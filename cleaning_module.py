"""Renata Ingrata: controle de tempo das tarefas de limpeza por área.

Tudo é gravado direto no Supabase (schema distrilog): cada tarefa tem um cronômetro
(iniciar, pausar, retomar, concluir) e o painel calcula a média de tempo por área."""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Request

import db

AREAS = ["PCP", "RH", "Estúdio", "Logística", "Cozinha", "Banheiros", "Marketing", "Digital", "Infra"]
TZ = ZoneInfo("America/Sao_Paulo")
MANAGER_ROLES = {"admin", "supervisor"}

router = APIRouter(prefix="/api/cleaning", tags=["limpeza"])


def _now() -> datetime:
    return datetime.now(TZ).replace(microsecond=0)


def _iso(value: datetime) -> str:
    return value.isoformat(timespec="seconds")


def db_connect() -> "db.Connection":
    return db.connect()


def init_cleaning_db() -> None:
    con = db_connect()
    try:
        con.executescript(
            """
            CREATE TABLE IF NOT EXISTS cleaning_tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                area TEXT NOT NULL,
                user_id INTEGER NOT NULL,
                user_name TEXT NOT NULL,
                status TEXT NOT NULL,
                notes TEXT,
                started_at TEXT NOT NULL,
                finished_at TEXT,
                worked_seconds INTEGER NOT NULL DEFAULT 0,
                paused_seconds INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS cleaning_task_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id INTEGER NOT NULL REFERENCES cleaning_tasks(id) ON DELETE CASCADE,
                event TEXT NOT NULL,
                occurred_at TEXT NOT NULL,
                user_id INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_cleaning_tasks_area_status ON cleaning_tasks(area, status);
            CREATE INDEX IF NOT EXISTS idx_cleaning_events_task ON cleaning_task_events(task_id);
            """
        )
    finally:
        con.close()


def _user(con, user_id: int):
    row = con.execute("SELECT id,name,role FROM users WHERE id=?", (int(user_id or 0),)).fetchone()
    if not row:
        raise HTTPException(401, "Usuário não autenticado.")
    return row


def _summarize(events: list, now: datetime) -> dict[str, Any]:
    """Tempo trabalhado e pausado a partir dos eventos (a parte em andamento conta até agora)."""
    worked = paused = 0
    state, last = None, None
    for ev in events:
        at = datetime.fromisoformat(ev["occurred_at"])
        name = ev["event"]
        if name in ("START", "RESUME"):
            if state == "PAUSADA" and last:
                paused += int((at - last).total_seconds())
            state, last = "EM_ANDAMENTO", at
        elif name in ("PAUSE", "FINISH"):
            if state == "EM_ANDAMENTO" and last:
                worked += int((at - last).total_seconds())
            state, last = ("PAUSADA" if name == "PAUSE" else "CONCLUIDA"), at
    if state == "EM_ANDAMENTO" and last:
        worked += int((now - last).total_seconds())
    elif state == "PAUSADA" and last:
        paused += int((now - last).total_seconds())
    return {"state": state, "worked_seconds": max(0, worked), "paused_seconds": max(0, paused)}


def _task_dict(row, summary: dict[str, Any] | None = None) -> dict[str, Any]:
    task = dict(row)
    if summary:
        task["worked_seconds"] = summary["worked_seconds"]
        task["paused_seconds"] = summary["paused_seconds"]
    return task


@router.get("/overview")
def overview(user_id: int, days: int = 30):
    con = db_connect()
    try:
        _user(con, user_id)
        now = _now()
        active_rows = con.execute(
            "SELECT * FROM cleaning_tasks WHERE status<>'CONCLUIDA' ORDER BY started_at DESC"
        ).fetchall()
        active = []
        if active_rows:
            ids = [int(r["id"]) for r in active_rows]
            marks = ",".join("?" for _ in ids)
            by_task: dict[int, list] = {i: [] for i in ids}
            for ev in con.execute(
                f"SELECT task_id,event,occurred_at FROM cleaning_task_events WHERE task_id IN ({marks}) ORDER BY id", ids
            ).fetchall():
                by_task[int(ev["task_id"])].append(ev)
            for r in active_rows:
                active.append(_task_dict(r, _summarize(by_task[int(r["id"])], now)))
        recent = [dict(r) for r in con.execute(
            "SELECT * FROM cleaning_tasks WHERE status='CONCLUIDA' ORDER BY finished_at DESC LIMIT 25"
        ).fetchall()]
        since = _iso(now - timedelta(days=days)) if days and days > 0 else "0000"
        stats = {r["area"]: dict(r) for r in con.execute(
            """SELECT area, COUNT(*) tasks, COALESCE(AVG(worked_seconds),0) avg_seconds,
                      COALESCE(SUM(worked_seconds),0) total_seconds, MIN(worked_seconds) min_seconds,
                      MAX(worked_seconds) max_seconds, MAX(finished_at) last_finished_at
               FROM cleaning_tasks WHERE status='CONCLUIDA' AND finished_at>=? GROUP BY area""", (since,)
        ).fetchall()}
    finally:
        con.close()
    by_area = []
    for area in AREAS:
        s = stats.get(area) or {}
        by_area.append({
            "area": area, "tasks": int(s.get("tasks") or 0), "avg_seconds": int(s.get("avg_seconds") or 0),
            "total_seconds": int(s.get("total_seconds") or 0), "min_seconds": int(s.get("min_seconds") or 0),
            "max_seconds": int(s.get("max_seconds") or 0), "last_finished_at": s.get("last_finished_at"),
        })
    total_tasks = sum(a["tasks"] for a in by_area)
    total_seconds = sum(a["total_seconds"] for a in by_area)
    return {
        "areas": AREAS, "active": active, "recent": recent, "by_area": by_area, "days": days,
        "totals": {"tasks": total_tasks, "total_seconds": total_seconds,
                   "avg_seconds": int(total_seconds / total_tasks) if total_tasks else 0},
    }


@router.post("/tasks")
async def start_task(request: Request):
    data = await request.json()
    area = str(data.get("area") or "").strip()
    notes = str(data.get("notes") or "").strip()
    if area not in AREAS:
        raise HTTPException(400, "Escolha uma área válida para a limpeza.")
    con = db_connect()
    try:
        user = _user(con, data.get("user_id"))
        if con.execute(
            "SELECT 1 FROM cleaning_tasks WHERE user_id=? AND status<>'CONCLUIDA'", (int(user["id"]),)
        ).fetchone():
            raise HTTPException(400, "Você já tem uma limpeza em andamento. Conclua ou pause antes de iniciar outra.")
        now = _iso(_now())
        cur = con.execute(
            """INSERT INTO cleaning_tasks(area,user_id,user_name,status,notes,started_at,created_at)
               VALUES(?,?,?,?,?,?,?)""",
            (area, int(user["id"]), user["name"], "EM_ANDAMENTO", notes or None, now, now),
        )
        con.execute(
            "INSERT INTO cleaning_task_events(task_id,event,occurred_at,user_id) VALUES(?,?,?,?)",
            (cur.lastrowid, "START", now, int(user["id"])),
        )
        con.commit()
        task_id = cur.lastrowid
    finally:
        con.close()
    return {"ok": True, "id": task_id}


_TRANSITIONS = {
    "pause": ("EM_ANDAMENTO", "PAUSE", "PAUSADA"),
    "resume": ("PAUSADA", "RESUME", "EM_ANDAMENTO"),
    "finish": (("EM_ANDAMENTO", "PAUSADA"), "FINISH", "CONCLUIDA"),
}


@router.post("/tasks/{task_id}/{action}")
async def task_action(task_id: int, action: str, request: Request):
    if action not in _TRANSITIONS:
        raise HTTPException(404, "Ação inválida.")
    data = await request.json()
    con = db_connect()
    try:
        user = _user(con, data.get("user_id"))
        task = con.execute("SELECT * FROM cleaning_tasks WHERE id=?", (task_id,)).fetchone()
        if not task:
            raise HTTPException(404, "Tarefa não encontrada.")
        if int(task["user_id"]) != int(user["id"]) and user["role"] not in MANAGER_ROLES:
            raise HTTPException(403, "Só quem iniciou a limpeza (ou um supervisor) pode alterar o cronômetro.")
        allowed, event, new_status = _TRANSITIONS[action]
        allowed = (allowed,) if isinstance(allowed, str) else allowed
        if task["status"] not in allowed:
            raise HTTPException(400, f"Ação incompatível com o estado atual: {task['status']}.")
        now = _now()
        con.execute(
            "INSERT INTO cleaning_task_events(task_id,event,occurred_at,user_id) VALUES(?,?,?,?)",
            (task_id, event, _iso(now), int(user["id"])),
        )
        events = con.execute(
            "SELECT event,occurred_at FROM cleaning_task_events WHERE task_id=? ORDER BY id", (task_id,)
        ).fetchall()
        summary = _summarize(events, now)
        if new_status == "CONCLUIDA":
            con.execute(
                """UPDATE cleaning_tasks SET status='CONCLUIDA',finished_at=?,worked_seconds=?,paused_seconds=? WHERE id=?""",
                (_iso(now), summary["worked_seconds"], summary["paused_seconds"], task_id),
            )
        else:
            con.execute("UPDATE cleaning_tasks SET status=? WHERE id=?", (new_status, task_id))
        con.commit()
    finally:
        con.close()
    return {"ok": True, "status": new_status, "worked_seconds": summary["worked_seconds"]}


@router.delete("/tasks/{task_id}")
async def delete_task(task_id: int, user_id: int):
    con = db_connect()
    try:
        user = _user(con, user_id)
        if user["role"] not in MANAGER_ROLES:
            raise HTTPException(403, "Somente administrador ou supervisor pode excluir uma limpeza.")
        con.execute("DELETE FROM cleaning_tasks WHERE id=?", (task_id,))
        con.commit()
    finally:
        con.close()
    return {"ok": True}


def register_cleaning_routes(app) -> None:
    app.include_router(router)
