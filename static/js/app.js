// static/js/app.js
(() => {
    // -------- DOM refs --------
    const fileInput = document.getElementById('fileInput');
    const hiddenImage = document.getElementById('hiddenImage');
    const raster = document.getElementById('raster');
    const overlay = document.getElementById('overlay');
    const previewPath = document.getElementById('previewPath');   // <-- separate live preview
    const corridorPath = document.getElementById('corridorPath'); // <-- committed path
    const handlesGroup = document.getElementById('handles');

    const newPathBtn = document.getElementById('newPathBtn');
    const undoBtn = document.getElementById('undoBtn');
    const downloadPngBtn = document.getElementById('downloadPngBtn');
    const downloadSvgBtn = document.getElementById('downloadSvgBtn');

    const corridorRange = document.getElementById('corridorRange');
    const corridorVal = document.getElementById('corridorVal');
    const smoothRange = document.getElementById('smoothRange');
    const smoothVal = document.getElementById('smoothVal');
    const editModeChk = document.getElementById('editModeChk');
    const showHandlesChk = document.getElementById('showHandlesChk');
    const colorPicker = document.getElementById('colorPicker');


    const outsideFadeRange = document.getElementById('outsideFadeRange');
    const outsideFadeVal = document.getElementById('outsideFadeVal');
    const markerOpacityRange = document.getElementById('markerOpacityRange');
    const markerOpacityVal = document.getElementById('markerOpacityVal');


    const stage = document.getElementById('stage');

    // Improve gesture stability even if CSS wasn't updated
    overlay.style.touchAction = 'none';
    raster.style.touchAction = 'none';

    // -------- App state --------
    let baseImageLoaded = false;
    let imgNaturalWidth = 0;
    let imgNaturalHeight = 0;

    let imageId = null; // set after /upload response

    // Editable path data
    let points = [];   // committed centerline points (image space)
    let scratch = [];  // current drawing capture
    let drawing = false;

    const state = {
        corridorPx: parseInt(corridorRange.value, 10),
        smoothing: parseFloat(smoothRange.value),
        color: colorPicker.value,
        editMode: false,
        showHandles: true,
        editSnapThreshold: 50, // px in image space


        outsideFade: (parseInt(outsideFadeRange.value, 10) / 100),  // 0..1
        markerOpacity: (parseInt(markerOpacityRange.value, 10) / 100) // 0..

    };

    // RAF throttle for preview redraw
    let rafPending = false;

    // -------- Utilities --------
    function getDisplayToImageScale() {
        const rect = raster.getBoundingClientRect();
        const scaleX = imgNaturalWidth ? (rect.width / imgNaturalWidth) : 1;
        return scaleX || 1;
    }

    function clientToImageCoords(evt) {
        const rect = raster.getBoundingClientRect();
        const x = (evt.clientX - rect.left);
        const y = (evt.clientY - rect.top);
        const scale = getDisplayToImageScale();
        return { x: x / scale, y: y / scale };
    }

    function distance(a, b) {
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        return Math.hypot(dx, dy);
    }

    // Ramer–Douglas–Peucker simplification helpers
    function perpendicularDistance(p, a, b) {
        const num = Math.abs((b.y - a.y) * p.x - (b.x - a.x) * p.y + b.x * a.y - b.y * a.x);
        const den = Math.hypot(b.y - a.y, b.x - a.x);
        return den === 0 ? 0 : num / den;
    }
    function findMaxPerpDistance(pts) {
        const start = pts[0], end = pts[pts.length - 1];
        let maxD = -1, idx = -1;
        for (let i = 1; i < pts.length - 1; i++) {
            const d = perpendicularDistance(pts[i], start, end);
            if (d > maxD) { maxD = d; idx = i; }
        }
        return { distance: maxD, index: idx };
    }
    function simplifyRDP(pts, epsilon) {
        if (pts.length < 3) return pts.slice();
        const dmaxInfo = findMaxPerpDistance(pts);
        if (dmaxInfo.distance > epsilon) {
            const rec1 = simplifyRDP(pts.slice(0, dmaxInfo.index + 1), epsilon);
            const rec2 = simplifyRDP(pts.slice(dmaxInfo.index), epsilon);
            return rec1.slice(0, -1).concat(rec2);
        } else {
            return [pts[0], pts[pts.length - 1]];
        }
    }

    function smoothPoints(raw, smoothing) {
        if (raw.length < 2) return raw.slice();
        const tol = (2 + smoothing * 14); // px
        let simplified = simplifyRDP(raw, tol);

        if (simplified.length > 4 && smoothing > 0) {
            const alpha = 0.15 + smoothing * 0.25;
            simplified = simplified.map((p, i, arr) => {
                if (i === 0 || i === arr.length - 1) return p;
                const prev = arr[i - 1], next = arr[i + 1];
                return {
                    x: p.x * (1 - alpha * 2) + (prev.x + next.x) * alpha,
                    y: p.y * (1 - alpha * 2) + (prev.y + next.y) * alpha,
                };
            });
        }
        return simplified;
    }

    function pointsToSvgPath(pts) {
        if (!pts.length) return '';
        let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
        for (let i = 1; i < pts.length; i++) {
            const p = pts[i];
            d += ` L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
        }
        return d;
    }

    function nearestIndexOnPolyline(pts, q) {
        if (!pts.length) return { index: -1, dist: Infinity };
        let best = { index: 0, dist: distance(pts[0], q) };
        for (let i = 1; i < pts.length; i++) {
            const d = distance(pts[i], q);
            if (d < best.dist) best = { index: i, dist: d };
        }
        return best;
    }

    function spliceSegment(pathPts, strokePts, threshold = 20) {
        if (pathPts.length < 2 || strokePts.length < 2) return pathPts.slice();
        const startQ = strokePts[0];
        const endQ = strokePts[strokePts.length - 1];

        const n1 = nearestIndexOnPolyline(pathPts, startQ);
        const n2 = nearestIndexOnPolyline(pathPts, endQ);

        if (n1.dist > threshold || n2.dist > threshold) {
            // Too far from the path — ignore this edit stroke
            return pathPts.slice();
        }

        let i1 = n1.index, i2 = n2.index;
        if (i1 > i2) [i1, i2] = [i2, i1];

        const left = pathPts.slice(0, i1);
        const right = pathPts.slice(i2 + 1);
        const merged = left.concat(strokePts, right);
        return smoothPoints(merged, state.smoothing);
    }

    // -------- Rendering --------
    function drawHandles() {
        handlesGroup.innerHTML = '';
        overlay.style.pointerEvents = 'auto'; // allow drawing & handles

        if (!state.showHandles || points.length === 0) return;

        const frag = document.createDocumentFragment();
        points.forEach((p, idx) => {
            const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            c.setAttribute('cx', p.x);
            c.setAttribute('cy', p.y);
            c.setAttribute('r', 6);
            c.dataset.idx = idx;
            c.style.pointerEvents = 'all';
            c.addEventListener('pointerdown', onHandlePointerDown);
            frag.appendChild(c);
        });
        handlesGroup.appendChild(frag);
    }

    function repaint() {
        if (!baseImageLoaded) return;
        overlay.setAttribute('viewBox', `0 0 ${imgNaturalWidth} ${imgNaturalHeight}`);
        overlay.setAttribute('width', imgNaturalWidth);
        overlay.setAttribute('height', imgNaturalHeight);

        corridorPath.setAttribute('d', pointsToSvgPath(points));
        corridorPath.setAttribute('stroke', state.color);
        corridorPath.setAttribute('stroke-width', String(state.corridorPx * 2));
        corridorPath.setAttribute('opacity', '0.85');

        // previewPath updated during drawing only
        drawHandles();
    }

    function updatePreview() {
        if (!scratch.length) {
            previewPath.setAttribute('d', '');
            return;
        }
        const preview = smoothPoints(scratch, state.smoothing);
        previewPath.setAttribute('d', pointsToSvgPath(preview));
        previewPath.setAttribute('stroke', state.color);
        previewPath.setAttribute('stroke-width', String(state.corridorPx * 2));
        previewPath.setAttribute('opacity', '0.5');
    }

    // -------- Handle dragging (anchors) --------
    let draggingIdx = null;
    function onHandlePointerDown(e) {
        e.stopPropagation();
        e.preventDefault();
        draggingIdx = parseInt(e.target.dataset.idx, 10);
        overlay.setPointerCapture(e.pointerId);
        overlay.addEventListener('pointermove', onHandlePointerMove);
        overlay.addEventListener('pointerup', onHandlePointerUp);
        overlay.addEventListener('pointercancel', onHandlePointerUp);
    }
    function onHandlePointerMove(e) {
        if (draggingIdx === null) return;
        const imgPt = clientToImageCoords(e);
        points[draggingIdx] = imgPt;
        repaint();
    }
    function onHandlePointerUp(e) {
        draggingIdx = null;
        overlay.releasePointerCapture(e.pointerId);
        overlay.removeEventListener('pointermove', onHandlePointerMove);
        overlay.removeEventListener('pointerup', onHandlePointerUp);
        overlay.removeEventListener('pointercancel', onHandlePointerUp);
    }

    // -------- Freehand pointer drawing --------
    function onPointerDown(e) {
        if (!baseImageLoaded) return;
        if (!e.isPrimary) return;
        if (e.button !== undefined && e.button !== 0) return;

        e.preventDefault();
        drawing = true;
        scratch = [clientToImageCoords(e)];
        overlay.setPointerCapture(e.pointerId);
        updatePreview();
    }

    function onPointerMove(e) {
        if (!drawing) return;
        e.preventDefault();

        const p = clientToImageCoords(e);
        const last = scratch[scratch.length - 1];
        if (!last || distance(last, p) >= 1.8) {
            scratch.push(p);
            if (!rafPending) {
                rafPending = true;
                requestAnimationFrame(() => {
                    updatePreview();
                    rafPending = false;
                });
            }
        }
    }

    function commitStrokeFromScratch() {
        const stroke = smoothPoints(scratch, state.smoothing);
        if (stroke.length < 2) return;

        if (!points.length) {
            points = stroke;
        } else if (state.editMode) {
            points = spliceSegment(points, stroke, state.editSnapThreshold);
        } else {
            const tail = points[points.length - 1];
            if (distance(tail, stroke[0]) < 12) {
                points = points.concat(stroke.slice(1));
            } else {
                points = stroke; // new path
            }
        }
    }

    function onPointerUp(e) {
        if (!drawing) return;
        e.preventDefault();

        drawing = false;
        overlay.releasePointerCapture(e.pointerId);

        commitStrokeFromScratch();
        scratch = [];
        previewPath.setAttribute('d', '');
        repaint();
    }

    function onPointerCancel() {
        if (!drawing) return;
        drawing = false;
        scratch = [];
        previewPath.setAttribute('d', '');
    }
    function onLostPointerCapture() {
        if (!drawing) return;
        drawing = false;
        scratch = [];
        previewPath.setAttribute('d', '');
    }

    // -------- Commands --------
    function undoLastPoint() {
        if (!points.length) return;
        points.pop();
        repaint();
    }

    function newPath() {
        points = [];
        repaint();
    }

    function drawImageToCanvas() {
        const ctx = raster.getContext('2d');
        raster.width = imgNaturalWidth;
        raster.height = imgNaturalHeight;

        ctx.clearRect(0, 0, raster.width, raster.height);
        ctx.drawImage(hiddenImage, 0, 0, imgNaturalWidth, imgNaturalHeight);

        // Ensure the stage has a real box so absolute children fill it
        stage.style.aspectRatio = `${imgNaturalWidth} / ${imgNaturalHeight}`;

        overlay.setAttribute('viewBox', `0 0 ${imgNaturalWidth} ${imgNaturalHeight}`);
        overlay.setAttribute('width', imgNaturalWidth);
        overlay.setAttribute('height', imgNaturalHeight);

        repaint();
    }

    // ---- BACKEND MERGE: request server to mask the image under the corridor ----
    async function downloadMergedPNG() {
        if (!baseImageLoaded) return alert('No image loaded yet.');
        if (!imageId) return alert('Image not uploaded yet—please reselect the file.');
        if (points.length < 2) return alert('Draw a corridor first.');

        const payload = {
            image_id: imageId,
            points: points,                   // image-space points
            corridor_px: state.corridorPx,     // corridor radius in px

            
            outside_fade: state.outsideFade,  // 0..1: how much to fade non-corridor toward white
            marker_alpha: state.markerOpacity // 0..1: opacity for triangle/circle outlines

        };

        try {
            const res = await fetch('/merge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                const txt = await res.text();
                console.error('Merge failed:', res.status, txt);
                alert(`Merge failed: ${res.status} ${txt}`);
                return;
            }
            const blob = await res.blob();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'corridor_masked.png';
            a.click();
            URL.revokeObjectURL(a.href);
        } catch (err) {
            console.error('Merge error:', err);
            alert('Merge error. See console for details.');
        }
    }

    // Keep SVG-only client export
    function downloadSVG() {
        const serializer = new XMLSerializer();
        const svg = overlay.cloneNode(true);
        svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        svg.setAttribute('viewBox', `0 0 ${imgNaturalWidth} ${imgNaturalHeight}`);
        svg.setAttribute('width', imgNaturalWidth);
        svg.setAttribute('height', imgNaturalHeight);
        const svgString = serializer.serializeToString(svg);
        const blob = new Blob([svgString], { type: 'image/svg+xml' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'corridor.svg';
        a.click();
        URL.revokeObjectURL(a.href);
    }

    // -------- Event wiring --------
    fileInput.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        // 1) Local display for drawing
        const url = URL.createObjectURL(file);
        hiddenImage.onload = () => {
            imgNaturalWidth = hiddenImage.naturalWidth;
            imgNaturalHeight = hiddenImage.naturalHeight;
            baseImageLoaded = true;
            drawImageToCanvas();
            URL.revokeObjectURL(url);
        };
        hiddenImage.src = url;

        // 2) Upload to backend to obtain imageId
        try {
            const form = new FormData();
            form.append('file', file);
            const res = await fetch('/upload', { method: 'POST', body: form });
            const json = await res.json();
            if (!res.ok) {
                console.error('Upload failed:', json);
                alert(`Upload failed: ${json.error || res.statusText}`);
                imageId = null;
                return;
            }
            imageId = json.image_id;
            // (Optionally, you can verify json.width/json.height vs local)
        } catch (err) {
            console.error('Upload error:', err);
            alert('Upload error. See console for details.');
            imageId = null;
        }
    });

    outsideFadeRange.addEventListener('input', (e) => {
        const v = parseInt(e.target.value, 10);
        state.outsideFade = v / 100;
        outsideFadeVal.textContent = `${v}%`;
        // Visual preview remains unchanged (fade applies on backend when exporting)
    });

    markerOpacityRange.addEventListener('input', (e) => {
        const v = parseInt(e.target.value, 10);
        state.markerOpacity = v / 100;
        markerOpacityVal.textContent = `${v}%`;
        // (We could preview marker opacity on the client, but they render at export time)
    });


    corridorRange.addEventListener('input', (e) => {
        state.corridorPx = parseInt(e.target.value, 10);
        corridorVal.textContent = String(state.corridorPx);
        repaint();
    });

    smoothRange.addEventListener('input', (e) => {
        state.smoothing = parseFloat(e.target.value);
        smoothVal.textContent = state.smoothing.toFixed(2);
        if (points.length > 2) points = smoothPoints(points, state.smoothing);
        repaint();
    });

    colorPicker.addEventListener('input', (e) => {
        state.color = e.target.value;
        repaint();
    });

    editModeChk.addEventListener('change', (e) => {
        state.editMode = e.target.checked;
    });

    showHandlesChk.addEventListener('change', (e) => {
        state.showHandles = e.target.checked;
        repaint();
    });

    newPathBtn.addEventListener('click', newPath);
    undoBtn.addEventListener('click', undoLastPoint);
    downloadPngBtn.addEventListener('click', downloadMergedPNG);
    downloadSvgBtn.addEventListener('click', downloadSVG);

    // Draw on overlay (SVG)
    overlay.addEventListener('pointerdown', onPointerDown);
    overlay.addEventListener('pointermove', onPointerMove);
    overlay.addEventListener('pointerup', onPointerUp);
    overlay.addEventListener('pointercancel', onPointerCancel);
    overlay.addEventListener('lostpointercapture', onLostPointerCapture);

    // Keyboard helpers
    window.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            undoLastPoint();
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
            e.preventDefault();
            newPath();
        }
    });

})();