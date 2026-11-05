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
Walking follows the OSM graph at 4.8 km/h. For one line boarding adds half its
headway when averaged over a full cycle. The project now generates concrete
periodic departures from headways, route times and optional manual phases.
Isochrones sample 120 departures over 60 minutes and aggregate complete journeys
(mean, nearest-rank P90, best or worst). Tests verify catching/missing transfers,
phase coordination on the longest common directed platform sequence, inactive
members, branching, persistence and incremental-versus-independent searches.
Timetable tests cover 7A–7B and 7A–8 on different corridors, rotation from any
member across both directions, compatible cycles requiring alternate slow-line
slots, incompatible periods, legacy migration and generated clock departures.

Planning checks cover whole-minute segment edits, evenly spaced takt options and
weekday/weekend operating costs (tram 28.33 PLN/km, bus 14.09 PLN/km). Costs include
both directions and hidden lines during configured service periods, without depot
runs. Check the header cost disclosure and collapsed per-line cost details.
For editor layout checks, scroll a long line: its compact title and close button
should remain visible. Takt sliders are taller and every configured option occupies
an equal interval. Less frequent header tools live in the **⋯** menu.

Routing regression checks cover Rondo Matecznego 03 → Bonarka 01, pedestrian-area snapping and preservation of closely spaced junctions. `fixtures/matecznego-bonarka.json` is a small extract of actual OSM stop/way geometry downloaded on 2026-10-19 from the [OSM API](https://api.openstreetmap.org/api/0.6/map?bbox=19.938,50.024,19.958,50.039), © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL. It includes pedestrian area [309423742](https://www.openstreetmap.org/way/309423742), which reproduced the original routing failure. Tests use the saved fixture and do not contact external services.

For the full editor, run a second server with `npm run dev -- --host 127.0.0.1 --port 5174` and open `/tests/editor-preview.html` on that port. Keep this fixture on a separate origin from your real project: it exercises actual save actions. Test × and repeated line selection, then select Alpha 01, choose “Przesuń przystanek”, drag the handle or click a destination, and reload to check persistence.

`fixtures/ztp-stops.json` contains the actual `stops.txt` rows for Bujaka,
Kurdwanów P+R and Teligi from the three official [ZTP GTFS feeds](https://gtfs.ztp.krakow.pl/),
downloaded on 2026-10-31: A version `20261024_20261031`, M `1698_1697`,
T `20261031`. Tests verify exact name/platform identity across operators,
co-located distinct platforms, mixed modes, CSV parsing, migration of saved
OSM references, manual positions/groups, and preservation of obsolete used
stops as local proposals. A full-catalogue check verifies unique name/number
pairs, IDs and migration aliases in `public/stops.json`.

Stop editing tests cover project-only names and transport types, persistence
after catalogue refresh/import, unchanged route geometry, and read-only access.
Walking tests verify that repeated origins reuse the prepared topology without
sharing request-specific splits or boarding connections. The production proxy
tests cover compressed disk cache, concurrent downloads, restart persistence,
and rejection of partial Overpass responses.

GTFS travel-time tests cover unsorted/interleaved stop times, exact platform
and mode identity, asymmetric directions, median aggregation across operators,
times above 24:00, missing timestamps, and duplicate sequences. They also
exercise drawing/moving/resetting legs, manual overrides, save/import, and
validate the complete generated `public/gtfs-times.json` index.

Journey checks cover concrete departures, transfers, staying on board across
period boundaries, branch restrictions, tie-breaking by transfers, walking-only
and disconnected routes, whole-day platform timetables, search normalization,
read-only analysis and the cached/rate-limited geocoder. The planner and
isochrone tool reuse the same worker and prepared walking graph.

Clock checks cover HH:MM and compact numeric input, shifts through midnight,
and the Warsaw time zone/weekend selector for the Now button. Browser QA also
covers default marker dragging, automatic rerouting, the quick-minute buttons,
slider changes and rejecting invalid hours.


GTFS network import checks cover exception-only calendars, representative days,
tram type 900, rounded headways with independent direction phases, meaningful
short variants versus rare depot trips, monotonic loop geometry, finite service
windows, midnight, legacy saves, compressed large-project persistence, catalogue
reloads, replacement with a backup and preserved local infrastructure, read-only
access, and API download deduplication/disk caching/forced refresh. Browser QA
uses the downloaded full ZTP network (315 lines/variants), reloads the project,
opens a line timetable, and finds a Kurdwanów P+R–Teligi journey.

Server cache checks verify that browser OSM downloads only use `/overpass`,
including Vite development and preview. They cover seven-day compressed OSM
extracts, stale copies during outages and a fifteen-minute failure cooldown.
GTFS checks cover daily processed snapshots, shared on-disk ZIP archives,
one-hour manual refresh limits, conditional 304 responses, restart persistence,
and rejection of truncated ZIPs without replacing the last good archive.

Bulk visibility checks verify category-wide changes, one persisted update,
unchanged schedules/other mode and the read-only boundary.

## Regresja bezpieczeństwa

`npm test` obejmuje również `tests/security.test.ts`: błędne URL i nagłówki, ścisły schemat
projektów, rozmiary body (także chunked), uprawnienia i wygasanie tokenów, limity dysku,
retencję, migrację starszych zapisów, dozwolone operacje OSM, współbieżność, limity odpowiedzi
upstream i zachowanie sekretów przy linkach podglądu. Próby działają wyłącznie na loopback
z danymi tymczasowymi i atrapami zewnętrznych dostawców.

Po `npm run build` uruchom `npm run test:production`: uruchamia dwie osobne instancje
gotowego bundla na losowych portach i sprawdza wspólny limit sieci, rotację tokenów,
zapisy, odrzucanie `GET //`, nagłówki i dostępność plików aplikacji. Nie korzysta z
produkcyjnego katalogu danych.

## Mapa w rzeczywistej przeglądarce

Po buildzie: `npm run test:map-browser`. Dla development: `npm run test:map-browser -- --dev`.
Wymaga Chromium (`/usr/bin/chromium`, ewentualnie `CHROMIUM_PATH`) i Node 22.12+.
Test tworzy osobny profil oraz projekt w katalogu tymczasowym, uruchamia WebGL i sprawdza
piksele trzech kolorów tras, Referer zawierający wyłącznie origin oraz brak wymuszonego
omijania cache kafelków. Usługi zewnętrzne są zastępowane atrapami; test nie pobiera kafelków OSM.
`MAP_QA_SCREENSHOT=/tmp/map.png` pozwala zachować zrzut mapy.

## Metryka jakości sieci

`tests/networkQuality.test.ts` sprawdza zgodność batchu z niezależnymi
wyszukiwaniami dla czterech scenariuszy, wagi miejsc i kampusów, brakujące
przyłączenia, kierunki, nieaktywne pory i ukryte linie. Kontroluje unikalne
komórki powierzchni, zgodność KMZ z katalogiem oraz prawdziwy worker API,
walidację, deduplikację, limity kolejki i zmianę klucza po aktualizacji OSM.
Produkcja sprawdza osadzony worker dla całego katalogu na małym wycinku OSM
zapisanym w katalogu tymczasowym, bez pobierania zewnętrznych danych.

`npm run export:quality-places` odtwarza KML/KMZ z katalogu.
`npm run benchmark:quality -- --baseline` porównuje metrykę z pełnymi
izochronami, batching z osobnymi wyszukiwaniami oraz geometrię konturów z HEAD.

Skala `gtfs` ma testy kotwic 0/100, wyników ponad 100, słabszej sieci,
niezdefiniowanej skali przy braku poprawy GTFS nad marszem, zgodności warunków,
współdzielenia referencji i odrzucania wczorajszego baseline’u. Pomiar rzeczywisty
zapisuje `artifacts/network-quality/krakow-benchmark.json`; skrypt
`benchmark:quality-city` przyjmuje pełny wycinek OSM i trzy lokalne archiwa GTFS.
