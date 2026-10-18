# city-plot

Pick a city or landmark, set how much ground the map covers, and style it for a pen plotter.

- **Place**: search a city, landmark or address (or type `lat, lon`). Drag the preview to move, scroll to zoom, or set the center and width in the Region panel.
- **Pens**: you define the pens (default: black, green and blue isographs, 0.3 mm). Every map layer, label and text block picks one.
- **Passes**: a layer's thickness is drawn as whole passes of its pen, overlapping by 20%. N passes draw `tip + (N-1) * 0.8 * tip` (0.3, 0.54, 0.78, 1.02 mm for a 0.3 mm pen). The style panel shows the pass count next to each thickness.
- **Layers**: parks, water, buildings, footpaths, minor/secondary/major streets, railways. Each has a pen, thickness, line style and (for areas) hatch fill. Layers switch off when the view is wider than they are made for (buildings 4 km, footpaths 6 km, minor streets 12 km, ...).
- **Landmarks**: attractions, museums, historic sites, stations, etc. from OpenStreetMap, plus your own ("home") from an address or coordinates.
- **Export**: SVG (one layer per pen and width; plotter mode splits thick lines into passes and hatches fills) and PNG.

Map data © OpenStreetMap contributors.

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
