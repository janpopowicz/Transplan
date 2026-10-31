import { create } from "zustand";
import type { JourneyPoint } from "./journey";
import type { ServiceDay } from "./timetable";
export const useJourneyState = create<{
  points: [JourneyPoint | null, JourneyPoint | null]; picking: 0 | 1 | null; day: ServiceDay; time: string;
  setPoint: (index: 0 | 1, point: JourneyPoint | null) => void;
  setPicking: (index: 0 | 1 | null) => void; setDay: (day: ServiceDay) => void; setTime: (time: string) => void; swap: () => void;
}>((set) => ({
  points: [null, null], picking: 0, day: "weekday", time: "08:00",
  setPoint: (index, point) => set((state) => {
    const points = [...state.points] as typeof state.points; points[index] = point;
    return { points, picking: point && !points[1 - index] ? (1 - index) as 0 | 1 : null };
  }),
  setPicking: (picking) => set({ picking }), setDay: (day) => set({ day }), setTime: (time) => set({ time }),
  swap: () => set((state) => ({ points: [state.points[1], state.points[0]], picking: null })),
}));
