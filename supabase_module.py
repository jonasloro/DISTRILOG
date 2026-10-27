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
import re

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
    """Conexão exclusiva para autenticação no schema public.

    AUTH_DATABASE_URL permite separar credenciais de autenticação das usadas
    pelas operações. Sem ela, mantém o comportamento anterior para não
    interromper instalações existentes. Nunca exponha essa URL ao navegador.
    """
    global _pg_pool
    url = os.getenv("AUTH_DATABASE_URL") or os.getenv("SUPABASE_DATABASE_URL")
    if not url:
        raise RuntimeError(
            "Configure AUTH_DATABASE_URL ou SUPABASE_DATABASE_URL no servidor."
        )
    if _pg_pool is None:
        from psycopg_pool import ConnectionPool

        pool = ConnectionPool(
            url,
            min_size=1,
            max_size=int(os.getenv("AUTH_PG_POOL_MAX", "4")),
            kwargs={
                "row_factory": dict_row,
                "prepare_threshold": None,
                "connect_timeout": 10,
                "options": "-c search_path=public",
            },
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
                "SELECT usuario, senha_hash, papel, must_change_password, idioma_preferido FROM usuarios WHERE usuario=%s",
                (usuario,),
            )
            linha = cur.fetchone()
    if not linha:
        return None
    if not verificar_senha(senha_texto_puro, linha["senha_hash"]):
        return None
    return {"usuario": linha["usuario"], "papel": linha["papel"], "must_change_password": bool(linha["must_change_password"]), "language": linha["idioma_preferido"]}


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
                       papel TEXT NOT NULL,
                       must_change_password BOOLEAN NOT NULL DEFAULT TRUE
                   )"""
            )
            cur.execute("ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT TRUE")
            cur.execute("ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS idioma_preferido TEXT NOT NULL DEFAULT 'pt-BR'")
            cur.execute("UPDATE usuarios SET idioma_preferido='pt-BR' WHERE idioma_preferido NOT IN ('pt-BR','es')")
            for usuario, senha_texto_puro, papel in usuarios_padrao:
                senha_hash = gerar_hash_senha(senha_texto_puro)
                cur.execute(
                    """INSERT INTO usuarios (usuario, senha_hash, papel) VALUES (%s, %s, %s)
                       ON CONFLICT (usuario) DO NOTHING""",
                    (usuario, senha_hash, papel),
                )
        con.commit()

ALLOWED_ROLES = frozenset({"admin","supervisor","consulta","recebimento","qualidade","processamento","etiquetagem","estocagem","planejamento","expedicao","devolucoes"})

def validate_new_password(password: str) -> None:
    if not isinstance(password, str) or len(password) < 12 or len(password) > 128 or not re.search(r"[A-Za-z]", password) or not re.search(r"\d", password):
        raise ValueError("A senha deve ter de 12 a 128 caracteres, incluindo letras e números.")

def change_password_supabase(username: str, current_password: str, new_password: str) -> None:
    validate_new_password(new_password)
    with pg_connect() as con:
        with con.cursor() as cur:
            cur.execute("SELECT senha_hash FROM usuarios WHERE usuario=%s FOR UPDATE", (username,))
            row=cur.fetchone()
            if not row or not verificar_senha(current_password,row["senha_hash"]):
                raise ValueError("Credenciais atuais inválidas.")
            if verificar_senha(new_password,row["senha_hash"]):
                raise ValueError("A nova senha precisa ser diferente da atual.")
            cur.execute("UPDATE usuarios SET senha_hash=%s,must_change_password=FALSE WHERE usuario=%s",
                        (gerar_hash_senha(new_password),username))

def create_operator_supabase(admin_username: str, admin_password: str, username: str, name: str, role: str, temporary_password: str) -> None:
    validate_new_password(temporary_password)
    if not re.fullmatch(r"[a-z0-9_.-]{3,40}",username):
        raise ValueError("Usuário inválido: use 3 a 40 letras minúsculas, números, ponto, traço ou sublinhado.")
    if not 2 <= len(name.strip()) <= 100 or role not in ALLOWED_ROLES:
        raise ValueError("Nome ou função inválida.")
    with pg_connect() as con:
        with con.cursor() as cur:
            cur.execute("SELECT senha_hash,papel,must_change_password FROM usuarios WHERE usuario=%s",(admin_username,))
            admin=cur.fetchone()
            if not admin or admin["papel"]!="admin" or admin["must_change_password"] or not verificar_senha(admin_password,admin["senha_hash"]):
                raise PermissionError("Autenticação de administrador inválida.")
            cur.execute("INSERT INTO usuarios(usuario,senha_hash,papel,must_change_password) VALUES(%s,%s,%s,TRUE)",
                        (username,gerar_hash_senha(temporary_password),role))

def reset_operator_password_supabase(admin_username: str, admin_password: str,
                                     target_username: str, temporary_password: str) -> None:
    """Administratively reset an existing operator to a one-time strong password.

    A separate verification of the administrator's current password prevents
    stolen browser sessions alone from resetting credentials.
    """
    validate_new_password(temporary_password)
    if target_username == admin_username:
        raise ValueError("Use a troca de senha para alterar sua própria conta.")
    with pg_connect() as con:
        with con.cursor() as cur:
            cur.execute("SELECT senha_hash,papel,must_change_password FROM usuarios WHERE usuario=%s FOR UPDATE", (admin_username,))
            admin = cur.fetchone()
            if not admin or admin["papel"] != "admin" or admin["must_change_password"] or not verificar_senha(admin_password,admin["senha_hash"]):
                raise PermissionError("Senha atual do administrador inválida.")
            cur.execute("SELECT usuario FROM usuarios WHERE usuario=%s FOR UPDATE", (target_username,))
            if not cur.fetchone():
                raise ValueError("Conta de operador não encontrada.")
            cur.execute(
                "UPDATE usuarios SET senha_hash=%s,must_change_password=TRUE WHERE usuario=%s",
                (gerar_hash_senha(temporary_password), target_username),
            )
