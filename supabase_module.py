"""Conexão com o Supabase (Postgres) e autenticação de usuários.

A lógica de hash de senha (gerar_hash_senha/verificar_senha) é uma cópia
exata do core/usuarios.py do OutLog-Distribox — PBKDF2-HMAC-SHA256 com
salt aleatório, 200 mil iterações, comparação segura contra timing attack.
Não usa bcrypt/passlib de propósito, só o que já vem no Python padrão
(mesma decisão do app original).

Além da autenticação e da estrutura física do CD, este módulo mantém no
Postgres do Supabase uma cópia persistente dos cards e itens operacionais.
O workflow continua usando SQLite local para compatibilidade com os módulos
existentes, mas cards e itens são sincronizados para sobreviver a redeploy.
"""
from __future__ import annotations

import binascii
import hashlib
import hmac
import os

import psycopg
from psycopg.rows import dict_row


def pg_connect():
    """Conecta no Postgres do Supabase. Lê a connection string da variável
    de ambiente SUPABASE_DATABASE_URL — precisa estar configurada no
    Railway (Variables) antes disso funcionar."""
    url = os.getenv("SUPABASE_DATABASE_URL")
    if not url:
        raise RuntimeError(
            "SUPABASE_DATABASE_URL não está configurada. Defina essa variável de "
            "ambiente com a connection string do Supabase (Settings → Database)."
        )
    return psycopg.connect(url, connect_timeout=10, row_factory=dict_row)


def gerar_hash_senha(senha_texto_puro: str) -> str:
    """PBKDF2-HMAC-SHA256 com salt aleatório — mesma lógica do OutLog-Distribox."""
    salt = os.urandom(16)
    hash_bytes = hashlib.pbkdf2_hmac("sha256", senha_texto_puro.encode("utf-8"), salt, 200_000)
    return binascii.hexlify(salt).decode() + ":" + binascii.hexlify(hash_bytes).decode()


def verificar_senha(senha_texto_puro: str, hash_armazenado: str) -> bool:
    try:
        salt_hex, hash_hex = hash_armazenado.split(":")
        salt = binascii.unhexlify(salt_hex)
        hash_esperado = binascii.unhexlify(hash_hex)
        hash_calculado = hashlib.pbkdf2_hmac("sha256", senha_texto_puro.encode("utf-8"), salt, 200_000)
        return hmac.compare_digest(hash_calculado, hash_esperado)
    except Exception:
        return False


def verificar_login_supabase(usuario: str, senha_texto_puro: str) -> dict | None:
    """Confere usuário/senha no Postgres (Supabase). Se bater, devolve
    {"usuario": ..., "papel": ...} — quem chama essa função ainda precisa
    casar isso com a tabela local de users (SQLite) pra pegar o id que o
    resto do app usa (require_user, criado_por etc. continuam olhando pro
    SQLite, sem mudança)."""
    with pg_connect() as con:
        with con.cursor() as cur:
            cur.execute(
                "SELECT usuario, senha_hash, papel FROM usuarios WHERE usuario=%s",
                (usuario,),
            )
            linha = cur.fetchone()
    if not linha:
        return None
    if not verificar_senha(senha_texto_puro, linha["senha_hash"]):
        return None
    return {"usuario": linha["usuario"], "papel": linha["papel"]}


def criar_usuario_supabase(usuario: str, senha_texto_puro: str, papel: str) -> None:
    senha_hash = gerar_hash_senha(senha_texto_puro)
    with pg_connect() as con:
        with con.cursor() as cur:
            cur.execute(
                """INSERT INTO usuarios (usuario, senha_hash, papel) VALUES (%s, %s, %s)
                   ON CONFLICT (usuario) DO UPDATE SET senha_hash=EXCLUDED.senha_hash, papel=EXCLUDED.papel""",
                (usuario, senha_hash, papel),
            )
        con.commit()


def seed_usuarios_supabase(usuarios_padrao: list[tuple[str, str, str]]) -> None:
    """Popula a tabela usuarios no Supabase com a lista padrão (usuario,
    senha, papel) — só insere quem ainda não existir lá (ON CONFLICT DO
    NOTHING), então é seguro rodar isso toda vez que o app sobe."""
    with pg_connect() as con:
        with con.cursor() as cur:
            for usuario, senha_texto_puro, papel in usuarios_padrao:
                senha_hash = gerar_hash_senha(senha_texto_puro)
                cur.execute(
                    """INSERT INTO usuarios (usuario, senha_hash, papel) VALUES (%s, %s, %s)
                       ON CONFLICT (usuario) DO NOTHING""",
                    (usuario, senha_hash, papel),
                )
        con.commit()


CARD_COLUMNS = [
    "id", "purchase_id", "source_created_date", "supplier", "original_type",
    "purchase_mode", "status_compra", "original_destination", "forecast_date",
    "qtd_itens", "source_notes", "brand", "collection", "current_sector",
    "status", "receiving_type", "quality_destination", "casulo_current",
    "source_location_summary", "source_snapshot_at", "created_at", "updated_at",
]

ITEM_COLUMNS = [
    "id", "card_id", "source_key", "product", "reference", "sku", "group_name",
    "collection", "brand", "gender", "color", "size", "capsule", "lot", "lot_id",
    "nf", "expected_qty", "url_photo", "status_kanban", "source_stage",
    "source_status_purchase", "source_status_lot", "source_status_quality",
    "source_inspection_phase", "source_status_pcp", "source_seamstress",
    "source_status_logistics", "source_received_qty",
]

RECEIVING_COLUMNS = [
    "id", "card_id", "receiving_type", "physical_status", "volumes", "received_qty",
    "has_damage", "damage_description", "notes", "photo_paths", "ten_percent_required",
    "ten_percent_min", "ten_percent_actual", "ten_percent_status",
    "physical_completed_by", "physical_completed_at", "closed_at", "created_at",
]

TIMER_EVENT_COLUMNS = [
    "id", "receiving_id", "event_type", "event_at", "user_id",
]


def init_card_persistence() -> None:
    """Cria as tabelas persistentes dos cards no Supabase sem substituir dados."""
    with pg_connect() as con:
        with con.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS outlog_cards (
                    id BIGINT PRIMARY KEY,
                    purchase_id TEXT NOT NULL UNIQUE,
                    source_created_date TEXT, supplier TEXT, original_type TEXT,
                    purchase_mode TEXT, status_compra TEXT, original_destination TEXT,
                    forecast_date TEXT, qtd_itens INTEGER DEFAULT 0, source_notes TEXT,
                    brand TEXT, collection TEXT, current_sector TEXT NOT NULL,
                    status TEXT NOT NULL, receiving_type TEXT NOT NULL,
                    quality_destination TEXT, casulo_current TEXT,
                    source_location_summary TEXT, source_snapshot_at TEXT,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS outlog_items (
                    id BIGINT PRIMARY KEY,
                    card_id BIGINT NOT NULL REFERENCES outlog_cards(id) ON DELETE CASCADE,
                    source_key TEXT NOT NULL, product TEXT, reference TEXT, sku TEXT,
                    group_name TEXT, collection TEXT, brand TEXT, gender TEXT,
                    color TEXT, size TEXT, capsule TEXT, lot TEXT, lot_id TEXT, nf TEXT,
                    expected_qty INTEGER NOT NULL DEFAULT 0, url_photo TEXT,
                    status_kanban TEXT, source_stage TEXT, source_status_purchase TEXT,
                    source_status_lot TEXT, source_status_quality TEXT,
                    source_inspection_phase TEXT, source_status_pcp TEXT,
                    source_seamstress TEXT, source_status_logistics TEXT,
                    source_received_qty INTEGER DEFAULT 0,
                    UNIQUE(card_id, source_key)
                )
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_outlog_items_card ON outlog_items(card_id)")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS outlog_receivings (
                    id BIGINT PRIMARY KEY,
                    card_id BIGINT NOT NULL REFERENCES outlog_cards(id) ON DELETE CASCADE,
                    receiving_type TEXT NOT NULL,
                    physical_status TEXT NOT NULL DEFAULT 'PENDENTE',
                    volumes INTEGER,
                    received_qty INTEGER,
                    has_damage INTEGER,
                    damage_description TEXT,
                    notes TEXT,
                    photo_paths TEXT,
                    ten_percent_required INTEGER NOT NULL DEFAULT 0,
                    ten_percent_min INTEGER NOT NULL DEFAULT 0,
                    ten_percent_actual INTEGER,
                    ten_percent_status TEXT NOT NULL DEFAULT 'NAO_INICIADA',
                    physical_completed_by INTEGER,
                    physical_completed_at TEXT,
                    closed_at TEXT,
                    created_at TEXT NOT NULL
                )
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_outlog_receivings_card ON outlog_receivings(card_id)")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS outlog_timer_events (
                    id BIGINT PRIMARY KEY,
                    receiving_id BIGINT NOT NULL REFERENCES outlog_receivings(id) ON DELETE CASCADE,
                    event_type TEXT NOT NULL,
                    event_at TEXT NOT NULL,
                    user_id INTEGER NOT NULL
                )
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_outlog_timer_events_receiving ON outlog_timer_events(receiving_id)")
        con.commit()


def _card_tuple(row) -> tuple:
    return tuple(row[column] for column in CARD_COLUMNS)


def _item_tuple(row) -> tuple:
    return tuple(row[column] for column in ITEM_COLUMNS)


def _receiving_tuple(row) -> tuple:
    return tuple(row[column] for column in RECEIVING_COLUMNS)


def _timer_event_tuple(row) -> tuple:
    return tuple(row[column] for column in TIMER_EVENT_COLUMNS)


def sync_all_receiving_state_to_supabase(sqlite_con) -> None:
    if not os.getenv("SUPABASE_DATABASE_URL"):
        return
    """Persiste os controles de Recebimento e os eventos dos cronômetros."""
    receivings = sqlite_con.execute("SELECT * FROM receivings ORDER BY id").fetchall()
    timer_events = sqlite_con.execute("SELECT * FROM timer_events ORDER BY id").fetchall()

    receiving_columns_sql = ",".join(RECEIVING_COLUMNS)
    timer_columns_sql = ",".join(TIMER_EVENT_COLUMNS)
    receiving_marks = ",".join(["%s"] * len(RECEIVING_COLUMNS))
    timer_marks = ",".join(["%s"] * len(TIMER_EVENT_COLUMNS))
    receiving_updates = ", ".join(
        f"{column}=EXCLUDED.{column}" for column in RECEIVING_COLUMNS if column != "id"
    )
    timer_updates = ", ".join(
        f"{column}=EXCLUDED.{column}" for column in TIMER_EVENT_COLUMNS if column != "id"
    )
    receiving_sql = (
        f"INSERT INTO outlog_receivings ({receiving_columns_sql}) VALUES ({receiving_marks})"
        f" ON CONFLICT (id) DO UPDATE SET {receiving_updates}"
    )
    timer_sql = (
        f"INSERT INTO outlog_timer_events ({timer_columns_sql}) VALUES ({timer_marks})"
        f" ON CONFLICT (id) DO UPDATE SET {timer_updates}"
    )

    with pg_connect() as con:
        with con.cursor() as cur:
            if receivings:
                cur.executemany(receiving_sql, [_receiving_tuple(row) for row in receivings])
            if timer_events:
                cur.executemany(timer_sql, [_timer_event_tuple(row) for row in timer_events])
        con.commit()


def restore_receiving_state_from_supabase(sqlite_con) -> int:
    """Merge persisted receiving controls without overwriting more advanced local state."""
    with pg_connect() as con:
        with con.cursor() as cur:
            cur.execute("SELECT * FROM outlog_receivings ORDER BY id")
            remote_receivings = cur.fetchall()
            cur.execute("SELECT * FROM outlog_timer_events ORDER BY id")
            remote_events = cur.fetchall()

    local_card_ids = {
        int(row["id"]) for row in sqlite_con.execute("SELECT id FROM cards").fetchall()
    }
    receiving_columns = ",".join(RECEIVING_COLUMNS)
    receiving_marks = ",".join(["?"] * len(RECEIVING_COLUMNS))
    columns_without_id = ",".join(RECEIVING_COLUMNS[1:])
    marks_without_id = ",".join(["?"] * (len(RECEIVING_COLUMNS) - 1))
    remote_to_local_receiving_id = {}
    restored_count = 0

    for row in remote_receivings:
        remote_id = int(row["id"])
        card_id = int(row["card_id"])
        if card_id not in local_card_ids:
            continue

        local = sqlite_con.execute(
            "SELECT * FROM receivings WHERE id=?", (remote_id,)
        ).fetchone()
        if local and int(local["card_id"]) == card_id and local["receiving_type"] == row["receiving_type"]:
            local_id = remote_id
            # A completed positive sample is terminal for a receiving record. If the
            # local copy is incomplete, recover only the sample fields from Supabase.
            remote_done = row["ten_percent_status"] == "CONCLUIDA" and int(row["ten_percent_actual"] or 0) > 0
            local_done = local["ten_percent_status"] == "CONCLUIDA" and int(local["ten_percent_actual"] or 0) > 0
            if remote_done and not local_done:
                sqlite_con.execute(
                    """UPDATE receivings SET
                       volumes=COALESCE(?,volumes),
                       received_qty=COALESCE(?,received_qty),
                       ten_percent_required=?,
                       ten_percent_min=COALESCE(?,ten_percent_min),
                       ten_percent_actual=?,
                       ten_percent_status='CONCLUIDA'
                       WHERE id=?""",
                    (
                        row["volumes"], row["received_qty"], row["ten_percent_required"],
                        row["ten_percent_min"], row["ten_percent_actual"], remote_id,
                    ),
                )
                restored_count += 1
        else:
            # IDs can collide when a deployment has a partially rebuilt local SQLite
            # database. Preserve both records and remap the remote ID to a new local ID.
            values = tuple(row[column] for column in RECEIVING_COLUMNS[1:])
            cursor = sqlite_con.execute(
                "INSERT INTO receivings ({}) VALUES ({})".format(columns_without_id, marks_without_id),
                values,
            )
            local_id = int(cursor.lastrowid)
            restored_count += 1
        remote_to_local_receiving_id[remote_id] = local_id

    timer_columns = ",".join(TIMER_EVENT_COLUMNS)
    timer_marks = ",".join(["?"] * len(TIMER_EVENT_COLUMNS))
    timer_without_id = ",".join(TIMER_EVENT_COLUMNS[1:])
    timer_marks_without_id = ",".join(["?"] * (len(TIMER_EVENT_COLUMNS) - 1))

    for row in remote_events:
        remote_receiving_id = int(row["receiving_id"])
        local_receiving_id = remote_to_local_receiving_id.get(remote_receiving_id)
        if local_receiving_id is None:
            # Retain a local link when the same receiving ID already exists and belongs
            # to a card in this database.
            local_parent = sqlite_con.execute(
                "SELECT id FROM receivings WHERE id=?", (remote_receiving_id,)
            ).fetchone()
            if not local_parent:
                continue
            local_receiving_id = remote_receiving_id

        event = sqlite_con.execute(
            "SELECT receiving_id,event_type,event_at,user_id FROM timer_events WHERE id=?",
            (row["id"],),
        ).fetchone()
        if event:
            if int(event["receiving_id"]) == local_receiving_id:
                continue
            values = (local_receiving_id, row["event_type"], row["event_at"], row["user_id"])
            sqlite_con.execute(
                "INSERT INTO timer_events ({}) VALUES ({})".format(timer_without_id, timer_marks_without_id),
                values,
            )
        else:
            values = (row["id"], local_receiving_id, row["event_type"], row["event_at"], row["user_id"])
            sqlite_con.execute(
                "INSERT INTO timer_events ({}) VALUES ({})".format(timer_columns, timer_marks),
                values,
            )

    return restored_count
def sync_card_to_supabase(sqlite_con, card_id: int) -> None:
    row = sqlite_con.execute("SELECT * FROM cards WHERE id=?", (card_id,)).fetchone()
    if not row:
        return
    columns_sql = ",".join(CARD_COLUMNS)
    placeholders = ",".join(["%s"] * len(CARD_COLUMNS))
    updates = ", ".join(f"{column}=EXCLUDED.{column}" for column in CARD_COLUMNS if column != "id")
    sql = (
        f"INSERT INTO outlog_cards ({columns_sql}) VALUES ({placeholders})"
        f" ON CONFLICT (id) DO UPDATE SET {updates}"
    )
    with pg_connect() as con:
        with con.cursor() as cur:
            cur.execute(sql, _card_tuple(row))
        con.commit()


def delete_card_from_supabase(card_id: int) -> None:
    if not os.getenv("SUPABASE_DATABASE_URL"):
        return
    with pg_connect() as con:
        with con.cursor() as cur:
            cur.execute("DELETE FROM card_allocations WHERE card_id=%s", (card_id,))
            cur.execute("DELETE FROM outlog_cards WHERE id=%s", (card_id,))
        con.commit()



def sync_card_items_to_supabase(sqlite_con, card_id: int) -> None:
    if not os.getenv("SUPABASE_DATABASE_URL"):
        return
    """Substitui no Supabase exatamente os itens locais de um Card."""
    items = sqlite_con.execute(
        "SELECT * FROM items WHERE card_id=? ORDER BY id",
        (card_id,),
    ).fetchall()
    columns_sql = ",".join(ITEM_COLUMNS)
    placeholders = ",".join(["%s"] * len(ITEM_COLUMNS))
    updates = ", ".join(f"{column}=EXCLUDED.{column}" for column in ITEM_COLUMNS if column != "id")
    item_sql = (
        f"INSERT INTO outlog_items ({columns_sql}) VALUES ({placeholders})"
        f" ON CONFLICT (id) DO UPDATE SET {updates}"
    )
    with pg_connect() as con:
        with con.cursor() as cur:
            cur.execute("DELETE FROM outlog_items WHERE card_id=%s", (card_id,))
            if items:
                cur.executemany(item_sql, [_item_tuple(row) for row in items])
        con.commit()


def sync_card_with_items_to_supabase(sqlite_con, card_id: int) -> None:
    if not os.getenv("SUPABASE_DATABASE_URL"):
        return
    """Persiste um Card e todos os seus itens no mesmo commit do Supabase."""
    card = sqlite_con.execute("SELECT * FROM cards WHERE id=?", (card_id,)).fetchone()
    if not card:
        return
    items = sqlite_con.execute(
        "SELECT * FROM items WHERE card_id=? ORDER BY id",
        (card_id,),
    ).fetchall()

    card_columns_sql = ",".join(CARD_COLUMNS)
    item_columns_sql = ",".join(ITEM_COLUMNS)
    card_placeholders = ",".join(["%s"] * len(CARD_COLUMNS))
    item_placeholders = ",".join(["%s"] * len(ITEM_COLUMNS))
    card_updates = ", ".join(f"{column}=EXCLUDED.{column}" for column in CARD_COLUMNS if column != "id")
    item_updates = ", ".join(f"{column}=EXCLUDED.{column}" for column in ITEM_COLUMNS if column != "id")

    card_sql = (
        f"INSERT INTO outlog_cards ({card_columns_sql}) VALUES ({card_placeholders})"
        f" ON CONFLICT (id) DO UPDATE SET {card_updates}"
    )
    item_sql = (
        f"INSERT INTO outlog_items ({item_columns_sql}) VALUES ({item_placeholders})"
        f" ON CONFLICT (id) DO UPDATE SET {item_updates}"
    )

    with pg_connect() as con:
        with con.cursor() as cur:
            cur.execute(card_sql, _card_tuple(card))
            cur.execute("DELETE FROM outlog_items WHERE card_id=%s", (card_id,))
            if items:
                cur.executemany(item_sql, [_item_tuple(row) for row in items])
        con.commit()


def sync_all_cards_to_supabase(sqlite_con, include_items: bool = False) -> None:
    if not os.getenv("SUPABASE_DATABASE_URL"):
        return
    """Sincroniza o estado local dos cards; itens entram quando solicitado (importação)."""
    cards = sqlite_con.execute("SELECT * FROM cards ORDER BY id").fetchall()
    if not cards:
        return
    card_columns_sql = ",".join(CARD_COLUMNS)
    item_columns_sql = ",".join(ITEM_COLUMNS)
    placeholders = ",".join(["%s"] * len(CARD_COLUMNS))
    item_placeholders = ",".join(["%s"] * len(ITEM_COLUMNS))
    updates = ", ".join(f"{column}=EXCLUDED.{column}" for column in CARD_COLUMNS if column != "id")
    item_updates = ", ".join(f"{column}=EXCLUDED.{column}" for column in ITEM_COLUMNS if column != "id")
    card_sql = (
        f"INSERT INTO outlog_cards ({card_columns_sql}) VALUES ({placeholders})"
        f" ON CONFLICT (id) DO UPDATE SET {updates}"
    )
    item_sql = (
        f"INSERT INTO outlog_items ({item_columns_sql}) VALUES ({item_placeholders})"
        f" ON CONFLICT (id) DO UPDATE SET {item_updates}"
    )
    with pg_connect() as con:
        with con.cursor() as cur:
            cur.executemany(card_sql, [_card_tuple(row) for row in cards])
            if include_items:
                items = sqlite_con.execute("SELECT * FROM items ORDER BY id").fetchall()
                cur.executemany(item_sql, [_item_tuple(row) for row in items])
        con.commit()


def bootstrap_card_persistence(sqlite_con) -> dict:
    if not os.getenv("SUPABASE_DATABASE_URL"):
        return {"mode": "local_only", "cards": 0}
    """Inicializa o espelho e decide se deve enviar a base local ou restaurar do Supabase."""
    init_card_persistence()
    local_count = int(sqlite_con.execute("SELECT COUNT(*) AS n FROM cards").fetchone()["n"] or 0)
    with pg_connect() as con:
        with con.cursor() as cur:
            cur.execute("SELECT COUNT(*) AS n FROM outlog_cards")
            remote_count = int(cur.fetchone()["n"] or 0)
    if local_count > 0 and remote_count == 0:
        sync_all_cards_to_supabase(sqlite_con, include_items=True)
        sync_all_receiving_state_to_supabase(sqlite_con)
        return {"mode": "seeded_remote", "cards": local_count}
    if local_count > 0:
        restored_receivings = restore_receiving_state_from_supabase(sqlite_con)
        sync_all_cards_to_supabase(sqlite_con, include_items=False)
        sync_all_receiving_state_to_supabase(sqlite_con)
        if restored_receivings:
            print("[persistencia] {} registro(s) de Recebimento recuperados do Supabase.".format(restored_receivings))
        return {"mode": "local", "cards": local_count, "receivings_restored": restored_receivings}
    if remote_count == 0:
        return {"mode": "empty", "cards": 0}

    with pg_connect() as con:
        with con.cursor() as cur:
            cur.execute("SELECT * FROM outlog_cards ORDER BY id")
            cards = cur.fetchall()
            cur.execute("SELECT * FROM outlog_items ORDER BY id")
            items = cur.fetchall()
    columns = ",".join(CARD_COLUMNS)
    marks = ",".join(["?"] * len(CARD_COLUMNS))
    for row in cards:
        sqlite_con.execute(f"INSERT OR IGNORE INTO cards ({columns}) VALUES ({marks})", _card_tuple(row))
    item_columns = ",".join(ITEM_COLUMNS)
    item_marks = ",".join(["?"] * len(ITEM_COLUMNS))
    for row in items:
        sqlite_con.execute(f"INSERT OR IGNORE INTO items ({item_columns}) VALUES ({item_marks})", _item_tuple(row))
    receiving_count = restore_receiving_state_from_supabase(sqlite_con)
    return {"mode": "restored", "cards": len(cards), "items": len(items), "receivings": receiving_count}


