import { readFileSync } from "node:fs";
import { expect, test } from "playwright/test";
import { MeshBasicMaterial } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Route } from "../src/game/route";
import { TrackCollision } from "../src/game/track-collision";
import { KartVehicle, type VehicleInput, type VehicleOptions } from "../src/game/vehicle";
import type { RouteData, Vec3 } from "../src/types";

test("the first P3563 bend retains its speed profile and mirrors to the left", () => {
  // P3563 race-clock offsets from the 199 km/h entry frame, and HUD km/h.
  const speeds = new Map([[41, 196], [81, 179], [122, 160], [166, 151],
    [184, 147], [203, 152], [250, 168], [288, 177]]);
  const right = new KartVehicle({ speed: 199 / 3.6 });
  const left = new KartVehicle({ speed: 199 / 3.6 });
  for (let t = 0; t < 288; t++) {
    const steer = t < 63 ? -1 : t < 105 ? 1 : 0;
    const input = { steer, drift: t < 42, throttle: 1 };
    const r = right.step(0.01, input);
    const l = left.step(0.01, { ...input, steer: -steer });
    const target = speeds.get(t + 1);
    if (target === undefined) continue;
    const kmh = Math.hypot(r.speed, r.lateralSpeed) * 3.6;
    expect(Math.abs(kmh - target), `HUD at ${(t + 1) / 100}s`).toBeLessThan(9);
    expect(l.x).toBeCloseTo(-r.x, 6);
    expect(l.z).toBeCloseTo(r.z, 6);
    expect(l.yaw).toBeCloseTo(-r.yaw, 6);
  }
  const heading = -right.state.yaw * 180 / Math.PI;
  expect(heading).toBeGreaterThan(80);
  expect(heading).toBeLessThan(100);
  expect(right.state.drifting).toBe(false);
});

// A straight wall at x=0. Use the oriented footprint so a rotating bumper can
// touch the wall before the kart's centre reaches it.
const wall: NonNullable<VehicleOptions["wallContactAt"]> = (x, _y, _z, yaw, width, length) => {
  const depth = x + Math.abs(Math.cos(yaw)) * width + Math.abs(Math.sin(yaw)) * length;
  return depth > 0 ? { normalX: -1, normalZ: 0, depth } : null;
};

function driveAlongWall(kart: KartVehicle, frames: number, input: VehicleInput) {
  const { vehicleHalfWidth, vehicleHalfLength, collisionCenterForward } = kart.tuning;
  for (let i = 0; i < frames; i++) {
    const s = kart.step(1 / 60, input);
    const centerX = s.x + Math.sin(s.yaw) * collisionCenterForward;
    const contact = wall(centerX, s.y, s.z, s.yaw, vehicleHalfWidth, vehicleHalfLength);
    expect(contact?.depth ?? 0).toBeLessThan(0.00001);
  }
  return kart.state;
}

test("a glancing impact keeps the kart moving along the wall", () => {
  const kart = new KartVehicle({ position: { x: -1.3 }, speed: 24, yaw: 12 * Math.PI / 180, wallContactAt: wall });
  const state = driveAlongWall(kart, 42, { throttle: 1 });
  expect(state.collisionCount).toBe(1);
  expect(state.z).toBeGreaterThan(15);
  expect(state.speed).toBeGreaterThan(20);
});

test("the player can steer out of a head-on impact in either direction", () => {
  for (const steer of [-1, 1]) {
    const kart = new KartVehicle({ position: { x: -1.3 }, speed: 8, yaw: Math.PI / 2, wallContactAt: wall });
    const stopped = driveAlongWall(kart, 92, { throttle: 1 });
    expect(stopped.collisionCount).toBeGreaterThan(0);
    expect(Math.abs(stopped.speed)).toBeLessThan(1);
    const free = driveAlongWall(kart, 110, { steer, throttle: 1 });
    expect(-steer * free.z).toBeGreaterThan(5);
    expect(free.speed).toBeGreaterThan(10);
  }
});

test("a ramp launches the kart and landing compresses and settles the suspension", () => {
  const kart = new KartVehicle({
    speed: 20,
    groundHeightAt: (_x, z, _progress, height) => {
      if (z >= 6 && z < 9) return null;
      const ground = z < 6 ? Math.max(0, z - 1) * 0.18 : 0;
      return Math.abs(ground - height) < 4 ? ground : null;
    },
  });
  let sawLift = false;
  let landed = false;
  let peak = 0;
  let minimumHeave = 0;
  let launchYaw = 0;
  for (let frame = 0; frame < 200; frame++) {
    const state = kart.step(0.01, sawLift && !landed ? { throttle: 1, steer: 1, drift: true } : {});
    const ride = state.suspension!;
    if (!ride.grounded) {
      if (!sawLift) {
        sawLift = true;
        launchYaw = state.yaw;
        expect(ride.verticalSpeed).toBeGreaterThan(2);
        expect(ride.pitch).toBeGreaterThan(0.1);
      }
      peak = Math.max(peak, state.y);
      expect(state.yaw).toBeCloseTo(launchYaw, 6);
      expect(state.gauge).toBe(0);
      expect(state.drifting).toBe(false);
    } else if (sawLift) {
      landed = true;
      minimumHeave = Math.min(minimumHeave, ride.heave);
      expect(state.y).toBeCloseTo(0, 4);
    }
  }
  expect(peak).toBeGreaterThan(1.25);
  expect(landed).toBe(true);
  expect(minimumHeave).toBeLessThan(-0.03);
  expect(kart.state.suspension!.heave).toBeCloseTo(0, 3);
});

test("a one-sided bump articulates the wheels and resets clear the suspension impulse", () => {
  const kart = new KartVehicle({
    speed: 8,
    groundHeightAt: (x, z) => x > 0 ? 0.12 * Math.max(0, 1 - Math.abs(z - 2)) : 0,
  });
  let peakRoll = 0;
  let maxTravelDifference = 0;
  for (let frame = 0; frame < 60; frame++) {
    const { suspension } = kart.step(0.01, { throttle: 1 });
    peakRoll = Math.max(peakRoll, suspension!.roll);
    maxTravelDifference = Math.max(maxTravelDifference, Math.abs(suspension!.travel[0] - suspension!.travel[1]));
  }
  expect(peakRoll).toBeGreaterThan(0.035);
  expect(maxTravelDifference).toBeGreaterThan(0.04);
  kart.resetPose(0, 0, 0, 0);
  expect(kart.state.suspension).toMatchObject({ grounded: true, verticalSpeed: 0, pitch: 0, roll: 0, heave: 0 });
});

function loadRoute(track: string) {
  const file = new URL(`../public/assets/tracks/${track}/route.json`, import.meta.url);
  return new Route(JSON.parse(readFileSync(file, "utf8")) as RouteData);
}

async function loadCollision(track: string) {
  const folder = new URL(`../public/assets/tracks/${track}/`, import.meta.url);
  const scene = readFileSync(new URL("track.gltf", folder), "utf8");
  const binary = readFileSync(new URL("track.bin", folder));
  // Use the same scene loader as the race, resolving geometry from disk.
  const loader = new GLTFLoader().register(parser => ({
    name: "localCollisionGeometry",
    loadBufferView: async index => {
      const view = parser.json.bufferViews[index];
      const start = view.byteOffset ?? 0;
      return Uint8Array.from(binary.subarray(start, start + view.byteLength)).buffer;
    },
    loadMaterial: async index => new MeshBasicMaterial({ name: parser.json.materials[index].name }),
  }));
  return new TrackCollision(await loader.parseAsync(scene, ""), track);
}

test("the village straight stays open to its rail and its bridge has two drivable decks", async () => {
  const collision = await loadCollision("village");
  for (const side of [-1, 1]) {
    const contact = (offset: number) =>
      collision.queryWall(143.64 + side * offset, 26.85, -525, Math.PI, 0.80756, 0.85441);
    expect(contact(12)).toBeNull();
    expect(contact(14.7)?.normalX).toBeCloseTo(-side, 1);
  }
  for (const height of [46.85, 66.85]) {
    expect(collision.groundHeight(854.5761, height, -1270.8476)).toBeCloseTo(height, 2);
  }
});

test("the ice landing and wooden bridge entrance clear the front bumper", async () => {
  const collision = await loadCollision("ice");
  const route = loadRoute("ice");
  // These approaches previously put either the cliff lip or the underside
  // of the bridge in front of a kart following its driving surface.
  for (const [startX, startY, startZ, yaw] of [
    [615, 382, -1258.5, 1.51],
    [687, 360.1, -999.8, 0.79],
  ]) {
    let y = startY;
    for (let d = 0; d <= 5; d += 0.1) {
      const x = startX + d * Math.sin(yaw);
      const z = startZ + d * Math.cos(yaw);
      y = collision.groundHeight(x, y, z) ?? route.query(x, z, -1, y).y;
      expect(collision.queryWall(x, y, z, yaw, 0.80756, 0.85441)).toBeNull();
    }
  }
});

test("the ice ravine is crossed in the air at racing speeds", async () => {
  const collision = await loadCollision("ice");
  for (const speed of [38, 50]) {
    const kart = new KartVehicle({
      speed,
      position: { x: 602.88, y: 382.45, z: -1260.01 },
      yaw: 1.496,
      groundHeightAt: (x, z, _progress, height, ceiling) => collision.groundHeight(x, height, z, ceiling),
      wallContactAt: collision.queryWall.bind(collision),
    });
    let airborneSteps = 0;
    let landed = false;
    let lowestHeave = 0;
    for (let frame = 0; frame < 90; frame++) {
      const state = kart.step(0.01, { throttle: 1 });
      if (!state.suspension!.grounded) {
        airborneSteps++;
        if (state.x < 617) expect(state.y).toBeGreaterThan(381.7);
      } else if (airborneSteps && state.x > 617) {
        landed = true;
        lowestHeave = Math.min(lowestHeave, state.suspension!.heave);
      }
      if (state.x > 641) break;
    }
    expect(airborneSteps).toBeGreaterThan(20);
    expect(landed).toBe(true);
    expect(lowestHeave).toBeLessThan(-0.02);
    expect(kart.state.collisionCount).toBe(0);
  }
});

test("desert's overlapping roads are selected by height after a reset", () => {
  const route = loadRoute("desert");
  expect(route.query(629.78, -292.96, -1, 51).y).toBeCloseTo(51.25, 1);
  expect(route.query(629.78, -292.96, -1, 64).y).toBeCloseTo(64.17, 1);
});

test("the ice transfer gate only triggers inside the gate in race direction", () => {
  const route = loadRoute("ice");
  expect(route.warpIndex).toBeGreaterThanOrEqual(0);
  const { gate: [a, b] } = route.data.warp!;
  const forward = route.pointAt(route.warpIndex).f;
  const point = (u: number, offset: number): Vec3 => [
    a[0] + u * (b[0] - a[0]) + offset * forward[0],
    a[1] + 1,
    a[2] + u * (b[2] - a[2]) + offset * forward[2],
  ];
  expect(route.crossesWarp(point(0.5, -1), point(0.5, 1))).toBe(true);
  expect(route.crossesWarp(point(0.5, 1), point(0.5, -1))).toBe(false);
  expect(route.crossesWarp(point(1.2, -1), point(1.2, 1))).toBe(false);
});
