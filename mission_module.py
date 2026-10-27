"""Visão da Missão: quadro semanal imutável, com cortes no fuso de Brasília.

A fonte da verdade é o Supabase PostgreSQL. Os três registros são feitos
por pg_cron, e nunca reconstruídos retroativamente a partir do saldo atual.
A API só lê os valores congelados.
"""
from __future__ import annotations

import calendar
import re
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, FastAPI, HTTPException

import db

BRASILIA = ZoneInfo("America/Sao_Paulo")
AUTOMATIC_START_MONTH = "2026-11"
AUTOMATIC_START_WEEK = date(2026, 11, 2)
SECTORS = (
    "RECEBIMENTO", "EXPEDIÇÃO PCP", "QUALIDADE 1", "QUALIDADE 2",
    "PROCESSAMENTO", "ETIQUETAGEM", "ESTOCAGEM", "AJUSTES", "EXPEDIÇÃO",
)
PHASES = ("BACKLOG", "WED", "FRI")
PHASE_NAMES = {"BACKLOG": "Backlog inicial", "WED": "Prévia de quarta",
               "FRI": "Fechamento de sexta"}

router = APIRouter(prefix="/api/mission", tags=["Missão - fotografias semanais"])


def monday_of(value: date) -> date:
    return value - timedelta(days=value.weekday())


def mondays_in_month(year: int, month: int) -> list[date]:
    """Uma linha do quadro por segunda-feira dentro do mês selecionado."""
    first = date(year, month, 1)
    candidate = first + timedelta(days=(7-first.weekday()) % 7)
    result = []
    while candidate.month == month:
        result.append(candidate)
        candidate += timedelta(days=7)
    return result


def deadlines(monday: date) -> dict[str, datetime]:
    return {
        "BACKLOG": datetime.combine(monday, time(8, 10), BRASILIA),
        "WED": datetime.combine(monday + timedelta(days=2), time(12), BRASILIA),
        "FRI": datetime.combine(monday + timedelta(days=4), time(16), BRASILIA),
    }


def phase_state(now: datetime, due: datetime, recorded: bool) -> str:
    if recorded:
        return "captured"
    return "scheduled" if now < due else "not_captured"


def build_week_view(monday: date, data: dict, now: datetime) -> dict:
    due = deadlines(monday)
    runs = data.get("runs", {})
    metrics = data.get("metrics", {})
    source_notes = data.get("notes", {})
    slots = {
        phase: {
            "label": PHASE_NAMES[phase],
            "scheduled_for": due[phase].isoformat(),
            "status": phase_state(now, due[phase], phase in runs),
            "captured_at": runs.get(phase),
        }
        for phase in PHASES
    }
    rows = []
    for sector in SECTORS:
        backlog = metrics.get(("BACKLOG", sector))
        wed = metrics.get(("WED", sector))
        fri = metrics.get(("FRI", sector))
        if "FRI" in runs:
            produced = fri
            produced_source = "FRI"
        elif "WED" in runs:
            produced = wed
            produced_source = "WED"
        else:
            produced = None
            produced_source = None
        source_detail = source_notes.get((produced_source, sector), "") if produced_source else ""
        source_supported = sector != "AJUSTES" and not source_detail.startswith("DADOS INCOMPLETOS")
        pct = None
        if isinstance(backlog, int) and backlog > 0 and isinstance(produced, int):
            pct = round(produced / backlog * 100, 2)
        rows.append({
            "sector": sector,
            "backlog": backlog,
            "wednesday": wed,
            "friday": fri,
            "produced": produced,
            "produced_source": produced_source,
            "achievement_pct": pct,
            "source_supported": source_supported,
            "source_detail": source_detail,
        })
    return {
        "week_start": monday.isoformat(),
        "week_end": (monday + timedelta(days=4)).isoformat(),
        "slots": slots,
        "rows": rows,
    }


@router.get("/weekly")
def mission_weekly(month: str | None = None) -> dict:
    now = datetime.now(BRASILIA)
    if month is None:
        year, month_num = now.year, now.month
    else:
        if not re.fullmatch(r"20\d{2}-(0[1-9]|1[0-2])", month):
            raise HTTPException(400, "Mês inválido. Use AAAA-MM.")
        year, month_num = map(int, month.split("-"))
    if f"{year:04d}-{month_num:02d}" < AUTOMATIC_START_MONTH:
        raise HTTPException(400, "O quadro automático começa em novembro de 2026. Para meses anteriores, consulte o Histórico legado.")
    if year > now.year + 1:
        raise HTTPException(400, "Período fora da janela de consulta.")
    weeks = mondays_in_month(year, month_num)
    first_monday, last_monday = weeks[0], weeks[-1]
    by_week: dict[date, dict] = {
        monday: {"runs": {}, "metrics": {}, "notes": {}} for monday in weeks
    }
    con = db.connect()
    try:
        runs = con.execute(
            """SELECT week_start,snapshot_kind,captured_at
                 FROM distrilog.mission_weekly_runs
                 WHERE week_start>=? AND week_start<=?""",
            (first_monday, last_monday),
        ).fetchall()
        metrics = con.execute(
            """SELECT week_start,snapshot_kind,sector,pieces,source_label
                 FROM distrilog.mission_weekly_metrics
                 WHERE week_start>=? AND week_start<=?""",
            (first_monday, last_monday),
        ).fetchall()
    finally:
        con.close()
    for row in runs:
        week = row["week_start"]
        if week in by_week:
            captured = row["captured_at"]
            by_week[week]["runs"][row["snapshot_kind"]] = captured.isoformat() if hasattr(captured, "isoformat") else str(captured)
    for row in metrics:
        week = row["week_start"]
        if week in by_week:
            v = row["pieces"]
            key = (row["snapshot_kind"], row["sector"])
            by_week[week]["metrics"][key] = None if v is None else int(v)
            by_week[week]["notes"][key] = str(row["source_label"] or "")
    return {
        "source": "Dados operacionais do DISTRILOG · Supabase",
        "timezone": "America/Sao_Paulo",
        "month": f"{year:04d}-{month_num:02d}",
        "automatic_start_month": AUTOMATIC_START_MONTH,
        "captured_at": now.isoformat(),
        "schedule": {"BACKLOG": "Segunda 08:10",
                     "WED": "Quarta 12:00", "FRI": "Sexta 16:00"},
        "sectors": list(SECTORS),
        "weeks": [build_week_view(w, by_week[w], now) for w in weeks],
        "disclaimer": (
            "Valores só aparecem após os respectivos cortes. Fotografias não "
            "são reconstruídas com dados atuais quando um horário é perdido. "
            "AJUSTES ainda não tem fonte de peças concluídas homologada."
        ),
    }


def register_mission_routes(app: FastAPI) -> None:
    app.include_router(router)
