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
The points affect geometry only. New segment times use route length at 20.5 km/h
for buses and 19 km/h for trams, rounded to 0.5 minutes (minimum 0.5).
Manual and legacy times survive rerouting; ↻ restores automatic calculation.

Isochrone checks cover boarding waits, transfers, service periods, directionality,
missing segments, walking access, inactive services, closed contours, disconnected
islands and inaccessible holes. In the main app, choose **Izochrony**, click the map,
change the period and the 30/45/60-minute limit, then clear or close the analysis.
The estimate uses all project lines (including hidden ones), half-headway waits,
segment travel times and straight-line walking at 4.8 km/h. It does not route walks
around physical barriers or use a live timetable.

Routing regression checks cover Rondo Matecznego 03 → Bonarka 01, pedestrian-area snapping and preservation of closely spaced junctions. `fixtures/matecznego-bonarka.json` is a small extract of actual OSM stop/way geometry downloaded on 2026-10-19 from the [OSM API](https://api.openstreetmap.org/api/0.6/map?bbox=19.938,50.024,19.958,50.039), © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL. It includes pedestrian area [309423742](https://www.openstreetmap.org/way/309423742), which reproduced the original routing failure. Tests use the saved fixture and do not contact external services.

For the full editor, run a second server with `npm run dev -- --host 127.0.0.1 --port 5174` and open `/tests/editor-preview.html` on that port. Keep this fixture on a separate origin from your real project: it exercises actual save actions. Test × and repeated line selection, then select Alpha 01, choose “Przesuń przystanek”, drag the handle or click a destination, and reload to check persistence.
