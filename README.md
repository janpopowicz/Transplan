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
Równolegle działają najwyżej dwa pobrania na proces. Każda odpowiedź ma limit 64 MiB,
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
