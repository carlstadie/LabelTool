"""
image_utils.py – GeoTIFF reading, preview rendering, metadata extraction
"""
import io
import json
import numpy as np
from pathlib import Path

try:
    import rasterio
    from rasterio.warp import transform_bounds
    from rasterio.enums import Resampling
    from pyproj import Transformer
    HAS_RASTERIO = True
except ImportError:
    HAS_RASTERIO = False

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False


def read_metadata(filepath: str) -> dict:
    """Extract full metadata from a GeoTIFF."""
    if not HAS_RASTERIO:
        raise RuntimeError("rasterio not installed")

    with rasterio.open(filepath) as src:
        crs_str = src.crs.to_string() if src.crs else "EPSG:4326"
        bounds  = src.bounds
        nodata  = src.nodata

        # Convert to WGS84 for Leaflet
        try:
            wgs84 = transform_bounds(src.crs, "EPSG:4326",
                                     bounds.left, bounds.bottom,
                                     bounds.right, bounds.top)
            w84_west, w84_south, w84_east, w84_north = wgs84
        except Exception:
            w84_west, w84_south = bounds.left, bounds.bottom
            w84_east, w84_north = bounds.right, bounds.top

        band_descriptions = []
        for i in range(src.count):
            desc = src.descriptions[i]
            band_descriptions.append(desc if desc else f"Band {i+1}")

        res_x = abs(src.transform.a)
        res_y = abs(src.transform.e)

        return {
            "crs":              crs_str,
            "width":            src.width,
            "height":           src.height,
            "band_count":       src.count,
            "resolution_x":     res_x,
            "resolution_y":     res_y,
            "nodata":           nodata,
            "bbox_minx":        bounds.left,
            "bbox_miny":        bounds.bottom,
            "bbox_maxx":        bounds.right,
            "bbox_maxy":        bounds.top,
            "wgs84_west":       w84_west,
            "wgs84_south":      w84_south,
            "wgs84_east":       w84_east,
            "wgs84_north":      w84_north,
            "band_descriptions": json.dumps(band_descriptions),
        }


def render_preview(filepath: str, bands=(1, 2, 3),
                   max_px: int = 3000,
                   stretch=(2, 98)) -> bytes:
    """
    Read selected bands from a GeoTIFF, apply percentile stretch,
    and return a PNG byte string.
    """
    if not HAS_RASTERIO or not HAS_PIL:
        raise RuntimeError("rasterio and Pillow required")

    with rasterio.open(filepath) as src:
        n_bands = src.count
        bands = [max(1, min(b, n_bands)) for b in bands]

        scale = min(max_px / src.width, max_px / src.height, 1.0)
        out_w = max(1, int(src.width  * scale))
        out_h = max(1, int(src.height * scale))

        rgb = []
        for band_num in bands[:3]:
            data = src.read(
                band_num,
                out_shape=(out_h, out_w),
                resampling=Resampling.bilinear,
            ).astype(np.float32)

            nodata = src.nodata
            if nodata is not None:
                data = np.where(data == nodata, np.nan, data)

            valid = data[~np.isnan(data)]
            if valid.size > 0:
                lo, hi = np.percentile(valid, stretch)
                rng = hi - lo if hi != lo else 1.0
                data = (data - lo) / rng
            data = np.clip(np.nan_to_num(data, nan=0.0), 0, 1)
            rgb.append((data * 255).astype(np.uint8))

        # Pad to 3 bands if fewer selected
        while len(rgb) < 3:
            rgb.append(rgb[-1] if rgb else np.zeros((out_h, out_w), np.uint8))

        img_arr = np.stack(rgb[:3], axis=-1)
        img = Image.fromarray(img_arr, "RGB")

        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=True)
        buf.seek(0)
        return buf.read()


def save_preview(filepath: str, preview_dir: str, image_id: int,
                 bands=(1, 2, 3)) -> str:
    """Render and save preview PNG; return relative path."""
    png_bytes = render_preview(filepath, bands=bands)
    out_path = Path(preview_dir) / f"{image_id}.png"
    out_path.write_bytes(png_bytes)
    return str(out_path)
