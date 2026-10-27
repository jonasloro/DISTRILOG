ALTER TABLE distrilog.users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
CREATE INDEX IF NOT EXISTS idx_distrilog_users_active ON distrilog.users (username) WHERE is_active = TRUE;
