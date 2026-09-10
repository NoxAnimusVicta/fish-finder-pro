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
RADARS = ["IDR713", "IDR033", "IDR043", "IDR403", "IDR283", "IDR553", "IDR693", "IDR963", "IDR663", "IDR683"]
KEEP_FRAMES = 8
MAX_STATION_LOOKUPS = 80

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
    # The all-stations table has a two-row header (grouped "Wind" / "Highest
    # Wind Gust" cells), so header-name matching is unreliable. The data cells
    # after the station name are in a fixed order:
    #   0 date/time  1 temp  2 app temp  3 dew pt  4 rel hum  5 delta-T
    #   6 wind dir   7 spd km/h  8 gust km/h  9 spd kts  10 gust kts
    #   11 pressure  12 rain since 9am  13 low temp  14 high temp
    #   15 gust dir  16 gust km/h+time  17 gust kts+time
    for table in soup.find_all("table"):
        if "obs_table" not in (table.get("class") or []) and not table.find("a", href=re.compile(r"IDN60801\.\d+")):
            continue
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
            c = [td.get_text(" ", strip=True) for td in tr.find_all("td")]
            if len(c) < 13:
                continue

            def cell(i):
                return c[i] if 0 <= i < len(c) else ""

            press = num(cell(11))
            if press is not None and not (900 <= press <= 1100):
                # layout shifted — look for the pressure-shaped cell nearby
                for j in range(8, min(15, len(c))):
                    v = num(c[j])
                    if v is not None and 900 <= v <= 1100 and re.match(r"^\d{3,4}\.\d$", c[j]):
                        press = v
                        break
                else:
                    press = None

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
            dtxt = cell(6).upper()
            out.append({
                "id": sid, "name": name,
                "lat": st.get("lat"), "lon": st.get("lon"),
                "time": parse_time(cell(0), now),
                "temp": num(cell(1)),
                "windDirText": dtxt if dtxt in DIRS or dtxt == "CALM" else None,
                "windDir": DIRS.get(dtxt),
                "windKt": 0.0 if dtxt == "CALM" else num(cell(9)),
                "gustKt": num(cell(10)),
                "pressure": press,
                "rain": num(cell(12)),
            })
    return out


# ------------------------------------------------------------------- radar
# BOM retired the HTML loop pages in 2026, but the anonymous FTP server still
# lists and serves every radar frame, and the HTTP mirror of the same files
# still works for the ones we can name. FTP first, HTTP as the fallback.
import ftplib
import io

_ftp = None


def ftp():
    global _ftp
    if _ftp is None:
        _ftp = ftplib.FTP("ftp.bom.gov.au", timeout=60)
        _ftp.login()  # anonymous
    return _ftp


def ftp_list_radar():
    try:
        names = ftp().nlst("/anon/gen/radar/")
        return [os.path.basename(n) for n in names]
    except Exception as e:
        print(f"  ftp list: {e}", file=sys.stderr)
        return []


def ftp_get(remote):
    buf = io.BytesIO()
    ftp().retrbinary("RETR " + remote, buf.write)
    return buf.getvalue()


def fetch_radar(rid, listing):
    names = sorted(n for n in listing if n.startswith(rid + ".T.") and n.endswith(".png"))[-KEEP_FRAMES:]
    if not names:
        raise RuntimeError("no frames in the FTP listing")
    d = os.path.join(LIVE, "radar", rid)
    os.makedirs(d, exist_ok=True)
    layers = {}
    for layer in ("background", "topography", "locations", "range", "legend.0"):
        fn = f"{rid}.{layer}.png"
        path = os.path.join(d, fn)
        if not os.path.exists(path):
            blob = None
            for fetcher in (lambda: ftp_get(f"/anon/gen/radar_transparencies/{fn}"),
                            lambda: get(f"https://www.bom.gov.au/products/radar_transparencies/{fn}", binary=True)):
                try:
                    blob = fetcher()
                    break
                except Exception as e:
                    print(f"  {rid} {layer}: {e}", file=sys.stderr)
            if not blob:
                continue
            with open(path, "wb") as f:
                f.write(blob)
        layers[layer.split(".")[0]] = f"radar/{rid}/{fn}"
    frames = []
    for fn in names:
        path = os.path.join(d, fn)
        if not os.path.exists(path):
            blob = None
            for fetcher in (lambda: ftp_get(f"/anon/gen/radar/{fn}"),
                            lambda: get(f"https://www.bom.gov.au/radar/{fn}", binary=True)):
                try:
                    blob = fetcher()
                    break
                except Exception as e:
                    print(f"  {rid} {fn}: {e}", file=sys.stderr)
            if not blob:
                continue
            with open(path, "wb") as f:
                f.write(blob)
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
    listing = ftp_list_radar()
    print(f"ftp radar listing: {len(listing)} files")
    for rid in RADARS:
        try:
            radar["radars"][rid] = fetch_radar(rid, listing)
            print(f"radar {rid}: {len(radar['radars'][rid]['frames'])} frames")
        except Exception as e:
            print(f"radar {rid} failed: {e}", file=sys.stderr)
    radar["fetched"] = now
    jsave(os.path.join(LIVE, "radar.json"), radar)


if __name__ == "__main__":
    main()
