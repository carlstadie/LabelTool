/* =========================================================
   label_tool.js – AWI PermafrostLabel 
   front end for label annotation
   ========================================================= */

// ── Globals injected by template ───────────────────────────────
// IMAGE_META  { id, wgs84_west/south/east/north, resolution_x/y, band_count }
// WORKER_NAME string
// CLASSES     array of { id, number, name, color, description }
// INIT_TILE_M number

// ── State ──────────────────────────────────────────────────────
let map, imageOverlay, drawnItems;
let currentMode      = 'cursor';
let pendingLayer     = null;   // { layer, type } while awaiting class assignment
let activeClassId    = null;
let gridLayer        = null;
let gridVisible      = true;
let TILE_SIZE_M      = INIT_TILE_M;
let sessionSaved     = 0;      // labels saved THIS session by this worker
let pendingLabels    = [];     // all tracked layers { layer, classId, type, saved, label_id }
let savedLayers      = {};     // label_id → layer map

let activeDrawHandler  = null;
let deleteClickHandler = null;

// ── Init ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const meta   = IMAGE_META;
  const bounds = [
    [meta.wgs84_south, meta.wgs84_west],
    [meta.wgs84_north, meta.wgs84_east],
  ];

  map = L.map('map', { zoomControl: true, attributionControl: false });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    opacity: 0.15, maxZoom: 22,
  }).addTo(map);

  imageOverlay = L.imageOverlay(`/api/image/${meta.id}/preview`, bounds, {
    opacity: 1, interactive: false,
  }).addTo(map);

  map.fitBounds(bounds);

  drawnItems = new L.FeatureGroup();
  map.addLayer(drawnItems);

  map.on('mousemove', e => {
    setStatusVal('sb-lat', e.latlng.lat.toFixed(6));
    setStatusVal('sb-lon', e.latlng.lng.toFixed(6));
  });
  map.on('zoomend', () => setStatusVal('sb-zoom', map.getZoom()));

  drawTileGrid();
  loadExistingLabels();
  document.addEventListener('keydown', onKeyDown);

  if (CLASSES.length) selectClass(CLASSES[0].id);
  setStatusVal('sb-zoom', map.getZoom());
});

// ── Helpers ─────────────────────────────────────────────────────
function setStatusVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ── Drawing Modes ───────────────────────────────────────────────
function setMode(mode) {
  // FIX 3: clean up previous handlers before setting new mode
  if (activeDrawHandler) { activeDrawHandler.disable(); activeDrawHandler = null; }
  if (deleteClickHandler) { map.off('click', deleteClickHandler); deleteClickHandler = null; }
  
  // Clean up custom draw state
  if (drawMarker) { map.removeLayer(drawMarker); drawMarker = null; }
  drawStart = null;

  currentMode = mode;
  setStatusVal('sb-mode', mode);

  // Sync ribbon button active state
  ['btn-cursor','btn-rectangle','btn-polygon','btn-delete'].forEach(id => {
    document.getElementById(id)?.classList.remove('active');
  });
  const modeToBtn = {
    cursor: 'btn-cursor', rectangle: 'btn-rectangle',
    polygon: 'btn-polygon', delete: 'btn-delete',
  };
  document.getElementById(modeToBtn[mode] || 'btn-cursor')?.classList.add('active');

  if (mode === 'rectangle') {
    startRectangleDraw();
  } else if (mode === 'polygon') {
    startPolygonDraw();
  } else if (mode === 'delete') {
    // Delete mode: persistent click handler — Esc or mode change exits
    map.dragging.disable();
    deleteClickHandler = function(e) {
      const entry = findEntryAtPoint(e.latlng);
      if (entry) deleteLabel(entry);
      // Stay in delete mode for multi-delete (Esc exits)
    };
    map.on('click', deleteClickHandler);
  } else if (mode === 'cursor') {
    // Cursor mode: enable panning
    map.dragging.enable();
  }
}

// ── Custom Draw Handlers ────────────────────────────────
let drawStart = null;
let drawMarker = null;
let polygonVertices = [];
let polygonMarkers  = [];   // vertex indicators; tracked for safe removal
let polygonOnClick = null;
let polygonOnDblClick = null;

function startRectangleDraw() {
  map.dragging.disable();
  drawStart = null;
  drawMarker = null;
  
  const onMouseDown = (e) => {
    drawStart = e.latlng;
    if (drawMarker) map.removeLayer(drawMarker);
    drawMarker = L.marker(drawStart, { opacity: 0.5 }).addTo(map);
  };
  
  const onMouseMove = (e) => {
    if (!drawStart) return;
    if (drawMarker) map.removeLayer(drawMarker);
    const corner1 = [drawStart.lat, drawStart.lng];
    const corner2 = [e.latlng.lat, e.latlng.lng];
    drawMarker = L.rectangle([corner1, corner2], { 
      color: '#7abfdc', weight: 2, fillOpacity: 0.1 
    }).addTo(map);
  };
  
  const onMouseUp = (e) => {
    if (!drawStart) return;
    map.off('mousedown', onMouseDown);
    map.off('mousemove', onMouseMove);
    map.off('mouseup', onMouseUp);
    
    const corner1 = [drawStart.lat, drawStart.lng];
    const corner2 = [e.latlng.lat, e.latlng.lng];
    const rect = L.rectangle([corner1, corner2], { 
      color: '#7abfdc', weight: 2, fillOpacity: 0.1 
    });
    
    if (drawMarker) map.removeLayer(drawMarker);
    drawStart = null;
    drawMarker = null;
    
    onShapeCreated({ layer: rect, layerType: 'rectangle' });
  };
  
  map.on('mousedown', onMouseDown);
  map.on('mousemove', onMouseMove);
  map.on('mouseup', onMouseUp);
  activeDrawHandler = { disable: () => {
    map.off('mousedown', onMouseDown);
    map.off('mousemove', onMouseMove);
    map.off('mouseup', onMouseUp);
  }};
}

function startPolygonDraw() {
  map.dragging.disable();
  polygonVertices = [];
  let tempLine = null;
  
  const addVertexMarker = (latlng) => {
    const m = L.circleMarker(latlng, {
      radius: 4, color: '#7abfdc', weight: 2,
      fillColor: '#fff', fillOpacity: 1,
    });
    m.addTo(map);
    polygonMarkers.push(m);
  };

  const clearVertexMarkers = () => {
    polygonMarkers.forEach(m => { try { map.removeLayer(m); } catch (_) {} });
    polygonMarkers = [];
  };

  polygonOnClick = (e) => {
    polygonVertices.push(e.latlng);
    addVertexMarker(e.latlng);
    if (polygonVertices.length >= 2) {
      const bounds = polygonVertices.map(v => [v.lat, v.lng]);
      if (tempLine) map.removeLayer(tempLine);
      tempLine = L.polyline(bounds, { 
        color: '#7abfdc', weight: 2, opacity: 0.7,
        lineJoin: 'round', lineCap: 'round'
      }).addTo(map);
    }
  };
  
  polygonOnDblClick = (e) => {
    if (polygonVertices.length < 3) {
      alert('Polygon requires at least 3 points');
      return;
    }
    map.off('click', polygonOnClick);
    map.off('dblclick', polygonOnDblClick);
    
    const bounds = polygonVertices.map(v => [v.lat, v.lng]);
    
    if (tempLine) map.removeLayer(tempLine);
    clearVertexMarkers();
    
    const poly = L.polygon(bounds, { 
      color: '#7abfdc', weight: 2, fillOpacity: 0.1,
      lineJoin: 'round', lineCap: 'round', smoothFactor: 0
    });
    
    polygonVertices = [];
    polygonOnClick = null;
    polygonOnDblClick = null;
    onShapeCreated({ layer: poly, layerType: 'polygon' });
  };
  
  map.on('click', polygonOnClick);
  map.on('dblclick', polygonOnDblClick);
  activeDrawHandler = { disable: () => {
    if (polygonOnClick) map.off('click', polygonOnClick);
    if (polygonOnDblClick) map.off('dblclick', polygonOnDblClick);
    polygonVertices = [];
    polygonOnClick = null;
    polygonOnDblClick = null;
    clearVertexMarkers();
    if (tempLine) { map.removeLayer(tempLine); tempLine = null; }
  }};
}

// Called by ribbon "Delete" button — toggles delete mode
function deleteSelected() {
  if (currentMode === 'delete') {
    setMode('cursor');
  } else {
    setMode('delete');
  }
}

function onShapeCreated(e) {
  if (activeDrawHandler) { activeDrawHandler.disable(); activeDrawHandler = null; }
  map.dragging.enable();  // Re-enable panning after shape drawn
  pendingLayer = { layer: e.layer, type: e.layerType };
  // Always show picker to let user assign class
  showPicker();
}

// ── Class Management ────────────────────────────────────────────
function selectClass(classId) {
  activeClassId = classId;
  const cls = CLASSES.find(c => c.id === classId);
  if (!cls) return;

  document.querySelectorAll('.class-item').forEach(el => el.classList.remove('selected'));
  document.getElementById('class-item-' + classId)?.classList.add('selected');
}

function showPicker() {
  document.getElementById('class-picker-overlay').style.display = 'flex';
}

function isOtherClass(classId) {
  const cls = CLASSES.find(c => c.id === classId);
  if (!cls) return false;
  return cls.number === 0 || (cls.name || '').toLowerCase() === 'other';
}

function findClassByName(name) {
  const target = (name || '').trim().toLowerCase();
  if (!target) return null;
  return CLASSES.find(c => (c.name || '').trim().toLowerCase() === target) || null;
}

async function resolveOtherClassChoice() {
  const suggestions = CLASSES
    .filter(c => c.number !== 0)
    .slice(0, 14)
    .map(c => `${c.number}: ${c.name}`)
    .join('\n');

  const raw = window.prompt(
    `Other class selected.\nType an existing class number/name, or enter a new class name.\n\nExisting classes:\n${suggestions}`
  );

  if (raw === null) return null;
  const value = raw.trim();
  if (!value) return null;

  const num = Number.parseInt(value, 10);
  if (Number.isInteger(num)) {
    const byNum = CLASSES.find(c => c.number === num && c.number !== 0);
    if (byNum) return byNum.id;
  }

  const byName = findClassByName(value);
  if (byName && byName.number !== 0) return byName.id;

  const resp = await fetch('/api/classes/resolve-other', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: value }),
  });
  if (!resp.ok) {
    let msg = 'Could not resolve class.';
    try {
      const d = await resp.json();
      if (d && d.error) msg = d.error;
    } catch {}
    alert(msg);
    return null;
  }

  const resolved = await resp.json();
  if (!CLASSES.find(c => c.id === resolved.id)) {
    CLASSES.push({
      id: resolved.id,
      number: resolved.number,
      name: resolved.name,
      color: resolved.color || '#9E9E9E',
      description: "Created from 'Other'",
    });
  }
  return resolved.id;
}

// Called by picker Cancel button
function cancelPending() {
  document.getElementById('class-picker-overlay').style.display = 'none';
  pendingLayer = null;
  // Stay in current draw mode — worker may want to redraw
}

// Called from onclick in picker items AND keyboard shortcut when picker open
async function assignClass(classId) {
  document.getElementById('class-picker-overlay').style.display = 'none';

  let targetClassId = classId;
  if (isOtherClass(classId)) {
    const resolvedId = await resolveOtherClassChoice();
    if (!resolvedId) {
      if (pendingLayer) showPicker();
      return;
    }
    targetClassId = resolvedId;
  }

  selectClass(targetClassId);
  if (pendingLayer) {
    confirmWithClass(targetClassId);
  }
}

function confirmWithClass(classId) {
  if (!pendingLayer) return;
  const { layer, type } = pendingLayer;
  pendingLayer = null;

  const cls = CLASSES.find(c => c.id === classId);
  if (!cls) return;

  styleLayer(layer, cls.color, true);
  drawnItems.addLayer(layer);

  const entry = { layer, classId, type, saved: false, label_id: null };
  pendingLabels.push(entry);
  layer.bindPopup(popupHTML(cls, WORKER_NAME, true));
  layer.on('click', () => { if (currentMode === 'delete') deleteLabel(entry); });

  updateCounts();
  saveEntry(entry);

  // Auto-restart draw mode so user can keep drawing without re-clicking ribbon
  if (currentMode === 'rectangle' || currentMode === 'polygon') {
    const m = currentMode;
    setTimeout(() => setMode(m), 60);
  }
}

// FIX 4: use '' not null for dashArray to properly clear dash stroke
function styleLayer(layer, color, isPending) {
  if (layer.setStyle) {
    layer.setStyle({
      color, weight: isPending ? 2.5 : 2,
      fillColor: color, fillOpacity: isPending ? 0.28 : 0.18,
      dashArray: isPending ? '6 3' : '',
      lineJoin: 'round',
      lineCap: 'round',
    });
  }
}

function popupHTML(cls, worker, unsaved) {
  return `<div style="font-family:'DM Sans',sans-serif;font-size:.82rem;min-width:140px;">
    <div style="display:flex;align-items:center;gap:.4rem;margin-bottom:.3rem;">
      <span style="width:10px;height:10px;border-radius:50%;background:${cls.color};display:inline-block;"></span>
      <strong>${cls.name}</strong>
    </div>
    <div style="color:#64748b;font-size:.75rem;">by ${worker}</div>
    ${unsaved ? '<div style="color:#f59e0b;font-size:.72rem;margin-top:.2rem;">⬤ unsaved</div>' : ''}
  </div>`;
}

// ── Save / Delete ───────────────────────────────────────────────
async function saveEntry(entry, options = {}) {
  if (!entry || entry.saved) return;
  try {
    const geom = entry.layer.toGeoJSON().geometry;
    const resp = await fetch('/api/labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: Boolean(options.keepalive),
      body: JSON.stringify({
        image_id: IMAGE_META.id,
        geometry: geom,
        label_type: entry.type,
        class_id: entry.classId,
        tile_size_m: TILE_SIZE_M,
      }),
    });
    if (!resp.ok) return;

    const data = await resp.json();
    entry.saved = true;
    entry.label_id = data.id;
    savedLayers[data.id] = entry.layer;
    sessionSaved++;

    const cls = CLASSES.find(c => c.id === entry.classId);
    if (cls) {
      styleLayer(entry.layer, cls.color, false);
      entry.layer.getPopup()?.setContent(popupHTML(cls, WORKER_NAME, false));
    }
    updateCounts();
  } catch (err) {
    console.error('Save error:', err);
  }
}

async function saveAllPending() {
  const toSave = pendingLabels.filter(e => !e.saved);
  if (!toSave.length) return;

  const btn = document.getElementById('btn-save');
  if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }

  for (const entry of toSave) {
    await saveEntry(entry);
  }

  if (btn) { btn.textContent = 'Save'; btn.disabled = false; }
  updateCounts();
}

async function deleteLabel(entry) {
  if (entry.label_id) {
    await fetch(`/api/labels/${entry.label_id}`, { method: 'DELETE' });
    if (entry.saved) sessionSaved = Math.max(0, sessionSaved - 1);
    delete savedLayers[entry.label_id];
  }
  drawnItems.removeLayer(entry.layer);
  const idx = pendingLabels.indexOf(entry);
  if (idx > -1) pendingLabels.splice(idx, 1);
  updateCounts();
}

async function loadExistingLabels() {
  try {
    const resp  = await fetch(`/api/labels?image_id=${IMAGE_META.id}`);
    const items = await resp.json();

    for (const lbl of items) {
      let layer;
      try {
        layer = L.geoJSON(JSON.parse(lbl.geojson)).getLayers()[0];
      } catch { continue; }

      const cls = CLASSES.find(c => c.id === lbl.class_id) ||
                  { color: '#4A90D9', name: 'Unknown', id: null };
      styleLayer(layer, cls.color, false);
      layer.bindPopup(popupHTML(cls, lbl.worker_name, false));
      drawnItems.addLayer(layer);

      const entry = { layer, classId: lbl.class_id, type: lbl.label_type,
                      saved: true, label_id: lbl.id };
      pendingLabels.push(entry);
      savedLayers[lbl.id] = layer;
      layer.on('click', () => { if (currentMode === 'delete') deleteLabel(entry); });
    }

    // Show total on image (all workers) in the "Total" counter
    const totalEl = document.getElementById('lbl-total');
    if (totalEl) totalEl.textContent = items.length;
  } catch (err) {
    console.error('Load error:', err);
  }
}

// FIX 7: separate total-image count from session count
function updateCounts() {
  const unsaved = pendingLabels.filter(e => !e.saved).length;
  const total   = pendingLabels.length;
  setStatusVal('lbl-total',   total);
  setStatusVal('lbl-session', sessionSaved + (unsaved ? ` (+${unsaved} unsaved)` : ''));
}

// ── Mark Done ───────────────────────────────────────────────────
async function closeImage() {
  await saveAllPending();
  await fetch(`/api/image/${IMAGE_META.id}/close`, { method: 'POST' });
  window.location.href = '/worker/queue';
}

async function markDone() {
  await saveAllPending();
  await fetch(`/api/image/${IMAGE_META.id}/done`, { method: 'POST' });
  window.location.href = '/worker/queue';
}

function confirmLeave() {
  const unsaved = pendingLabels.filter(e => !e.saved).length;
  return unsaved === 0 || confirm(`${unsaved} unsaved label(s). Leave without saving?`);
}

// ── Tile Grid ──────────────────────────────────────────────────
function drawTileGrid() {
  if (gridLayer) { map.removeLayer(gridLayer); gridLayer = null; }
  if (!gridVisible) return;

  const { wgs84_west: west, wgs84_east: east,
          wgs84_south: south, wgs84_north: north } = IMAGE_META;
  const centerLat = (south + north) / 2;
  const degLat    = TILE_SIZE_M / 111320;
  const degLng    = TILE_SIZE_M / (111320 * Math.cos(centerLat * Math.PI / 180));

  const style = { color: '#fff', weight: 0.5, opacity: 0.4, interactive: false };
  const lines = [];

  // FIX: cap line count to prevent browser freeze at tiny tile sizes
  const maxV = Math.min(Math.ceil((east  - west)  / degLng) + 2, 300);
  const maxH = Math.min(Math.ceil((north - south) / degLat) + 2, 300);
  const x0   = Math.floor(west  / degLng) * degLng;
  const y0   = Math.floor(south / degLat) * degLat;

  for (let i = 0; i < maxV; i++)
    lines.push(L.polyline([[south, x0 + i * degLng], [north, x0 + i * degLng]], style));
  for (let i = 0; i < maxH; i++)
    lines.push(L.polyline([[y0 + i * degLat, west],  [y0 + i * degLat, east]],  style));

  gridLayer = L.layerGroup(lines).addTo(map);
}

// FIX 6: debounce grid redraws (200ms) to avoid lag while dragging slider
let _tileTimer = null;
function updateTileSize(val) {
  TILE_SIZE_M = parseFloat(val);
  const el = document.getElementById('tile-val');
  if (el) el.textContent = `${Math.round(val)}m`;
  clearTimeout(_tileTimer);
  _tileTimer = setTimeout(drawTileGrid, 200);
}

function toggleGrid() {
  gridVisible = !gridVisible;
  document.getElementById('btn-grid')?.classList.toggle('active', gridVisible);
  drawTileGrid();
}

// ── Band re-render ──────────────────────────────────────────────
let _bandTimer = null;
function rerenderPreview() {
  clearTimeout(_bandTimer);
  _bandTimer = setTimeout(() => {
    const r = document.getElementById('band-r').value;
    const g = document.getElementById('band-g').value;
    const b = document.getElementById('band-b').value;
    // FIX 10: cache-bust with timestamp so browser doesn't serve stale image
    const url = `/api/image/${IMAGE_META.id}/preview?bands=${r},${g},${b}&_t=${Date.now()}`;
    const bounds = [
      [IMAGE_META.wgs84_south, IMAGE_META.wgs84_west],
      [IMAGE_META.wgs84_north, IMAGE_META.wgs84_east],
    ];
    if (imageOverlay) map.removeLayer(imageOverlay);
    imageOverlay = L.imageOverlay(url, bounds, { opacity: 1, interactive: false }).addTo(map);
    imageOverlay.bringToBack();
    if (gridLayer) gridLayer.bringToFront();
    drawnItems.bringToFront();
  }, 400);
}

// ── Keyboard Shortcuts ──────────────────────────────────────────
function onKeyDown(e) {
  const tag = document.activeElement.tagName.toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

  const pickerOpen = document.getElementById('class-picker-overlay').style.display !== 'none';

  // 0–9: class hotkeys — use e.code for keyboard-layout independence
  const digitMatch = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
  if (digitMatch) {
    const num = parseInt(digitMatch[1], 10);
    const cls = CLASSES.find(c => c.number === num);
    if (!cls) return;
    e.preventDefault();
    if (pickerOpen) {
      assignClass(cls.id);
    } else if (num !== 0) {
      selectClass(cls.id);
    }
    return;
  }

  if (pickerOpen) {
    if (e.key === 'Escape') cancelPending();
    return;
  }

  const k = e.key.toLowerCase();
  if (k === 'r')       setMode('rectangle');
  else if (k === 'p')  setMode('polygon');
  else if (k === 'd')  deleteSelected();
  else if (k === 'c')  closeImage();
  else if (k === 'escape') setMode('cursor');
  else if (k === 'g')  toggleGrid();
  else if (k === 's')  saveAllPending();
  else if (k === 'enter') { e.preventDefault(); markDone(); }
}

// ── Helper ──────────────────────────────────────────────────────
function findEntryAtPoint(latlng) {
  for (const entry of pendingLabels) {
    try {
      if (entry.layer.getBounds?.().contains(latlng)) return entry;
    } catch {}
  }
  return null;
}

// Auto-save every 2 minutes
setInterval(() => {
  if (pendingLabels.some(e => !e.saved)) saveAllPending();
}, 120_000);
