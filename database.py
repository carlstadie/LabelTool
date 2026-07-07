"""
database.py – SQLite schema and helper functions for AWI PermafrostLabel
"""
import sqlite3
import json
from datetime import datetime
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATABASE = BASE_DIR / 'labeller.db'


def get_db():
    conn = sqlite3.connect(str(DATABASE))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    """Create all tables and seed default config."""
    db = get_db()
    db.executescript("""
    CREATE TABLE IF NOT EXISTS config (
        key   TEXT PRIMARY KEY,
        value TEXT
    );

    CREATE TABLE IF NOT EXISTS groups (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        type        TEXT DEFAULT 'project',
        description TEXT,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS images (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        filename          TEXT NOT NULL,
        original_filename TEXT,
        group_id          INTEGER REFERENCES groups(id) ON DELETE SET NULL,
        filepath          TEXT NOT NULL,
        preview_path      TEXT,
        status            TEXT DEFAULT 'available',
        crs               TEXT,
        bbox_minx         REAL, bbox_miny REAL,
        bbox_maxx         REAL, bbox_maxy REAL,
        wgs84_west        REAL, wgs84_south REAL,
        wgs84_east        REAL, wgs84_north REAL,
        width             INTEGER,
        height            INTEGER,
        band_count        INTEGER,
        resolution_x      REAL,
        resolution_y      REAL,
        nodata            REAL,
        band_descriptions TEXT,
        uploaded_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        assigned_to       TEXT,
        completed_at      TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS classes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        number      INTEGER UNIQUE NOT NULL,
        name        TEXT NOT NULL,
        color       TEXT NOT NULL DEFAULT '#4A90D9',
        description TEXT,
        active      INTEGER DEFAULT 1,
        sort_order  INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS labels (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        image_id      INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
        worker_name   TEXT NOT NULL,
        geojson       TEXT NOT NULL,
        label_type    TEXT NOT NULL DEFAULT 'polygon',
        class_id      INTEGER REFERENCES classes(id),
        tile_size_m   REAL,
        basemap       TEXT,
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS work_sessions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        worker_name TEXT NOT NULL,
        image_id    INTEGER REFERENCES images(id),
        started_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at    TIMESTAMP,
        tile_size_m REAL DEFAULT 100
    );
    """)

    # Backward-compatible migration for existing databases.
    cols = [r[1] for r in db.execute("PRAGMA table_info(labels)").fetchall()]
    if "basemap" not in cols:
        db.execute("ALTER TABLE labels ADD COLUMN basemap TEXT")

    # Default config
    defaults = {
        'app_name': 'PermafrostLabel',
        'app_subtitle': 'Remote Sensing Labelling Tool',
        'organization': 'Alfred Wegener Institute · Permafrost Remote Sensing',
        'logo_url': '',
        'admin_token': 'awi-admin-2024',
        'max_preview_px': '3000',
        'default_tile_size_m': '100',
        'contact_email': 'permafrost@awi.de',
    }
    for key, value in defaults.items():
        db.execute("INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)", (key, value))

    # Default classes
    default_classes = [
        (0, 'Other',              '#9E9E9E', 'Custom class prompt',        999),
        (1, 'Permafrost',         '#2196F3', 'Active permafrost layer',     1),
        (2, 'Thermokarst Lake',   '#00BCD4', 'Thermokarst or thaw lakes',   2),
        (3, 'Active Layer',       '#FF9800', 'Seasonally thawed active layer', 3),
        (4, 'Ice Wedge Polygon',  '#9C27B0', 'Ice wedge polygon network',   4),
        (5, 'Retrogressive Slump','#F44336', 'Retrogressive thaw slump',    5),
        (6, 'Peat / Vegetation',  '#4CAF50', 'Peat bog or tundra vegetation',6),
        (7, 'Water',              '#03A9F4', 'Open water body',             7),
        (8, 'Background',         '#9E9E9E', 'No-feature background',       8),
    ]
    for num, name, color, desc, order in default_classes:
        db.execute("""INSERT OR IGNORE INTO classes (number,name,color,description,sort_order)
                      VALUES (?,?,?,?,?)""", (num, name, color, desc, order))
    db.commit()
    db.close()


# ── Config ────────────────────────────────────────────────────────────────────

def get_config():
    db = get_db()
    rows = db.execute("SELECT key, value FROM config").fetchall()
    db.close()
    return {r['key']: r['value'] for r in rows}


def set_config(key, value):
    db = get_db()
    db.execute("INSERT OR REPLACE INTO config (key,value) VALUES (?,?)", (key, value))
    db.commit()
    db.close()


def set_config_bulk(data: dict):
    db = get_db()
    for key, value in data.items():
        db.execute("INSERT OR REPLACE INTO config (key,value) VALUES (?,?)", (key, value))
    db.commit()
    db.close()


# ── Groups ────────────────────────────────────────────────────────────────────

def get_groups():
    db = get_db()
    rows = db.execute("""
        SELECT g.*, COUNT(i.id) AS image_count
        FROM groups g LEFT JOIN images i ON i.group_id = g.id
        GROUP BY g.id ORDER BY g.name
    """).fetchall()
    db.close()
    return [dict(r) for r in rows]


def create_group(name, gtype, description):
    db = get_db()
    cur = db.execute("INSERT INTO groups (name,type,description) VALUES (?,?,?)",
                     (name, gtype, description))
    db.commit()
    gid = cur.lastrowid
    db.close()
    return gid


def delete_group(gid):
    db = get_db()
    db.execute("DELETE FROM groups WHERE id=?", (gid,))
    db.commit()
    db.close()


# ── Images ────────────────────────────────────────────────────────────────────

def add_image(data: dict):
    db = get_db()
    cur = db.execute("""
        INSERT INTO images
        (filename,original_filename,group_id,filepath,preview_path,crs,
         bbox_minx,bbox_miny,bbox_maxx,bbox_maxy,
         wgs84_west,wgs84_south,wgs84_east,wgs84_north,
         width,height,band_count,resolution_x,resolution_y,nodata,band_descriptions)
        VALUES
        (:filename,:original_filename,:group_id,:filepath,:preview_path,:crs,
         :bbox_minx,:bbox_miny,:bbox_maxx,:bbox_maxy,
         :wgs84_west,:wgs84_south,:wgs84_east,:wgs84_north,
         :width,:height,:band_count,:resolution_x,:resolution_y,:nodata,:band_descriptions)
    """, data)
    db.commit()
    iid = cur.lastrowid
    db.close()
    return iid


def get_images(group_id=None, status=None):
    db = get_db()
    q = """
        SELECT i.*, g.name AS group_name,
               (SELECT COUNT(*) FROM labels l WHERE l.image_id=i.id) AS label_count
        FROM images i LEFT JOIN groups g ON i.group_id=g.id
        WHERE 1=1
    """
    params = []
    if group_id:
        q += " AND i.group_id=?"; params.append(group_id)
    if status:
        q += " AND i.status=?"; params.append(status)
    q += " ORDER BY i.uploaded_at DESC"
    rows = db.execute(q, params).fetchall()
    db.close()
    return [dict(r) for r in rows]


def get_image(image_id):
    db = get_db()
    row = db.execute("""
        SELECT i.*, g.name AS group_name
        FROM images i LEFT JOIN groups g ON i.group_id=g.id
        WHERE i.id=?
    """, (image_id,)).fetchone()
    db.close()
    return dict(row) if row else None


def update_image_status(image_id, status, worker=None):
    db = get_db()
    if worker:
        db.execute("UPDATE images SET status=?, assigned_to=? WHERE id=?",
                   (status, worker, image_id))
    else:
        if status == 'available':
            db.execute("UPDATE images SET status=?, assigned_to=NULL WHERE id=?",
                       (status, image_id))
        else:
            db.execute("UPDATE images SET status=? WHERE id=?", (status, image_id))
    if status == 'done':
        db.execute("UPDATE images SET completed_at=CURRENT_TIMESTAMP WHERE id=?", (image_id,))
    elif status == 'available':
        db.execute("UPDATE images SET completed_at=NULL WHERE id=?", (image_id,))
    db.commit()
    db.close()


def delete_image(image_id):
    db = get_db()
    db.execute("DELETE FROM images WHERE id=?", (image_id,))
    db.commit()
    db.close()


# ── Classes ───────────────────────────────────────────────────────────────────

def get_classes(active_only=True):
    db = get_db()
    q = "SELECT * FROM classes"
    if active_only:
        q += " WHERE active=1"
    q += " ORDER BY sort_order, number"
    rows = db.execute(q).fetchall()
    db.close()
    return [dict(r) for r in rows]


def upsert_class(data: dict):
    db = get_db()
    if data.get('id'):
        db.execute("""UPDATE classes SET number=?,name=?,color=?,description=?,active=?,sort_order=?
                      WHERE id=?""",
                   (data['number'], data['name'], data['color'],
                    data.get('description',''), data.get('active',1),
                    data.get('sort_order',0), data['id']))
    else:
        db.execute("""INSERT INTO classes (number,name,color,description,active,sort_order)
                      VALUES (?,?,?,?,?,?)""",
                   (data['number'], data['name'], data['color'],
                    data.get('description',''), data.get('active',1), data.get('sort_order',0)))
    db.commit()
    db.close()


def delete_class(class_id):
    db = get_db()
    db.execute("DELETE FROM classes WHERE id=?", (class_id,))
    db.commit()
    db.close()


def resolve_other_class(name: str):
    """Resolve class by name (case-insensitive); create it if missing."""
    class_name = (name or "").strip()
    if not class_name:
        raise ValueError("Class name is required")

    db = get_db()
    row = db.execute("SELECT * FROM classes WHERE LOWER(name)=LOWER(?) LIMIT 1",
                     (class_name,)).fetchone()
    created = False

    if not row:
        next_number = db.execute("SELECT COALESCE(MAX(number), 0) + 1 FROM classes").fetchone()[0]
        next_order = db.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM classes").fetchone()[0]
        cur = db.execute(
            """INSERT INTO classes (number,name,color,description,active,sort_order)
               VALUES (?,?,?,?,?,?)""",
            (int(next_number), class_name, "#9E9E9E", "Created from 'Other' prompt", 1, int(next_order))
        )
        db.commit()
        row = db.execute("SELECT * FROM classes WHERE id=?", (cur.lastrowid,)).fetchone()
        created = True

    cls = dict(row)
    db.close()
    return cls, created


# ── Labels ────────────────────────────────────────────────────────────────────

def add_label(image_id, worker_name, geojson_str, label_type, class_id, tile_size_m,
              basemap=None):
    db = get_db()
    cur = db.execute("""
        INSERT INTO labels (image_id,worker_name,geojson,label_type,class_id,tile_size_m,basemap)
        VALUES (?,?,?,?,?,?,?)
    """, (image_id, worker_name, geojson_str, label_type, class_id, tile_size_m, basemap))
    db.commit()
    lid = cur.lastrowid
    db.close()
    return lid


def get_labels(image_id=None, class_id=None, worker_name=None, group_id=None):
    db = get_db()
    q = """
        SELECT l.*, c.name AS class_name, c.color AS class_color, c.number AS class_number,
               i.original_filename, i.group_id,
               g.name AS group_name
        FROM labels l
        JOIN images i ON l.image_id=i.id
        LEFT JOIN classes c ON l.class_id=c.id
        LEFT JOIN groups g ON i.group_id=g.id
        WHERE 1=1
    """
    params = []
    if image_id:
        q += " AND l.image_id=?"; params.append(image_id)
    if class_id:
        q += " AND l.class_id=?"; params.append(class_id)
    if worker_name:
        q += " AND l.worker_name=?"; params.append(worker_name)
    if group_id:
        q += " AND i.group_id=?"; params.append(group_id)
    q += " ORDER BY l.created_at DESC"
    rows = db.execute(q, params).fetchall()
    db.close()
    return [dict(r) for r in rows]


def delete_label(label_id):
    db = get_db()
    db.execute("DELETE FROM labels WHERE id=?", (label_id,))
    db.commit()
    db.close()


# ── Stats ─────────────────────────────────────────────────────────────────────

def get_stats():
    db = get_db()
    stats = {}
    stats['total_images']    = db.execute("SELECT COUNT(*) FROM images").fetchone()[0]
    stats['done_images']     = db.execute("SELECT COUNT(*) FROM images WHERE status='done'").fetchone()[0]
    stats['available_images']= db.execute("SELECT COUNT(*) FROM images WHERE status='available'").fetchone()[0]
    stats['total_labels']    = db.execute("SELECT COUNT(*) FROM labels").fetchone()[0]
    stats['total_workers']   = db.execute("SELECT COUNT(DISTINCT worker_name) FROM labels").fetchone()[0]
    stats['total_groups']    = db.execute("SELECT COUNT(*) FROM groups").fetchone()[0]
    # Labels by class
    rows = db.execute("""
        SELECT c.name, c.color, COUNT(l.id) AS cnt
        FROM labels l JOIN classes c ON l.class_id=c.id
        GROUP BY c.id ORDER BY cnt DESC
    """).fetchall()
    stats['labels_by_class'] = [dict(r) for r in rows]
    # Recent workers
    rows = db.execute("""
        SELECT worker_name, COUNT(*) AS label_count, MAX(created_at) AS last_active
        FROM labels GROUP BY worker_name ORDER BY last_active DESC LIMIT 10
    """).fetchall()
    stats['workers'] = [dict(r) for r in rows]
    stats['leaderboard'] = get_worker_leaderboard(limit=10)
    db.close()
    return stats


def get_worker_leaderboard(limit=20):
    db = get_db()
    rows = db.execute("""
        WITH lbl AS (
            SELECT worker_name, COUNT(*) AS label_count, MAX(created_at) AS last_label_at
            FROM labels
            GROUP BY worker_name
        ),
        img AS (
            SELECT assigned_to AS worker_name, COUNT(*) AS image_count, MAX(completed_at) AS last_done_at
            FROM images
            WHERE status='done' AND assigned_to IS NOT NULL AND assigned_to <> ''
            GROUP BY assigned_to
        ),
        names AS (
            SELECT worker_name FROM lbl
            UNION
            SELECT worker_name FROM img
        )
        SELECT
            n.worker_name,
            COALESCE(img.image_count, 0) AS image_count,
            COALESCE(lbl.label_count, 0) AS label_count,
            CASE
              WHEN lbl.last_label_at IS NULL THEN img.last_done_at
              WHEN img.last_done_at IS NULL THEN lbl.last_label_at
              WHEN lbl.last_label_at > img.last_done_at THEN lbl.last_label_at
              ELSE img.last_done_at
            END AS last_active
        FROM names n
        LEFT JOIN lbl ON lbl.worker_name = n.worker_name
        LEFT JOIN img ON img.worker_name = n.worker_name
        ORDER BY label_count DESC, image_count DESC, n.worker_name ASC
        LIMIT ?
    """, (int(limit),)).fetchall()
    db.close()
    return [dict(r) for r in rows]
