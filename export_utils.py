"""
export_utils.py – Export labels to GeoJSON, Shapefile, GPKG, GeoParquet, CSV
"""
import io
import json
import zipfile
import tempfile
import os
from pathlib import Path
from datetime import datetime

try:
    import geopandas as gpd
    from shapely.geometry import shape, mapping
    import pandas as pd
    HAS_GEO = True
except ImportError:
    HAS_GEO = False


def labels_to_geodataframe(labels: list):
    """Convert label dicts (from DB) into a GeoDataFrame."""
    if not HAS_GEO:
        raise RuntimeError("geopandas and shapely required")

    records = []
    geometries = []
    for lbl in labels:
        try:
            geom = shape(json.loads(lbl['geojson']))
        except Exception:
            continue
        records.append({
            'label_id':    lbl['id'],
            'image_id':    lbl['image_id'],
            'image_file':  lbl.get('original_filename', ''),
            'group':       lbl.get('group_name', ''),
            'worker':      lbl['worker_name'],
            'class_id':    lbl.get('class_id'),
            'class_name':  lbl.get('class_name', ''),
            'class_no':    lbl.get('class_number'),
            'class_color': lbl.get('class_color', ''),
            'label_type':  lbl['label_type'],
            'basemap':     lbl.get('basemap', ''),
            'tile_size_m': lbl.get('tile_size_m'),
            'created_at':  lbl['created_at'],
        })
        geometries.append(geom)

    if not records:
        return None

    gdf = gpd.GeoDataFrame(records, geometry=geometries, crs="EPSG:4326")
    return gdf


def export_labels(labels: list, fmt: str) -> tuple[bytes, str, str]:
    """
    Export labels to the requested format.
    Returns (bytes, filename, mimetype).
    Supported formats: geojson, shapefile, gpkg, geoparquet, csv
    """
    gdf = labels_to_geodataframe(labels)
    ts  = datetime.utcnow().strftime("%Y%m%d_%H%M%S")

    if gdf is None or gdf.empty:
        return b"", "empty.txt", "text/plain"

    fmt = fmt.lower()

    # ── GeoJSON ──────────────────────────────────────────────────────────────
    if fmt == "geojson":
        buf = io.BytesIO()
        buf.write(gdf.to_json(indent=2).encode())
        buf.seek(0)
        return buf.read(), f"labels_{ts}.geojson", "application/geo+json"

    # ── Shapefile (zipped) ────────────────────────────────────────────────────
    if fmt in ("shapefile", "shp"):
        with tempfile.TemporaryDirectory() as tmpdir:
            out = Path(tmpdir) / "labels"
            gdf.to_file(str(out), driver="ESRI Shapefile")
            zip_buf = io.BytesIO()
            with zipfile.ZipFile(zip_buf, 'w', zipfile.ZIP_DEFLATED) as zf:
                for f in Path(tmpdir).glob("labels.*"):
                    zf.write(f, f.name)
            zip_buf.seek(0)
            return zip_buf.read(), f"labels_{ts}.zip", "application/zip"

    # ── GeoPackage ────────────────────────────────────────────────────────────
    if fmt == "gpkg":
        with tempfile.NamedTemporaryFile(suffix=".gpkg", delete=False) as tmp:
            tmppath = tmp.name
        try:
            gdf.to_file(tmppath, driver="GPKG", layer="labels")
            data = Path(tmppath).read_bytes()
        finally:
            os.unlink(tmppath)
        return data, f"labels_{ts}.gpkg", "application/octet-stream"

    # ── GeoParquet ────────────────────────────────────────────────────────────
    if fmt == "geoparquet":
        buf = io.BytesIO()
        gdf.to_parquet(buf, index=False)
        buf.seek(0)
        return buf.read(), f"labels_{ts}.parquet", "application/octet-stream"

    # ── CSV (WKT geometry) ────────────────────────────────────────────────────
    if fmt == "csv":
        df = gdf.copy()
        df['geometry_wkt'] = df.geometry.apply(lambda g: g.wkt)
        df = df.drop(columns=['geometry'])
        buf = io.BytesIO()
        df.to_csv(buf, index=False)
        buf.seek(0)
        return buf.read(), f"labels_{ts}.csv", "text/csv"

    raise ValueError(f"Unknown export format: {fmt}")


def export_footprints(images: list, fmt: str) -> tuple[bytes, str, str]:
    """
    Export image footprints (bounding boxes) with class summary attributes.
    images: list of dicts with wgs84 bounds and label summary.
    """
    if not HAS_GEO:
        raise RuntimeError("geopandas required")

    from shapely.geometry import box
    ts = datetime.utcnow().strftime("%Y%m%d_%H%M%S")

    records = []
    geometries = []
    for img in images:
        geom = box(img['wgs84_west'], img['wgs84_south'],
                   img['wgs84_east'], img['wgs84_north'])
        records.append({
            'image_id':   img['id'],
            'filename':   img.get('original_filename', ''),
            'group':      img.get('group_name', ''),
            'status':     img.get('status', ''),
            'label_count':img.get('label_count', 0),
            'classes':    img.get('classes', ''),
            'workers':    img.get('workers', ''),
        })
        geometries.append(geom)

    if not records:
        return b"", "empty.txt", "text/plain"

    gdf = gpd.GeoDataFrame(records, geometry=geometries, crs="EPSG:4326")

    fmt = fmt.lower()
    if fmt == "geojson":
        data = gdf.to_json(indent=2).encode()
        return data, f"footprints_{ts}.geojson", "application/geo+json"
    if fmt in ("shapefile", "shp"):
        with tempfile.TemporaryDirectory() as tmpdir:
            out = Path(tmpdir) / "footprints"
            gdf.to_file(str(out), driver="ESRI Shapefile")
            zip_buf = io.BytesIO()
            with zipfile.ZipFile(zip_buf, 'w', zipfile.ZIP_DEFLATED) as zf:
                for f in Path(tmpdir).glob("footprints.*"):
                    zf.write(f, f.name)
            zip_buf.seek(0)
            return zip_buf.read(), f"footprints_{ts}.zip", "application/zip"
    if fmt == "gpkg":
        with tempfile.NamedTemporaryFile(suffix=".gpkg", delete=False) as tmp:
            tmppath = tmp.name
        try:
            gdf.to_file(tmppath, driver="GPKG", layer="footprints")
            data = Path(tmppath).read_bytes()
        finally:
            os.unlink(tmppath)
        return data, f"footprints_{ts}.gpkg", "application/octet-stream"
    if fmt == "geoparquet":
        buf = io.BytesIO()
        gdf.to_parquet(buf, index=False)
        buf.seek(0)
        return buf.read(), f"footprints_{ts}.parquet", "application/octet-stream"
    if fmt == "csv":
        df = gdf.copy()
        df['geometry_wkt'] = df.geometry.apply(lambda g: g.wkt)
        df = df.drop(columns=['geometry'])
        buf = io.BytesIO()
        df.to_csv(buf, index=False)
        buf.seek(0)
        return buf.read(), f"footprints_{ts}.csv", "text/csv"

    raise ValueError(f"Unknown format: {fmt}")
