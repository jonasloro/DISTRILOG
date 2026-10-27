-- Índices alinhados às consultas reais de Cards, inspeções, triagens e trilhas.
CREATE INDEX IF NOT EXISTS idx_hist_card_id_desc ON distrilog.history(card_id,id DESC);
CREATE INDEX IF NOT EXISTS idx_receivings_card_id_desc ON distrilog.receivings(card_id,id DESC);
CREATE INDEX IF NOT EXISTS idx_quality_inspections_card_id_desc ON distrilog.quality_inspections(card_id,id DESC);
CREATE INDEX IF NOT EXISTS idx_processing_records_card_id_desc ON distrilog.processing_records(card_id,id DESC);
CREATE INDEX IF NOT EXISTS idx_processing_triages_card_id_desc ON distrilog.processing_triages(card_id,id DESC);
CREATE INDEX IF NOT EXISTS idx_processing_cadastro_tasks_card_id ON distrilog.processing_cadastro_tasks(card_id,id);
CREATE INDEX IF NOT EXISTS idx_processing_triage_events_triage ON distrilog.processing_triage_events(triage_id,id);
CREATE INDEX IF NOT EXISTS idx_processing_triage_counts_triage ON distrilog.processing_triage_counts(triage_id,item_id);
CREATE INDEX IF NOT EXISTS idx_quality_worker_timers_worker ON distrilog.quality_worker_timer_events(worker_id,id);
CREATE INDEX IF NOT EXISTS idx_processing_timer_events_worker ON distrilog.processing_timer_events(worker_id,id);
CREATE INDEX IF NOT EXISTS idx_storage_entries_card_id ON distrilog.storage_entries(card_id,id);
CREATE INDEX IF NOT EXISTS idx_items_stage_card_id ON distrilog.items(source_stage,card_id);
