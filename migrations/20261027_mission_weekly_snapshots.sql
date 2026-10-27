-- Visão da Missão: fonte operacional, fotografias imutáveis e cortes semanais.
-- Horário operacional: America/Sao_Paulo. pg_cron do Supabase executa em UTC.
-- Backlog seg 08:10; produzido prévia qua 12:00; fechamento sex 16:00.
-- Não inventar/backfill de fotografias retroativas.
CREATE TABLE IF NOT EXISTS distrilog.mission_weekly_runs (
    week_start date NOT NULL,
    snapshot_kind text NOT NULL CHECK (snapshot_kind IN ('BACKLOG','WED','FRI')),
    planned_at timestamptz NOT NULL,
    captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    source_cards bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (week_start,snapshot_kind)
);

CREATE TABLE IF NOT EXISTS distrilog.mission_weekly_metrics (
    week_start date NOT NULL,
    snapshot_kind text NOT NULL CHECK (snapshot_kind IN ('BACKLOG','WED','FRI')),
    sector text NOT NULL CHECK (sector IN
        ('RECEBIMENTO','EXPEDIÇÃO PCP','QUALIDADE 1','QUALIDADE 2',
         'PROCESSAMENTO','ETIQUETAGEM','ESTOCAGEM','AJUSTES','EXPEDIÇÃO')),
    pieces bigint CHECK (pieces >= 0),
    source_label text NOT NULL,
    captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (week_start,snapshot_kind,sector),
    FOREIGN KEY (week_start,snapshot_kind)
       REFERENCES distrilog.mission_weekly_runs(week_start,snapshot_kind)
);

CREATE INDEX IF NOT EXISTS idx_mission_weekly_metrics_month
    ON distrilog.mission_weekly_metrics(week_start DESC, sector);
ALTER TABLE distrilog.mission_weekly_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE distrilog.mission_weekly_metrics ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON distrilog.mission_weekly_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON distrilog.mission_weekly_metrics FROM PUBLIC, anon, authenticated;

-- Todos os valores abaixo são PEÇAS, nunca volumes/casulos/caixas.
-- COMPLETION: fato finalizado no próprio fluxo; evita avanço por simples
-- movimentação de endereço ou pelo mero estado AGUARDANDO de um Card.
CREATE OR REPLACE FUNCTION distrilog.mission_production_facts()
RETURNS TABLE(sector text, event_key text, finished_at timestamptz, pieces bigint)
LANGUAGE sql STABLE
SET search_path = distrilog,pg_catalog
SET TimeZone = 'UTC'
AS $$
WITH item_totals AS (
    SELECT i.card_id,
           SUM(GREATEST(0,COALESCE(NULLIF(i.real_qty,0),i.expected_qty,0)))::bigint qty
    FROM distrilog.items i GROUP BY i.card_id
), receiving AS (
    SELECT 'RECEBIMENTO'::text AS sector, 'recebimento:'||r.id AS event_key,
           NULLIF(r.physical_completed_at,'')::timestamptz AS finished_at,
           GREATEST(0,COALESCE(NULLIF(r.received_qty,0),
             CASE WHEN r.source_subset=1
                THEN (SELECT SUM(GREATEST(0,COALESCE(NULLIF(i.real_qty,0),i.expected_qty,0)))
                      FROM distrilog.receiving_operation_items roi
                      JOIN distrilog.items i ON i.id=roi.item_id
                      WHERE roi.receiving_id=r.id)
                ELSE it.qty END,0))::bigint AS pieces
    FROM distrilog.receivings r
    LEFT JOIN item_totals it ON it.card_id=r.card_id
    WHERE r.physical_status='CONCLUIDO' AND r.physical_completed_at IS NOT NULL
), inspected AS (
    SELECT CASE WHEN q.inspection_type=2 THEN 'QUALIDADE 2' ELSE 'QUALIDADE 1' END AS sector,
           'qualidade:'||q.id AS event_key,
           NULLIF(q.completed_at,'')::timestamptz AS finished_at,
           GREATEST(0,COALESCE(
               CASE WHEN q.source_subset=1 THEN
                  (SELECT SUM(GREATEST(0,COALESCE(NULLIF(i.real_qty,0),i.expected_qty,0)))
                   FROM distrilog.quality_inspection_items qi
                   JOIN distrilog.items i ON i.id=qi.item_id
                   WHERE qi.inspection_id=q.id)
               ELSE it.qty END,0))::bigint AS pieces
    FROM distrilog.quality_inspections q
    LEFT JOIN item_totals it ON it.card_id=q.card_id
    WHERE q.status='CONCLUIDA' AND q.completed_at IS NOT NULL
), triaged AS (
    SELECT 'PROCESSAMENTO'::text AS sector, 'triagem:'||t.id AS event_key,
           NULLIF(t.finished_at,'')::timestamptz AS finished_at,
           GREATEST(0,COALESCE(t.counted_total,0))::bigint AS pieces
    FROM distrilog.processing_triages t
    WHERE t.status='CONCLUIDA' AND t.finished_at IS NOT NULL
), processed_legacy AS (
    -- Fluxo sem Triagem: só itens com quantidades de PEÇAS registradas;
    -- processed_qty_general corresponde a VOLUMES e não é utilizado.
    SELECT 'PROCESSAMENTO'::text AS sector,'processamento:'||pr.id AS event_key,
           NULLIF(pr.completed_at,'')::timestamptz AS finished_at,
           GREATEST(0,COALESCE((
             SELECT SUM(pi.processed_qty)::bigint
             FROM distrilog.processing_item_quantities pi
             WHERE pi.processing_id=pr.id),0))::bigint AS pieces
    FROM distrilog.processing_records pr
    WHERE pr.status='CONCLUIDO' AND pr.completed_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM distrilog.processing_triages t
        WHERE t.card_id=pr.card_id AND t.status='CONCLUIDA'
      )
), downstream_finished AS (
    SELECT d.sector::text AS sector,'operacao:'||d.id AS event_key,
           NULLIF(d.completed_at,'')::timestamptz AS finished_at,
           GREATEST(0,COALESCE((
              SELECT SUM(a.completed_qty)::bigint
              FROM distrilog.downstream_assignments a WHERE a.operation_id=d.id
           ),0))::bigint AS pieces
    FROM distrilog.downstream_operations d
    WHERE d.sector IN ('ETIQUETAGEM','ESTOCAGEM')
      AND d.status='CONCLUIDO' AND d.completed_at IS NOT NULL
), storage_direct AS (
    SELECT 'ESTOCAGEM'::text AS sector,'entrada:'||e.id AS event_key,
           NULLIF(e.concluded_at,'')::timestamptz AS finished_at,
           GREATEST(0,COALESCE((
              SELECT SUM(si.stored_qty)::bigint
              FROM distrilog.storage_entry_items si WHERE si.entry_id=e.id
           ),0))::bigint AS pieces
    FROM distrilog.storage_entries e
    WHERE e.concluded_at IS NOT NULL
      AND e.downstream_operation_id IS NULL
), pcp_dispatch AS (
    SELECT 'EXPEDIÇÃO PCP'::text AS sector,'despacho:'||d.id AS event_key,
           NULLIF(d.completed_at,'')::timestamptz AS finished_at,
           GREATEST(0,COALESCE(d.dispatched_qty,0))::bigint AS pieces
    FROM distrilog.dispatches d WHERE d.completed_at IS NOT NULL
), expedition AS (
    SELECT 'EXPEDIÇÃO'::text AS sector,'expedicao:'||s.id AS event_key,
           NULLIF(s.completed_at,'')::timestamptz AS finished_at,
           GREATEST(0,COALESCE(s.total_qty,0))::bigint AS pieces
    FROM distrilog.shipments s WHERE s.completed_at IS NOT NULL
)
SELECT * FROM receiving
UNION ALL SELECT * FROM inspected
UNION ALL SELECT * FROM triaged
UNION ALL SELECT * FROM processed_legacy
UNION ALL SELECT * FROM downstream_finished
UNION ALL SELECT * FROM storage_direct
UNION ALL SELECT * FROM pcp_dispatch
UNION ALL SELECT * FROM expedition
$$;

-- Qualquer categoria sem fonte efetiva (AJUSTES) fica NULL, nunca zero falso.
-- O mesmo conjunto de nove setores é gravado em cada captura.
CREATE OR REPLACE FUNCTION distrilog.mission_capture_snapshot(p_kind text)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = distrilog,pg_catalog
SET TimeZone = 'UTC'
AS $$
DECLARE
    local_clock timestamp;
    week_monday date;
    due_local timestamp;
    due_at timestamptz;
    inserted integer;
BEGIN
    IF p_kind NOT IN ('BACKLOG','WED','FRI') THEN
        RAISE EXCEPTION 'Tipo de fotografia inválido';
    END IF;
    local_clock := clock_timestamp() AT TIME ZONE 'America/Sao_Paulo';
    week_monday := local_clock::date - (EXTRACT(ISODOW FROM local_clock)::integer - 1);
    due_local := CASE p_kind
        WHEN 'BACKLOG' THEN week_monday::timestamp + interval '8 hours 10 minutes'
        WHEN 'WED' THEN (week_monday + 2)::timestamp + interval '12 hours'
        ELSE (week_monday + 4)::timestamp + interval '16 hours'
    END;
    -- A função não aceita fotografias tardias com o saldo atual.
    -- O cron deve cair dentro do minuto exato no calendário local.
    IF local_clock < due_local OR local_clock >= due_local + interval '1 minute' THEN
        RETURN FALSE;
    END IF;
    due_at := due_local AT TIME ZONE 'America/Sao_Paulo';
    -- Impede duplicatas se houver reinício ou execuções simultâneas.
    PERFORM pg_advisory_xact_lock(hashtext('distrilog-mission-'||week_monday||'-'||p_kind));
    INSERT INTO distrilog.mission_weekly_runs(week_start,snapshot_kind,planned_at,source_cards)
    SELECT week_monday,p_kind,due_at,(SELECT COUNT(*) FROM distrilog.cards)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS inserted = ROW_COUNT;
    IF inserted=0 THEN RETURN FALSE; END IF;

    IF p_kind='BACKLOG' THEN
        WITH workload AS (
          SELECT i.card_id,
                 CASE
                   WHEN c.current_sector='RECEBIMENTO'
                        AND c.status NOT IN ('EM_TRANSITO','ORIGEM_TRANSITO','EM_COSTURA_CD01')
                       THEN 'RECEBIMENTO'
                   WHEN c.current_sector='QUALIDADE' THEN
                       CASE WHEN COALESCE((
                           SELECT qi.inspection_type FROM distrilog.quality_inspections qi
                           WHERE qi.card_id=c.id ORDER BY qi.id DESC LIMIT 1
                       ), CASE WHEN c.receiving_type='RETORNO' THEN 2 ELSE 1 END)=2
                       THEN 'QUALIDADE 2' ELSE 'QUALIDADE 1' END
                   WHEN c.current_sector IN ('PROCESSAMENTO','TRIAGEM') THEN 'PROCESSAMENTO'
                   WHEN c.current_sector='ETIQUETAGEM' THEN 'ETIQUETAGEM'
                   WHEN c.current_sector='ESTOCAGEM' THEN 'ESTOCAGEM'
                   WHEN c.current_sector IN ('PCP','EXPEDICAO_PCP','PLANEJAMENTO') THEN 'EXPEDIÇÃO PCP'
                   WHEN c.current_sector IN ('EXPEDICAO','EXPEDIÇÃO') THEN 'EXPEDIÇÃO'
                   WHEN c.current_sector='AJUSTES' THEN 'AJUSTES'
                   ELSE NULL END sector,
                 GREATEST(0,COALESCE(NULLIF(i.real_qty,0),i.expected_qty,0))::bigint AS qty
          FROM distrilog.cards c
          JOIN distrilog.items i ON i.card_id=c.id
          WHERE c.status NOT IN ('FINALIZADO','CANCELADO','CANCELADA','CONCLUIDO','CONCLUÍDO')
        ), per_sector AS (
          SELECT sector,COALESCE(SUM(qty),0)::bigint AS qty FROM workload
          WHERE sector IS NOT NULL GROUP BY sector
        )
        INSERT INTO distrilog.mission_weekly_metrics(week_start,snapshot_kind,sector,pieces,source_label)
        SELECT week_monday,p_kind,s.sector,COALESCE(p.qty,0),
               'Cards abertos do setor · peças dos itens'
        FROM unnest(ARRAY['RECEBIMENTO','EXPEDIÇÃO PCP','QUALIDADE 1','QUALIDADE 2',
             'PROCESSAMENTO','ETIQUETAGEM','ESTOCAGEM','AJUSTES','EXPEDIÇÃO']::text[]) s(sector)
        LEFT JOIN per_sector p ON p.sector=s.sector;
    ELSE
        WITH events AS (
          SELECT e.sector,COALESCE(SUM(e.pieces),0)::bigint AS qty
          FROM distrilog.mission_production_facts() e
          WHERE e.finished_at >= (week_monday::timestamp + interval '8 hours 10 minutes')
                                      AT TIME ZONE 'America/Sao_Paulo'
            AND e.finished_at <= due_at
          GROUP BY e.sector
        )
        INSERT INTO distrilog.mission_weekly_metrics(week_start,snapshot_kind,sector,pieces,source_label)
        SELECT week_monday,p_kind,s.sector,
               CASE WHEN s.sector='AJUSTES' THEN NULL
                    ELSE COALESCE(events.qty,0) END,
               CASE WHEN s.sector='AJUSTES' THEN 'SEM FONTE OPERACIONAL DE PEÇAS CONCLUÍDAS'
                    ELSE 'Concluídos desde segunda 08:10 até o corte' END
        FROM unnest(ARRAY['RECEBIMENTO','EXPEDIÇÃO PCP','QUALIDADE 1','QUALIDADE 2',
             'PROCESSAMENTO','ETIQUETAGEM','ESTOCAGEM','AJUSTES','EXPEDIÇÃO']::text[]) s(sector)
        LEFT JOIN events ON events.sector=s.sector;
    END IF;
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION distrilog.mission_production_facts() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION distrilog.mission_capture_snapshot(text) FROM PUBLIC,anon,authenticated;

-- Um disparo no horário de verão e outro no horário padrão. Apenas aquele
-- que coincide com America/Sao_Paulo executa; nunca dobra o fechamento.
SELECT cron.schedule('distrilog-mission-backlog','10 10,11 * * 1',
    $$SELECT distrilog.mission_capture_snapshot('BACKLOG')$$);
SELECT cron.schedule('distrilog-mission-wednesday','0 14,15 * * 3',
    $$SELECT distrilog.mission_capture_snapshot('WED')$$);
SELECT cron.schedule('distrilog-mission-friday','0 18,19 * * 5',
    $$SELECT distrilog.mission_capture_snapshot('FRI')$$);
