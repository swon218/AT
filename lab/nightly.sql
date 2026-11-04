CREATE TABLE IF NOT EXISTS lab_publication (
  id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, target TEXT,
  published_at TEXT NOT NULL, summary TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lab_batches (
  day TEXT NOT NULL, phase TEXT NOT NULL, started_at TEXT NOT NULL,
  finished_at TEXT, published_at TEXT, PRIMARY KEY(day,phase)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS lab_batch_items (
  day TEXT NOT NULL, phase TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL,
  market TEXT NOT NULL, listed TEXT, status TEXT NOT NULL DEFAULT 'pending',
  detail TEXT, staged BLOB, PRIMARY KEY(day,phase,code)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS lab_attempts (
  id INTEGER PRIMARY KEY, day TEXT NOT NULL, phase TEXT NOT NULL, code TEXT NOT NULL,
  at TEXT NOT NULL, status TEXT NOT NULL, detail TEXT
);
CREATE TABLE IF NOT EXISTS lab_rejected_payloads (
  code TEXT NOT NULL, source TEXT NOT NULL, hash TEXT NOT NULL, payload TEXT NOT NULL,
  first_seen TEXT NOT NULL, PRIMARY KEY(code,source,hash)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS lab_public_symbols (
  code TEXT PRIMARY KEY, target TEXT NOT NULL, status TEXT NOT NULL, detail TEXT
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS lab_symbol_basis (
  code TEXT PRIMARY KEY, source TEXT NOT NULL, version TEXT NOT NULL, listed TEXT,
  evidence TEXT NOT NULL, approved_at TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS lab_basis_history (
  code TEXT NOT NULL, version TEXT NOT NULL, source TEXT NOT NULL, listed TEXT,
  evidence TEXT NOT NULL, approved_at TEXT NOT NULL, PRIMARY KEY(code,version)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS lab_nontrade (
  code TEXT NOT NULL, date TEXT NOT NULL, source TEXT NOT NULL, evidence TEXT NOT NULL,
  PRIMARY KEY(code,date,source)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS lab_listing_evidence (
  code TEXT PRIMARY KEY, listed TEXT NOT NULL, evidence TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS lab_recovery_candidates (
  id TEXT PRIMARY KEY, code TEXT NOT NULL, date TEXT NOT NULL,
  base_source TEXT NOT NULL, base_hash TEXT NOT NULL, base_policy TEXT NOT NULL,
  source TEXT NOT NULL, basis TEXT NOT NULL, payload TEXT NOT NULL, evidence TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lab_recovery_validations (
  id INTEGER PRIMARY KEY, candidate TEXT NOT NULL REFERENCES lab_recovery_candidates(id),
  at TEXT NOT NULL, accepted INTEGER NOT NULL, evidence TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lab_resolution_events (
  id INTEGER PRIMARY KEY, candidate TEXT NOT NULL REFERENCES lab_recovery_candidates(id),
  validation INTEGER REFERENCES lab_recovery_validations(id), at TEXT NOT NULL,
  action TEXT NOT NULL, reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lab_resolution_current (
  code TEXT NOT NULL, date TEXT NOT NULL, event INTEGER NOT NULL REFERENCES lab_resolution_events(id),
  PRIMARY KEY(code,date)
) WITHOUT ROWID;
CREATE VIEW IF NOT EXISTS effective_candle_quality AS
  SELECT q.code,q.date,q.source,q.raw_hash,q.policy,
    CASE WHEN r.id IS NULL THEN q.status ELSE 'recovered' END AS status,
    q.reason,q.delta,q.processed_high,q.processed_low,q.raw_json,
    r.id AS candidate,r.source AS recovery_source,r.basis AS recovery_basis,
    e.id AS recovery_event,e.validation AS recovery_validation
  FROM current_candle_quality q
  LEFT JOIN lab_resolution_current a USING(code,date)
  LEFT JOIN lab_resolution_events e ON e.id=a.event
  LEFT JOIN lab_recovery_candidates r ON r.id=e.candidate
    AND (r.base_source,r.base_hash,r.base_policy)=(q.source,q.raw_hash,q.policy)
    AND q.status='quarantined';
