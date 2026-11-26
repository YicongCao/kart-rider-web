import { expect, test } from "playwright/test";
import { KartVehicle, type VehicleInput } from "../src/game/vehicle";

function drive(kart: KartVehicle, ms: number, input: VehicleInput) {
  for (let elapsed = 0; elapsed < ms; elapsed += 10) {
    kart.step(Math.min(10, ms - elapsed) / 1000, input);
  }
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

test("countersteering and reapplying throttle gives one short burst with real thrust", () => {
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

test("a fresh drift earns a fresh burst without spending an N2O charge", () => {
  const kart = new KartVehicle({ speed: 42, initialGauge: 1 });
  for (const direction of [1, -1, 1]) {
    finishSlide(kart, direction);
    drive(kart, 20, {});
    expect(drive(kart, 180, { throttle: 1 }).boostKind).toBe("drift");
  }
  expect(kart.state.miniBoostCount).toBe(3);
  expect(kart.state.gauge).toBe(1);
  const nitro = drive(kart, 10, { throttle: 1, boost: true });
  expect(nitro.boostKind).toBe("nitro");
  expect(nitro.nitroCount).toBe(1);
  expect(nitro.gauge).toBeLessThan(0.01);
  drive(kart, 30, {});
  expect(drive(kart, 20, { throttle: 1 }).boostKind).toBe("nitro");
});

test("straight driving, early reapplication, an expired drift and respawn give no mini boost", () => {
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

test("a start boost has its own cue and counter, and cannot be tapped twice", () => {
  const kart = new KartVehicle({ startAtSeconds: 0 });
  const started = drive(kart, 10, { throttle: 1 });
  expect(started.boostKind).toBe("start");
  expect(started.miniBoostCount + started.nitroCount).toBe(0);
  drive(kart, 20, {});
  drive(kart, 550, { throttle: 1 });
  expect(kart.state.boostCount).toBe(1);
  expect(kart.state.lastBoostKind).toBe("start");
});

test("the P3563 practice bend accepts throttle after the skid has ended", () => {
  // Milliseconds since steering right in two original-client runs. The C
  // recording still shows tire marks at the throttle press. D shows a burst.
  const runs = [
    { shiftOn: 31, shiftOff: 437, rightOff: 625, leftOn: 656, leftOff: 1063, lift: 1281, press: 2125, fires: false },
    { shiftOn: 32, shiftOff: 438, rightOff: 657, leftOn: 688, leftOff: 1063, lift: 1282, press: 2409, fires: true },
  ];
  for (const run of runs) {
    const kart = new KartVehicle({ speed: 52 });
    drive(kart, run.shiftOn, { throttle: 1, steer: 1 });
    drive(kart, run.shiftOff - run.shiftOn, { throttle: 1, steer: 1, drift: true });
    drive(kart, run.rightOff - run.shiftOff, { throttle: 1, steer: 1 });
    drive(kart, run.leftOn - run.rightOff, { throttle: 1 });
    drive(kart, run.leftOff - run.leftOn, { throttle: 1, steer: -1 });
    drive(kart, run.lift - run.leftOff, { throttle: 1 });
    const before = drive(kart, run.press - run.lift, {});
    expect(before.drifting).toBe(!run.fires);
    const after = drive(kart, 2, { throttle: 1 });
    expect(after.boostKind).toBe(run.fires ? "drift" : "none");
    expect(drive(kart, 550, { throttle: 1 }).miniBoostCount).toBe(run.fires ? 1 : 0);
  }
});

test("eight linked drifts can fire the previous burst while the next drift is underway", () => {
  const kart = new KartVehicle({ speed: 42 });
  drive(kart, 80, { throttle: 1, steer: -1, drift: true });
  drive(kart, 180, { throttle: 1, steer: 1 });
  for (let count = 1; count <= 8; count++) {
    const entry = drive(kart, 50, { steer: -1, drift: true });
    expect(entry.drifting).toBe(true);
    expect(entry.boostKind).toBe("none");
    const fired = drive(kart, 50, { throttle: 1, steer: 1 });
    expect(fired.drifting).toBe(true);
    expect(fired.boostKind).toBe("drift");
    expect(fired.miniBoostCount).toBe(count);
    drive(kart, 180, { throttle: 1, steer: 1 });
  }
  expect(kart.state.nitroCount).toBe(0);
  expect(kart.state.speed).toBeGreaterThan(42);
});

test("the Cotton C1 mini matches the P3563 speedometer while the exhaust is lit", () => {
  const kart = new KartVehicle({ speed: 67.5 / 3.6 });
  // Coast through a tap so the mini starts at the recorded 65 km/h.
  drive(kart, 80, { steer: 1, drift: true });
  const ready = drive(kart, 120, { steer: -1 });
  expect(Math.round(Math.hypot(ready.speed, ready.lateralSpeed) * 3.6)).toBe(65);

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
