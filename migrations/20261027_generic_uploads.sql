CREATE TABLE IF NOT EXISTS distrilog.generic_uploads (
    filename TEXT PRIMARY KEY,
    content BYTEA NOT NULL,
    media_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 10485760),
    uploaded_by BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE distrilog.generic_uploads ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_generic_uploads_uploaded_at
    ON distrilog.generic_uploads(created_at DESC);