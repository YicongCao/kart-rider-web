/**
 * Original KartRider lateral tire response.
 *
 * This is a dependency-free port of the lateral path recovered from P3563
 * `FUN_00B53F80` and cross-checked against the 2004 demo reconstruction in
 * `KartriderDemoPhysics/src/kart_dynamics.c`.
 *
 * Inputs and outputs use the Web simulator's body frame:
 * forward is the chassis +Z direction and lateral is chassis +right.
 * Positive yaw rate therefore turns toward +right.
 */

export const ORIGINAL_LOW_SPEED = 5;
export const ORIGINAL_STEER_ACTIVE_SPEED = 0.5;
export const ORIGINAL_LEAN_SPEED = 10;
export const ORIGINAL_AUTO_SLIP_RATIO = 1.2;
export const ORIGINAL_AUTO_SLIP_SPEED = 15;
export const ORIGINAL_TIRE_GRAVITY = 9.8;

export type OriginalLateralMode = "grip" | "drift" | "trigger";

export interface OriginalLateralConfig {
  mass: number;
  maxSteerDegrees: number;
  steerConstraint: number;
  frontGripFactor: number;
  rearGripFactor: number;
  driftTriggerFactor: number;
  driftSlipFactor: number;
  cornerDrawFactor: number;
  driftLeanFactor: number;
  steerLeanFactor: number;
  /**
   * P3563 `B53F80` uses `rawSteer * MaxSteerAngle` for the trigger and
   * active-drift tire forces, while ordinary grip uses the speed-attenuated
   * `+0xAA4` angle. The 2004 demo uses the same split. `"filtered"` remains
   * available only for explicitly replaying a filtered-angle variant.
   */
  heldDriftSteer?: "filtered" | "maximum";
}

export interface OriginalLateralInput {
  forwardVelocity: number;
  lateralVelocity: number;
  /** Chassis yaw rate in rad/s. */
  yawRate: number;
  /** -1..1 raw steering input. Positive turns toward chassis +right. */
  steeringInput: number;
  /** Accelerator input; enables the original steering-angle history clamp. */
  forwardInput?: number;
  previousSteerAngleRad?: number;
  reverseSteering?: boolean;
  /** AF4: manual drift input is still held. */
  driftInputActive?: boolean;
  mode: OriginalLateralMode;
}

export interface OriginalLateralOutput {
  speed: number;
  steerAngleRad: number;
  nextPreviousSteerAngleRad: number;
  frontSlip: number;
  rearSlip: number;
  frontForce: number;
  rearForce: number;
  /** Body-right force in N. */
  lateralForce: number;
  /** Positive body-right yaw torque; the original uses virtual half-track 0.5. */
  yawTorque: number;
  /** Positive body-right roll torque. */
  rollTorque: number;
  /** Positive body-forward force applied by the grip-only corner draw. */
  cornerDrawForwardForce: number;
}

export interface OriginalDriftState {
  /** AF4: manual drift key latch. */
  inputActive: boolean;
  /** +0xAFC state byte: automatic slip detection. */
  slipDetected: boolean;
  /** B08: trigger window. */
  triggerActive: boolean;
  entryWasForward: boolean;
  /** B0C: trigger countdown. */
  triggerTimer: number;
  /** +0xAF8: low-grip window after the trigger. */
  lingerTimer: number;
}

export function createOriginalDriftState(
  overrides: Partial<OriginalDriftState> = {},
): OriginalDriftState {
  return {
    inputActive: false,
    slipDetected: false,
    triggerActive: false,
    entryWasForward: false,
    triggerTimer: 0,
    lingerTimer: 0,
    ...overrides,
  };
}

/**
 * Original `kart_steer_angle_rad` at 0x0042fcde.
 * Speed attenuation is applied to the effective steering angle, while the
 * trigger force uses the unattenuated maximum angle.
 */
export function originalSteerAngleRad(
  config: Pick<OriginalLateralConfig, "maxSteerDegrees" | "steerConstraint">,
  forwardVelocity: number,
  steeringInput: number,
  reverseSteering = false,
) {
  const direction = reverseSteering ? -1 : 1;
  const maximum = config.maxSteerDegrees * Math.PI / 180;
  const attenuation = Math.exp(
    -Math.abs(forwardVelocity / config.steerConstraint),
  );
  return maximum * direction * steeringInput * attenuation;
}

/**
 * Lateral force/torque path from P3563 0xB53F80.
 *
 * The `<= 5 m/s` branch deliberately computes ordinary tire forces and
 * ignores the trigger/slip multipliers. The owner clears the drift state in
 * that branch before applying the result.
 */
export function computeOriginalLateralResponse(
  config: OriginalLateralConfig,
  input: OriginalLateralInput,
): OriginalLateralOutput {
  const speed = Math.hypot(input.forwardVelocity, input.lateralVelocity);
  const travelDirection = input.forwardVelocity <= 0 ? -1 : 1;
  const steeringDirection = input.reverseSteering ? -1 : 1;
  const maximumSteer =
    config.maxSteerDegrees * Math.PI / 180 *
    steeringDirection * input.steeringInput;
  const previousSteer = input.previousSteerAngleRad ?? 0;
  let steerAngle = originalSteerAngleRad(
    config,
    input.forwardVelocity,
    input.steeringInput,
    input.reverseSteering,
  );
  let nextPreviousSteerAngle = steerAngle;

  // The original rate limiter only blocks an increase in the same direction.
  if (
    (input.forwardInput ?? 0) !== 0 &&
    (
      (previousSteer > 0 && steerAngle > 0) ||
      (previousSteer < 0 && steerAngle < 0)
    ) &&
    Math.abs(previousSteer) < Math.abs(steerAngle)
  ) {
    steerAngle = previousSteer;
    nextPreviousSteerAngle = previousSteer;
  }

  const denominator = speed <= ORIGINAL_LOW_SPEED
    ? ORIGINAL_LOW_SPEED
    : speed;
  const heldDriftAngle =
    speed > ORIGINAL_LOW_SPEED &&
    input.mode === "drift" &&
    input.driftInputActive &&
    config.heldDriftSteer !== "filtered"
      ? maximumSteer
      : steerAngle;
  const steerForSlip = speed >= ORIGINAL_STEER_ACTIVE_SPEED
    ? travelDirection * heldDriftAngle
    : 0;
  const frontSlip =
    steerForSlip -
    input.lateralVelocity / denominator -
    (input.yawRate * 0.5) / denominator;
  const rearSlip =
    -input.lateralVelocity / denominator +
    (input.yawRate * 0.5) / denominator;

  const weight = ORIGINAL_TIRE_GRAVITY * config.mass;
  let frontForce: number;
  let rearForce: number;
  if (speed > ORIGINAL_LOW_SPEED && input.mode === "trigger") {
    // B545AF: the ignition window has no front-axle force.
    frontForce = 0;
    rearForce =
      maximumSteer *
      config.driftTriggerFactor *
      -weight *
      config.frontGripFactor;
  } else {
    frontForce = frontSlip * weight * config.frontGripFactor;
    rearForce = rearSlip * weight * config.rearGripFactor;
    if (speed > ORIGINAL_LOW_SPEED && input.mode === "drift") {
      frontForce *= config.driftSlipFactor;
      rearForce *= config.driftSlipFactor;
    }
  }

  const lateralForce = frontForce + rearForce;
  const yawTorque = 0.5 * frontForce - 0.5 * rearForce;
  const cornerDrawForwardForce =
    speed > ORIGINAL_LOW_SPEED && input.mode === "grip"
      ? Math.abs(lateralForce) * config.cornerDrawFactor
      : 0;
  let rollTorque = 0;
  if (speed > ORIGINAL_LOW_SPEED && input.mode === "drift") {
    const lowSpeedScale = speed <= ORIGINAL_LEAN_SPEED ? 0.5 : 1;
    rollTorque =
      -lateralForce * config.driftLeanFactor * lowSpeedScale;
  } else if (speed > ORIGINAL_LOW_SPEED && input.mode === "grip") {
    rollTorque = -lateralForce * config.steerLeanFactor;
  }

  return {
    speed,
    steerAngleRad: steerAngle,
    nextPreviousSteerAngleRad: nextPreviousSteerAngle,
    frontSlip,
    rearSlip,
    frontForce,
    rearForce,
    lateralForce,
    yawTorque,
    rollTorque,
    cornerDrawForwardForce,
  };
}

/**
 * Shift press/release entry at 0x00431a30.
 *
 * A press is accepted only after the linger window has fully expired. Releasing
 * clears AF4 but never clears the trigger window or its linger timer.
 */
export function setOriginalDriftInput(
  state: OriginalDriftState,
  pressed: boolean,
  forwardVelocity: number,
) {
  if (!pressed) {
    state.inputActive = false;
    return;
  }
  if (state.lingerTimer <= 0) {
    state.inputActive = true;
    state.triggerActive = true;
    state.entryWasForward = forwardVelocity > 0;
  }
}

/**
 * Trigger window at 0x0042fff0.
 *
 * On its first substep it seeds B0C=DriftTriggerTime and AF8=2*B0C. The linger
 * timer does not decrement while the trigger window is active.
 */
export function stepOriginalDriftTrigger(
  state: OriginalDriftState,
  driftTriggerTime: number,
  deltaSeconds: number,
) {
  if (!state.triggerActive) return;
  if (state.triggerTimer <= 0) {
    // Native state fields are 32-bit floats. Keep timer arithmetic in the same
    // precision so a 0.1 s / 5 ms fixture retains the original final tick.
    state.triggerTimer = Math.fround(driftTriggerTime);
    state.lingerTimer = Math.fround(state.triggerTimer * 2);
    return;
  }
  state.triggerTimer = Math.fround(
    state.triggerTimer - Math.fround(deltaSeconds),
  );
  if (state.triggerTimer <= 0) {
    state.triggerTimer = 0;
    state.triggerActive = false;
  }
}

/** Linger countdown at 0x00430244, called only outside the trigger window. */
export function stepOriginalDriftLinger(
  state: OriginalDriftState,
  deltaSeconds: number,
) {
  state.lingerTimer = Math.max(
    0,
    Math.fround(state.lingerTimer - Math.fround(deltaSeconds)),
  );
}

/**
 * Low-speed reset and the automatic-slip gate at 0x0042fef8 / 0xB544cb.
 *
 * P3563 raises the automatic-slip gate from the demo's >5 m/s to >15 m/s and
 * clears both timers with the flags at <=5 m/s.
 */
export function updateOriginalDriftSlip(
  state: OriginalDriftState,
  speed: number,
  forwardVelocity: number,
  lateralVelocity: number,
) {
  state.slipDetected = false;
  if (speed <= ORIGINAL_LOW_SPEED) {
    state.triggerActive = false;
    state.inputActive = false;
    state.slipDetected = false;
    state.triggerTimer = 0;
    state.lingerTimer = 0;
    return;
  }
  if (!state.inputActive && !state.triggerActive) {
    state.slipDetected =
      speed > ORIGINAL_AUTO_SLIP_SPEED &&
      Math.abs(lateralVelocity) >
        Math.abs(forwardVelocity) * ORIGINAL_AUTO_SLIP_RATIO;
  }
}

/** Resolve the force mode from the recovered state flags. */
export function originalLateralMode(
  state: OriginalDriftState,
): OriginalLateralMode {
  if (state.triggerActive) return "trigger";
  if (
    state.inputActive ||
    state.slipDetected ||
    state.lingerTimer > 0
  ) {
    return "drift";
  }
  return "grip";
}
