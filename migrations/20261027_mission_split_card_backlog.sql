-- Mission split-card improvement: per-item stage for subset flows.
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

