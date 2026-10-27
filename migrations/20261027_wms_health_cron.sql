-- Monitoramento automático do WMS sem alteração dos saldos operacionais.
-- Agendado pelo pg_cron no próprio Supabase, independente do Render.
CREATE TABLE IF NOT EXISTS distrilog.wms_health_snapshots (
    id BIGSERIAL PRIMARY KEY,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    active_allocations BIGINT NOT NULL,
    orphan_cards BIGINT NOT NULL,
    orphan_items BIGINT NOT NULL,
    invalid_addresses BIGINT NOT NULL,
    invalid_quantities BIGINT NOT NULL,
    overfilled_color_addresses BIGINT NOT NULL
);
ALTER TABLE distrilog.wms_health_snapshots ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_wms_health_checked_at
    ON distrilog.wms_health_snapshots(checked_at DESC);

CREATE OR REPLACE FUNCTION distrilog.capture_wms_health()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
    snapshot_id BIGINT;
BEGIN
    INSERT INTO distrilog.wms_health_snapshots (
        active_allocations, orphan_cards, orphan_items,
        invalid_addresses, invalid_quantities, overfilled_color_addresses
    )
    SELECT
        (SELECT COUNT(*) FROM distrilog.card_allocations a WHERE a.active IS TRUE),
        (SELECT COUNT(*) FROM distrilog.card_allocations a
          LEFT JOIN distrilog.cards c ON c.id=a.card_id
          WHERE a.active IS TRUE AND c.id IS NULL),
        (SELECT COUNT(*) FROM distrilog.card_allocations a
          LEFT JOIN distrilog.items i ON i.id=a.item_id
          WHERE a.active IS TRUE AND a.item_id IS NOT NULL AND i.id IS NULL),
        (SELECT COUNT(*) FROM distrilog.card_allocations a
          LEFT JOIN distrilog.sector_positions p ON p.address=a.address AND p.setor=a.setor
          WHERE a.active IS TRUE AND p.id IS NULL),
        (SELECT COUNT(*) FROM distrilog.card_allocations a
          WHERE a.active IS TRUE AND (a.quantidade <= 0 OR a.box_count < 0)),
        (SELECT COUNT(*) FROM (
            SELECT a.setor,a.address
            FROM distrilog.card_allocations a
            JOIN distrilog.items i ON i.id=a.item_id
            WHERE a.active IS TRUE AND a.setor IN ('ET','EC')
            GROUP BY a.setor,a.address
            HAVING COUNT(DISTINCT COALESCE(NULLIF(BTRIM(i.color),''),'SEM COR')) > 4
        ) overfilled)
    RETURNING id INTO snapshot_id;
    RETURN snapshot_id;
END;
$fn$;

REVOKE ALL ON FUNCTION distrilog.capture_wms_health() FROM PUBLIC;
REVOKE ALL ON FUNCTION distrilog.capture_wms_health() FROM anon, authenticated;

CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule(
  'distrilog-wms-health-hourly',
  '7 * * * *',
  $job$SELECT distrilog.capture_wms_health()$job$
);
