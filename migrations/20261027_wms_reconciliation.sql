-- Só o backend pode acessar via rotas autenticadas; RLS nega clientes diretos.
CREATE TABLE IF NOT EXISTS distrilog.wms_reconciliation_actions (
    id BIGSERIAL PRIMARY KEY,
    allocation_id BIGINT NOT NULL,
    record_snapshot JSONB NOT NULL,
    action TEXT NOT NULL,
    reason TEXT NOT NULL,
    physically_verified BOOLEAN NOT NULL,
    actor_user_id BIGINT NOT NULL,
    actor_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE distrilog.wms_reconciliation_actions ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_wms_reconciliation_allocation
 ON distrilog.wms_reconciliation_actions(allocation_id, created_at DESC);
