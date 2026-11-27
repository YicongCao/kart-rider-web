import type { RoadSurface } from "./vehicle";

const BASE_SURFACE: RoadSurface = {
  grip: 1,
  drag: 1,
  acceleration: 1,
  driftGauge: 1,
};

/**
 * Production road multipliers for each shipped track. Keep this shared
 * between the game and the deterministic acceptance harness so a test cannot
 * silently substitute grippier ice than the player actually drives on.
 */
export function trackSurface(trackId: string): RoadSurface {
  if (trackId === "ice") {
    return { grip: 0.64, drag: 0.9, acceleration: 0.94, driftGauge: 0.95 };
  }
  if (trackId === "desert") {
    return { grip: 0.94, drag: 1.03, acceleration: 1, driftGauge: 1 };
  }
  if (trackId === "forest") {
    return { grip: 0.97, drag: 1, acceleration: 1, driftGauge: 1 };
  }
  return BASE_SURFACE;
}
