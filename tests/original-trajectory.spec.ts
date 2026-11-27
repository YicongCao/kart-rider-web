import { readFileSync } from "node:fs";
import { expect, test } from "playwright/test";
import {
  computeOriginalLateralResponse,
  createOriginalDriftState,
  originalLateralMode,
  setOriginalDriftInput,
  stepOriginalDriftLinger,
  stepOriginalDriftTrigger,
  updateOriginalDriftSlip,
  type OriginalLateralConfig,
} from "../src/game/lateral-physics";
import {
  addVec3,
  bodyAxes,
  computeDrag,
  dotVec3,
  integrateAngularVelocity,
  integratePose,
  inverseInertiaDiagonal,
  scaleVec3,
  type Quat,
  type Vec3,
} from "../src/game/original-kinematics";

const FIXTURE_URL = new URL("./fixtures/oracle-trajectory.csv", import.meta.url);
const STEP_SECONDS = 0.005;

// `kart_dynamics_default_config()` used by compare_trajectory_oracle.c.
const CONFIG: OriginalLateralConfig = {
  mass: 100,
  maxSteerDegrees: 10,
  steerConstraint: 30,
  frontGripFactor: 5,
  rearGripFactor: 5,
  driftTriggerFactor: 0.05,
  driftSlipFactor: 0.2,
  cornerDrawFactor: 0,
  driftLeanFactor: 0.07,
  steerLeanFactor: 0.01,
  // Both the 2004 trajectory and P3563 B53F80 use full lock for held drift;
  // ordinary grip alone uses the filtered steering angle.
  heldDriftSteer: "maximum",
};

interface TrajectoryRow {
  step: number;
  steer: number;
  position: Vec3;
  velocity: Vec3;
  omega: Vec3;
  orientation: Quat;
  driftInput: boolean;
  slip: boolean;
  trigger: boolean;
  triggerTimer: number;
  lingerTimer: number;
}

function parseFixture(): TrajectoryRow[] {
  const lines = readFileSync(FIXTURE_URL, "utf8").trim().split(/\r?\n/);
  return lines.slice(1).map(line => {
    const values = line.split(",").map(Number);
    expect(values).toHaveLength(21);
    return {
      step: values[0],
      steer: values[1],
      position: { x: values[3], y: values[4], z: values[5] },
      velocity: { x: values[6], y: values[7], z: values[8] },
      omega: { x: values[9], y: values[10], z: values[11] },
      orientation: {
        w: values[12],
        x: values[13],
        y: values[14],
        z: values[15],
      },
      driftInput: values[16] === 1,
      slip: values[17] === 1,
      trigger: values[18] === 1,
      triggerTimer: values[19],
      lingerTimer: values[20],
    };
  });
}

/**
 * C world basis is right=(1,0,0), forward=(0,-1,0), up=(0,0,1).
 * Web world basis is right=(1,0,0), forward=(0,0,1), up=(0,1,0).
 * The same rotation maps (x,y,z) to (x,z,-y).
 */
function fromOriginalWorld(value: Vec3): Vec3 {
  return { x: value.x, y: value.z, z: -value.y };
}

function fromOriginalLocal(value: Vec3): Vec3 {
  return { x: value.x, y: value.z, z: -value.y };
}

function fromOriginalQuat(value: Quat): Quat {
  return { w: value.w, x: value.x, y: value.z, z: -value.y };
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

test("replays the full 240-frame 2004 trajectory through the shared kinematics", () => {
  const rows = parseFixture();
  expect(rows).toHaveLength(240);

  let position: Vec3 = { x: 0, y: 0, z: 0 };
  let velocity: Vec3 = fromOriginalWorld({ x: 0, y: -20, z: 0 });
  let omega: Vec3 = { x: 0, y: 0, z: 0 };
  let orientation: Quat = { w: 1, x: 0, y: 0, z: 0 };
  let previousSteerAngle = 0;
  const drift = createOriginalDriftState();
  const maxError = {
    position: 0,
    velocity: 0,
    omega: 0,
    orientation: 0,
    triggerTimer: 0,
    lingerTimer: 0,
  };

  for (const row of rows) {
    if (row.step === 40) {
      setOriginalDriftInput(drift, true, 20);
    } else if (row.step === 100) {
      setOriginalDriftInput(drift, false, 20);
    }

    const axes = bodyAxes(orientation);
    const forwardVelocity = dotVec3(velocity, axes.forward);
    const lateralVelocity = dotVec3(velocity, axes.right);
    const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
    updateOriginalDriftSlip(drift, speed, forwardVelocity, lateralVelocity);
    const mode = originalLateralMode(drift);
    const lateral = computeOriginalLateralResponse(CONFIG, {
      forwardVelocity,
      lateralVelocity,
      yawRate: omega.y,
      steeringInput: row.steer,
      forwardInput: 1,
      previousSteerAngleRad: previousSteerAngle,
      driftInputActive: drift.inputActive,
      mode,
    });
    previousSteerAngle = lateral.nextPreviousSteerAngleRad;

    if (mode === "trigger") {
      stepOriginalDriftTrigger(drift, 0.1, STEP_SECONDS);
    } else if (mode === "drift") {
      stepOriginalDriftLinger(drift, STEP_SECONDS);
    }

    let force = scaleVec3(axes.right, lateral.lateralForce);
    force = addVec3(force, scaleVec3(axes.forward, lateral.cornerDrawForwardForce));
    let torque = {
      x: 0,
      y: lateral.yawTorque,
      z: -lateral.rollTorque,
    };
    const drag = computeDrag(
      velocity,
      omega,
      3,
      0.5,
      true,
      1,
    );
    force = addVec3(force, drag.force);
    torque = addVec3(torque, drag.torque);

    velocity = addVec3(
      velocity,
      scaleVec3(force, STEP_SECONDS / CONFIG.mass),
    );
    omega = integrateAngularVelocity(
      omega,
      torque,
      inverseInertiaDiagonal(CONFIG.mass),
      STEP_SECONDS,
    );
    const pose = integratePose(
      position,
      orientation,
      velocity,
      omega,
      STEP_SECONDS,
    );
    position = pose.position;
    orientation = pose.orientation;
    omega = pose.angularVelocity;

    const expectedPosition = fromOriginalWorld(row.position);
    const expectedVelocity = fromOriginalWorld(row.velocity);
    const expectedOmega = fromOriginalLocal(row.omega);
    const expectedOrientation = fromOriginalQuat(row.orientation);
    const errors = {
      position: distance(position, expectedPosition),
      velocity: distance(velocity, expectedVelocity),
      omega: distance(omega, expectedOmega),
      orientation: Math.hypot(
        orientation.w - expectedOrientation.w,
        orientation.x - expectedOrientation.x,
        orientation.y - expectedOrientation.y,
        orientation.z - expectedOrientation.z,
      ),
      triggerTimer: Math.abs(drift.triggerTimer - row.triggerTimer),
      lingerTimer: Math.abs(drift.lingerTimer - row.lingerTimer),
    };
    for (const [name, error] of Object.entries(errors)) {
      maxError[name as keyof typeof maxError] = Math.max(
        maxError[name as keyof typeof maxError],
        error,
      );
    }

    const location = `trajectory step ${row.step}`;
    expect(drift.inputActive, `${location} AF4`).toBe(row.driftInput);
    expect(drift.slipDetected, `${location} auto slip`).toBe(row.slip);
    expect(drift.triggerActive, `${location} B08`).toBe(row.trigger);
    expect(drift.triggerTimer, `${location} trigger timer`)
      .toBeCloseTo(row.triggerTimer, 5);
    expect(drift.lingerTimer, `${location} linger timer`)
      .toBeCloseTo(row.lingerTimer, 5);
    expect(errors.orientation, `${location} orientation`).toBeLessThan(1e-4);
    expect(errors.velocity, `${location} velocity`).toBeLessThan(1e-4);
    expect(errors.omega, `${location} omega`).toBeLessThan(1e-5);
    expect(errors.position, `${location} position`).toBeLessThan(1e-4);
  }

  console.log("TRAJECTORY_ORACLE_MAX_ERROR", JSON.stringify(maxError));
  expect(maxError.triggerTimer).toBeLessThan(1e-6);
  expect(maxError.lingerTimer).toBeLessThan(1e-6);
  expect(maxError.orientation).toBeLessThan(1e-4);
  expect(maxError.velocity).toBeLessThan(1e-4);
  expect(maxError.omega).toBeLessThan(1e-5);
  expect(maxError.position).toBeLessThan(1e-4);
});
