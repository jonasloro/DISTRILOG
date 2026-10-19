"""Conexão com o Supabase (Postgres) e autenticação de usuários.

A lógica de hash de senha (gerar_hash_senha/verificar_senha) é uma cópia
exata do core/usuarios.py do OutLog-Distribox — PBKDF2-HMAC-SHA256 com
salt aleatório, 200 mil iterações, comparação segura contra timing attack.
Não usa bcrypt/passlib de propósito, só o que já vem no Python padrão
(mesma decisão do app original).

Cards, itens, Recebimento, Qualidade etc. agora são lidos e gravados direto no
schema `distrilog` pelo módulo db.py — não há mais cópia local nem sincronização.
Este módulo mantém só a conexão (pg_connect) e o login (tabela usuarios).
"""
from __future__ import annotations

import binascii
import hashlib
import hmac
import os

import psycopg
from psycopg.rows import dict_row


_pg_pool = None


class _PooledPg:
    """Conexão do pool com a mesma interface de psycopg.connect(): serve em `with`
    (commit/rollback ao sair) ou com commit()/close() explícitos."""

    def __init__(self, pool):
        self._pool = pool
        self._raw = pool.getconn()
        self._released = False

    def __getattr__(self, name):
        return getattr(self._raw, name)

    def _release(self) -> None:
        if self._released:
            return
        self._released = True
        try:
            self._raw.rollback()
        except Exception:
            pass
        self._pool.putconn(self._raw)

    def close(self) -> None:
        self._release()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            if exc_type is None:
                self._raw.commit()
            else:
                self._raw.rollback()
        finally:
            self._release()

    def __del__(self):
        try:
            self._release()
        except Exception:
            pass


def pg_connect():
    """Conexão (do pool) com o Postgres do Supabase. Lê a connection string da variável
    de ambiente SUPABASE_DATABASE_URL."""
    global _pg_pool
    url = os.getenv("SUPABASE_DATABASE_URL")
    if not url:
        raise RuntimeError(
            "SUPABASE_DATABASE_URL não está configurada. Defina essa variável de "
            "ambiente com a connection string do Supabase (Settings → Database)."
        )
    if _pg_pool is None:
        from psycopg_pool import ConnectionPool
        import db

        db.ensure_schema(url)
        pool = ConnectionPool(
            url,
            min_size=1,
            max_size=int(os.getenv("PG_POOL_MAX", "8")),
            kwargs={"row_factory": dict_row, "prepare_threshold": None, "connect_timeout": 10},
            timeout=20, max_idle=240, max_lifetime=1800, open=False,
        )
        pool.open(wait=True, timeout=20)
        _pg_pool = pool
    return _PooledPg(_pg_pool)


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
            cur.execute(
                """CREATE TABLE IF NOT EXISTS usuarios (
                       usuario TEXT PRIMARY KEY,
                       senha_hash TEXT NOT NULL,
                       papel TEXT NOT NULL
                   )"""
            )
            for usuario, senha_texto_puro, papel in usuarios_padrao:
                senha_hash = gerar_hash_senha(senha_texto_puro)
                cur.execute(
                    """INSERT INTO usuarios (usuario, senha_hash, papel) VALUES (%s, %s, %s)
                       ON CONFLICT (usuario) DO NOTHING""",
                    (usuario, senha_hash, papel),
                )
        con.commit()
