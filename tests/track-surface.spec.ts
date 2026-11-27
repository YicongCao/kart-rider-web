import { expect, test } from "playwright/test";
import { trackSurface } from "../src/game/track-surface";

test("acceptance uses the same road multipliers as the shipped game", () => {
  expect(trackSurface("village")).toEqual({
    grip: 1,
    drag: 1,
    acceleration: 1,
    driftGauge: 1,
  });
  expect(trackSurface("desert")).toEqual({
    grip: 0.94,
    drag: 1.03,
    acceleration: 1,
    driftGauge: 1,
  });
  expect(trackSurface("forest")).toEqual({
    grip: 0.97,
    drag: 1,
    acceleration: 1,
    driftGauge: 1,
  });
  expect(trackSurface("ice")).toEqual({
    grip: 0.64,
    drag: 0.9,
    acceleration: 0.94,
    driftGauge: 0.95,
  });
});
