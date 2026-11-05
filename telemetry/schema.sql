-- One row per install, event and version: a replayed event is ignored (INSERT OR IGNORE).
-- No address, no time of day, nothing about the user's terminals or files. Of where an event
-- came from, only the country (two characters, as Cloudflare names it); NULL in rows from
-- before it was kept. settings is a complete, validated JSON snapshot or NULL until one is sent.
-- A table made before either column gets it from README.md's ALTERs, as does one made before
-- runtime (the terminal runtime the sender's server serves, NULL from senders before it).
CREATE TABLE IF NOT EXISTS events (
  day TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('install', 'update')),
  install_id TEXT NOT NULL,
  version TEXT NOT NULL,
  previous_version TEXT,
  os TEXT NOT NULL,
  arch TEXT NOT NULL,
  install_method TEXT NOT NULL CHECK (install_method IN ('plugin', 'managed', 'source')),
  country TEXT,
  settings TEXT CHECK (settings IS NULL OR json_valid(settings)),
  runtime TEXT CHECK (runtime IS NULL OR runtime IN ('herdr', 'herdr-core')),
  UNIQUE (install_id, event, version)
);
CREATE INDEX IF NOT EXISTS events_day ON events (day);

-- One row per install and UTC day a browser visited (day is the visit's, even when the message
-- arrived later). A later message that day replaces version and harnesses (the kinds of coding
-- agents seen, a sorted JSON array from shared/telemetry.ts TELEMETRY_HARNESSES) and usage (the
-- day's TelemetryUsage as JSON: kinds of screen, ways in, and counts; NULL from senders before it).
CREATE TABLE IF NOT EXISTS active (
  day TEXT NOT NULL,
  install_id TEXT NOT NULL,
  version TEXT NOT NULL,
  os TEXT NOT NULL,
  arch TEXT NOT NULL,
  install_method TEXT NOT NULL CHECK (install_method IN ('plugin', 'managed', 'source')),
  country TEXT,
  harnesses TEXT NOT NULL CHECK (json_valid(harnesses)),
  usage TEXT CHECK (usage IS NULL OR json_valid(usage)),
  runtime TEXT CHECK (runtime IS NULL OR runtime IN ('herdr', 'herdr-core')),
  PRIMARY KEY (day, install_id)
);
CREATE INDEX IF NOT EXISTS active_day ON active (day);
