import { readFileSync } from "node:fs";
import { expect, test } from "playwright/test";
import { MeshBasicMaterial } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Route } from "../src/game/route";
import { TrackCollision } from "../src/game/track-collision";
import { trackSurface } from "../src/game/track-surface";
import { DEFAULT_TUNING, KartVehicle } from "../src/game/vehicle";
import type { RouteData, RoutePoint, RouteSample } from "../src/types";

const CRUISE_SPEED = 45;
const COAST_BAND = 2;
const DRIVER_TIMESTEP = 0.01;
const GRIP_BRAKE_DECELERATION = DEFAULT_TUNING.gripBrake / DEFAULT_TUNING.mass;

function wrapAngle(angle: number) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function loadRoute(track: string) {
  const file = new URL(`../public/assets/tracks/${track}/route.json`, import.meta.url);
  return new Route(JSON.parse(readFileSync(file, "utf8")) as RouteData);
}

async function loadCollision(track: string) {
  const folder = new URL(`../public/assets/tracks/${track}/`, import.meta.url);
  const scene = readFileSync(new URL("track.gltf", folder), "utf8");
  const binary = readFileSync(new URL("track.bin", folder));
  const loader = new GLTFLoader().register(parser => ({
    name: "localGripLapGeometry",
    loadBufferView: async index => {
      const view = parser.json.bufferViews[index];
      const start = view.byteOffset ?? 0;
      return Uint8Array.from(binary.subarray(start, start + view.byteLength)).buffer;
    },
    loadMaterial: async index => new MeshBasicMaterial({ name: parser.json.materials[index].name }),
  }));
  return new TrackCollision(await loader.parseAsync(scene, ""), track);
}

function pointAhead(points: RoutePoint[], length: number, index: number, metres: number) {
  let next = index;
  let distance = 0;
  while (distance < metres) {
    const current = points[next % points.length];
    const following = points[(next + 1) % points.length];
    distance += (following.s - current.s + length) % length;
    next += 1;
  }
  return points[next % points.length];
}

function curvatureAhead(points: RoutePoint[], length: number, index: number, metres: number) {
  let next = index;
  let distance = 0;
  let curvature = 0;
  while (distance < metres) {
    curvature = Math.max(curvature, Math.abs(points[next % points.length].curvature));
    const current = points[next % points.length];
    const following = points[(next + 1) % points.length];
    distance += (following.s - current.s + length) % length;
    next += 1;
  }
  return curvature;
}

function cornerSpeedSquared(curvature: number) {
  // The exported curvature measures the local change in tangent angle.
  return 120 / Math.max(0.02, Math.abs(curvature));
}

function keyboardTargetSpeed(
  route: Route,
  { segment, s }: Pick<RouteSample, "segment" | "s">,
  speed: number,
  lookahead: number,
) {
  const stoppingDistance = speed ** 2 / (2 * GRIP_BRAKE_DECELERATION);
  const preview = Math.max(lookahead, stoppingDistance + speed * DRIVER_TIMESTEP);
  const current = route.points[segment];
  const next = route.pointAt(segment + 1);
  const distanceFrom = (s - current.s + route.length) % route.length;
  const distanceTo = (next.s - s + route.length) % route.length;
  const fraction = distanceFrom / (distanceFrom + distanceTo || 1);
  const curvature = current.curvature + (next.curvature - current.curvature) * fraction;
  let allowedSpeedSquared = Math.min(CRUISE_SPEED ** 2, cornerSpeedSquared(curvature));

  // Work backwards from each sampled corner speed along the route arc.
  for (let offset = 1; offset < route.points.length; offset++) {
    const point = route.pointAt(segment + offset);
    const distance = (point.s - s + route.length) % route.length;
    if (distance > preview) break;
    allowedSpeedSquared = Math.min(
      allowedSpeedSquared,
      cornerSpeedSquared(point.curvature) + 2 * GRIP_BRAKE_DECELERATION * distance,
    );
  }
  return Math.sqrt(allowedSpeedSquared);
}

function analogTargetSpeed(route: Route, sample: RouteSample, lookahead: number) {
  const curvature = curvatureAhead(route.points, route.length, sample.segment, lookahead);
  const routeYaw = Math.atan2(sample.forward[0], sample.forward[2]);
  const future = pointAhead(route.points, route.length, sample.segment, 30);
  const futureYaw = Math.atan2(future.f[0], future.f[2]);
  const bend = Math.abs(wrapAngle(futureYaw - routeYaw));
  return Math.min(
    CRUISE_SPEED,
    Math.max(6, CRUISE_SPEED - 28 * bend),
    Math.sqrt(cornerSpeedSquared(curvature)),
  );
}

function keyboardSteer(error: number, lateralSpeed: number, slipRatio: number) {
  const steer = Math.abs(error) > 0.035 ? Math.sign(error) : 0;
  // Full lock opposite the lateral velocity adds body slip. Release it before
  // the slip limit, while still allowing steering back toward the velocity.
  return slipRatio >= 0.21 && steer * lateralSpeed < 0 ? 0 : steer;
}

/**
 * 2004 C simulation, production grip constants, flat ground, 25 m/s entry,
 * full left lock and throttle for 1.5 s. The car scrubs hard but never enters
 * the drift state. The old 0.12 slip ceiling was a Web-only fit and disagreed
 * with the recovered tire model (0.903 peak here).
 */
const GRIP_TURN_ORACLE = {
  maxSlipRatio: 0.903,
  maxYawRate: 1.535,
} as const;

test("grip throttle stays straight and repeated steering reverses cleanly", () => {
  const kart = new KartVehicle({ speed: 0 });
  for (let frame = 0; frame < 500; frame++) {
    kart.step(0.01, { throttle: 1 });
  }
  expect(kart.state.yaw).toBeCloseTo(0, 4);
  expect(kart.state.x).toBeCloseTo(0, 3);

  for (const steer of [-1, 1, -1, 1]) {
    for (let frame = 0; frame < 20; frame++) {
      kart.step(0.01, { throttle: 1, steer });
    }
  }
  const yawBeforeLeft = kart.state.yaw;
  for (let frame = 0; frame < 150; frame++) {
    kart.step(0.01, { throttle: 1, steer: -1 });
  }
  expect(kart.state.yaw).toBeLessThan(yawBeforeLeft - 0.2);
});

test("a sustained grip turn keeps lateral slip bounded", () => {
  const kart = new KartVehicle({ speed: 25 });
  let maxRatio = 0;
  let maxYawRate = 0;
  let previousYaw = kart.state.yaw;
  for (let frame = 0; frame < 150; frame++) {
    const state = kart.step(0.01, { throttle: 1, steer: -1 });
    maxRatio = Math.max(
      maxRatio,
      Math.abs(state.lateralSpeed) / Math.max(1, Math.abs(state.speed)),
    );
    maxYawRate = Math.max(maxYawRate, Math.abs(wrapAngle(state.yaw - previousYaw) / 0.01));
    previousYaw = state.yaw;
  }
  expect(maxRatio).toBeLessThanOrEqual(GRIP_TURN_ORACLE.maxSlipRatio + 0.1);
  expect(maxYawRate).toBeLessThanOrEqual(
    GRIP_TURN_ORACLE.maxYawRate + 0.2,
  );
  expect(kart.state.driftPhase).toBe("none");
});

interface GripLapOptions {
  /** Use only the discrete -1/0/1 values produced by keyboard steering. */
  keyboard?: boolean;
  /** Base curvature preview distance. Braking may require scanning farther. */
  curvatureLookahead?: number;
}

async function runGripLap(track: string, options: GripLapOptions = {}) {
  const route = loadRoute(track);
  const collision = await loadCollision(track);
  const start = route.points[0];
  const startHeight = collision.groundHeight(start.p[0], start.p[1], start.p[2]) ?? start.p[1];
  const sampler = {
    length: route.length,
    nearest: (x: number, z: number, hint = -1, height?: number) => {
      const sample = route.query(x, z, hint, height);
      return {
        x: sample.x,
        y: sample.y,
        z: sample.z,
        tangentX: sample.forward[0],
        tangentZ: sample.forward[2],
        rightX: sample.right[0],
        rightZ: sample.right[2],
        progress: sample.s,
        lateral: sample.lateral,
        segment: sample.segment,
      };
    },
  };
  const kart = new KartVehicle({
    position: { x: start.p[0], y: startHeight, z: start.p[2] },
    yaw: route.startYaw(),
    speed: 0,
    route: sampler,
    wallContactAt: collision.queryWall.bind(collision),
    groundHeightAt: (x, z, _progress, height, ceiling) =>
      collision.groundHeight(x, height, z, ceiling),
    surfaceAt: () => trackSurface(track),
  });

  const curvatureLookahead = options.curvatureLookahead ?? 25;
  let hint = 0;
  let collisions = 0;
  let maxLateral = 0;
  let maxSlipRatio = 0;
  let maxCruiseSpeed = 0;
  let lapTime = Infinity;
  let firstCollision = "";
  let reversed = false;
  let drifting = false;
  const keyboardSteeringValues = options.keyboard ? new Set<number>() : undefined;
  for (let frame = 0; frame < 32_000; frame++) {
    const state = kart.state;
    const sample = route.query(state.x, state.z, hint, state.y);
    hint = sample.segment;
    maxLateral = Math.max(maxLateral, Math.abs(sample.lateral));
    const slipRatio = (state.suspension?.grounded ?? true) && Math.abs(state.speed) > 5
      ? Math.abs(state.lateralSpeed) / Math.abs(state.speed)
      : 0;
    maxSlipRatio = Math.max(maxSlipRatio, slipRatio);
    if (state.time > 1 && state.speed < -0.25) reversed = true;
    if (state.drifting || state.driftPhase !== "none") drifting = true;

    const speed = Math.hypot(state.speed, state.lateralSpeed);
    const lookahead = Math.min(22, 7 + speed * 0.55);
    const target = pointAhead(route.points, route.length, sample.segment, lookahead);
    const desiredYaw = Math.atan2(target.p[0] - state.x, target.p[2] - state.z);
    const error = wrapAngle(desiredYaw - state.yaw);
    const steer = options.keyboard
      ? keyboardSteer(error, state.lateralSpeed, slipRatio)
      : Math.max(-1, Math.min(1, error * 2.4));
    keyboardSteeringValues?.add(steer);
    const targetSpeed = options.keyboard
      ? keyboardTargetSpeed(route, sample, speed, curvatureLookahead)
      : analogTargetSpeed(route, sample, curvatureLookahead);
    if (targetSpeed === CRUISE_SPEED) maxCruiseSpeed = Math.max(maxCruiseSpeed, speed);
    // Use the planned speed as the keyboard driver's braking threshold, with
    // room to coast below it before reapplying full throttle.
    const throttleSpeed = options.keyboard ? targetSpeed - COAST_BAND : targetSpeed;
    const brakeSpeed = options.keyboard ? targetSpeed : targetSpeed + COAST_BAND;
    const throttle = speed < throttleSpeed ? 1 : 0;
    const brake = speed > brakeSpeed ? 1 : 0;
    const next = kart.step(DRIVER_TIMESTEP, { throttle, brake, steer });
    if (next.collisionCount > collisions) {
      collisions = next.collisionCount;
      if (!firstCollision) {
        firstCollision = JSON.stringify({
          frame, s: sample.s, lateral: sample.lateral, speed: state.speed,
          side: state.lateralSpeed, yaw: state.yaw, steer, impact: next.impactSpeed,
        });
      }
    }
    if (next.lap >= 1) {
      lapTime = next.time;
      break;
    }
  }

  return {
    collisions,
    drifting,
    reversed,
    maxSlipRatio,
    maxLateral,
    maxCruiseSpeed,
    lapTime,
    firstCollision,
    keyboardSteeringValues,
    halfWidth: route.halfWidth,
    maxLapTime: route.length / 22 + 20,
  };
}

function expectCleanGripLap(
  result: Awaited<ReturnType<typeof runGripLap>>,
  label: string,
) {
  console.log(label, JSON.stringify({
    lapTime: result.lapTime,
    maxLapTime: result.maxLapTime,
    maxSlipRatio: result.maxSlipRatio,
    maxLateral: result.maxLateral,
    maxCruiseSpeed: result.maxCruiseSpeed,
    halfWidth: result.halfWidth,
    collisions: result.collisions,
    reversed: result.reversed,
    drifting: result.drifting,
  }));
  expect(
    result.collisions,
    `wall collisions${result.firstCollision ? `: ${result.firstCollision}` : ""}`,
  ).toBe(0);
  expect(result.drifting, "the acceptance lap must stay in grip mode").toBe(false);
  expect(result.reversed, "the kart must not reverse during the lap").toBe(false);
  expect(result.maxSlipRatio, "maximum body slip ratio").toBeLessThan(0.25);
  expect(result.maxLateral, "maximum distance from the centreline")
    .toBeLessThan(result.halfWidth - 1.5);
  expect(result.lapTime, "completed lap time").toBeLessThan(result.maxLapTime);
}

test("a grip-only controller completes a clean village lap", async () => {
  const result = await runGripLap("village");
  expectCleanGripLap(result, "GRIP_LAP");
});

test("keyboard braking uses distance to a bend across the lap seam", () => {
  const route = new Route({
    length: 120,
    halfWidth: 10,
    points: [0, 20, 60, 95, 110].map<RoutePoint>(s => ({
      s,
      curvature: s === 0 ? 1 : 0,
      p: [0, 0, s],
      f: [0, 0, 1],
      u: [0, 1, 0],
    })),
  });
  const beforeBend = { segment: 2, s: 90 };
  const speedAt30m = Math.sqrt(120 + 2 * GRIP_BRAKE_DECELERATION * 30);
  const speedAt20m = Math.sqrt(120 + 2 * GRIP_BRAKE_DECELERATION * 20);

  expect(keyboardTargetSpeed(route, beforeBend, 10, 25)).toBe(CRUISE_SPEED);
  expect(keyboardTargetSpeed(route, beforeBend, 10, 40)).toBeCloseTo(speedAt30m, 8);
  expect(keyboardTargetSpeed(route, beforeBend, 44, 25)).toBeCloseTo(speedAt30m, 8);
  expect(keyboardTargetSpeed(route, { segment: 3, s: 100 }, 10, 25)).toBeCloseTo(speedAt20m, 8);
});

for (const curvatureLookahead of [25, 40]) {
  test(`keyboard grip completes a clean village lap with ${curvatureLookahead} m base preview`, async () => {
    const result = await runGripLap("village", { keyboard: true, curvatureLookahead });
    expect(result.keyboardSteeringValues, "steering values sent to the kart")
      .toEqual(new Set([-1, 0, 1]));
    expectCleanGripLap(result, `GRIP_LAP_KEYBOARD_${curvatureLookahead}M`);
    expect(result.maxCruiseSpeed, "actual speed on unrestricted straights")
      .toBeGreaterThan(CRUISE_SPEED - COAST_BAND - 1);
  });
}
