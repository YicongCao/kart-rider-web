import { expect, test } from "playwright/test";
import { Route } from "../src/game/route";
import type { RouteData } from "../src/types";

test("route lateral offsets use the driver's right-hand basis", () => {
  const route = new Route({
    length: 20,
    halfWidth: 5,
    points: [
      { p: [0, 0, 0], f: [0, 0, 1], u: [0, 1, 0], s: 0, curvature: 0 },
      { p: [0, 0, 10], f: [0, 0, 1], u: [0, 1, 0], s: 10, curvature: 0 },
      { p: [0, 0, 20], f: [0, 0, 1], u: [0, 1, 0], s: 20, curvature: 0 },
    ],
  } satisfies RouteData);

  const right = route.query(2, 5);
  const left = route.query(-2, 5);

  expect(right.right[0]).toBeCloseTo(1, 9);
  expect(right.right[2]).toBeCloseTo(0, 9);
  expect(right.lateral).toBeCloseTo(2, 9);
  expect(left.lateral).toBeCloseTo(-2, 9);
});
