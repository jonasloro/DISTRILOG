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
