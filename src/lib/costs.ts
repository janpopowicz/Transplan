import { PERIODS } from "../constants";
import type { TransitLine } from "../types";
import { lineLength } from "./geo";
import { nextDeparture } from "./timetable";

export const COST_PER_KM = { tram: 28.33, bus: 14.09 } as const;
export type ServiceDay = "weekday" | "weekend";

export function dailyLineCost(line: TransitLine, day: ServiceDay) {
  const routeKm = line.segments.reduce((total, segment) => total + lineLength(segment.geometry) / 1000, 0);
  let vehicleKm = 0;
  for (const period of PERIODS.filter((p) => p.group === day)) {
    const takt = line.takt[period.id];
    if (takt == null || !Number.isFinite(takt) || takt <= 0) continue;
    const [start, end] = period.hours.split("–").map((time) => {
      const [hours, minutes] = time.split(":").map(Number);
      return hours * 60 + minutes;
    });
    if (!line.serviceWindows) vehicleKm += routeKm * ((end - start + 1440) % 1440) / takt;
    else for (const direction of ["outbound", "inbound"] as const) {
      const window = line.serviceWindows[period.id]?.[direction];
      if (!window) continue;
      const phase = line.departureOffsets?.[period.id]?.[direction] ?? line.departureOffsetMin ?? 0;
      const first = nextDeparture(window[0],phase,takt);
      const count = Math.max(0,Math.ceil((window[1]-first-1e-8)/takt));
      const km = line.segments.filter((s) => s.direction === direction).reduce((sum,s) => sum+lineLength(s.geometry)/1000,0);
      vehicleKm += km*count;
    }
  }
  return { vehicleKm, cost: vehicleKm * COST_PER_KM[line.mode] };
}

export function dailyNetworkCost(lines: TransitLine[], day: ServiceDay) {
  return lines.reduce((total, line) => {
    const value = dailyLineCost(line, day);
    total.cost += value.cost;
    total.vehicleKm += value.vehicleKm;
    total[line.mode] += value.cost;
    return total;
  }, { cost: 0, vehicleKm: 0, bus: 0, tram: 0 });
}

export const formatMoney = (amount: number) => new Intl.NumberFormat("pl-PL", {
  style: "currency", currency: "PLN", maximumFractionDigits: 0,
}).format(amount);
