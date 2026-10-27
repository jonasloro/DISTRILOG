"""Semântica da fotografia semanal — nenhuma semana é recalculada após o corte."""
from __future__ import annotations

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

import mission_module as mission

TZ = ZoneInfo("America/Sao_Paulo")


def test_monday_week_calendar_and_cutoffs():
    assert mission.monday_of(date(2026, 10, 27)) == date(2026, 10, 26)
    assert mission.mondays_in_month(2026, 10) == [
        date(2026, 10, 5), date(2026, 10, 12),
        date(2026, 10, 19), date(2026, 10, 26),
    ]
    assert mission.mondays_in_month(2026, 11) == [
        date(2026, 11, 2), date(2026, 11, 9),
        date(2026, 11, 16), date(2026, 11, 23), date(2026, 11, 30),
    ]
    due = mission.deadlines(date(2026, 11, 2))
    assert due["BACKLOG"].isoformat() == "2026-11-02T08:10:00-03:00"
    assert due["WED"].isoformat() == "2026-11-04T12:00:00-03:00"
    assert due["FRI"].isoformat() == "2026-11-06T16:00:00-03:00"
    assert due["BACKLOG"].astimezone(ZoneInfo("UTC")).hour == 11


def test_states_do_not_recalculate_missing_snapshots():
    due = mission.deadlines(date(2026, 11, 2))["BACKLOG"]
    assert mission.phase_state(due-timedelta(seconds=1), due, False) == "scheduled"
    assert mission.phase_state(due+timedelta(seconds=1), due, False) == "not_captured"
    assert mission.phase_state(due+timedelta(hours=48), due, True) == "captured"


def test_wednesday_preview_and_friday_final_are_independent_and_frozen():
    week = date(2026, 11, 2)
    data = {
        "runs": {
            "BACKLOG": "2026-11-02T08:10:01-03:00",
            "WED": "2026-11-04T12:00:00-03:00",
        },
        "metrics": {
            ("BACKLOG","PROCESSAMENTO"): 1200,
            ("WED","PROCESSAMENTO"): 1500,
        },
    }
    at_wednesday = mission.build_week_view(
        week,data,datetime(2026,11,4,13,0,tzinfo=TZ)
    )
    row = next(r for r in at_wednesday["rows"] if r["sector"] == "PROCESSAMENTO")
    assert row["backlog"] == 1200
    assert row["produced"] == 1500
    assert row["wednesday"] == 1500
    assert row["produced_source"] == "WED"
    assert row["achievement_pct"] == 125.0  # 100% não é limite

    # O número de quarta fica fixo; sexta traz o fechamento em coluna própria.
    data["runs"]["FRI"] = "2026-11-06T16:00:00-03:00"
    data["metrics"][("FRI","PROCESSAMENTO")] = 1900
    friday = mission.build_week_view(
        week,data,datetime(2026,11,7,9,0,tzinfo=TZ)
    )
    row = next(r for r in friday["rows"] if r["sector"] == "PROCESSAMENTO")
    assert row["backlog"] == 1200
    assert row["wednesday"] == 1500
    assert row["friday"] == 1900
    assert row["produced"] == 1900
    assert row["produced_source"] == "FRI"
    assert row["achievement_pct"] == 158.33


def test_before_first_cutoff_is_not_zero_and_missing_source_is_not_zero():
    monday = date(2026, 11, 2)
    view = mission.build_week_view(
        monday,{"runs":{},"metrics":{}},
        datetime(2026,11,2,8,9,tzinfo=TZ)
    )
    assert view["slots"]["BACKLOG"]["status"] == "scheduled"
    assert all(row["backlog"] is None and row["produced"] is None for row in view["rows"])
    assert next(r for r in view["rows"] if r["sector"]=="AJUSTES")["source_supported"] is False


def test_month_validation():
    for invalid in ("2026-13","2026-00","2026-1","not-a-date","2025-12"):
        with pytest.raises(Exception):
            mission.mission_weekly(invalid)


def test_api_reads_only_immutable_records(monkeypatch):
    week = date(2026,11,2)
    class Result:
        def __init__(self,records):self.records=records
        def fetchall(self):return self.records
    class Connection:
        def __init__(self):self.closed=False;self.sql=[]
        def execute(self,sql,params):
            assert sql.lstrip().upper().startswith("SELECT")
            self.sql.append(sql)
            if "mission_weekly_runs" in sql:
                return Result([
                    {"week_start":week,"snapshot_kind":"BACKLOG",
                     "captured_at":datetime(2026,11,2,8,10,1,tzinfo=TZ)}
                ])
            return Result([
                {"week_start":week,"snapshot_kind":"BACKLOG",
                 "sector":"QUALIDADE 1","pieces":240, "source_label":"Cards abertos do setor · peças dos itens"}
            ])
        def close(self):self.closed=True
    con = Connection()
    monkeypatch.setattr(mission.db,"connect",lambda:con)
    response=mission.mission_weekly("2026-11")
    assert con.closed
    assert len(con.sql)==2
    row=next(r for r in response["weeks"][0]["rows"] if r["sector"]=="QUALIDADE 1")
    assert row["backlog"]==240
    assert row["produced"] is None
    assert response["timezone"]=="America/Sao_Paulo"
