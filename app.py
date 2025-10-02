# app.py
import io
import uuid
import math
from pathlib import Path

from flask import Flask, render_template, request, send_file, abort, jsonify
from PIL import Image, ImageDraw

app = Flask(__name__, static_folder="static", template_folder="templates")

# Where uploaded images are stored (keep it out of version control)
UPLOAD_DIR = Path("./uploads")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"}



@app.route("/")
def index():
    return render_template("index.html")


@app.post("/upload")
def upload():
    """
    Receives a multipart/form upload with an image file.
    Saves it with a UUID name and returns {image_id, width, height}.
    """
    if "file" not in request.files:
        return jsonify({"error": "no file part"}), 400

    f = request.files["file"]
    if not f or f.filename == "":
        return jsonify({"error": "no selected file"}), 400

    ext = Path(f.filename).suffix.lower()
    if ext not in ALLOWED_EXTS:
        return jsonify({"error": f"file type not allowed: {ext}"}), 400

    image_id = f"{uuid.uuid4().hex}{ext}"
    path = UPLOAD_DIR / image_id
    f.save(path)

    # Validate it's an image and get natural size
    try:
        with Image.open(path) as im:
            w, h = im.size
    except Exception as e:
        path.unlink(missing_ok=True)
        return jsonify({"error": f"invalid image: {e}"}), 400

    return jsonify({"image_id": image_id, "width": w, "height": h})

# In app.py

@app.post("/merge")
def merge():
    """
    JSON body: {
        "image_id": "<uuid>.ext",
        "points": [{"x": float, "y": float}, ...],   # image-space
        "corridor_px": int,                          # radius in px
        "outside_fade": float,                       # 0..1 (0=no fade, 1=full white)
        "marker_alpha": float                        # 0..1 (0=transparent, 1=opaque)
    }

    Returns PNG where:
      - Non-corridor region is blended toward white by outside_fade
      - Corridor region shows original image
      - Purple edge ring along corridor (opaque)
      - Start triangle + end circle drawn in purple with marker_alpha
    """
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "invalid JSON"}), 400

    image_id = data.get("image_id")
    points = data.get("points") or []
    corridor_px = int(data.get("corridor_px") or 0)

    # Defaults for new fields
    outside_fade = float(data.get("outside_fade") if data.get("outside_fade") is not None else 0.8)
    outside_fade = max(0.0, min(1.0, outside_fade))

    marker_alpha = float(data.get("marker_alpha") if data.get("marker_alpha") is not None else 0.7)
    marker_alpha = max(0.0, min(1.0, marker_alpha))

    if not image_id or not points or corridor_px <= 0:
        return jsonify({"error": "missing image_id, points, or corridor_px"}), 400

    path = UPLOAD_DIR / image_id
    if not path.exists():
        return jsonify({"error": "image not found"}), 404

    try:
        with Image.open(path) as base:
            base = base.convert("RGB")
            w, h = base.size

            # ---------- Parameters ----------
            scale = 2  # 2× supersampling for smoother edges
            W2, H2 = w * scale, h * scale

            stroke_w2 = max(1, int(corridor_px * 2 * scale))  # corridor diameter at 2×

            EDGE_THICKNESS_PX = max(2, int(0.5 * corridor_px))  # ring thickness in native px
            edge_w2 = max(1, int(EDGE_THICKNESS_PX * 2 * scale))  # 2× scale

            PURPLE_RGB = (128, 0, 255)
            PURPLE_RGBA_OPAQUE = (128, 0, 255, 255)
            PURPLE_RGBA_MARKER = (128, 0, 255, int(round(marker_alpha * 255)))

            # Scale points to high-res for mask drawing
            if len(points) < 2:
                return jsonify({"error": "need at least 2 points"}), 400
            pts2 = [(p["x"] * scale, p["y"] * scale) for p in points]

            # ---------- 1) Corridor mask (high-res -> native) ----------
            mask2 = Image.new("L", (W2, H2), 0)
            dmask = ImageDraw.Draw(mask2)
            try:
                dmask.line(pts2, fill=255, width=stroke_w2, joint="curve")
            except TypeError:
                dmask.line(pts2, fill=255, width=stroke_w2)

            r_in = stroke_w2 // 2
            x0, y0 = pts2[0]
            x1, y1 = pts2[-1]
            dmask.ellipse([x0 - r_in, y0 - r_in, x0 + r_in, y0 + r_in], fill=255)
            dmask.ellipse([x1 - r_in, y1 - r_in, x1 + r_in, y1 + r_in], fill=255)

            mask = mask2.resize((w, h), Image.LANCZOS)

            # ---------- 2) Outside fade: blend base -> white, then paste corridor ----------
            white = Image.new("RGB", (w, h), (255, 255, 255))
            outside = Image.blend(base, white, outside_fade)  # fade non-corridor
            out = outside.copy()
            out.paste(base, mask=mask)  # restore true base inside corridor

            # ---------- 3) Purple edge ring (opaque) ----------
            ring2 = Image.new("L", (W2, H2), 0)
            dring = ImageDraw.Draw(ring2)

            outer_w2 = stroke_w2 + edge_w2
            try:
                dring.line(pts2, fill=255, width=outer_w2, joint="curve")
            except TypeError:
                dring.line(pts2, fill=255, width=outer_w2)

            r_out = outer_w2 // 2
            dring.ellipse([x0 - r_out, y0 - r_out, x0 + r_out, y0 + r_out], fill=255)
            dring.ellipse([x1 - r_out, y1 - r_out, x1 + r_out, y1 + r_out], fill=255)

            # carve inner corridor to leave a ring
            try:
                dring.line(pts2, fill=0, width=stroke_w2, joint="curve")
            except TypeError:
                dring.line(pts2, fill=0, width=stroke_w2)
            dring.ellipse([x0 - r_in, y0 - r_in, x0 + r_in, y0 + r_in], fill=0)
            dring.ellipse([x1 - r_in, y1 - r_in, x1 + r_in, y1 + r_in], fill=0)

            ring_mask = ring2.resize((w, h), Image.LANCZOS)
            purple_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
            purple_solid = Image.new("RGBA", (w, h), PURPLE_RGBA_OPAQUE)
            purple_layer = Image.composite(purple_solid, purple_layer, ring_mask)

            # ---------- 4) Markers: stroked triangle (start) + stroked circle (end), with alpha ----------
            p0, p1, pe = points[0], points[1], points[-1]
            vx, vy = (p1["x"] - p0["x"], p1["y"] - p0["y"])
            norm = math.hypot(vx, vy) or 1.0
            ux, uy = vx / norm, vy / norm
            px_, py_ = -uy, ux  # perpendicular

            tri_height = corridor_px * 1.6
            tri_base   = corridor_px * 1.6

            tip   = (p0["x"] + ux * tri_height,        p0["y"] + uy * tri_height)
            left  = (p0["x"] + px_ * (tri_base / 2.0),  p0["y"] + py_ * (tri_base / 2.0))
            right = (p0["x"] - px_ * (tri_base / 2.0),  p0["y"] - py_ * (tri_base / 2.0))
            triangle_path = [tip, left, right, tip]

            MARKER_STROKE_PX = max(2, int(0.6 * corridor_px))

            pd = ImageDraw.Draw(purple_layer)
            # Triangle outline (semi-transparent)
            try:
                pd.line(triangle_path, fill=PURPLE_RGBA_MARKER, width=MARKER_STROKE_PX//3, joint="curve")
            except TypeError:
                pd.line(triangle_path, fill=PURPLE_RGBA_MARKER, width=MARKER_STROKE_PX)

            # Circle outline at end (semi-transparent)
            end_r = int(corridor_px * 0.9)
            bbox = [pe["x"] - end_r, pe["y"] - end_r, pe["x"] + end_r, pe["y"] + end_r]
            try:
                pd.ellipse(bbox, outline=PURPLE_RGBA_MARKER, width=MARKER_STROKE_PX//3)
            except TypeError:
                # Approximate width if Pillow ellipse width isn't supported
                for k in range(MARKER_STROKE_PX):
                    inset = k / 2.0
                    pd.ellipse(
                        [bbox[0] - inset, bbox[1] - inset, bbox[2] + inset, bbox[3] + inset],
                        outline=PURPLE_RGBA_MARKER
                    )

            # ---------- 5) Composite purple overlays ----------
            out_rgba = out.convert("RGBA")
            out_final = Image.alpha_composite(out_rgba, purple_layer)

            # ---------- 6) Return PNG ----------
            buf = io.BytesIO()
            out_final.save(buf, format="PNG")
            buf.seek(0)
            return send_file(
                buf,
                mimetype="image/png",
                as_attachment=True,
                download_name="corridor_masked.png",
            )

    except Exception as e:
        return jsonify({"error": f"merge failed: {e}"}), 500
if __name__ == "__main__":
    # For local dev only
    app.run(debug=True)