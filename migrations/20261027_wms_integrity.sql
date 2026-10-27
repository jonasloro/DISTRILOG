-- DISTRILOG WMS: proteção de integridade para novas alocações.
-- NOT VALID preserva registros legados órfãos para reconciliação supervisionada.
-- As constraints passam a validar TODAS as novas inserções e atualizações.
CREATE TABLE IF NOT EXISTS distrilog.position_movements (
    id BIGSERIAL PRIMARY KEY,
    card_id BIGINT NOT NULL,
    source_address TEXT NOT NULL,
    destination_address TEXT NOT NULL,
    from_sector TEXT NOT NULL,
    to_sector TEXT NOT NULL,
    item_id BIGINT,
    color TEXT,
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    box_count INTEGER NOT NULL DEFAULT 0 CHECK(box_count >= 0),
    unit TEXT NOT NULL CHECK(unit IN ('VOLUME','CAIXA_PRETA')),
    reason TEXT NOT NULL,
    actor_user_id BIGINT NOT NULL,
    actor_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE distrilog.position_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE distrilog.users
    ADD COLUMN IF NOT EXISTS session_revoked_after_ns BIGINT NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_wms_sector_address_unique
    ON distrilog.sector_positions(address,setor);
CREATE INDEX IF NOT EXISTS idx_wms_active_address
    ON distrilog.card_allocations(address,setor,card_id) WHERE active IS TRUE;
CREATE INDEX IF NOT EXISTS idx_wms_moves_location_date
    ON distrilog.position_movements(source_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wms_moves_destination_date
    ON distrilog.position_movements(destination_address, created_at DESC);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_wms_card_valid'
                   AND conrelid='distrilog.card_allocations'::regclass) THEN
        ALTER TABLE distrilog.card_allocations
        ADD CONSTRAINT fk_wms_card_valid FOREIGN KEY (card_id)
            REFERENCES distrilog.cards(id) ON DELETE RESTRICT NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_wms_item_valid'
                   AND conrelid='distrilog.card_allocations'::regclass) THEN
        ALTER TABLE distrilog.card_allocations
        ADD CONSTRAINT fk_wms_item_valid FOREIGN KEY (item_id)
            REFERENCES distrilog.items(id) ON DELETE RESTRICT NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_wms_address_sector_valid'
                   AND conrelid='distrilog.card_allocations'::regclass) THEN
        ALTER TABLE distrilog.card_allocations
        ADD CONSTRAINT fk_wms_address_sector_valid FOREIGN KEY (address,setor)
            REFERENCES distrilog.sector_positions(address,setor) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_wms_quantity_positive'
                   AND conrelid='distrilog.card_allocations'::regclass) THEN
        ALTER TABLE distrilog.card_allocations
        ADD CONSTRAINT ck_wms_quantity_positive CHECK(quantidade > 0) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_wms_boxes_nonnegative'
                   AND conrelid='distrilog.card_allocations'::regclass) THEN
        ALTER TABLE distrilog.card_allocations
        ADD CONSTRAINT ck_wms_boxes_nonnegative CHECK(box_count >= 0) NOT VALID;
    END IF;
END $$;
