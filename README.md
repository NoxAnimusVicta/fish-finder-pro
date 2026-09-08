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
5. **Switch on the BOM updaters.** *Settings → Actions → General → Workflow
   permissions → Read and write*. Then the *Actions* tab → enable workflows →
   run **Update BOM data** once (coastal waters forecasts, warnings and
   official tide predictions into `data/`, then every two hours) and **Live
   BOM feed** once (station observations and radar frames onto a `live`
   branch, then every ten minutes). The app works without either — it falls
   back to model tides, skips the BOM text and uses the map radar.

To change anything later, edit the file on GitHub and commit; the site updates
within a minute. On the phone, close and reopen the app to pick it up.

## What's in it

| Tab | What it does |
| --- | --- |
| **Now** | Bite score 0–100 with the reasoning shown, current wind/swell/water temp/barometer, next tide, sun and moon, and the best windows over the next week |
| **Forecast** | Bite score charted across seven days, 48-hour strip, daily outlook, swell and sea state |
| **Tides** | Tide curve per day with highs and lows, night shading, moon feeding periods |
| **Maps** | Live BOM radar loop for the nearest site with a you-are-here dot, a map-based radar, Windy wind and swell layers, one-tap links to BOM warnings |
| **Fish** | 40 NSW species with season bars, run and migration notes, current legal sizes and bag limits, baits and lures |

Settings hold your name, land-or-boat, target species, wind and swell limits,
and the catch log. Everything stays on the phone.

Day-to-day extras: favourite and recent spots, notes per spot, a four-week
moon-and-tide planner, "best bets" (every species scored for the water you
are on, now and over the next 24 hours), a barometer trace from yesterday to
tomorrow, one-tap sharing of the conditions or the catch log as CSV, blank
sessions and a daily bag tally in the log, a backup/restore of everything on
the phone, pull-to-refresh, and a larger-text option.

### What makes it more accurate than a plain forecast

- **Real readings, not just the model.** The nearest BOM weather station's
  latest wind, gust, pressure and temperature are shown next to the model,
  and the next six hours of the forecast are nudged toward what the station
  is actually reading, with the nudge fading out so a stale reading cannot
  poison tomorrow.
- **Confidence.** BOM's own 18-member ensemble is pulled alongside the
  forecast. Where the members disagree on the wind, the windows and the
  seven-day list say so.
- **Local exposure.** Every spot knows which way it faces, so a westerly at
  Callala Bay counts as offshore and flattening, while at Currarong it is
  side-shore — the same wind scores differently at spots ten minutes apart.
- **His weights.** Every factor's pull on the score can be tuned in Settings,
  and once there are six or more logged catches the app starts learning which
  factors actually produce for him — measured against what each factor
  typically reads at that spot that week (and against his blank sessions once
  he has logged a few), so a factor that is always high never gets credit for
  nothing.
- **Tested.** `sim/run_sims.js` checks sunrise/sunset against the NOAA solar
  calculator (within 0.1 min), moon phase against Meeus' lunar-phase instants,
  the tide-model extraction against an analytic harmonic tide (median timing
  error 2 min), 4,000 Monte Carlo score runs for range and monotonicity, the
  window builder's constraints, the learning algorithm against a random
  angler and a selective one, and every spot and species entry for
  consistency. `test/run.py` drives the whole UI in a simulated iPhone.

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
scripts/fetch_bom.py       two-hourly forecasts, warnings, tides
scripts/fetch_live.py      ten-minute observations and radar frames
.github/workflows/bom.yml  runs fetch_bom.py, commits to data/
.github/workflows/live.yml runs fetch_live.py, force-pushes the live branch
data/                      what the Action writes
test/                      offline browser test — python3 test/run.py
```

Adding a spot means one row in `SPOT_ROWS` in `js/data.js`; adding a species
means one object in `SPECIES`. Both are commented.
