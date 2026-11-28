import { readFileSync } from "node:fs";
import { expect, test } from "playwright/test";
import { MeshBasicMaterial } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Route } from "../src/game/route";
import { TrackCollision } from "../src/game/track-collision";
import { trackSurface } from "../src/game/track-surface";
import { DEFAULT_TUNING, KartVehicle } from "../src/game/vehicle";
import type { RouteData, RoutePoint } from "../src/types";

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
  /** Curvature preview distance for the optional keyboard controller. */
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
  const cruiseSpeed = 45;
  const minimumBendSpeed = 6;
  const coastBand = 2;
  const gripDeceleration = DEFAULT_TUNING.gripBrake / DEFAULT_TUNING.mass;
  // Cap approach speed using the distance to the edge of the preview, the
  // bend-speed floor and nominal grip deceleration (v² = vBend² + 2ad).
  const previewSpeedLimit = Math.sqrt(
    minimumBendSpeed ** 2 + 2 * gripDeceleration * curvatureLookahead,
  );
  const speedLimit = options.keyboard ? Math.min(cruiseSpeed, previewSpeedLimit) : cruiseSpeed;

  let hint = 0;
  let collisions = 0;
  let maxLateral = 0;
  let maxSlipRatio = 0;
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
    if ((state.suspension?.grounded ?? true) && Math.abs(state.speed) > 5) {
      maxSlipRatio = Math.max(
        maxSlipRatio,
        Math.abs(state.lateralSpeed) / Math.abs(state.speed),
      );
    }
    if (state.time > 1 && state.speed < -0.25) reversed = true;
    if (state.drifting || state.driftPhase !== "none") drifting = true;

    const speed = Math.hypot(state.speed, state.lateralSpeed);
    const lookahead = Math.min(22, 7 + speed * 0.55);
    const target = pointAhead(route.points, route.length, sample.segment, lookahead);
    const desiredYaw = Math.atan2(target.p[0] - state.x, target.p[2] - state.z);
    const error = wrapAngle(desiredYaw - state.yaw);
    const steer = options.keyboard
      ? error > 0.035
        ? 1
        : error < -0.035
          ? -1
          : 0
      : Math.max(-1, Math.min(1, error * 2.4));
    keyboardSteeringValues?.add(steer);
    const curvature = curvatureAhead(
      route.points,
      route.length,
      sample.segment,
      curvatureLookahead,
    );
    const routeYaw = Math.atan2(sample.forward[0], sample.forward[2]);
    const future = pointAhead(route.points, route.length, sample.segment, 30);
    const futureYaw = Math.atan2(future.f[0], future.f[2]);
    const bend = Math.abs(wrapAngle(futureYaw - routeYaw));
    const targetSpeed = Math.min(
      speedLimit,
      Math.max(minimumBendSpeed, cruiseSpeed - 28 * bend),
      Math.sqrt(120 / Math.max(0.02, curvature)),
    );
    // Use the planned speed as the keyboard driver's braking threshold, with
    // room to coast below it before reapplying full throttle.
    const throttleSpeed = options.keyboard ? targetSpeed - coastBand : targetSpeed;
    const brakeSpeed = options.keyboard ? targetSpeed : targetSpeed + coastBand;
    const throttle = speed < throttleSpeed ? 1 : 0;
    const brake = speed > brakeSpeed ? 1 : 0;
    const next = kart.step(0.01, { throttle, brake, steer });
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

for (const curvatureLookahead of [25, 40]) {
  test(`keyboard grip completes a clean village lap with ${curvatureLookahead} m curvature preview`, async () => {
    const result = await runGripLap("village", { keyboard: true, curvatureLookahead });
    expect(result.keyboardSteeringValues, "steering values sent to the kart")
      .toEqual(new Set([-1, 0, 1]));
    expectCleanGripLap(result, `GRIP_LAP_KEYBOARD_${curvatureLookahead}M`);
  });
}
