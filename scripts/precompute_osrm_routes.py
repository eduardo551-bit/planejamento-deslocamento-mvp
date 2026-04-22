import argparse
import json
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_WORKBOOK = ROOT / "public" / "data" / "calculo-deslocamento.xlsx"
DEFAULT_OUTPUT = ROOT / "public" / "data" / "osrm-routes.json"
OSRM_TABLE_URL = "https://router.project-osrm.org/table/v1/driving/{coordinates}?sources={sources}&destinations={destinations}&annotations=duration,distance"

NS = {
    "a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}


def main():
    parser = argparse.ArgumentParser(description="Precompute OSRM route matrix for the fixed service workbook.")
    parser.add_argument("--workbook", type=Path, default=DEFAULT_WORKBOOK)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--limit", type=int, default=0, help="Maximum new services to calculate in this run. 0 means all remaining.")
    parser.add_argument("--batch-size", type=int, default=12)
    parser.add_argument("--sleep", type=float, default=1.0)
    args = parser.parse_args()

    services, bases = read_workbook(args.workbook)
    cache = read_cache(args.output)
    routes = cache.setdefault("routes", {})

    missing_services = [
        service for service in services
        if any(route_key(service["id"], base["id"]) not in routes for base in bases)
    ]
    if args.limit > 0:
        missing_services = missing_services[:args.limit]

    print(f"Services: {len(services)} | Bases: {len(bases)} | Pending this run: {len(missing_services)}")
    for start in range(0, len(missing_services), args.batch_size):
        batch = missing_services[start:start + args.batch_size]
        values = request_matrix(batch, bases)
        routes.update(values)
        cache.update({
            "source": "OpenStreetMap / OSRM",
            "serviceCount": len(services),
            "baseCount": len(bases),
            "routeCount": len(routes),
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })
        write_cache(args.output, cache)
        done = min(start + len(batch), len(missing_services))
        print(f"Saved batch {done}/{len(missing_services)} | route relations: {len(routes)}")
        time.sleep(args.sleep)


def read_workbook(path):
    sheets = read_xlsx_sheets(path)
    maintenance = sheets.get("Manutenção") or sheets.get("Manutencao") or next(iter(sheets.values()))
    bases_sheet = sheets.get("Bases") or list(sheets.values())[1]

    services = []
    for index, row in enumerate(maintenance, start=1):
        lng = normalize_coordinate(row.get("COORD_X"))
        lat = normalize_coordinate(row.get("COORD_Y"))
        if lat is None or lng is None:
            continue
        services.append({
            "id": index,
            "description": str(row.get("DESCRICAO_DEFEITO") or f"Serviço {index}"),
            "lat": lat,
            "lng": lng,
        })

    bases = []
    for index, row in enumerate(bases_sheet):
        lat = normalize_coordinate(row.get("Latitude"))
        lng = normalize_coordinate(row.get("Longitude"))
        if lat is None or lng is None:
            continue
        bases.append({
            "id": f"base-{index}",
            "name": str(row.get("Nome Comum") or f"Base {index + 1}"),
            "lat": lat,
            "lng": lng,
        })

    return services, bases


def read_xlsx_sheets(path):
    with zipfile.ZipFile(path) as archive:
        shared = read_shared_strings(archive)
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        relmap = {rel.attrib["Id"]: rel.attrib["Target"] for rel in rels}
        sheets = {}

        for sheet in workbook.findall("a:sheets/a:sheet", NS):
            name = sheet.attrib["name"]
            rel_id = sheet.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]
            target = relmap[rel_id]
            sheet_path = "xl/" + target.lstrip("/") if not target.startswith("xl/") else target
            rows = read_sheet_rows(archive, sheet_path, shared)
            if not rows:
                sheets[name] = []
                continue
            headers = [str(value or "").strip() for value in rows[0]]
            records = []
            for row in rows[1:]:
                records.append({headers[index]: row[index] if index < len(row) else "" for index in range(len(headers))})
            sheets[name] = records

    return sheets


def read_shared_strings(archive):
    try:
        root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    return ["".join(text.text or "" for text in item.findall(".//a:t", NS)) for item in root.findall("a:si", NS)]


def read_sheet_rows(archive, sheet_path, shared):
    root = ET.fromstring(archive.read(sheet_path))
    rows = []
    for row in root.findall("a:sheetData/a:row", NS):
        values = []
        for cell in row.findall("a:c", NS):
            ref = cell.attrib.get("r", "")
            index = column_index("".join(ch for ch in ref if ch.isalpha()))
            while len(values) <= index:
                values.append("")
            raw = cell.find("a:v", NS)
            inline = cell.find("a:is/a:t", NS)
            value = inline.text if inline is not None else (raw.text if raw is not None else "")
            if cell.attrib.get("t") == "s" and value != "":
                value = shared[int(value)]
            values[index] = value
        rows.append(values)
    return rows


def column_index(column):
    value = 0
    for char in column:
        value = value * 26 + ord(char.upper()) - ord("A") + 1
    return max(0, value - 1)


def normalize_coordinate(value):
    try:
        number = float(str(value).replace(",", "."))
    except (TypeError, ValueError):
        return None
    while abs(number) > 90:
        number = number / 10
    return number


def request_matrix(services, bases):
    if not services:
        return {}

    coordinates = ";".join([f'{item["lng"]},{item["lat"]}' for item in [*services, *bases]])
    sources = ";".join(str(index) for index, _ in enumerate(services))
    destinations = ";".join(str(len(services) + index) for index, _ in enumerate(bases))
    url = OSRM_TABLE_URL.format(coordinates=coordinates, sources=sources, destinations=destinations)
    request = urllib.request.Request(url, headers={"User-Agent": "service-planner-mvp/0.1"})

    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        if len(services) > 1:
            return split_request(services, bases)
        print(f"Skipping service {services[0]['id']} after OSRM HTTP {error.code}")
        return {}
    except (urllib.error.URLError, TimeoutError):
        if len(services) > 1:
            return split_request(services, bases)
        return {}

    if payload.get("code") != "Ok":
        if len(services) > 1:
            return split_request(services, bases)
        print(f"Skipping service {services[0]['id']} after OSRM code {payload.get('code')}")
        return {}

    values = {}
    distances = payload.get("distances") or []
    durations = payload.get("durations") or []
    for service_index, service in enumerate(services):
        for base_index, base in enumerate(bases):
            try:
                distance = distances[service_index][base_index]
                duration = durations[service_index][base_index]
            except IndexError:
                continue
            if distance is None or duration is None:
                continue
            values[route_key(service["id"], base["id"])] = {
                "distanceKm": distance / 1000,
                "durationMin": duration / 60,
                "source": "osrm",
            }
    return values


def split_request(services, bases):
    middle = max(1, len(services) // 2)
    values = request_matrix(services[:middle], bases)
    values.update(request_matrix(services[middle:], bases))
    return values


def read_cache(path):
    if not path.exists():
        return {"routes": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def write_cache(path, cache):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cache, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def route_key(service_id, base_id):
    return f"{service_id}:{base_id}"


if __name__ == "__main__":
    main()
