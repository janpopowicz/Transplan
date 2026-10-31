import type { ServiceDay } from "./timetable";
export function clockMinutes(value: string): number | null {
  const text = value.trim();
  const colon = /^(\d{1,2}):(\d{1,2})$/.exec(text);
  let hour: number, minute: number;
  if (colon) { hour = Number(colon[1]); minute = Number(colon[2]); }
  else if (/^\d{3,4}$/.test(text)) { hour = Number(text.slice(0, -2)); minute = Number(text.slice(-2)); }
  else if (/^\d{1,2}$/.test(text)) { hour = Number(text); minute = 0; }
  else return null;
  return hour >= 0 && hour < 24 && minute >= 0 && minute < 60 ? hour * 60 + minute : null;
}
export function clockString(minute: number) {
  const value = ((Math.round(minute) % 1440) + 1440) % 1440;
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}
export function warsawNow(date = new Date()): { time: string; day: ServiceDay } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Warsaw", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { time: `${part("hour")}:${part("minute")}`, day: ["Sat", "Sun"].includes(part("weekday")) ? "weekend" : "weekday" };
}
