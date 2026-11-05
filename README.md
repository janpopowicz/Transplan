# Transplan

Planowanie sieci komunikacji miejskiej w Krakowie.

## Uruchomienie

Wymagany Node.js 22.12+. Wersja użyta do weryfikacji: 22.23.4 (plik `.nvmrc`).

```sh
npm ci
npm run dev
```

Serwer deweloperski i `npm run preview` obsługują również API udostępniania.

Produkcja:

```sh
npm run build
npm start
```

Serwer obsługuje aplikację i API na `127.0.0.1:3000`. Do nasłuchu na innych interfejsach ustaw `HOST` (np. `0.0.0.0` w kontenerze). Konfiguracja: `PORT`, `HOST`
oraz `TRANSPLAN_DATA_DIR` (domyślnie `data/networks`, względem katalogu uruchomienia).
Katalog danych musi być zapisywalny i trwały między wdrożeniami. Przy kilku
instancjach musi być współdzielony i obsługiwać atomowe twarde dowiązania (hard links),
`mkdir` oraz atomowe zmiany nazw. Wszystkie instancje muszą używać tych samych limitów.
Blokada zapisu działa między procesami; jej odnowienie następuje co 10 s, a wygaszenie po 30 s.
Obrazy podkładu mapy przeglądarka pobiera bezpośrednio z `tile.openstreetmap.org`,
z normalnym cache HTTP zgodnym z nagłówkami OSM. Nie są proxyowane przez aplikację.
GTFS i jego archiwa nadal korzystają z trwałego cache serwera. Worker MapLibre jest osobnym,
wersjonowanym plikiem w `dist/assets`, emitowanym przez Vite razem z aplikacją.
Sam hosting statycznego `dist/` nie wystarczy: `/api/networks` wymaga serwera Node.
Torowiska, drogi i sieć piesza korzystają wyłącznie z `/overpass`, obsługiwanego
przez serwer w produkcji, development i preview. Przeglądarka nie wysyła zapytań
Overpass bezpośrednio do publicznych instancji. API przyjmuje wyłącznie JSON
`{ "kind": "tram" | "roads" | "walking" }`; query i obszar ustala serwer.
Równolegle działają najwyżej dwa pobrania na proces. Odpowiedzi mają limit 64 MiB dla dróg i torowisk oraz 192 MiB dla pełnego wycinka pieszego,
a cache przechowuje trzy stałe wycinki (nie tworzy wpisów dla dowolnych query).
Stare klucze cache są usuwane podczas pierwszego użycia nowej wersji. Wycinki OSM są kompresowane
i buforowane na dysku w `data/overpass` przez 7 dni
(`TRANSPLAN_OSM_CACHE_DIR` zmienia katalog). Starszy wycinek jest dostępny
od razu podczas odświeżania w tle. Przeglądarka zachowuje własny cache sieci
pieszej w IndexedDB, a worker ponownie wykorzystuje przygotowany graf.
Równoległe prośby o ten sam wycinek współdzielą pobieranie. Po błędzie źródła
serwer odczekuje 15 minut przed kolejną próbą; poprawna starsza kopia nadal działa.

Izochrony korzystają z konkretnych odjazdów generowanych z taktów, czasów
międzyprzystankowych i przesunięcia linii. W sekcji taktów można zmienić
**Przesunięcie odjazdów (min)** względem początku wybranej pory dnia i kierunku.
Domyślnie zwinięty **Generowany rozkład jazdy** ma wybór jednego stanowiska
i dnia (roboczy/weekend). Tabela godzin pokazuje wszystkie odjazdy w ciągu
całego dnia, z uwzględnieniem taktów i koordynacji poszczególnych pór.
Czasy jazdy pochodzą z projektu (GTFS lub ustawienia ręczne); import GTFS
dopasowuje do jego odjazdów edytowalne takty i przesunięcia. Takty wybranej pory obowiązują przez całą podróż,
również po końcu godzinnego okna. Ukryte linie nadal kursują.

Dla 120 momentów startu, co 30 sekund przez pierwszą godzinę wybranej pory,
szukamy najwcześniejszego dojazdu do każdego miejsca. Oczekiwanie zależy od
konkretnych godzin, więc można zdążyć lub nie zdążyć na przesiadkę. Wynik to
średnia, P90 (108. uporządkowana obserwacja), najlepszy lub najgorszy czas
spośród próbek. Statystyki są liczone osobno dla każdego miejsca i dotyczą
całych podróży. Najlepszy i najgorszy przypadek odnoszą się do próbek,
nie do wszystkich możliwych sekund startu. Dojścia i przesiadki prowadzą
po OSM między fizycznymi stanowiskami; grupowanie mapy nie daje darmowej przesiadki.

Osobna sekcja **Koordynuj z linią** tworzy bezpośrednią relację między parą
linii. Każda para ma własny najdłuższy ciąg wspólnych stanowisk, osobno w obu
kierunkach. Można połączyć 7A–7B na jednym odcinku i 7A–8 na innym, nawet gdy
wszystkie trzy linie nie mają wspólnego odcinka. Lewa lista rysuje łańcuszki
dokładnie między połączonymi parami; każdą relację można osobno odłączyć.

Dla równych taktów fazy na wejściu we wspólny odcinek różnią się o połowę taktu
(dwie linie co 10 min → wspólny takt 5 min). Gdy takty są wielokrotnościami,
rzadsza linia wpada w środek odpowiedniego odstępu częstszej. Solver uwzględnia
czas dojazdu obu linii do początku ich wspólnego odcinka i jednocześnie
spełnia relacje w całej połączonej sieci. Wybiera też odpowiedni naprzemienny
kurs, gdy kilka relacji tworzy cykl. Gdy w danej porze takty nie są swoimi
wielokrotnościami, ta relacja pozostaje nieaktywna. Sprzeczne cykle mają
jawnie oznaczony przybliżony przeplot. Różne czasy jazdy na wspólnym odcinku
mogą zmienić odstępy po drodze.

Pole przesunięcia w taktach pokazuje faktyczną fazę pierwszego stanowiska
wybranego kierunku i pory, po uwzględnieniu koordynacji. Jego zmiana przesuwa
cały rozkład tej linii oraz wszystkich linii połączonych z nią, w obu kierunkach
i wszystkich porach. Wzajemne przesunięcia i koordynacja na różnych odcinkach
pozostają zachowane. Edycja taktów i tras automatycznie przelicza przeplot.
Relacje i przesunięcia są zapisywane w projekcie, JSON i udostępnianej sieci.
Starsze grupy są nadal odczytywane i migrowane do relacji między parami.

Obliczenia wykorzystują jeden przygotowany graf pieszy, osobne czasy samego
marszu oraz przyrostowe wyszukiwanie dla kolejnych momentów startu. Worker
buforuje scenariusze dla ostatnich danych, więc ponowny wybór policzonego
scenariusza nie uruchamia symulacji od nowa.

Grubość linii na mapie korzysta z pierwiastka częstotliwości
szczytowej: `max(1,8; 1,75 × √(kursy/h))` px. To skala pośrednia między
logarytmem a proporcjonalnością do częstotliwości. Długość pojazdu dodaje
od 0 do 0,6 px, proporcjonalnie do rozmiaru w obrębie rodzaju transportu.
Najkrótszy autobus (8 m) i tramwaj (26 m) mają tę samą grubość przy tym samym
takcie. Wspólna skala dla widoku sieciowego i szczegółowego ma limit 8 px.

## Ukryta metryka jakości sieci

Silnik `src/lib/networkQuality.ts` i API udostępniają `weighted-isochrone-area-v1`.
Metryka nie ma elementów interfejsu i nie uruchamia się przy otwieraniu strony.
Wynik `scoreKm2` to ważona średnia powierzchni osiągalnej **z ważnych miejsc**
w 15, 30, 45 i 60 minut; większa wartość oznacza lepszą dostępność. Cztery progi
mają równe wagi. Dla każdego miejsca najpierw liczymy średni czas podróży
ze 120 momentów startu w pierwszej godzinie wybranej pory, tak samo jak izochrony
w scenariuszu „średni”. Następnie mierzymy powierzchnię pod każdym progiem.
To powierzchnia pola średnich czasów, a nie średnia 120 osobnych powierzchni.
Obliczenia dotyczą podróży od miejsca do otoczenia; kierunki tras mają znaczenie.

Katalog `src/lib/networkQualityPlaces.ts` zawiera 88 miejsc i 93 punkty z
`miejsca.txt`, współrzędne `[lon, lat]`, źródła OSM i uwagi do niejednoznacznych
nazw. Zwykłe miejsca mają wagę 1, „ważny” 2, „bardzo ważny” 3. Punkty AGH i UJ
Ruczaj dzielą wagę swojego kampusu; dwa kampusy UR dzielą wagę jednego wpisu.
Factory/Futura w Modlniczce jest liczone raz, a IKEA przy Conrada osobno.
Współrzędne są punktami reprezentatywnymi obiektów do weryfikacji, nie pomiarem
wejść. Źródło: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
ODbL; pozycje pobrane przez Photon 4 listopada 2026.

Powierzchnia jest przybliżana stałą siatką 100 × 100 m w obszarze `BBOX` projektu.
Liczone są unikalne komórki w korytarzach dróg pieszych OSM, o promieniu 80 m,
zgodnie z konwencją wizualizacji izochron. Nakładające się drogi nie powielają
powierzchni. Korytarz służy wyłącznie pomiarowi: nie tworzy przejść przez rzeki,
ściany ani odłączone ulice. Nie jest to powierzchnia pełnych działek ani
metryka ważona ludnością. Porównuj projekty przy tym samym katalogu, porze
i wycinku OSM; API zwraca wersję katalogu, czas danych pieszych i rozdzielczość.

Punkt łączy się z drogą do 150 m, a stanowisko do 80 m. Brak połączenia punktu
wnosi zero bez usuwania jego wagi z mianownika. `complete: false`,
`connectedWeight` i `places[].anchors` pokazują takie braki oraz odległość
przyłączenia. Odłączony od reszty miasta, ale poprawnie podłączony punkt nadal
ma własny obszar dostępny pieszo. `unconnectedStops` podaje braki stanowisk.
Ukryte linie kursują w obliczeniach, a pusta sieć ma wynik samego marszu.

API działa w development, preview i produkcji:

- `GET /api/network-quality/places` — katalog i jego wersja.
- `POST /api/network-quality`, JSON `{ "proposal": <projekt z eksportu JSON>, "period": "wd_am" }`
  — `202` z `id`, postępem i nagłówkiem `Location`.
- `GET /api/network-quality/<id>` — `202` podczas obliczeń, `200` z
  `{ "status": "done", "result": { "scoreKm2": ..., "weightedAreasKm2": [...], "places": [...] }, ... }`
  po zakończeniu albo `502` po nieudanym zadaniu. Nieznane/wygasłe ID zwraca `404`.

Przykład z wyeksportowanym projektem (wymaga `jq`):

```sh
jq '{proposal: ., period: "wd_am"}' projekt.json > /tmp/transplan-quality-request.json
curl -H 'Content-Type: application/json' --data-binary @/tmp/transplan-quality-request.json \
  http://127.0.0.1:5173/api/network-quality
# Następnie GET pod ścieżkę z Location / ID odpowiedzi.
```

Opcjonalne pole `"scale": "gtfs"` w POST dodaje `result.normalization`:
`score` jest bezwymiarowym indeksem, `baselineDate` datą baseline’u w strefie
Warszawy, a `baselineScoreKm2` i `walkingOnlyScoreKm2` zachowują wartości odniesienia.
Domyślne `"scale": "raw"` zwraca samo `scoreKm2` bez dodatkowych obliczeń.

Wydajność: graf jest przygotowywany raz dla wszystkich punktów (przycięte ślepe
drzewa, skrócone łańcuchy stopnia 2), a wyszukiwania wykonuje jądro WebAssembly
z `src/lib/native/meanRouting.c` (`npm run build:routing-kernel`, potrzebny tylko
clang). Dla dużych grafów do 4 workerów dzieli punkty, współdzieląc ten sam
przygotowany model; wynik jest identyczny z obliczeniem jednowątkowym. Cały
Kraków (93 punkty) liczy się ok. 24–28 s na i7-8650U przy pełnym taktowaniu;
na laptopie w trybie oszczędzania energii czasy rosną nawet trzykrotnie.

```text
indeks = 100 × (scoreKm2 − walkingOnlyScoreKm2)
             / (baselineScoreKm2 − walkingOnlyScoreKm2)
```

W ten sposób brak komunikacji miejskiej daje 0, sieć zaimportowana z dzisiejszego
GTFS daje 100, a poprawa ponad nią może dać więcej niż 100. Dostępność piesza
jest odejmowana z obu wartości. Dla okresu, w którym GTFS nie daje żadnej
poprawy nad marszem, indeks jest `null` z powodem `baseline-has-no-transit-gain`;
nie da się wtedy wyznaczyć niezerowej jednostki skali. Surowe km² pozostają dostępne.

Baseline korzysta z tego samego importera i cache co `/api/gtfs`, dla tego
samego dnia, okresu, katalogu miejsc i grafu OSM. Brak dzisiejszych danych daje
502 zamiast cichego użycia wczorajszej sieci. Pierwsza normalizacja wymaga
trzech obliczeń: samego marszu, GTFS oraz badanego projektu. Dwa zestawy
wartości referencyjnych są buforowane osobno od wyników projektów. Kolejne
projekty w tych samych warunkach wymagają jednego obliczenia. `phase` pokazuje
`walking-reference`, `gtfs-reference` lub `network`; postęp obejmuje wszystkie
potrzebne batche. Wersja GTFS i dzień wchodzą do klucza cache.

Jeden proces serwera uruchamia najwyżej jeden worker obliczeniowy, z limitem
15 minut na obliczenie jednej sieci. Powtórzone żądania trwającego zadania
współdzielą wynik. Inne zadanie
podczas obliczeń zwraca `429`. Cache mieści cztery wyniki przez 15 minut;
zmiana projektu, pory, katalogu przystanków lub pliku OSM zmienia klucz.
Zadania są lokalne dla procesu i znikają po restarcie; przy wielu instancjach
kieruj odpytywanie statusu do tej samej instancji. Zgłoszenia mają limit
6/min na klienta i 12/min na proces, odczyty 120/600. Walidacja projektu,
limity body i ochrona originu są takie same jak dla API zapisu.
Dane piesze współdzielą cache i pobieranie z `/overpass`, także podczas
odświeżania starszej kopii (`walkingStale` w odpowiedzi).

Batch przygotowuje raz rozkłady, przyłączenia przystanków, graf i geometrię
rastra. Obszary są liczone bez budowania wielokątów i linii GeoJSON; w pamięci
pozostaje tylko wynik bieżącego początku. Zwykłe izochrony grupują komórki
według pasm zamiast skanować cały raster osobno dla każdego pasma.

Pliki do sprawdzenia położeń:
`artifacts/network-quality/miejsca.kmz` i `miejsca.kml`. Kolory odpowiadają
wagom; opisy zawierają nazwy, wagę punktu, źródła i uwagi. Po zmianie katalogu
podnieś `NETWORK_QUALITY_CATALOG_VERSION` i wygeneruj je ponownie:

```sh
npm run export:quality-places
npm run benchmark:quality
# Dodatkowo porównanie geometrii i czasu ze źródłem izochron z HEAD:
npm run benchmark:quality -- --baseline
```

Benchmark używa syntetycznej sieci 1681 wierzchołków, 3280 odcinków,
12 początków i 120 próbek odjazdu. Przykładowy pomiar na Node 22.23.4:
pełne izochrony wszystkich początków 418 ms, metryka w batchu 56 ms
(około 7,5× szybciej). To pomiar syntetyczny, nie prognoza czasu dla pełnego
Krakowa. Porównanie starego i nowego wyznaczania konturów sprawdza identyczność
GeoJSON, pasm i metadanych dla gęstego oraz rzadkiego grafu.

Pomiar rzeczywistego Krakowa z 4 listopada 2026, na Intel Core i7-8650U
1,90 GHz i Node 22.23.4: **566,458 s (9 min 26 s)** dla wszystkich 88 miejsc /
93 punktów, okres `wd_am`, 120 momentów startu. Graf ma 849 404 wierzchołki
i 911 018 odcinków; GTFS daje 256 linii/wariantów, w tym 217 aktywnych w tej porze.
Wszystkie 93 punkty są podłączone, bez brakujących stanowisk. Pomiar obejmuje
przygotowanie grafu i rastra, bez cache wyniku. Import GTFS i parsowanie OSM
zajęły dodatkowo 31,716 s; pobieranie danych nie jest wliczone.

Referencja samego marszu zajęła **41,116 s**. Surowy baseline GTFS ma
108,7403875 km², sam marsz 18,6941 km²; normalizacja potwierdziła indeksy
odpowiednio **100** i **0**. Raporty i wyniki dla poszczególnych miejsc są w
`artifacts/network-quality/krakow-benchmark.json`,
`krakow-benchmark.result.json`, `krakow-normalization-benchmark.json`
i `krakow-normalization-benchmark.result.json`. Są to pomiary dwóch batchy
silnika; zimne żądanie normalizacji dodatkowo oblicza badany projekt.

Pełny pomiar na rzeczywistych danych można odtworzyć bez pobierania w skrypcie:

```sh
npm run benchmark:quality-city -- --walking walking.json --tram T.zip --bus A.zip \
  --mobilis M.zip --period wd_am --output artifacts/network-quality/krakow-benchmark.json
# Osobny pomiar samego marszu i przeliczenie otrzymanego baseline’u na indeks 100:
npm run benchmark:quality-city -- --walking walking.json \
  --baseline-result artifacts/network-quality/krakow-benchmark.result.json \
  --output artifacts/network-quality/krakow-normalization-benchmark.json
```

Raport rozdziela import/parsing od obliczeń oraz zapisuje liczbę punktów,
wierzchołków, linii, połączeń z drogami, wersję GTFS i parametry komputera.

## Planer przejazdu

Wybierz **Trasa**, wskaż start A i cel B na mapie albo wyszukaj przystanki,
adresy lub miejsca. Wybierz dzień i godzinę, a następnie **Znajdź trasę**.
Planer korzysta z linii projektu (także ukrytych), całodniowych odjazdów,
koordynacji i sieci pieszej OSM. Kolorowe odcinki pokazują przejazd, a przerywana
linia — marsz. Lista podaje godziny, przesiadki i oczekiwanie. Znaczniki A i B są domyślnie
przeciągalne. Po pierwszym wyszukaniu zmiana punktu, godziny lub dnia
automatycznie przelicza trasę (po krótkim opóźnieniu, aby nie liczyć każdego
ruchu suwaka). Godzinę można wpisać w formacie 24-godzinnym, przesuwać
przyciskami ±5/±15 minut albo suwakiem. **Teraz** ustawia godzinę i typ dnia
według strefy Europe/Warsaw.

Wyszukiwanie wybiera najwcześniejszy dojazd; przy równych godzinach preferuje
mniej przesiadek, następnie mniej marszu. Kurs kończy przejazd według pory,
w której odjechał z początku trasy, także po granicy kolejnej pory. Dojścia
łączą punkty z siecią pieszą do 150 m, a stanowiska do 80 m. Przy brakach
połączeń OSM planer pokazuje błąd zamiast prostej trasy przez przeszkody.
Rozkłady dotyczą wybranego typu dnia, bez opóźnień i kursów rozpoczynających
się następnego dnia; ostatnie kursy mogą dojeżdżać po północy.

Przystanki są wyszukiwane lokalnie. Przycisk **Szukaj miejsca** wysyła jawne
zapytanie przez `/geocode` do [Photon](https://github.com/komoot/photon/blob/master/docs/api-v1.md).
Serwer ogranicza obszar do Krakowa i okolic, buforuje wyniki przez dobę oraz
ogranicza zapytania do jednego na sekundę. Nie wysyła zapytań przy każdym
znaku. `TRANSPLAN_GEOCODER_URL` pozwala wskazać własny serwer Photon.
Korzystanie z publicznej instancji podlega jej [zasadom rozsądnego obciążenia](https://github.com/komoot/photon#demo-server).

## Wspólna sieć bez kont

Kliknij **Udostępnij**. Projekt staje się wspólną siecią, a jego UUID trafia do adresu przeglądarki. Sekrety pozostają w pamięci
aktualnej karty (`sessionStorage`); po inicjalizacji są usuwane z adresu. Dotychczasowy lokalny projekt pozostaje
pod adresem bez parametrów. Okno udostępniania pokazuje dwa stałe linki:

- **Podgląd na żywo**: `?network=<uuid>` — odczyt, bez prawa zapisu.
- **Wspólna edycja**: `?network=<uuid>#write=<secret-uuid>` — odczyt i zapis.

Właściciel otrzymuje dodatkowy prywatny **link zarządzania** `?network=<uuid>#owner=<secret-uuid>`.
Należy go zachować dla siebie. Pozwala on tworzyć nowy link edycji i unieważniać poprzedni
w oknie udostępniania. Edytorzy nie otrzymują tego uprawnienia. Link edycji wygasa po 30 dniach;
właściciel może go odnowić. Fragment po `#` nie jest wysyłany w żądaniu HTTP.
Starsze linki z `&write=` są nadal odczytywane i czyszczone po otwarciu, ale ich pierwsze
żądanie może pozostać w logach proxy — konfiguracja logów powinna pomijać query i Authorization.
Przejście zwykłym linkiem podglądu nie przywraca uprawnień z wcześniejszej sesji.

Wszystkie osoby korzystają z tej samej sieci. Zmiany zapisują się automatycznie,
a pozostali uczestnicy pobierają aktualizacje co sekundę. Odświeżenie strony
pobiera aktualny stan z serwera. Podgląd nie ujawnia sekretu edycji. Serwer
sprawdza sekret przy każdym zapisie; przechowuje tylko jego skrót SHA-256.
Posiadacz linku do edycji może też przekazać go kolejnym osobom.

Zapisy używają numerów wersji, aby uniknąć cichego nadpisywania nowszych zmian.
Niezależne zmiany różnych linii, przystanków i pól łączą się automatycznie.
Zmiana tego samego pola przez dwie osoby zatrzymuje zapis i pokazuje wybór
spornych zmian. Pozostałe, niesporne zmiany obu osób zostają zachowane.
Sekwencje przystanków, geometrie i tablice odcinków są łączone jako całość.
Podczas obliczania trasy synchronizacja czeka na zakończenie operacji.

Niewysłane zmiany edytora i ich wersja bazowa są zapisywane w przeglądarce,
aby można je było odzyskać po odświeżeniu lub chwilowym braku połączenia
(o ile przeglądarka pozwala zapisać dane). Stan synchronizacji jest widoczny
nad mapą. Przy zamykaniu strony z niewysłanymi zmianami pojawia się ostrzeżenie.

Nie ma kont ani listy publicznych sieci. Link podglądu pozostaje aktywny do usunięcia sieci;
link edycji ma ograniczony czas życia i może zostać unieważniony.
Katalog sieci zawiera kolejne wersje JSON oraz skrót sekretu edycji. Należy go
zachowywać między wdrożeniami; administrator może usunąć sieć wraz z jej katalogiem.
Maksymalny rozmiar pojedynczego zapisu to 10 MiB. Serwer i import JSON sprawdzają ścisły schemat,
rozmiary kolekcji, identyfikatory, współrzędne, czasy, kolory i dozwolone takty 4–240 min.
Nieznane pola i niepoprawne powiązania są odrzucane. Błędy importu należy poprawić w pliku;
serwer nie usuwa nieznanych pól po cichu.

## Limity bezpieczeństwa i API

Domyślna pojemność sieci to 1 GiB, do 1000 sieci i do 5 najnowszych rewizji każdej sieci
(wliczając bieżącą). `TRANSPLAN_MAX_STORAGE_BYTES`, `TRANSPLAN_MAX_NETWORKS` oraz
`TRANSPLAN_RETAINED_REVISIONS` zmieniają te limity. Przekroczenie pojemności zwraca 507.
Rezerwacje pojemności są zapisywane przed danymi, pod wspólną blokadą. Po awarii w trakcie
zapisu mogą pozostać ostrożnie zawyżone; po ręcznym usuwaniu sieci należy zatrzymać wszystkie
instancje, usunąć `data/networks/.budget.json` i uruchomić je ponownie, aby przeliczyć zajętość.
Nie usuwać pliku budżetu podczas działania serwerów. Istniejące katalogi są uwzględniane
w pierwszym przeliczeniu, a wskaźniki bieżących rewizji migrują się przy odczycie.
Stara historia jest przycinana przy kolejnym zapisie danej sieci.

Ograniczenia na minutę, odpowiednio na adres klienta / proces: tworzenie 10/60,
zapisy i zarządzanie linkami 120/600, odczyty sieci 600/6000, OSM i każde z pozostałych
API 60/300. Przekroczenie zwraca 429 z `Retry-After`. Serwer używa adresu połączenia TCP,
nie ufa `X-Forwarded-For`; za reverse proxy limity per adres dotyczą proxy. Dodatkowe limity
na krawędzi infrastruktury można ustawić dla rzeczywistego IP klienta. Limity ruchu są per proces,
limity dysku i liczby sieci są wspólne dla instancji korzystających z tego samego katalogu.
Jednoczesne buforowanie body JSON ma budżet 40 MiB, a kolejka zapisów ma najwyżej 8 pozycji.

Wszystkie endpointy sprawdzają URL, dozwolone i niepowtarzające się parametry query oraz
używane nagłówki. Zapisy wymagają poprawnego UTF-8 i `application/json`, odrzucają kompresję body,
obce originy i nadmiarowe pola. GET nie przyjmuje body. `revision` jest dodatnią bezpieczną
liczbą całkowitą, a `refresh` dopuszcza wyłącznie `1`. Serwer ma CSP, ochronę przed ramkami,
`nosniff` i `strict-origin`; HTML nie jest buforowany. Polityka Referer przekazuje
wyłącznie origin (bez ścieżki, query i sekretów), wymagany przez serwer kafelków OSM. HTTPS oraz HSTS należy skonfigurować
na produkcyjnym reverse proxy. Dev i preview domyślnie nasłuchują tylko na loopback.

Zarządzanie linkami: `POST /api/networks/<uuid>/access`, JSON `{ "action": "rotate" }`
lub `{ "action": "revoke" }`, z `Authorization: Bearer <owner-token>`. Starsza sieć bez właściciela
pozwala jednorazowo użyć aktualnego, niewygasłego tokenu edycji; odpowiedź przekazuje prywatny
`ownerToken`, który trzeba zachować. Starsze tokeny bez daty wygasają 30 dni po modyfikacji
pliku `access.json`. Nowe sieci nie pozwalają edytorowi przejąć roli właściciela.

Fallback routingu Valhalla/OSRM działa bezpośrednio w przeglądarce, tak jak dotychczas w produkcji.
Development nie wystawia już dodatkowego proxy `/valhalla`.

## Sprawdzenie

Stanowiska są importowane wyłącznie z oficjalnego **GTFS ZTP Kraków**:
MPK autobusy (`GTFS_KRK_A.zip`), Mobilis (`GTFS_KRK_M.zip`) i tramwaje
(`GTFS_KRK_T.zip`). OSM służy do dróg, torów i mapy.

Klucz scalania to dokładna nazwa `stop_name` oraz numer stanowiska
(`platform_code`, a w aktualnych plikach ZTP `stop_desc`). Wielkość liter,
polskie znaki i pełne nazwy mają znaczenie. Ten sam klucz łączy rekordy
różnych operatorów i rodzajów transportu niezależnie od odległości; inne numery
stanowisk pozostają osobne nawet w tym samym miejscu. Współrzędne pochodzą
z GTFS, z pierwszeństwem MPK przed Mobilis. Grupy przystankowe w widoku sieci
łączą stanowiska o tej samej nazwie bazowej w promieniu 250 m, również z różnymi
numerami i dla różnych rodzajów transportu. To grupowanie nie usuwa rekordów
z katalogu ani nie zmienia sekwencji stanowisk linii. Obsługa grupy w obu
kierunkach daje jedną kropkę na linię; obsługa w jednym kierunku daje strzałkę.
Ręczne grupy pozostają dostępne.

Ponowny import wymaga Node.js oraz `unzip`. Bez argumentów pobiera trzy
aktualne archiwa ZTP; można też podać trzy lokalne pliki w kolejności A/M/T:

```sh
node scripts/import-stops.mjs
# lub: node scripts/import-stops.mjs A.zip M.zip T.zip
npm run build
```

Wynik trafia atomowo do `public/stops.json`. Po imporcie kliknij
**Plik → Odśwież dane** lub przeładuj aplikację z pustym cache przystanków.
Katalog jest buforowany w przeglądarce przez 7 dni, a przycisk omija cache.
Nie ma automatycznego powrotu do przystanków OSM. Import z 31.10.2026 daje
**3285 unikalnych stanowisk** w skonfigurowanym obszarze z 4225 wierszy GTFS.

Importer przetwarza również `routes.txt`, `trips.txt` i `stop_times.txt`, zapisując
`public/gtfs-times.json`. Indeks obejmuje kolejne stanowiska w jednym kursie,
osobno dla kierunku A → B oraz rodzaju transportu. Czas to różnica między
odjazdem z A a przyjazdem do B; dla wielu przejazdów wybieramy medianę.
Uwzględniamy poprawną kolejność `stop_sequence` oraz godziny po północy,
np. `25:10:00`. Nie łączymy par przez pominięte przystanki ani między kursami.

Czasy nowych odcinków oraz istniejących odcinków automatycznych korzystają
najpierw z GTFS. Bez pasującej relacji aplikacja szacuje czas z długości trasy
i prędkości domyślnej. Edytor oznacza czasy rozkładowe jako **GTFS** i pokazuje
liczbę przejazdów w podpowiedzi. Czasy są zaokrąglane do pełnych minut,
minimum 1 min. Wartości wpisane ręcznie pozostają zachowane; przycisk ↻
przywraca czas z GTFS lub oszacowanie. Indeks z obecnych plików ma 3974 relacje.

Stare identyfikatory OSM są przechowywane jako aliasy do migracji zapisanych
linii. Opcjonalny czwarty argument skryptu przyjmuje dawny zrzut Overpass
wyłącznie do uzupełnienia aliasów. Ponowne importy zachowują dotychczasowe
aliasy. Zapisane przebiegi, czasy, lokalne propozycje, grupy i przesunięcia
pozostają zachowane. Używany przystanek, którego nie ma w GTFS, zostaje
lokalną propozycją projektu zamiast zerwać linię.

Panel przystanku pozwala przesunąć stanowisko oraz zmienić jego nazwę i typ
(autobus, tramwaj, autobus + tramwaj). Edycje są zapisywane w projekcie,
przetrwają odświeżenie katalogu i eksport/import oraz synchronizują się
w sieci współdzielonej. Identyfikatory i przebiegi istniejących linii pozostają
zachowane. Podgląd bez prawa edycji nie pozwala zmieniać przystanków.

Źródła: [GTFS ZTP Kraków](https://gtfs.ztp.krakow.pl/).
Aliasy migracji: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL.

```sh
npm test
npm run build
```

Testy współpracy uruchamiają lokalne serwery HTTP i sprawdzają uprawnienia,
równoległe zapisy, konflikty, podgląd, ponawianie oraz trwałość po restarcie.
Dodatkowe scenariusze edytora opisano w [tests/README.md](tests/README.md).

## Import bieżącej sieci GTFS

**Plik → Importuj bieżący GTFS** pobiera oficjalne pliki ZTP Kraków (T, A, M)
i pokazuje podgląd przed zastąpieniem linii. Przed importem pobierana jest kopia
obecnego projektu w JSON. Lokalne przystanki, przesunięte stanowiska, torowiska
i oznaczenia budowy pozostają w projekcie.

Import wybiera reprezentatywny dzień roboczy i sobotę z najbliższych 21 dni,
z uwzględnieniem `calendar_dates`; konkretne daty i wersje są w podglądzie.
Weekend przybliżamy sobotą. Dla każdego kierunku i okresu dobieramy takt
z opcji edytora (4–240 min) do mediany odstępów odjazdów, a przesunięcie co 0,5 min
minimalizuje błąd dopasowania do tej siatki. Wspólny takt linii bierze częstszy
z kierunków, po czym oba przesunięcia są ponownie dopasowywane do tego taktu.
Ramy kursowania ograniczają generowane odjazdy do obsługiwanej części okresu.
Noc ma osobne takty. To edytowalne przybliżenie, a nie kopia każdego kursu GTFS.
Włączenie taktu w wcześniej nieobsługiwanej porze uruchamia ją w całym okresie.

Wariant to uporządkowana lista stanowisk, niezależnie od `shape_id`
i błędnie powielonego `direction_id`.
Zostaje dominujący wariant każdego kierunku oraz pozostałe z przynajmniej
4 kursami i co najmniej 10% liczby kursów dominującego. Przeciwne kierunki
łączymy według krańcówek, także gdy źródło oznacza oba tym samym kierunkiem; regularne warianty dostają sufiksy A, B…
GTFS `shapes.txt` daje geometrię, a mediany czasów między kolejnymi odjazdami
— czasy odcinków. Zaimportowane czasy nie są nadpisywane globalnym cache czasów.
Brakujący lub niepasujący kształt daje jawnie policzone połączenie proste.
Trasy poza obszarem projektu są ograniczane do najdłuższego spójnego ciągu
stanowisk wewnątrz niego; nie łączymy przez brakujące przystanki poza granicą.
Tabor ma domyślnie 12 m dla autobusu i 33 m dla tramwaju.

Kropki przy tytułach **Tramwaje** i **Autobusy**, wyrównane do kropek
poszczególnych linii, ukrywają lub pokazują całą kategorię jednym kliknięciem,
niezależnie od filtra listy. Ukryte linie nadal kursują w obliczeniach.

GTFS zawiera rozkłady, bez pozycji GPS na żywo. API `/api/gtfs` buforuje wynik
przez 24 godziny w `data/gtfs`; przy zmianie dnia przelicza dobór dni rozkładu.
Archiwa ZIP ZTP (T, A, M) są przechowywane w `data/gtfs/archives` przez 24 godziny
i współdzielone przez import sieci, generowanie katalogu przystanków i indeksu czasów.
Nowy dzień nie wymaga ponownego pobrania świeżych ZIP-ów. Przy odświeżaniu serwer
wysyła ETag/Last-Modified, jeśli źródło je udostępniło, więc niezmieniony ZIP może
zostać potwierdzony odpowiedzią 304 bez transferu archiwum.
**Sprawdź aktualizacje** może sprawdzić źródło najwyżej raz na godzinę.
Równoległe żądania współdzielą pobranie, a awaria uruchamia 15-minutową przerwę
przed ponowieniem. Starsza poprawna kopia pozostaje dostępna podczas odświeżania
i awarii. `TRANSPLAN_GTFS_CACHE_DIR` zmienia katalog cache GTFS. Oba katalogi cache
powinny być trwałe między restartami i wdrożeniami. Można przygotować cache z CLI:

```sh
npm run import:gtfs
```

Duże projekty i pamięć podręczna mapy są kompresowane w pamięci przeglądarki;
JSON eksportu i udostępniania zachowuje zwykły format. Widok sieciowy wyszukuje
sąsiednie grupy w indeksie przestrzennym, a szerokość wspólnej wiązki ma limit
48 px, aby dziesiątki równoległych linii nie zasłaniały mapy.
