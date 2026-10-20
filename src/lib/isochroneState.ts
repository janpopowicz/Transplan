import { create } from "zustand";
import type { PeriodId } from "../constants";
import type { Coord } from "../types";

// Analysis settings are session-only; they are not part of the exported project.
export const useIsochroneState = create<{
  origin: Coord | null;
  period: PeriodId;
  maxMinutes: number;
  setOrigin: (origin: Coord | null) => void;
  setPeriod: (period: PeriodId) => void;
  setMaxMinutes: (minutes: number) => void;
}>((set) => ({
  origin: null,
  period: "wd_am",
  maxMinutes: 45,
  setOrigin: (origin) => set({ origin }),
  setPeriod: (period) => set({ period }),
  setMaxMinutes: (maxMinutes) => set({ maxMinutes }),
}));
