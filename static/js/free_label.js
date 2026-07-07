/* =========================================================
   free_label.js – AWI PermafrostLabel
   Free labelling: draw on web basemaps, no GeoTIFF needed.
   Mirrors label_tool.js's hand-rolled draw architecture.
   ========================================================= */

// ── Quadkey helper for Bing Maps tiles ─────────────────────
function tileToQuadkey(x, y, z) {
  let key = '';
  for (let i = z; i > 0; i--) {
    let d = 0;
    const mask = 1 << (i - 1);
    if (x & mask) d += 1;
    if (y & mask) d += 2;
    key += d;
  }
  return key;
}

const BingLayer = L.TileLayer.extend({
  getTileUrl(coords) {
    const q = tileToQuadkey(coords.x, coords.y, coords.z);
    const server = Math.floor(Math.random() * 4);
    return `https://ecn.t${server}.tiles.virtualearth.net/tiles/a${q}.jpeg?g=1`;
  }
});

// ── Basemap catalogue ───────────────────────────────────────
const BASEMAPS = [
  { id:'esri_imagery', name:'Esri World Imagery', desc:'Maxar/DigitalGlobe, zoom 23 in much of the Arctic',
    stars:5, icon:'🛰️', bg:'linear-gradient(135deg,#1a3a2a,#2d6040)', type:'xyz',
    url:'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attr:'© Esri, Maxar, GeoEye, Earthstar Geographics', max:23, group:'satellite' },
  { id:'esri_clarity', name:'Esri Clarity', desc:'Enhanced sharpening, often crisper than standard Esri',
    stars:5, icon:'✨', bg:'linear-gradient(135deg,#1a2a3a,#2d4060)', type:'xyz',
    url:'https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attr:'© Esri', max:23, group:'satellite' },
  { id:'google_satellite', name:'Google Maps Satellite', desc:'High-res, frequently updated, strong Arctic coverage',
    stars:5, icon:'🌐', bg:'linear-gradient(135deg,#1e3a1e,#346034)', type:'xyz_s',
    url:'https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', subs:['0','1','2','3'],
    attr:'© Google', max:21, group:'satellite', note:'Unofficial tiles, research use only' },
  { id:'google_hybrid', name:'Google Hybrid', desc:'Satellite plus road and place labels',
    stars:4, icon:'🗺️', bg:'linear-gradient(135deg,#1e3030,#305050)', type:'xyz_s',
    url:'https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', subs:['0','1','2','3'],
    attr:'© Google', max:21, group:'satellite', note:'Unofficial tiles, research use only' },
  { id:'bing_aerial', name:'Bing Aerial', desc:'Microsoft, high-res globally, strong Arctic data',
    stars:5, icon:'🔷', bg:'linear-gradient(135deg,#1a2a40,#2a4060)', type:'bing',
    attr:'© Microsoft, Bing', max:20, group:'satellite' },
  { id:'esri_topo', name:'Esri World Topo', desc:'Terrain, contours, place names for reference',
    stars:3, icon:'🏔️', bg:'linear-gradient(135deg,#c8d8c0,#a8c090)', type:'xyz',
    url:'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    attr:'© Esri', max:23, group:'reference' },
  { id:'osm', name:'OpenStreetMap', desc:'Roads, rivers, place names for context',
    stars:2, icon:'🗾', bg:'linear-gradient(135deg,#d4e8f0,#b8d4e4)', type:'xyz_s',
    url:'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', subs:'abc',
    attr:'© OpenStreetMap contributors', max:19, group:'reference' },
];

// ── State ───────────────────────────────────────────────────
let map, tileLayer, drawnItems;
let currentMode        = 'cursor';
let activeClassId      = null;
let pendingLayer       = null;
let pendingLabels      = [];
let savedCount         = 0;
let activeDrawHandler  = null;
let deleteClickHandler = null;
let activeBmId         = 'esri_imagery';
let activeBmName       = 'Esri World Imagery';

// ── Init ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  map = L.map('map', { zoomControl: true, attributionControl: true });
  map.setView([72, 90], 5);

  drawnItems = new L.FeatureGroup();
  map.addLayer(drawnItems);

  applyBasemap('esri_imagery');

  map.on('mousemove', e => {
    setVal('sb-lat', e.latlng.lat.toFixed(6));
    setVal('sb-lon', e.latlng.lng.toFixed(6));
  });
  map.on('zoomend', onZoomChange);
  onZoomChange();

  buildBasemapPanel();
  document.addEventListener('keydown', onKeyDown);

  ['goto-lat', 'goto-lon', 'goto-zoom'].forEach(id => {
    document.getElementById(id)?.addEventListener('keydown', e => {
      if (e.key === 'Enter') gotoCoords();
    });
  });

  if (CLASSES.length) selectClass(CLASSES[0].id);
});

function setVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function mpp(zoom) {
  const m = (2 * Math.PI * 6378137) / (256 * Math.pow(2, zoom));
  return m < 1 ? m.toFixed(2) + ' m/px'
       : m < 1000 ? Math.round(m) + ' m/px'
       : (m / 1000).toFixed(1) + ' km/px';
}

function onZoomChange() {
  const z = map.getZoom();
  setVal('sb-zoom', z);
  setVal('zoom-val', z);
  setVal('res-val', '~' + mpp(z));
}

// ── Basemaps ────────────────────────────────────────────────
function applyBasemap(id) {
  const bm = BASEMAPS.find(b => b.id === id);
  if (!bm) return;

  activeBmId = id;
  activeBmName = bm.name;

  if (tileLayer) map.removeLayer(tileLayer);

  if (bm.type === 'bing') {
    tileLayer = new BingLayer('', { maxZoom: bm.max || 20, attribution: bm.attr }).addTo(map);
  } else {
    const opts = {
      maxZoom: bm.max || 19,
      attribution: bm.attr,
    };
    if (bm.subs) {
      opts.subdomains = bm.subs;
    } else if (typeof bm.url === 'string' && bm.url.includes('{s}')) {
      opts.subdomains = 'abc';
    }
    tileLayer = L.tileLayer(bm.url, opts).addTo(map);
  }
  tileLayer.bringToBack();
  if (drawnItems) drawnItems.bringToFront();

  const ribbonEl = document.getElementById('current-bm-name');
  if (ribbonEl) ribbonEl.textContent = bm.name.split(' ').slice(0, 3).join(' ');
  setVal('sb-basemap', bm.name);

  document.querySelectorAll('.bm-item').forEach(el => {
    el.classList.toggle('active', el.dataset.bmId === id);
  });
}

function buildBasemapPanel() {
  const list = document.getElementById('bm-list');
  if (!list) return;
  let lastGroup = null;
  BASEMAPS.forEach(bm => {
    if (bm.group !== lastGroup) {
      lastGroup = bm.group;
      const lbl = document.createElement('div');
      lbl.className = 'bm-section-label';
      lbl.textContent = bm.group === 'satellite' ? '— Satellite Imagery —' : '— Reference Maps —';
      list.appendChild(lbl);
    }
    const item = document.createElement('div');
    item.className = 'bm-item' + (bm.id === activeBmId ? ' active' : '');
    item.dataset.bmId = bm.id;
    const stars = '<span class="bm-stars">' + '★'.repeat(bm.stars) +
                  '<span class="off">' + '★'.repeat(5 - bm.stars) + '</span></span>';
    item.innerHTML = `
      <div class="bm-thumb" style="background:${bm.bg};">${bm.icon}</div>
      <div class="bm-info">
        <div class="bm-name">${bm.name}</div>
        <div style="display:flex;align-items:center;gap:.35rem;margin-top:.05rem;">${stars}<span class="bm-desc">${bm.desc}</span></div>
        ${bm.note ? `<div class="bm-note">⚠ ${bm.note}</div>` : ''}
      </div>`;
    item.addEventListener('click', () => applyBasemap(bm.id));
    list.appendChild(item);
  });
}

function toggleBasemapPanel() {
  document.getElementById('bm-panel').classList.toggle('hidden');
}

function toggleGoto() {
  const panel = document.getElementById('goto-panel');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) document.getElementById('goto-lat').focus();
}

function gotoCoords() {
  const lat = parseFloat(document.getElementById('goto-lat').value);
  const lon = parseFloat(document.getElementById('goto-lon').value);
  const zoom = parseInt(document.getElementById('goto-zoom').value, 10) || 12;
  if (isNaN(lat) || isNaN(lon)) return;
  map.setView([lat, lon], zoom);
  document.getElementById('goto-panel').classList.add('hidden');
}

// ── Drawing Modes ───────────────────────────────────────────
function setMode(mode) {
  if (activeDrawHandler)  { activeDrawHandler.disable(); activeDrawHandler = null; }
  if (deleteClickHandler) { map.off('click', deleteClickHandler); deleteClickHandler = null; }
  if (drawMarker) { map.removeLayer(drawMarker); drawMarker = null; }
  drawStart = null;

  currentMode = mode;
  setVal('sb-mode', mode);

  ['btn-cursor','btn-rectangle','btn-point','btn-polygon','btn-delete'].forEach(id => {
    document.getElementById(id)?.classList.remove('active','active-danger');
  });
  const modeToBtn = { cursor:'btn-cursor', rectangle:'btn-rectangle', point:'btn-point', stream:'btn-stream', polygon:'btn-polygon', delete:'btn-delete' };
  const btn = document.getElementById(modeToBtn[mode] || 'btn-cursor');
  btn?.classList.add(mode === 'delete' ? 'active-danger' : 'active');

  if (mode === 'rectangle') {
    startRectangleDraw();
  } else if (mode === 'point') {
    startPointDraw();
  } else if (mode === 'stream') {
    startStreamDraw();
  } else if (mode === 'polygon') {
    startPolygonDraw();
  } else if (mode === 'delete') {
    map.dragging.disable();
    deleteClickHandler = e => {
      const entry = findEntryAtPoint(e.latlng);
      if (entry) deleteLabel(entry);
    };
    map.on('click', deleteClickHandler);
  } else if (mode === 'cursor') {
    map.dragging.enable();
  }
}

let drawStart = null;
let drawMarker = null;
let polygonVertices = [];
let polygonMarkers = [];
let polygonOnClick = null;
let polygonOnDblClick = null;
let polygonOnContextMenu = null;
let streamVertices = [];
let streamMarkers = [];
let streamOnMouseDown = null;
let streamOnMouseMove = null;
let streamOnMouseUp = null;
let streamOnContextMenu = null;
let streamTempLine = null;
let streamIsDrawing = false;

function startPointDraw() {
  map.dragging.disable();

  const onClick = e => {
    map.off('click', onClick);
    const pt = L.circleMarker(e.latlng, {
      radius: 6,
      color: '#7abfdc',
      weight: 2,
      fillColor: '#7abfdc',
      fillOpacity: 0.25,
    });
    onShapeCreated({ layer: pt, layerType: 'point' });
  };

  map.on('click', onClick);
  activeDrawHandler = { disable: () => map.off('click', onClick) };
}

function startStreamDraw() {
  map.dragging.disable();
  streamVertices = [];
  streamMarkers = [];
  streamTempLine = null;
  streamIsDrawing = false;

  const addVertexMarker = latlng => {
    const m = L.circleMarker(latlng, {
      radius: 2.5,
      color: '#7abfdc',
      weight: 1,
      fillColor: '#fff',
      fillOpacity: 0.9,
      interactive: false,
    });
    m.addTo(map);
    streamMarkers.push(m);
  };

  const clearStreamMarkers = () => {
    streamMarkers.forEach(m => { try { map.removeLayer(m); } catch (_) {} });
    streamMarkers = [];
  };

  const updateTempLine = () => {
    if (streamTempLine) map.removeLayer(streamTempLine);
    if (streamVertices.length < 2) return;
    const pts = streamVertices.map(v => [v.lat, v.lng]);
    streamTempLine = L.polyline(pts, {
      color: '#7abfdc',
      weight: 2,
      opacity: 0.8,
      lineJoin: 'round',
      lineCap: 'round',
      interactive: false,
    }).addTo(map);
  };

  const pushVertex = latlng => {
    const last = streamVertices[streamVertices.length - 1];
    if (last) {
      const a = map.latLngToContainerPoint(last);
      const b = map.latLngToContainerPoint(latlng);
      // Skip near-duplicates to keep tracing responsive.
      if (a.distanceTo(b) < 6) return;
    }
    streamVertices.push(latlng);
    addVertexMarker(latlng);
    updateTempLine();
  };

  const finalizeStream = () => {
    if (streamVertices.length < 3) {
      alert('Stream polygon requires at least 3 points. Hold left mouse and trace, then right-click to close.');
      return;
    }

    map.off('mousedown', streamOnMouseDown);
    map.off('mousemove', streamOnMouseMove);
    map.off('mouseup', streamOnMouseUp);
    map.off('contextmenu', streamOnContextMenu);

    const pts = streamVertices.map(v => [v.lat, v.lng]);
    if (streamTempLine) map.removeLayer(streamTempLine);
    clearStreamMarkers();

    const poly = L.polygon(pts, {
      color: '#7abfdc',
      weight: 2,
      fillOpacity: 0.1,
      lineJoin: 'round',
      lineCap: 'round',
      smoothFactor: 0,
    });

    streamVertices = [];
    streamOnMouseDown = null;
    streamOnMouseMove = null;
    streamOnMouseUp = null;
    streamOnContextMenu = null;
    streamTempLine = null;
    streamIsDrawing = false;

    onShapeCreated({ layer: poly, layerType: 'polygon' });
  };

  streamOnMouseDown = e => {
    if (e.originalEvent && e.originalEvent.button !== 0) return;
    streamIsDrawing = true;
    pushVertex(e.latlng);
  };

  streamOnMouseMove = e => {
    if (!streamIsDrawing) return;
    pushVertex(e.latlng);
  };

  streamOnMouseUp = e => {
    if (!streamIsDrawing) return;
    pushVertex(e.latlng);
    streamIsDrawing = false;
  };

  streamOnContextMenu = e => {
    if (e.originalEvent) e.originalEvent.preventDefault();
    finalizeStream();
  };

  map.on('mousedown', streamOnMouseDown);
  map.on('mousemove', streamOnMouseMove);
  map.on('mouseup', streamOnMouseUp);
  map.on('contextmenu', streamOnContextMenu);

  activeDrawHandler = { disable: () => {
    if (streamOnMouseDown) map.off('mousedown', streamOnMouseDown);
    if (streamOnMouseMove) map.off('mousemove', streamOnMouseMove);
    if (streamOnMouseUp) map.off('mouseup', streamOnMouseUp);
    if (streamOnContextMenu) map.off('contextmenu', streamOnContextMenu);
    streamVertices = [];
    streamOnMouseDown = null;
    streamOnMouseMove = null;
    streamOnMouseUp = null;
    streamOnContextMenu = null;
    streamIsDrawing = false;
    clearStreamMarkers();
    if (streamTempLine) { map.removeLayer(streamTempLine); streamTempLine = null; }
  }};
}

function startRectangleDraw() {
  map.dragging.disable();
  drawStart = null;
  drawMarker = null;

  const onMouseDown = e => {
    drawStart = e.latlng;
    if (drawMarker) map.removeLayer(drawMarker);
    drawMarker = L.marker(drawStart, { opacity: 0.5 }).addTo(map);
  };
  const onMouseMove = e => {
    if (!drawStart) return;
    if (drawMarker) map.removeLayer(drawMarker);
    drawMarker = L.rectangle([[drawStart.lat, drawStart.lng], [e.latlng.lat, e.latlng.lng]],
      { color:'#7abfdc', weight:2, fillOpacity:0.1 }).addTo(map);
  };
  const onMouseUp = e => {
    if (!drawStart) return;
    map.off('mousedown', onMouseDown);
    map.off('mousemove', onMouseMove);
    map.off('mouseup', onMouseUp);

    const rect = L.rectangle([[drawStart.lat, drawStart.lng], [e.latlng.lat, e.latlng.lng]],
      { color:'#7abfdc', weight:2, fillOpacity:0.1 });

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

  const addVertexMarker = latlng => {
    const m = L.circleMarker(latlng, { radius:4, color:'#7abfdc', weight:2, fillColor:'#fff', fillOpacity:1 });
    m.addTo(map);
    polygonMarkers.push(m);
  };
  const clearVertexMarkers = () => {
    polygonMarkers.forEach(m => { try { map.removeLayer(m); } catch (_) {} });
    polygonMarkers = [];
  };

  polygonOnClick = e => {
    polygonVertices.push(e.latlng);
    addVertexMarker(e.latlng);
    if (polygonVertices.length >= 2) {
      const pts = polygonVertices.map(v => [v.lat, v.lng]);
      if (tempLine) map.removeLayer(tempLine);
      tempLine = L.polyline(pts, { color:'#7abfdc', weight:2, opacity:0.7, lineJoin:'round', lineCap:'round' }).addTo(map);
    }
  };

  polygonOnDblClick = () => {
    if (polygonVertices.length < 3) { alert('Polygon requires at least 3 points'); return; }
    map.off('click', polygonOnClick);
    map.off('dblclick', polygonOnDblClick);
    map.off('contextmenu', polygonOnContextMenu);

    const pts = polygonVertices.map(v => [v.lat, v.lng]);
    if (tempLine) map.removeLayer(tempLine);
    clearVertexMarkers();

    const poly = L.polygon(pts, { color:'#7abfdc', weight:2, fillOpacity:0.1, lineJoin:'round', lineCap:'round', smoothFactor:0 });

    polygonVertices = [];
    polygonOnClick = null;
    polygonOnDblClick = null;
    polygonOnContextMenu = null;
    onShapeCreated({ layer: poly, layerType: 'polygon' });
  };

  // Right-click closes polygon immediately to avoid double-click completion lag.
  polygonOnContextMenu = e => {
    if (e.originalEvent) e.originalEvent.preventDefault();
    polygonOnDblClick();
  };

  map.on('click', polygonOnClick);
  map.on('dblclick', polygonOnDblClick);
  map.on('contextmenu', polygonOnContextMenu);
  activeDrawHandler = { disable: () => {
    if (polygonOnClick) map.off('click', polygonOnClick);
    if (polygonOnDblClick) map.off('dblclick', polygonOnDblClick);
    if (polygonOnContextMenu) map.off('contextmenu', polygonOnContextMenu);
    polygonVertices = [];
    polygonOnClick = null;
    polygonOnDblClick = null;
    polygonOnContextMenu = null;
    clearVertexMarkers();
    if (tempLine) { map.removeLayer(tempLine); tempLine = null; }
  }};
}

function deleteSelected() {
  setMode(currentMode === 'delete' ? 'cursor' : 'delete');
}

function onShapeCreated(e) {
  if (activeDrawHandler) { activeDrawHandler.disable(); activeDrawHandler = null; }
  map.dragging.enable();
  pendingLayer = { layer: e.layer, type: e.layerType };
  document.getElementById('class-picker-overlay').style.display = 'flex';
}

// ── Class Management ────────────────────────────────────────
function selectClass(classId) {
  activeClassId = classId;
  const cls = CLASSES.find(c => c.id === classId);
  if (!cls) return;
  document.querySelectorAll('.class-item').forEach(el => el.classList.remove('selected'));
  document.getElementById('class-item-' + classId)?.classList.add('selected');
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
  const suggestions = CLASSES.filter(c => c.number !== 0).slice(0, 14)
    .map(c => `${c.number}: ${c.name}`).join('\n');
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
    try { const d = await resp.json(); if (d?.error) msg = d.error; } catch {}
    alert(msg);
    return null;
  }
  const resolved = await resp.json();
  if (!CLASSES.find(c => c.id === resolved.id)) {
    CLASSES.push({ id: resolved.id, number: resolved.number, name: resolved.name,
                   color: resolved.color || '#9E9E9E', description: "Created from 'Other'" });
  }
  return resolved.id;
}

function cancelPending() {
  document.getElementById('class-picker-overlay').style.display = 'none';
  pendingLayer = null;
}

async function assignClass(classId) {
  document.getElementById('class-picker-overlay').style.display = 'none';
  let targetClassId = classId;
  if (isOtherClass(classId)) {
    const resolvedId = await resolveOtherClassChoice();
    if (!resolvedId) {
      if (pendingLayer) document.getElementById('class-picker-overlay').style.display = 'flex';
      return;
    }
    targetClassId = resolvedId;
  }
  selectClass(targetClassId);
  if (pendingLayer) confirmWithClass(targetClassId);
}

function confirmWithClass(classId) {
  if (!pendingLayer) return;
  const { layer, type } = pendingLayer;
  pendingLayer = null;

  const cls = CLASSES.find(c => c.id === classId);
  if (!cls) return;

  styleLayer(layer, cls.color, true);
  drawnItems.addLayer(layer);

  const entry = { layer, classId, type, saved: false, label_id: null, basemap: activeBmName };
  pendingLabels.push(entry);
  layer.bindPopup(popupHTML(cls, entry.basemap, true));
  layer.on('click', () => { if (currentMode === 'delete') deleteLabel(entry); });

  updateCounts();
  saveEntry(entry);

  if (currentMode === 'rectangle' || currentMode === 'point' || currentMode === 'stream' || currentMode === 'polygon') {
    const m = currentMode;
    setTimeout(() => setMode(m), 60);
  }
}

function styleLayer(layer, color, isPending) {
  if (layer.setStyle) {
    layer.setStyle({
      color, weight: isPending ? 2.5 : 2,
      fillColor: color, fillOpacity: isPending ? 0.28 : 0.18,
      dashArray: isPending ? '6 3' : '',
      lineJoin: 'round', lineCap: 'round',
    });
  }
}

function popupHTML(cls, basemap, unsaved) {
  return `<div style="font-family:'Plus Jakarta Sans',sans-serif;font-size:.82rem;min-width:150px;">
    <div style="display:flex;align-items:center;gap:.4rem;margin-bottom:.3rem;">
      <span style="width:10px;height:10px;border-radius:50%;background:${cls.color};display:inline-block;"></span>
      <strong>${cls.name}</strong>
    </div>
    <div style="color:#64748b;font-size:.75rem;">by ${WORKER_NAME}</div>
    <div style="color:#3b8ab8;font-size:.7rem;margin-top:.15rem;">🗺 ${basemap}</div>
    ${unsaved ? '<div style="color:#f59e0b;font-size:.72rem;margin-top:.2rem;">⬤ unsaved</div>' : ''}
  </div>`;
}

// ── Save / Delete ───────────────────────────────────────────
async function ensureSession() {
  if (SESSION_IMAGE_ID) return SESSION_IMAGE_ID;
  const name = document.getElementById('session-name')?.value || 'Free Session';
  const resp = await fetch('/api/free_session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await resp.json();
  SESSION_IMAGE_ID = data.image_id;
  setVal('session-id-display', '#' + SESSION_IMAGE_ID);
  return SESSION_IMAGE_ID;
}

async function saveEntry(entry, options = {}) {
  if (!entry || entry.saved) return;
  try {
    const imageId = await ensureSession();
    const geom = entry.layer.toGeoJSON().geometry;
    const resp = await fetch('/api/labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: Boolean(options.keepalive),
      body: JSON.stringify({
        image_id: imageId,
        geometry: geom,
        label_type: entry.type,
        class_id: entry.classId,
        tile_size_m: null,
        basemap: entry.basemap,
      }),
    });
    if (!resp.ok) return;

    const data = await resp.json();
    entry.saved = true;
    entry.label_id = data.id;
    savedCount++;

    const cls = CLASSES.find(c => c.id === entry.classId);
    if (cls) {
      styleLayer(entry.layer, cls.color, false);
      entry.layer.getPopup()?.setContent(popupHTML(cls, entry.basemap, false));
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
  for (const entry of toSave) await saveEntry(entry);
  if (btn) { btn.textContent = 'Save'; btn.disabled = false; }
  updateCounts();
}

async function deleteLabel(entry) {
  if (entry.label_id) {
    await fetch(`/api/labels/${entry.label_id}`, { method: 'DELETE' });
    if (entry.saved) savedCount = Math.max(0, savedCount - 1);
  }
  drawnItems.removeLayer(entry.layer);
  const idx = pendingLabels.indexOf(entry);
  if (idx > -1) pendingLabels.splice(idx, 1);
  updateCounts();
}

function updateCounts() {
  const unsaved = pendingLabels.filter(e => !e.saved).length;
  setVal('saved-count', savedCount);
  setVal('unsaved-count', unsaved);
}

function findEntryAtPoint(latlng) {
  for (const entry of pendingLabels) {
    try { if (entry.layer.getBounds?.().contains(latlng)) return entry; } catch {}
    try {
      if (entry.layer.getLatLng) {
        const p = map.latLngToContainerPoint(entry.layer.getLatLng());
        const q = map.latLngToContainerPoint(latlng);
        if (p.distanceTo(q) <= 10) return entry;
      }
    } catch {}
  }
  return null;
}

// ── Finish ──────────────────────────────────────────────────
async function finishSession() {
  await saveAllPending();
  window.location.href = '/worker/queue';
}

function confirmLeave() {
  const unsaved = pendingLabels.filter(e => !e.saved).length;
  return unsaved === 0 || confirm(`${unsaved} unsaved label(s). Leave without saving?`);
}

// ── Keyboard Shortcuts ──────────────────────────────────────
function onKeyDown(e) {
  const tag = document.activeElement.tagName.toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

  const pickerOpen = document.getElementById('class-picker-overlay').style.display !== 'none';

  const digitMatch = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
  if (digitMatch) {
    const num = parseInt(digitMatch[1], 10);
    const cls = CLASSES.find(c => c.number === num);
    if (!cls) return;
    e.preventDefault();
    if (pickerOpen) assignClass(cls.id);
    else if (num !== 0) selectClass(cls.id);
    return;
  }

  if (pickerOpen) { if (e.key === 'Escape') cancelPending(); return; }

  const k = e.key.toLowerCase();
  if (k === 'r')        setMode('rectangle');
  else if (k === 'o')   setMode('point');
  else if (k === 't')   setMode('stream');
  else if (k === 'p')   setMode('polygon');
  else if (k === 'd')   deleteSelected();
  else if (k === 'b')   toggleBasemapPanel();
  else if (k === 'g')   toggleGoto();
  else if (k === 'escape') setMode('cursor');
  else if (k === 's')   saveAllPending();
  else if (k === 'enter') { e.preventDefault(); finishSession(); }
}

// Auto-save every 2 minutes
setInterval(() => {
  if (pendingLabels.some(e => !e.saved)) saveAllPending();
}, 120_000);
