"""
app.py – AWI PermafrostLabel · Main Flask Application
Run:  python app.py
Admin:  http://localhost:5000/admin
Worker: http://localhost:5000/worker
"""
import os
import io
import json
import uuid
import traceback
from pathlib import Path
from datetime import datetime

from flask import (Flask, render_template, request, jsonify, redirect,
                   url_for, session, send_file, abort, flash)

import database as db
import image_utils as iu
import export_utils as eu

# ── App Setup ─────────────────────────────────────────────────────────────────

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "awi-pfl-secret-change-in-production")
# Allow arbitrarily large GeoTIFF uploads (set in env to override, e.g. "2147483648" = 2 GB)
app.config["MAX_CONTENT_LENGTH"] = int(os.environ.get("MAX_UPLOAD_BYTES", 2 * 1024 ** 3))

BASE_DIR    = Path(__file__).resolve().parent
UPLOAD_DIR  = BASE_DIR / "uploads"
PREVIEW_DIR = BASE_DIR / "previews"
EXPORT_DIR  = BASE_DIR / "exports"
for d in (UPLOAD_DIR, PREVIEW_DIR, EXPORT_DIR):
    d.mkdir(exist_ok=True)

# Initialise DB on startup
with app.app_context():
    db.init_db()


# ── Helpers ───────────────────────────────────────────────────────────────────

def cfg():
    return db.get_config()


def require_admin():
    if not session.get("is_admin"):
        return redirect(url_for("admin_login"))
    return None


def require_worker():
    if not session.get("worker_name"):
        return redirect(url_for("worker_login"))
    return None


# ── Root ──────────────────────────────────────────────────────────────────────

@app.route("/")
def root():
    return render_template("home.html", cfg=cfg())


# ═══════════════════════════════════════════════════════════════════════════════
#  ADMIN
# ═══════════════════════════════════════════════════════════════════════════════

@app.route("/admin/login", methods=["GET", "POST"])
def admin_login():
    if request.method == "POST":
        token = request.form.get("token", "")
        if token == cfg().get("admin_token", "awi-admin-2024"):
            session["is_admin"] = True
            return redirect(url_for("admin_dashboard"))
        flash("Invalid admin token", "error")
    return render_template("admin_login.html", cfg=cfg())


@app.route("/admin/logout")
def admin_logout():
    session.pop("is_admin", None)
    return redirect(url_for("admin_login"))


@app.route("/admin")
@app.route("/admin/dashboard")
def admin_dashboard():
    redir = require_admin()
    if redir: return redir
    stats = db.get_stats()
    groups = db.get_groups()
    return render_template("admin_dashboard.html", cfg=cfg(),
                           stats=stats, groups=groups)


# ── Groups ────────────────────────────────────────────────────────────────────

@app.route("/admin/groups", methods=["GET", "POST"])
def admin_groups():
    redir = require_admin()
    if redir: return redir

    if request.method == "POST":
        action = request.form.get("action")
        if action == "create":
            db.create_group(
                request.form["name"],
                request.form.get("type", "project"),
                request.form.get("description", "")
            )
            flash("Group created", "success")
        elif action == "delete":
            db.delete_group(request.form["group_id"])
            flash("Group deleted", "success")
        return redirect(url_for("admin_groups"))

    groups = db.get_groups()
    return render_template("admin_groups.html", cfg=cfg(), groups=groups)


# ── Upload ────────────────────────────────────────────────────────────────────

@app.route("/admin/upload", methods=["GET", "POST"])
def admin_upload():
    redir = require_admin()
    if redir: return redir

    if request.method == "POST":
        group_id = request.form.get("group_id") or None
        files = request.files.getlist("images")
        results = []
        for f in files:
            if not f.filename:
                continue
            try:
                safe_name = f"{uuid.uuid4().hex}_{Path(f.filename).name}"
                dest = UPLOAD_DIR / safe_name
                f.save(str(dest))

                meta = iu.read_metadata(str(dest))
                img_id = db.add_image({
                    "filename":           safe_name,
                    "original_filename":  f.filename,
                    "group_id":           int(group_id) if group_id else None,
                    "filepath":           str(dest),
                    "preview_path":       None,
                    "crs":                meta["crs"],
                    "bbox_minx":          meta["bbox_minx"],
                    "bbox_miny":          meta["bbox_miny"],
                    "bbox_maxx":          meta["bbox_maxx"],
                    "bbox_maxy":          meta["bbox_maxy"],
                    "wgs84_west":         meta["wgs84_west"],
                    "wgs84_south":        meta["wgs84_south"],
                    "wgs84_east":         meta["wgs84_east"],
                    "wgs84_north":        meta["wgs84_north"],
                    "width":              meta["width"],
                    "height":             meta["height"],
                    "band_count":         meta["band_count"],
                    "resolution_x":       meta["resolution_x"],
                    "resolution_y":       meta["resolution_y"],
                    "nodata":             meta["nodata"],
                    "band_descriptions":  meta["band_descriptions"],
                })
                # Generate preview
                preview_path = iu.save_preview(str(dest), str(PREVIEW_DIR), img_id)
                conn = db.get_db()
                conn.execute("UPDATE images SET preview_path=? WHERE id=?",
                             (preview_path, img_id))
                conn.commit()
                conn.close()
                results.append({"file": f.filename, "status": "ok", "id": img_id})
            except Exception as e:
                results.append({"file": f.filename, "status": "error", "msg": str(e)})
        return jsonify(results)

    groups = db.get_groups()
    return render_template("admin_upload.html", cfg=cfg(), groups=groups)


@app.route("/admin/images")
def admin_images():
    redir = require_admin()
    if redir: return redir
    group_id = request.args.get("group_id")
    images = db.get_images(group_id=group_id)
    groups = db.get_groups()
    return render_template("admin_images.html", cfg=cfg(),
                           images=images, groups=groups,
                           selected_group=group_id)


@app.route("/admin/images/<int:image_id>/delete", methods=["POST"])
def admin_delete_image(image_id):
    redir = require_admin()
    if redir: return redir
    img = db.get_image(image_id)
    if img:
        db.delete_image(image_id)
        # Optionally remove files
        try:
            Path(img["filepath"]).unlink(missing_ok=True)
            if img.get("preview_path"):
                Path(img["preview_path"]).unlink(missing_ok=True)
        except Exception:
            pass
    flash("Image deleted", "success")
    return redirect(url_for("admin_images"))


# ── Classes ───────────────────────────────────────────────────────────────────

@app.route("/admin/classes", methods=["GET", "POST"])
def admin_classes():
    redir = require_admin()
    if redir: return redir

    if request.method == "POST":
        action = request.form.get("action")
        if action in ("create", "update"):
            db.upsert_class({
                "id":          request.form.get("class_id") or None,
                "number":      int(request.form["number"]),
                "name":        request.form["name"],
                "color":       request.form["color"],
                "description": request.form.get("description", ""),
                "active":      1 if request.form.get("active") else 0,
                "sort_order":  int(request.form.get("sort_order", 0)),
            })
            flash("Class saved", "success")
        elif action == "delete":
            db.delete_class(int(request.form["class_id"]))
            flash("Class deleted", "success")
        return redirect(url_for("admin_classes"))

    classes = db.get_classes(active_only=False)
    return render_template("admin_classes.html", cfg=cfg(), classes=classes)


# ── Config ────────────────────────────────────────────────────────────────────

@app.route("/admin/config", methods=["GET", "POST"])
def admin_config():
    redir = require_admin()
    if redir: return redir

    if request.method == "POST":
        keys = ["app_name","app_subtitle","organization","logo_url",
                "admin_token","max_preview_px","default_tile_size_m","contact_email"]
        data = {k: request.form.get(k, "") for k in keys}
        db.set_config_bulk(data)
        flash("Configuration saved", "success")
        return redirect(url_for("admin_config"))

    return render_template("admin_config.html", cfg=cfg())


# ── Admin Export ──────────────────────────────────────────────────────────────

@app.route("/admin/export", methods=["GET"])
def admin_export():
    redir = require_admin()
    if redir: return redir
    groups  = db.get_groups()
    classes = db.get_classes(active_only=False)
    return render_template("admin_export.html", cfg=cfg(),
                           groups=groups, classes=classes)


@app.route("/admin/export/download", methods=["POST"])
def admin_export_download():
    redir = require_admin()
    if redir: return redir
    return _do_export(request.form)


# ═══════════════════════════════════════════════════════════════════════════════
#  WORKER
# ═══════════════════════════════════════════════════════════════════════════════

@app.route("/worker")
@app.route("/worker/login", methods=["GET", "POST"])
def worker_login():
    if request.method == "POST":
        name = request.form.get("name", "").strip()
        if name:
            session["worker_name"] = name
            return redirect(url_for("worker_queue"))
        flash("Please enter your name", "error")
    return render_template("worker_login.html", cfg=cfg())


@app.route("/worker/logout")
def worker_logout():
    session.pop("worker_name", None)
    return redirect(url_for("worker_login"))


@app.route("/worker/queue")
def worker_queue():
    redir = require_worker()
    if redir: return redir
    group_id = request.args.get("group_id")
    images   = db.get_images(group_id=group_id, status="available")
    groups   = db.get_groups()
    leaderboard = db.get_worker_leaderboard(limit=10)
    return render_template("worker_queue.html", cfg=cfg(),
                           images=images, groups=groups,
                           worker=session["worker_name"],
                           leaderboard=leaderboard,
                           selected_group=group_id)


@app.route("/worker/label/<int:image_id>")
def worker_label(image_id):
    redir = require_worker()
    if redir: return redir
    img = db.get_image(image_id)
    if not img:
        abort(404)
    classes = db.get_classes()
    worker  = session["worker_name"]
    tile_m  = float(cfg().get("default_tile_size_m", 100))
    leaderboard_top = db.get_worker_leaderboard(limit=3)

    # Mark in-progress
    db.update_image_status(image_id, "in_progress", worker)

    band_descriptions = json.loads(img.get("band_descriptions") or "[]")
    return render_template("worker_label.html", cfg=cfg(),
                           img=img, classes=classes,
                           worker=worker, tile_m=tile_m,
                           leaderboard_top=leaderboard_top,
                           band_descriptions=band_descriptions)


@app.route("/worker/export", methods=["GET"])
def worker_export():
    redir = require_worker()
    if redir: return redir
    worker  = session["worker_name"]
    groups  = db.get_groups()
    classes = db.get_classes(active_only=False)
    return render_template("worker_export.html", cfg=cfg(),
                           groups=groups, classes=classes, worker=worker)


@app.route("/worker/export/download", methods=["POST"])
def worker_export_download():
    redir = require_worker()
    if redir: return redir
    data = dict(request.form)
    data["worker_name"] = session["worker_name"]
    return _do_export(data)


# ── Free Labelling ────────────────────────────────────────────────────────────

@app.route("/worker/free")
def worker_free_label():
    redir = require_worker()
    if redir: return redir
    classes = db.get_classes()
    worker  = session["worker_name"]
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    return render_template("worker_free_label.html", cfg=cfg(),
                           classes=classes, worker=worker, now=now)


# ── Help ──────────────────────────────────────────────────────────────────────

@app.route("/help")
def help_page():
    return render_template("help.html", cfg=cfg())


# ═══════════════════════════════════════════════════════════════════════════════
#  API
# ═══════════════════════════════════════════════════════════════════════════════

@app.route("/api/image/<int:image_id>/preview")
def api_preview(image_id):
    """Serve rendered preview PNG."""
    img = db.get_image(image_id)
    if not img:
        abort(404)

    bands_raw = request.args.get("bands", "1,2,3")
    try:
        bands = tuple(int(b) for b in bands_raw.split(","))
    except Exception:
        bands = (1, 2, 3)

    # Check if default preview exists and no band change requested
    if bands == (1, 2, 3) and img.get("preview_path"):
        p = Path(img["preview_path"])
        if p.exists():
            resp = send_file(str(p), mimetype="image/png")
            resp.headers["Cache-Control"] = "public, max-age=3600"
            return resp

    # Re-render
    try:
        max_px = int(db.get_config().get("max_preview_px", 3000))
        png_bytes = iu.render_preview(img["filepath"], bands=bands, max_px=max_px)
        resp = send_file(io.BytesIO(png_bytes), mimetype="image/png")
        resp.headers["Cache-Control"] = "no-store"
        return resp
    except Exception as e:
        app.logger.error(f"Preview error for {image_id}: {e}")
        abort(500)


@app.route("/api/image/<int:image_id>/meta")
def api_meta(image_id):
    img = db.get_image(image_id)
    if not img:
        abort(404)
    img["band_descriptions"] = json.loads(img.get("band_descriptions") or "[]")
    return jsonify(img)


@app.route("/api/labels", methods=["GET"])
def api_get_labels():
    image_id = request.args.get("image_id", type=int)
    labels = db.get_labels(image_id=image_id)
    return jsonify(labels)


@app.route("/api/labels", methods=["POST"])
def api_add_label():
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data"}), 400
    worker = session.get("worker_name") or data.get("worker_name", "unknown")
    try:
        label_id = db.add_label(
            image_id    = data["image_id"],
            worker_name = worker,
            geojson_str = json.dumps(data["geometry"]),
            label_type  = data.get("label_type", "polygon"),
            class_id    = data.get("class_id"),
            tile_size_m = data.get("tile_size_m"),
            basemap     = data.get("basemap"),
        )
        return jsonify({"id": label_id, "status": "created"}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/free_session", methods=["POST"])
def api_create_free_session():
    """Create a virtual image record backing a free-labelling session.
    Status is set to 'free_session' so it does not appear in the normal queue.
    """
    worker = session.get("worker_name", "unknown")
    data   = request.get_json() or {}
    name   = data.get("name") or f"Free Session {datetime.now().strftime('%Y-%m-%d %H:%M')}"

    img_id = db.add_image({
        "filename":          f"free_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{worker}",
        "original_filename": name,
        "group_id":          None,
        "filepath":          "free_label",
        "preview_path":      None,
        "crs":               "EPSG:4326",
        "bbox_minx":  -180, "bbox_miny":   -90,
        "bbox_maxx":   180, "bbox_maxy":    90,
        "wgs84_west": -180, "wgs84_south": -90,
        "wgs84_east":  180, "wgs84_north":  90,
        "width":  0, "height":    0,
        "band_count":  0,
        "resolution_x": 0, "resolution_y": 0,
        "nodata":          None,
        "band_descriptions": "[]",
    })
    db.update_image_status(img_id, "free_session", worker)
    return jsonify({"image_id": img_id, "name": name}), 201


@app.route("/api/classes/resolve-other", methods=["POST"])
def api_resolve_other_class():
    if not session.get("worker_name"):
        return jsonify({"error": "Worker login required"}), 401

    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Class name is required"}), 400

    try:
        cls, created = db.resolve_other_class(name)
        return jsonify({
            "id": cls["id"],
            "name": cls["name"],
            "number": cls["number"],
            "color": cls.get("color", "#9E9E9E"),
            "created": created,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/labels/<int:label_id>", methods=["DELETE"])
def api_delete_label(label_id):
    db.delete_label(label_id)
    return jsonify({"status": "deleted"})


@app.route("/api/image/<int:image_id>/done", methods=["POST"])
def api_mark_done(image_id):
    worker = session.get("worker_name", "unknown")
    db.update_image_status(image_id, "done", worker)
    return jsonify({"status": "done"})


@app.route("/api/image/<int:image_id>/close", methods=["POST"])
def api_close_image(image_id):
    """End current worker session and release image back to queue."""
    db.update_image_status(image_id, "available")
    return jsonify({"status": "available"})


@app.route("/api/image/<int:image_id>/reopen", methods=["POST"])
def api_reopen(image_id):
    db.update_image_status(image_id, "available")
    return jsonify({"status": "available"})


@app.route("/api/labels/geojson")
def api_labels_geojson():
    """Return all labels for map view as GeoJSON FeatureCollection."""
    image_id   = request.args.get("image_id",  type=int)
    class_id   = request.args.get("class_id",  type=int)
    group_id   = request.args.get("group_id",  type=int)
    worker     = request.args.get("worker")
    labels     = db.get_labels(image_id=image_id, class_id=class_id,
                               worker_name=worker, group_id=group_id)
    features = []
    for lbl in labels:
        try:
            geom = json.loads(lbl["geojson"])
            features.append({
                "type": "Feature",
                "geometry": geom,
                "properties": {
                    "id":         lbl["id"],
                    "class_name": lbl.get("class_name",""),
                    "class_color":lbl.get("class_color","#4A90D9"),
                    "class_no":   lbl.get("class_number"),
                    "worker":     lbl["worker_name"],
                    "image":      lbl.get("original_filename",""),
                    "created_at": lbl["created_at"],
                }
            })
        except Exception:
            pass
    return jsonify({"type": "FeatureCollection", "features": features})


@app.route("/api/footprints/geojson")
def api_footprints_geojson():
    """Return image footprints with label summaries as GeoJSON."""
    group_id  = request.args.get("group_id",  type=int)
    class_ids = request.args.getlist("class_id", type=int)
    images    = db.get_images(group_id=group_id)

    features = []
    for img in images:
        w, s, e, n = (img.get("wgs84_west"),  img.get("wgs84_south"),
                      img.get("wgs84_east"),  img.get("wgs84_north"))
        if any(v is None for v in (w, s, e, n)):
            continue
        labels = db.get_labels(image_id=img["id"])
        if class_ids:
            labels = [l for l in labels if l.get("class_id") in class_ids]
        class_names = list({l.get("class_name","") for l in labels if l.get("class_name")})
        workers     = list({l["worker_name"] for l in labels})
        features.append({
            "type": "Feature",
            "geometry": {
                "type": "Polygon",
                "coordinates": [[
                    [w, s],[e, s],[e, n],[w, n],[w, s]
                ]]
            },
            "properties": {
                "image_id":    img["id"],
                "filename":    img.get("original_filename",""),
                "group":       img.get("group_name",""),
                "status":      img.get("status",""),
                "label_count": len(labels),
                "classes":     ", ".join(class_names),
                "workers":     ", ".join(workers),
            }
        })
    return jsonify({"type": "FeatureCollection", "features": features})


@app.route("/api/classes")
def api_classes():
    return jsonify(db.get_classes())


# ═══════════════════════════════════════════════════════════════════════════════
#  SHARED EXPORT LOGIC
# ═══════════════════════════════════════════════════════════════════════════════

def _do_export(form_data):
    export_type = form_data.get("export_type", "labels")
    fmt         = form_data.get("format", "geojson")
    group_id    = form_data.get("group_id") or None
    class_id    = form_data.get("class_id") or None
    worker_name = form_data.get("worker_name") or None

    if group_id:  group_id  = int(group_id)
    if class_id:  class_id  = int(class_id)

    try:
        if export_type == "footprints":
            images = db.get_images(group_id=group_id)
            # Attach class summary to each image
            for img in images:
                labels = db.get_labels(image_id=img["id"],
                                       class_id=class_id,
                                       worker_name=worker_name)
                img["label_count"] = len(labels)
                img["classes"]  = ", ".join(sorted({l.get("class_name","") for l in labels} - {""}))
                img["workers"]  = ", ".join(sorted({l["worker_name"] for l in labels}))
            data, fname, mime = eu.export_footprints(images, fmt)
        else:
            labels = db.get_labels(class_id=class_id,
                                   worker_name=worker_name,
                                   group_id=group_id)
            data, fname, mime = eu.export_labels(labels, fmt)

        if not data:
            flash("No data to export with those filters", "warning")
            return redirect(request.referrer or url_for("root"))

        return send_file(io.BytesIO(data),
                         mimetype=mime,
                         as_attachment=True,
                         download_name=fname)
    except Exception as e:
        app.logger.error(f"Export error: {e}\n{traceback.format_exc()}")
        flash(f"Export failed: {e}", "error")
        return redirect(request.referrer or url_for("root"))


# ─────────────────────────────────────────────────────────────────────────────

@app.route("/admin/images/<int:image_id>/reopen", methods=["POST"])
def admin_reopen_image(image_id):
    """HTML-form reopen — used from admin images table."""
    redir = require_admin()
    if redir: return redir
    db.update_image_status(image_id, "available")
    flash("Image reopened for labelling", "success")
    return redirect(url_for("admin_images"))


if __name__ == "__main__":
    print("\n" + "═"*60)
    print("  AWI PermafrostLabel")
    print("  Admin  → http://localhost:5000/admin")
    print("  Worker → http://localhost:5000/worker")
    print("  Multi-user: threaded=True (up to ~8 concurrent workers)")
    print("  Production: gunicorn -w 4 --bind 0.0.0.0:5000 app:app")
    print("═"*60 + "\n")
    app.run(host="0.0.0.0", port=5000, debug=True, threaded=True)
