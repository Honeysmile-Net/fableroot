-- Fableroot cloud save · Cloudflare D1 (SQLite)
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sub        TEXT NOT NULL UNIQUE,      -- Google account id
  email      TEXT,
  name       TEXT,
  picture    TEXT,
  created    INTEGER NOT NULL,
  last_login INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,          -- SHA-256 of the cookie token (the token itself is never stored)
  user_id    INTEGER NOT NULL,
  created    INTEGER NOT NULL,
  expires    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS saves (
  user_id INTEGER NOT NULL,
  slot    INTEGER NOT NULL,             -- 1..3
  data    TEXT NOT NULL,                -- the game's save JSON
  t       INTEGER NOT NULL,             -- time the game wrote it (client clock, ms)
  updated INTEGER NOT NULL,             -- time the server stored it (ms)
  dev     TEXT,                         -- the browser tab that currently owns this slot
  size    INTEGER NOT NULL,
  PRIMARY KEY (user_id, slot)
);
