"""Cálculo da amostra de 10%: fiel à grade e distribuída por volume (sem depender do banco)."""
from __future__ import annotations

from typing import Any


def proportional_allocation(quantities: dict[int, int], total: int) -> dict[int, int]:
    """Divide `total` peças entre os itens na proporção exata da quantidade de cada um
    (maior resto), de modo que a soma feche exatamente `total` e nenhum item passe da
    própria quantidade. Ex.: 40 G Azul em 396 peças, total 40 → 4 G Azul."""
    qty = {k: max(0, int(v or 0)) for k, v in quantities.items()}
    capacity = sum(qty.values())
    total = max(0, min(int(total or 0), capacity))
    if capacity == 0 or total == 0:
        return {k: 0 for k in qty}
    base: dict[int, int] = {}
    remainders: dict[int, int] = {}
    for key, value in qty.items():
        numerator = total * value
        base[key] = numerator // capacity
        remainders[key] = numerator % capacity  # fração exata, sem erro de ponto flutuante
    left = total - sum(base.values())
    # maiores restos primeiro; empate: item com mais peças e depois pelo menor id
    order = sorted(qty, key=lambda k: (-remainders[k], -qty[k], k if isinstance(k, int) else 0))
    for key in order:
        if left <= 0:
            break
        if base[key] < qty[key]:
            base[key] += 1
            left -= 1
    return base


def volume_plan(rows: list[dict[str, Any]], volumes: Any) -> list[dict[str, Any]]:
    """Reparte a retirada de cada item entre os volumes de forma equilibrada, para que
    cada volume ceda uma parte parecida e nenhum seja esvaziado para fechar os 10%."""
    count = max(0, int(volumes or 0))
    if count <= 0:
        return []
    totals = [0] * count
    per_volume: list[list[dict[str, Any]]] = [[] for _ in range(count)]
    ordered = sorted(rows, key=lambda r: -int(r.get("sample_qty") or 0))
    for row in ordered:
        sample = int(row.get("sample_qty") or 0)
        if sample <= 0:
            continue
        base, extra = divmod(sample, count)
        amounts = [base] * count
        for index in sorted(range(count), key=lambda v: (totals[v], v))[:extra]:
            amounts[index] += 1
        for index, amount in enumerate(amounts):
            if amount:
                totals[index] += amount
                per_volume[index].append({
                    "product": row.get("product"), "reference": row.get("reference") or row.get("sku"),
                    "color": row.get("color"), "size": row.get("size"), "qty": amount,
                })
    return [{"volume": i + 1, "qty": totals[i], "items": per_volume[i]} for i in range(count)]
