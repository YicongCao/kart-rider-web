/**
 * Deterministic fixed-step kart simulator.
 *
 * This module deliberately has no Three.js or DOM dependencies.
 *
 * World convention:
 *   forward = (sin(yaw), 0, cos(yaw))
 *   right   = (cos(yaw), 0, -sin(yaw))
 * Positive steer therefore increases yaw and turns toward the body's +right
 * vector. The project's route.json startYaw is atan2(forward.x, forward.z),
 * which is the same convention.
 */

import type { TrackWallContact } from "./track-collision";
import { KartSuspension, WHEEL_OFFSETS } from "./suspension";
import {
  computeOriginalSupportForces,
  ORIGINAL_REST_COMPRESSION,
  ORIGINAL_SUPPORT_HALF_LENGTH,
  ORIGINAL_SUPPORT_HALF_WIDTH,
  ORIGINAL_SUPPORT_PROBE_INSET,
  ORIGINAL_WHEEL_SIGNS,
  type WheelSupportSample,
} from "./contact-force";
import {
  computeOriginalLateralResponse,
  createOriginalDriftState,
  originalLateralMode,
  setOriginalDriftInput,
  stepOriginalDriftLinger,
  stepOriginalDriftTrigger,
  updateOriginalDriftSlip,
  type OriginalLateralMode,
} from "./lateral-physics";
import {
  bodyAxes,
  computeDrag,
  crossVec3,
  dotVec3,
  integrateAngularVelocity,
  integratePose,
  inverseInertiaDiagonal,
  ORIGINAL_WORLD_GRAVITY,
  quatFromYaw,
  rollFromOrientation,
  type Quat,
  type Vec3,
} from "./original-kinematics";

export const FIXED_STEP_SECONDS = 0.002;
const WORLD_UP: Vec3 = { x: 0, y: 1, z: 0 };

export type DriftPhase = "none" | "trigger" | "active" | "decay";
export type BoostKind = "none" | "start" | "drift" | "nitro";

export interface VehicleInput {
  /** 0..1. */
  throttle?: number;
  /** 0..1. Brakes while moving forward, reverses once stopped. */
  brake?: number;
  /** -1..1. Positive steer increases yaw (see module convention). */
  steer?: number;
  /** Held drift key. A press is latched at the fixed step where it begins. */
  drift?: boolean;
  /** Edge-triggered nitro request; consumes one N2O slot while accelerating. */
  boost?: boolean;
}

export interface VehicleState {
  x: number;
  y: number;
  z: number;
  suspension: {
    grounded: boolean;
    frontContact: number;
    rearContact: number;
    verticalSpeed: number;
    surfaceHeight: number | null;
    pitch: number;
    roll: number;
    heave: number;
    travel: number[];
  } | null;
  /** Radians. Wrapped to (-PI, PI]. */
  yaw: number;
  /** Signed forward speed in m/s (negative while reversing). */
  speed: number;
  /** Body-right lateral speed in m/s. */
  lateralSpeed: number;
  /** World-space planar speed magnitude in m/s. */
  planarSpeed: number;
  /** Physical chassis roll around its local forward axis, in radians. */
  roll: number;
  /** Body-local yaw rate in rad/s. */
  yawRate: number;
  /** Body-local roll rate in rad/s. */
  rollRate: number;
  /** Nitro gauge as 0..1, including uncommitted drift charge. */
  gauge: number;
  /** N2O items in the two race slots. */
  n2oCharges: number;
  boosting: boolean;
  boostKind: BoostKind;
  lastBoostKind: BoostKind;
  drifting: boolean;
  driftPhase: DriftPhase;
  boostCount: number;
  miniBoostCount: number;
  nitroCount: number;
  collisionCount: number;
  impactSpeed: number;
  /** Distance along the course in metres, when a route is attached. */
  progress: number;
  /** progress / route length, in 0..1. */
  lapProgress: number;
  /** Completed forward start-line crossings. */
  lap: number;
  /** Signed offset from the route centreline. Positive is route-right. */
  lateralOffset: number;
  boostRemaining: number;
  /** Seconds since the current exhaust effect ignited. Zero when inactive. */
  boostElapsed: number;
  /** Simulation time in seconds. */
  time: number;
}

/**
 * Rigid-body state used by trajectory oracles and native-side replay tools.
 * Its vertical state includes spring travel relative to the track ride height.
 */
export interface PhysicsSnapshot {
  position: Vec3;
  velocity: Vec3;
  angularVelocity: Vec3;
  orientation: Quat;
  forwardSpeed: number;
  lateralSpeed: number;
  yawRate: number;
  roll: number;
}

export interface VehicleTuning {
  mass: number;
  forwardAccel: number;
  backwardAccel: number;
  gripBrake: number;
  slipBrake: number;
  airFriction: number;
  dragFactor: number;
  boostAccelFactor: number;
  startBoostAccelFactor: number;
  steerConstraint: number;
  maxSteerDeg: number;
  /** Drift-phase planar moment of inertia divided by mass, in square metres. */
  yawInertiaPerMass: number;
  /** P3563 S7 front/rear tire force coefficients, in newtons per radian. */
  frontGripFactor: number;
  rearGripFactor: number;
  cornerDrawFactor: number;
  driftTrigTime: number;
  driftSlipFactor: number;
  driftTriggerFactor: number;
  /**
   * P3563 uses full lock (`rawSteer * MaxSteerAngle`) for trigger and active
   * drift tire forces; only ordinary grip reads the filtered `+0xAA4` angle.
   * "filtered" exists for replaying experiments that need the grip angle.
   */
  heldDriftSteer: "filtered" | "maximum";
  driftEscapeForce: number;
  driftLeanFactor: number;
  steerLeanFactor: number;
  driftStopSpeed: number;
  driftMaxGauge: number;
  n2oCapacity: number;
  /** Gauge gain calibrated in the Web simulator. */
  driftGaugeScale: number;
  boostDuration: number;
  miniBoostDuration: number;
  miniBoostWindow: number;
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
  // The live P3563 captures measured 2304 N, consistent with S7's 2150 N
  // plus the KartSpec constructor's 154 N. Cotton C1 has its own XML value.
  forwardAccel: 2304,
  backwardAccel: 1775,
  gripBrake: 2070,
  slipBrake: 1415,
  airFriction: 3,
  // S7 DragFactor 0.75 plus the KartSpec constructor -0.083, cross-checked
  // against the live trace's 3v + 0.667v^2 drag residual (0.022/0.026 N RMS).
  dragFactor: 0.667,
  boostAccelFactor: 1.5,
  startBoostAccelFactor: 1.5,
  // P3563's GetDefaultSpac adds SpeedType.SteerConstraint (22.25) to the
  // KartSpec constructor value (2.36), yielding 24.61.
  steerConstraint: 24.61,
  maxSteerDeg: 10,
  // P3563: InverseInertia = 12 / mass; the state stores mass / 12.
  yawInertiaPerMass: 1 / 12,
  // P3563 S7 FrontGripFactor/RearGripFactor. The native tire force uses
  // weight (mass * 9.8), not mass directly.
  frontGripFactor: 5,
  rearGripFactor: 5,
  // P3563 B53F80 +0x76C resolves to 0.18 (S7) + 0.074 (kart).
  cornerDrawFactor: 0.254,
  driftTrigTime: 0.2,
  driftSlipFactor: 0.2,
  driftTriggerFactor: 0.2,
  heldDriftSteer: "maximum",
  // The town first-bend capture measures the active automatic-slip thrust
  // directly at 4200 N. The Launcher composition is not independently
  // resolved, so this is the captured S7/cotton1 value rather than a global
  // constant for every kart or speed mode.
  driftEscapeForce: 4200,
  driftLeanFactor: 0.06,
  steerLeanFactor: 0.01,
  driftStopSpeed: 5,
  driftMaxGauge: 4300,
  // Time-attack speed slots hold at most two N2O items.
  n2oCapacity: 2,
  driftGaugeScale: 3.7,
  boostDuration: 3,
  // Cotton1's BodyParam omits driftBoostTick and driftBoostMulAccelFactor.
  // The regular boost factor applies. P3563 replays and practice runs show
  // a half-second burst. The window for reapplying throttle is independent.
  miniBoostDuration: 0.5,
  miniBoostWindow: 0.5,
  // Existing countdown/start calibration.
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
  /** Unit route-right vector in X/Z (the driver's right). */
  rightX: number;
  rightZ: number;
  /** Distance along the route in metres. */
  progress: number;
  /** Signed lateral offset from the centreline (positive = driver's right). */
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
  /** Initial N2O slot charges. */
  initialN2oCharges?: number;
  /** Simulation time of the race start, used for the +/-100 ms start boost. */
  startAtSeconds?: number | null;
  route?: RouteSampler | null;
  /** Road surface query, called once per 2 ms substep. */
  surfaceAt?: SurfaceSampler | null;
  /** Wheel and chassis ground probe. Enables suspension and airborne motion. */
  groundHeightAt?: ((
    x: number, z: number, progress: number, previousHeight: number, ceiling: number,
  ) => number | null) | null;
  /** Deepest overlapping track wall, sampled at the kart's footprint centre. */
  wallContactAt?: ((
    x: number, y: number, z: number, yaw: number, halfWidth: number, halfLength: number,
  ) => TrackWallContact | null) | null;
  /** Constant or callback half-width for courses without collision geometry. */
  roadHalfWidth?: number | RoadHalfWidthSampler | null;
  /** Follow route height when running without a ground probe. Default true. */
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
  private velocityX: number;
  private velocityZ: number;
  private supportDisplacement = 0;
  private supportSpeed = 0;
  private orientation: Quat;
  private angularVelocity: Vec3;
  private forwardSpeed: number;
  private lateralVelocity: number;
  private yawRate: number;
  private planarSpeedValue: number;
  private previousSteerAngle = 0;
  private supportCompressions = WHEEL_OFFSETS.map(
    () => ORIGINAL_REST_COMPRESSION,
  );
  private driftPhaseValue: DriftPhase;
  private driftState = createOriginalDriftState();
  private driftDirection: number;
  private driftGaugeElapsed: number;
  private driftStartSeconds: number;
  private committedGauge: number;
  private pendingGauge: number;
  private n2oChargesValue: number;
  private boostRemainingValue: number;
  private boostStartedAt = 0;
  private boostKind: BoostKind = "none";
  private lastBoostKind: BoostKind = "none";
  private miniBoostWindowUntil = -Infinity;
  private boostActivations: number;
  private miniBoostCount = 0;
  private nitroCount = 0;
  private collisionCount = 0;
  private impactSpeed = 0;
  private lastImpact = -Infinity;
  private startBoostConsumed: boolean;
  private startAtSecondsValue: number | null;
  private previousThrottleDown: boolean;
  private previousDriftHeld: boolean;
  private previousBoostDown: boolean;
  private accumulatorSeconds: number;
  private elapsedSeconds: number;
  private routeValue: RouteSampler | null;
  private surfaceSampler: SurfaceSampler | null;
  private readonly probeGround: ((x: number, z: number, height: number, ceiling: number) => number | null) | null;
  private readonly suspension: KartSuspension | null;
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
    this.orientation = quatFromYaw(this.yawValue);
    this.angularVelocity = { x: 0, y: 0, z: 0 };
    const initialSpeed = finiteOr(options.speed, 0);
    this.velocityX = Math.sin(this.yawValue) * initialSpeed;
    this.velocityZ = Math.cos(this.yawValue) * initialSpeed;
    this.forwardSpeed = initialSpeed;
    this.lateralVelocity = 0;
    this.planarSpeedValue = Math.abs(initialSpeed);
    this.yawRate = 0;
    this.driftPhaseValue = "none";
    this.driftDirection = 0;
    this.driftGaugeElapsed = 0;
    this.driftStartSeconds = -Infinity;
    this.committedGauge = clamp(
      finiteOr(options.initialGauge, 0),
      0,
      1,
    ) * this.configuration.driftMaxGauge;
    this.pendingGauge = 0;
    this.n2oChargesValue = clamp(
      Math.floor(finiteOr(options.initialN2oCharges, 0)),
      0,
      this.configuration.n2oCapacity,
    );
    this.boostRemainingValue = 0;
    this.boostActivations = 0;
    this.startBoostConsumed = false;
    this.startAtSecondsValue =
      typeof options.startAtSeconds === "number" &&
      Number.isFinite(options.startAtSeconds)
        ? options.startAtSeconds
        : null;
    this.previousThrottleDown = false;
    this.previousDriftHeld = false;
    this.previousBoostDown = false;
    this.accumulatorSeconds = 0;
    this.elapsedSeconds = 0;
    this.routeValue = options.route ?? null;
    this.surfaceSampler = options.surfaceAt ?? null;
    const groundHeightAt = options.groundHeightAt;
    this.probeGround = groundHeightAt
      ? (x, z, height, ceiling) => groundHeightAt(x, z, this.routeProgress, height, ceiling)
      : null;
    this.suspension = this.probeGround ? new KartSuspension() : null;
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
    this.resetSuspension();
  }

  get tuning(): Readonly<VehicleTuning> {
    return this.configuration;
  }

  get physicsSnapshot(): PhysicsSnapshot {
    return {
      position: { x: this.x, y: this.y + this.supportDisplacement, z: this.z },
      velocity: { x: this.velocityX, y: this.verticalSpeed, z: this.velocityZ },
      angularVelocity: { ...this.angularVelocity },
      orientation: { ...this.orientation },
      forwardSpeed: this.forwardSpeed,
      lateralSpeed: this.lateralVelocity,
      yawRate: this.yawRate,
      roll: rollFromOrientation(this.orientation),
    };
  }

  /**
   * Restore a rigid-body state captured from the native simulator or from a
   * trajectory fixture. Drift flags and race timers are intentionally reset;
   * replay callers supply the same inputs from that point forward.
   */
  restorePhysicsSnapshot(
    snapshot: PhysicsSnapshot,
    options: { previousSteerAngleRad?: number } = {},
  ): void {
    this.x = snapshot.position.x;
    this.y = snapshot.position.y;
    this.z = snapshot.position.z;
    this.velocityX = snapshot.velocity.x;
    this.velocityZ = snapshot.velocity.z;
    this.orientation = { ...snapshot.orientation };
    this.angularVelocity = { ...snapshot.angularVelocity };
    this.previousSteerAngle = finiteOr(options.previousSteerAngleRad, 0);
    this.driftState = createOriginalDriftState();
    this.driftPhaseValue = "none";
    this.driftDirection = 0;
    this.accumulatorSeconds = 0;
    this.resetSuspension();
    this.supportSpeed = snapshot.velocity.y;
    this.syncBodyVelocity();
  }

  private get verticalSpeed() {
    return (this.suspension?.verticalSpeed ?? 0) + this.supportSpeed;
  }

  get state(): VehicleState {
    const gaugeTotal = this.committedGauge + this.pendingGauge;
    const suspension = this.suspension;
    return {
      x: this.x,
      y: this.suspension ? this.y : this.y + this.supportDisplacement,
      z: this.z,
      suspension: suspension && {
        grounded: suspension.grounded,
        frontContact: suspension.frontContact,
        rearContact: suspension.rearContact,
        verticalSpeed: suspension.verticalSpeed,
        surfaceHeight: suspension.surfaceHeight,
        pitch: suspension.pitch.value,
        roll: suspension.roll.value,
        heave: suspension.heave.value,
        travel: suspension.travel(),
      },
      yaw: this.yawValue,
      speed: this.forwardSpeed,
      lateralSpeed: this.lateralVelocity,
      planarSpeed: this.planarSpeedValue,
      roll: rollFromOrientation(this.orientation),
      yawRate: this.yawRate,
      rollRate: this.angularVelocity.z,
      gauge: clamp(gaugeTotal / this.configuration.driftMaxGauge, 0, 1),
      n2oCharges: this.n2oChargesValue,
      boosting: this.boostRemainingValue > 0,
      boostKind: this.boostKind,
      lastBoostKind: this.lastBoostKind,
      drifting: this.driftPhaseValue !== "none",
      driftPhase: this.driftPhaseValue,
      boostCount: this.boostActivations,
      miniBoostCount: this.miniBoostCount,
      nitroCount: this.nitroCount,
      collisionCount: this.collisionCount,
      impactSpeed: this.impactSpeed,
      progress: this.routeProgress,
      lapProgress: this.lapProgressValue,
      lap: this.lapValue,
      lateralOffset: this.lateralOffsetValue,
      boostRemaining: this.boostRemainingValue,
      boostElapsed: this.boostKind === "none" ? 0 : this.elapsedSeconds - this.boostStartedAt,
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
    this.miniBoostWindowUntil = -Infinity;
    if (this.boostKind === "drift") this.endBoost();
    this.x = x;
    this.y = y;
    this.z = z;
    this.yawValue = wrapAngle(yaw);
    this.orientation = quatFromYaw(this.yawValue);
    this.angularVelocity = { x: 0, y: 0, z: 0 };
    const resetSpeed = finiteOr(speed, 0);
    this.velocityX = Math.sin(this.yawValue) * resetSpeed;
    this.velocityZ = Math.cos(this.yawValue) * resetSpeed;
    this.forwardSpeed = resetSpeed;
    this.lateralVelocity = 0;
    this.planarSpeedValue = Math.abs(resetSpeed);
    this.yawRate = 0;
    this.previousSteerAngle = 0;
    this.previousDriftHeld = false;
    this.accumulatorSeconds = 0;
    this.routeSample = null;
    this.previousRouteProgress = this.routeProgress;
    this.lateralOffsetValue = 0;
    this.resetSuspension();
  }

  private resetSuspension() {
    this.supportDisplacement = 0;
    this.supportSpeed = 0;
    this.supportCompressions = WHEEL_OFFSETS.map(
      () => ORIGINAL_REST_COMPRESSION,
    );
    this.suspension?.reset(this.probeGround?.(this.x, this.z, this.y, this.y + 0.08) ?? null);
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
    this.syncBodyVelocity();
    const throttle = clamp(finiteOr(input.throttle, 0), 0, 1);
    const brake = clamp(finiteOr(input.brake, 0), 0, 1);
    const steerTarget = clamp(finiteOr(input.steer, 0), -1, 1);
    const driftHeld = input.drift === true;
    const boostHeld = input.boost === true;
    const throttleDown = throttle > 0.01;
    const throttleEdge = throttleDown && !this.previousThrottleDown;
    const boostEdge = boostHeld && !this.previousBoostDown;
    const grounded = this.suspension?.grounded ?? true;
    const frontContact = this.suspension?.frontContact ?? 1;
    const rearContact = this.suspension?.rearContact ?? 1;
    const tireContact = (frontContact + rearContact) / 2;

    const surface =
      this.surfaceSampler?.(this.x, this.z, this.routeProgress) ?? {};
    const gripMultiplier = grounded ? Math.max(0, finiteOr(surface.grip, 1)) : 0;
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

    this.updateGaugeInventory();

    if (boostCharge > 0) {
      this.committedGauge = Math.min(
        this.configuration.driftMaxGauge,
        this.committedGauge +
          boostCharge * this.configuration.driftMaxGauge * partialStep,
      );
      this.updateGaugeInventory();
    }

    if (!throttleDown && this.boostKind === "drift") this.endBoost();
    if (Math.hypot(this.forwardSpeed, this.lateralVelocity) <
        this.configuration.driftStopSpeed) {
      this.miniBoostWindowUntil = -Infinity;
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
      this.beginBoost("start", this.configuration.startBoostDuration);
    }

    if (
      boostEdge &&
      throttleDown &&
      (this.boostKind === "none" || this.boostKind === "drift") &&
      this.n2oChargesValue > 0
    ) {
      this.n2oChargesValue--;
      this.nitroCount++;
      this.beginBoost("nitro", this.configuration.boostDuration);
    } else if (throttleEdge && this.boostKind === "none" &&
               this.elapsedSeconds < this.miniBoostWindowUntil) {
      this.miniBoostWindowUntil = -Infinity;
      this.miniBoostCount++;
      this.beginBoost("drift", this.configuration.miniBoostDuration);
    }

    const boostActive = this.boostRemainingValue > 0;
    const boostMultiplier = boostActive
      ? this.boostKind === "start"
        ? this.configuration.startBoostAccelFactor
        : this.configuration.boostAccelFactor
      : 1;

    const spec = this.configuration;
    let speed = this.planarSpeedValue;
    const previousPhase = this.driftPhaseValue;
    // B53610 selects traction before B53F80 updates slip for the tires.
    const previousSlip = this.driftState.slipDetected;
    const driftPressEdge = driftHeld && !this.previousDriftHeld;
    const driftReleaseEdge = !driftHeld && this.previousDriftHeld;

    if (driftReleaseEdge) {
      setOriginalDriftInput(this.driftState, false, this.forwardSpeed);
    }
    if (grounded) {
      if (driftPressEdge) {
        setOriginalDriftInput(this.driftState, true, this.forwardSpeed);
        if (this.driftState.triggerActive) {
          this.driftDirection = Math.sign(steerTarget) || (this.forwardSpeed >= 0 ? 1 : -1);
          this.driftStartSeconds = this.elapsedSeconds;
          this.driftGaugeElapsed = 0;
        }
      }
      updateOriginalDriftSlip(
        this.driftState,
        speed,
        this.forwardSpeed,
        this.lateralVelocity,
      );
    }

    const lateralMode: OriginalLateralMode = grounded
      ? originalLateralMode(this.driftState)
      : "grip";
    this.driftPhaseValue =
      lateralMode === "trigger"
        ? "trigger"
        : lateralMode === "drift"
          ? "active"
          : "none";
    if (this.driftPhaseValue !== "none" && this.driftStartSeconds === -Infinity) {
      this.driftStartSeconds = this.elapsedSeconds;
      this.driftGaugeElapsed = 0;
    }

    const lateral = computeOriginalLateralResponse(
      {
        mass: spec.mass,
        maxSteerDegrees: spec.maxSteerDeg,
        steerConstraint: spec.steerConstraint,
        frontGripFactor: spec.frontGripFactor,
        rearGripFactor: spec.rearGripFactor,
        driftTriggerFactor: spec.driftTriggerFactor,
        driftSlipFactor: spec.driftSlipFactor,
        cornerDrawFactor: spec.cornerDrawFactor,
        driftLeanFactor: spec.driftLeanFactor,
        steerLeanFactor: spec.steerLeanFactor,
        heldDriftSteer: spec.heldDriftSteer,
      },
      {
        forwardVelocity: this.forwardSpeed,
        lateralVelocity: this.lateralVelocity,
        yawRate: this.yawRate,
        steeringInput: steerTarget,
        forwardInput: throttle,
        previousSteerAngleRad: this.previousSteerAngle,
        driftInputActive: this.driftState.inputActive,
        mode: lateralMode,
      },
    );
    this.previousSteerAngle = lateral.nextPreviousSteerAngleRad;

    const contactGrip = grounded ? gripMultiplier : 0;
    const frontForce = lateral.frontForce * frontContact * contactGrip;
    const rearForce = lateral.rearForce * rearContact * contactGrip;
    let lateralForce = frontForce + rearForce;

    // Original longitudinal force replacement: only automatic slip uses the
    // drift-escape force. A manual held drift keeps ForwardAccelForce.
    const driveForce = previousSlip
      ? spec.driftEscapeForce
      : spec.forwardAccel;
    const driveContact = boostActive ? 1 : rearContact;
    const tractionForce =
      driveForce * throttle * boostMultiplier * accelerationMultiplier *
      driveContact;
    let bodyForwardForce = 0;
    // P3563 B53610 restores forward travel once the kart has rotated past
    // zero while the accelerator is held. The restoring force is weight times
    // speed; outside a drift the native path caps the speed term at 5 m/s.
    if (throttleDown && this.forwardSpeed < 0) {
      const recoverySpeed =
        this.driftState.inputActive || this.driftState.slipDetected
          ? speed
          : Math.min(speed, this.configuration.driftStopSpeed);
      bodyForwardForce += recoverySpeed * spec.mass * 9.8;
    }
    let brakeForceX = 0;
    let brakeForceZ = 0;
    if (grounded && brake > 0) {
      if (speed > 0.5) {
        const alignment = this.forwardSpeed / Math.max(speed, 1e-6);
        const brakeForce = alignment <= 0.8
          ? spec.slipBrake
          : spec.gripBrake;
        brakeForceX = -this.velocityX / speed * brakeForce * brake;
        brakeForceZ = -this.velocityZ / speed * brakeForce * brake;
      } else {
        bodyForwardForce -= spec.backwardAccel * brake * tireContact;
      }
    }
    if (lateralMode === "grip") {
      bodyForwardForce += lateral.cornerDrawForwardForce * contactGrip *
        accelerationMultiplier;
    }

    const axes = bodyAxes(this.orientation);
    const normal = this.suspension?.groundNormal(this.yawValue) ?? WORLD_UP;
    const support = this.computeSupport(axes, normal);
    // Ordinary traction follows the road tangent recovered at B53610.
    const traction = crossVec3(axes.right, normal);
    const linearForce = {
      x:
        axes.right.x * lateralForce +
        traction.x * tractionForce +
        axes.forward.x * bodyForwardForce +
        support.force.x +
        brakeForceX,
      y:
        axes.right.y * lateralForce +
        traction.y * tractionForce +
        axes.forward.y * bodyForwardForce +
        support.force.y +
        ORIGINAL_WORLD_GRAVITY * spec.mass,
      z:
        axes.right.z * lateralForce +
        traction.z * tractionForce +
        axes.forward.z * bodyForwardForce +
        support.force.z +
        brakeForceZ,
    };
    const linearVelocity = {
      x: this.velocityX,
      y: this.verticalSpeed,
      z: this.velocityZ,
    };
    const drag = computeDrag(
      linearVelocity,
      this.angularVelocity,
      spec.airFriction,
      spec.dragFactor * dragMultiplier,
      grounded,
      1,
    );
    this.velocityX +=
      (linearForce.x + drag.force.x) / spec.mass * partialStep;
    // On tracks the ride height follows the selected deck and carries the
    // flight trajectory. While grounded the spring integrates chassis travel
    // relative to that height, which can move independently on a grade.
    if (grounded) {
      this.supportSpeed +=
        (linearForce.y + drag.force.y) / spec.mass * partialStep;
    }
    this.velocityZ +=
      (linearForce.z + drag.force.z) / spec.mass * partialStep;

    // Body-local torque: local +Y is up (yaw) and local +Z is forward (roll).
    // The native roll torque is stored about its local backwards axis, hence
    // the sign change when mapping it onto the Web body frame.
    const torque = {
      x: support.torque.x + drag.torque.x,
      y:
        0.5 * frontForce - 0.5 * rearForce +
        drag.torque.y,
      z:
        -lateral.rollTorque * contactGrip +
        support.torque.z +
        drag.torque.z,
    };
    const inverseInertia = inverseInertiaDiagonal(spec.mass);
    this.angularVelocity = integrateAngularVelocity(
      this.angularVelocity,
      torque,
      inverseInertia,
      partialStep,
    );
    const pose = integratePose(
      { x: this.x, y: this.supportDisplacement, z: this.z },
      this.orientation,
      { x: this.velocityX, y: this.supportSpeed, z: this.velocityZ },
      this.angularVelocity,
      partialStep,
    );
    this.x = pose.position.x;
    this.supportDisplacement = pose.position.y;
    if (grounded) {
      const minimum = -ORIGINAL_REST_COMPRESSION * 2;
      const maximum = ORIGINAL_REST_COMPRESSION;
      if (this.supportDisplacement <= minimum) {
        this.supportDisplacement = minimum;
        this.supportSpeed = Math.max(0, this.supportSpeed);
      } else if (this.supportDisplacement >= maximum) {
        this.supportDisplacement = maximum;
        this.supportSpeed = Math.min(0, this.supportSpeed);
      }
    }
    this.z = pose.position.z;
    this.orientation = pose.orientation;
    this.angularVelocity = pose.angularVelocity;
    this.syncBodyVelocity();

    if (lateralMode === "trigger") {
      stepOriginalDriftTrigger(
        this.driftState,
        spec.driftTrigTime,
        partialStep,
      );
    } else if (lateralMode === "drift") {
      stepOriginalDriftLinger(this.driftState, partialStep);
    }

    if (
      previousPhase !== "none" &&
      this.driftPhaseValue === "none" &&
      grounded
    ) {
      this.completeDrift();
    }

    speed = this.planarSpeedValue;
    if (grounded && speed < 0.15 && throttle === 0 && brake === 0) {
      this.velocityX = 0;
      this.velocityZ = 0;
      this.forwardSpeed = 0;
      this.lateralVelocity = 0;
      this.planarSpeedValue = 0;
      this.angularVelocity = { x: 0, y: 0, z: 0 };
      this.yawRate = 0;
    }

    if (grounded && this.driftPhaseValue !== "none") {
      this.fillDriftGauge(
        driftGaugeMultiplier * tireContact,
        partialStep,
      );
      this.updateGaugeInventory();
    }

    this.updateRoute(steerTarget);
    // KartSuspension supplies the ballistic height and speed during flight.
    if (this.suspension && !this.suspension.grounded) {
      this.supportDisplacement = 0;
      this.supportSpeed = 0;
    }
    this.syncBodyVelocity();

    if (this.boostRemainingValue > 0) {
      this.boostRemainingValue = Math.max(
        0,
        this.boostRemainingValue - partialStep,
      );
      if (this.boostRemainingValue === 0) {
        this.endBoost();
      }
    }

    this.elapsedSeconds += partialStep;
    this.previousThrottleDown = throttleDown;
    this.previousDriftHeld = driftHeld;
    this.previousBoostDown = boostHeld;
  }

  /**
   * Sample the four P3563 suspension supports. The spring force is applied
   * along the chassis up axis, not straight up; on a rolled chassis that
   * horizontal component is part of the original cornering response.
   */
  private computeSupport(axes: ReturnType<typeof bodyAxes>, normal: Vec3) {
    const samples: WheelSupportSample[] = [];
    const normalProjection = dotVec3(axes.up, normal);
    const bodyY = this.y + this.supportDisplacement;
    for (const [side, end] of ORIGINAL_WHEEL_SIGNS) {
      const right = side * ORIGINAL_SUPPORT_HALF_WIDTH * ORIGINAL_SUPPORT_PROBE_INSET;
      const forward = end * ORIGINAL_SUPPORT_HALF_LENGTH * ORIGINAL_SUPPORT_PROBE_INSET;
      const wheelX = this.x + axes.right.x * right + axes.forward.x * forward;
      const wheelZ = this.z + axes.right.z * right + axes.forward.z * forward;
      const wheelY = bodyY + axes.right.y * right + axes.forward.y * forward;
      // The ray must reach from full droop to the bump stop. Using only the
      // rest compression here makes the road disappear as soon as the chassis
      // sags past 0.5 m, which then removes all support force.
      const ceiling = wheelY +
        ORIGINAL_REST_COMPRESSION * 2 * Math.max(0, axes.up.y);
      const groundY = this.probeGround
        ? this.probeGround(wheelX, wheelZ, wheelY, ceiling)
        : this.y;
      // Intersect the contact plane with the finite ray along body up. The
      // track height query chooses the deck and supplies a point on that plane.
      const distance = groundY === null || normalProjection <= 0
        ? -Infinity
        : (groundY - wheelY) * normal.y / normalProjection;
      // A wheel below the road is compressed, not inactive. Clamping at the
      // bump stop keeps a hard landing or a steep downhill from dropping the
      // support ray below the deck, where it can no longer see the road and
      // the chassis free-falls through the track.
      const active = distance >= -ORIGINAL_REST_COMPRESSION;
      const compression = active
        ? Math.max(
          0,
          Math.min(
            ORIGINAL_REST_COMPRESSION * 2,
            ORIGINAL_REST_COMPRESSION + distance,
          ),
        )
        : 0;
      samples.push({ active, compression, normal });
    }
    const support = computeOriginalSupportForces(
      axes,
      samples,
      this.supportCompressions,
      FIXED_STEP_SECONDS,
    );
    this.supportCompressions = samples.map(sample => sample.compression);
    return support;
  }

  /**
   * Re-project the world velocity onto the physical body axes. The caches are
   * what the tire model, telemetry, and remaining gameplay systems consume.
   */
  private syncBodyVelocity(): void {
    const axes = bodyAxes(this.orientation);
    const verticalSpeed = this.verticalSpeed;
    this.forwardSpeed =
      this.velocityX * axes.forward.x + verticalSpeed * axes.forward.y + this.velocityZ * axes.forward.z;
    this.lateralVelocity =
      this.velocityX * axes.right.x + verticalSpeed * axes.right.y + this.velocityZ * axes.right.z;
    this.planarSpeedValue = Math.hypot(this.velocityX, this.velocityZ);
    this.yawValue = Math.atan2(axes.forward.x, axes.forward.z);
    this.yawRate = this.angularVelocity.y;
  }

  private beginBoost(kind: Exclude<BoostKind, "none">, duration: number): void {
    this.lastBoostKind = kind;
    this.boostStartedAt = this.elapsedSeconds;
    this.boostRemainingValue = Math.max(0, duration);
    this.boostKind = this.boostRemainingValue > 0 ? kind : "none";
    this.boostActivations++;
  }

  private endBoost(): void {
    this.boostKind = "none";
    this.boostRemainingValue = 0;
  }

  private completeDrift(): void {
    if (this.driftState.entryWasForward) {
      this.miniBoostWindowUntil =
        this.elapsedSeconds + this.configuration.miniBoostWindow;
    }
    this.finishDrift();
  }

  private finishDrift(): void {
    this.driftPhaseValue = "none";
    this.driftDirection = 0;
    this.driftState = createOriginalDriftState();
    this.driftGaugeElapsed = 0;
    this.driftStartSeconds = -Infinity;
    this.committedGauge = Math.min(
      this.configuration.driftMaxGauge,
      this.committedGauge + this.pendingGauge,
    );
    this.pendingGauge = 0;
    this.updateGaugeInventory();
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

  private updateGaugeInventory(): void {
    if (
      this.n2oChargesValue >= this.configuration.n2oCapacity ||
      this.committedGauge + this.pendingGauge <
        this.configuration.driftMaxGauge
    ) {
      return;
    }
    this.n2oChargesValue++;
    this.committedGauge = 0;
    this.pendingGauge = 0;
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
    if (this.suspension && this.probeGround) {
      this.y = this.suspension.step(this.x, this.y, this.z, this.yawValue,
        this.forwardSpeed, this.lateralVelocity, this.probeGround, FIXED_STEP_SECONDS);
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
    const closingSpeed = -(
      this.velocityX * normalX +
      this.velocityZ * normalZ
    );
    if (closingSpeed <= 0) return;

    if (closingSpeed > 2.5 && this.elapsedSeconds - this.lastImpact > 0.45) {
      this.collisionCount++;
      this.impactSpeed = closingSpeed;
      this.lastImpact = this.elapsedSeconds;
      this.pendingGauge *= this.configuration.driftGaugePreserveOnImpact;
    }
    // A resting contact removes only the inward speed. A real impact rebounds;
    // the component along the face is preserved in either case.
    const restitution = closingSpeed > 1 ? this.configuration.wallRestitution : 0;
    const impulse = closingSpeed * (1 + restitution);
    this.velocityX += impulse * normalX;
    this.velocityZ += impulse * normalZ;
    this.syncBodyVelocity();

    if (normalForward < 0) {
      // With the nose pinned the tires have little steering authority. Allow
      // steering to pick a side head-on; an oblique nose hit turns along the face.
      const pinningNose = normalForward < -0.45 && this.planarSpeedValue < 3;
      if (steer !== 0 && pinningNose) {
        const direction = Math.sign(steer);
        const turnRate = Math.abs(steer) * (1.8 - 0.7 * normalForward);
        this.yawRate = direction * Math.max(this.yawRate * direction, turnRate);
        this.angularVelocity.y = this.yawRate;
        return;
      }
      const turn = Math.abs(normalRight) < 0.02 || (-normalForward > 0.8 && steer !== 0)
        ? steer
        : Math.sign(normalRight);
      const yawImpulse = Math.min(1, closingSpeed) * -normalForward;
      this.yawRate += turn * yawImpulse * 0.45;
      this.angularVelocity.y = this.yawRate;
    }
  }
}
