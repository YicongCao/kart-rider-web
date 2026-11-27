import { expect, test } from "playwright/test";
import { computeOriginalSupportForces } from "../src/game/contact-force";
import { ORIGINAL_WORLD_GRAVITY } from "../src/game/original-kinematics";
import { FIXED_STEP_SECONDS, KartVehicle } from "../src/game/vehicle";

const flatNormal = { x: 0, y: 1, z: 0 };

test("four wheel loads reproduce the measured P3563 support force and torque", () => {
  // B53380 at 1.587 s. The captured compression deltas are per 2 ms substep.
  const axes = {
    right: { x: -0.9037653207778931, y: -0.163614422082901, z: 0.3955230712890625 },
    forward: { x: -0.4048733115196228, y: 0.02696751058101654, z: -0.9139750003814697 },
    up: { x: -0.13887321949005127, y: 0.9861556887626648, z: 0.090615414083004 },
  };
  const compressions = [
    0.6172218322753906, 0.4136619567871094, 0.6529731750488281, 0.4494209289550781,
  ];
  const deltas = [
    0.000545501708984375, -0.000751495361328125, 0.000843048095703125, -0.000453948974609375,
  ];
  const samples = compressions.map(compression => ({
    active: true,
    compression,
    normal: flatNormal,
  }));
  const { force, torque } = computeOriginalSupportForces(
    axes, samples, compressions.map((value, index) => value - deltas[index]), 0.002,
  );

  expect(force.x).toBeCloseTo(-810.3966, 2);
  expect(force.y + 100 * ORIGINAL_WORLD_GRAVITY).toBeCloseTo(-125.2749, 2);
  expect(force.z).toBeCloseTo(528.7875, 2);
  expect(torque.x).toBeCloseTo(23.9936, 3);
  expect(torque.y).toBe(0);
  expect(torque.z).toBeCloseTo(117.3063, 3);
});

test("a tilted support acts along body up and a spring cannot pull the chassis", () => {
  const axes = {
    right: { x: 0.8, y: -0.6, z: 0 },
    forward: { x: 0, y: 0, z: 1 },
    up: { x: 0.6, y: 0.8, z: 0 },
  };
  const { force, torque } = computeOriginalSupportForces(axes, [
    { active: true, compression: 0.5, normal: flatNormal },
    { active: true, compression: 0.2, normal: flatNormal },
    { active: false, compression: 0.5, normal: flatNormal },
  ], [0.5, 0.5, 0.5], 0.002);

  expect(force.x).toBeCloseTo(705.6, 8);
  expect(force.y).toBeCloseTo(940.8, 8);
  expect(force.z).toBe(0);
  expect(torque.x).toBeCloseTo(-96.106036, 6);
  expect(torque.y).toBe(0);
  expect(torque.z).toBeCloseTo(90.174641, 6);
});

test("a vertical impulse changes spring compression and the rigid body snapshot", () => {
  const kart = new KartVehicle();
  const snapshot = kart.physicsSnapshot;
  kart.restorePhysicsSnapshot({ ...snapshot, velocity: { x: 0, y: 1, z: 0 } });
  expect(kart.physicsSnapshot.velocity.y).toBe(1);

  kart.step(2 * FIXED_STEP_SECONDS);
  const after = kart.physicsSnapshot;
  expect(after.position.y).toBeGreaterThan(0);
  expect(after.velocity.y).toBeLessThan(0.99);
  expect(kart.state.y).toBe(after.position.y);

  kart.resetPose(0, 0, 0, 0);
  expect(kart.physicsSnapshot).toEqual(snapshot);
});

test("a grounded chassis cannot sag through the road after a hard impact", () => {
  const kart = new KartVehicle({ groundHeightAt: () => 0 });
  const snapshot = kart.physicsSnapshot;
  kart.restorePhysicsSnapshot({
    ...snapshot,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: -40, z: 0 },
  });

  let minimumOffset = 0;
  for (let step = 0; step < 2_000; step++) {
    kart.step(FIXED_STEP_SECONDS);
    const offset = kart.physicsSnapshot.position.y - kart.state.y;
    minimumOffset = Math.min(minimumOffset, offset);
    // The bump stop is one full rest-compression below the ride height. A
    // missing support sample must never let the chassis free-fall below it.
    expect(offset).toBeGreaterThanOrEqual(-1.0 - 1e-9);
  }

  expect(minimumOffset).toBeLessThan(-0.1);
  expect(kart.physicsSnapshot.position.y).toBeCloseTo(0, 1);
  expect(kart.state.y).toBeCloseTo(0, 4);
});
