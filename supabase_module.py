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
    "physical_completed_by", "physical_completed_at", "closed_at", "source_subset", "created_at",
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
                    source_subset SMALLINT NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL
                )
            """)
            cur.execute("ALTER TABLE outlog_receivings ADD COLUMN IF NOT EXISTS source_subset SMALLINT NOT NULL DEFAULT 0")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_outlog_receivings_card ON outlog_receivings(card_id)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_outlog_receivings_type ON outlog_receivings(card_id,receiving_type,id DESC)")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS outlog_receiving_operation_items (
                    receiving_id BIGINT NOT NULL REFERENCES outlog_receivings(id) ON DELETE CASCADE,
                    item_id BIGINT NOT NULL REFERENCES outlog_items(id) ON DELETE CASCADE,
                    PRIMARY KEY(receiving_id,item_id)
                )
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_outlog_receiving_items_item ON outlog_receiving_operation_items(item_id)")
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


def get_latest_receiving_from_supabase(card_id: int, receiving_type: str) -> dict | None:
    """Read the authoritative latest Receiving operation directly from Supabase."""
    with pg_connect() as con:
        with con.cursor() as cur:
            cur.execute(
                """SELECT * FROM outlog_receivings
                   WHERE card_id=%s AND receiving_type=%s
                   ORDER BY id DESC LIMIT 1""",
                (int(card_id), receiving_type),
            )
            return cur.fetchone()


def sync_receiving_card_state_to_supabase(
    sqlite_con,
    card_id: int,
    sync_item_ids: list[int] | None = None,
    receiving_type: str | None = None,
) -> dict[str, int]:
    """Write through Receiving state without overwriting unrelated item changes."""
    if not os.getenv("SUPABASE_DATABASE_URL"):
        raise RuntimeError("SUPABASE_DATABASE_URL não está configurada; o Recebimento não pode ser confirmado.")

    card = sqlite_con.execute("SELECT * FROM cards WHERE id=?", (int(card_id),)).fetchone()
    if not card:
        raise RuntimeError("Card {} não existe no banco local.".format(card_id))
    items = sqlite_con.execute(
        "SELECT * FROM items WHERE card_id=? ORDER BY id", (int(card_id),)
    ).fetchall()
    receiving_query = "SELECT * FROM receivings WHERE card_id=?"
    receiving_params: tuple = (int(card_id),)
    if receiving_type is not None:
        receiving_query += " AND receiving_type=?"
        receiving_params += (receiving_type,)
    receivings = sqlite_con.execute(
        receiving_query + " ORDER BY id", receiving_params
    ).fetchall()
    receiving_ids = [int(row["id"]) for row in receivings]

    events = []
    operation_items = []
    if receiving_ids:
        marks = ",".join("?" for _ in receiving_ids)
        events = sqlite_con.execute(
            "SELECT * FROM timer_events WHERE receiving_id IN ({}) ORDER BY id".format(marks),
            receiving_ids,
        ).fetchall()
        operation_items = sqlite_con.execute(
            "SELECT receiving_id,item_id FROM receiving_operation_items WHERE receiving_id IN ({}) ORDER BY receiving_id,item_id".format(marks),
            receiving_ids,
        ).fetchall()

    card_columns_sql = ",".join(CARD_COLUMNS)
    item_columns_sql = ",".join(ITEM_COLUMNS)
    receiving_columns_sql = ",".join(RECEIVING_COLUMNS)
    timer_columns_sql = ",".join(TIMER_EVENT_COLUMNS)
    card_marks = ",".join(["%s"] * len(CARD_COLUMNS))
    item_marks = ",".join(["%s"] * len(ITEM_COLUMNS))
    receiving_marks = ",".join(["%s"] * len(RECEIVING_COLUMNS))
    timer_marks = ",".join(["%s"] * len(TIMER_EVENT_COLUMNS))
    card_updates = ", ".join(
        "{}=EXCLUDED.{}".format(c, c)
        for c in ("current_sector", "status", "receiving_type", "purchase_mode", "quality_destination", "updated_at")
    )
    item_updates = ", ".join("{}=EXCLUDED.{}".format(c, c) for c in ITEM_COLUMNS if c not in {"id", "card_id", "source_key"})
    receiving_updates = ", ".join("{}=EXCLUDED.{}".format(c, c) for c in RECEIVING_COLUMNS if c != "id")
    timer_updates = ", ".join("{}=EXCLUDED.{}".format(c, c) for c in TIMER_EVENT_COLUMNS if c != "id")

    card_sql = (
        "INSERT INTO outlog_cards ({}) VALUES ({}) ON CONFLICT (id) DO UPDATE SET {}".format(
            card_columns_sql, card_marks, card_updates
        )
        + " WHERE outlog_cards.purchase_id=EXCLUDED.purchase_id"
    )
    item_insert_sql = (
        "INSERT INTO outlog_items ({}) VALUES ({}) ON CONFLICT (id) DO NOTHING".format(
            item_columns_sql, item_marks
        )
    )
    item_update_sql = (
        "INSERT INTO outlog_items ({}) VALUES ({}) ON CONFLICT (id) DO UPDATE SET {}".format(
            item_columns_sql, item_marks, item_updates
        )
        + " WHERE outlog_items.card_id=EXCLUDED.card_id AND outlog_items.source_key=EXCLUDED.source_key"
    )
    receiving_sql = (
        "INSERT INTO outlog_receivings ({}) VALUES ({}) ON CONFLICT (id) DO UPDATE SET {}".format(
            receiving_columns_sql, receiving_marks, receiving_updates
        )
        + " WHERE outlog_receivings.card_id=EXCLUDED.card_id"
        + " AND outlog_receivings.receiving_type=EXCLUDED.receiving_type"
        + " AND outlog_receivings.created_at=EXCLUDED.created_at"
    )
    timer_sql = (
        "INSERT INTO outlog_timer_events ({}) VALUES ({}) ON CONFLICT (id) DO UPDATE SET {}".format(
            timer_columns_sql, timer_marks, timer_updates
        )
        + " WHERE outlog_timer_events.receiving_id=EXCLUDED.receiving_id"
        + " AND outlog_timer_events.event_type=EXCLUDED.event_type"
        + " AND outlog_timer_events.event_at=EXCLUDED.event_at"
        + " AND outlog_timer_events.user_id=EXCLUDED.user_id"
    )

    with pg_connect() as con:
        with con.cursor() as cur:
            cur.execute(card_sql, _card_tuple(card))
            if cur.rowcount != 1:
                raise RuntimeError("Não foi possível sincronizar a identidade do Card {} no Supabase.".format(card_id))

            requested_item_ids = {int(item_id) for item_id in (sync_item_ids or [])}
            available_item_ids = {int(item["id"]) for item in items}
            if not requested_item_ids.issubset(available_item_ids):
                missing_ids = sorted(requested_item_ids - available_item_ids)
                raise RuntimeError(
                    "Não foi possível atualizar item(ns) inexistente(s) {} do Card {}.".format(missing_ids, card_id)
                )
            for item in items:
                if int(item["id"]) in requested_item_ids:
                    cur.execute(item_update_sql, _item_tuple(item))
                    if cur.rowcount != 1:
                        raise RuntimeError(
                            "Conflito de identidade ao atualizar item {} do Card {} no Supabase.".format(item["id"], card_id)
                        )
                else:
                    cur.execute(item_insert_sql, _item_tuple(item))
                    if cur.rowcount == 0:
                        cur.execute(
                            "SELECT card_id,source_key FROM outlog_items WHERE id=%s",
                            (int(item["id"]),),
                        )
                        remote_item = cur.fetchone()
                        if (
                            not remote_item
                            or int(remote_item["card_id"]) != int(card_id)
                            or remote_item["source_key"] != item["source_key"]
                        ):
                            raise RuntimeError(
                                "Conflito de identidade ao preservar item {} do Card {} no Supabase.".format(item["id"], card_id)
                            )

            for receiving in receivings:
                cur.execute(receiving_sql, _receiving_tuple(receiving))
                if cur.rowcount != 1:
                    raise RuntimeError(
                        "Conflito de identidade no registro de Recebimento {} do Card {}.".format(receiving["id"], card_id)
                    )

            links_by_receiving: dict[int, list[int]] = {}
            for link in operation_items:
                links_by_receiving.setdefault(int(link["receiving_id"]), []).append(int(link["item_id"]))
            for receiving_id in receiving_ids:
                cur.execute(
                    "DELETE FROM outlog_receiving_operation_items WHERE receiving_id=%s",
                    (receiving_id,),
                )
                linked_items = links_by_receiving.get(receiving_id, [])
                if linked_items:
                    cur.executemany(
                        """INSERT INTO outlog_receiving_operation_items(receiving_id,item_id)
                           VALUES(%s,%s) ON CONFLICT(receiving_id,item_id) DO NOTHING""",
                        [(receiving_id, item_id) for item_id in linked_items],
                    )

            for event in events:
                cur.execute(timer_sql, _timer_event_tuple(event))
                if cur.rowcount != 1:
                    raise RuntimeError(
                        "Conflito de identidade no evento de cronômetro {} do Recebimento {}.".format(
                            event["id"], event["receiving_id"]
                        )
                    )
        con.commit()

    return {
        "card_id": int(card_id),
        "receivings": len(receivings),
        "timer_events": len(events),
    }


def sync_all_receiving_state_to_supabase(sqlite_con) -> None:
    if not os.getenv("SUPABASE_DATABASE_URL"):
        return
    """Persiste os controles de Recebimento e os eventos dos cronômetros."""
    receivings = sqlite_con.execute("SELECT * FROM receivings ORDER BY id").fetchall()
    timer_events = sqlite_con.execute("SELECT * FROM timer_events ORDER BY id").fetchall()
    receiving_ids = [int(row["id"]) for row in receivings]
    operation_items = []
    if receiving_ids:
        marks = ",".join("?" for _ in receiving_ids)
        operation_items = sqlite_con.execute(
            "SELECT receiving_id,item_id FROM receiving_operation_items WHERE receiving_id IN ({}) ORDER BY receiving_id,item_id".format(marks),
            receiving_ids,
        ).fetchall()

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
        " WHERE outlog_receivings.card_id=EXCLUDED.card_id"
        " AND outlog_receivings.receiving_type=EXCLUDED.receiving_type"
        " AND outlog_receivings.created_at=EXCLUDED.created_at"
    )
    timer_sql = (
        f"INSERT INTO outlog_timer_events ({timer_columns_sql}) VALUES ({timer_marks})"
        f" ON CONFLICT (id) DO UPDATE SET {timer_updates}"
        " WHERE outlog_timer_events.receiving_id=EXCLUDED.receiving_id"
        " AND outlog_timer_events.event_type=EXCLUDED.event_type"
        " AND outlog_timer_events.event_at=EXCLUDED.event_at"
        " AND outlog_timer_events.user_id=EXCLUDED.user_id"
    )

    with pg_connect() as con:
        with con.cursor() as cur:
            if receivings:
                for receiving in receivings:
                    cur.execute(receiving_sql, _receiving_tuple(receiving))
                    if cur.rowcount != 1:
                        raise RuntimeError(
                            "Conflito de identidade ao sincronizar o registro de Recebimento {} do Card {}.".format(
                                receiving["id"], receiving["card_id"]
                            )
                        )
                for receiving_id in receiving_ids:
                    cur.execute(
                        "DELETE FROM outlog_receiving_operation_items WHERE receiving_id=%s",
                        (receiving_id,),
                    )
            if operation_items:
                cur.executemany(
                    """INSERT INTO outlog_receiving_operation_items(receiving_id,item_id)
                       VALUES(%s,%s) ON CONFLICT(receiving_id,item_id) DO NOTHING""",
                    [(int(row["receiving_id"]), int(row["item_id"])) for row in operation_items],
                )
            if timer_events:
                for event in timer_events:
                    cur.execute(timer_sql, _timer_event_tuple(event))
                    if cur.rowcount != 1:
                        raise RuntimeError(
                            "Conflito de identidade no evento de cronômetro {} do Recebimento {}.".format(
                                event["id"], event["receiving_id"]
                            )
                        )
        con.commit()


def restore_receiving_state_from_supabase(
    sqlite_con, card_id: int | None = None, receiving_type: str | None = None
) -> int:
    """Restore receiving state by stable identity while preserving local records on ID collisions.

    When a specific Card is supplied, fetch only its receiving rows and timer events.
    This supports on-demand recovery without loading the complete operational history.
    """
    if not os.getenv("SUPABASE_DATABASE_URL"):
        return 0
    with pg_connect() as con:
        with con.cursor() as cur:
            if card_id is None:
                cur.execute("SELECT * FROM outlog_receivings ORDER BY id")
                remote_receivings = cur.fetchall()
                cur.execute("SELECT * FROM outlog_timer_events ORDER BY id")
                remote_events = cur.fetchall()
            else:
                query = "SELECT * FROM outlog_receivings WHERE card_id=%s"
                params: tuple = (int(card_id),)
                if receiving_type is not None:
                    query += " AND receiving_type=%s"
                    params += (receiving_type,)
                cur.execute(query + " ORDER BY id", params)
                remote_receivings = cur.fetchall()
                receiving_ids = [int(row["id"]) for row in remote_receivings]
                if receiving_ids:
                    cur.execute(
                        "SELECT * FROM outlog_timer_events WHERE receiving_id = ANY(%s) ORDER BY id",
                        (receiving_ids,),
                    )
                    remote_events = cur.fetchall()
                else:
                    remote_events = []
            remote_receiving_ids_for_links = [int(row["id"]) for row in remote_receivings]
            if remote_receiving_ids_for_links:
                cur.execute(
                    """SELECT receiving_id,item_id FROM outlog_receiving_operation_items
                       WHERE receiving_id = ANY(%s) ORDER BY receiving_id,item_id""",
                    (remote_receiving_ids_for_links,),
                )
                remote_operation_items = cur.fetchall()
            else:
                remote_operation_items = []

            card_state_sql = """SELECT id,current_sector,status,receiving_type,purchase_mode,
                                       quality_destination,updated_at FROM outlog_cards"""
            card_state_params = None
            if card_id is not None:
                card_state_sql += " WHERE id=%s"
                card_state_params = (int(card_id),)
            cur.execute(card_state_sql, card_state_params)
            remote_card_states = cur.fetchall()

    local_card_ids = {
        int(row["id"]) for row in sqlite_con.execute("SELECT id FROM cards").fetchall()
    }
    for remote_card in remote_card_states:
        local_card_id = int(remote_card["id"])
        if local_card_id not in local_card_ids:
            continue
        sqlite_con.execute(
            """UPDATE cards SET current_sector=?,status=?,receiving_type=?,purchase_mode=?,
               quality_destination=?,updated_at=? WHERE id=?""",
            (
                remote_card["current_sector"], remote_card["status"], remote_card["receiving_type"],
                remote_card["purchase_mode"], remote_card["quality_destination"],
                remote_card["updated_at"], local_card_id,
            ),
        )
    tables = {
        row["name"]
        for row in sqlite_con.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    }
    has_timer_events = "timer_events" in tables
    has_receiving_items = "receiving_operation_items" in tables
    has_quality_inspections = "quality_inspections" in tables and "source_receiving_id" in {
        row["name"] for row in sqlite_con.execute("PRAGMA table_info(quality_inspections)").fetchall()
    }

    receiving_columns = ",".join(RECEIVING_COLUMNS)
    receiving_marks = ",".join(["?"] * len(RECEIVING_COLUMNS))
    timer_columns = ",".join(TIMER_EVENT_COLUMNS)
    timer_marks = ",".join(["?"] * len(TIMER_EVENT_COLUMNS))
    remote_receiving_ids = {int(row["id"]) for row in remote_receivings}
    remote_timer_ids = {int(row["id"]) for row in remote_events}
    local_receiving_max = int(sqlite_con.execute("SELECT COALESCE(MAX(id),0) FROM receivings").fetchone()[0] or 0)
    local_timer_max = (
        int(sqlite_con.execute("SELECT COALESCE(MAX(id),0) FROM timer_events").fetchone()[0] or 0)
        if has_timer_events else 0
    )
    next_receiving_id = max(local_receiving_max, max(remote_receiving_ids, default=0)) + 1
    next_timer_id = max(local_timer_max, max(remote_timer_ids, default=0)) + 1
    restored_count = 0
    remote_to_local_receiving_id = {}

    def rekey_local_receiving(old_id: int, new_id: int) -> None:
        local_row = sqlite_con.execute("SELECT * FROM receivings WHERE id=?", (old_id,)).fetchone()
        if not local_row:
            return
        values = list(_receiving_tuple(local_row))
        values[0] = new_id
        sqlite_con.execute(
            "INSERT INTO receivings ({}) VALUES ({})".format(receiving_columns, receiving_marks),
            tuple(values),
        )
        if has_timer_events:
            sqlite_con.execute("UPDATE timer_events SET receiving_id=? WHERE receiving_id=?", (new_id, old_id))
        if has_receiving_items:
            sqlite_con.execute(
                "UPDATE receiving_operation_items SET receiving_id=? WHERE receiving_id=?",
                (new_id, old_id),
            )
        if has_quality_inspections:
            sqlite_con.execute(
                "UPDATE quality_inspections SET source_receiving_id=? WHERE source_receiving_id=?",
                (new_id, old_id),
            )
        sqlite_con.execute("DELETE FROM receivings WHERE id=?", (old_id,))

    def rekey_local_timer_event(old_id: int, new_id: int) -> None:
        local_event = sqlite_con.execute("SELECT * FROM timer_events WHERE id=?", (old_id,)).fetchone()
        if not local_event:
            return
        values = list(_timer_event_tuple(local_event))
        values[0] = new_id
        sqlite_con.execute(
            "INSERT INTO timer_events ({}) VALUES ({})".format(timer_columns, timer_marks),
            tuple(values),
        )
        sqlite_con.execute("DELETE FROM timer_events WHERE id=?", (old_id,))

    for row in remote_receivings:
        remote_id = int(row["id"])
        card_id = int(row["card_id"])
        if card_id not in local_card_ids:
            continue

        local_by_id = sqlite_con.execute(
            "SELECT * FROM receivings WHERE id=?", (remote_id,)
        ).fetchone()
        if local_by_id:
            same_identity = (
                int(local_by_id["card_id"]) == card_id
                and local_by_id["receiving_type"] == row["receiving_type"]
                and local_by_id["created_at"] == row["created_at"]
            )
            if not same_identity:
                # Move the unrelated local record out of the remote ID's way, keeping its children linked.
                rekey_local_receiving(remote_id, next_receiving_id)
                next_receiving_id += 1
                local_by_id = None

        if local_by_id:
            local_id = remote_id
        else:
            local_by_identity = sqlite_con.execute(
                """SELECT * FROM receivings
                   WHERE card_id=? AND receiving_type=? AND created_at=?
                   ORDER BY id DESC LIMIT 1""",
                (card_id, row["receiving_type"], row["created_at"]),
            ).fetchone()
            if local_by_identity:
                old_local_id = int(local_by_identity["id"])
                if old_local_id != remote_id:
                    # Remote IDs are canonical; move the matching local record to that ID.
                    rekey_local_receiving(old_local_id, remote_id)
                local_id = remote_id
            else:
                sqlite_con.execute(
                    "INSERT INTO receivings ({}) VALUES ({})".format(receiving_columns, receiving_marks),
                    _receiving_tuple(row),
                )
                local_id = remote_id
                restored_count += 1

        # Supabase is the source of truth: refresh the local operational copy from the
        # persisted row so a stale SQLite state cannot roll a completed step backwards.
        local_before = sqlite_con.execute(
            "SELECT * FROM receivings WHERE id=?", (local_id,)
        ).fetchone()
        update_columns = [column for column in RECEIVING_COLUMNS if column != "id"]
        if local_before and any(local_before[column] != row[column] for column in RECEIVING_COLUMNS):
            sqlite_con.execute(
                "UPDATE receivings SET {} WHERE id=?".format(
                    ",".join("{}=?".format(column) for column in update_columns)
                ),
                tuple(row[column] for column in update_columns) + (local_id,),
            )
            restored_count += 1
        remote_to_local_receiving_id[remote_id] = local_id

    if has_receiving_items and remote_operation_items:
        links_by_receiving: dict[int, list[int]] = {}
        for link in remote_operation_items:
            links_by_receiving.setdefault(int(link["receiving_id"]), []).append(int(link["item_id"]))
        # Replace the local links only for operations whose authoritative remote link set exists.
        for remote_id, item_ids in links_by_receiving.items():
            local_id = remote_to_local_receiving_id.get(remote_id)
            if local_id is None:
                continue
            sqlite_con.execute("DELETE FROM receiving_operation_items WHERE receiving_id=?", (local_id,))
            for item_id in item_ids:
                local_item = sqlite_con.execute(
                    "SELECT 1 FROM items WHERE id=?", (item_id,)
                ).fetchone()
                if local_item:
                    sqlite_con.execute(
                        "INSERT OR IGNORE INTO receiving_operation_items(receiving_id,item_id) VALUES(?,?)",
                        (local_id, item_id),
                    )

    for row in remote_events:
        remote_receiving_id = int(row["receiving_id"])
        local_receiving_id = remote_to_local_receiving_id.get(remote_receiving_id)
        if local_receiving_id is None:
            # Don't attach a remote event to an unrelated local receiving with a colliding numeric ID.
            continue

        local_event = sqlite_con.execute(
            "SELECT * FROM timer_events WHERE id=?", (row["id"],)
        ).fetchone()
        if local_event:
            same_event = (
                int(local_event["receiving_id"]) == local_receiving_id
                and local_event["event_type"] == row["event_type"]
                and local_event["event_at"] == row["event_at"]
                and int(local_event["user_id"]) == int(row["user_id"])
            )
            if same_event:
                continue
            # Keep the unrelated local event and free the remote primary key.
            rekey_local_timer_event(int(row["id"]), next_timer_id)
            next_timer_id += 1

        local_event_by_identity = sqlite_con.execute(
            """SELECT id FROM timer_events
               WHERE receiving_id=? AND event_type=? AND event_at=? AND user_id=?
               ORDER BY id LIMIT 1""",
            (local_receiving_id, row["event_type"], row["event_at"], row["user_id"]),
        ).fetchone()
        if local_event_by_identity:
            matching_local_id = int(local_event_by_identity["id"])
            if matching_local_id != int(row["id"]):
                # A matching event under a different local ID is the same event, not a second timer event.
                rekey_local_timer_event(matching_local_id, int(row["id"]))
            continue

        values = (
            int(row["id"]),
            local_receiving_id,
            row["event_type"],
            row["event_at"],
            row["user_id"],
        )
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
    receiving_ids = [
        int(row["id"])
        for row in sqlite_con.execute("SELECT id FROM receivings WHERE card_id=? ORDER BY id", (card_id,)).fetchall()
    ]
    operation_items = []
    if receiving_ids:
        marks = ",".join("?" for _ in receiving_ids)
        operation_items = sqlite_con.execute(
            "SELECT receiving_id,item_id FROM receiving_operation_items WHERE receiving_id IN ({}) ORDER BY receiving_id,item_id".format(marks),
            receiving_ids,
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
            if receiving_ids:
                cur.execute(
                    "DELETE FROM outlog_receiving_operation_items WHERE receiving_id = ANY(%s)",
                    (receiving_ids,),
                )
            if operation_items:
                cur.executemany(
                    """INSERT INTO outlog_receiving_operation_items(receiving_id,item_id)
                       VALUES(%s,%s) ON CONFLICT(receiving_id,item_id) DO NOTHING""",
                    [(int(row["receiving_id"]), int(row["item_id"])) for row in operation_items],
                )
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



def restore_card_state_for_quality(sqlite_con) -> dict[int, dict]:
    """Refresh local Card routing fields from Supabase before a Quality operation."""
    if not os.getenv("SUPABASE_DATABASE_URL"):
        raise RuntimeError("SUPABASE_DATABASE_URL não está configurada.")

    with pg_connect() as con:
        with con.cursor() as cur:
            cur.execute(
                """SELECT id,purchase_id,current_sector,status,receiving_type,purchase_mode,
                          quality_destination,updated_at
                   FROM outlog_cards ORDER BY id"""
            )
            remote_rows = cur.fetchall()

    local_ids = {
        int(row["id"]): str(row["purchase_id"])
        for row in sqlite_con.execute("SELECT id,purchase_id FROM cards").fetchall()
    }
    snapshot: dict[int, dict] = {}
    for row in remote_rows:
        card_id = int(row["id"])
        if local_ids.get(card_id) != str(row["purchase_id"]):
            continue
        state = {key: row[key] for key in (
            "id","purchase_id","current_sector","status","receiving_type",
            "purchase_mode","quality_destination","updated_at"
        )}
        sqlite_con.execute(
            """UPDATE cards SET current_sector=?,status=?,receiving_type=?,purchase_mode=?,
               quality_destination=?,updated_at=? WHERE id=? AND purchase_id=?""",
            (
                state["current_sector"], state["status"], state["receiving_type"],
                state["purchase_mode"], state["quality_destination"], state["updated_at"],
                card_id, state["purchase_id"],
            ),
        )
        snapshot[card_id] = state
    return snapshot


def store_quality_files(files: list[dict]) -> list[str]:
    """Persist all Quality evidence uploads atomically in Supabase."""
    if not files:
        return []
    with pg_connect() as con:
        with con.cursor() as cur:
            for uploaded in files:
                cur.execute(
                    """INSERT INTO outlog_quality_files(
                           id,original_name,content_type,content,uploaded_by,created_at
                       ) VALUES(%s,%s,%s,%s,%s,%s)""",
                    (
                        uploaded["id"], uploaded["original_name"], uploaded["content_type"],
                        uploaded["content"], int(uploaded["uploaded_by"]), uploaded["created_at"],
                    ),
                )
        con.commit()
    return ["/api/quality/files/{}".format(uploaded["id"]) for uploaded in files]


def get_quality_file(file_id: str) -> dict | None:
    """Read durable Quality evidence by its unguessable identifier."""
    with pg_connect() as con:
        with con.cursor() as cur:
            cur.execute(
                """SELECT original_name,content_type,content
                   FROM outlog_quality_files WHERE id=%s""",
                (file_id,),
            )
            row = cur.fetchone()
    return dict(row) if row else None


# Persistência da Qualidade: Supabase é a fonte de verdade; SQLite é apenas cache
# de compatibilidade para as consultas e transações legadas do módulo.
QUALITY_PERSISTENCE_TABLES = {
    "quality_inspections": {
        "remote": "outlog_quality_inspections",
        "columns": [
            "id", "card_id", "inspection_type", "status", "destination", "sample_source",
            "source_receiving_id", "purchase_mode", "sample_target_total", "development_required",
            "development_separated", "development_pending", "source_subset", "send_to_costura",
            "created_by", "completed_by", "created_at", "completed_at",
        ],
        "pk": ["id"],
    },
    "quality_sample_items": {
        "remote": "outlog_quality_sample_items",
        "columns": ["id", "inspection_id", "item_id", "sample_qty", "sample_scope"],
        "pk": ["id"],
    },
    "quality_inspection_items": {
        "remote": "outlog_quality_inspection_items",
        "columns": ["inspection_id", "item_id"],
        "pk": ["inspection_id", "item_id"],
    },
    "quality_item_routes": {
        "remote": "outlog_quality_item_routes",
        "columns": ["inspection_id", "item_id", "destination"],
        "pk": ["inspection_id", "item_id"],
    },
    "quality_workers": {
        "remote": "outlog_quality_workers",
        "columns": ["id", "inspection_id", "inspector_id", "status", "created_at", "completed_at"],
        "pk": ["id"],
    },
    "quality_worker_timer_events": {
        "remote": "outlog_quality_worker_timer_events",
        "columns": ["id", "worker_id", "event_type", "event_at", "user_id"],
        "pk": ["id"],
    },
    "quality_assignments": {
        "remote": "outlog_quality_assignments",
        "columns": [
            "id", "worker_id", "sample_item_id", "assigned_qty", "inspected_qty", "approved_qty",
            "rejected_qty", "rework_qty", "reject_reason", "rework_reason", "observation",
            "photo_paths", "result_status", "assigned_by", "assigned_at",
        ],
        "pk": ["id"],
    },
    "quality_audit_events": {
        "remote": "outlog_quality_history",
        "columns": ["id", "card_id", "user_id", "event_type", "description", "created_at"],
        "pk": ["id"],
    },
}
QUALITY_DELETE_ORDER = [
    "quality_audit_events",
    "quality_assignments",
    "quality_worker_timer_events",
    "quality_item_routes",
    "quality_inspection_items",
    "quality_workers",
    "quality_sample_items",
    "quality_inspections",
]
QUALITY_INSERT_ORDER = [
    "quality_inspections",
    "quality_sample_items",
    "quality_inspection_items",
    "quality_item_routes",
    "quality_workers",
    "quality_worker_timer_events",
    "quality_assignments",
    "quality_audit_events",
]


def init_quality_persistence() -> None:
    """Cria o armazenamento remoto da Qualidade sem apagar registros existentes."""
    ddl = [
        """CREATE TABLE IF NOT EXISTS outlog_quality_inspections (
            id BIGINT PRIMARY KEY, card_id BIGINT NOT NULL, inspection_type INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'ABERTA', destination TEXT, sample_source TEXT NOT NULL,
            source_receiving_id BIGINT, purchase_mode TEXT NOT NULL DEFAULT 'GRADE',
            sample_target_total BIGINT NOT NULL DEFAULT 0, development_required SMALLINT,
            development_separated SMALLINT, development_pending SMALLINT NOT NULL DEFAULT 0,
            source_subset SMALLINT NOT NULL DEFAULT 0, send_to_costura SMALLINT,
            created_by BIGINT NOT NULL, completed_by BIGINT, created_at TEXT NOT NULL,
            completed_at TEXT
        )""",
        """CREATE TABLE IF NOT EXISTS outlog_quality_sample_items (
            id BIGINT PRIMARY KEY, inspection_id BIGINT NOT NULL
                REFERENCES outlog_quality_inspections(id) ON DELETE CASCADE,
            item_id BIGINT NOT NULL, sample_qty BIGINT NOT NULL DEFAULT 0,
            sample_scope TEXT NOT NULL DEFAULT 'ITEM', UNIQUE(inspection_id, item_id)
        )""",
        """CREATE TABLE IF NOT EXISTS outlog_quality_inspection_items (
            inspection_id BIGINT NOT NULL
                REFERENCES outlog_quality_inspections(id) ON DELETE CASCADE,
            item_id BIGINT NOT NULL, PRIMARY KEY(inspection_id, item_id)
        )""",
        """CREATE TABLE IF NOT EXISTS outlog_quality_item_routes (
            inspection_id BIGINT NOT NULL
                REFERENCES outlog_quality_inspections(id) ON DELETE CASCADE,
            item_id BIGINT NOT NULL, destination TEXT, PRIMARY KEY(inspection_id, item_id)
        )""",
        """CREATE TABLE IF NOT EXISTS outlog_quality_workers (
            id BIGINT PRIMARY KEY,
            inspection_id BIGINT NOT NULL
                REFERENCES outlog_quality_inspections(id) ON DELETE CASCADE,
            inspector_id BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'NAO_INICIADA',
            created_at TEXT NOT NULL, completed_at TEXT, UNIQUE(inspection_id, inspector_id)
        )""",
        """CREATE TABLE IF NOT EXISTS outlog_quality_worker_timer_events (
            id BIGINT PRIMARY KEY,
            worker_id BIGINT NOT NULL
                REFERENCES outlog_quality_workers(id) ON DELETE CASCADE,
            event_type TEXT NOT NULL, event_at TEXT NOT NULL, user_id BIGINT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS outlog_quality_assignments (
            id BIGINT PRIMARY KEY,
            worker_id BIGINT NOT NULL
                REFERENCES outlog_quality_workers(id) ON DELETE CASCADE,
            sample_item_id BIGINT NOT NULL
                REFERENCES outlog_quality_sample_items(id) ON DELETE CASCADE,
            assigned_qty BIGINT NOT NULL, inspected_qty BIGINT NOT NULL DEFAULT 0,
            approved_qty BIGINT NOT NULL DEFAULT 0, rejected_qty BIGINT NOT NULL DEFAULT 0,
            rework_qty BIGINT NOT NULL DEFAULT 0, reject_reason TEXT, rework_reason TEXT,
            observation TEXT, photo_paths TEXT, result_status TEXT NOT NULL DEFAULT 'PENDENTE',
            assigned_by BIGINT NOT NULL, assigned_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS outlog_quality_history (
            id BIGINT PRIMARY KEY, card_id BIGINT NOT NULL, user_id BIGINT,
            event_type TEXT NOT NULL, description TEXT NOT NULL, created_at TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS outlog_quality_files (
            id TEXT PRIMARY KEY,
            original_name TEXT NOT NULL,
            content_type TEXT NOT NULL,
            content BYTEA NOT NULL,
            uploaded_by BIGINT NOT NULL,
            created_at TEXT NOT NULL
        )""",
        "CREATE INDEX IF NOT EXISTS idx_outlog_quality_inspections_card ON outlog_quality_inspections(card_id, id DESC)",
        "CREATE INDEX IF NOT EXISTS idx_outlog_quality_workers_inspection ON outlog_quality_workers(inspection_id)",
        "CREATE INDEX IF NOT EXISTS idx_outlog_quality_assignments_worker ON outlog_quality_assignments(worker_id)",
        "CREATE INDEX IF NOT EXISTS idx_outlog_quality_sample_items_inspection ON outlog_quality_sample_items(inspection_id)",
    ]
    with pg_connect() as con:
        with con.cursor() as cur:
            for statement in ddl:
                cur.execute(statement)
        con.commit()


def _read_quality_snapshot() -> dict[str, list[dict]]:
    snapshot: dict[str, list[dict]] = {}
    with pg_connect() as con:
        with con.cursor() as cur:
            for local_table in QUALITY_INSERT_ORDER:
                spec = QUALITY_PERSISTENCE_TABLES[local_table]
                order_by = ", ".join(spec["pk"])
                cur.execute("SELECT * FROM {} ORDER BY {}".format(spec["remote"], order_by))
                snapshot[local_table] = [dict(row) for row in cur.fetchall()]
    return snapshot


def _local_quality_snapshot(sqlite_con) -> dict[str, list[dict]]:
    result: dict[str, list[dict]] = {}
    for local_table in QUALITY_INSERT_ORDER:
        spec = QUALITY_PERSISTENCE_TABLES[local_table]
        result[local_table] = [
            {column: row[column] for column in spec["columns"]}
            for row in sqlite_con.execute("SELECT * FROM {}".format(local_table)).fetchall()
        ]
    return result


def _quality_key(row: dict, key_columns: list[str]) -> tuple:
    return tuple(row.get(column) for column in key_columns)


def _quality_row_equal(left: dict | None, right: dict | None, columns: list[str]) -> bool:
    if left is None or right is None:
        return left is right
    return all(left.get(column) == right.get(column) for column in columns)


def _quality_snapshot_empty(snapshot: dict[str, list[dict]]) -> bool:
    return not any(snapshot.get(table) for table in QUALITY_PERSISTENCE_TABLES)


def restore_quality_state_from_supabase(sqlite_con) -> dict[str, list[dict]]:
    """Refresh the local compatibility cache from Supabase and return its conflict snapshot."""
    snapshot = _read_quality_snapshot()
    sqlite_con.execute("PRAGMA foreign_keys=OFF")
    try:
        for local_table in QUALITY_DELETE_ORDER:
            sqlite_con.execute("DELETE FROM {}".format(local_table))
        for local_table in QUALITY_INSERT_ORDER:
            spec = QUALITY_PERSISTENCE_TABLES[local_table]
            columns = spec["columns"]
            marks = ",".join(["?"] * len(columns))
            statement = "INSERT INTO {} ({}) VALUES ({})".format(
                local_table, ",".join(columns), marks
            )
            for row in snapshot.get(local_table, []):
                sqlite_con.execute(statement, tuple(row.get(column) for column in columns))
        # Reconstitui o histórico visível do Card a partir dos eventos auditados da Qualidade.
        local_tables = {
            row["name"] for row in sqlite_con.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        if "history" in local_tables:
            for event in snapshot.get("quality_audit_events", []):
                values = (
                    event.get("card_id"), event.get("user_id"), event.get("event_type"),
                    event.get("description"), event.get("created_at"),
                )
                already_present = sqlite_con.execute(
                    """SELECT 1 FROM history WHERE card_id=? AND event_type=?
                       AND description=? AND created_at=?
                       AND COALESCE(user_id,-1)=COALESCE(?,-1) LIMIT 1""",
                    (values[0], values[2], values[3], values[4], values[1]),
                ).fetchone()
                if already_present:
                    continue
                id_in_use = sqlite_con.execute(
                    "SELECT 1 FROM history WHERE id=?", (event.get("id"),)
                ).fetchone()
                if id_in_use:
                    sqlite_con.execute(
                        """INSERT INTO history(card_id,user_id,event_type,description,created_at)
                           VALUES(?,?,?,?,?)""",
                        values,
                    )
                else:
                    sqlite_con.execute(
                        """INSERT INTO history(id,card_id,user_id,event_type,description,created_at)
                           VALUES(?,?,?,?,?,?)""",
                        (event.get("id"), *values),
                    )
        # End the restore transaction before re-enabling SQLite foreign-key checks.
        sqlite_con.commit()
    except Exception:
        sqlite_con.rollback()
        raise
    finally:
        sqlite_con.execute("PRAGMA foreign_keys=ON")
    return snapshot


def bootstrap_quality_state(sqlite_con) -> dict[str, list[dict]]:
    """Migrate legacy local rows once when Supabase has no Quality data, then restore it."""
    init_quality_persistence()
    snapshot = _read_quality_snapshot()
    legacy = _local_quality_snapshot(sqlite_con)
    if _quality_snapshot_empty(snapshot):
        if any(legacy.get(table) for table in QUALITY_PERSISTENCE_TABLES):
            sync_quality_state_to_supabase(sqlite_con, snapshot, None)
            snapshot = _read_quality_snapshot()
    elif not snapshot.get("quality_audit_events") and legacy.get("quality_audit_events"):
        # Older deployments may already have inspections in Supabase but only local history.
        spec = QUALITY_PERSISTENCE_TABLES["quality_audit_events"]
        columns = spec["columns"]
        marks = ",".join(["%s"] * len(columns))
        with pg_connect() as con:
            with con.cursor() as cur:
                for event in legacy["quality_audit_events"]:
                    cur.execute(
                        "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT (id) DO NOTHING".format(
                            spec["remote"], ",".join(columns), marks
                        ),
                        tuple(event.get(column) for column in columns),
                    )
            con.commit()
        snapshot = _read_quality_snapshot()
    return restore_quality_state_from_supabase(sqlite_con)


def sync_quality_state_to_supabase(
    sqlite_con,
    previous_snapshot: dict[str, list[dict]] | None,
    previous_card_snapshot: dict[int, dict] | None = None,
) -> dict[str, list[dict]]:
    """Write changed Quality rows and routing changes atomically, with stale-state checks."""
    previous_snapshot = previous_snapshot or {table: [] for table in QUALITY_PERSISTENCE_TABLES}
    current = _local_quality_snapshot(sqlite_con)
    old_by_table = {
        table: {_quality_key(row, QUALITY_PERSISTENCE_TABLES[table]["pk"]): row
                for row in previous_snapshot.get(table, [])}
        for table in QUALITY_PERSISTENCE_TABLES
    }
    current_by_table = {
        table: {_quality_key(row, QUALITY_PERSISTENCE_TABLES[table]["pk"]): row
                for row in current.get(table, [])}
        for table in QUALITY_PERSISTENCE_TABLES
    }

    with pg_connect() as con:
        with con.cursor() as cur:
            # Serialize cross-instance writes. The per-row checks below detect stale snapshots.
            cur.execute("SELECT pg_advisory_xact_lock(%s)", (742119885,))
            for local_table in QUALITY_DELETE_ORDER:
                spec = QUALITY_PERSISTENCE_TABLES[local_table]
                remote = spec["remote"]
                columns = spec["columns"]
                keys = spec["pk"]
                for key, old_row in old_by_table[local_table].items():
                    if key in current_by_table[local_table]:
                        continue
                    key_where = " AND ".join("{}=%s".format(column) for column in keys)
                    compare_old = " AND ".join("{} IS NOT DISTINCT FROM %s".format(column) for column in columns)
                    params = (*key, *(old_row.get(column) for column in columns))
                    cur.execute(
                        "DELETE FROM {} WHERE {} AND {}".format(remote, key_where, compare_old),
                        params,
                    )
                    if cur.rowcount == 0:
                        cur.execute(
                            "SELECT * FROM {} WHERE {}".format(remote, key_where), key
                        )
                        live = cur.fetchone()
                        if live is not None and not _quality_row_equal(dict(live), old_row, columns):
                            raise RuntimeError(
                                "A Qualidade foi alterada por outra sessão. Atualize a tela e tente novamente."
                            )

            for local_table in QUALITY_INSERT_ORDER:
                spec = QUALITY_PERSISTENCE_TABLES[local_table]
                remote = spec["remote"]
                columns = spec["columns"]
                keys = spec["pk"]
                key_where = " AND ".join("{}=%s".format(column) for column in keys)
                updates = [column for column in columns if column not in keys]
                marks = ",".join(["%s"] * len(columns))
                key_sql = ",".join(keys)
                insert_sql = "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT ({}) DO NOTHING".format(
                    remote, ",".join(columns), marks, key_sql
                )
                for key, row in current_by_table[local_table].items():
                    old_row = old_by_table[local_table].get(key)
                    if old_row is not None and _quality_row_equal(old_row, row, columns):
                        continue
                    if old_row is None:
                        cur.execute(insert_sql, tuple(row.get(column) for column in columns))
                        if cur.rowcount == 0:
                            cur.execute(
                                "SELECT * FROM {} WHERE {}".format(remote, key_where), key
                            )
                            live = cur.fetchone()
                            if live is None or not _quality_row_equal(dict(live), row, columns):
                                raise RuntimeError(
                                    "Conflito de identificação ao salvar Qualidade no Supabase; nenhum dado local foi confirmado."
                                )
                        continue

                    if not updates:
                        continue
                    set_sql = ", ".join("{}=%s".format(column) for column in updates)
                    compare_old = " AND ".join("{} IS NOT DISTINCT FROM %s".format(column) for column in columns)
                    params = (
                        *(row.get(column) for column in updates),
                        *key,
                        *(old_row.get(column) for column in columns),
                    )
                    cur.execute(
                        "UPDATE {} SET {} WHERE {} AND {}".format(remote, set_sql, key_where, compare_old),
                        params,
                    )
                    if cur.rowcount == 0:
                        cur.execute(
                            "SELECT * FROM {} WHERE {}".format(remote, key_where), key
                        )
                        live = cur.fetchone()
                        if live is None or not _quality_row_equal(dict(live), row, columns):
                            raise RuntimeError(
                                "A Qualidade foi alterada por outra sessão. Atualize a tela e tente novamente."
                            )
        # Descobre os Cards afetados pelos registros de Qualidade alterados nesta transação.
        touched_inspection_ids = set()
        touched_card_ids = set()
        changed_worker_ids = set()
        completed_subset_ids = set()
        for local_table in QUALITY_INSERT_ORDER:
            spec = QUALITY_PERSISTENCE_TABLES[local_table]
            columns = spec["columns"]
            all_keys = set(old_by_table[local_table]) | set(current_by_table[local_table])
            for row_key in all_keys:
                old_row = old_by_table[local_table].get(row_key)
                new_row = current_by_table[local_table].get(row_key)
                if _quality_row_equal(old_row, new_row, columns):
                    continue
                row = new_row or old_row
                if local_table == "quality_inspections":
                    inspection_id = int(row["id"])
                    touched_inspection_ids.add(inspection_id)
                    if row.get("card_id") is not None:
                        touched_card_ids.add(int(row["card_id"]))
                    if (
                        new_row is not None and new_row.get("status") == "CONCLUIDA"
                        and (old_row is None or old_row.get("status") != "CONCLUIDA")
                    ):
                        completed_subset_ids.add(inspection_id)
                elif local_table == "quality_audit_events":
                    if row.get("card_id") is not None:
                        touched_card_ids.add(int(row["card_id"]))
                elif local_table in {
                    "quality_sample_items", "quality_inspection_items",
                    "quality_item_routes", "quality_workers",
                }:
                    touched_inspection_ids.add(int(row["inspection_id"]))
                elif local_table in {"quality_worker_timer_events", "quality_assignments"}:
                    changed_worker_ids.add(int(row["worker_id"]))

        worker_to_inspection = {}
        for worker_row in (
            list(old_by_table["quality_workers"].values())
            + list(current_by_table["quality_workers"].values())
        ):
            worker_to_inspection[int(worker_row["id"])] = int(worker_row["inspection_id"])
        for worker_id in changed_worker_ids:
            inspection_id = worker_to_inspection.get(worker_id)
            if inspection_id is not None:
                touched_inspection_ids.add(inspection_id)

        for inspection_id in touched_inspection_ids:
            inspection_key = (inspection_id,)
            row = (
                current_by_table["quality_inspections"].get(inspection_key)
                or old_by_table["quality_inspections"].get(inspection_key)
            )
            if row and row.get("card_id") is not None:
                touched_card_ids.add(int(row["card_id"]))

        # Propaga apenas as referências que uma Inspeção de subset concluiu.
        items_to_sync_by_card = {}
        for inspection_id in completed_subset_ids:
            inspection = current_by_table["quality_inspections"].get((inspection_id,))
            if not inspection or not bool(inspection.get("source_subset")):
                continue
            card_id = int(inspection["card_id"])
            for link in current_by_table["quality_inspection_items"].values():
                if int(link["inspection_id"]) == inspection_id:
                    items_to_sync_by_card.setdefault(card_id, set()).add(int(link["item_id"]))

        # Nunca sobrescreve o estado do Card usando uma cópia local possivelmente velha.
        # Cada conexão de Qualidade carrega previamente o estado remoto e usa compare-and-set.
        if previous_card_snapshot is not None:
            state_columns = (
                "current_sector", "status", "receiving_type",
                "purchase_mode", "quality_destination", "updated_at",
            )
            for card_id in sorted(touched_card_ids):
                card = sqlite_con.execute(
                    "SELECT * FROM cards WHERE id=?", (card_id,)
                ).fetchone()
                if not card:
                    continue
                local_state = {column: card[column] for column in state_columns}
                baseline = previous_card_snapshot.get(card_id)
                if baseline is None:
                    raise RuntimeError(
                        "O Card {} não possui um estado remoto confiável no Supabase; atualize a base do Card antes de salvar a Qualidade.".format(card_id)
                    )
                changed_columns = [
                    column for column in state_columns
                    if local_state[column] != baseline.get(column)
                ]
                if changed_columns:
                    set_sql = ", ".join("{}=%s".format(column) for column in changed_columns)
                    baseline_where = " AND ".join(
                        "{} IS NOT DISTINCT FROM %s".format(column)
                        for column in state_columns
                    )
                    cur.execute(
                        "UPDATE outlog_cards SET {} WHERE id=%s AND purchase_id=%s AND {}".format(
                            set_sql, baseline_where
                        ),
                        (
                            *(local_state[column] for column in changed_columns),
                            card_id, card["purchase_id"],
                            *(baseline.get(column) for column in state_columns),
                        ),
                    )
                    if cur.rowcount == 0:
                        cur.execute(
                            """SELECT purchase_id,current_sector,status,receiving_type,
                                      purchase_mode,quality_destination,updated_at
                               FROM outlog_cards WHERE id=%s""",
                            (card_id,),
                        )
                        live = cur.fetchone()
                        same_state = bool(live) and str(live["purchase_id"]) == str(card["purchase_id"]) and all(
                            live[column] == local_state[column] for column in state_columns
                        )
                        if not same_state:
                            raise RuntimeError(
                                "O estado do Card {} mudou em outra operação durante a Qualidade. Atualize e tente novamente.".format(card_id)
                            )
                if card_id in previous_card_snapshot:
                    previous_card_snapshot[card_id].update(local_state)

            if items_to_sync_by_card:
                item_columns_sql = ",".join(ITEM_COLUMNS)
                item_marks = ",".join(["%s"] * len(ITEM_COLUMNS))
                item_updates = ", ".join(
                    "{}=EXCLUDED.{}".format(column, column)
                    for column in ITEM_COLUMNS if column not in {"id", "card_id", "source_key"}
                )
                item_sql = (
                    "INSERT INTO outlog_items ({}) VALUES ({}) "
                    "ON CONFLICT (id) DO UPDATE SET {}".format(
                        item_columns_sql, item_marks, item_updates
                    )
                    + " WHERE outlog_items.card_id=EXCLUDED.card_id "
                    "AND outlog_items.source_key=EXCLUDED.source_key"
                )
                for card_id, item_ids in items_to_sync_by_card.items():
                    for item_id in sorted(item_ids):
                        item = sqlite_con.execute(
                            "SELECT * FROM items WHERE id=? AND card_id=?", (item_id, card_id)
                        ).fetchone()
                        if not item:
                            raise RuntimeError(
                                "A referência {} da Inspeção concluída não existe mais no Card {}.".format(item_id, card_id)
                            )
                        cur.execute(item_sql, _item_tuple(item))
                        if cur.rowcount != 1:
                            raise RuntimeError(
                                "Não foi possível persistir a referência {} do Card {} no Supabase.".format(item_id, card_id)
                            )

        con.commit()

    return current
