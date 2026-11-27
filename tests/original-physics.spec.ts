import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "playwright/test";
import {
  createOriginalDriftState,
  computeOriginalLateralResponse,
  originalLateralMode,
  setOriginalDriftInput,
  stepOriginalDriftLinger,
  stepOriginalDriftTrigger,
  updateOriginalDriftSlip,
  type OriginalDriftState,
  type OriginalLateralConfig,
  type OriginalLateralMode,
} from "../src/game/lateral-physics";

const ORACLE_URL = new URL("./fixtures/oracle-lateral.csv", import.meta.url);
const ORACLE_STEP = 0.005;

// KartriderDemoPhysics defaults used to produce oracle-lateral.csv.
const ORACLE_CONFIG: OriginalLateralConfig = {
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
  // This fixture is the 2004 demo oracle. Both it and P3563 use full lock for
  // the held-drift tire force; grip alone uses the filtered +0xAA4 angle.
  heldDriftSteer: "maximum",
};

interface OracleRow {
  scenario: "grip_turn" | "drift_release" | "auto_slip";
  step: number;
  forceX: number;
  forceY: number;
  forceZ: number;
  torqueX: number;
  torqueY: number;
  torqueZ: number;
  driftInput: boolean;
  slip: boolean;
  trigger: boolean;
  triggerTimer: number;
  lingerTimer: number;
  steerAngle: number;
}

function parseOracle() {
  const lines = readFileSync(ORACLE_URL, "utf8").trim().split(/\r?\n/);
  const rows: OracleRow[] = [];
  for (const line of lines.slice(1)) {
    const values = line.split(",");
    expect(values).toHaveLength(14);
    rows.push({
      scenario: values[0] as OracleRow["scenario"],
      step: Number(values[1]),
      forceX: Number(values[2]),
      forceY: Number(values[3]),
      forceZ: Number(values[4]),
      torqueX: Number(values[5]),
      torqueY: Number(values[6]),
      torqueZ: Number(values[7]),
      driftInput: values[8] === "1",
      slip: values[9] === "1",
      trigger: values[10] === "1",
      triggerTimer: Number(values[11]),
      lingerTimer: Number(values[12]),
      steerAngle: Number(values[13]),
    });
  }
  return rows;
}

function oracleScenarioInput(
  row: OracleRow,
  state: OriginalDriftState,
) {
  if (row.scenario === "grip_turn") {
    return {
      forwardVelocity: 20,
      lateralVelocity: 0,
      yawRate: 0,
      steeringInput: 1,
      mode: originalLateralMode(state),
      driftInputActive: state.inputActive,
    };
  }
  if (row.scenario === "drift_release") {
    return {
      forwardVelocity: 20,
      lateralVelocity: row.step < 30 ? 0 : 8,
      yawRate: 0.2,
      steeringInput: 1,
      mode: originalLateralMode(state),
      driftInputActive: state.inputActive,
    };
  }
  return {
    forwardVelocity: 10,
    lateralVelocity: row.step < 10 ? 5 : 13,
    yawRate: 0,
    steeringInput: 0,
    mode: originalLateralMode(state),
    driftInputActive: state.inputActive,
  };
}

test("replays all 140 original lateral-oracle frames without approximation", () => {
  const rows = parseOracle();
  expect(rows).toHaveLength(140);
  let state = createOriginalDriftState();
  let previousScenario: OracleRow["scenario"] | null = null;
  let previousStep = -1;
  const maxError = {
    lateralForce: 0,
    rollTorque: 0,
    yawTorque: 0,
    steerAngle: 0,
    triggerTimer: 0,
    lingerTimer: 0,
  };

  for (const row of rows) {
    if (row.scenario !== previousScenario || row.step === 0) {
      state = createOriginalDriftState();
      if (row.scenario === "drift_release") {
        state.inputActive = true;
        state.triggerActive = true;
        state.entryWasForward = true;
      }
    }
    expect(row.step).toBe(previousScenario === row.scenario ? previousStep + 1 : 0);
    previousScenario = row.scenario;
    previousStep = row.step;

    if (row.scenario === "drift_release" && row.step === 25) {
      state.inputActive = false;
    }
    const input = oracleScenarioInput(row, state);
    updateOriginalDriftSlip(
      state,
      Math.hypot(input.forwardVelocity, input.lateralVelocity),
      input.forwardVelocity,
      input.lateralVelocity,
    );
    const mode = originalLateralMode(state);
    const output = computeOriginalLateralResponse(ORACLE_CONFIG, {
      ...input,
      mode,
    });
    if (mode === "trigger") {
      // The oracle uses the demo's configured 0.1 s trigger window.
      stepOriginalDriftTrigger(state, 0.1, ORACLE_STEP);
    } else if (mode === "drift") {
      stepOriginalDriftLinger(state, ORACLE_STEP);
    }

    const location = `${row.scenario} step ${row.step}`;
    const errors = {
      lateralForce: Math.abs(output.lateralForce - row.forceX),
      rollTorque: Math.abs(output.rollTorque - row.torqueY),
      yawTorque: Math.abs(output.yawTorque - row.torqueZ),
      steerAngle: Math.abs(output.steerAngleRad - row.steerAngle),
      triggerTimer: Math.abs(state.triggerTimer - row.triggerTimer),
      lingerTimer: Math.abs(state.lingerTimer - row.lingerTimer),
    };
    for (const [name, error] of Object.entries(errors)) {
      maxError[name as keyof typeof maxError] = Math.max(
        maxError[name as keyof typeof maxError],
        error,
      );
    }
    expect(output.cornerDrawForwardForce, `${location} corner draw`).toBe(0);
    expect(output.lateralForce, `${location} force x`).toBeCloseTo(row.forceX, 2);
    expect(output.lateralForce, `${location} force x tolerance`)
      .toBeGreaterThanOrEqual(row.forceX - 0.02);
    expect(output.lateralForce, `${location} force x tolerance`)
      .toBeLessThanOrEqual(row.forceX + 0.02);
    expect(output.rollTorque, `${location} torque y`)
      .toBeGreaterThanOrEqual(row.torqueY - 0.002);
    expect(output.rollTorque, `${location} torque y`)
      .toBeLessThanOrEqual(row.torqueY + 0.002);
    expect(output.yawTorque, `${location} torque z`)
      .toBeGreaterThanOrEqual(row.torqueZ - 0.002);
    expect(output.yawTorque, `${location} torque z`)
      .toBeLessThanOrEqual(row.torqueZ + 0.002);
    expect(output.steerAngleRad, `${location} steer`)
      .toBeGreaterThanOrEqual(row.steerAngle - 1e-6);
    expect(output.steerAngleRad, `${location} steer`)
      .toBeLessThanOrEqual(row.steerAngle + 1e-6);
    expect(state.inputActive, `${location} AF4`).toBe(row.driftInput);
    expect(state.slipDetected, `${location} slip`).toBe(row.slip);
    expect(state.triggerActive, `${location} B08`).toBe(row.trigger);
    expect(state.triggerTimer, `${location} trigger timer`)
      .toBeCloseTo(row.triggerTimer, 5);
    expect(state.lingerTimer, `${location} linger timer`)
      .toBeCloseTo(row.lingerTimer, 5);
  }

  expect(maxError.lateralForce).toBeLessThan(0.02);
  expect(maxError.rollTorque).toBeLessThan(0.002);
  expect(maxError.yawTorque).toBeLessThan(0.002);
  expect(maxError.steerAngle).toBeLessThan(1e-6);
  expect(maxError.triggerTimer).toBeLessThan(1e-6);
  expect(maxError.lingerTimer).toBeLessThan(1e-6);
  console.log("LATERAL_ORACLE_MAX_ERROR", JSON.stringify(maxError));
});

test("low speed uses ordinary tires and never applies drift multipliers", () => {
  const base = {
    forwardVelocity: 3,
    lateralVelocity: 2,
    yawRate: 0.4,
    steeringInput: 1,
    driftInputActive: true,
  };
  const grip = computeOriginalLateralResponse(ORACLE_CONFIG, {
    ...base,
    mode: "grip",
  });
  for (const mode of ["drift", "trigger"] as OriginalLateralMode[]) {
    const output = computeOriginalLateralResponse(ORACLE_CONFIG, {
      ...base,
      mode,
    });
    expect(output.frontSlip).toBeCloseTo(grip.frontSlip, 12);
    expect(output.rearSlip).toBeCloseTo(grip.rearSlip, 12);
    expect(output.frontForce).toBeCloseTo(grip.frontForce, 10);
    expect(output.rearForce).toBeCloseTo(grip.rearForce, 10);
    expect(output.lateralForce).toBeCloseTo(grip.lateralForce, 10);
    expect(output.yawTorque).toBeCloseTo(grip.yawTorque, 10);
    expect(output.rollTorque).toBe(0);
    expect(output.cornerDrawForwardForce).toBe(0);
  }
  expect(grip.frontSlip).toBeCloseTo(
    grip.steerAngleRad - 2 / 5 - 0.5 * 0.4 / 5,
    12,
  );
});

test("P3563 held drift uses full lock; filtered is an explicit variant", () => {
  const config: OriginalLateralConfig = {
    ...ORACLE_CONFIG,
    heldDriftSteer: "maximum",
  };
  const input = {
    forwardVelocity: 20,
    lateralVelocity: 0,
    yawRate: 0.4,
    steeringInput: 1,
    driftInputActive: true,
    mode: "drift" as const,
  };
  const p3563 = computeOriginalLateralResponse(config, input);
  const filtered = computeOriginalLateralResponse(
    { ...config, heldDriftSteer: "filtered" },
    input,
  );
  const demo = computeOriginalLateralResponse(ORACLE_CONFIG, input);
  const fullLock = ORACLE_CONFIG.maxSteerDegrees * Math.PI / 180;
  expect(p3563.steerAngleRad).toBeLessThan(fullLock);
  expect(p3563.frontSlip).toBeCloseTo(
    fullLock - 0 - 0.5 * 0.4 / 20,
    12,
  );
  expect(p3563.lateralForce).toBeCloseTo(demo.lateralForce, 10);
  expect(p3563.steerAngleRad).toBeCloseTo(filtered.steerAngleRad, 12);
  expect(p3563.frontSlip).toBeGreaterThan(filtered.frontSlip);
  expect(p3563.lateralForce).not.toBeCloseTo(filtered.lateralForce, 3);
});

test("trigger is rear-axle-only and sustained drift applies the slip factor", () => {
  const input = {
    forwardVelocity: 20,
    lateralVelocity: 0,
    yawRate: 0,
    steeringInput: 1,
    mode: "trigger" as const,
    driftInputActive: true,
  };
  const trigger = computeOriginalLateralResponse(ORACLE_CONFIG, input);
  const expectedRear =
    10 * Math.PI / 180 * ORACLE_CONFIG.driftTriggerFactor *
    -ORACLE_CONFIG.mass * 9.8 * ORACLE_CONFIG.frontGripFactor;
  expect(trigger.frontForce).toBe(0);
  expect(trigger.rearForce).toBeCloseTo(expectedRear, 10);
  expect(trigger.lateralForce).toBeCloseTo(expectedRear, 10);
  expect(trigger.yawTorque).toBeCloseTo(-0.5 * expectedRear, 10);
  expect(trigger.rollTorque).toBe(0);

  const drift = computeOriginalLateralResponse(ORACLE_CONFIG, {
    ...input,
    mode: "drift",
  });
  expect(drift.frontForce).toBeCloseTo(
    drift.frontSlip * 9.8 * ORACLE_CONFIG.mass *
      ORACLE_CONFIG.frontGripFactor * ORACLE_CONFIG.driftSlipFactor,
    10,
  );
  expect(drift.rearForce).toBeCloseTo(
    drift.rearSlip * 9.8 * ORACLE_CONFIG.mass *
      ORACLE_CONFIG.rearGripFactor * ORACLE_CONFIG.driftSlipFactor,
    10,
  );
});

test("grip corner draw is forward force; drift and trigger disable it", () => {
  const config: OriginalLateralConfig = {
    ...ORACLE_CONFIG,
    cornerDrawFactor: 0.18,
  };
  const grip = computeOriginalLateralResponse(config, {
    forwardVelocity: 20,
    lateralVelocity: 0,
    yawRate: 0,
    steeringInput: 1,
    mode: "grip",
  });
  expect(grip.cornerDrawForwardForce).toBeCloseTo(
    Math.abs(grip.lateralForce) * config.cornerDrawFactor,
    10,
  );
  for (const mode of ["drift", "trigger"] as OriginalLateralMode[]) {
    const output = computeOriginalLateralResponse(config, {
      forwardVelocity: 20,
      lateralVelocity: 0,
      yawRate: 0,
      steeringInput: 1,
      driftInputActive: true,
      mode,
    });
    expect(output.cornerDrawForwardForce).toBe(0);
  }
});

test("left and right steering produce mirrored forces and yaw torque", () => {
  for (const mode of ["grip", "drift", "trigger"] as OriginalLateralMode[]) {
    const input = {
      forwardVelocity: 20,
      lateralVelocity: 0,
      yawRate: 0,
      driftInputActive: true,
      mode,
    };
    const right = computeOriginalLateralResponse(ORACLE_CONFIG, {
      ...input,
      steeringInput: 1,
    });
    const left = computeOriginalLateralResponse(ORACLE_CONFIG, {
      ...input,
      steeringInput: -1,
    });
    expect(left.frontForce).toBeCloseTo(-right.frontForce, 10);
    expect(left.rearForce).toBeCloseTo(-right.rearForce, 10);
    expect(left.lateralForce).toBeCloseTo(-right.lateralForce, 10);
    expect(left.yawTorque).toBeCloseTo(-right.yawTorque, 10);
    expect(left.rollTorque).toBeCloseTo(-right.rollTorque, 10);
    expect(left.cornerDrawForwardForce)
      .toBeCloseTo(right.cornerDrawForwardForce, 10);
  }
});

test("the steering history clamp only blocks same-direction increases", () => {
  const base = {
    forwardVelocity: 20,
    lateralVelocity: 0,
    yawRate: 0,
    steeringInput: 1,
    forwardInput: 1,
    mode: "grip" as const,
  };
  const increasing = computeOriginalLateralResponse(ORACLE_CONFIG, {
    ...base,
    previousSteerAngleRad: 0.02,
  });
  expect(increasing.steerAngleRad).toBe(0.02);
  expect(increasing.nextPreviousSteerAngleRad).toBe(0.02);

  const decreasing = computeOriginalLateralResponse(ORACLE_CONFIG, {
    ...base,
    previousSteerAngleRad: 0.1,
  });
  expect(decreasing.steerAngleRad).toBeGreaterThan(0.08);
  expect(decreasing.steerAngleRad).toBeLessThan(0.1);
  expect(decreasing.nextPreviousSteerAngleRad)
    .toBe(decreasing.steerAngleRad);

  const opposite = computeOriginalLateralResponse(ORACLE_CONFIG, {
    ...base,
    steeringInput: -1,
    previousSteerAngleRad: 0.02,
  });
  expect(opposite.steerAngleRad).toBeLessThan(0);
  expect(opposite.nextPreviousSteerAngleRad)
    .toBe(opposite.steerAngleRad);
});

test("P3563 drift timing keeps linger frozen through trigger and rejects re-entry", () => {
  const state = createOriginalDriftState();
  setOriginalDriftInput(state, true, 50);
  expect(state.inputActive).toBe(true);
  expect(state.triggerActive).toBe(true);

  // First trigger step seeds B0C=0.2 and AF8=2*B0C=0.4.
  stepOriginalDriftTrigger(state, 0.2, 0.002);
  expect(state.triggerTimer).toBeCloseTo(0.2, 6);
  expect(state.lingerTimer).toBeCloseTo(0.4, 6);
  for (let index = 0; index < 10; index++) {
    stepOriginalDriftTrigger(state, 0.2, 0.002);
  }
  // Releasing Shift during trigger clears AF4 but not B08 or AF8.
  setOriginalDriftInput(state, false, 50);
  expect(state.inputActive).toBe(false);
  expect(state.triggerActive).toBe(true);
  expect(state.lingerTimer).toBeCloseTo(0.4, 6);
  while (state.triggerActive) {
    stepOriginalDriftTrigger(state, 0.2, 0.002);
  }
  expect(state.lingerTimer).toBeCloseTo(0.4, 6);
  expect(originalLateralMode(state)).toBe("drift");

  // A new Shift press is ignored for the entire 0.4 s linger window.
  setOriginalDriftInput(state, true, 50);
  expect(state.inputActive).toBe(false);
  expect(state.triggerActive).toBe(false);
  for (let index = 0; index < 199; index++) {
    stepOriginalDriftLinger(state, 0.002);
    expect(originalLateralMode(state)).toBe("drift");
    setOriginalDriftInput(state, true, 50);
    expect(state.inputActive).toBe(false);
  }
  expect(state.lingerTimer).toBeGreaterThan(0);
  stepOriginalDriftLinger(state, 0.002);
  expect(state.lingerTimer).toBeLessThan(1e-12);
  expect(originalLateralMode(state)).toBe("grip");
  setOriginalDriftInput(state, true, 50);
  expect(state.inputActive).toBe(true);
  expect(state.triggerActive).toBe(true);
});

test("zero steering does not end a held drift; only Shift release does", () => {
  const state = createOriginalDriftState();
  setOriginalDriftInput(state, true, 50);
  for (let index = 0; index < 200; index++) {
    updateOriginalDriftSlip(state, 20, 20, 0);
    if (index === 0) stepOriginalDriftTrigger(state, 0.2, 0.002);
    else if (!state.triggerActive) stepOriginalDriftLinger(state, 0.002);
    else stepOriginalDriftTrigger(state, 0.2, 0.002);
  }
  expect(state.inputActive).toBe(true);
  expect(state.triggerActive).toBe(false);
  expect(originalLateralMode(state)).toBe("drift");
  setOriginalDriftInput(state, false, 20);
  expect(state.inputActive).toBe(false);
});

test("auto slip uses the P3563 15 m/s gate and low speed clears both timers", () => {
  const state = createOriginalDriftState();
  updateOriginalDriftSlip(state, Math.hypot(10, 13), 10, 13);
  expect(state.slipDetected).toBe(true);
  updateOriginalDriftSlip(state, Math.hypot(4, 5.5), 4, 5.5);
  expect(state.slipDetected).toBe(false);

  state.inputActive = true;
  state.triggerActive = true;
  state.triggerTimer = 0.1;
  state.lingerTimer = 0.2;
  updateOriginalDriftSlip(state, 5, 4, 3);
  expect(state).toMatchObject({
    inputActive: false,
    slipDetected: false,
    triggerActive: false,
    triggerTimer: 0,
    lingerTimer: 0,
  });
});

test("the fixture is the checked-in original oracle, not a generated approximation", () => {
  const path = fileURLToPath(ORACLE_URL);
  expect(path.endsWith("/tests/fixtures/oracle-lateral.csv")).toBe(true);
  expect(readFileSync(ORACLE_URL, "utf8")).toContain(
    "scenario,step,force_x,force_y,force_z,torque_x,torque_y,torque_z",
  );
});
