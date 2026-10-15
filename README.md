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
