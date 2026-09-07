# Dawson's Fish Finder Pro

A phone-first fishing app for the NSW coast and inland waters. Static HTML —
no server, no build step, no API keys. Host it free on GitHub Pages and add it
to the iPhone home screen, where it runs full screen like a native app.

![icon](icons/icon-192.png)

## Putting it online (about 5 minutes)

1. **Make the repo.** On github.com, *New repository* → name it `fish-finder-pro`
   → **Public** → Create.
2. **Upload the files.** On the repo page, *Add file* → *Upload files* → drag
   in everything from this folder (keep the folder structure — `js/`,
   `icons/`, `data/`, `.github/`) → *Commit changes*.
3. **Turn on Pages.** *Settings* → *Pages* → Source: **Deploy from a branch**,
   Branch: **main**, folder: **/ (root)** → Save. A minute later the URL
   appears at the top of that page:
   `https://noxanimusvicta.github.io/fish-finder-pro/`
4. **Add it to the home screen.** Open that URL in **Safari** on the iPhone →
   the Share button → **Add to Home Screen** → Add. It must be Safari; Chrome
   on iOS can't install home-screen apps.
5. **Switch on the BOM updater.** *Actions* tab → *I understand my workflows,
   go ahead and enable them* → pick **Update BOM data** → *Run workflow*. That
   pulls BOM's coastal waters forecasts, marine warnings and official tide
   predictions into `data/`, and then repeats every two hours. The app works
   without it — it just falls back to model tides and skips the BOM text.

To change anything later, edit the file on GitHub and commit; the site updates
within a minute. On the phone, close and reopen the app to pick it up.

## What's in it

| Tab | What it does |
| --- | --- |
| **Now** | Bite score 0–100 with the reasoning shown, current wind/swell/water temp/barometer, next tide, sun and moon, and the best windows over the next week |
| **Forecast** | Bite score charted across seven days, 48-hour strip, daily outlook, swell and sea state |
| **Tides** | Tide curve per day with highs and lows, night shading, moon feeding periods |
| **Maps** | Animated rain radar, Windy wind and swell layers, one-tap links to the right BOM radar and warnings for where you are |
| **Fish** | 40 NSW species with season bars, run and migration notes, current legal sizes and bag limits, baits and lures |

Settings hold your name, land-or-boat, target species, wind and swell limits,
and the catch log. Everything stays on the phone.

### The bite score

A weighted blend of wind (strength, gusts, and whether it's blowing off the
coast), barometric pressure and its three-hour trend, tide movement and how
close you are to a turn, solunar major and minor periods, light at dawn and
dusk, cloud and rain, swell height and period, and sea temperature against
your target species' preferred range — then scaled by whether that species is
in its run this month. The factor bars on the Now tab show every input, so it
is never a black box.

## Where the data comes from

- **Weather** — Bureau of Meteorology **ACCESS-G** model (switchable to a
  multi-model blend), served through [Open-Meteo](https://open-meteo.com).
- **Swell, sea state, water temperature** — Open-Meteo Marine.
- **Tides** — official **BOM predictions** for the six NSW standard ports when
  the GitHub Action has fetched them, shifted by the published time
  differences for your spot. Without them, a global tide model estimate,
  clearly labelled as such.
- **Rain radar** — [RainViewer](https://www.rainviewer.com), which ingests BOM
  radar.
- **Wind and swell maps** — [Windy](https://www.windy.com) embeds.
- **Sun, moon, solunar** — calculated on the phone. Moon phase times land
  within about six minutes of published ephemeris; sunrise and sunset within a
  minute.
- **Fishing rules** — NSW DPIRD saltwater and freshwater bag and size limits,
  checked September 2026.

> This product is based on Bureau of Meteorology information that has
> subsequently been modified. The Bureau does not necessarily support or
> endorse, or have any connection with, the product.

Tide heights and swell figures are guidance, not navigation or depth data.
Fishing rules change — the official DPIRD tables win.

## Files

```
index.html                 markup and iOS meta tags
styles.css                 all styling, light and dark
js/astro.js                sun, moon, solunar maths
js/data.js                 spots, ports, radars, species, NSW rules
js/core.js                 storage, network, tides, bite score
js/map.js                  the slippy map (no libraries)
js/app.js                  screens, charts, glue
sw.js                      offline cache — bump CACHE after edits
manifest.webmanifest       home-screen install metadata
scripts/fetch_bom.py       what the GitHub Action runs
.github/workflows/bom.yml  the two-hourly BOM update
data/                      what the Action writes
test/                      offline browser test — python3 test/run.py
```

Adding a spot means one row in `SPOT_ROWS` in `js/data.js`; adding a species
means one object in `SPECIES`. Both are commented.
