import sqlite3
import os
from flask import g

DB_PATH = os.path.join(os.path.dirname(__file__), 'doomsday.db')

def get_db():
    db = getattr(g, '_database', None)
    if db is None:
        db = g._database = sqlite3.connect(DB_PATH, isolation_level=None) # Autocommit mode like better-sqlite3 for basic queries
        db.row_factory = sqlite_dict_factory
        db.execute('PRAGMA journal_mode = WAL')
        db.execute('PRAGMA foreign_keys = ON')
        # Ensure schema exists (same exact queries as Node.js)
        init_schema(db)
    return db

def sqlite_dict_factory(cursor, row):
    d = {}
    for idx, col in enumerate(cursor.description):
        d[col[0]] = row[idx]
    return d

def query_db(query, args=(), one=False):
    cur = get_db().execute(query, args)
    rv = cur.fetchall()
    cur.close()
    return (rv[0] if rv else None) if one else rv

def insert_db(query, args=()):
    db = get_db()
    cur = db.cursor()
    cur.execute(query, args)
    db.commit() # Ensure committed if not auto-committed
    last_id = cur.lastrowid
    cur.close()
    return last_id

def execute_db(query, args=()):
    db = get_db()
    cur = db.cursor()
    cur.execute(query, args)
    db.commit()
    cur.close()

def init_schema(db):
    db.executescript("""
  -- Users table (Google OAuth)
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    picture TEXT,
    role TEXT DEFAULT 'participant',  -- 'admin' or 'participant'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Teams table
  CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_name TEXT UNIQUE NOT NULL,
    team_code TEXT NOT NULL,
    banned INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Team members (up to 4 per team)
  CREATE TABLE IF NOT EXISTS team_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id),
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- Questions table
  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    category TEXT NOT NULL,           -- AI, CP, HEX, DEV
    body_markdown TEXT NOT NULL,
    answer TEXT NOT NULL,
    answer_mode TEXT DEFAULT 'exact', -- exact, case-insensitive, contains
    sort_order INTEGER DEFAULT 0,
    visible_from DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- File attachments per question
  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    filepath TEXT NOT NULL,
    FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
  );

  -- Reference links per question
  CREATE TABLE IF NOT EXISTS reference_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    url TEXT NOT NULL,
    FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
  );

  -- Submissions log
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    question_id INTEGER NOT NULL,
    submitted_value TEXT NOT NULL,
    is_correct INTEGER DEFAULT 0,
    time_taken INTEGER DEFAULT 0,     -- seconds spent on question
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (team_id) REFERENCES teams(id),
    FOREIGN KEY (question_id) REFERENCES questions(id)
  );

  -- Question view log
  CREATE TABLE IF NOT EXISTS question_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    question_id INTEGER NOT NULL,
    viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (team_id) REFERENCES teams(id),
    FOREIGN KEY (question_id) REFERENCES questions(id)
  );

  -- Activity log (unified timeline for admin)
  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    question_id INTEGER,
    activity_type TEXT NOT NULL,       -- question_viewed, wrong_submission, correct_submission
    category TEXT,
    submitted_value TEXT,
    metadata TEXT,                     -- JSON string for extra info
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (team_id) REFERENCES teams(id)
  );

  -- Settings (key-value store)
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Announcements
  CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  """)

    db.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('competition_start', '')")
    db.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('competition_end', '')")
    db.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('maintenance_mode', '0')")
    db.commit()

def close_db(e=None):
    db = getattr(g, '_database', None)
    if db is not None:
        db.close()
