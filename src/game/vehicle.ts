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

import type { TrackWallContact } from "./track-collision";

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
  collisionCount: number;
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
  /** Planar throttle calibration against the recorded P3563 straight. */
  driveScale: number;
  tireStiffness: number;
  /** Per-axle tire force multiplier (official tire grip factor calibration). */
  tireGrip: number;
  halfWheelbase: number;
  /** Planar moment of inertia divided by mass, in square metres. */
  yawInertiaPerMass: number;
  yawDamping: number;
  straightYawDamping: number;
  cornerDrawFactor: number;
  driftTrigTime: number;
  driftDecayTime: number;
  driftSlipFactor: number;
  driftTriggerFactor: number;
  driftEscapeForce: number;
  tireResponseTime: number;
  driftStopSpeed: number;
  driftMaxGauge: number;
  /** Gauge gain calibrated in the Web simulator. */
  driftGaugeScale: number;
  boostDuration: number;
  startBoostDuration: number;
  startBoostWindow: number;
  wallRestitution: number;
  vehicleHalfWidth: number;
  vehicleHalfLength: number;
  collisionCenterForward: number;
  driftGaugePreserveOnImpact: number;
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
  // P3563 S7 uses the Default profile in ExcData.SpeedType. Cotton1 adds
  // 10 N forward and 50 N reverse through its own BodyParam resource.
  // The planar projection's effective thrust matches the 173 → 199 km/h
  // straight in the P3563 recording (2.56 s). The stock force stays in N.
  steeringExponentialScale: 1,
  driveScale: 1.175,
  tireStiffness: 980,
  tireGrip: 5,
  halfWheelbase: 0.5,
  yawInertiaPerMass: 0.87,
  yawDamping: 0.35,
  straightYawDamping: 6,
  cornerDrawFactor: 0.18,
  driftTrigTime: 0.2,
  driftDecayTime: 0.4,
  driftSlipFactor: 0.2,
  driftTriggerFactor: 0.2,
  driftEscapeForce: 2600,
  tireResponseTime: 0.16,
  driftStopSpeed: 5,
  driftMaxGauge: 4300,
  driftGaugeScale: 3.7,
  boostDuration: 3,
  // Official startBoosterTimeSpeed is not present in the extracted table.
  // 0.5 s follows the existing kart.html prototype and is an approximation.
  startBoostDuration: 0.5,
  startBoostWindow: 0.1,
  wallRestitution: 0.5,
  // Cotton1 ReKart.rootBounds, with the model's -Y axis pointing forward.
  vehicleHalfWidth: 0.80756,
  vehicleHalfLength: 0.85441,
  collisionCenterForward: 0.05448,
  driftGaugePreserveOnImpact: 0.5,
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
  nearest(x: number, z: number, hint?: number, heightHint?: number): RouteSample;
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
  groundHeightAt?: ((
    x: number, z: number, progress: number, previousHeight: number,
  ) => number | null) | null;
  /** Deepest overlapping track wall, sampled at the kart's footprint centre. */
  wallContactAt?: ((
    x: number, y: number, z: number, yaw: number, halfWidth: number, halfLength: number,
  ) => TrackWallContact | null) | null;
  /** Constant or callback half-width for courses without collision geometry. */
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
  private tireEnvelope = 0;
  private driftPhaseValue: DriftPhase;
  private driftDirection: number;
  private driftTimer: number;
  private driftGaugeElapsed: number;
  private committedGauge: number;
  private pendingGauge: number;
  private boostRemainingValue: number;
  private boostKind: "none" | "start" | "nitro";
  private boostActivations: number;
  private collisionCount = 0;
  private lastImpact = -Infinity;
  private startBoostConsumed: boolean;
  private startAtSecondsValue: number | null;
  private previousThrottleDown: boolean;
  private previousDriftChord: boolean;
  private previousBoostDown: boolean;
  private accumulatorSeconds: number;
  private elapsedSeconds: number;
  private routeValue: RouteSampler | null;
  private surfaceSampler: SurfaceSampler | null;
  private groundHeightSampler: NonNullable<VehicleOptions["groundHeightAt"]> | null;
  private readonly wallContactAt: NonNullable<VehicleOptions["wallContactAt"]> | null;
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
    this.wallContactAt = options.wallContactAt ?? null;
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
      collisionCount: this.collisionCount,
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
  resetPose(x: number, y: number, z: number, yaw: number, speed = 0): void {
    this.finishDrift();
    this.x = x;
    this.y = y;
    this.z = z;
    this.yawValue = wrapAngle(yaw);
    this.forwardSpeed = finiteOr(speed, 0);
    this.lateralVelocity = 0;
    this.yawRate = 0;
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
      driftChord,
      driftEdge,
      steerTarget,
      partialStep,
    );

    const boostActive = this.boostRemainingValue > 0;
    const boostMultiplier = boostActive
      ? this.boostKind === "start"
        ? this.configuration.startBoostAccelFactor
        : this.configuration.boostAccelFactor
      : 1;

    const spec = this.configuration;
    const speed = Math.hypot(this.forwardSpeed, this.lateralVelocity);
    const forwardMagnitude = Math.abs(this.forwardSpeed);
    const tireSpeed = Math.max(speed, 1);
    const lateralRatio = this.lateralVelocity / tireSpeed;
    const axleRatio = this.yawRate * spec.halfWheelbase / tireSpeed;
    const steerAngle = steerTarget * spec.maxSteerDeg * Math.PI / 180 *
      Math.exp(-forwardMagnitude / spec.steerConstraint * spec.steeringExponentialScale);
    const travelDirection = this.forwardSpeed < 0 ? -1 : 1;
    const tireForce = spec.tireStiffness * spec.tireGrip * gripMultiplier * Math.min(speed, 1);
    const trigger = this.driftPhaseValue === "trigger";
    const active = this.driftPhaseValue === "active";
    const sliding = speed > 15 && Math.abs(this.lateralVelocity) > 1.2 * forwardMagnitude;

    // The tires can have regained their grip while the kart is still moving sideways.
    const recovery = this.driftPhaseValue === "decay"
      ? 1 - Math.exp((this.driftTimer - spec.driftDecayTime) / spec.tireResponseTime)
      : 1;
    let frontForce: number;
    let rearForce: number;
    if (trigger) {
      // Only the front axle generates lateral force during ignition.
      frontForce = tireForce * spec.driftTriggerFactor * this.driftDirection;
      rearForce = 0;
    } else {
      let axleGrip = 1;
      if (active) {
        this.tireEnvelope += (1 - this.tireEnvelope) *
          (1 - Math.exp(-partialStep / spec.tireResponseTime));
        axleGrip = spec.driftSlipFactor * this.tireEnvelope;
      } else if (this.driftPhaseValue === "decay") {
        const releasedGrip = this.tireEnvelope * spec.driftSlipFactor;
        axleGrip = releasedGrip + (1 - releasedGrip) * recovery;
      }
      frontForce = tireForce * axleGrip * (steerAngle * travelDirection - lateralRatio - axleRatio);
      rearForce = tireForce * axleGrip * (-lateralRatio + axleRatio);
      if (active && sliding) {
        // Progressive rear bite keeps a sustained handbrake turn recoverable
        // at the reference's 1.2 lateral/forward breakaway threshold.
        const excessSlip = Math.max(0, (Math.abs(this.lateralVelocity) - 1.2 * forwardMagnitude) / tireSpeed);
        rearForce -= tireForce * excessSlip * lateralRatio;
      }
    }

    const driveForce = sliding ? spec.driftEscapeForce : spec.forwardAccel;
    let forwardForce = driveForce * spec.driveScale * throttle * boostMultiplier * accelerationMultiplier;
    if (brake > 0) {
      forwardForce -= (this.forwardSpeed > 0.5 ? spec.gripBrake : spec.backwardAccel) * brake;
    }
    // Drag uses the world velocity magnitude and acts along both components.
    const drag = spec.airFriction + speed * spec.dragFactor * dragMultiplier;
    const sideForce = frontForce + rearForce;
    if (!trigger && !active) {
      forwardForce -= travelDirection * spec.cornerDrawFactor * Math.abs(sideForce) * recovery;
    }
    this.forwardSpeed += (forwardForce - this.forwardSpeed * drag) / spec.mass * partialStep;
    this.lateralVelocity += (sideForce - this.lateralVelocity * drag) / spec.mass * partialStep;
    const yawInertia = spec.mass * spec.yawInertiaPerMass;
    const yawTorque = spec.halfWheelbase * (frontForce - rearForce) - spec.airFriction * this.yawRate;
    this.yawRate += yawTorque / yawInertia * partialStep;
    if (this.driftPhaseValue === "none") {
      // Flat-ground self-alignment after the slip window closes. Centered
      // wheels settle promptly when the driver lets go of the direction key.
      const damping = spec.straightYawDamping +
        (spec.yawDamping - spec.straightYawDamping) * Math.abs(steerTarget);
      this.yawRate *= Math.exp(-damping * gripMultiplier * partialStep);
    }
    if (speed < 0.15 && throttle === 0 && brake === 0) {
      this.forwardSpeed = 0;
      this.lateralVelocity = 0;
      this.yawRate = 0;
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

    this.updateRoute(steerTarget);

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
    if (this.driftPhaseValue !== "none" && this.forwardSpeed < this.configuration.driftStopSpeed) {
      this.finishDrift();
    }
    if (driftEdge && this.forwardSpeed >= this.configuration.driftStopSpeed &&
      (this.driftPhaseValue === "none" || (this.driftPhaseValue === "decay" && this.driftTimer <= 0))) {
      this.finishDrift();
      this.driftPhaseValue = "trigger";
      this.driftDirection = Math.sign(steerTarget);
      this.driftTimer = this.configuration.driftTrigTime;
      this.tireEnvelope = 0;
    }
    const holdingDirection = driftHeld && steerTarget * this.driftDirection > 0;
    if (this.driftPhaseValue === "trigger") {
      this.driftTimer -= deltaSeconds;
      if (this.driftTimer <= 0) {
        this.driftPhaseValue = holdingDirection ? "active" : "decay";
        this.driftTimer = holdingDirection ? 0 : this.configuration.driftDecayTime;
      }
    } else if (this.driftPhaseValue === "active" && !holdingDirection) {
      this.driftPhaseValue = "decay";
      this.driftTimer = this.configuration.driftDecayTime;
    } else if (this.driftPhaseValue === "decay") {
      this.driftTimer -= deltaSeconds;
      // The tires regrip first, then the visible skid and gauge window end
      // as the velocity catches the chassis or crosses its original heading.
      if (this.driftTimer <= 0 && -this.lateralVelocity * this.driftDirection <= 0.12 * this.forwardSpeed) {
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

  private updateRoute(steer: number): void {
    if (this.wallContactAt) {
      const { vehicleHalfWidth, vehicleHalfLength, collisionCenterForward } = this.configuration;
      const offsetX = Math.sin(this.yawValue) * collisionCenterForward;
      const offsetZ = Math.cos(this.yawValue) * collisionCenterForward;
      // A second face can still overlap after clearing the first at a corner.
      for (let pass = 0; pass < 3; pass++) {
        const contact = this.wallContactAt(
          this.x + offsetX, this.y, this.z + offsetZ, this.yawValue, vehicleHalfWidth, vehicleHalfLength,
        );
        if (!contact || !(contact.depth > 0)) break;
        this.resolveWallContact(contact, steer);
      }
    }

    if (this.routeValue !== null) {
      const sample = this.routeValue.nearest(
        this.x,
        this.z,
        this.routeSample?.segment,
        this.y,
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

      if (this.wallContactAt === null && this.halfWidthSampler !== null) {
        const halfWidth = this.halfWidthSampler(
          sample.progress,
          this.x,
          this.z,
          sample,
        );
        const limit = Math.max(0, halfWidth - this.configuration.vehicleHalfWidth);
        const depth = Math.abs(sample.lateral) - limit;
        if (Number.isFinite(depth) && depth > 0) {
          const side = Math.sign(sample.lateral);
          this.resolveWallContact({
            normalX: -side * sample.rightX,
            normalZ: -side * sample.rightZ,
            depth,
          }, steer);
          this.lateralOffsetValue = side * limit;
        }
      }
    }
    const height = this.groundHeightSampler?.(this.x, this.z, this.routeProgress, this.y);
    if (typeof height === "number" && Number.isFinite(height)) {
      this.y = height;
    } else if (this.routeSample && this.followRouteHeightValue) {
      this.y = this.routeSample.y;
    }
  }

  private resolveWallContact({ normalX, normalZ, depth }: TrackWallContact, steer: number): void {
    this.x += normalX * depth;
    this.z += normalZ * depth;

    const forwardX = Math.sin(this.yawValue);
    const forwardZ = Math.cos(this.yawValue);
    const normalForward = normalX * forwardX + normalZ * forwardZ;
    const normalRight = normalX * forwardZ - normalZ * forwardX;
    const closingSpeed = -(this.forwardSpeed * normalForward + this.lateralVelocity * normalRight);
    if (closingSpeed <= 0) return;

    if (closingSpeed > 2.5 && this.elapsedSeconds - this.lastImpact > 0.45) {
      this.collisionCount++;
      this.lastImpact = this.elapsedSeconds;
      this.pendingGauge *= this.configuration.driftGaugePreserveOnImpact;
    }
    // A resting contact removes only the inward speed. A real impact rebounds;
    // the component along the face is preserved in either case.
    const restitution = closingSpeed > 1 ? this.configuration.wallRestitution : 0;
    const impulse = closingSpeed * (1 + restitution);
    this.forwardSpeed += impulse * normalForward;
    this.lateralVelocity += impulse * normalRight;

    if (normalForward < 0) {
      // With the nose pinned the tires have little steering authority. Allow
      // steering to pick a side head-on; an oblique nose hit turns along the face.
      const pinningNose = normalForward < -0.45 && Math.hypot(this.forwardSpeed, this.lateralVelocity) < 3;
      if (steer !== 0 && pinningNose) {
        const direction = Math.sign(steer);
        const turnRate = Math.abs(steer) * (1.8 - 0.7 * normalForward);
        this.yawRate = direction * Math.max(this.yawRate * direction, turnRate);
        return;
      }
      const turn = Math.abs(normalRight) < 0.02 || (-normalForward > 0.8 && steer !== 0)
        ? steer
        : Math.sign(normalRight);
      const yawImpulse = Math.min(1, closingSpeed) * -normalForward;
      this.yawRate += turn * yawImpulse * 0.45;
    }
  }
}
