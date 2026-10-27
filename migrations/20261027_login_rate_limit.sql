-- Proteção de autenticação compartilhada entre instâncias Render.
-- Somente hashes de usuário/IP são armazenados, nunca nomes nem IPs em claro.
CREATE TABLE IF NOT EXISTS distrilog.auth_login_attempts (
    bucket_key TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    window_started_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE distrilog.auth_login_attempts ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_login_throttle_expiry
    ON distrilog.auth_login_attempts(window_started_at);

-- Remove buckets antigos sem interferir com o login atual.
SELECT cron.schedule(
    'distrilog-login-throttle-purge',
    '23 4 * * *',
    $job$DELETE FROM distrilog.auth_login_attempts WHERE window_started_at < now() - INTERVAL '2 days'$job$
);
