# Interlining regression checks

Run `npm test` for network topology, directional widths, express snapping, lane continuity and editing-mode checks. The runner bundles TypeScript with esbuild and uses Node's built-in test runner; it cleans up its temporary output.

For visual checks, run `npm run dev` and open `/tests/render-preview.html`. This fixture mounts the production `MapView` with in-memory stops, roads and three services, without fetching OSM data or changing saved proposals:

- Red 100 serves Alpha–Beta–Gamma–Delta in both directions.
- Blue 500 runs Alpha–Delta through the same corridor, skipping Beta and Gamma.
- Green 200 shares Beta–Gamma and then runs a one-way loop.

At the initial network zoom, check parallel strokes, averaged stop groups, continuous joins and four arrows on the green one-way sections. Use the editing/drawing buttons to check separate platforms and directions at the same zoom; return to network view to check restoration. Zooming above 13.5 also shows the detailed view, as in the main app.

The suite also checks service-specific stop dots, closing/deselecting a line and moving stops (routing, failure rollback, OSM position persistence and import).

Waypoint checks cover ordered route shaping for buses and trams, external routing,
undo and cancellation, persistence, splitting/merging legs and moving stops.
While drawing a line, choose **Dodaj punkt trasy**, click a road or track, then
choose the next stop. Repeat the button to add more points before that stop.
The points affect geometry only. New segment times use route length using `AVERAGE_SPEED_KMH`
(currently 24 km/h for buses and 19 km/h for trams), rounded to whole minutes (minimum 1).
Manual times survive rerouting; saved/imported times are normalized to whole minutes; ↻ restores automatic calculation.

Isochrone checks cover boarding waits, transfers, service periods, directionality,
OSM pedestrian access restrictions, bridges, disconnected crossings, foot one-way
rules, edge snapping and full reachable coverage beyond 200 minutes. In the main
app, choose **Izochrony**, click the map and choose the service period.
All time bands are shown across the reachable network inside the configured BBOX.
Walking follows the OSM graph at 4.8 km/h; boarding adds half-headway waiting time.
Short origin/stop connectors (up to 150/80 m) remain approximate. The display grid
widens road corridors for visibility without adding shortcuts to the routing graph.
Entering the isochrone tool starts downloading OSM through two independent providers.
The first complete response wins; the download deadline is 30 seconds including the
response body. Closing the panel preserves the worker, graph and active download.
Subsequent clicks reuse the graph; IndexedDB preserves it across reloads. Snapshots
older than seven days are used immediately and refreshed in the background. Downloads require a working public Overpass endpoint;
failures show a retry action and never fall back to straight-line walking.

Planning checks cover whole-minute segment edits, evenly spaced takt options and
weekday/weekend operating costs (tram 28.33 PLN/km, bus 14.09 PLN/km). Costs include
both directions and hidden lines during configured service periods, without depot
runs. Check the header cost disclosure and collapsed per-line cost details.
For editor layout checks, scroll a long line: its compact title and close button
should remain visible. Takt sliders are taller and every configured option occupies
an equal interval. Less frequent header tools live in the **⋯** menu.

Routing regression checks cover Rondo Matecznego 03 → Bonarka 01, pedestrian-area snapping and preservation of closely spaced junctions. `fixtures/matecznego-bonarka.json` is a small extract of actual OSM stop/way geometry downloaded on 2026-10-19 from the [OSM API](https://api.openstreetmap.org/api/0.6/map?bbox=19.938,50.024,19.958,50.039), © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL. It includes pedestrian area [309423742](https://www.openstreetmap.org/way/309423742), which reproduced the original routing failure. Tests use the saved fixture and do not contact external services.

For the full editor, run a second server with `npm run dev -- --host 127.0.0.1 --port 5174` and open `/tests/editor-preview.html` on that port. Keep this fixture on a separate origin from your real project: it exercises actual save actions. Test × and repeated line selection, then select Alpha 01, choose “Przesuń przystanek”, drag the handle or click a destination, and reload to check persistence.
