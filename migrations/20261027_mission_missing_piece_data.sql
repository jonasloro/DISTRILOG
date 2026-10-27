-- Datas congeladas continuam intactas. Recusar produções sem peça medida.
-- Números ausentes não são zero, e volumes não são somados como peças.
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
           CASE WHEN r.received_qty>0 THEN r.received_qty::bigint
                WHEN r.source_subset=1 THEN
                  (SELECT SUM(GREATEST(0,COALESCE(NULLIF(i.real_qty,0),i.expected_qty,0)))::bigint
                   FROM distrilog.receiving_operation_items roi
                   JOIN distrilog.items i ON i.id=roi.item_id
                   WHERE roi.receiving_id=r.id)
                ELSE it.qty END AS pieces
    FROM distrilog.receivings r
    LEFT JOIN item_totals it ON it.card_id=r.card_id
    WHERE r.physical_status='CONCLUIDO' AND r.physical_completed_at IS NOT NULL
), inspected AS (
    SELECT CASE WHEN q.inspection_type=2 THEN 'QUALIDADE 2' ELSE 'QUALIDADE 1' END AS sector,
           'qualidade:'||q.id AS event_key,
           NULLIF(q.completed_at,'')::timestamptz AS finished_at,
           CASE WHEN q.source_subset=1 THEN
                  (SELECT SUM(GREATEST(0,COALESCE(NULLIF(i.real_qty,0),i.expected_qty,0)))::bigint
                   FROM distrilog.quality_inspection_items qi
                   JOIN distrilog.items i ON i.id=qi.item_id
                   WHERE qi.inspection_id=q.id)
                ELSE it.qty END AS pieces
    FROM distrilog.quality_inspections q
    LEFT JOIN item_totals it ON it.card_id=q.card_id
    WHERE q.status='CONCLUIDA' AND q.completed_at IS NOT NULL
), triaged AS (
    SELECT 'PROCESSAMENTO'::text AS sector, 'triagem:'||t.id AS event_key,
           NULLIF(t.finished_at,'')::timestamptz AS finished_at,
           CASE WHEN t.counted_total IS NULL THEN NULL
                ELSE GREATEST(0,t.counted_total)::bigint END AS pieces
    FROM distrilog.processing_triages t
    WHERE t.status='CONCLUIDA' AND t.finished_at IS NOT NULL
), processed_legacy AS (
    -- Fluxo sem Triagem: só itens com quantidades de PEÇAS registradas;
    -- processed_qty_general corresponde a VOLUMES e não é utilizado.
    SELECT 'PROCESSAMENTO'::text AS sector,'processamento:'||pr.id AS event_key,
           NULLIF(pr.completed_at,'')::timestamptz AS finished_at,
           (SELECT SUM(GREATEST(0,pi.processed_qty))::bigint
            FROM distrilog.processing_item_quantities pi
            WHERE pi.processing_id=pr.id) AS pieces
    FROM distrilog.processing_records pr
    WHERE pr.status='CONCLUIDO' AND pr.completed_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM distrilog.processing_triages t
        WHERE t.card_id=pr.card_id AND t.status='CONCLUIDA'
      )
), downstream_finished AS (
    SELECT d.sector::text AS sector,'operacao:'||d.id AS event_key,
           NULLIF(d.completed_at,'')::timestamptz AS finished_at,
           (SELECT SUM(GREATEST(0,a.completed_qty))::bigint
            FROM distrilog.downstream_assignments a WHERE a.operation_id=d.id) AS pieces
    FROM distrilog.downstream_operations d
    WHERE d.sector IN ('ETIQUETAGEM','ESTOCAGEM')
      AND d.status='CONCLUIDO' AND d.completed_at IS NOT NULL
), storage_direct AS (
    SELECT 'ESTOCAGEM'::text AS sector,'entrada:'||e.id AS event_key,
           NULLIF(e.concluded_at,'')::timestamptz AS finished_at,
           (SELECT SUM(GREATEST(0,si.stored_qty))::bigint
            FROM distrilog.storage_entry_items si WHERE si.entry_id=e.id) AS pieces
    FROM distrilog.storage_entries e
    WHERE e.concluded_at IS NOT NULL
      AND e.downstream_operation_id IS NULL
), pcp_dispatch AS (
    SELECT 'EXPEDIÇÃO PCP'::text AS sector,'despacho:'||d.id AS event_key,
           NULLIF(d.completed_at,'')::timestamptz AS finished_at,
           CASE WHEN d.dispatched_qty IS NULL THEN NULL
                ELSE GREATEST(0,d.dispatched_qty)::bigint END AS pieces
    FROM distrilog.dispatches d WHERE d.completed_at IS NOT NULL
), expedition AS (
    SELECT 'EXPEDIÇÃO'::text AS sector,'expedicao:'||s.id AS event_key,
           NULLIF(s.completed_at,'')::timestamptz AS finished_at,
           CASE WHEN s.total_qty IS NULL THEN NULL
                ELSE GREATEST(0,s.total_qty)::bigint END AS pieces
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
        -- Itens de um mesmo Card podem ocupar setores diferentes.
        -- Em fluxo fracionado, source_stage é a etapa real do item;
        -- em fluxo normal, current_sector é a etapa do Card.
        WITH workload AS (
          SELECT c.id card_id,c.receiving_type,c.status,
                 CASE
                   WHEN NULLIF(TRIM(COALESCE(c.source_snapshot_at,'')),'') IS NOT NULL
                     AND UPPER(TRIM(COALESCE(i.source_stage,''))) IN (
                       'RECEBIMENTO','QUALIDADE','QUALIDADE_RETRABALHO',
                       'QUALIDADE_REJEITADO','AGUARDANDO_PROCESSAMENTO',
                       'PROCESSAMENTO','TRIAGEM','ETIQUETAGEM',
                       'ESTOCAGEM','EXPEDICAO','EXPEDIÇÃO','EXPEDICAO_PCP',
                       'PCP','AJUSTES','CONCLUIDO','FINALIZADO')
                   THEN UPPER(TRIM(i.source_stage))
                   ELSE UPPER(TRIM(COALESCE(c.current_sector,'')))
                 END AS stage,
                 GREATEST(0,COALESCE(NULLIF(i.real_qty,0),i.expected_qty,0))::bigint AS qty
          FROM distrilog.cards c
          JOIN distrilog.items i ON i.card_id=c.id
          WHERE c.status NOT IN ('FINALIZADO','CANCELADO','CANCELADA','CONCLUIDO','CONCLUÍDO')
        ), staged AS (
          SELECT CASE
                 WHEN stage='RECEBIMENTO'
                      AND status NOT IN ('EM_TRANSITO','ORIGEM_TRANSITO','EM_COSTURA_CD01')
                      THEN 'RECEBIMENTO'
                 WHEN stage IN ('QUALIDADE','QUALIDADE_RETRABALHO','QUALIDADE_REJEITADO')
                      THEN CASE WHEN COALESCE((
                          SELECT qi.inspection_type FROM distrilog.quality_inspections qi
                          WHERE qi.card_id=w.card_id ORDER BY qi.id DESC LIMIT 1
                      ),CASE WHEN w.receiving_type='RETORNO' THEN 2 ELSE 1 END)=2
                      THEN 'QUALIDADE 2' ELSE 'QUALIDADE 1' END
                 WHEN stage IN ('PROCESSAMENTO','AGUARDANDO_PROCESSAMENTO','TRIAGEM')
                      THEN 'PROCESSAMENTO'
                 WHEN stage='ETIQUETAGEM' THEN 'ETIQUETAGEM'
                 WHEN stage='ESTOCAGEM' THEN 'ESTOCAGEM'
                 WHEN stage IN ('PCP','EXPEDICAO_PCP','PLANEJAMENTO') THEN 'EXPEDIÇÃO PCP'
                 WHEN stage IN ('EXPEDICAO','EXPEDIÇÃO') THEN 'EXPEDIÇÃO'
                 WHEN stage='AJUSTES' THEN 'AJUSTES'
                 ELSE NULL END AS sector,
                 qty
          FROM workload w        ), per_sector AS (
          SELECT sector,COALESCE(SUM(qty),0)::bigint AS qty FROM staged
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
          SELECT e.sector,COALESCE(SUM(e.pieces),0)::bigint AS qty,
                 COUNT(*) FILTER(WHERE e.pieces IS NULL)::bigint AS unmeasured
          FROM distrilog.mission_production_facts() e
          WHERE e.finished_at >= (week_monday::timestamp + interval '8 hours 10 minutes')
                                      AT TIME ZONE 'America/Sao_Paulo'
            AND e.finished_at <= due_at
          GROUP BY e.sector
        )
        INSERT INTO distrilog.mission_weekly_metrics(week_start,snapshot_kind,sector,pieces,source_label)
        SELECT week_monday,p_kind,s.sector,
               CASE WHEN s.sector='AJUSTES' OR COALESCE(events.unmeasured,0)>0
                    THEN NULL ELSE COALESCE(events.qty,0) END,
               CASE WHEN s.sector='AJUSTES'
                    THEN 'SEM FONTE OPERACIONAL DE PEÇAS CONCLUÍDAS'
                    WHEN COALESCE(events.unmeasured,0)>0
                    THEN 'DADOS INCOMPLETOS: CONCLUSÃO SEM QUANTIDADE DE PEÇAS'
                    ELSE 'Concluídos desde segunda 08:10 até o corte' END
        FROM unnest(ARRAY['RECEBIMENTO','EXPEDIÇÃO PCP','QUALIDADE 1','QUALIDADE 2',
             'PROCESSAMENTO','ETIQUETAGEM','ESTOCAGEM','AJUSTES','EXPEDIÇÃO']::text[]) s(sector)
        LEFT JOIN events ON events.sector=s.sector;
    END IF;
    RETURN TRUE;
END;
$$;

