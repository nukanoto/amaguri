CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hashes (
  state_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (state_key, hash),
  UNIQUE (state_key, ordinal)
);
