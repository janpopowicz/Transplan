import { BUS_VEHICLES, TRAM_VEHICLES, LINE_WIDTH_FREQUENCY_FACTOR, LINE_WIDTH_MAX_PX,
  LINE_WIDTH_MIN_PX, LINE_WIDTH_VEHICLE_BONUS_PX } from "../constants";
import type { TransitLine } from "../types";
import { peakTakt, tripsPerHourNum } from "./takt";

const lengths = {
  bus: BUS_VEHICLES.map((v) => parseFloat(v.id)),
  tram: TRAM_VEHICLES.map((v) => parseFloat(v.id)),
};

/** Frequency stays legible without letting frequent, long vehicles dominate
 * the map. Vehicle size is relative to its mode, with a small additive bonus. */
export function lineStrokeWidth(line: TransitLine): number {
  const frequency = tripsPerHourNum(peakTakt(line));
  if (!(frequency > 0)) return LINE_WIDTH_MIN_PX;
  const min = Math.min(...lengths[line.mode]), max = Math.max(...lengths[line.mode]);
  const length = parseFloat(line.vehicle);
  const size = Number.isFinite(length) ? Math.max(0, Math.min(1, (length - min) / (max - min))) : 0;
  return Math.min(LINE_WIDTH_MAX_PX, Math.max(LINE_WIDTH_MIN_PX, LINE_WIDTH_FREQUENCY_FACTOR * Math.sqrt(frequency))
    + LINE_WIDTH_VEHICLE_BONUS_PX * size);
}
