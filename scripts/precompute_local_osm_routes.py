import argparse
import json
import math
import time
from pathlib import Path

import networkx as nx
import osmnx as ox

from precompute_osrm_routes import DEFAULT_OUTPUT, DEFAULT_WORKBOOK, read_workbook, route_key, write_cache


ROOT = Path(__file__).resolve().parents[1]
GRAPH_FILE = ROOT / "scripts" / "df-road-network.graphml"


def main():
    parser = argparse.ArgumentParser(description="Precompute all service-base routes from local OpenStreetMap road data.")
    parser.add_argument("--workbook", type=Path, default=DEFAULT_WORKBOOK)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--graph", type=Path, default=GRAPH_FILE)
    parser.add_argument("--buffer", type=float, default=0.08)
    args = parser.parse_args()

    ox.settings.use_cache = True
    ox.settings.log_console = True

    services, bases = read_workbook(args.workbook)
    graph = load_or_download_graph(args.graph, services, bases, args.buffer)
    graph = ox.add_edge_speeds(graph)
    graph = ox.add_edge_travel_times(graph)

    print("Finding nearest graph nodes...")
    service_nodes = ox.distance.nearest_nodes(graph, [item["lng"] for item in services], [item["lat"] for item in services])
    base_nodes = ox.distance.nearest_nodes(graph, [item["lng"] for item in bases], [item["lat"] for item in bases])

    routes = {}
    started = time.time()
    for base, base_node in zip(bases, base_nodes):
      lengths = nx.single_source_dijkstra_path_length(graph, base_node, weight="length")
      travel_times = nx.single_source_dijkstra_path_length(graph, base_node, weight="travel_time")
      for service, service_node in zip(services, service_nodes):
          distance = lengths.get(service_node)
          duration = travel_times.get(service_node)
          if distance is None or duration is None:
              distance_km, duration_min = haversine_fallback(service, base)
          else:
              distance_km = distance / 1000
              duration_min = duration / 60
          routes[route_key(service["id"], base["id"])] = {
              "distanceKm": distance_km,
              "durationMin": duration_min,
              "source": "osrm",
          }
      print(f"Base {base['name']} done | route relations: {len(routes)}")

    cache = {
        "source": "OpenStreetMap local road graph via OSMnx",
        "serviceCount": len(services),
        "baseCount": len(bases),
        "routeCount": len(routes),
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "routes": routes,
    }
    write_cache(args.output, cache)
    print(f"Saved {len(routes)} route relations to {args.output}")
    print(f"Elapsed: {time.time() - started:.1f}s")


def load_or_download_graph(path, services, bases, buffer):
    if path.exists():
        print(f"Loading cached graph: {path}")
        return ox.load_graphml(path)

    lats = [item["lat"] for item in [*services, *bases]]
    lngs = [item["lng"] for item in [*services, *bases]]
    bbox = (
        min(lngs) - buffer,
        min(lats) - buffer,
        max(lngs) + buffer,
        max(lats) + buffer,
    )
    print(f"Downloading OSM road graph for bbox {bbox}...")
    graph = ox.graph_from_bbox(bbox, network_type="drive", simplify=True, retain_all=False, truncate_by_edge=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    ox.save_graphml(graph, path)
    return graph


def haversine_fallback(service, base):
    radius = 6371
    dlat = math.radians(base["lat"] - service["lat"])
    dlng = math.radians(base["lng"] - service["lng"])
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(service["lat"])) * math.cos(math.radians(base["lat"])) * math.sin(dlng / 2) ** 2
    distance_km = radius * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a)) * 1.28
    return distance_km, (distance_km / 34) * 60


if __name__ == "__main__":
    main()
