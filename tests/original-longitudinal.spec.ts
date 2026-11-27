import { expect, test } from "playwright/test";
import { quatFromYaw } from "../src/game/original-kinematics";
import { KartVehicle } from "../src/game/vehicle";

function reversingKart() {
  const kart = new KartVehicle();
  kart.restorePhysicsSnapshot({
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: -2 },
    angularVelocity: { x: 0, y: 0, z: 0 },
    orientation: quatFromYaw(0),
    forwardSpeed: -2,
    lateralSpeed: 0,
    yawRate: 0,
    roll: 0,
  });
  return kart;
}

test("P3563 throttle recovery pushes a reversing kart back through zero", () => {
  const throttled = reversingKart();
  const coasting = reversingKart();
  for (let step = 0; step < 100; step++) {
    throttled.step(0.002, { throttle: 1 });
    coasting.step(0.002, {});
  }

  // B53610 adds weight * min(speed, 5 m/s) along body-forward while the
  // accelerator is held. From -2 m/s that is a ~19.6 m/s^2 recovery, well
  // above drag alone, so a 0.2 s hold must erase the reverse motion.
  expect(throttled.state.speed).toBeGreaterThan(-0.05);
  expect(coasting.state.speed).toBeLessThan(-1.9);
});

test("P3563 only applies reverse recovery while the accelerator is held", () => {
  const idle = reversingKart();
  for (let step = 0; step < 500; step++) idle.step(0.002, {});
  expect(idle.state.speed).toBeLessThan(-1.9);
});
