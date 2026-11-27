import { readFileSync } from "node:fs";
import { expect, test } from "playwright/test";
import { quatFromYaw } from "../src/game/original-kinematics";
import { DEFAULT_TUNING, KartVehicle } from "../src/game/vehicle";

interface TraceSample {
  t: number;
  forwardSpeed: number;
  lateralSpeed: number;
  yawRate: number;
}

interface LiveDriftFixture {
  schemaVersion: number;
  source: string;
  notes: string[];
  initial: {
    forwardSpeed: number;
    lateralSpeed: number;
    yawRate: number;
    previousSteerAngleRad: number;
  };
  inputSwitchSeconds: number;
  driftSteer: number;
  driftThrottle: number;
  samples: TraceSample[];
  liveConstants: Record<string, number>;
  tolerances: {
    maxForwardSpeedError: number;
    maxLateralSpeedError: number;
    maxYawRateError: number;
  };
}

function loadFixture(): LiveDriftFixture {
  return JSON.parse(readFileSync(
    new URL("./fixtures/p3563-live-drift-trace.json", import.meta.url),
    "utf8",
  )) as LiveDriftFixture;
}

test("Web replays the captured P3563 full-lock drift trace", () => {
  const fixture = loadFixture();
  expect(fixture.schemaVersion).toBe(1);
  expect(fixture.samples.length).toBeGreaterThanOrEqual(10);

  // The live runtime's default road surface is mode 0: no front/rear grip
  // modifier, steering multiplier 1, drift force multiplier 1.
  expect(fixture.liveConstants.maxSteerDeg).toBe(DEFAULT_TUNING.maxSteerDeg);
  expect(fixture.liveConstants.steerConstraint)
    .toBeCloseTo(DEFAULT_TUNING.steerConstraint, 6);
  expect(fixture.liveConstants.frontGripFactor)
    .toBe(DEFAULT_TUNING.frontGripFactor);
  expect(fixture.liveConstants.rearGripFactor)
    .toBe(DEFAULT_TUNING.rearGripFactor);
  expect(fixture.liveConstants.driftLeanFactor)
    .toBeCloseTo(DEFAULT_TUNING.driftLeanFactor, 6);
  expect(fixture.liveConstants.steerLeanFactor)
    .toBeCloseTo(DEFAULT_TUNING.steerLeanFactor, 6);

  const initial = fixture.initial;
  const kart = new KartVehicle({ position: { x: 0, y: 0, z: 0 } });
  kart.restorePhysicsSnapshot({
    position: { x: 0, y: 0, z: 0 },
    // Web forward is +Z and body-right is +X at yaw 0.
    velocity: { x: initial.lateralSpeed, y: 0, z: initial.forwardSpeed },
    angularVelocity: { x: 0, y: initial.yawRate, z: 0 },
    orientation: quatFromYaw(0),
    forwardSpeed: initial.forwardSpeed,
    lateralSpeed: initial.lateralSpeed,
    yawRate: initial.yawRate,
    roll: 0,
  }, {
    previousSteerAngleRad: initial.previousSteerAngleRad,
  });

  let sampleIndex = 0;
  const errors = {
    forwardSpeed: 0,
    lateralSpeed: 0,
    yawRate: 0,
  };
  for (let milliseconds = 2; milliseconds <= 846; milliseconds += 2) {
    const drifting = milliseconds > fixture.inputSwitchSeconds * 1000;
    kart.step(0.002, {
      throttle: fixture.driftThrottle,
      steer: drifting ? fixture.driftSteer : 1,
      drift: drifting,
    });
    const next = fixture.samples[sampleIndex + 1];
    if (!next || milliseconds < Math.round(next.t * 1000)) continue;
    sampleIndex++;
    const state = kart.state;
    errors.forwardSpeed = Math.max(
      errors.forwardSpeed,
      Math.abs(state.speed - next.forwardSpeed),
    );
    errors.lateralSpeed = Math.max(
      errors.lateralSpeed,
      Math.abs(state.lateralSpeed - next.lateralSpeed),
    );
    errors.yawRate = Math.max(
      errors.yawRate,
      Math.abs(state.yawRate - next.yawRate),
    );
  }

  expect(sampleIndex).toBe(fixture.samples.length - 1);
  expect(kart.state.driftPhase).toBe("active");
  expect(errors.forwardSpeed).toBeLessThanOrEqual(
    fixture.tolerances.maxForwardSpeedError,
  );
  expect(errors.lateralSpeed).toBeLessThanOrEqual(
    fixture.tolerances.maxLateralSpeedError,
  );
  expect(errors.yawRate).toBeLessThanOrEqual(
    fixture.tolerances.maxYawRateError,
  );
  console.log("P3563_LIVE_DRIFT_MAX_ERROR", JSON.stringify(errors));
});

test("the live trace fixture carries its native sampling boundaries", () => {
  const fixture = loadFixture();
  expect(fixture.source).toContain("FUN_00B53F80");
  expect(fixture.notes.join(" ")).toContain("+0xAE0");
  expect(fixture.inputSwitchSeconds).toBeGreaterThan(0);
  expect(fixture.driftSteer).toBe(-1);
});
