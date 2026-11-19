# city-plot

Pick a city or landmark, set how much ground the map covers, and style it for a pen plotter.

- **Place**: search a city, landmark or address (or type `lat, lon`). Drag the preview to move, scroll to zoom, or set the center and width in the Region panel.
- **Pens**: you define the pens (default: black, green and blue isographs, 0.3 mm). Every map layer, label and text block picks one.
- **Passes**: a layer's thickness is drawn as whole passes of its pen, overlapping by 20%. N passes draw `tip + (N-1) * 0.8 * tip` (0.3, 0.54, 0.78, 1.02 mm for a 0.3 mm pen). The style panel shows the pass count next to each thickness.
- **Layers**: parks, water, buildings, footpaths, minor/secondary/major streets, railways. Each has a pen, thickness, line style and (for areas) hatch fill. Layers switch off when the view is wider than they are made for (buildings 4 km, footpaths 6 km, minor streets 12 km, ...).
- **Waterlines**: water can have lines that follow the shore out into it, like an engraved chart (count, first gap, and how much
  each gap widens). They are contours of the distance from land on a fine grid (`src/city/waterlines.ts`), drawn in one pass of
  the water pen, and are traced once the view stops moving.
- **Looks**: Classic, Engraved chart, Blueprint, Nolli, Minimal and Kraft set the paper, pens, layers, type, border and
  north arrow in one click (`src/scene/looks.ts`), keeping the place, area, page and text; Undo is offered until the next change.
  The north arrow sits on clear paper: map lines and hatching are cut away under it.
- **Hand**: a Steady ↔ Sketchy slider (in Look) draws the map lines as if inked by hand: a slow drift of the sheet, so
  streets that meet still meet, and a tremor along each line, cut to the map again (`src/scene/hand.ts`). "Another take"
  draws it with a new seed. Kraft uses it.
- **Map scale**: Region → Scale fixes the map at 1:10,000, 1:25,000, 1:50,000 or 1:100,000; the width then follows the map
  frame, so the scale stays true on any page size. Zooming the map by hand lets go of it.
- **Grid**: a UTM kilometre grid (`src/scene/grid.ts`), numbered in the margin like a military or survey map (eastings
  along the top and bottom, northings up the sides). The lines are the true UTM lines, so they lean slightly off north.
  The **Military** look turns it on, with red roads, black buildings, blue water and green woods.
- **Title block**: Map info can show a **scale bar** (round metres or feet/miles, true to the map) and an **on foot** bar
  (minutes at 5 km/h) beside Area and Scale (`src/scene/scalebar.ts`); values too long for the row are set smaller, all
  alike. Coordinates can be written 47°36′22″ N. The title can sit in a **cartouche**: a ruled box, a double rule, or corner
  brackets (`src/scene/cartouche.ts`), with the map giving up the room it needs.
- **Wide views**: buildings, footpaths and minor streets switch off past 4, 6 and 12 km as before; each has a "Wide views"
  switch that draws it up to 13, 10 and 24 km (the map tiles carry them that far). The Military look turns it on.
- **Hatching by height**: the buildings layer can be hatched by each building's height from the map tiles: outlines under
  15 m, then light, medium, and solid above 120 m.
- **Surprise me**: the start screen (and Place) offers a curated city with a street plan worth plotting (`src/surprise.ts`).
- **Memory route**: join some of your own landmarks in order (Memory route group): a dotted line with an arrow on each leg,
  numbered stops, map lines cleared either side, and a key under the map listing each stop with a short note
  (`src/features/route.ts`). Path: curved, straight, or **along the streets**: the walk is found in the map's own street
  data on the device (`src/features/streetRoute.ts`, Dijkstra over footpaths and streets), so no stop goes to a routing
  service; a leg it cannot find keeps its curve.
- **Route from photos**: in Memory route, **Add from photos** (on a phone: the photo library or camera) reads each photo's
  GPS position and date from its EXIF on the device (JPEG and HEIC, `src/photos.ts`); photos are never uploaded. Stops are
  named by date and go in the order the photos were taken; photos from one place on one day are one stop. Phones often
  strip the location when a photo is picked in a browser, so those are listed to **Place on map** with a tap.
- **Photos from a phone**: Memory route → **From your phone** shows a QR code. The phone's page (`?drop=<token>`) reads its
  photos' locations and dates on the phone and sends only those, a file name and a ~160 px preview to a drop box on the
  Worker (`worker/drop.ts`, under `city/drop/` in the bucket); the computer collects them every 3 s, and they are deleted
  as they are collected. A box lasts an hour. In `npm run dev` the box lives in memory; to try it from a real phone, run
  `npx vite --host` and open the editor at the computer's network address, so the QR code carries an address the phone can reach.
- **Dashes on the plotter**: plotting software ignores `stroke-dasharray`, so the plotter export cuts dashed lines into real
  dashes, dotted lines into pen taps, and heavy dots into small discs (a tap and rings).
- **Plot time**: the Plotter preview estimates how long the plot takes (pens in palette order, lines sorted to keep pen-up
  travel short, as plotting software does; `src/export/plan.ts`) and **Watch it plot** plays it back: the ink appears in plot
  order, with the pen moving between lines and pausing to swap pens. Plotter speeds are set under Export and kept in the browser.
- **Landmarks**: attractions, museums, historic sites, stations, etc. from OpenStreetMap, plus your own ("home") from an address or coordinates.
- **Export**: SVG (plotter mode: one layer per pen, named after it, thick lines as passes, fills hatched, small text as single strokes) and PNG. A **Plotter** preview shows the map as the pens will draw it (ink width, translucency, overlap).
- **Pens**: pen kinds (technical/isograph, Micron, gel, marker) with ink spread, a saved-pen library, paper swatches with a low-contrast warning, and a table of which pen draws what.
- **Editing**: click any part of the map to open its settings; landmarks have their own markers, clear paper around labels, and a Hidden list.

## Where the data comes from

- **Streets, buildings, water, parks, railways:** OpenStreetMap data served as vector tiles by [OpenFreeMap](https://openfreemap.org)
  (OpenMapTiles schema), read in the user's browser (`src/city/tiles.ts`). Tiles are static files, so a view loads in a second or
  two. If the tiles cannot be fetched, each layer comes from an Overpass query through the Worker instead (`worker/api.ts`).
- **Landmarks (attractions, museums, stations…):** one small Overpass lookup through the Worker, because it also says which
  places have a Wikidata entry (used to rank them). **Place search:** Nominatim, through the Worker.
- OpenFreeMap's terms do not allow automated data collection, so tiles are fetched only from the user's browser (never from the
  Worker), at most four at a time, and a view is limited to about 150 tiles (a wider view uses a lower zoom).
- `test/fixtures/tiles/` holds three real downtown Seattle tiles (OpenStreetMap contributors, ODbL) so the decoder is tested
  without a network.

Map data © OpenStreetMap contributors.

## Saving and sharing

- **Save** (above the map) keeps the whole map under an 8-character code in the `project-files` bucket (`city/`), and `?p=code`
  reopens it. A browser that saved a project can **Save over** it (it holds an edit key; only a hash is stored).
- **Copy 1-hour link** puts the current SVG on the server and copies a link that works for an hour.
- Every export also lands in the bucket under `city-plot/<session>/`, with the settings beside it.

```bash
npm install
npm run dev     # app and /api on one dev server
npm test
npm run build
```

## Deploy

Deploys run from this machine with wrangler (already logged in; `npx wrangler login` if not):

```bash
npm run deploy   # runs the tests, builds, and `wrangler deploy`
```

`wrangler.toml` attaches the custom domain `city.bobsabayesian.io` (wrangler creates the DNS record and certificate) and
binds the R2 bucket `project-files` (`npx wrangler r2 bucket create project-files` if it does not exist yet). Deploying
from the Cloudflare dashboard as well would overwrite this; use one or the other.

## Coasters

Print size has two coaster shapes (4 in): a circle and a 3 × 4 in rounded rectangle. The map is cut to the shape.
Choosing one sets small margins, 6 pt labels and lighter lines, and switches off the title, the info text and the
attribution line (which does not fit), so credit OpenStreetMap contributors on the product itself.
