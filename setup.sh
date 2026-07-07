#!/bin/bash
# setup.sh — Install dependencies for AWI PermafrostLabel
set -e

echo "=============================================="
echo "  AWI PermafrostLabel — Dependency Setup"
echo "=============================================="

# Create virtual environment if not present
if [ ! -d "venv" ]; then
  echo "→ Creating virtual environment..."
  python3 -m venv venv
fi

source venv/bin/activate

echo "→ Installing Python packages..."
pip install --upgrade pip -q
pip install \
  Flask>=2.3.0 \
  rasterio>=1.3.0 \
  numpy>=1.24.0 \
  Pillow>=10.0.0 \
  geopandas>=0.14.0 \
  shapely>=2.0.0 \
  pyproj>=3.5.0 \
  pandas>=2.0.0 \
  fiona>=1.9.0 \
  pyarrow>=14.0.0

echo ""
echo "✓ Setup complete!"
echo ""
echo "  Run: source venv/bin/activate && python app.py"
echo "  Admin:  http://localhost:5000/admin"
echo "  Worker: http://localhost:5000/worker"
echo "=============================================="
