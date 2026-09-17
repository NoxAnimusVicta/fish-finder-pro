#!/usr/bin/env python3
"""Build data/coast.json: the east-coast land outline the swell map clips to.

Source: Australian Bureau of Statistics ASGS 2021 state boundaries (CC BY 4.0),
which follow the coastline at mean high water. Pulled generalised to about
200 m, holes and specks dropped, kept to the stretch of coast the app covers,
and written as milli-degree deltas so the whole thing is ~80 KB.
"""
import json, os, sys, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "coast.json")
URL = ("https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/STE/MapServer/0/query?"
       + urllib.parse.urlencode({
           "where": "STATE_CODE_2021 IN ('1','2','3','8','9')",   # NSW, Vic, Qld, ACT, other territories (Jervis Bay)
           "outFields": "STATE_CODE_2021",
           "returnGeometry": "true",
           "outSR": "4326",
           "maxAllowableOffset": "0.002",
           "geometryPrecision": "3",
           "f": "json",
       }))
# the stretch of coast the app has spots on, with room to spare
LON_MIN, LAT_MIN, LAT_MAX = 147.0, -39.5, -26.5


def area(ring):
    a = 0.0
    for i in range(len(ring) - 1):
        a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
    return a / 2


def main():
    req = urllib.request.Request(URL, headers={"User-Agent": "fish-finder-pro coast build"})
    with urllib.request.urlopen(req, timeout=120) as r:
        j = json.load(r)
    if "error" in j:
        print("ABS error:", j["error"], file=sys.stderr)
        return 1
    rings = []
    for f in j.get("features", []):
        for ring in f["geometry"]["rings"]:
            if area(ring) > 0 or len(ring) < 8:      # ArcGIS outer rings run clockwise; holes and specks go
                continue
            lons = [p[0] for p in ring]; lats = [p[1] for p in ring]
            if max(lons) < LON_MIN or min(lats) > LAT_MAX or max(lats) < LAT_MIN:
                continue
            rings.append(ring)
    out = []
    for ring in rings:
        px = py = 0
        flat = []
        for p in ring:
            x, y = round(p[0] * 1000), round(p[1] * 1000)
            flat.append(x - px); flat.append(y - py)
            px, py = x, y
        out.append(flat)
    doc = {"v": 1, "source": "ABS ASGS 2021 state boundaries, CC BY 4.0, generalised 0.002 deg",
           "scale": 1000, "rings": out}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(doc, fh, separators=(",", ":"))
    pts = sum(len(r) // 2 for r in out)
    print(f"wrote {OUT}: {len(out)} rings, {pts} points, {os.path.getsize(OUT)} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
