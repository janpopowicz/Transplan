import { create } from "zustand";
import type { PeriodId } from "../constants";
import type { AccessibilityScenario } from "./pedestrianRouting";
import type { Coord } from "../types";

// Analysis settings are session-only; they are not part of the exported project.
export const useIsochroneState = create<{
  origin: Coord | null;
  period: PeriodId;
  scenario: AccessibilityScenario;
  setScenario: (scenario: AccessibilityScenario) => void;
  setOrigin: (origin: Coord | null) => void;
  setPeriod: (period: PeriodId) => void;
}>((set) => ({
  origin: null,
  period: "wd_am",
  scenario: "mean",
  setScenario: (scenario) => set({ scenario }),
  setOrigin: (origin) => set({ origin }),
  setPeriod: (period) => set({ period }),
}));
