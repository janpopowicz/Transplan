import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

// Compile the single source of truth without requiring Node's TS loader.
const compiled = await build({ entryPoints: ["src/lib/networkQualityPlaces.ts"], bundle: true,
  platform: "node", format: "esm", write: false });
const { NETWORK_QUALITY_PLACES: places, NETWORK_QUALITY_CATALOG_VERSION: version } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const xml = (value) => String(value).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
const data = (name, value) => `<Data name="${xml(name)}"><value>${xml(value)}</value></Data>`;
const folders = [...new Set(places.map((p) => p.category))].map((category) => `<Folder><name>${xml(category)}</name>${places.filter((p) => p.category === category).map((p) =>
  p.points.map((point, index) => `<Placemark id="${p.id}-${index + 1}"><name>${xml(p.name + (p.points.length > 1 ? ` — ${index + 1}/${p.points.length}` : ""))}</name>
<description>${xml(`${point.name}\nWaga miejsca: ${p.weight}; waga punktu: ${p.weight / p.points.length}\n${p.note ?? ""}\nŹródło: ${point.source}`)}</description><styleUrl>#weight${p.weight}</styleUrl>
<ExtendedData>${data("placeId", p.id)}${data("pointName", point.name)}${data("placeWeight", p.weight)}${data("anchorWeight", p.weight / p.points.length)}${data("source", point.source)}${data("catalogVersion", version)}${data("note", p.note ?? "")}</ExtendedData>
<Point><altitudeMode>clampToGround</altitudeMode><coordinates>${point.coord.join(",")},0</coordinates></Point></Placemark>`).join("\n")).join("\n")}</Folder>`).join("\n");
const styles = [[1, "ff00bbff"], [2, "ff0088ff"], [3, "ff4444ee"]].map(([weight, color]) =>
  `<Style id="weight${weight}"><IconStyle><color>${color}</color><scale>${weight === 3 ? 1.3 : 1}</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/wht-circle.png</href></Icon></IconStyle></Style>`).join("\n");
const kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Transplan — miejsca metryki jakości sieci</name><description>${xml(`Katalog ${version}: ${places.length} miejsc, ${places.reduce((n, p) => n + p.points.length, 0)} punktów. Wagi 1/2/3; punkty kampusu dzielą wagę miejsca. Współrzędne reprezentatywne do weryfikacji. © OpenStreetMap contributors, ODbL, https://www.openstreetmap.org/copyright`)}</description>${styles}${folders}</Document></kml>\n`;

/** Deterministic single-entry ZIP, using the standard ZIP headers and CRC-32. */
function kmz(text) {
  const name = Buffer.from("doc.kml"), raw = Buffer.from(text), compressed = deflateRawSync(raw), crc = crc32(raw);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt16LE(33, 12); // 1980-01-01; deterministic archive timestamps.
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt16LE(33, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22), offset = local.length + name.length + compressed.length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([local, name, compressed, central, name, end]);
}
const directory = resolve(process.argv[2] ?? "artifacts/network-quality");
await mkdir(directory, { recursive: true });
await writeFile(join(directory, "miejsca.kml"), kml);
await writeFile(join(directory, "miejsca.kmz"), kmz(kml));
console.log(`${places.length} miejsc, ${places.reduce((n, p) => n + p.points.length, 0)} punktów → ${directory}/miejsca.kmz`);
