/**
 * Deterministic fixed-step kart simulator.
 *
 * This module deliberately has no Three.js or DOM dependencies. All motion is
 * planar (X/Z); `y` is supplied by an optional ground-height or route sampler.
 *
 * World convention:
 *   forward = (sin(yaw), 0, cos(yaw))
 *   right   = (cos(yaw), 0, -sin(yaw))
 * Positive steer therefore increases yaw and turns toward the body's +right
 * vector. The project's route.json startYaw is atan2(forward.x, forward.z),
 * which is the same convention.
 */

export const FIXED_STEP_SECONDS = 0.002;

export type DriftPhase = "none" | "trigger" | "active" | "decay";

export interface VehicleInput {
  /** 0..1. */
  throttle?: number;
  /** 0..1. Brakes while moving forward, reverses once stopped. */
  brake?: number;
  /** -1..1. Positive steer increases yaw (see module convention). */
  steer?: number;
  /** Held drift key. A press is latched at the fixed step where it begins. */
  drift?: boolean;
  /** Edge-triggered nitro request; consumes a full gauge. */
  boost?: boolean;
}

export interface VehicleState {
  x: number;
  y: number;
  z: number;
  /** Radians. Wrapped to (-PI, PI]. */
  yaw: number;
  /** Signed forward speed in m/s (negative while reversing). */
  speed: number;
  /** Body-right lateral speed in m/s. */
  lateralSpeed: number;
  /** Nitro gauge as 0..1, including uncommitted drift charge. */
  gauge: number;
  boosting: boolean;
  drifting: boolean;
  driftPhase: DriftPhase;
  boostCount: number;
  /** Distance along the course in metres, when a route is attached. */
  progress: number;
  /** progress / route length, in 0..1. */
  lapProgress: number;
  /** Completed forward start-line crossings. */
  lap: number;
  /** Signed offset from the route centreline. Positive is route-right. */
  lateralOffset: number;
  boostRemaining: number;
  /** Simulation time in seconds. */
  time: number;
}

export interface VehicleTuning {
  mass: number;
  forwardAccel: number;
  backwardAccel: number;
  gripBrake: number;
  airFriction: number;
  dragFactor: number;
  boostAccelFactor: number;
  startBoostAccelFactor: number;
  steerConstraint: number;
  maxSteerDeg: number;
  steeringExponentialScale: number;
  /** First-order steering response, per second. */
  steeringResponse: number;
  tireStiffness: number;
  /** Per-axle tire force multiplier (official tire grip factor calibration). */
  tireGrip: number;
  tireSlipLimitRad: number;
  halfWheelbase: number;
  yawInertiaDiv: number;
  yawRateLimit: number;
  driftYawRateLimit: number;
  yawDamping: number;
  straightYawDamping: number;
  normalLateralDamping: number;
  driftLateralDamping: number;
  decayLateralDamping: number;
  cornerDrawFactor: number;
  driftTrigTime: number;
  driftDecayTime: number;
  driftSlipFactor: number;
  driftTriggerFrontGrip: number;
  /** Extra yaw-rate impulse at drift ignition, rad/s. */
  driftEntryYaw: number;
  driftStopSpeed: number;
  driftMaxGauge: number;
  /** Official slow-charge calibration from tools/kartemu/kart.html. */
  driftGaugeScale: number;
  boostDuration: number;
  startBoostDuration: number;
  startBoostWindow: number;
  wallRestitution: number;
  vehicleHalfWidth: number;
}

export const DEFAULT_TUNING: VehicleTuning = {
  mass: 100,
  forwardAccel: 2160,
  backwardAccel: 1775,
  gripBrake: 2070,
  airFriction: 3,
  dragFactor: 0.75,
  boostAccelFactor: 1.494,
  startBoostAccelFactor: 1.494,
  steerConstraint: 22.25,
  maxSteerDeg: 10,
  steeringExponentialScale: 1,
  steeringResponse: 14,
  tireStiffness: 980,
  tireGrip: 5,
  tireSlipLimitRad: 0.1,
  halfWheelbase: 0.5,
  yawInertiaDiv: 12,
  yawRateLimit: 2.5,
  driftYawRateLimit: 1.35,
  yawDamping: 1.2,
  straightYawDamping: 10,
  normalLateralDamping: 3,
  driftLateralDamping: 1.8,
  decayLateralDamping: 3.5,
  cornerDrawFactor: 0.18,
  driftTrigTime: 0.2,
  driftDecayTime: 0.4,
  driftSlipFactor: 0.2,
  driftTriggerFrontGrip: 0.45,
  driftEntryYaw: 0.25,
  driftStopSpeed: 5,
  driftMaxGauge: 4300,
  driftGaugeScale: 3.7,
  boostDuration: 3,
  // Official startBoosterTimeSpeed is not present in the extracted table.
  // 0.5 s follows the existing kart.html prototype and is an approximation.
  startBoostDuration: 0.5,
  startBoostWindow: 0.1,
  wallRestitution: 0.25,
  vehicleHalfWidth: 0.6,
};

export interface RoadSurface {
  /** Multiplier for tire lateral force and lateral damping. Default 1. */
  grip?: number;
  /** Multiplier for aerodynamic drag. Default 1. */
  drag?: number;
  /** Multiplier for throttle force. Default 1. */
  acceleration?: number;
  /** Multiplier for drift gauge accumulation. Default 1. */
  driftGauge?: number;
  /** Normalised gauge added per second (bcharge-style road). */
  boostCharge?: number;
}

export type SurfaceSampler = (
  x: number,
  z: number,
  progress: number,
) => RoadSurface | null | undefined;

export interface RoutePointLike {
  p: readonly [number, number, number];
  f?: readonly [number, number, number];
  u?: readonly [number, number, number];
  s?: number;
  curvature?: number;
}

export interface RouteSample {
  x: number;
  y: number;
  z: number;
  /** Unit tangent in X/Z. */
  tangentX: number;
  tangentZ: number;
  /** Unit route-right vector in X/Z. */
  rightX: number;
  rightZ: number;
  /** Distance along the route in metres. */
  progress: number;
  /** Signed lateral offset from the centreline (positive = route-right). */
  lateral: number;
  /** Index of the segment that produced this sample. */
  segment: number;
}

export interface RouteSampler {
  readonly length: number;
  nearest(x: number, z: number, hint?: number): RouteSample;
}

interface RouteSegment {
  ax: number;
  ay: number;
  az: number;
  dx: number;
  dz: number;
  length: number;
  lengthSq: number;
  startProgress: number;
  tangentX: number;
  tangentZ: number;
}

/**
 * Build a closed-loop nearest-point sampler from route.json-style points.
 * If `length` is supplied (for example meta.json's route length), progress is
 * scaled to that authoritative value; otherwise the sampled polyline length is
 * used.
 */
export function createRouteSampler(
  points: readonly RoutePointLike[],
  length?: number,
): RouteSampler {
  if (points.length === 0) {
    throw new Error("createRouteSampler requires at least one point");
  }

  const segments: RouteSegment[] = [];
  let sampledLength = 0;
  const count = points.length;
  const segmentCount = count > 1 ? count : 1;

  for (let index = 0; index < segmentCount; index += 1) {
    const from = points[index];
    const to = points[(index + 1) % count];
    const dx = to.p[0] - from.p[0];
    const dz = to.p[2] - from.p[2];
    const segmentLength = Math.hypot(dx, dz);
    const tangentX = segmentLength > 1e-9 ? dx / segmentLength : 1;
    const tangentZ = segmentLength > 1e-9 ? dz / segmentLength : 0;

    segments.push({
      ax: from.p[0],
      ay: from.p[1],
      az: from.p[2],
      dx,
      dz,
      length: segmentLength,
      lengthSq: dx * dx + dz * dz,
      startProgress: sampledLength,
      tangentX,
      tangentZ,
    });
    sampledLength += segmentLength;

    if (count === 1) {
      break;
    }
  }

  const routeLength =
    Number.isFinite(length) && (length as number) > 0
      ? (length as number)
      : sampledLength;
  const progressScale = sampledLength > 1e-9 ? routeLength / sampledLength : 1;

  return {
    length: routeLength,
    nearest(x: number, z: number): RouteSample {
      let bestDistanceSq = Number.POSITIVE_INFINITY;
      let bestSegment = 0;
      let bestT = 0;

      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        let t = 0;
        if (segment.lengthSq > 1e-12) {
          t =
            ((x - segment.ax) * segment.dx + (z - segment.az) * segment.dz) /
            segment.lengthSq;
          t = clamp(t, 0, 1);
        }
        const px = segment.ax + segment.dx * t;
        const pz = segment.az + segment.dz * t;
        const offsetX = x - px;
        const offsetZ = z - pz;
        const distanceSq = offsetX * offsetX + offsetZ * offsetZ;
        if (distanceSq < bestDistanceSq) {
          bestDistanceSq = distanceSq;
          bestSegment = index;
          bestT = t;
        }
      }

      const segment = segments[bestSegment];
      const from = points[bestSegment];
      const to = points[(bestSegment + 1) % count];
      const cx = segment.ax + segment.dx * bestT;
      const cz = segment.az + segment.dz * bestT;
      const cy = from.p[1] + (to.p[1] - from.p[1]) * bestT;
      const rightX = segment.tangentZ;
      const rightZ = -segment.tangentX;
      const lateral =
        (x - cx) * rightX + (z - cz) * rightZ;

      return {
        x: cx,
        y: cy,
        z: cz,
        tangentX: segment.tangentX,
        tangentZ: segment.tangentZ,
        rightX,
        rightZ,
        progress:
          (segment.startProgress + segment.length * bestT) * progressScale,
        lateral,
        segment: bestSegment,
      };
    },
  };
}

export type RoadHalfWidthSampler = (
  progress: number,
  x: number,
  z: number,
  sample: RouteSample,
) => number;

export interface VehicleOptions {
  position?: { x?: number; y?: number; z?: number };
  yaw?: number;
  speed?: number;
  tuning?: Partial<VehicleTuning>;
  /** Initial nitro gauge, 0..1. */
  initialGauge?: number;
  /** Simulation time of the race start, used for the +/-100 ms start boost. */
  startAtSeconds?: number | null;
  route?: RouteSampler | null;
  /** Road surface query, called once per 2 ms substep. */
  surfaceAt?: SurfaceSampler | null;
  /** Optional ground height. Wins over route height. */
  groundHeightAt?: ((x: number, z: number, progress: number) => number) | null;
  /** Constant or callback half-width. Wall collision needs a route sampler. */
  roadHalfWidth?: number | RoadHalfWidthSampler | null;
  /** Follow the attached route's interpolated Y. Default true. */
  followRouteHeight?: boolean;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function wrapAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  let wrapped = angle % twoPi;
  if (wrapped > Math.PI) wrapped -= twoPi;
  if (wrapped < -Math.PI) wrapped += twoPi;
  return wrapped;
}

export class KartVehicle {
  private readonly configuration: VehicleTuning;
  private x: number;
  private y: number;
  private z: number;
  private yawValue: number;
  private forwardSpeed: number;
  private lateralVelocity: number;
  private yawRate: number;
  private steerSmoothed: number;
  private driftPhaseValue: DriftPhase;
  private driftDirection: number;
  private driftTimer: number;
  private driftGaugeElapsed: number;
  private committedGauge: number;
  private pendingGauge: number;
  private boostRemainingValue: number;
  private boostKind: "none" | "start" | "nitro";
  private boostActivations: number;
  private startBoostConsumed: boolean;
  private startAtSecondsValue: number | null;
  private previousThrottleDown: boolean;
  private previousDriftChord: boolean;
  private previousBoostDown: boolean;
  private accumulatorSeconds: number;
  private elapsedSeconds: number;
  private routeValue: RouteSampler | null;
  private surfaceSampler: SurfaceSampler | null;
  private groundHeightSampler:
    | ((x: number, z: number, progress: number) => number)
    | null;
  private halfWidthSampler: RoadHalfWidthSampler | null;
  private followRouteHeightValue: boolean;
  private routeSample: RouteSample | null;
  private previousRouteProgress: number | null;
  private routeProgress: number;
  private lapProgressValue: number;
  private lapValue: number;
  private lateralOffsetValue: number;

  constructor(options: VehicleOptions = {}) {
    this.configuration = { ...DEFAULT_TUNING, ...(options.tuning ?? {}) };
    this.x = finiteOr(options.position?.x, 0);
    this.y = finiteOr(options.position?.y, 0);
    this.z = finiteOr(options.position?.z, 0);
    this.yawValue = wrapAngle(finiteOr(options.yaw, 0));
    this.forwardSpeed = finiteOr(options.speed, 0);
    this.lateralVelocity = 0;
    this.yawRate = 0;
    this.steerSmoothed = 0;
    this.driftPhaseValue = "none";
    this.driftDirection = 0;
    this.driftTimer = 0;
    this.driftGaugeElapsed = 0;
    this.committedGauge = clamp(
      finiteOr(options.initialGauge, 0),
      0,
      1,
    ) * this.configuration.driftMaxGauge;
    this.pendingGauge = 0;
    this.boostRemainingValue = 0;
    this.boostKind = "none";
    this.boostActivations = 0;
    this.startBoostConsumed = false;
    this.startAtSecondsValue =
      typeof options.startAtSeconds === "number" &&
      Number.isFinite(options.startAtSeconds)
        ? options.startAtSeconds
        : null;
    this.previousThrottleDown = false;
    this.previousDriftChord = false;
    this.previousBoostDown = false;
    this.accumulatorSeconds = 0;
    this.elapsedSeconds = 0;
    this.routeValue = options.route ?? null;
    this.surfaceSampler = options.surfaceAt ?? null;
    this.groundHeightSampler = options.groundHeightAt ?? null;
    this.halfWidthSampler =
      typeof options.roadHalfWidth === "function"
        ? options.roadHalfWidth
        : typeof options.roadHalfWidth === "number" &&
            Number.isFinite(options.roadHalfWidth)
          ? () => options.roadHalfWidth as number
          : null;
    this.followRouteHeightValue = options.followRouteHeight ?? true;
    this.routeSample = null;
    this.previousRouteProgress = null;
    this.routeProgress = 0;
    this.lapProgressValue = 0;
    this.lapValue = 0;
    this.lateralOffsetValue = 0;
  }

  get tuning(): Readonly<VehicleTuning> {
    return this.configuration;
  }

  get state(): VehicleState {
    const gaugeTotal = this.committedGauge + this.pendingGauge;
    return {
      x: this.x,
      y: this.y,
      z: this.z,
      yaw: this.yawValue,
      speed: this.forwardSpeed,
      lateralSpeed: this.lateralVelocity,
      gauge: clamp(gaugeTotal / this.configuration.driftMaxGauge, 0, 1),
      boosting: this.boostRemainingValue > 0,
      drifting: this.driftPhaseValue !== "none",
      driftPhase: this.driftPhaseValue,
      boostCount: this.boostActivations,
      progress: this.routeProgress,
      lapProgress: this.lapProgressValue,
      lap: this.lapValue,
      lateralOffset: this.lateralOffsetValue,
      boostRemaining: this.boostRemainingValue,
      time: this.elapsedSeconds,
    };
  }

  setStartAt(seconds: number | null): void {
    this.startAtSecondsValue =
      typeof seconds === "number" && Number.isFinite(seconds) ? seconds : null;
    this.startBoostConsumed = false;
  }

  primeThrottleHeld(held: boolean): void {
    this.previousThrottleDown = held;
  }

  setRoute(route: RouteSampler | null): void {
    this.routeValue = route;
    this.routeSample = null;
    this.previousRouteProgress = null;
    this.routeProgress = 0;
    this.lapProgressValue = 0;
    this.lapValue = 0;
    this.lateralOffsetValue = 0;
  }

  /** Respawn on the course without resetting race timing or collected gauge. */
  resetPose(x: number, y: number, z: number, yaw: number): void {
    this.finishDrift();
    this.x = x;
    this.y = y;
    this.z = z;
    this.yawValue = wrapAngle(yaw);
    this.forwardSpeed = 0;
    this.lateralVelocity = 0;
    this.yawRate = 0;
    this.steerSmoothed = 0;
    this.accumulatorSeconds = 0;
    this.routeSample = null;
    this.previousRouteProgress = this.routeProgress;
    this.lateralOffsetValue = 0;
  }

  setRoadHalfWidth(
    halfWidth: number | RoadHalfWidthSampler | null,
  ): void {
    this.halfWidthSampler =
      typeof halfWidth === "function"
        ? halfWidth
        : typeof halfWidth === "number" && Number.isFinite(halfWidth)
          ? () => halfWidth
          : null;
  }

  setSurfaceSampler(surfaceAt: SurfaceSampler | null): void {
    this.surfaceSampler = surfaceAt;
  }

  /**
   * Advance the simulation. Input is sampled once per fixed 2 ms substep, so
   * controller results are independent of the caller's render frame rate.
   * Returns the post-step state.
   */
  step(deltaSeconds: number, input: VehicleInput = {}): VehicleState {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
      return this.state;
    }

    // Prevent a background-tab gap from creating an unbounded catch-up loop.
    this.accumulatorSeconds += Math.min(deltaSeconds, 0.25);
    const epsilon = FIXED_STEP_SECONDS * 1e-6;
    while (this.accumulatorSeconds + epsilon >= FIXED_STEP_SECONDS) {
      this.substep(input);
      this.accumulatorSeconds -= FIXED_STEP_SECONDS;
      if (this.accumulatorSeconds < 0 && this.accumulatorSeconds > -epsilon) {
        this.accumulatorSeconds = 0;
      }
    }
    return this.state;
  }

  private substep(input: VehicleInput): void {
    const partialStep = FIXED_STEP_SECONDS;
    const throttle = clamp(finiteOr(input.throttle, 0), 0, 1);
    const brake = clamp(finiteOr(input.brake, 0), 0, 1);
    const steerTarget = clamp(finiteOr(input.steer, 0), -1, 1);
    const driftHeld = input.drift === true;
    const boostHeld = input.boost === true;
    const throttleDown = throttle > 0.01;
    const throttleEdge = throttleDown && !this.previousThrottleDown;
    const driftChord = driftHeld && Math.abs(steerTarget) > 0.05;
    const driftEdge = driftChord && !this.previousDriftChord;
    const boostEdge = boostHeld && !this.previousBoostDown;

    const surface =
      this.surfaceSampler?.(this.x, this.z, this.routeProgress) ?? {};
    const gripMultiplier = Math.max(0, finiteOr(surface.grip, 1));
    const dragMultiplier = Math.max(0, finiteOr(surface.drag, 1));
    const accelerationMultiplier = Math.max(
      0,
      finiteOr(surface.acceleration, 1),
    );
    const driftGaugeMultiplier = Math.max(
      0,
      finiteOr(surface.driftGauge, 1),
    );
    const boostCharge = Math.max(0, finiteOr(surface.boostCharge, 0));

    if (boostCharge > 0) {
      this.committedGauge = Math.min(
        this.configuration.driftMaxGauge,
        this.committedGauge +
          boostCharge * this.configuration.driftMaxGauge * partialStep,
      );
    }

    if (
      throttleEdge &&
      !this.startBoostConsumed &&
      this.startAtSecondsValue !== null &&
      this.boostRemainingValue <= 0 &&
      Math.abs(this.elapsedSeconds - this.startAtSecondsValue) <=
        this.configuration.startBoostWindow + 1e-9
    ) {
      this.startBoostConsumed = true;
      this.boostKind = "start";
      this.boostRemainingValue = this.configuration.startBoostDuration;
      this.boostActivations += 1;
    }

    if (
      boostEdge &&
      this.boostRemainingValue <= 0 &&
      this.committedGauge + this.pendingGauge >=
        this.configuration.driftMaxGauge
    ) {
      this.committedGauge = 0;
      this.pendingGauge = 0;
      this.boostKind = "nitro";
      this.boostRemainingValue = this.configuration.boostDuration;
      this.boostActivations += 1;
    }

    this.updateDriftState(
      driftHeld,
      driftEdge,
      steerTarget,
      partialStep,
    );

    this.steerSmoothed +=
      (steerTarget - this.steerSmoothed) *
      (1 - Math.exp(-this.configuration.steeringResponse * partialStep));

    const boostActive = this.boostRemainingValue > 0;
    const boostMultiplier = boostActive
      ? this.boostKind === "start"
        ? this.configuration.startBoostAccelFactor
        : this.configuration.boostAccelFactor
      : 1;

    let longitudinalAcceleration = 0;
    if (throttle > 0) {
      longitudinalAcceleration +=
        (this.configuration.forwardAccel *
          throttle *
          boostMultiplier *
          accelerationMultiplier) /
        this.configuration.mass;
    }
    if (brake > 0) {
      const brakingForce =
        this.forwardSpeed > 0.5
          ? this.configuration.gripBrake
          : this.configuration.backwardAccel;
      longitudinalAcceleration -= (brakingForce * brake) / this.configuration.mass;
    }

    const dragForce =
      this.forwardSpeed * this.configuration.airFriction +
      this.forwardSpeed *
        Math.abs(this.forwardSpeed) *
        this.configuration.dragFactor *
        dragMultiplier;
    longitudinalAcceleration -= dragForce / this.configuration.mass;
    this.forwardSpeed += longitudinalAcceleration * partialStep;

    if (
      throttle <= 0.01 &&
      brake <= 0.01 &&
      Math.abs(this.forwardSpeed) < 0.15
    ) {
      this.forwardSpeed = 0;
    }

    const speedMagnitude = Math.abs(this.forwardSpeed);
    const travelSign = this.forwardSpeed < 0 ? -1 : 1;
    const maxSteeringAngle = this.configuration.maxSteerDeg * Math.PI / 180;
    const steeringAngle =
      this.steerSmoothed *
      maxSteeringAngle *
      Math.exp(
        (-speedMagnitude / this.configuration.steerConstraint) *
          this.configuration.steeringExponentialScale,
      ) *
      travelSign;

    const speedReference = Math.max(speedMagnitude, 2);
    const axleSpeed = this.yawRate * this.configuration.halfWheelbase;
    let frontSlip = steeringAngle -
      Math.atan2(this.lateralVelocity + axleSpeed, speedReference);
    let rearSlip = -Math.atan2(this.lateralVelocity - axleSpeed, speedReference);

    let frontGrip = 1;
    let rearGrip = 1;
    if (this.driftPhaseValue === "trigger") {
      frontSlip = this.driftDirection * maxSteeringAngle;
      frontGrip = this.configuration.driftTriggerFrontGrip;
      rearGrip = 0;
    } else if (this.driftPhaseValue === "active") {
      frontGrip = this.configuration.driftSlipFactor;
      rearGrip = frontGrip;
    } else if (this.driftPhaseValue === "decay") {
      const recovery = clamp(
        1 - this.driftTimer / this.configuration.driftDecayTime,
        0,
        1,
      );
      frontGrip = this.configuration.driftSlipFactor +
        (1 - this.configuration.driftSlipFactor) * recovery;
      rearGrip = frontGrip;
    } else {
      const slipLimit = this.configuration.tireSlipLimitRad;
      frontSlip = clamp(frontSlip, -slipLimit, slipLimit);
      rearSlip = clamp(rearSlip, -slipLimit, slipLimit);
    }
    frontGrip *= gripMultiplier;
    rearGrip *= gripMultiplier;

    const tireSpeedScale = clamp(speedMagnitude / 2, 0, 1);
    const frontForce =
      this.configuration.tireStiffness *
      this.configuration.tireGrip *
      frontGrip *
      frontSlip *
      tireSpeedScale;
    const rearForce =
      this.configuration.tireStiffness *
      this.configuration.tireGrip *
      rearGrip *
      rearSlip *
      tireSpeedScale;

    this.lateralVelocity +=
      ((frontForce + rearForce) / this.configuration.mass) * partialStep;
    this.yawRate +=
      ((this.configuration.halfWheelbase * (frontForce - rearForce)) /
        (this.configuration.mass / this.configuration.yawInertiaDiv)) *
      partialStep;

    this.yawRate *= Math.exp(
      -this.configuration.yawDamping * partialStep,
    );
    if (Math.abs(this.steerSmoothed) < 0.05) {
      this.yawRate *= Math.exp(
        -this.configuration.straightYawDamping * partialStep,
      );
    }
    const yawRateLimit = this.driftPhaseValue === "none"
      ? this.configuration.yawRateLimit
      : this.configuration.driftYawRateLimit;
    this.yawRate = clamp(
      this.yawRate,
      -yawRateLimit,
      yawRateLimit,
    );

    const lateralDamping =
      this.driftPhaseValue === "none"
        ? this.configuration.normalLateralDamping
        : this.driftPhaseValue === "decay"
          ? this.configuration.decayLateralDamping
          : this.configuration.driftLateralDamping;
    this.lateralVelocity *= Math.exp(-lateralDamping * gripMultiplier * partialStep);

    if (this.forwardSpeed !== 0) {
      this.forwardSpeed -=
        Math.sign(this.forwardSpeed) *
        this.configuration.cornerDrawFactor *
        (Math.abs(frontForce + rearForce) / this.configuration.mass) *
        partialStep;
    }

    const yawDelta = this.yawRate * partialStep;
    this.yawValue = wrapAngle(this.yawValue + yawDelta);

    // Rotate the body-frame velocity opposite to the yaw change: world velocity
    // is momentarily unchanged while the chassis turns underneath it.
    const cosYaw = Math.cos(yawDelta);
    const sinYaw = Math.sin(yawDelta);
    const previousForwardSpeed = this.forwardSpeed;
    const previousLateralSpeed = this.lateralVelocity;
    this.forwardSpeed =
      previousForwardSpeed * cosYaw + previousLateralSpeed * sinYaw;
    this.lateralVelocity =
      previousLateralSpeed * cosYaw - previousForwardSpeed * sinYaw;

    const forwardX = Math.sin(this.yawValue);
    const forwardZ = Math.cos(this.yawValue);
    const rightX = Math.cos(this.yawValue);
    const rightZ = -Math.sin(this.yawValue);
    this.x +=
      (forwardX * this.forwardSpeed + rightX * this.lateralVelocity) *
      partialStep;
    this.z +=
      (forwardZ * this.forwardSpeed + rightZ * this.lateralVelocity) *
      partialStep;

    if (
      this.driftPhaseValue === "active" ||
      this.driftPhaseValue === "decay"
    ) {
      this.fillDriftGauge(
        driftGaugeMultiplier,
        partialStep,
      );
    }

    this.updateRoute();

    if (this.boostRemainingValue > 0) {
      this.boostRemainingValue = Math.max(
        0,
        this.boostRemainingValue - partialStep,
      );
      if (this.boostRemainingValue === 0) {
        this.boostKind = "none";
      }
    }

    this.elapsedSeconds += partialStep;
    this.previousThrottleDown = throttleDown;
    this.previousDriftChord = driftChord;
    this.previousBoostDown = boostHeld;
  }

  private updateDriftState(
    driftHeld: boolean,
    driftEdge: boolean,
    steerTarget: number,
    deltaSeconds: number,
  ): void {
    if (
      driftEdge &&
      this.driftPhaseValue === "none" &&
      this.forwardSpeed >= this.configuration.driftStopSpeed
    ) {
      this.driftPhaseValue = "trigger";
      this.driftDirection = steerTarget > 0 ? 1 : -1;
      this.driftTimer = this.configuration.driftTrigTime;
      this.driftGaugeElapsed = 0;
      this.yawRate +=
        this.driftDirection * this.configuration.driftEntryYaw;
    }

    if (this.driftPhaseValue === "trigger") {
      this.driftTimer -= deltaSeconds;
      if (this.driftTimer <= 0) {
        this.driftPhaseValue = driftHeld ? "active" : "decay";
        this.driftTimer =
          this.driftPhaseValue === "decay"
            ? this.configuration.driftDecayTime
            : 0;
        this.driftGaugeElapsed = 0;
      }
      return;
    }

    if (this.driftPhaseValue === "active") {
      if (!driftHeld || steerTarget * this.driftDirection < -0.05) {
        this.driftPhaseValue = "decay";
        this.driftTimer = this.configuration.driftDecayTime;
      } else if (
        Math.abs(this.forwardSpeed) < this.configuration.driftStopSpeed
      ) {
        this.finishDrift();
      }
      return;
    }

    if (this.driftPhaseValue === "decay") {
      this.driftTimer -= deltaSeconds;
      if (
        this.driftTimer <= 0 ||
        Math.abs(this.forwardSpeed) < this.configuration.driftStopSpeed
      ) {
        this.finishDrift();
      }
    }
  }

  private finishDrift(): void {
    this.driftPhaseValue = "none";
    this.driftDirection = 0;
    this.driftTimer = 0;
    this.driftGaugeElapsed = 0;
    this.committedGauge = Math.min(
      this.configuration.driftMaxGauge,
      this.committedGauge + this.pendingGauge,
    );
    this.pendingGauge = 0;
  }

  private fillDriftGauge(
    surfaceMultiplier: number,
    deltaSeconds: number,
  ): void {
    if (this.forwardSpeed < 0) return;

    this.driftGaugeElapsed += deltaSeconds;
    const elapsed = this.driftGaugeElapsed;
    const weight = elapsed < 0.2 ? 3 : elapsed < 0.5 ? 1.5 : 1 / (2 * elapsed);
    const charge =
      this.lateralVelocity *
      this.lateralVelocity *
      deltaSeconds *
      this.configuration.driftGaugeScale *
      weight *
      surfaceMultiplier;
    this.pendingGauge = Math.min(
      this.configuration.driftMaxGauge - this.committedGauge,
      this.pendingGauge + charge,
    );
  }

  private updateRoute(): void {
    if (this.routeValue !== null) {
      const sample = this.routeValue.nearest(
        this.x,
        this.z,
        this.routeSample?.segment,
      );
      this.routeSample = sample;
      this.routeProgress = sample.progress;
      this.lapProgressValue =
        this.routeValue.length > 1e-9
          ? clamp(sample.progress / this.routeValue.length, 0, 1)
          : 0;
      this.lateralOffsetValue = sample.lateral;

      if (
        this.previousRouteProgress !== null &&
        this.routeValue.length > 1e-9
      ) {
        const progressDelta = sample.progress - this.previousRouteProgress;
        const halfLength = this.routeValue.length * 0.5;
        if (progressDelta < -halfLength) {
          this.lapValue += 1;
        } else if (progressDelta > halfLength) {
          this.lapValue = Math.max(0, this.lapValue - 1);
        }
      }
      this.previousRouteProgress = sample.progress;

      if (this.halfWidthSampler !== null) {
        const halfWidth = this.halfWidthSampler(
          sample.progress,
          this.x,
          this.z,
          sample,
        );
        this.resolveWall(sample, halfWidth);
      }

      if (this.groundHeightSampler !== null) {
        const height = this.groundHeightSampler(
          this.x,
          this.z,
          sample.progress,
        );
        if (Number.isFinite(height)) this.y = height;
      } else if (this.followRouteHeightValue) {
        this.y = sample.y;
      }
    } else if (this.groundHeightSampler !== null) {
      const height = this.groundHeightSampler(this.x, this.z, 0);
      if (Number.isFinite(height)) this.y = height;
    }
  }

  private resolveWall(sample: RouteSample, halfWidth: number): void {
    if (!Number.isFinite(halfWidth)) return;
    const limit = Math.max(
      0,
      halfWidth - this.configuration.vehicleHalfWidth,
    );
    const lateral = sample.lateral;
    if (Math.abs(lateral) <= limit) {
      this.lateralOffsetValue = lateral;
      return;
    }

    const side = lateral >= 0 ? 1 : -1;
    this.x = sample.x + sample.rightX * limit * side;
    this.z = sample.z + sample.rightZ * limit * side;
    this.lateralOffsetValue = limit * side;

    const normalX = sample.rightX * side;
    const normalZ = sample.rightZ * side;
    const forwardX = Math.sin(this.yawValue);
    const forwardZ = Math.cos(this.yawValue);
    const rightX = Math.cos(this.yawValue);
    const rightZ = -Math.sin(this.yawValue);

    let velocityX =
      forwardX * this.forwardSpeed + rightX * this.lateralVelocity;
    let velocityZ =
      forwardZ * this.forwardSpeed + rightZ * this.lateralVelocity;
    const normalVelocity = velocityX * normalX + velocityZ * normalZ;
    if (normalVelocity > 0) {
      const restitution = this.configuration.wallRestitution;
      velocityX -= normalX * normalVelocity * (1 + restitution);
      velocityZ -= normalZ * normalVelocity * (1 + restitution);
    }

    this.forwardSpeed = velocityX * forwardX + velocityZ * forwardZ;
    this.lateralVelocity = velocityX * rightX + velocityZ * rightZ;
    this.yawRate *= 0.5;
  }
}
