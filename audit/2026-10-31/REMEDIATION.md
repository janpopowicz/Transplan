# Naprawy po audycie — 31.10.2026

Zaimplementowano poprawki A01–A06 i aktualizacje zależności. Oryginalny raport i dowody
pozostają zapisem stanu sprzed zmian. Nie wykonywano wdrożenia ani migracji produkcyjnego katalogu danych.

| Ustalenie | Zmiana | Weryfikacja |
| --- | --- | --- |
| A01, wyłączenie procesu | Wspólna walidacja request target i nagłówków, kontrolowana odpowiedź 400, przechwytywanie błędów asynchronicznych, wydzielony start serwera | Surowe HTTP: `//`, błędny UTF-8 i kodowanie, traversal, podwójny Host. Kolejne żądanie działa; sprawdzono również gotowy bundle |
| A02, nieograniczony dysk | Globalny budżet 1 GiB/1000 sieci, retencja do 5 rewizji, blokada między procesami, rezerwacje przed zapisem, ograniczona kolejka, rate limiting, trwały wskaźnik bieżącej rewizji | Jednoczesne utworzenia przez dwa handlery oraz dwa osobne procesy, restart, migracja starych danych, retencja, 507 bez częściowego projektu |
| A03, dowolne query OSM | Wyłącznie `tram`, `roads`, `walking`; query i bbox budowane na serwerze, do 2 pobrań, 3 klucze cache, limit odpowiedzi 64 MiB, odrzucanie cross-site, sprzątanie starych kluczy | Niepoprawne operacje i obce originy nie trafiają upstream; wspólne pobieranie, limit współbieżności, anulowanie zbyt dużego strumienia |
| A04, złośliwy projekt | Ścisły schemat projektu i dopuszczalne takty; niezależne limity generowania odjazdów; sprawdzenie pliku przed odczytem | API/import odrzucają małe takty i nadmierne dane; funkcja obliczeniowa odrzuca mały takt nawet z pominięciem schematu |
| A05, sekrety edycji | Nowe linki z sekretem we fragmencie, czyszczenie URL po inicjalizacji, wartości w sessionStorage karty, klucze kopii odzyskiwania bez tokenu, osobny link właściciela, rotacja/unieważnienie i 30 dni ważności edycji | Stary token przestaje zapisywać po rotacji/wygaśnięciu/unieważnieniu; edytor nie może przejąć roli właściciela; czysty link podglądu nie przywraca praw z sesji |
| A06, osadzanie i nagłówki | CSP z `frame-ancestors 'none'`, X-Frame-Options DENY, strict-origin, nosniff, no-store na HTML | Sprawdzone na odpowiedziach rzeczywistego serwera produkcyjnego |
| Zależności | MapLibre 6.16.0 wraz ze zmianą importów na eksporty nazwane, Vite 7.3.7, source-map-js 1.2.2 | TypeScript, build klienta/serwera; npm audit: zero podatności |

## Walidacja po stronie serwera

Każdy handler HTTP, również montowany osobno w development/preview, przechodzi przez
`server/security.mjs`. Walidacja następuje przed użyciem wartości i przed żądaniem do dostawcy.
Nieznane pola i parametry oraz duplikaty są odrzucane.

| Wejście | Reguły |
| --- | --- |
| HTTP | Request target do 2048 znaków; poprawny origin-form i kodowanie UTF-8; brak znaków sterujących, backslash, zakodowanych separatorów ścieżki i segmentów `..`; kontrola Host i powtarzających się istotnych nagłówków |
| GET/HEAD | Bez body; parametry tylko z listy dozwolonej dla danej trasy |
| JSON | application/json z opcjonalnym charset=utf-8; poprawny UTF-8; brak kompresji body; limity również dla transferu chunked; kontrola Origin i Sec-Fetch-Site; budżet równoczesnego buforowania 40 MiB |
| POST /api/networks | Tylko `{ proposal }`; bez query; limit body 10 MiB, ścisły schemat projektu |
| GET /api/networks/:id | UUID v4; opcjonalny pojedynczy `revision` jako dodatnia bezpieczna liczba całkowita |
| PUT /api/networks/:id | Bearer UUID, prawidłowy skrót i data ważności; tylko `{ proposal, revision }`; ponowna autoryzacja pod blokadą po odczycie body |
| POST /api/networks/:id/access | Bearer właściciela; tylko `{ action: 'rotate' lub 'revoke' }`, do 128 B; jednorazowa ścieżka pozyskania właściciela dla starych sieci bez tej roli |
| POST /overpass | Tylko `{ kind: 'tram' lub 'roads' lub 'walking' }`, do 256 B; brak dowolnego QL lub dodatkowych parametrów |
| GET /geocode | Jeden `q`, 3–160 znaków po trim; brak sterujących znaków i dodatkowych parametrów |
| GET /api/gtfs | Wyłącznie opcjonalne `refresh=1`; brak dodatkowych i powtórzonych parametrów |
| Projekt | Dozwolone pola na wszystkich poziomach; limity długości i kolekcji, unikalne ID, zgodność pojazdu z trybem, poprawne współrzędne, geometrie i ich łączna złożoność, czasy 0–1440 min, kolory hex, dozwolone takty z TAKT_OPTIONS, okna i przesunięcia, powiązania linii i segmentów |
| Dane upstream | Strumieniowe limity odpowiedzi OSM/Photon/ZIP, brak przekierowań HTTP; walidacja elementów OSM, wyników geokodowania oraz projektów wynikowych GTFS; timeout procesów unzip; cache GTFS do 3 dziennych snapshotów |

Limity ruchu mają ograniczoną liczbę wpisów i nie ufają X-Forwarded-For. Domyślne wartości,
konfiguracja wieloinstancyjna i operacje administracyjne są opisane w README. Dodatkowy proxy
Valhalla w development został usunięty; fallback przeglądarki działa bezpośrednio tak jak wcześniej
w produkcji. Dev i preview nasłuchują domyślnie na loopback.

## Dowody

Weryfikacja na oficjalnym Node **22.23.4**, pobranym do `/tmp` po sprawdzeniu SHA-256;
systemowej instalacji Node nie zmieniono. `.nvmrc` wskazuje sprawdzoną wersję, a projekt wymaga Node 22.12+.

- **167/167 testów PASS**, w tym 22 nowe testy bezpieczeństwa: [after-tests.log](after-tests.log).
- **Build PASS**: TypeScript, Vite i bundle serwera: [after-build.log](after-build.log).
- **Test gotowego pakietu w 2 procesach PASS**: [after-production.log](after-production.log), skrypt `tests/production-smoke.mjs` / `npm run test:production` po buildzie.
- **npm audit: 0 podatności**: [after-npm-audit.json](after-npm-audit.json).

Pierwotny `reproduce.mjs` służy dokumentowaniu poprzednich podatności i celowo oczekuje
niebezpiecznego zachowania. Do weryfikacji poprawionej wersji używać testów aplikacji i testu
produkcyjnego opisanego powyżej.

## Uwagi do uruchomienia i migracji

- Budżet dysku jest wspólny dla instancji, a limity ruchu i pobrań upstream są per proces.
  Wspólny katalog musi obsługiwać atomowe mkdir, rename i hard link. Wszystkie instancje
  powinny mieć tę samą konfigurację limitów.
- Stare dane są liczone przed pierwszym nowym zapisem. Historyczne rewizje są przycinane
  przy następnym zapisie danej sieci; migracja nie usuwa hurtowo projektów. Rezerwacja
  przerwana awarią może zawyżyć zajętość — procedura przeliczenia po zatrzymaniu serwerów jest w README.
- Właściciel powinien zachować prywatny link zarządzania. Link zarządzania nie trafia do linku
  współedycji i pozostaje ważny po unieważnieniu uprawnień edytorów. Starsze sieci mogą uzyskać
  go przez udokumentowany endpoint zarządzania, używając dotychczasowego niewygasłego tokenu.
- Migracja starych kluczy odzyskiwania zachowuje niewysłane dane; przy niedostępnym lub pełnym
  storage nie usuwa jedynej kopii. Nowe klucze nigdy nie zawierają tokenów.
- Pierwszego requestu starego linku z tokenem w query nie da się cofnąć; należy redagować
  query i Authorization w istniejących logach reverse proxy. Nowe linki nie wysyłają sekretu w URL HTTP.
- TLS/HSTS i konfiguracja reverse proxy pozostają poza repozytorium i nie zostały zmienione.
  W późniejszej korekcie mapy wykonano automatyczny test WebGL w izolowanym Chromium
  z atrapami dostawców. Nie wykonywano prób przeciążenia usług publicznych.

## Korekta integracji mapy po naprawach bezpieczeństwa

`no-referrer` zastąpiono `strict-origin` w nagłówkach i HTML: kafelki OSM wymagają prawdziwego
Referer, a origin nie ujawnia query ani sekretów linków. Kafelki są pobierane przez klienta
bezpośrednio, z domyślnym cache HTTP. Cache GTFS pozostaje na serwerze.
Po aktualizacji MapLibre 6 worker musi być jawnie emitowany przez Vite — import
`maplibre-gl-worker.mjs?worker&url` i `setWorkerUrl` wskazują właściwy plik z hashem.
Dodano test tego artefaktu w pakiecie produkcyjnym i test WebGL w izolowanym Chromium,
z atrapami usług zewnętrznych. Szczegóły uruchomienia: `tests/README.md`.

Wynik korekty mapy: `npm test` 167/167 PASS; build PASS; test produkcyjny obejmuje
obecność workera, jego referencję w bundlu i JavaScript MIME. Browser QA development
i production potwierdził widoczne piksele czerwonej, niebieskiej i zielonej trasy, Referer
równy samemu origin i brak błędów JavaScript/CSP. Logi: `map-browser-dev.log`,
`map-browser-production.log`, `map-production.log`, `map-build.log`, `map-tests.log`.

Poprawiony pakiet uruchomiono również w istniejącej instancji na porcie 3000,
z zachowaniem jej środowiska, adresu nasłuchu i katalogu danych. Odpowiedź aktywnego serwera
potwierdza `Referrer-Policy: strict-origin`.
