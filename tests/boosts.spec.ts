import { expect, test } from "playwright/test";
import {
  KartVehicle,
  type VehicleInput,
  type VehicleState,
} from "../src/game/vehicle";

/**
 * Evidence groups used by these tests:
 * - [P3563] Drift trigger 0.2 s, linger 0.4 s, 2 ms substeps, and the
 *   practice-bend input recordings are native evidence.
 * - [2004] The 0.5 s mini window/duration, 1.5x thrust and 3 s item boost
 *   come from the 2004 demo/oracle. The Cotton C1 HUD curve is from P3563.
 * - [Web] Gauge inventory, one-shot start cue and respawn rules are product
 *   contracts. They are not presented as original-native behaviour.
 */

function drive(kart: KartVehicle, ms: number, input: VehicleInput) {
  for (let elapsed = 0; elapsed < ms; elapsed += 10) {
    kart.step(Math.min(10, ms - elapsed) / 1000, input);
  }
  return kart.state;
}

function driveUntil(
  kart: KartVehicle,
  done: (state: VehicleState) => boolean,
  ms: number,
  input: VehicleInput,
  stepMs = 2,
) {
  for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
    if (done(kart.state)) return kart.state;
    kart.step(stepMs / 1000, input);
  }
  return kart.state;
}

/**
 * End a P3563 drift completely (0.2 s trigger + 0.4 s linger from the end of
 * the trigger), leaving the 0.5 s accelerator opportunity window open.
 */
function finishDriftAndArm(kart: KartVehicle, direction = 1) {
  drive(kart, 80, { throttle: 1, steer: direction, drift: true });
  expect(kart.state.drifting).toBe(true);
  driveUntil(
    kart,
    state => !state.drifting,
    2_000,
    { throttle: 1, steer: -direction },
  );
  expect(kart.state.drifting).toBe(false);
  return kart.state;
}

function finishDriftAndArmCoasting(kart: KartVehicle, direction = 1) {
  drive(kart, 80, { steer: direction, drift: true });
  expect(kart.state.drifting).toBe(true);
  driveUntil(
    kart,
    state => !state.drifting,
    2_000,
    { steer: -direction },
  );
  expect(kart.state.drifting).toBe(false);
  return kart.state;
}

// Keep the accelerator down while straightening, so releasing Shift alone
// and actually tapping the accelerator are distinguishable in the assertions.
function finishSlide(kart: KartVehicle, direction = 1) {
  drive(kart, 90, { throttle: 1, steer: direction, drift: true });
  expect(kart.state.drifting).toBe(true);
  for (let i = 0; kart.state.drifting && i < 300; i++) {
    kart.step(0.01, { throttle: 1, steer: -direction });
  }
  expect(kart.state.drifting).toBe(false);
}

test("[2004] countersteer + reapply spends one 0.5 s mini at 1.5x thrust", () => {
  // Window/duration/thrust are 2004-demo/oracle evidence. P3563 has not
  // recovered the corresponding boost function.
  const kart = new KartVehicle({ speed: 34 });
  const control = new KartVehicle({ speed: 34 });
  for (const vehicle of [kart, control]) finishSlide(vehicle);
  drive(kart, 20, { throttle: 0 });
  const lit = drive(kart, 10, { throttle: 1 });
  expect(lit.boostKind).toBe("drift");
  expect(lit.miniBoostCount).toBe(1);
  expect(lit.nitroCount).toBe(0);
  drive(kart, 390, { throttle: 1 });
  drive(control, 420, { throttle: 1 });
  expect(control.state.boostCount).toBe(0);
  expect(kart.state.speed - control.state.speed).toBeGreaterThan(1);
  expect(kart.state.boostKind).toBe("drift");
  expect(drive(kart, 120, { throttle: 1 }).boosting).toBe(false);
  drive(kart, 20, {});
  expect(drive(kart, 20, { throttle: 1 }).boostCount).toBe(1);
});

test("[Web] a full gauge becomes an N2O slot and a fresh drift still minis", () => {
  const kart = new KartVehicle({ speed: 42, initialGauge: 1 });
  const converted = drive(kart, 10, {});
  expect(converted.n2oCharges).toBe(1);
  expect(converted.gauge).toBeLessThan(0.01);
  for (const direction of [1, -1, 1]) {
    finishSlide(kart, direction);
    drive(kart, 20, {});
    expect(drive(kart, 180, { throttle: 1 }).boostKind).toBe("drift");
  }
  expect(kart.state.miniBoostCount).toBe(3);
  expect(kart.state.n2oCharges).toBe(1);
  const nitro = drive(kart, 10, { throttle: 1, boost: true });
  expect(nitro.boostKind).toBe("nitro");
  expect(nitro.nitroCount).toBe(1);
  expect(nitro.n2oCharges).toBe(0);
  drive(kart, 3050, { throttle: 1 });
  drive(kart, 20, {});
  expect(drive(kart, 10, { throttle: 1, boost: true }).boostKind).toBe("none");
});

test("[2004] item boost starts only with forward input and expires after 3 s", () => {
  // The 3000 ms duration and forward-input gate are demo/oracle evidence.
  // The two-slot inventory consumed here is the Web product rule.
  const kart = new KartVehicle({ speed: 35, initialN2oCharges: 1 });
  const idle = drive(kart, 20, { boost: true });
  expect(idle.boostKind).toBe("none");
  expect(idle.n2oCharges).toBe(1);
  drive(kart, 10, {});
  const fired = drive(kart, 10, { throttle: 1, boost: true });
  expect(fired.boostKind).toBe("nitro");
  expect(fired.n2oCharges).toBe(0);
  expect(fired.nitroCount).toBe(1);
  drive(kart, 3050, { throttle: 1 });
  drive(kart, 20, {});
  const empty = drive(kart, 10, { throttle: 1, boost: true });
  expect(empty.boostKind).toBe("none");
  expect(empty.n2oCharges).toBe(0);
});

test("[Web] a full gauge awards N2O before the skid ends", () => {
  // Inventory timing is a Web contract; P3563 gauge charging/awarding has
  // not been recovered.
  const kart = new KartVehicle({
    speed: 42,
    tuning: { driftGaugeScale: 5000 },
  });
  let awarded = null;
  for (let i = 0; i < 500; i++) {
    const state = kart.step(0.002, { throttle: 1, steer: 1, drift: true });
    if (state.n2oCharges > 0) {
      awarded = state;
      break;
    }
  }
  expect(awarded).not.toBeNull();
  expect(awarded!.gauge).toBeLessThan(0.05);
  expect(awarded!.drifting).toBe(true);
});

test("[2004/Web] straight, early, expired and respawn cases give no mini", () => {
  const kart = new KartVehicle({ speed: 40 });
  drive(kart, 80, { throttle: 1 });
  drive(kart, 20, {});
  expect(drive(kart, 20, { throttle: 1 }).boostCount).toBe(0);
  drive(kart, 200, { throttle: 1, steer: 1, drift: true });
  drive(kart, 30, { steer: 1, drift: true });
  expect(drive(kart, 20, { throttle: 1, steer: 1, drift: true }).boosting).toBe(false);
  drive(kart, 3000, { throttle: 1 });
  drive(kart, 20, {});
  expect(drive(kart, 20, { throttle: 1 }).boostCount).toBe(0);
  finishSlide(kart);
  kart.resetPose(0, 0, 0, 0, 40);
  drive(kart, 20, {});
  expect(drive(kart, 20, { throttle: 1 }).miniBoostCount).toBe(0);
});

test("[Web] start boost is a 0.5 s one-shot cue", () => {
  // Product rule: the Web start cue is 0.5 s and latched. The 2004 demo uses
  // a 1000 ms timed boost and has no equivalent one-shot latch.
  const kart = new KartVehicle({ startAtSeconds: 0 });
  const started = drive(kart, 10, { throttle: 1 });
  expect(started.boostKind).toBe("start");
  expect(started.miniBoostCount + started.nitroCount).toBe(0);
  drive(kart, 20, {});
  drive(kart, 550, { throttle: 1 });
  expect(kart.state.boostCount).toBe(1);
  expect(kart.state.lastBoostKind).toBe("start");
});

interface PracticeRun {
  approachMs: number;
  shiftOn: number;
  shiftOff: number;
  rightOff: number;
  leftOn: number;
  leftOff: number;
  lift: number;
  press: number;
}

function replayPracticeRun(run: PracticeRun) {
  const kart = new KartVehicle();
  drive(kart, run.approachMs, { throttle: 1 });
  drive(kart, run.shiftOn, { throttle: 1, steer: 1 });
  drive(kart, run.shiftOff - run.shiftOn, { throttle: 1, steer: 1, drift: true });
  drive(kart, run.rightOff - run.shiftOff, { throttle: 1, steer: 1 });
  drive(kart, run.leftOn - run.rightOff, { throttle: 1 });
  drive(kart, run.leftOff - run.leftOn, { throttle: 1, steer: -1 });
  drive(kart, run.lift - run.leftOff, { throttle: 1 });
  drive(kart, run.press - run.lift, {});
  const after = drive(kart, 2, { throttle: 1 });
  const settled = drive(kart, 550, { throttle: 1 });
  return { after, settled };
}

test("[P3563] practice-bend C: throttle after the exit window does not fire", () => {
  // C/events.txt records Up down at 32 ms, Right down at 5595 ms, and Up
  // down again at 7720 ms. Replay the approach from rest. All subsequent
  // offsets use Right down as zero. The recorded exhaust stays unlit.
  const run: PracticeRun = {
    approachMs: 5595 - 32,
    shiftOn: 31, shiftOff: 437, rightOff: 625, leftOn: 656,
    leftOff: 1063, lift: 1281, press: 2125,
  };
  const result = replayPracticeRun(run);
  expect(result.after.boostKind).toBe("none");
  expect(result.settled.miniBoostCount).toBe(0);
});

test("[P3563 gap] practice-bend D fires on the client and misses on Web", () => {
  // D/events.txt records Up at 30 ms, Right at 5592 ms, and the successful
  // re-press at 8001 ms. P3563's unported +0x65C extends low grip on surface
  // mode 1. The surface mode in this recording has yet to be confirmed.
  const run: PracticeRun = {
    approachMs: 5592 - 30,
    shiftOn: 32, shiftOff: 438, rightOff: 657, leftOn: 688,
    leftOff: 1063, lift: 1282, press: 2409,
  };
  const result = replayPracticeRun(run);
  expect(result.after.boostKind).toBe("none");
  expect(result.settled.miniBoostCount).toBe(0);
});

test("[2004/Web] each linked drift can spend the previous exit window while drifting", () => {
  // The 2004 state machine may spend the opportunity during the next drift.
  // The single Web boostKind still collapses concurrent timed/instant state.
  const kart = new KartVehicle({ speed: 42 });
  finishDriftAndArm(kart, -1);
  let lastFired = kart.state;
  for (let count = 1; count <= 8; count++) {
    const direction = count % 2 === 1 ? -1 : 1;
    const entry = drive(kart, 10, { steer: direction, drift: true });
    expect(entry.drifting).toBe(true);
    lastFired = drive(kart, 10, {
      throttle: 1,
      steer: direction,
      drift: true,
    });
    expect(lastFired.drifting).toBe(true);
    expect(lastFired.boostKind).toBe("drift");
    expect(lastFired.miniBoostCount).toBe(count);
    if (count < 8) {
      driveUntil(
        kart,
        state => !state.drifting,
        4_000,
        { throttle: 1, steer: 0 },
      );
      expect(kart.state.drifting).toBe(false);
    }
  }
  expect(kart.state.nitroCount).toBe(0);
  expect(kart.state.miniBoostCount).toBe(8);
  expect(kart.state.boostCount).toBe(8);
  expect(lastFired.boostKind).toBe("drift");
});

test("[P3563] Cotton C1 mini acceleration matches the recorded speedometer curve", () => {
  // launcher_drift_report.md §§6–8: S7 plus cotton1/param.xml BodyParam.
  // C1 adds 10 N to forward thrust. Its missing XML fields take their XML
  // defaults, including zero increments for drag, steer constraint and escape.
  const kart = new KartVehicle({
    speed: 72 / 3.6,
    tuning: {
      forwardAccel: 2150 + 10,
      dragFactor: 0.75,
      boostAccelFactor: 1.5 - 0.006,
      steerConstraint: 22.25,
      driftEscapeForce: 2600,
      cornerDrawFactor: 0.18,
      driftLeanFactor: 0.07,
    },
  });
  const ready = finishDriftAndArmCoasting(kart, 1);
  expect(Math.abs(
    Math.hypot(ready.speed, ready.lateralSpeed) * 3.6 - 65,
  )).toBeLessThan(1);

  // Elapsed milliseconds from the first flame at race clock 00:13.55.
  const samples = [[100, 74], [160, 80], [220, 87], [250, 90], [320, 96], [410, 104], [440, 107]];
  let previousMs = 0;
  for (const [ms, kmh] of samples) {
    const state = drive(kart, ms - previousMs, { throttle: 1 });
    expect(state.boostKind).toBe("drift");
    const displaySpeed = Math.hypot(state.speed, state.lateralSpeed) * 3.6;
    expect(Math.abs(displaySpeed - kmh), `C1 speed at +${ms} ms`).toBeLessThan(2);
    previousMs = ms;
  }
});
