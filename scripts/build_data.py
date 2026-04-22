"""
Pré-processa os dados estáticos para o front-end.

O que faz:
  1. Lê public/data/calculo-deslocamento.xlsx
  2. Gera public/data/services.json e public/data/bases.json
  3. Compacta public/data/osrm-routes.json do formato full para o formato 2D compacto

Formato compacto do osrm-routes.json:
  {
    "v": 1,
    "sids": [1, 2, ..., N],          -- IDs dos serviços
    "bids": ["base-0", ..., "base-M"], -- IDs das bases
    "d": [[d00, d01, ...], ...],       -- distâncias em km, 2 casas decimais
    "t": [[t00, t01, ...], ...]        -- tempos em minutos, 2 casas decimais
  }

Executar após atualizar a planilha ou regerar o cache de rotas:
  npm run build:data
"""

import json
import math
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "public" / "data"
XLSX_FILE = DATA_DIR / "calculo-deslocamento.xlsx"
ROUTES_FILE = DATA_DIR / "osrm-routes.json"
SERVICES_OUT = DATA_DIR / "services.json"
BASES_OUT = DATA_DIR / "bases.json"

# Import shared XLSX parsing from the existing precompute script
sys.path.insert(0, str(Path(__file__).parent))
from precompute_osrm_routes import read_workbook


def build_services_json(services: list[dict]) -> list[dict]:
    return [
        {
            "id": s["id"],
            "description": s["description"],
            "lat": round(s["lat"], 6),
            "lng": round(s["lng"], 6),
        }
        for s in services
    ]


def build_bases_json(bases: list[dict], service_count: int) -> list[dict]:
    capacity = max(1, math.ceil(service_count / max(1, len(bases)) * 1.12))
    return [
        {
            "id": b["id"],
            "name": b["name"],
            "address": b.get("address", ""),
            "lat": round(b["lat"], 6),
            "lng": round(b["lng"], 6),
            "capacity": capacity,
        }
        for b in bases
    ]


def compact_routes(routes_full: dict, services: list[dict], bases: list[dict]) -> dict:
    sids = [s["id"] for s in services]
    bids = [b["id"] for b in bases]
    sid_index = {sid: i for i, sid in enumerate(sids)}
    bid_index = {bid: i for i, bid in enumerate(bids)}
    n, m = len(sids), len(bids)

    dist = [[None] * m for _ in range(n)]
    dur = [[None] * m for _ in range(n)]

    for key, route in routes_full.items():
        sid_str, _, bid = key.partition(":")
        try:
            sid = int(sid_str)
        except ValueError:
            continue
        si = sid_index.get(sid)
        bi = bid_index.get(bid)
        if si is None or bi is None:
            continue
        dist[si][bi] = round(route["distanceKm"], 2)
        dur[si][bi] = round(route["durationMin"], 2)

    covered = sum(1 for row in dist for v in row if v is not None)
    total = n * m
    print(f"   Cobertura: {covered:,} / {total:,} ({covered / total * 100:.1f}%)")

    return {"v": 1, "sids": sids, "bids": bids, "d": dist, "t": dur}


def write_json(path: Path, data: object) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def fmt_kb(path: Path) -> str:
    size = path.stat().st_size
    if size >= 1_048_576:
        return f"{size / 1_048_576:.1f} MB"
    return f"{size / 1024:.0f} KB"


def main() -> None:
    print("=== build_data.py ===\n")

    # 1. Parse planilha
    print(f"1. Lendo planilha: {XLSX_FILE.name}")
    services_raw, bases_raw = read_workbook(XLSX_FILE)
    print(f"   {len(services_raw):,} serviços, {len(bases_raw)} bases")

    services = build_services_json(services_raw)
    bases = build_bases_json(bases_raw, len(services))

    # 2. Escrever services.json e bases.json
    print(f"\n2. Escrevendo services.json e bases.json")
    write_json(SERVICES_OUT, services)
    write_json(BASES_OUT, bases)
    print(f"   services.json  {fmt_kb(SERVICES_OUT)}")
    print(f"   bases.json     {fmt_kb(BASES_OUT)}")

    # 3. Compactar rotas
    if not ROUTES_FILE.exists():
        print(f"\n3. {ROUTES_FILE.name} não encontrado — pulando compactação")
        print("   Execute npm run build:rotas primeiro para gerar o cache de rotas.")
        return

    raw = json.loads(ROUTES_FILE.read_text(encoding="utf-8"))

    if raw.get("v") == 1 and "sids" in raw:
        print(f"\n3. {ROUTES_FILE.name} já está no formato compacto — OK")
        return

    print(f"\n3. Compactando {ROUTES_FILE.name}")
    size_before = ROUTES_FILE.stat().st_size
    routes_full = raw.get("routes", {})
    compact = compact_routes(routes_full, services_raw, bases_raw)
    write_json(ROUTES_FILE, compact)
    size_after = ROUTES_FILE.stat().st_size
    reduction = (1 - size_after / size_before) * 100
    print(f"   {size_before / 1_048_576:.1f} MB -> {size_after / 1_048_576:.1f} MB  ({reduction:.0f}% menor)")

    print("\nConcluído. Reinicie o servidor de desenvolvimento.")


if __name__ == "__main__":
    main()
