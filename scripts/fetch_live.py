#!/usr/bin/env python3
"""Ten-minute job: BOM station observations and radar frames for the `live`
branch. Everything is best effort — a failed fetch keeps whatever was there.

Layout of the live branch (LIVE_DIR):
  obs.json            latest reading from every NSW station with a position
  stations.json       station id -> lat/lon cache, filled in gradually
  radar.json          frame lists per radar
  radar/IDR713/…png   the last few frames plus the static layers
"""
import json
import os
import re
import sys
import time
import datetime as dt
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup

TZ = ZoneInfo("Australia/Sydney")
LIVE = os.environ.get("LIVE_DIR", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "live"))
REPO = os.environ.get("GITHUB_REPOSITORY", "fish-finder-pro")
UAS = [
    f"DawsonsFishFinder/1.0 (personal, non-commercial; +https://github.com/{REPO})",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
]
RADARS = ["IDR713", "IDR033", "IDR043", "IDR403", "IDR283", "IDR553", "IDR693", "IDR963"]
KEEP_FRAMES = 6
MAX_STATION_LOOKUPS = 25

S = requests.Session()


def get(url, binary=False):
    last = None
    for ua in UAS:
        try:
            r = S.get(url, timeout=40, headers={
                "User-Agent": ua, "Referer": "https://www.bom.gov.au/",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                "Accept-Language": "en-AU,en;q=0.9", "Upgrade-Insecure-Requests": "1"})
            if r.status_code == 200:
                return r.content if binary else r.text
            last = f"HTTP {r.status_code}"
        except Exception as e:
            last = str(e)
    raise RuntimeError(f"{url}: {last}")


def jload(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def jsave(path, obj):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"), sort_keys=True)


# ------------------------------------------------------------ observations
DIRS = {"N": 0, "NNE": 22.5, "NE": 45, "ENE": 67.5, "E": 90, "ESE": 112.5, "SE": 135, "SSE": 157.5,
        "S": 180, "SSW": 202.5, "SW": 225, "WSW": 247.5, "W": 270, "WNW": 292.5, "NW": 315, "NNW": 337.5}


def num(x):
    try:
        x = x.replace("\xa0", " ").strip()
        if x in ("", "-", "—", "Calm"):
            return None
        return float(re.sub(r"[^\d.\-]", "", x))
    except Exception:
        return None


def parse_time(txt, now):
    """BOM writes '07/01:30pm' — day of month and local time."""
    m = re.search(r"(\d{1,2})/(\d{1,2}):(\d{2})\s*(am|pm)", txt, re.I)
    if not m:
        return None
    day, hh, mm, mer = int(m.group(1)), int(m.group(2)) % 12, int(m.group(3)), m.group(4).lower()
    if mer == "pm":
        hh += 12
    for shift in (0, -1):
        base = now + dt.timedelta(days=shift) if shift else now
        try:
            cand = dt.datetime(base.year, base.month, day, hh, mm, tzinfo=TZ)
        except ValueError:
            continue
        if cand <= now + dt.timedelta(minutes=30):
            return int(cand.timestamp())
    return None


def fetch_obs(stations):
    html = get("https://www.bom.gov.au/nsw/observations/nswall.shtml")
    soup = BeautifulSoup(html, "html.parser")
    now = dt.datetime.now(TZ)
    out, looked_up = [], 0
    for table in soup.find_all("table"):
        heads = [h.get_text(" ", strip=True).lower() for h in table.find_all("th")
                 if h.find_parent("thead") is not None]
        if not heads or not any("wind" in h for h in heads):
            continue

        def col(*names):
            # earlier names win outright, so "gust kts" beats plain "gust"
            for n in names:
                for i, h in enumerate(heads):
                    if n in h:
                        return i
            return None

        c_time, c_temp = col("date/time", "date"), col("temp")
        c_dir, c_kts, c_gust = col("wind dir", "dir"), col("spd kts", "kts"), col("gust kts", "gust")
        c_press, c_rain = col("press"), col("rain")
        body = table.find("tbody") or table
        for tr in body.find_all("tr"):
            th = tr.find("th")
            if not th or not th.find("a"):
                continue
            a = th.find("a")
            m = re.search(r"IDN60801\.(\d+)\.shtml", a.get("href", ""))
            if not m:
                continue
            sid, name = m.group(1), a.get_text(" ", strip=True)
            cells = [td.get_text(" ", strip=True) for td in tr.find_all("td")]
            # header includes the station column; data cells do not
            off = 1 if heads and "station" in heads[0] else 0

            def cell(i):
                j = None if i is None else i - off
                return cells[j] if j is not None and 0 <= j < len(cells) else ""

            st = stations.get(sid)
            if st is None and looked_up < MAX_STATION_LOOKUPS:
                looked_up += 1
                try:
                    j = json.loads(get(f"https://www.bom.gov.au/fwo/IDN60801/IDN60801.{sid}.json"))
                    d0 = j["observations"]["data"][0]
                    st = {"lat": d0.get("lat"), "lon": d0.get("lon"), "name": d0.get("name") or name}
                    stations[sid] = st
                    time.sleep(0.4)
                except Exception as e:
                    print(f"  station {sid}: {e}", file=sys.stderr)
                    stations[sid] = {"lat": None, "lon": None, "name": name}
                    st = stations[sid]
            if st is None:
                continue
            dtxt = cell(c_dir).upper()
            out.append({
                "id": sid, "name": name,
                "lat": st.get("lat"), "lon": st.get("lon"),
                "time": parse_time(cell(c_time), now),
                "temp": num(cell(c_temp)),
                "windDirText": dtxt if dtxt in DIRS or dtxt == "CALM" else None,
                "windDir": DIRS.get(dtxt),
                "windKt": 0.0 if dtxt == "CALM" else num(cell(c_kts)),
                "gustKt": num(cell(c_gust)),
                "pressure": num(cell(c_press)),
                "rain": num(cell(c_rain)),
            })
    return out


# ------------------------------------------------------------------- radar
def fetch_radar(rid):
    html = get(f"https://www.bom.gov.au/products/{rid}.loop.shtml")
    names = re.findall(r'theImageNames\[\d+\]\s*=\s*"([^"]+)"', html)
    names = [n for n in names if rid in n]
    if not names:
        raise RuntimeError("no frame list on loop page")
    names = sorted(set(names))[-KEEP_FRAMES:]
    d = os.path.join(LIVE, "radar", rid)
    os.makedirs(d, exist_ok=True)
    layers = {}
    for layer in ("background", "topography", "locations", "range", "legend.0"):
        fn = f"{rid}.{layer}.png"
        path = os.path.join(d, fn)
        if not os.path.exists(path):
            try:
                blob = get(f"https://www.bom.gov.au/products/radar_transparencies/{fn}", binary=True)
                with open(path, "wb") as f:
                    f.write(blob)
                time.sleep(0.3)
            except Exception as e:
                print(f"  {rid} {layer}: {e}", file=sys.stderr)
                continue
        layers[layer.split(".")[0]] = f"radar/{rid}/{fn}"
    frames = []
    for n in names:
        fn = os.path.basename(n)
        path = os.path.join(d, fn)
        if not os.path.exists(path):
            try:
                blob = get("https://www.bom.gov.au" + n, binary=True)
                with open(path, "wb") as f:
                    f.write(blob)
                time.sleep(0.3)
            except Exception as e:
                print(f"  {rid} {fn}: {e}", file=sys.stderr)
                continue
        m = re.search(r"\.T\.(\d{12})\.png$", fn)
        ts = int(dt.datetime.strptime(m.group(1), "%Y%m%d%H%M").replace(tzinfo=dt.timezone.utc).timestamp()) if m else None
        frames.append({"time": ts, "file": f"radar/{rid}/{fn}"})
    keep = {os.path.basename(f["file"]) for f in frames} | {os.path.basename(v) for v in layers.values()}
    for fn in os.listdir(d):
        if fn not in keep:
            os.remove(os.path.join(d, fn))
    step = None
    if len(frames) >= 2 and frames[-1]["time"] and frames[-2]["time"]:
        step = round((frames[-1]["time"] - frames[-2]["time"]) / 60)
    return {"frames": frames, "layers": layers, "stepMin": step}


def main():
    os.makedirs(LIVE, exist_ok=True)
    now = int(time.time())

    stations = jload(os.path.join(LIVE, "stations.json"), {})
    try:
        obs = fetch_obs(stations)
        jsave(os.path.join(LIVE, "stations.json"), stations)
        jsave(os.path.join(LIVE, "obs.json"), {"fetched": now, "stations": obs})
        print(f"observations: {len(obs)} stations ({sum(1 for o in obs if o['lat'] is not None)} positioned)")
    except Exception as e:
        print(f"observations failed: {e}", file=sys.stderr)

    radar = jload(os.path.join(LIVE, "radar.json"), {"radars": {}})
    radar.setdefault("radars", {})
    for rid in RADARS:
        try:
            radar["radars"][rid] = fetch_radar(rid)
            print(f"radar {rid}: {len(radar['radars'][rid]['frames'])} frames")
        except Exception as e:
            print(f"radar {rid} failed: {e}", file=sys.stderr)
    radar["fetched"] = now
    jsave(os.path.join(LIVE, "radar.json"), radar)


if __name__ == "__main__":
    main()
