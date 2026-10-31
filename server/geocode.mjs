const BBOX = [19.68, 49.92, 20.28, 50.18];
/** Explicit place searches only; bounded, cached and rate-limited upstream. */
export function createGeocodeHandler({ fetchImpl = fetch, now = Date.now,
  endpoint = process.env.TRANSPLAN_GEOCODER_URL || "https://photon.komoot.io/api/" } = {}) {
  const cache = new Map();
  let nextRequest = 0;
  return async (req, res, next = () => {}) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== "/geocode") return next();
    const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(body)); };
    if (req.method !== "GET") return send(405, { error: "Dozwolone jest tylko wyszukiwanie GET." });
    const q = (url.searchParams.get("q") || "").trim();
    if (q.length < 3 || q.length > 160) return send(400, { error: "Wpisz od 3 do 160 znaków." });
    const key = q.toLocaleLowerCase("pl");
    const cached = cache.get(key);
    if (cached && now() - cached.time < 86400000) return send(200, cached.places);
    if (now() < nextRequest) return send(429, { error: "Poczekaj chwilę przed kolejnym wyszukiwaniem." });
    nextRequest = now() + 1000;
    try {
      const target = new URL(endpoint);
      target.searchParams.set("q", q); target.searchParams.set("limit", "6");
      target.searchParams.set("bbox", BBOX.join(","));
      target.searchParams.set("lat", "50.0614"); target.searchParams.set("lon", "19.9372");
      const response = await fetchImpl(target, { signal: AbortSignal.timeout(10000), headers: {
        "User-Agent": "Transplan/1.0 (Krakow transit network planner; explicit place search)", "Accept": "application/json",
      } });
      if (!response.ok) throw new Error("Geocoder unavailable");
      const data = await response.json();
      const places = (Array.isArray(data.features) ? data.features : []).flatMap((feature) => {
        const coord = feature.geometry?.coordinates, p = feature.properties || {};
        if (!Array.isArray(coord) || coord.length !== 2 || !coord.every(Number.isFinite) || coord[0] < BBOX[0] || coord[0] > BBOX[2] || coord[1] < BBOX[1] || coord[1] > BBOX[3]) return [];
        const address = [p.street, p.housenumber].filter((v) => typeof v === "string" || typeof v === "number").join(" ");
        const name = [...new Set([p.name, address, p.district, p.city].filter((v) => typeof v === "string" && v))].join(", ");
        return name ? [{ name, coord }] : [];
      }).slice(0, 6);
      if (cache.size >= 200) cache.delete(cache.keys().next().value);
      cache.set(key, { time: now(), places });
      return send(200, places);
    } catch { return send(502, { error: "Wyszukiwarka miejsc jest chwilowo niedostępna. Wybierz przystanek z listy lub wskaż punkt na mapie." }); }
  };
}
