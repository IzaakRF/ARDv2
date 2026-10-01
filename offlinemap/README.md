# Offline maps

The Map page draws two layers, both served locally so it works with no internet:

1. **Street map (committed to git):** `gui/public/basemap/whitecliffs_region.pmtiles`,
   an OpenStreetMap vector extract from [Protomaps](https://protomaps.com)
   (ODbL, free for offline use with attribution). It covers
   lon 142.55-143.85, lat -31.20 to -30.15 at zoom 0-14 (overzoomed beyond):
   White Cliffs, Caradoc Station (the launch site) and the Goodwood test area.
   It shows wherever there is no satellite imagery.
2. **Satellite imagery (not in git):** `gui/public/maps/tiles/{z}/{x}/{y}.jpg`,
   from `download_map.py`. Only use imagery whose licence allows offline
   caching.

## Changing the street-map area

Needs the `pmtiles` CLI (`brew install pmtiles`, or a binary from
https://github.com/protomaps/go-pmtiles/releases) and internet:

```bash
BUILD=$(curl -s https://build-metadata.protomaps.dev/builds.json \
  | python3 -c "import json,sys; print(max(b['key'] for b in json.load(sys.stdin) if b['key'].endswith('.pmtiles')))")
pmtiles extract "https://build.protomaps.com/$BUILD" \
  gui/public/basemap/whitecliffs_region.pmtiles \
  --bbox=142.55,-31.20,143.85,-30.15 --maxzoom=14
```

`--bbox` is west,south,east,north. If you rename the file, update
`BASEMAP_URL`/the source URL in `gui/src/pages/MapPage.tsx`.

## Generated files (no npm packages needed on the Pi)

So the Raspberry Pi can update with a plain `git pull`, the map uses only
`maplibre-gl` (already a dependency). These were generated once on a
development machine:

- `gui/src/vendor/pmtiles.js`: [pmtiles](https://github.com/protomaps/PMTiles)
  4.5.0 (BSD-3-Clause) bundled into one file:
  `npx esbuild node_modules/pmtiles/dist/esm/index.js --bundle --format=esm --minify`
- `gui/src/basemap/layers.ts`: map style layers from `@protomaps/basemaps`
  5.7.2: `layers("basemap", namedFlavor("dark"), { lang: "en" })`
- `gui/public/basemap/fonts/` and `sprites/`: label fonts and icons from
  https://github.com/protomaps/basemaps-assets (Noto Sans Regular/Medium/Italic,
  ranges 0-255, 256-511, 8192-8447; sprites v4 `dark`)
