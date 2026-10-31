# Audyt bezpieczeństwa Transplan — 31.10.2026

## Ocena

**Przed publicznym wdrożeniem zalecam usunięcie A01–A03.** Obecny serwer można zatrzymać jednym nieuwierzytelnionym żądaniem. API pozwala również na nieograniczony przyrost danych i uruchamianie równoległych, dowolnych zapytań Overpass. Są to niezależne problemy dostępności.

Potwierdzono cztery błędy: trzy o wysokim ryzyku i jeden o średnim ryzyku. Dodatkowo opisano ryzyko zarządzania sekretami oraz brak ochrony przed osadzaniem strony. Skan npm wskazał trzy podatne pakiety; ich ocena kontekstowa znajduje się osobno poniżej. Nie potwierdzono przejęcia danych ani wykonania kodu przez napastnika.

## Zakres i ograniczenia

- Przegląd bieżącego katalogu roboczego, łącznie ze zmianami niezacommitowanymi i nowymi plikami `server/`. Bazowy HEAD: `ebe944864df11a71b936d49e7a04003b0ebc143f`. Sam audyt nie dotyczy wyłącznie tego commitu.
- React, import JSON, wyświetlanie mapy, synchronizacja, linki udostępniania, serwer Node, proxy, cache i zależności z `package-lock.json`.
- Kontrolowane próby na osobnych procesach i portach `127.0.0.1`, dane w katalogach tymczasowych, Overpass zastąpiony atrapą. Nie wykonywano testu przeciążeniowego usług publicznych ani istniejącej instancji aplikacji.
- Nie oceniano rzeczywistej konfiguracji reverse proxy, TLS, infrastruktury chmurowej, uprawnień produkcyjnego systemu plików, kopii zapasowych ani historii Git. Zewnętrzne limity lub filtrowanie mogą ograniczać skutki części problemów; nie ma ich w badanej aplikacji.
- Weryfikacja zależności: odczyt bazy npm i komunikatów producentów. Skan wzorców sekretów objął 102 pliki, bez znalezisk; nie jest to gwarancja braku sekretów.
- Audyt dodał wyłącznie materiały w `audit/2026-10-31/`. Nie wprowadza poprawek do kodu aplikacji ani zależności. Build odtworzył ignorowane artefakty `dist/` i `dist-server/`.

## Ustalenia

| ID | Ryzyko / priorytet | Problem | Dowód |
| --- | --- | --- | --- |
| A01 | Wysokie / P1 | Nieobsłużony błąd parsowania URL kończy proces Node | Osobna instancja kończy się kodem 1 po `GET //` |
| A02 | Wysokie / P1 | Nieograniczony anonimowy zapis i przechowywanie rewizji | 5 utworzeń, 5 aktualizacji, 6 rewizji pierwszej sieci, 1 294 460 B |
| A03 | Wysokie / P1 | Dowolne zapytania Overpass, brak limitu współbieżności i rozmiaru cache | 12 żądań → 12 równoległych pobrań i 12 plików |
| A04 | Średnie / P2 | Dodatni, zbyt mały takt powoduje niekończącą się pętlę | API 201 dla `1e-14`; obliczenie przerwane limitem czasu |
| A05 | Średnie / P2, ryzyko projektowe | Trwały sekret edycji w URL i pamięci lokalnej, bez rotacji | Potwierdzone w kodzie; nie odtwarzano kradzieży sekretu |
| A06 | Niskie / P3, zabezpieczenie dodatkowe | Brak ochrony dokumentu przed osadzaniem w ramce | Dokument bez CSP i X-Frame-Options |

### A01 — jedno żądanie może wyłączyć serwer

**Lokalizacja:** `server/index.mjs:18–19`, `server/gtfs.mjs:59–60`. Ten sam wzorzec parsowania przed obsługą błędów występuje w `server/geocode.mjs:8`, `server/overpass.mjs:32` i `server/networks.mjs:29`.

Łańcuch middleware odrzuca wyniki funkcji asynchronicznych przez `void`, bez `.catch()`. Pierwszy handler wykonuje `new URL(req.url, base)` przed swoim `try`. Request target `//` jest przyjmowany przez parser HTTP Node, ale konstruktor URL rzuca `ERR_INVALID_URL`. Nieobsłużone odrzucenie Promise kończy proces w badanym środowisku Node przy domyślnych ustawieniach.

**Odtworzenie:** lokalna instancja zbudowana bezpośrednio ze źródeł otrzymała `GET // HTTP/1.1`; zakończyła się kodem 1 z `ERR_INVALID_URL`. Nie są wymagane UUID sieci, token ani body. Warunek wdrożeniowy: takie żądanie musi dotrzeć do Node; reverse proxy może je wcześniej odrzucić.

**Skutek:** utrata dostępności całego procesu, zrywanie synchronizacji; automatyczny restart nie usuwa możliwości ponowienia ataku.

**Naprawa:** parsować i walidować request target w jednej kontrolowanej granicy błędów, zwracać 400 dla błędnego URL oraz przechwytywać odrzucenia każdego middleware. Nie polegać na globalnym `unhandledRejection` jako podstawowym mechanizmie obsługi żądań.

**Kryterium odbioru:** błędne targety HTTP nie kończą procesu; po odpowiedzi 400 kolejne poprawne żądanie działa. Powtórzyć na właściwym runtime i przez docelowe proxy.

### A02 — anonimowe wyczerpanie miejsca i kosztowne odczyty

**Lokalizacja:** `server/networks.mjs:12–24`, `51–61`, `72–85`.

Każdy klient może tworzyć kolejne sieci, uzyskując własne tokeny zapisu. Limit 10 MiB obejmuje tylko pojedynczy request. Każda aktualizacja pozostawia pełną kopię projektu w nowym pliku; brak limitu liczby sieci, łącznego rozmiaru danych, liczby rewizji, retencji oraz ograniczenia częstotliwości. Odczyt, w tym polling ze znaną rewizją, wylicza wszystkie pliki w katalogu przez `readdir`.

**Odtworzenie:** 5 anonimowych utworzeń projektu po około 129 kB i 5 kolejnych zapisów pierwszej sieci zostało przyjętych bez ograniczeń. Zostało 6 pełnych rewizji pierwszej sieci; łącznie 1 294 460 B danych. Próba była celowo mała i nie wyczerpywała dysku. Możliwość nieograniczonego powtarzania wynika z implementacji.

**Skutek:** zapełnienie wspólnego wolumenu, błędy zapisu wszystkich projektów, wzrost kosztu odczytów i kopii zapasowych. Napastnik nie potrzebuje dostępu do cudzej sieci.

**Naprawa:** wprowadzić globalne limity zajętości i liczby sieci, ograniczenia tworzenia/zapisów, limit rewizji i ich retencję, monitoring wolnego miejsca oraz kontrolowaną odmowę zapisu. Limity per IP powinny być uzupełnieniem limitów globalnych. Zastąpić skanowanie całej historii indeksem bieżącej rewizji, zachowując atomowość i obsługę kilku instancji.

**Kryterium odbioru:** przekroczenie limitów zwraca kontrolowane 429/odmowę pojemności, historia podlega retencji, a odczyt nie skaluje się z liczbą wszystkich starych rewizji.

### A03 — publiczny proxy Overpass umożliwia nadużycie zasobów

**Lokalizacja:** `server/overpass.mjs:28–30`, `40–60`, `66–75`; zapis cache `13–22`.

Serwer akceptuje dowolny parametr `data`, zamiast budować ograniczone zapytania na podstawie dozwolonych operacji aplikacji. Nie wymusza obszaru Krakowa. Współdzielenie pobierania i cooldown działają wyłącznie dla identycznego SHA-256 body: wystarczy dodać inny komentarz do zapytania. Brak globalnego limitu równoległych pobrań, rozmiaru odpowiedzi przed `response.text()`, zajętości cache i usuwania starych plików. Siedem dni oznacza świeżość, a nie usunięcie cache; mapa nieudanych kluczy `retryAfter` również nie ma limitu liczby wpisów.

**Odtworzenie:** 12 zapytań różniących się komentarzem spowodowało 12 równoległych wywołań atrapy upstream i utworzenie 12 plików cache. Wszystkie zostały zaakceptowane również z `Sec-Fetch-Site: cross-site`. Nie wykonano tych prób na rzeczywistym Overpass.

**Skutek:** zużycie pamięci, połączeń i dysku, obciążenie zewnętrznych dostawców oraz możliwa blokada adresu serwera. Formularz wysłany z obcej witryny może inicjować proste POST-y; brak CORS nie powstrzymuje samego wysłania takich żądań. Blokada cross-site jest dodatkiem — bezpośredni klient HTTP nadal może nadużywać API.

**Naprawa:** udostępnić nazwy dozwolonych operacji i walidowane parametry, konstruować query po stronie serwera, wymusić obszar i zakres danych. Dodać ograniczoną kolejkę z globalnym limitem współbieżności, limity ruchu, strumieniowy limit odpowiedzi, limit bajtów/wpisów cache, sprzątanie plików oraz wygaszanie wpisów błędów. Stałe adresy upstream są dobrą ochroną przed dowolnym SSRF; nie stwierdzono możliwości wyboru dowolnego hosta.

**Kryterium odbioru:** dowolne QL i nadmiar żądań są odrzucane; równoległość, odpowiedzi i cache mają egzekwowane limity również dla różnych kluczy.

### A04 — mały takt blokuje generowanie rozkładu

**Lokalizacja:** `src/lib/proposal.ts:59–60`, `src/lib/timetable.ts:282–291`, `src/components/TimetablePanel.tsx:21`.

Walidacja akceptuje każdą skończoną liczbę `takt > 0`, mimo że interfejs operuje na zdefiniowanych opcjach od 4 do 240 minut. Pętla generująca odjazdy zwiększa czas o takt bez budżetu liczby iteracji ani kontroli postępu. Dla `wd_night: 1e-14`, przy czasie 1380, dodawanie nie zmienia liczby zmiennoprzecinkowej: `1380 + 1e-14 === 1380`. Pętla stale dopisuje odjazdy.

**Odtworzenie:** spreparowany projekt został przyjęty przez `POST /api/networks` z 201. Bezpośrednie wywołanie rzeczywistego `buildDailyTimetable` po tej samej walidacji nie zakończyło się i zostało przerwane po 200 ms w osobnym procesie. Dowód obejmuje funkcję obliczeniową i akceptację API; nie wykonywano próby zawieszenia całej przeglądarki.

**Skutek:** użytkownik importujący taki projekt albo otwierający jego generowany rozkład może zablokować główny wątek przeglądarki i zużyć pamięć. Współedytor może wprowadzić takie dane do istniejącej sieci. Wymagana jest interakcja uruchamiająca odpowiednie obliczenie; samo wejście na stronę nie zostało wykazane jako wystarczające.

**Naprawa:** walidować takt względem `TAKT_OPTIONS` lub jednoznacznie ustalonego przedziału biznesowego. W obliczeniach niezależnie egzekwować maksymalną liczbę odjazdów i kontrolę postępu. Ustalić również limity liczby obiektów/wierzchołków, długości pól, czasów przejazdu i postojów, unikalności ID i dozwolonych pól. Import pliku powinien sprawdzać rozmiar przed `file.text()` (`src/store.ts:1095–1097`).

**Kryterium odbioru:** API i import odrzucają takt `1e-14`; funkcja obliczeniowa przerywa pracę również wtedy, gdy otrzyma błędne dane z pominięciem walidatora.

### A05 — ekspozycja i brak możliwości unieważnienia sekretu edycji

**Lokalizacja:** `src/lib/sharing.ts:10–23`, `src/lib/sharedSession.ts:23`, `77`; obsługa uprawnień `server/networks.mjs:55–58`, `72–76`.

To ryzyko przyjętego modelu uprawnień, a nie wykazane obejście autoryzacji. Sekret pozostaje w `?write=...` oraz w nazwie klucza `localStorage` kopii odzyskiwania. Otwarcie lub odświeżenie linku wysyła query do serwera i potencjalnych logów reverse proxy. Sekret pozostaje też w historii adresów. W aplikacji brak rotacji, unieważnienia i wygasania tokenu, więc ujawniony link zachowuje prawo zapisu do usunięcia sieci przez administratora.

`strict-origin-when-cross-origin` w HTML ogranicza Referer do origin przy żądaniach do innych origin. **Nie potwierdzono wycieku sekretu do zewnętrznych serwisów map/fontów.** `Referrer-Policy: no-referrer` jest ustawiane na odpowiedziach API, a nie na dokumencie, i nie usuwa sekretu z jego URL.

**Naprawa:** przenieść sekret linku do fragmentu URL, odczytać go po stronie klienta i usunąć z widocznego adresu po inicjalizacji; zaplanować przechowywanie potrzebne do ponownego otwarcia sesji. Nie umieszczać tokenu w nazwach trwałych kluczy storage. Dodać odrębne uprawnienie właściciela do rotacji/unieważnienia oraz politykę czasu życia. Zastosować `Referrer-Policy: no-referrer` na dokumencie i redakcję query/Authorization w logach. Sam fragment nie chroni przed skryptem działającym w tym samym origin.

### A06 — dokument można osadzić w obcej witrynie

**Lokalizacja:** `server/index.mjs:27–28`, `index.html`.

Odpowiedź dokumentu nie zawiera CSP z `frame-ancestors` ani `X-Frame-Options`. Brak ochrony przed clickjackingiem zwiększa ryzyko nakłonienia użytkownika do kliknięcia w kontrolki osadzonej aplikacji. Nie wykazano w ten sposób uzyskania tokenu ani modyfikacji cudzej sieci. Możliwość dostępu do danych w ramce zależy także od polityk storage przeglądarki.

**Naprawa:** ustawić `Content-Security-Policy: frame-ancestors 'none'` albo jawnie zatwierdzone originy. Docelową CSP dla skryptów, workerów i map wprowadzić po sprawdzeniu działania MapLibre. Ocenić HTTPS/HSTS na faktycznym terminatorze TLS; kod serwera HTTP nie dowodzi braku TLS we wdrożeniu.

## Zależności — alerty wymagające aktualizacji, z oceną osiągalności

Pełny wynik: [npm-audit.json](npm-audit.json). `npm audit` zgłasza **1 critical i 2 high**, co opisuje pakiety, a nie trzy potwierdzone ścieżki ataku w Transplan.

| Pakiet z lockfile | Alert npm | Zastosowanie w tej aplikacji | Zalecenie |
| --- | --- | --- | --- |
| `maplibre-gl@5.24.0` | Critical, GHSA-jrc7-96c5-q579 | XSS dotyczy niezaufanego HTML atrybucji. Styl i atrybucja są stałe (`src/components/MapView.tsx:17–28`), nazwy w tooltipach są escapowane (`651–658`). Nie znaleziono ścieżki od projektu do podatnego HTML atrybucji. | Zaplanować aktualizację do zgodnej wersji z poprawką; producent wskazuje minimum 6.4.1, co wymaga migracji głównej wersji. Sprawdzić mapę i popupy. |
| `vite@7.3.6` | High, 5 advisories | Zależność developerska. `server.host: true` udostępnia dev server na interfejsach sieciowych. Alerty obejmują m.in. odczyt plików na nie-Windows i funkcje edytora; część wymaga Windows lub dodatkowych warunków. Produkcyjny `npm start` uruchamia własny serwer, bez Vite. Nie potwierdzono spełnienia wszystkich warunków konkretnego exploitu. | Zaktualizować co najmniej do 7.3.7 i ponownie sprawdzić cały zestaw alertów. Ograniczyć dev server do loopback, gdy dostęp z LAN nie jest potrzebny. |
| `source-map-js@1.2.1` | High, GHSA-68fv-2mgg-jv7q | Zależność przez `vite → postcss`, używana w narzędziach budowania. DoS wymaga przetwarzania złośliwej mapy źródeł; nie znaleziono publicznego API przyjmującego takie mapy. | Zaktualizować zależność pośrednią do minimum 1.2.2 i odświeżyć lockfile. |

Źródła producentów: [MapLibre — podatność i poprawka](https://github.com/maplibre/maplibre-gl-js/security/advisories/GHSA-jrc7-96c5-q579), [Vite — warunki odczytu plików i poprawione wersje](https://github.com/vitejs/vite/security/advisories/GHSA-rq7h-c2jc-7f22), [source-map-js — wydanie 1.2.2 z poprawką DoS](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2). Pozostałe identyfikatory Vite są w surowym wyniku npm. Nie zalecam bezwarunkowego `npm audit fix --force`; aktualizacja MapLibre wymaga weryfikacji zgodności.

## Sprawdzone zabezpieczenia

- UUID v4 generowane kryptograficznie; oddzielne uprawnienia odczytu i zapisu.
- Serwer przechowuje SHA-256 tokenu i porównuje go przez `timingSafeEqual`; GET nie ujawnia tokenu ani jego skrótu.
- Kontrola autoryzacji PUT działa niezależnie od blokad interfejsu. Próby zapisu bez praw są objęte testami.
- Walidacja UUID ogranicza ścieżki dostępu do danych, statyczny serwer sprawdza granicę katalogu. W przejrzanym kodzie nie znaleziono potwierdzonego path traversal.
- Limit pojedynczego body JSON działa również dla odczytu strumieniowego. Zapis wymaga JSON i odrzuca cross-site przez Fetch Metadata.
- Atomowe publikowanie rewizji oraz numery wersji chronią przed cichym nadpisywaniem przy współbieżnych zapisach.
- React i jawne escapowanie tekstu popupów ograniczają XSS. Nie znaleziono bezpośredniego wstrzyknięcia HTML z nazw przystanków.
- Pobieranie archiwów GTFS używa stałych URL HTTPS, a `unzip` jest uruchamiany przez `execFile` z tablicą argumentów. Nie znaleziono w tych ścieżkach wejścia użytkownika do powłoki.
- Geokoder ma limit długości zapytania, czasu odpowiedzi, częstości wywołań i liczby wpisów cache. GTFS ma współdzielenie pobrań i cooldown.

## Weryfikacja i materiały

- `npm test`: **145/145 PASS**. Pierwszy przebieg w sandboxie miał 13 błędów otwierania portów `EPERM`; ponowny przebieg z dostępem do lokalnych portów przeszedł w całości. Wynik: [tests.log](tests.log).
- `npm run build`: **PASS** dla TypeScript, klienta i bundla serwera. Vite ostrzega o Node 22.6.0 — wymagane przez projekt minimum to 22.12+ lub 20.19+. Należy ujednolicić runtime i powtórzyć weryfikację. Wynik: [build.log](build.log).
- Próby bezpieczeństwa: [reproduce.mjs](reproduce.mjs), wynik [reproduction.json](reproduction.json). Uruchomienie: `node audit/2026-10-31/reproduce.mjs`. Skrypt używa katalogów tymczasowych, loopback i atrapy Overpass; zatrzymuje tylko własne procesy. Celowo oczekuje obecnych podatności, więc po naprawach część asercji powinna przestać przechodzić. Nie jest zestawem testów regresji dla poprawionej aplikacji.
- Po poprawkach: dodać testy oczekujące bezpiecznych odpowiedzi, powtórzyć testy funkcjonalne i skan npm. Najpierw A01, następnie limity/retencja A02–A03, walidacja i budżety obliczeń A04, potem sekrety, zależności i nagłówki.
