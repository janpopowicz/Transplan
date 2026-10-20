export const KRAKOW_CENTER: [number, number] = [19.9372, 50.0614];

/** Krakow metro area — includes Skawina, Wieliczka, Niepołomice, Zielonki */
export const BBOX = {
  south: 49.92,
  west: 19.68,
  north: 50.18,
  east: 20.28,
};

export const PERIODS = [
  {
    id: "wd_early",
    group: "weekday",
    label: "Wczesny ranek",
    short: "ranek",
    hours: "4:00–6:00",
  },
  {
    id: "wd_am",
    group: "weekday",
    label: "Szczyt poranny",
    short: "szczyt",
    hours: "6:00–9:00",
  },
  {
    id: "wd_mid",
    group: "weekday",
    label: "Międzyszczyt",
    short: "dzień",
    hours: "9:00–14:00",
  },
  {
    id: "wd_pm",
    group: "weekday",
    label: "Szczyt popołudniowy",
    short: "szczyt",
    hours: "14:00–18:00",
  },
  {
    id: "wd_eve",
    group: "weekday",
    label: "Wieczór",
    short: "wieczór",
    hours: "18:00–23:00",
  },
  {
    id: "we_morn",
    group: "weekend",
    label: "Rano",
    short: "rano",
    hours: "6:00–10:00",
  },
  {
    id: "we_day",
    group: "weekend",
    label: "Południe i popołudnie",
    short: "dzień",
    hours: "10:00–19:00",
  },
  {
    id: "we_late",
    group: "weekend",
    label: "Późny wieczór",
    short: "wieczór",
    hours: "19:00–23:00",
  },
] as const;

export type PeriodId = (typeof PERIODS)[number]["id"];

/** Standard Polish takt values (minutes), including 7.5 */
export const TAKT_OPTIONS = [4, 5, 6, 7.5, 8, 10, 12, 15, 20, 30, 40, 60] as const;

export const BUS_VEHICLES = [
  { id: "8m", label: "8 m", hint: "minibus / midi" },
  { id: "10m", label: "10 m", hint: "midi" },
  { id: "12m", label: "12 m", hint: "standard" },
  { id: "18m", label: "18 m", hint: "przegubowy" },
] as const;

export const TRAM_VEHICLES = [
  { id: "26m", label: "26 m", hint: "np. N8 / GT8" },
  { id: "33m", label: "33 m", hint: "np. NGT6 / EU8N" },
  { id: "42m", label: "42 m", hint: "np. NGT8 / Lajkonik" },
] as const;

export const LINE_COLORS = [
  "#c41e3a",
  "#1d4ed8",
  "#0f766e",
  "#b45309",
  "#7c3aed",
  "#be185d",
  "#0369a1",
  "#4d7c0f",
  "#9f1239",
  "#155e75",
  "#a16207",
  "#5b21b6",
  "#c2410c",
  "#1e3a8a",
  "#115e59",
  "#86198f",
  "#3f6212",
  "#9a3412",
  "#1e40af",
  "#854d0e",
];

export const AVERAGE_SPEED_KMH = { bus: 24, tram: 19 } as const;
export const DEFAULT_LAYOVER_MIN = 5;
export const STOP_PAIR_METERS = 90;
export const SNAP_METERS = 18;
export const INTERLINE_TOLERANCE_M = 28;
/** Maximum separation of routes/platforms sharing a network-view corridor. */
export const DIRECTION_COLLAPSE_M = 80;
/** Gap between parallel strokes on a shared corridor, in px. */
export const OFFSET_GAP_PX = 2.2;
/** Screen-space length of an offset lane-change at a node. */
export const OFFSET_BLEND_PX = 22;
export const OFFSET_BLEND_MIN_M = 12;
export const OFFSET_BLEND_MAX_M = 55;
/** Stay on the current graph edge while the point is this close. */
export const EDGE_STICK_M = 18;
/** Sample spacing when baking a parallel stroke. */
export const OFFSET_SAMPLE_M = 11;
/**
 * Stroke width (px) = peak trips/hour × vehicle length (m) × this factor.
 * Peak is the more frequent of the morning and afternoon takt.
 */
export const LINE_WIDTH_FACTOR = 0.05;
export const LINE_WIDTH_MIN_PX = 1.8;
export const LINE_WIDTH_MAX_PX = 26;
/** Below this zoom the map collapses into a network diagram. */
export const NETWORK_ZOOM = 13.5;
/** Same-name stops (Kraków platform numbers stripped) within this distance merge. */
export const STOP_GROUP_METERS = 420;

export const DEFAULT_TAKT: Record<PeriodId, number | null> = {
  wd_early: 20,
  wd_am: 15,
  wd_mid: 20,
  wd_pm: 15,
  wd_eve: 20,
  we_morn: 30,
  we_day: 20,
  we_late: 20,
};
