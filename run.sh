#!/bin/bash
# AWI PermafrostLabel – Startup Script
set -e

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║          AWI PermafrostLabel                        ║"
echo "║          Remote Sensing Labelling Tool              ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  Admin  → http://localhost:5000/admin               ║"
echo "║  Worker → http://localhost:5000/worker              ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# Check Python
if ! command -v python3 &> /dev/null; then
    echo "ERROR: Python 3 not found. Please install Python 3.9+"
    exit 1
fi

# Install deps if needed
if ! python3 -c "import flask" 2>/dev/null; then
    echo "Installing dependencies..."
    pip install -r requirements.txt --break-system-packages --quiet
fi

# Start Flask
python3 app.py
