The `Update BOM data` GitHub Action writes `bom.json` (coastal waters
forecasts and marine warnings) and `tides.json` (BOM tide predictions for the
six NSW standard ports) into this folder.

Until it has run for the first time the app falls back to its own model data,
so an empty folder is fine.
