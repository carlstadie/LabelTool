# AWI PermafrostLabel

**Remote Sensing Image Labelling Tool**  
Alfred Wegener Institute · Permafrost Remote Sensing Section · Potsdam

---

## Quick Start

```bash
# 1. Install dependencies (once)
pixi init 
pixi install

# 2. Start the server
pixi run ResponseLabel
```

| Portal | URL |
|--------|-----|
| **Admin** | http://localhost:5000/admin |
| **Worker** | http://localhost:5000/worker |
| **Help** | http://localhost:5000/help |

Default admin token: `roffltrollisttoll` (change in Admin → Configuration)

---

## Features

### Admin Portal
- **Groups** – organise images by project, region, or sensor
- **Upload** – drag & drop GeoTIFF files with automatic metadata extraction
- **Classes** – define label classes with key numbers (1–9), colours, descriptions
- **Configuration** – app name, logo, admin token, default tile size
- **Export** – labels and image footprints in GeoJSON / Shapefile / GPKG / GeoParquet / CSV
- **Map preview** – interactive map of all labels and footprints

### Worker Portal
- Name-only login (recorded with every label)
- Image queue filtered by group
- **Labelling tool** with:
  - Rectangle and polygon drawing modes
  - Keyboard shortcut class assignment (1–9)
  - Adjustable tile grid overlay (10–2000 m)
  - Band order control (R/G/B from any bands)
  - Zoom & pan
  - Auto-save every 2 minutes
- Personal export of labels and footprints

---

## Keyboard Shortcuts (Labelling Tool)

| Key | Action |
|-----|--------|
| `R` | Rectangle mode |
| `P` | Polygon mode |
| `D` | Delete mode |
| `Esc` | Pan mode |
| `G` | Toggle grid |
| `S` | Save labels |
| `Enter` | Mark done & return to queue |
| `1`–`9` | Select class by number |

---

## Export Formats

| Format | Extension | Notes |
|--------|-----------|-------|
| GeoJSON | `.geojson` | Universal, web-ready |
| Shapefile | `.zip` | ArcGIS / QGIS compatible |
| GeoPackage | `.gpkg` | Recommended for QGIS |
| GeoParquet | `.parquet` | ML/big-data pipelines |
| CSV (WKT) | `.csv` | Tabular analysis |

All geometries are stored in **EPSG:4326** (WGS 84).

---

## Project Structure

```
awi_labeller/
├── app.py              ← Flask application (all routes)
├── database.py         ← SQLite schema & CRUD
├── image_utils.py      ← GeoTIFF reading & preview rendering
├── export_utils.py     ← Multi-format export (GeoPandas)
├── requirements.txt
├── setup.sh
├── labeller.db         ← Created on first run
├── uploads/            ← GeoTIFF files
├── previews/           ← Generated PNG previews
├── exports/            ← Temporary export files
├── templates/
│   ├── base.html
│   ├── admin_base.html
│   ├── admin_dashboard.html
│   ├── admin_upload.html
│   ├── admin_classes.html
│   ├── admin_groups.html
│   ├── admin_images.html
│   ├── admin_config.html
│   ├── admin_export.html
│   ├── admin_login.html
│   ├── worker_login.html
│   ├── worker_queue.html
│   ├── worker_label.html
│   ├── worker_export.html
│   ├── help.html
│   └── home.html
└── static/
    ├── css/style.css
    └── js/label_tool.js
```

---

## Network Access (Multi-user)

For multiple workers on a local network, find the server's LAN IP:

```bash
# Linux/macOS
ip addr show | grep "inet " | grep -v 127.0.0.1

# Windows
ipconfig
```

Workers then open: `http://<server-ip>:5000/worker`

---

## Configuration

All settings are editable via **Admin → Configuration** or by editing `labeller.db` directly.

| Setting | Default | Description |
|---------|---------|-------------|
| `app_name` | `PermafrostLabel` | Application title |
| `organization` | AWI line | Shown in header |
| `logo_url` | (blank) | URL to a logo image |
| `admin_token` | `awi-admin-2024` | Admin portal password |
| `max_preview_px` | `3000` | Max preview resolution |
| `default_tile_size_m` | `100` | Default grid tile size |

---

*Alfred Wegener Institute for Polar and Marine Research — Permafrost Remote Sensing*
