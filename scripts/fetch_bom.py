#!/usr/bin/env python3
"""Pull Bureau of Meteorology data into data/*.json for the static app.

Runs in GitHub Actions. Everything is best effort: if BOM is unreachable or a
page changes shape, the existing file is left alone rather than clobbered, and
the app falls back to its own model data.
"""
import json
import os
import re
import sys
import datetime as dt
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup

TZ = ZoneInfo("Australia/Sydney")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
REPO = os.environ.get("GITHUB_REPOSITORY", "fish-finder-pro")
UA = f"NSWFishingApp/1.0 (personal, non-commercial; +https://github.com/{REPO})"

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": UA, "Accept-Language": "en-AU,en"})

COASTAL_XML = "https://www.bom.gov.au/fwo/IDN11001.xml"
WARNING_FEEDS = [
    "https://www.bom.gov.au/fwo/IDZ00060.warnings_marine_nsw.xml",
    "https://www.bom.gov.au/fwo/IDZ00054.warnings_land_nsw.xml",
]

DISTRICTS = {
    "byron": "Byron Coast",
    "coffs": "Coffs Coast",
    "macquarie": "Macquarie Coast",
    "hunter": "Hunter Coast",
    "sydney": "Sydney Coast",
    "illawarra": "Illawarra Coast",
    "batemans": "Batemans Coast",
    "eden": "Eden Coast",
}

PORTS = {
    "yamba": ("Yamba", "NSW_TP008"),
    "newcastle": ("Newcastle", "NSW_TP004"),
    "sydney": ("Sydney (Fort Denison)", "NSW_TP007"),
    "botany": ("Botany Bay", "NSW_TP001"),
    "portkembla": ("Port Kembla", "NSW_TP006"),
    "eden": ("Eden", "NSW_TP002"),
}

MONTHS = {m: i + 1 for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}


def get(url, **kw):
    r = SESSION.get(url, timeout=45, **kw)
    r.raise_for_status()
    return r


def load(name):
    p = os.path.join(DATA, name)
    if os.path.exists(p):
        try:
            with open(p) as f:
                return json.load(f)
        except Exception:
            return None
    return None


def save(name, obj):
    os.makedirs(DATA, exist_ok=True)
    p = os.path.join(DATA, name)
    with open(p, "w") as f:
        json.dump(obj, f, separators=(",", ":"), sort_keys=True)
    print(f"wrote {name} ({os.path.getsize(p)} bytes)")


# --------------------------------------------------------------- forecasts
def fetch_coastal():
    """NSW coastal waters forecast, one entry per district."""
    soup = BeautifulSoup(get(COASTAL_XML).content, "xml")
    issued = ""
    amoc = soup.find("issue-time-local")
    if amoc:
        issued = amoc.get_text(strip=True)

    by_name = {}
    for area in soup.find_all("area"):
        desc = (area.get("description") or "").strip()
        by_name[desc.lower()] = area

    out = {}
    for key, name in DISTRICTS.items():
        area = by_name.get(name.lower())
        if area is None:
            continue
        periods = []
        for fp in area.find_all("forecast-period"):
            label = fp.get("start-time-local", "")
            try:
                start = dt.datetime.fromisoformat(label)
                label = start.strftime("%a %-d %b")
            except Exception:
                label = fp.get("index", "")
            chunks = []
            for txt in fp.find_all("text"):
                s = " ".join(txt.get_text(" ", strip=True).split())
                if s:
                    chunks.append(s)
            if chunks:
                periods.append({"label": label, "text": " ".join(chunks)})
        if periods:
            out[key] = {"name": name, "issued": issued, "periods": periods[:4]}
    return out


def fetch_warnings():
    items = []
    for url in WARNING_FEEDS:
        try:
            soup = BeautifulSoup(get(url).content, "xml")
        except Exception as e:
            print(f"  warnings {url}: {e}", file=sys.stderr)
            continue
        for it in soup.find_all("item")[:8]:
            title = it.find("title")
            desc = it.find("description")
            link = it.find("link")
            if not title:
                continue
            t = title.get_text(strip=True)
            if "cancel" in t.lower():
                continue
            items.append({
                "title": t,
                "text": " ".join(desc.get_text(" ", strip=True).split())[:400] if desc else "",
                "url": link.get_text(strip=True) if link else url,
            })
    return items[:6]


# ------------------------------------------------------------------- tides
DAY_RE = re.compile(r"\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2})\s+"
                    r"(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b")
TOKEN_RE = re.compile(
    r"(?P<day>\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}\s+"
    r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b)"
    r"|(?P<label>\b(?:High|Low)\b)"
    r"|(?P<time>\b\d{1,2}:\d{2}\s*(?:am|pm)\b)"
    r"|(?P<height>\b-?\d+\.\d{2}\s*m\b)")


def parse_tide_page(html, start_date):
    """Walk a token stream so the parser does not care how BOM lays the
    table out — only the order High/Low -> time -> height matters."""
    text = BeautifulSoup(html, "html.parser").get_text("\n")
    cursor = start_date
    current = None
    pending = None
    pending_time = None
    tides = []

    for m in TOKEN_RE.finditer(text):
        if m.group("day"):
            d = DAY_RE.search(m.group("day"))
            day, mon = int(d.group(2)), MONTHS[d.group(3)]
            probe = cursor
            for _ in range(400):
                if probe.day == day and probe.month == mon:
                    break
                probe += dt.timedelta(days=1)
            else:
                continue
            current = probe
            cursor = probe
            pending = pending_time = None
        elif m.group("label"):
            pending = m.group("label").lower()
            pending_time = None
        elif m.group("time"):
            if pending:
                pending_time = m.group("time").replace(" ", "").lower()
        elif m.group("height"):
            if pending and pending_time and current:
                hh, rest = pending_time.split(":")
                mm, mer = rest[:2], rest[2:]
                hour = int(hh) % 12 + (12 if mer == "pm" else 0)
                local = dt.datetime(current.year, current.month, current.day,
                                    hour, int(mm), tzinfo=TZ)
                height = float(m.group("height").replace("m", "").strip())
                tides.append({"time": int(local.timestamp()),
                              "height": round(height, 2),
                              "type": "high" if pending == "high" else "low"})
            pending = pending_time = None
    return tides


def fetch_tides(force=False):
    existing = load("tides.json") or {}
    ports = existing.get("ports", {})
    today = dt.datetime.now(TZ).date()

    need = force
    if not need:
        for key in PORTS:
            p = ports.get(key)
            if not p or not p.get("tides"):
                need = True
                break
            last = dt.datetime.fromtimestamp(p["tides"][-1]["time"], TZ).date()
            if (last - today).days < 10:
                need = True
                break
    if not need:
        print("tides still fresh, skipping")
        return None

    start = today - dt.timedelta(days=1)
    out = {}
    for key, (name, aac) in PORTS.items():
        url = ("https://www.bom.gov.au/australia/tides/print.php"
               f"?aac={aac}&type=tide&date={start.isoformat()}"
               "&region=NSW&tz=Australia/Sydney&tz_js=AEST&days=31")
        try:
            html = get(url).text
            tides = parse_tide_page(html, start)
        except Exception as e:
            print(f"  {name}: {e}", file=sys.stderr)
            tides = []
        if len(tides) < 40:
            print(f"  {name}: only {len(tides)} tides parsed — keeping previous", file=sys.stderr)
            if ports.get(key):
                out[key] = ports[key]
            continue
        out[key] = {"name": name, "aac": aac, "tides": tides}
        print(f"  {name}: {len(tides)} tides")

    if not out:
        return None
    return {"updated": dt.datetime.now(TZ).isoformat(timespec="minutes"),
            "source": "Bureau of Meteorology tide predictions",
            "ports": out}


def main():
    force = "--force-tides" in sys.argv
    previous = load("bom.json") or {}

    coastal, warnings = previous.get("coastal"), previous.get("warnings", [])
    try:
        coastal = fetch_coastal() or coastal
        print(f"coastal districts: {len(coastal or {})}")
    except Exception as e:
        print(f"coastal forecast failed: {e}", file=sys.stderr)
    try:
        warnings = fetch_warnings()
        print(f"warnings: {len(warnings)}")
    except Exception as e:
        print(f"warnings failed: {e}", file=sys.stderr)

    if coastal:
        save("bom.json", {
            "updated": dt.datetime.now(TZ).isoformat(timespec="minutes"),
            "coastal": coastal,
            "warnings": warnings,
            "attribution": ("This product is based on Bureau of Meteorology information that has "
                            "subsequently been modified. The Bureau does not necessarily support "
                            "or endorse, or have any connection with, the product."),
        })

    try:
        tides = fetch_tides(force)
        if tides:
            save("tides.json", tides)
    except Exception as e:
        print(f"tides failed: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
