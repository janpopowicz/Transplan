import { NETWORK_ZOOM } from "../constants";
import type { DrawingState, EditorTool, InsertSlot } from "../types";

/** Editing always exposes individual platforms and both directional routes. */
export function isNetworkView(zoom: number, state: {
  selectedLineId: string | null;
  drawing: DrawingState | null;
  insertSlot: InsertSlot | null;
  tool: EditorTool;
}): boolean {
  return zoom < NETWORK_ZOOM && !state.selectedLineId && !state.drawing && !state.insertSlot &&
    state.tool !== "draw-bus" && state.tool !== "draw-tram" && state.tool !== "move-stop";
}
