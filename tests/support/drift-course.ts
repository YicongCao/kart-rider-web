import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MeshBasicMaterial } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  analyzeCornerDrift,
  cornerContains,
  extractCorners,
  findDriftEpisodes,
  type CornerDriftResult,
  type DriftEpisode,
  type DriftTelemetrySample,
  type TrackCorner,
} from "../../src/game/drift-analysis";
import { Route } from "../../src/game/route";
import { KartSuspension } from "../../src/game/suspension";
import { TrackCollision } from "../../src/game/track-collision";
import { trackSurface } from "../../src/game/track-surface";
import {
  DEFAULT_TUNING,
  FIXED_STEP_SECONDS,
  KartVehicle,
  type VehicleInput,
  type VehicleState,
} from "../../src/game/vehicle";
import {
  ORIGINAL_TIRE_GRAVITY,
  computeOriginalLateralResponse,
} from "../../src/game/lateral-physics";
import type { RouteData } from "../../src/types";

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

/** Length below which an extracted section is treated as a route artefact. */
export const MIN_DRIFT_CORNER_LENGTH = 20;

export const DRIFT_ACCEPTANCE = {
  minCoverage: 0.8,
  maxCoverageGap: 0.25,
  minDriftSeconds: 0.9,
  maxCornerEndHeadingErrorDeg: 45,
  maxFinalHeadingErrorDeg: 30,
  minMedianSideSlipDeg: 20,
  maxMedianSideSlipDeg: 70,
  minSpeedRetention: 0.75,
  maxSpeedRetention: 1.2,
  /**
   * The grounded chassis may compress one rest travel below the ride height.
   * A larger sag means the support sample lost the road, not a hard corner.
   */
  maxGroundedChassisSink: 1.05,
} as const;

export interface TrackAssets {
  track: string;
  route: Route;
  collision: TrackCollision;
}

export interface DriftSample {
  s: number;
  lateral: number;
  yaw: number;
  /** Signed left edge of the collision-free centreline corridor. */
  corridorLeft?: number;
  /** Signed right edge of the collision-free centreline corridor. */
  corridorRight?: number;
  corridorAt?: (s: number) => { left: number; right: number };
  velocityHeading?: number;
}

export interface DriftDriverContext {
  state: VehicleState;
  sample: DriftSample;
  corner: TrackCorner;
  time: number;
}

export type DriftDriver = (context: DriftDriverContext) => VehicleInput;

export interface DriftDriverFactoryContext {
  track: string;
  corner: TrackCorner;
  route: Route;
  routeLength: number;
}

export type DriftDriverFactory = (context: DriftDriverFactoryContext) => DriftDriver;

export interface CornerDriftOptions {
  /** Distance before the corner body at which the kart starts, in metres. */
  approach?: number;
  /** Starting lateral offset outside the corner, in metres. */
  startOutside?: number;
  /** Initial forward speed, in metres per second. */
  initialSpeed?: number;
  /** Per-corner initial speed override used by track-level acceptance runs. */
  initialSpeedForCorner?: (corner: TrackCorner, route: Route) => number;
  /** Fixed simulation step, in seconds. */
  step?: number;
  /** Wall-clock simulation limit for a single corner. */
  maxDuration?: number;
  /** Continue measuring for this distance after the corner body. */
  finishBuffer?: number;
  /** Temporary physics overrides for calibration probes. */
  tuning?: Partial<import("../../src/game/vehicle").VehicleTuning>;
  /** Upper bound for the default corner entry/target speed, in m/s. */
  speedCap?: number;
  /**
   * Directory containing `tracks/<track>/route.json` and `track.gltf`.
   * Defaults to `public/assets`. Standalone builds can point the same
   * renderer-independent harness at their own asset root.
   */
  assetsRoot?: string | URL;
}

export interface CornerDriftRun {
  track: string;
  corner: TrackCorner;
  approach: number;
  startS: number;
  finishS: number;
  initialSpeed: number;
  duration: number;
  samples: (DriftTelemetrySample & { x: number; z: number })[];
  analysis: CornerDriftResult;
  collisions: number;
  majorCollisions: number;
  collisionDetail: string;
  offroad: boolean;
  offroadDetail: string;
  reversed: boolean;
  reverseDetail: string;
  timedOut: boolean;
  reachedExit: boolean;
  /** Velocity-heading error at the geometric corner exit. */
  exitHeadingErrorDeg: number | null;
  /**
   * Velocity-heading error where the kart crosses the corner body's end.
   * Body yaw is expected to carry the drift slip angle at that instant.
   */
  cornerEndHeadingErrorDeg: number | null;
  /** Body-yaw error at the corner end, reported for drift posture. */
  cornerEndBodyHeadingErrorDeg: number | null;
  finalHeadingErrorDeg: number;
  maxLateral: number;
  /** Diagnostic only: rigid-body height relative to the supported ride height. */
  minGroundedChassisOffset: { meters: number; s: number; time: number } | null;
  cornerEntrySpeed: number | null;
  cornerExitSpeed: number | null;
  cornerSpeedRetention: number | null;
  driftSpeedRetention: number | null;
  driftSamplesInCorner: number;
  medianSideSlipDeg: number | null;
  longestDriftSeconds: number;
  longestDrift: DriftEpisode | null;
  coverage: number;
  maxCoverageGap: number;
  driftInputStartS: number | null;
  driftInputStartTime: number | null;
  driftInputLeadMeters: number | null;
  driftInputStartedBeforeCorner: boolean;
  driftInputActiveAtCornerStart: boolean | null;
  failures: string[];
}

export interface FilteredCorner {
  start: number;
  end: number;
  length: number;
  headingDegrees: number;
}

export interface TrackDriftSummary {
  corners: number;
  passed: number;
  failed: number;
  failureReasons: Record<string, number>;
  averageCoverage: number;
  maxCoverageGap: number;
  averageLongestDriftSeconds: number;
  medianMedianSideSlipDeg: number;
}

export interface TrackDriftRun {
  track: string;
  routeLength: number;
  corners: TrackCorner[];
  filteredShortCorners: FilteredCorner[];
  runs: CornerDriftRun[];
  summary: TrackDriftSummary;
}

/**
 * Hard acceptance checks shared by the formal test and native/standalone
 * probes. Keeping this in the support module avoids a probe passing because
 * it only checked collisions while the formal test also checked slip,
 * coverage and retention.
 */
export function driftAcceptanceReasons(run: CornerDriftRun) {
  const reasons = [...run.failures];
  const analysis = run.analysis.failures;
  for (const failure of analysis) {
    if (!reasons.includes(failure)) reasons.push(failure);
  }

  if (run.coverage < DRIFT_ACCEPTANCE.minCoverage) {
    reasons.push(
      `coverage ${run.coverage.toFixed(2)} < ${DRIFT_ACCEPTANCE.minCoverage}`,
    );
  }
  if (run.maxCoverageGap > DRIFT_ACCEPTANCE.maxCoverageGap) {
    reasons.push(
      `max coverage gap ${run.maxCoverageGap.toFixed(2)}s > ` +
      `${DRIFT_ACCEPTANCE.maxCoverageGap}s`,
    );
  }
  if (run.longestDriftSeconds < DRIFT_ACCEPTANCE.minDriftSeconds) {
    reasons.push(
      `longest drift ${run.longestDriftSeconds.toFixed(2)}s < ` +
      `${DRIFT_ACCEPTANCE.minDriftSeconds}s`,
    );
  }
  if (run.cornerEndHeadingErrorDeg === null) {
    reasons.push("no corner-end heading measurement");
  } else if (
    run.cornerEndHeadingErrorDeg >
      DRIFT_ACCEPTANCE.maxCornerEndHeadingErrorDeg
  ) {
    reasons.push(
      `corner-end heading error ${run.cornerEndHeadingErrorDeg.toFixed(1)}deg > ` +
      `${DRIFT_ACCEPTANCE.maxCornerEndHeadingErrorDeg}deg`,
    );
  }
  if (run.finalHeadingErrorDeg > DRIFT_ACCEPTANCE.maxFinalHeadingErrorDeg) {
    reasons.push(
      `final heading error ${run.finalHeadingErrorDeg.toFixed(1)}deg > ` +
      `${DRIFT_ACCEPTANCE.maxFinalHeadingErrorDeg}deg`,
    );
  }
  if (run.medianSideSlipDeg === null) {
    reasons.push("no drifting side-slip samples in corner");
  } else if (
    run.medianSideSlipDeg < DRIFT_ACCEPTANCE.minMedianSideSlipDeg ||
    run.medianSideSlipDeg > DRIFT_ACCEPTANCE.maxMedianSideSlipDeg
  ) {
    reasons.push(
      `median side slip ${run.medianSideSlipDeg.toFixed(1)}deg outside ` +
      `${DRIFT_ACCEPTANCE.minMedianSideSlipDeg}..` +
      `${DRIFT_ACCEPTANCE.maxMedianSideSlipDeg}deg`,
    );
  }
  if (run.driftSpeedRetention === null) {
    reasons.push("no drift speed retention measurement");
  } else if (
    run.driftSpeedRetention < DRIFT_ACCEPTANCE.minSpeedRetention ||
    run.driftSpeedRetention > DRIFT_ACCEPTANCE.maxSpeedRetention
  ) {
    reasons.push(
      `speed retention ${run.driftSpeedRetention.toFixed(2)} outside ` +
      `${DRIFT_ACCEPTANCE.minSpeedRetention}..` +
      `${DRIFT_ACCEPTANCE.maxSpeedRetention}`,
    );
  }
  if (run.driftInputStartS === null) {
    reasons.push("drift input never started");
  } else if (!run.driftInputStartedBeforeCorner) {
    reasons.push(
      `drift input started ${Math.abs(run.driftInputLeadMeters ?? 0).toFixed(1)}m ` +
      "after the corner body",
    );
  }
  if (run.driftInputActiveAtCornerStart === false) {
    reasons.push("drift input was not active entering the corner body");
  }
  if (
    run.minGroundedChassisOffset !== null &&
    run.minGroundedChassisOffset.meters < -DRIFT_ACCEPTANCE.maxGroundedChassisSink
  ) {
    reasons.push(
      `grounded chassis sank ${Math.abs(run.minGroundedChassisOffset.meters).toFixed(2)}m ` +
      `> ${DRIFT_ACCEPTANCE.maxGroundedChassisSink}m`,
    );
  }

  return [...new Set(reasons)];
}

export interface AcceptanceDriftDriverOptions {
  /** Route geometry used for lookahead and cross-track correction. */
  route?: Route;
  /** Absolute route length, so the driver can resolve s=0 crossings. */
  routeLength?: number;
  /** Distance before the corner body where drift input starts. */
  driftLead?: number;
  /** Peak line offset toward the inside of the bend, in metres. */
  insideOffset?: number;
  /** Base lookahead distance, in metres. */
  lookaheadBase?: number;
  /** Additional lookahead per m/s of speed. */
  lookaheadSpeed?: number;
  /** Cross-track path correction gain, in degrees per metre. */
  crossTrackGainDeg?: number;
  /** Absolute cross-track correction limit, in degrees. */
  crossTrackMaxDeg?: number;
  /** Direct steer bias per metre of lateral path error. */
  crossTrackSteerGain?: number;
  /** Initial full-lock phase before the line controller takes over. */
  kickSeconds?: number;
  /** Maximum body slip requested by the line controller, in degrees. */
  slipTargetDeg?: number;
  /** Minimum body slip requested by the line controller, in degrees. */
  slipMinDeg?: number;
  /** Gain applied to the body-slip tracking error. */
  slipGain?: number;
  /** Integral gain used to remove steady-state body-slip error. */
  slipIntegralGain?: number;
  /** Yaw-rate feedback applied while the drift is active. */
  yawRateFeedback?: number;
  /** Use the recovered P3563 tire model to invert yaw torque into steer. */
  modelYawControl?: boolean;
  /**
   * Drive with keyboard-like full-lock drift pulses and a steady-state slip
   * target derived from the recovered tire model. Fractional analog steering
   * is not available from the original keyboard controls.
   */
  slipHoldControl?: boolean;
  /** Distance after the corner body where drift input is released. */
  driftEndBuffer?: number;
  /** Distance before the corner body ends where the slip target is tapered. */
  slipTaperTail?: number;
  /** Heading gain used by the post-drift grip recovery controller. */
  gripHeadingGain?: number;
  /** Yaw-rate damping used by the post-drift grip recovery controller. */
  gripYawRateGain?: number;
  /** Fixed countersteer applied immediately after releasing the drift. */
  releaseCounterSteer?: number;
  /** Upper bound for the steady drift target speed, in m/s. */
  speedCap?: number;
  /** Optional controller telemetry for calibration probes. */
  debugEvery?: number;
  /** Optional controller telemetry for calibration probes. */
  debug?: (sample: {
    time: number;
    into: number;
    lateral: number;
    lateralTarget: number;
    pathYaw: number;
    pathYawRate: number;
    desiredYawRate: number;
    yawRate: number;
    slip: number;
    targetSlip: number;
    targetSpeed: number;
    yawDemand: number;
    slipDeficit: number;
    intoDrift: number;
    steer: number;
  }) => void;
}

const trackCache = new Map<string, Promise<TrackAssets>>();

function trackFolderUrl(track: string, assetsRoot?: string | URL) {
  const configured = assetsRoot ??
    process.env.KART_DRIFT_ASSET_ROOT;
  if (!configured) {
    return new URL(`../../public/assets/tracks/${track}/`, import.meta.url);
  }
  const root = configured instanceof URL
    ? new URL(configured)
    : pathToFileURL(`${resolve(configured)}/`);
  if (!root.pathname.endsWith("/")) root.pathname += "/";
  return new URL(`tracks/${track}/`, root);
}

export function loadTrack(
  track: string,
  assetsRoot?: string | URL,
): Promise<TrackAssets> {
  const folder = trackFolderUrl(track, assetsRoot);
  const cached = trackCache.get(folder.href);
  if (cached) return cached;
  const loading = loadTrackUncached(track, folder);
  trackCache.set(folder.href, loading);
  return loading;
}

async function loadTrackUncached(
  track: string,
  folder: URL,
): Promise<TrackAssets> {
  const routeFile = new URL("route.json", folder);
  const route = new Route(
    JSON.parse(readFileSync(routeFile, "utf8")) as RouteData,
  );
  const scene = readFileSync(new URL("track.gltf", folder), "utf8");
  const binary = readFileSync(new URL("track.bin", folder));
  const loader = new GLTFLoader().register(parser => ({
    name: "localDriftCourseGeometry",
    loadBufferView: async index => {
      const view = parser.json.bufferViews[index];
      const start = view.byteOffset ?? 0;
      return Uint8Array.from(binary.subarray(start, start + view.byteLength)).buffer;
    },
    loadMaterial: async index =>
      new MeshBasicMaterial({ name: parser.json.materials[index].name }),
  }));
  const collision = new TrackCollision(await loader.parseAsync(scene, ""), track);
  return { track, route, collision };
}

function wrapAngle(angle: number) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function positiveModulo(value: number, modulus: number) {
  return ((value % modulus) + modulus) % modulus;
}

function signedDelta(from: number, to: number, modulus: number) {
  let delta = positiveModulo(to - from, modulus);
  if (delta > modulus / 2) delta -= modulus;
  return delta;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function buildRouteSampler(route: Route) {
  return {
    length: route.length,
    nearest: (x: number, z: number, hint = -1, height?: number) => {
      const sample = route.query(x, z, hint, height);
      return {
        x: sample.x,
        y: sample.y,
        z: sample.z,
        tangentX: sample.forward[0],
        tangentZ: sample.forward[2],
        rightX: sample.right[0],
        rightZ: sample.right[2],
        progress: sample.s,
        lateral: sample.lateral,
        segment: sample.segment,
      };
    },
  };
}

function routeSurface(track: string) {
  return trackSurface(track);
}

function findPointIndex(route: Route, s: number) {
  const wrapped = positiveModulo(s, route.length);
  let low = 0;
  let high = route.points.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (route.points[middle].s <= wrapped) low = middle;
    else high = middle - 1;
  }
  return low;
}

function poseAt(route: Route, s: number) {
  const wrapped = positiveModulo(s, route.length);
  const index = findPointIndex(route, wrapped);
  const point = route.points[index];
  const next = route.points[(index + 1) % route.points.length];
  const span = (next.s - point.s + route.length) % route.length;
  const t = span > 1e-9
    ? Math.min(1, Math.max(0, (wrapped - point.s) / span))
    : 0;
  const fx = point.f[0] + (next.f[0] - point.f[0]) * t;
  const fz = point.f[2] + (next.f[2] - point.f[2]) * t;
  const forwardLength = Math.hypot(fx, fz) || 1;
  return {
    x: point.p[0] + (next.p[0] - point.p[0]) * t,
    y: point.p[1] + (next.p[1] - point.p[1]) * t,
    z: point.p[2] + (next.p[2] - point.p[2]) * t,
    yaw: Math.atan2(fx / forwardLength, fz / forwardLength),
    segment: index,
  };
}

/**
 * Average route heading over a window to remove the coarse waypoint steps in
 * the exported centreline. The visible road is continuous, while `f` vectors
 * are constant for 20-30 m and then jump by 7-13 degrees.
 */
function smoothedYawAt(route: Route, s: number, windowMeters: number) {
  if (windowMeters <= 1) return poseAt(route, s).yaw;
  const base = poseAt(route, s).yaw;
  const half = Math.max(1, Math.round(windowMeters / 2));
  let sum = 0;
  let count = 0;
  for (let offset = -half; offset <= half; offset++) {
    const yaw = poseAt(route, s + offset).yaw;
    sum += wrapAngle(yaw - base);
    count++;
  }
  return base + sum / count;
}

function corridorAt(
  route: Route,
  collision: TrackCollision,
  s: number,
  yaw: number,
) {
  const pose = poseAt(route, s);
  const rightX = Math.cos(pose.yaw);
  const rightZ = -Math.sin(pose.yaw);
  const limit = route.halfWidth;
  const step = 0.5;
  const forwardX = Math.sin(pose.yaw);
  const forwardZ = Math.cos(pose.yaw);
  const footprint = [
    [0, 0],
    [DEFAULT_TUNING.vehicleHalfWidth, 0],
    [-DEFAULT_TUNING.vehicleHalfWidth, 0],
    [0, DEFAULT_TUNING.vehicleHalfLength],
    [0, -DEFAULT_TUNING.vehicleHalfLength],
  ] as const;
  const query = (lateral: number) => {
    const x = pose.x + rightX * lateral;
    const z = pose.z + rightZ * lateral;
    const deck = collision.groundHeight(x, pose.y, z);
    if (deck === null || Math.abs(deck - pose.y) > 1.2) return false;
    for (const [side, forward] of footprint) {
      const sample = collision.groundHeight(
        x + rightX * side + forwardX * forward,
        deck,
        z + rightZ * side + forwardZ * forward,
      );
      // A bridge or elevated section has open air beside its deck. Missing
      // ground under any part of the footprint is a boundary even when there
      // is no wall mesh there.
      if (sample === null || Math.abs(sample - deck) > 0.8) return false;
    }
    const y = deck;
    return collision.queryWall(
      x,
      y,
      z,
      yaw,
      DEFAULT_TUNING.vehicleHalfWidth,
      DEFAULT_TUNING.vehicleHalfLength,
    ) === null;
  };

  let rightBound = 0;
  for (let lateral = step; lateral <= limit; lateral += step) {
    if (!query(lateral)) break;
    rightBound = lateral;
  }
  let leftBound = 0;
  for (let lateral = step; lateral <= limit; lateral += step) {
    if (!query(-lateral)) break;
    leftBound = lateral;
  }
  return { left: -leftBound, right: rightBound };
}

function approachDeckLimit(
  route: Route,
  collision: TrackCollision,
  startS: number,
  distance: number,
) {
  let limit = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset <= distance; offset += 2) {
    const s = positiveModulo(startS + offset, route.length);
    const corridor = corridorAt(
      route,
      collision,
      s,
      poseAt(route, s).yaw,
    );
    limit = Math.min(
      limit,
      Math.min(Math.abs(corridor.left), corridor.right),
    );
  }
  return Number.isFinite(limit) ? Math.max(0, limit - 0.75) : 0;
}

/** Project within a local arc around the previous frame, including the lap seam. */
export function projectNear(route: Route, previousS: number, reach: number, x: number, z: number) {
  const lower = previousS - reach;
  const upper = previousS + reach;
  let index = findPointIndex(route, lower);
  let segmentS = lower + signedDelta(lower, route.points[index].s, route.length);
  let bestDistance = Infinity;
  let bestS = previousS;
  for (let count = 0; count < route.points.length && segmentS <= upper; count++) {
    const point = route.points[index];
    index = (index + 1) % route.points.length;
    const next = route.points[index];
    const span = positiveModulo(next.s - point.s, route.length);
    const dx = next.p[0] - point.p[0];
    const dz = next.p[2] - point.p[2];
    const planarLengthSq = dx * dx + dz * dz;
    if (span > 0 && planarLengthSq > 0) {
      const t = clamp(((x - point.p[0]) * dx + (z - point.p[2]) * dz) / planarLengthSq,
        Math.max(0, (lower - segmentS) / span), Math.min(1, (upper - segmentS) / span));
      const distance = (x - point.p[0] - t * dx) ** 2 + (z - point.p[2] - t * dz) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestS = segmentS + t * span;
      }
    }
    segmentS += span;
  }
  const pose = poseAt(route, bestS);
  return {
    s: positiveModulo(bestS, route.length),
    lateral: (x - pose.x) * Math.cos(pose.yaw) - (z - pose.z) * Math.sin(pose.yaw),
    yaw: pose.yaw,
  };
}

export function defaultCornerSpeed(corner: TrackCorner, speedCap?: number) {
  return steadyDriftSpeed(corner, speedCap);
}

function sideSlipDegrees(sample: DriftTelemetrySample) {
  return Math.abs(Math.atan2(
    sample.lateralSpeed,
    Math.max(0.1, Math.abs(sample.speed)),
  ) * DEG);
}

/**
 * Move the requested outside start offset inward until the kart footprint no
 * longer intersects a wall. `route.halfWidth` is an AI corridor rather than
 * the physical road mesh, so a fixed offset spawns through fences on the
 * narrower courses.
 */
function safeStartPose(
  collision: TrackCollision,
  pose: ReturnType<typeof poseAt>,
  rightX: number,
  rightZ: number,
  requestedLateral: number,
) {
  const sign = requestedLateral < 0 ? -1 : 1;
  let offset = Math.abs(requestedLateral);
  for (;;) {
    const lateral = sign * offset;
    const x = pose.x + rightX * lateral;
    const z = pose.z + rightZ * lateral;
    const groundY = collision.groundHeight(x, pose.y, z);
    const y = groundY ?? pose.y;
    const contact = collision.queryWall(
      x,
      y,
      z,
      pose.yaw,
      DEFAULT_TUNING.vehicleHalfWidth,
      DEFAULT_TUNING.vehicleHalfLength,
    );
    // A bridge or elevated road can have open air below the requested
    // outside offset. Do not spawn the kart on the ravine floor: keep moving
    // inward until the collision surface agrees with the route deck. The
    // exported route spline can sit slightly below a ramp mesh, so accept a
    // surface above the spline while still rejecting a lower deck.
    const onDeck =
      groundY !== null &&
      groundY >= pose.y - 0.6 &&
      groundY <= pose.y + 1.2;
    if (!contact && onDeck) {
      return { offset, x, y: groundY, z };
    }
    if (offset <= 0) {
      return null;
    }
    offset = Math.max(0, offset - 0.25);
  }
}

/**
 * Run one corner from a supported rolling start with a 100 Hz controller cadence.
 *
 * The vehicle itself still integrates at its internal 2 ms fixed step. This
 * helper only fixes the controller/sensor cadence, so a driver cannot change
 * its result with render-frame timing.
 */
export async function runCornerDrift(
  track: string,
  corner: TrackCorner,
  driver: DriftDriver,
  options: CornerDriftOptions = {},
): Promise<CornerDriftRun> {
  const { route, collision } = await loadTrack(track, options.assetsRoot);
  let approach = options.approach ?? 8;
  const step = options.step ?? 0.01;
  const maxDuration = options.maxDuration ?? 40;
  const finishBuffer = options.finishBuffer ?? 20;
  const startOutside = options.startOutside ?? 8;
  const requestedSpeed = options.initialSpeed ?? defaultCornerSpeed(corner, options.speedCap);
  let startS: number, startPose: ReturnType<typeof poseAt>, routeRightX: number, routeRightZ: number;
  let spawn: ReturnType<typeof safeStartPose>;
  do {
    startS = positiveModulo(corner.start - approach, route.length);
    startPose = poseAt(route, startS);
    routeRightX = Math.cos(startPose.yaw);
    routeRightZ = -Math.sin(startPose.yaw);
    const limit = approachDeckLimit(route, collision, startS, approach);
    spawn = safeStartPose(collision, startPose, routeRightX, routeRightZ,
      -corner.direction * Math.min(startOutside, limit));
    if (spawn) break;
    approach -= 1;
  } while (approach > 0);
  if (!spawn) throw new Error(`${track}: no supported approach before s=${corner.start}`);
  const { x: startX, y: resolvedStartY, z: startZ } = spawn;
  const finishS = positiveModulo(corner.end + finishBuffer, route.length);
  // A rolling start has zero vertical velocity. Test its first wheel contact on
  // the actual mesh before choosing the entry speed; on steep down-ramps the
  // deck can fall away even though the stationary footprint is supported.
  const supported = (speed: number) => {
    const suspension = new KartSuspension();
    const travel = speed * FIXED_STEP_SECONDS;
    suspension.step(startX + travel * Math.sin(startPose.yaw), resolvedStartY,
      startZ + travel * Math.cos(startPose.yaw), startPose.yaw, speed, 0,
      (x, z, y, ceiling) => collision.groundHeight(x, y, z, ceiling), FIXED_STEP_SECONDS);
    return suspension.grounded && suspension.frontContact > 0 && suspension.rearContact > 0;
  };
  let initialSpeed = requestedSpeed;
  while (initialSpeed > 0 && !supported(initialSpeed)) initialSpeed = Math.max(0, Math.ceil(initialSpeed) - 1);
  if (initialSpeed === 0) throw new Error(`${track}: unsupported rolling start at s=${startS}`);

  const kart = new KartVehicle({
    position: { x: startX, y: resolvedStartY, z: startZ },
    yaw: startPose.yaw,
    speed: initialSpeed,
    route: buildRouteSampler(route),
    wallContactAt: collision.queryWall.bind(collision),
    groundHeightAt: (x, z, _progress, height, ceiling) =>
      collision.groundHeight(x, height, z, ceiling),
    surfaceAt: () => routeSurface(track),
    tuning: options.tuning,
  });

  const cornerStartOffset = approach;
  const cornerEndOffset = approach + corner.length;
  const finishOffset = cornerEndOffset + finishBuffer;
  let currentS = startS;
  let currentLateral = (startX - startPose.x) * routeRightX + (startZ - startPose.z) * routeRightZ;
  let currentYaw = startPose.yaw;
  // Drift analysis is planar (like the KSV position differences). Body-local
  // axle speeds include pitch/roll and vertical suspension motion on a grade.
  const planarComponents = (yaw: number) => {
    const { velocity } = kart.physicsSnapshot;
    return { speed: velocity.x * Math.sin(yaw) + velocity.z * Math.cos(yaw),
      lateralSpeed: velocity.x * Math.cos(yaw) - velocity.z * Math.sin(yaw) };
  };
  const samples: CornerDriftRun["samples"] = [{
    x: kart.state.x, z: kart.state.z,
    t: kart.state.time,
    s: currentS,
    yaw: kart.state.yaw,
    ...planarComponents(kart.state.yaw),
    drifting: kart.state.drifting,
    driftPhase: kart.state.driftPhase,
  }];

  let collisions = 0;
  let majorCollisions = 0;
  let collisionDetail = "";
  let offroad = false;
  let offroadDetail = "";
  let reversed = false;
  let reverseDetail = "";
  let timedOut = false;
  let reachedExit = false;
  let cornerEndHeadingErrorDeg: number | null = null;
  let cornerEndBodyHeadingErrorDeg: number | null = null;
  let finalHeadingErrorDeg = 0;
  let maxLateral = 0;
  let minGroundedChassisOffset: CornerDriftRun["minGroundedChassisOffset"] = null;
  let cornerEntrySpeed: number | null = null;
  let cornerExitSpeed: number | null = null;
  let enteredCorner = false;
  let cornerExited = false;
  let driftInputStartS: number | null = null;
  let driftInputStartTime: number | null = null;
  let driftInputLeadMeters: number | null = null;
  let driftInputActiveAtCornerStart: boolean | null = null;
  let finished = false;
  const corridorCache = new Map<
    number,
    { left: number; right: number }
  >();
  const corridorFor = (s: number, yaw: number) => {
    const key =
      Math.round(positiveModulo(s, route.length) * 2) * 1000 +
      Math.round(wrapAngle(yaw - poseAt(route, s).yaw) * 10);
    const cached = corridorCache.get(key);
    if (cached) return cached;
    const corridor = corridorAt(route, collision, s, yaw);
    corridorCache.set(key, corridor);
    return corridor;
  };

  const maxFrames = Math.ceil(maxDuration / step);
  for (let frame = 0; frame < maxFrames; frame++) {
    const state = kart.state;
    const corridor = corridorFor(currentS, state.yaw);
    const before = {
      s: currentS,
      lateral: currentLateral,
      yaw: currentYaw,
      corridorLeft: corridor.left,
      corridorRight: corridor.right,
    };
    const into = signedDelta(startS, before.s, route.length);
    const input = driver({
      state,
      sample: {
        s: before.s,
        lateral: before.lateral,
        yaw: before.yaw,
        corridorLeft: before.corridorLeft,
        corridorRight: before.corridorRight,
        corridorAt: s => corridorFor(s, poseAt(route, s).yaw),
        velocityHeading: Math.atan2(kart.physicsSnapshot.velocity.x, kart.physicsSnapshot.velocity.z),
      },
      corner,
      time: state.time,
    });
    const driftInput = input.drift === true;

    if (driftInput && driftInputStartS === null) {
      driftInputStartS = before.s;
      driftInputStartTime = state.time;
      driftInputLeadMeters = signedDelta(corner.start, before.s, route.length);
    }
    if (driftInputActiveAtCornerStart === null && into >= cornerStartOffset) {
      driftInputActiveAtCornerStart = driftInput;
    }

    const previousCollisionCount = state.collisionCount;
    const next = kart.step(step, input);
    const travel = Math.hypot(next.x - state.x, next.z - state.z);
    // Allow for the shorter distance travelled on the inside of a bend.
    const sample = projectNear(route, currentS, 2 * travel + 0.01, next.x, next.z);
    currentS = sample.s;
    currentLateral = sample.lateral;
    currentYaw = sample.yaw;
    const progress = signedDelta(startS, currentS, route.length);
    const entersCorner = !enteredCorner && progress >= cornerStartOffset;
    const exitsCorner = !cornerExited && progress >= cornerEndOffset;
    if (entersCorner) enteredCorner = true;
    const speed = next.planarSpeed;
    const sampleYaw = sample.yaw;

    samples.push({
      x: next.x, z: next.z,
      t: kart.state.time,
      s: sample.s,
      yaw: kart.state.yaw,
      ...planarComponents(next.yaw),
      drifting: kart.state.drifting,
      driftPhase: kart.state.driftPhase,
    });
    if (next.suspension?.grounded) {
      const meters = kart.physicsSnapshot.position.y - next.y;
      if (minGroundedChassisOffset === null || meters < minGroundedChassisOffset.meters) {
        minGroundedChassisOffset = { meters, s: currentS, time: next.time };
      }
    }
    maxLateral = Math.max(maxLateral, Math.abs(sample.lateral));
    finalHeadingErrorDeg = Math.abs(wrapAngle(kart.state.yaw - sampleYaw) * DEG);

    if (entersCorner) {
      cornerEntrySpeed = speed;
    }
    if (exitsCorner && !reachedExit) {
      reachedExit = true;
      cornerExitSpeed = speed;
      const endPose = poseAt(route, corner.end);
      const { velocity } = kart.physicsSnapshot;
      cornerEndBodyHeadingErrorDeg = Math.abs(
        wrapAngle(kart.state.yaw - endPose.yaw) * DEG,
      );
      cornerEndHeadingErrorDeg = Math.abs(
        wrapAngle(Math.atan2(velocity.x, velocity.z) - endPose.yaw) * DEG,
      );
      cornerExited = true;
    }

    if (next.collisionCount > previousCollisionCount) {
      collisions = next.collisionCount;
      majorCollisions = next.collisionCount;
      if (!collisionDetail) {
        collisionDetail =
          `s=${sample.s.toFixed(1)} lateral=${sample.lateral.toFixed(2)} ` +
          `impact=${next.impactSpeed.toFixed(2)} drifting=${next.drifting}`;
      }
      break;
    }
    // `route.halfWidth` is the AI centreline corridor, not the physical road
    // boundary. Village corners are 13.6-14.2 m from the centreline to the
    // wall while the route declares 10 m, and desert's corridor is narrower
    // than its road. Use the collision query as the actual boundary and keep
    // this only as a runaway guard.
    if (Math.abs(sample.lateral) > route.halfWidth + 20) {
      offroad = true;
      offroadDetail =
        `s=${sample.s.toFixed(1)} lateral=${sample.lateral.toFixed(2)} ` +
        `halfWidth=${route.halfWidth.toFixed(2)} speed=${speed.toFixed(1)}`;
      break;
    }
    if (next.speed < -0.5) {
      reversed = true;
      reverseDetail =
        `s=${sample.s.toFixed(1)} speed=${next.speed.toFixed(2)} ` +
        `lateral=${sample.lateral.toFixed(2)}`;
      break;
    }
    const finishInto = signedDelta(startS, currentS, route.length);
    if (finishInto >= finishOffset) {
      finished = true;
      break;
    }
    if (kart.state.time >= maxDuration) {
      timedOut = true;
      break;
    }
  }
  if (!finished && !timedOut && collisions === 0 && !offroad && !reversed) {
    timedOut = true;
  }

  const [analysis] = analyzeCornerDrift(samples, [corner], route.length, {
    minCoverage: DRIFT_ACCEPTANCE.minCoverage,
    maxCoverageGap: DRIFT_ACCEPTANCE.maxCoverageGap,
    // Short 20-24 m corners take less than 0.9 s to traverse at racing speed.
    // The reference 0.9 s floor is for the whole drift episode; applying it to
    // the in-corner slice would make those corners impossible by construction.
    // The episode-level check below still enforces the 0.9 s floor.
    minDriftSeconds: 0,
  });
  const allEpisodes = findDriftEpisodes(samples);
  const overlappingEpisodes = allEpisodes.filter(episode =>
    samples.some(sample =>
      sample.t >= episode.startTime &&
      sample.t <= episode.endTime &&
      cornerContains(corner, sample.s, route.length)),
  );
  const longestDrift = overlappingEpisodes.reduce<DriftEpisode | null>(
    (longest, episode) =>
      longest === null || episode.duration > longest.duration ? episode : longest,
    null,
  );
  const insideDriftSlips = samples
    .filter(sample =>
      cornerContains(corner, sample.s, route.length) && sample.drifting)
    .map(sideSlipDegrees);
  const cornerSpeedRetention =
    cornerEntrySpeed !== null &&
    cornerExitSpeed !== null &&
    cornerEntrySpeed > 1e-6
      ? cornerExitSpeed / cornerEntrySpeed
      : null;
  const driftInputStartedBeforeCorner =
    driftInputLeadMeters !== null && driftInputLeadMeters < 0;
  const exitHeadingErrorDeg = cornerEndHeadingErrorDeg;

  const failures: string[] = [];
  if (collisions > 0) failures.push(`collision (${collisionDetail})`);
  if (offroad) failures.push(`offroad (${offroadDetail})`);
  if (reversed) failures.push(`reverse (${reverseDetail})`);
  if (timedOut) failures.push(`timeout (${kart.state.time.toFixed(2)}s)`);
  if (!reachedExit) {
    failures.push("did not reach corner exit");

  }

  return {
    track,
    corner,
    approach,
    startS,
    finishS,
    initialSpeed,
    duration: kart.state.time,
    samples,
    analysis,
    collisions,
    majorCollisions,
    collisionDetail,
    offroad,
    offroadDetail,
    reversed,
    reverseDetail,
    timedOut,
    reachedExit,
    exitHeadingErrorDeg,
    cornerEndHeadingErrorDeg,
    cornerEndBodyHeadingErrorDeg,
    finalHeadingErrorDeg,
    maxLateral,
    minGroundedChassisOffset,
    cornerEntrySpeed,
    cornerExitSpeed,
    cornerSpeedRetention,
    driftSpeedRetention: longestDrift?.speedRetention ?? null,
    driftSamplesInCorner: insideDriftSlips.length,
    medianSideSlipDeg: insideDriftSlips.length
      ? median(insideDriftSlips)
      : null,
    longestDriftSeconds: longestDrift?.duration ?? 0,
    longestDrift,
    coverage: analysis.coverage,
    maxCoverageGap: analysis.maxCoverageGap,
    driftInputStartS,
    driftInputStartTime,
    driftInputLeadMeters,
    driftInputStartedBeforeCorner,
    driftInputActiveAtCornerStart,
    failures,
  };
}

/**
 * Extract the corners that can actually host a drift.
 *
 * `extractCorners` keeps a 13 m connector-like jog in village (roughly
 * s=1814..1827). It is a route-export artefact rather than a bend and cannot
 * contain the required 0.9 s drift, so the shared harness filters sub-20 m
 * sections here instead of changing the production extractor.
 */
export function extractDriftCorners(route: Route) {
  const extracted = extractCorners(route.data, {
    minLength: 18,
    straightMinLength: 18,
    flatSlope: 0.0025,
  });
  const filteredShortCorners = extracted
    .filter(corner => corner.length < MIN_DRIFT_CORNER_LENGTH)
    .map(corner => ({
      start: corner.start,
      end: corner.end,
      length: corner.length,
      headingDegrees: corner.headingDegrees,
    }));
  return {
    corners: extracted.filter(corner => corner.length >= MIN_DRIFT_CORNER_LENGTH),
    filteredShortCorners,
  };
}

export async function runTrackDrift(
  track: string,
  driverFactory: DriftDriverFactory,
  options: CornerDriftOptions = {},
): Promise<TrackDriftRun> {
  const { route } = await loadTrack(track, options.assetsRoot);
  const { corners, filteredShortCorners } = extractDriftCorners(route);
  const runs: CornerDriftRun[] = [];
  for (const corner of corners) {
    const initialSpeed = options.initialSpeed ?? options.initialSpeedForCorner?.(corner, route);
    const driver = driverFactory({
      track,
      corner,
      route,
      routeLength: route.length,
    });
    runs.push(await runCornerDrift(track, corner, driver, {
      ...options,
      approach: options.approach ?? (initialSpeed ?? defaultCornerSpeed(corner)) *
        (DEFAULT_TUNING.driftTrigTime + DIGITAL_TIRE_DRIFT.predictionSeconds),
      startOutside: options.startOutside ?? DEFAULT_TUNING.vehicleHalfWidth,
      initialSpeed,
    }));
  }

  const acceptance = runs.map(run => driftAcceptanceReasons(run));
  const failureReasons: Record<string, number> = {};
  for (const reasons of acceptance) {
    for (const reason of reasons) {
      const key = reason.split(" ")[0];
      failureReasons[key] = (failureReasons[key] ?? 0) + 1;
    }
  }
  const summary: TrackDriftSummary = {
    corners: runs.length,
    passed: acceptance.filter(reasons => reasons.length === 0).length,
    failed: acceptance.filter(reasons => reasons.length > 0).length,
    failureReasons,
    averageCoverage: runs.length
      ? runs.reduce((sum, run) => sum + run.coverage, 0) / runs.length
      : 0,
    maxCoverageGap: runs.length
      ? Math.max(...runs.map(run => run.maxCoverageGap))
      : 0,
    averageLongestDriftSeconds: runs.length
      ? runs.reduce((sum, run) => sum + run.longestDriftSeconds, 0) / runs.length
      : 0,
    medianMedianSideSlipDeg: median(
      runs.flatMap(run =>
        run.medianSideSlipDeg === null ? [] : [run.medianSideSlipDeg]),
    ),
  };
  return {
    track,
    routeLength: route.length,
    corners,
    filteredShortCorners,
    runs,
    summary,
  };
}

const ACCEPTANCE_DRIFT = {
  speedMin: 16,
  speedCap: 55,
  targetSlipDeg: 45,
  driftLead: 10,
  driftTail: 4,
  driftEndBuffer: 8,
  slipTaperTail: 3,
  kickSeconds: 0.12,
  kickSteer: 1,
  slipTargetDeg: 55,
  slipMinDeg: 30,
  slipCurvatureGain: 0.3,
  slipCurvatureOffsetDeg: 12,
  slipRampSeconds: 0.5,
  slipExitTaperDistance: 8,
  slipExitTargetDeg: 8,
  insideOffset: 0.5,
  lookaheadBase: 10,
  lookaheadSpeed: 0.55,
  lookaheadRadiusWindow: 18,
  lookaheadRadiusScale: 0.55,
  lookaheadMin: 12,
  lookaheadMax: 32,
  crossTrackGainDeg: 1.4,
  crossTrackMaxDeg: 24,
  crossTrackSteerGain: 0,
  pursuitBearingLimitDeg: 18,
  yawHeadingGain: 1.6,
  yawCourseGain: 0.9,
  yawRateGain: 0,
  slipGain: 1.5,
  slipIntegralGain: 0,
  yawRateCapDeg: 84,
  yawRateCapGain: 0.06,
  releaseCounterSeconds: 0.35,
  releaseCounterSteer: 0.35,
  releaseSlipGain: 1.2,
  gripHeadingGain: 2.4,
  gripYawRateGain: 0.5,
  slipBuildFraction: 0.72,
  slipBuildMaxSeconds: 0.65,
  slipHoldCourseGain: 1.3,
  slipHoldLateralGain: 0.14,
  slipHoldYawRateGain: 0.18,
  slipHoldMaxCommand: 1.25,
  slipHoldMaxSlipDeg: 60,
  minSteer: 0.07,
  throttleMargin: 0.35,
  brakeMargin: 0.75,
  brakeGain: 1,
} as const;

function targetDriftSpeed(corner: TrackCorner, speedCap?: number) {
  return steadyDriftSpeed(corner, speedCap);
}

/**
 * Steady-state P3563 drift speed for a target body slip angle.
 *
 * At equilibrium the yaw torque cancels (`yawRate = speed / radius`) and the
 * lateral tire force supplies the turn:
 *
 *   weight * (steer - 2 * tan(beta)) = -mass * speed^2 / radius
 *
 * With `weight = mass * 9.8`, the effective steering angle cancels and:
 *
 *   speed^2 = 9.8 + 19.6 * radius * tan(beta)
 *
 * The cap is below the 2160 N / 0.75 drag terminal speed. Gentle corners then
 * hold the highest slip the top speed can support instead of demanding an
 * impossible 45-degree slide at 60 km/h.
 */
function steadyDriftSpeed(corner: TrackCorner, speedCap?: number) {
  const heading = Math.max(
    0.1,
    Math.abs(corner.absoluteHeadingDegrees ?? corner.headingDegrees) * RAD,
  );
  const radius = corner.length / heading;
  return clamp(
    Math.sqrt(
      9.8 +
      19.6 * radius * Math.tan(ACCEPTANCE_DRIFT.targetSlipDeg * RAD),
    ),
    ACCEPTANCE_DRIFT.speedMin,
    speedCap ?? ACCEPTANCE_DRIFT.speedCap,
  );
}

/**
 * Closed-loop acceptance driver for sustained, linked drifts.
 *
 * The driver enters just before the corner, uses a full-lock kick, follows a
 * lookahead racing line, and tapers the requested slip near the exit. It has
 * no render or browser dependency, so the same controller exercises the Web
 * runtime and any shared standalone runtime.
 */
export function acceptanceDriftDriver(
  options: AcceptanceDriftDriverOptions = {},
): DriftDriver {
  const route = options.route;
  const routeLength = options.routeLength ?? 0;
  const driftLead = options.driftLead ?? ACCEPTANCE_DRIFT.driftLead;
  const kickSeconds = options.kickSeconds ?? ACCEPTANCE_DRIFT.kickSeconds;
  const slipTarget = (options.slipTargetDeg ?? ACCEPTANCE_DRIFT.slipTargetDeg) * RAD;
  const slipMin =
    (options.slipMinDeg ?? ACCEPTANCE_DRIFT.slipMinDeg) * RAD;
  const slipGain = options.slipGain ?? ACCEPTANCE_DRIFT.slipGain;
  const slipIntegralGain =
    options.slipIntegralGain ?? ACCEPTANCE_DRIFT.slipIntegralGain;
  const yawRateFeedback =
    options.yawRateFeedback ?? ACCEPTANCE_DRIFT.yawRateGain;
  const modelYawControl = options.modelYawControl ?? false;
  const slipHoldControl = options.slipHoldControl ?? true;
  const driftEndBuffer =
    options.driftEndBuffer ?? ACCEPTANCE_DRIFT.driftEndBuffer;
  const slipTaperOverride = options.slipTaperTail;
  const gripHeadingGain =
    options.gripHeadingGain ?? ACCEPTANCE_DRIFT.gripHeadingGain;
  const gripYawRateGain =
    options.gripYawRateGain ?? ACCEPTANCE_DRIFT.gripYawRateGain;
  const releaseCounterSteer =
    options.releaseCounterSteer ?? ACCEPTANCE_DRIFT.releaseCounterSteer;
  const speedCap = options.speedCap;
  const debug = options.debug;
  const insideOffset = options.insideOffset ?? ACCEPTANCE_DRIFT.insideOffset;
  const lookaheadBase =
    options.lookaheadBase ?? ACCEPTANCE_DRIFT.lookaheadBase;
  const lookaheadSpeed =
    options.lookaheadSpeed ?? ACCEPTANCE_DRIFT.lookaheadSpeed;
  const crossTrackGainDeg =
    options.crossTrackGainDeg ?? ACCEPTANCE_DRIFT.crossTrackGainDeg;
  const crossTrackMaxDeg =
    options.crossTrackMaxDeg ?? ACCEPTANCE_DRIFT.crossTrackMaxDeg;
  const crossTrackSteerGain =
    options.crossTrackSteerGain ?? ACCEPTANCE_DRIFT.crossTrackSteerGain;
  let kickStart: number | null = null;
  let releasedAt = -Infinity;
  let releaseDirection = 0;
  let targetSpeed: number | null = null;
  let previousTime = 0;
  let previousYaw = 0;
  let yawRate = 0;
  let driftElapsed = 0;
  let wasDriftRequested = false;
  let slipIntegral = 0;

  return ({ state, sample, corner, time }) => {
    const speed = Math.hypot(state.speed, state.lateralSpeed);
    const frameDt = Math.max(0, time - previousTime);
    if (frameDt > 0) {
      const measured = wrapAngle(state.yaw - previousYaw) /
        frameDt;
      yawRate = yawRate * 0.75 + measured * 0.25;
    }
    previousTime = time;
    previousYaw = state.yaw;
    targetSpeed ??= targetDriftSpeed(corner, speedCap);
    const into = routeLength > 0
      ? signedDelta(corner.start, sample.s, routeLength)
      : sample.s - corner.start;
    const pastEnd = routeLength > 0
      ? signedDelta(corner.end, sample.s, routeLength)
      : sample.s - corner.end;
    const releaseBeforeEnd = driftEndBuffer ?? 0;
    const driftRequested =
      into >= -driftLead && pastEnd <= releaseBeforeEnd;
    if (driftRequested && !wasDriftRequested) {
      driftElapsed = 0;
      slipIntegral = 0;
    }
    if (driftRequested) {
      if (kickStart === null) kickStart = time;
      driftElapsed += frameDt;
    } else if (wasDriftRequested) {
      releasedAt = time;
      releaseDirection = corner.direction;
      slipIntegral = 0;
    }
    wasDriftRequested = driftRequested;

    const slip = Math.atan2(
      state.lateralSpeed,
      Math.max(1, Math.abs(state.speed)),
    );
    const direction = corner.direction;
    const pose = route
      ? poseAt(route, sample.s)
      : { x: state.x, z: state.z, yaw: sample.yaw, segment: -1 } as const;
    const curvatureDistance = clamp(speed * 0.55, 12, 30);
    const pathAhead = route
      ? poseAt(route, sample.s + curvatureDistance)
      : pose;
    const pathYawRate =
      speed * wrapAngle(pathAhead.yaw - pose.yaw) / curvatureDistance;
    const lookTarget = route
      ? poseAt(route, sample.s + clamp(
        lookaheadBase + speed * lookaheadSpeed,
        ACCEPTANCE_DRIFT.lookaheadMin,
        ACCEPTANCE_DRIFT.lookaheadMax,
      ))
      : pose;
    let pathYaw = pose.yaw +
      wrapAngle(lookTarget.yaw - pose.yaw) * 0.5;
    const pursuitYaw = Math.atan2(
      lookTarget.x - state.x,
      lookTarget.z - state.z,
    );
    pathYaw += clamp(
      wrapAngle(pursuitYaw - pathYaw),
      -ACCEPTANCE_DRIFT.pursuitBearingLimitDeg * RAD,
      ACCEPTANCE_DRIFT.pursuitBearingLimitDeg * RAD,
    );
    const lineT = clamp(into / Math.max(1, corner.length), 0, 1);
    const lineShape = into < 0 || into > corner.length
      ? 0
      : Math.sin(Math.PI * lineT);
    const lateralTarget = corner.direction * insideOffset * lineShape;
    pathYaw += clamp(
      (lateralTarget - sample.lateral) *
        crossTrackGainDeg * RAD,
      -crossTrackMaxDeg * RAD,
      crossTrackMaxDeg * RAD,
    );

    let steer: number;
    let telemetryIntoDrift = 0;
    let telemetryDesiredYawRate = 0;
    let telemetryTargetSlip = 0;
    let telemetryYawDemand = 0;
    let telemetrySlipDeficit = 0;
    if (driftRequested && kickStart !== null &&
        time - kickStart < kickSeconds) {
      steer = direction * ACCEPTANCE_DRIFT.kickSteer;
    } else if (driftRequested) {
      const slipTaperTail = slipTaperOverride ?? Math.min(
        corner.length * 0.2,
        Math.max(8, targetSpeed * 0.7),
      );
      const exitRemaining = Math.max(
        0,
        corner.length + slipTaperTail - into,
      );
      const exitScale = clamp(
        exitRemaining / ACCEPTANCE_DRIFT.slipExitTaperDistance,
        0,
        1,
      );
      const entryScale = clamp(
        driftElapsed / ACCEPTANCE_DRIFT.slipRampSeconds,
        0,
        1,
      );
      const curvatureSlip = clamp(
        Math.abs(pathYawRate) * DEG *
          ACCEPTANCE_DRIFT.slipCurvatureGain +
          ACCEPTANCE_DRIFT.slipCurvatureOffsetDeg,
        slipMin / RAD,
        slipTarget / RAD,
      );
      const slipMagnitude = ACCEPTANCE_DRIFT.slipExitTargetDeg +
        (curvatureSlip - ACCEPTANCE_DRIFT.slipExitTargetDeg) *
        Math.min(entryScale, exitScale);
      const targetSlip = -direction * slipMagnitude * RAD;
      const desiredBodyYaw = pathYaw - targetSlip;
      const headingError = wrapAngle(desiredBodyYaw - state.yaw);
      const velocityYaw = state.yaw + slip;
      const courseError = wrapAngle(pathYaw - velocityYaw);
      const desiredYawRate = clamp(
        pathYawRate +
          headingError * ACCEPTANCE_DRIFT.yawHeadingGain +
          courseError * ACCEPTANCE_DRIFT.yawCourseGain,
        -ACCEPTANCE_DRIFT.yawRateCapDeg * RAD,
        ACCEPTANCE_DRIFT.yawRateCapDeg * RAD,
      );
      const speedFactor = clamp(speed / 15, 0.35, 1);
      const yawDemand =
        (desiredYawRate - yawRate * yawRateFeedback) * direction /
        speedFactor;
      let intoDrift = yawDemand >= 0.82
        ? (yawDemand - 0.82) / 0.62
        : (yawDemand - 0.82) / 1.5;
      intoDrift += (Math.abs(targetSlip) - Math.abs(slip)) *
        slipGain;
      slipIntegral = clamp(
        slipIntegral +
          (Math.abs(targetSlip) - Math.abs(slip)) *
          slipIntegralGain * frameDt,
        -0.5,
        0.5,
      );
      intoDrift += slipIntegral;
      telemetryYawDemand = yawDemand;
      telemetrySlipDeficit = (Math.abs(targetSlip) - Math.abs(slip)) *
        ACCEPTANCE_DRIFT.slipGain;
      intoDrift = clamp(intoDrift, -1, 1);
      telemetryIntoDrift = intoDrift;
      telemetryDesiredYawRate = desiredYawRate;
      telemetryTargetSlip = targetSlip;
      if (slipHoldControl) {
        const gripScale = Math.max(
          1e-6,
          2 * DEFAULT_TUNING.frontGripFactor *
            DEFAULT_TUNING.driftSlipFactor,
        );
        const curvature = Math.abs(pathYawRate) / Math.max(1, speed);
        const slipDenominator =
          speed * speed / (ORIGINAL_TIRE_GRAVITY * gripScale) - 0.5;
        const physicalSlip = Math.atan(
          curvature * Math.max(0, slipDenominator),
        );
        const targetSlipMagnitude = clamp(
          physicalSlip,
          8 * RAD,
          ACCEPTANCE_DRIFT.slipHoldMaxSlipDeg * RAD,
        );
        telemetryTargetSlip = -direction * targetSlipMagnitude;
        const actualSlipMagnitude = Math.abs(slip);
        const building =
          actualSlipMagnitude <
            targetSlipMagnitude * ACCEPTANCE_DRIFT.slipBuildFraction &&
          driftElapsed < ACCEPTANCE_DRIFT.slipBuildMaxSeconds;

        if (building) {
          // The original keyboard has no analog value: entry is a held
          // direction key, so build the slide at full lock.
          steer = direction * ACCEPTANCE_DRIFT.kickSteer;
        } else {
          const steerAngleFeedForward = Math.tan(targetSlipMagnitude) /
            Math.max(0.5, slipDenominator);
          const steerFeedForward =
            steerAngleFeedForward * DEG / DEFAULT_TUNING.maxSteerDeg;
          const slipError = targetSlipMagnitude - actualSlipMagnitude;
          const courseTurn = direction * courseError;
          const lateralTurn =
            -direction * (sample.lateral - lateralTarget);
          const yawRateError = direction * (desiredYawRate - state.yawRate);
          const command =
            steerFeedForward +
            slipError * slipGain +
            courseTurn * ACCEPTANCE_DRIFT.slipHoldCourseGain +
            lateralTurn * ACCEPTANCE_DRIFT.slipHoldLateralGain +
            yawRateError * ACCEPTANCE_DRIFT.slipHoldYawRateGain;
          steer =
            direction * clamp(
              command,
              -ACCEPTANCE_DRIFT.slipHoldMaxCommand,
              ACCEPTANCE_DRIFT.slipHoldMaxCommand,
            );
        }
        telemetryIntoDrift = steer * direction;
      } else if (modelYawControl) {
        const config = {
          mass: DEFAULT_TUNING.mass,
          maxSteerDegrees: DEFAULT_TUNING.maxSteerDeg,
          steerConstraint: DEFAULT_TUNING.steerConstraint,
          frontGripFactor: DEFAULT_TUNING.frontGripFactor,
          rearGripFactor: DEFAULT_TUNING.rearGripFactor,
          driftTriggerFactor: DEFAULT_TUNING.driftTriggerFactor,
          driftSlipFactor: DEFAULT_TUNING.driftSlipFactor,
          cornerDrawFactor: DEFAULT_TUNING.cornerDrawFactor,
          driftLeanFactor: DEFAULT_TUNING.driftLeanFactor,
          steerLeanFactor: DEFAULT_TUNING.steerLeanFactor,
          heldDriftSteer: DEFAULT_TUNING.heldDriftSteer,
        } as const;
        const response = (steeringInput: number) =>
          computeOriginalLateralResponse(config, {
            forwardVelocity: state.speed,
            lateralVelocity: state.lateralSpeed,
            yawRate: state.yawRate,
            steeringInput,
            driftInputActive: true,
            mode: "drift",
          });
        const neutral = response(0);
        const fullSteer = response(1);
        const torqueSlope = fullSteer.yawTorque - neutral.yawTorque;
        const desiredYawAcceleration = clamp(
          (desiredYawRate - state.yawRate) / 0.12,
          -80,
          80,
        );
        const desiredTorque =
          desiredYawAcceleration * DEFAULT_TUNING.mass /
          (1 / DEFAULT_TUNING.yawInertiaPerMass);
        steer = Math.abs(torqueSlope) > 1e-6
          ? (desiredTorque - neutral.yawTorque) / torqueSlope
          : direction * intoDrift;
        steer += clamp(
          (lateralTarget - sample.lateral) * crossTrackSteerGain,
          -1,
          1,
        );
        telemetryIntoDrift = intoDrift;
      } else {
        steer = direction * intoDrift;
      }
    } else {
      const gripTargetYaw = pathYaw -
        Math.sign(slip) *
        Math.min(Math.abs(slip), 35 * RAD) * 0.15;
      const headingError = wrapAngle(gripTargetYaw - state.yaw);
      steer =
        headingError * gripHeadingGain -
        yawRate * gripYawRateGain +
        slip * ACCEPTANCE_DRIFT.releaseSlipGain;
      if (time - releasedAt <= ACCEPTANCE_DRIFT.releaseCounterSeconds) {
        steer -= releaseDirection * releaseCounterSteer;
      }
    }
    if (driftRequested &&
        kickStart !== null &&
        time - kickStart >= kickSeconds &&
        steer * direction > 0 &&
        Math.abs(steer) < ACCEPTANCE_DRIFT.minSteer) {
      steer = direction * ACCEPTANCE_DRIFT.minSteer;
    }
    steer = clamp(steer, -1, 1);
    debug?.({
      time,
      into,
      lateral: sample.lateral,
      lateralTarget,
      pathYaw,
      pathYawRate,
      desiredYawRate: telemetryDesiredYawRate,
      yawRate,
      slip,
      targetSlip: telemetryTargetSlip,
      yawDemand: telemetryYawDemand,
      slipDeficit: telemetrySlipDeficit,
      intoDrift: telemetryIntoDrift,
      steer,
    });

    const speedTarget = targetSpeed!;
    let throttle = 0;
    let brake = 0;
    if (speed < speedTarget - ACCEPTANCE_DRIFT.throttleMargin) {
      throttle = 1;
    } else if (speed > speedTarget + ACCEPTANCE_DRIFT.brakeMargin) {
      brake = clamp(
        (speed - speedTarget - ACCEPTANCE_DRIFT.brakeMargin) *
          ACCEPTANCE_DRIFT.brakeGain,
        0,
        1,
      );
    }

    return {
      throttle,
      brake,
      steer,
      drift: driftRequested,
    };
  };
}

export interface DigitalTireDriftOptions {
  route?: Route;
  routeLength?: number;
  /** Distance before the corner body where the drift key is pressed. */
  driftLead?: number;
  /** Distance after the corner body where the drift key is released. */
  driftEndBuffer?: number;
  /** Lateral offset outside the corner before turn-in, in metres. */
  outsideLine?: number;
  /** Lateral apex offset toward the inside of the bend, in metres. */
  apexLine?: number;
  /** Extra target slip added to the curvature-derived equilibrium angle. */
  slipBiasDeg?: number;
  /** Minimum target slip while the kart is inside the corner body. */
  minSlipDeg?: number;
  /** Upper bound for the curvature-derived target slip. */
  maxSlipDeg?: number;
  /** Speed multiplier applied to the P3563 steady-drift equilibrium. */
  speedScale?: number;
  /** Speed multiplier for tight corners below 30 m radius. */
  tightSpeedScale?: number;
  /** Speed multiplier for medium corners below 50 m radius. */
  mediumSpeedScale?: number;
  /** Speed multiplier for wide corners at or above 120 m radius. */
  wideSpeedScale?: number;
  /** Upper bound for the target speed, in m/s. */
  speedCap?: number;
  /** Cross-track correction gain from metres to path yaw. */
  crossTrackGain?: number;
  /** Fraction of the corner held wide before the apex line starts. */
  lineHoldFraction?: number;
  /** Wall-repulsion gain from metres to path yaw, in degrees per metre. */
  wallAvoidGain?: number;
  /** Footprint centre kept this far inside the measured wall corridor. */
  wallMargin?: number;
  /** Additional clearance kept on the inside wall at the apex. */
  apexInset?: number;
  /** Extra yaw rate requested per radian of body-slip shortfall. */
  slipYawGain?: number;
  /** Seconds of lateral motion used for the line and wall prediction. */
  predictionSeconds?: number;
  /** Body-heading-error gain used by the yaw-rate target. */
  yawHeadingGain?: number;
  /** Velocity-course-error gain used by the yaw-rate target. */
  yawCourseGain?: number;
  /**
   * Controller shape. "torque" pulses the recovered tire model directly;
   * "slip" gives the digital steering keys explicit slip-band priority and
   * uses yaw pulses only to hold the path while slip is inside that band.
   */
  controlMode?:
    | "torque"
    | "slip"
    | "slipPursuit"
    | "pursuit"
    | "equilibrium"
    | "slipBang"
    | "yawBang"
    | "modelPredict";
  /** Slip error beyond this band selects a full countersteer/steer key. */
  slipDeadbandDeg?: number;
  /** Slip error at which the slip controller requests full steering duty. */
  slipFullDutyDeg?: number;
  /** Hysteresis half-band for the bang-bang slip controller, in degrees. */
  slipBandDeg?: number;
  /** Target-slip adjustment per metre of predicted line error. */
  slipPathGainDegPerMeter?: number;
  /**
   * Target-slip reduction per metre the kart is already inside its line.
   * This turns line error into less rotation instead of adding wall contact.
   */
  slipInsideGainDegPerMeter?: number;
  /** Maximum reduction from the inside-line feedback, in degrees. */
  slipInsideMaxDeg?: number;
  /** Maximum requested chassis yaw rate, in radians per second. */
  yawRateCap?: number;
  /** Time constant used to turn yaw-rate error into a torque demand. */
  yawResponseSeconds?: number;
  /** Duty amplification for the recovered-torque keyboard pulses. */
  yawDutyGain?: number;
  /** Centred route window used to estimate local path yaw rate, in metres. */
  pathRateWindowMeters?: number;
  /** Low-pass time constant for the route curvature feed-forward, in seconds. */
  pathRateFilterSeconds?: number;
  /** Centred window used to average coarse route heading, in metres. */
  yawSmoothingMeters?: number;
  /** Base pure-pursuit lookahead distance, in metres. */
  pursuitLookaheadBase?: number;
  /** Additional pure-pursuit lookahead per m/s. */
  pursuitLookaheadSpeed?: number;
  /** Body-yaw error gain for the pure-pursuit controller. */
  pursuitHeadingGain?: number;
  /** Velocity-course error gain for the pure-pursuit controller. */
  pursuitCourseGain?: number;
  /** Direct yaw-rate damping for the pure-pursuit controller. */
  pursuitYawDamping?: number;
  debugEvery?: number;
  /** Optional controller telemetry for calibration probes. */
  debug?: (sample: {
    time: number;
    into: number;
    lateral: number;
    lateralTarget: number;
    pathYaw: number;
    pathYawRate: number;
    desiredYawRate: number;
    yawRate: number;
    slip: number;
    targetSlip: number;
    yawTorqueDemand: number;
    steer: number;
    drift: boolean;
    speed: number;
    targetSpeed: number;
    forwardSpeed: number;
    lateralSpeed: number;
    grounded: boolean;
    y: number;
    groundHeight: number | null;
    corridorLeft: number;
    corridorRight: number;
  }) => void;
}

const DIGITAL_TIRE_DRIFT = {
  driftLead: 4,
  // KSV drift episodes include the exit phase: the player keeps the key down
  // until the kart is on the following straight instead of releasing at the
  // geometric corner end. Eight metres also makes a 20 m corner long enough to
  // meet the original 0.9 s lower quartile at racing speed.
  driftEndBuffer: 8,
  outsideLine: 5,
  apexLine: 3,
  slipBiasDeg: 0,
  minSlipDeg: 20,
  maxSlipDeg: 52,
  tightSpeedScale: 0.6,
  mediumSpeedScale: 0.7,
  speedScale: 0.85,
  // The scale multiplies the speed that sustains 45 deg of equilibrium slip.
  // 0.85 still leaves a line-following margin while keeping a wide bend out of
  // the near-zero-slip grip regime.
  wideSpeedScale: 0.85,
  speedCap: Math.sqrt(DEFAULT_TUNING.forwardAccel / DEFAULT_TUNING.dragFactor),
  speedMin: 16,
  crossTrackGain: 1.2,
  lineHoldFraction: 0.15,
  wallAvoidGain: 5,
  wallMargin: 2.2,
  apexInset: 1,
  slipYawGain: 2.5,
  predictionSeconds: 0.35,
  yawHeadingGain: 2.2,
  yawCourseGain: 1.6,
  kickSeconds: 0.2,
  slipBuildFraction: 0.72,
  slipBuildMaxSeconds: 0.65,
  slipDeadbandDeg: 4,
  slipFullDutyDeg: 12,
  slipBandDeg: 3,
  slipPathGainDegPerMeter: 1,
  slipInsideGainDegPerMeter: 1.5,
  slipInsideMaxDeg: 20,
  yawRateCap: 2.5,
  yawResponseSeconds: 0.18,
  yawDutyGain: 1,
  pathRateWindowMeters: 12,
  pathRateFilterSeconds: 0.15,
  yawSmoothingMeters: 16,
  pursuitLookaheadBase: 8,
  pursuitLookaheadSpeed: 0.7,
  pursuitHeadingGain: 1.4,
  pursuitCourseGain: 1.5,
  pursuitYawDamping: 0.3,
  torquePulseLimit: 1,
  throttleMargin: 0.4,
  brakeMargin: 0.8,
} as const;

export function digitalTireTargetSpeed(
  corner: TrackCorner,
  options: DigitalTireDriftOptions = {},
) {
  const radius = corner.length /
    Math.max(1e-6, Math.abs(corner.absoluteHeadingDegrees) * RAD);
  const scale = radius < 30
    ? options.tightSpeedScale ??
      options.speedScale ??
      DIGITAL_TIRE_DRIFT.tightSpeedScale
    : radius < 50
      ? options.mediumSpeedScale ??
        options.speedScale ??
        DIGITAL_TIRE_DRIFT.mediumSpeedScale
      : radius < 120
        ? options.speedScale ?? DIGITAL_TIRE_DRIFT.speedScale
        : options.wideSpeedScale ??
          options.speedScale ??
          DIGITAL_TIRE_DRIFT.wideSpeedScale;
  const candidate = scale * Math.sqrt(9.8 + 19.6 * radius * Math.tan(50 * RAD));
  let roadLimit = options.speedCap ?? DIGITAL_TIRE_DRIFT.speedCap;
  if (options.route) {
    const route = options.route;
    // Read changes of grade over the steering preview, not triangle noise.
    // At a crest the deck drops away at v²/R; a ballistic kart cannot follow
    // it if that exceeds suspension gravity.
    const half = DIGITAL_TIRE_DRIFT.pursuitLookaheadBase;
    const approach = Math.min(candidate, roadLimit) * (DEFAULT_TUNING.driftTrigTime + DIGITAL_TIRE_DRIFT.predictionSeconds);
    const start = corner.start - approach;
    for (let s = start; s <= corner.start + corner.length; s += half / 2) {
      const curvature = (2 * poseAt(route, s).y - poseAt(route, s - half).y - poseAt(route, s + half).y) / (half * half);
      if (curvature > 0) roadLimit = Math.min(roadLimit, Math.sqrt(9.81 / curvature));
      // The tire pair can supply at most about 2 g laterally at this grip.
      // Limit speed for the tightest steering preview, not the mean radius
      // of a bend that can include near-straight pieces.
      const turn = Math.abs(wrapAngle(smoothedYawAt(route, s + half, 2 * half) -
        smoothedYawAt(route, s - half, 2 * half))) / (2 * half);
      if (turn > 0) roadLimit = Math.min(roadLimit, Math.sqrt(2 * ORIGINAL_TIRE_GRAVITY / turn));
    }
  }
  return Math.min(Math.max(candidate, DIGITAL_TIRE_DRIFT.speedMin), roadLimit);
}

/**
 * Keyboard-realistic drift acceptance driver.
 *
 * Steering is always one of -1, 0, or +1, matching the original direction-key
 * input. The controller uses the recovered P3563 tire response as a model of
 * the next-substep yaw torque and pulse-width modulates the digital keys, so
 * it does not depend on an analog steering value the original game cannot
 * produce. The line target is expressed in track metres; wall safety remains
 * the harness's collision check rather than a calibrated force offset.
 */
export function digitalTireDriftDriver(
  options: DigitalTireDriftOptions = {},
): DriftDriver {
  const route = options.route;
  const routeLength = options.routeLength ?? 0;
  const driftLead = options.driftLead ?? DIGITAL_TIRE_DRIFT.driftLead;
  const configuredDriftEndBuffer = options.driftEndBuffer;
  const outsideLine = options.outsideLine ?? DIGITAL_TIRE_DRIFT.outsideLine;
  const apexLine = options.apexLine ?? DIGITAL_TIRE_DRIFT.apexLine;
  const slipBias =
    (options.slipBiasDeg ?? DIGITAL_TIRE_DRIFT.slipBiasDeg) * RAD;
  const minSlip =
    (options.minSlipDeg ?? DIGITAL_TIRE_DRIFT.minSlipDeg) * RAD;
  const maxSlip =
    (options.maxSlipDeg ?? DIGITAL_TIRE_DRIFT.maxSlipDeg) * RAD;
  const crossTrackGain =
    options.crossTrackGain ?? DIGITAL_TIRE_DRIFT.crossTrackGain;
  const lineHoldFraction = clamp(
    options.lineHoldFraction ?? DIGITAL_TIRE_DRIFT.lineHoldFraction,
    0,
    0.4,
  );
  const wallAvoidGain =
    options.wallAvoidGain ?? DIGITAL_TIRE_DRIFT.wallAvoidGain;
  const wallMargin =
    options.wallMargin ?? DIGITAL_TIRE_DRIFT.wallMargin;
  const apexInset =
    options.apexInset ?? DIGITAL_TIRE_DRIFT.apexInset;
  const slipYawGain =
    options.slipYawGain ?? DIGITAL_TIRE_DRIFT.slipYawGain;
  const predictionSeconds =
    options.predictionSeconds ?? DIGITAL_TIRE_DRIFT.predictionSeconds;
  const yawHeadingGain =
    options.yawHeadingGain ?? DIGITAL_TIRE_DRIFT.yawHeadingGain;
  const yawCourseGain =
    options.yawCourseGain ?? DIGITAL_TIRE_DRIFT.yawCourseGain;
  const controlMode = options.controlMode ?? "pursuit";
  const slipDeadband =
    (options.slipDeadbandDeg ?? DIGITAL_TIRE_DRIFT.slipDeadbandDeg) * RAD;
  const slipFullDuty =
    (options.slipFullDutyDeg ?? DIGITAL_TIRE_DRIFT.slipFullDutyDeg) * RAD;
  const slipBand =
    (options.slipBandDeg ?? DIGITAL_TIRE_DRIFT.slipBandDeg) * RAD;
  const slipPathGain =
    (options.slipPathGainDegPerMeter ??
      DIGITAL_TIRE_DRIFT.slipPathGainDegPerMeter) * RAD;
  const slipInsideGain =
    (options.slipInsideGainDegPerMeter ??
      DIGITAL_TIRE_DRIFT.slipInsideGainDegPerMeter) * RAD;
  const slipInsideMax =
    (options.slipInsideMaxDeg ??
      DIGITAL_TIRE_DRIFT.slipInsideMaxDeg) * RAD;
  const yawRateCap =
    options.yawRateCap ?? DIGITAL_TIRE_DRIFT.yawRateCap;
  const yawResponseSeconds =
    options.yawResponseSeconds ?? DIGITAL_TIRE_DRIFT.yawResponseSeconds;
  const yawDutyGain =
    options.yawDutyGain ?? DIGITAL_TIRE_DRIFT.yawDutyGain;
  const pathRateWindow = Math.max(
    2,
    options.pathRateWindowMeters ?? DIGITAL_TIRE_DRIFT.pathRateWindowMeters,
  );
  const pathRateFilterSeconds = Math.max(
    0,
    options.pathRateFilterSeconds ??
      DIGITAL_TIRE_DRIFT.pathRateFilterSeconds,
  );
  const yawSmoothingMeters = Math.max(
    0,
    options.yawSmoothingMeters ?? DIGITAL_TIRE_DRIFT.yawSmoothingMeters,
  );
  const pursuitLookaheadBase =
    options.pursuitLookaheadBase ??
    DIGITAL_TIRE_DRIFT.pursuitLookaheadBase;
  const pursuitLookaheadSpeed =
    options.pursuitLookaheadSpeed ??
    DIGITAL_TIRE_DRIFT.pursuitLookaheadSpeed;
  const pursuitHeadingGain =
    options.pursuitHeadingGain ??
    DIGITAL_TIRE_DRIFT.pursuitHeadingGain;
  const pursuitCourseGain =
    options.pursuitCourseGain ??
    DIGITAL_TIRE_DRIFT.pursuitCourseGain;
  const pursuitYawDamping =
    options.pursuitYawDamping ??
    DIGITAL_TIRE_DRIFT.pursuitYawDamping;
  const debug = options.debug;
  let previousTime = 0;
  let previousYaw = 0;
  let yawRate = 0;
  let driftElapsed = 0;
  let wasDrift = false;
  let resolvedDriftEndBuffer: number | null = null;
  let torquePulse = 0;
  let gripSteerPulse = 0;
  let predictiveSteer = 0;
  let controlStep = 0;
  let filteredPathYawRate = 0;
  let targetSpeed: number | undefined;
  let previousSlip = 0;
  let slipRate = 0;
  let previousCourse = 0;
  let courseRate = 0;

  return ({ state, sample, corner, time }) => {
    const dt = Math.max(0, time - previousTime);
    if (dt > 0) {
      const measured = wrapAngle(state.yaw - previousYaw) / dt;
      yawRate = yawRate * 0.8 + measured * 0.2;
    }
    previousTime = time;
    previousYaw = state.yaw;
    controlStep++;
    targetSpeed ??= Math.min(state.planarSpeed, digitalTireTargetSpeed(corner, options));

    const direction = corner.direction;
    const speed = state.planarSpeed;
    const course = sample.velocityHeading ?? state.yaw + Math.atan2(state.lateralSpeed, state.speed);
    const slip = wrapAngle(course - state.yaw);
    if (dt > 0) courseRate += (1 - Math.exp(-dt / yawResponseSeconds)) *
      (wrapAngle(course - previousCourse) / dt - courseRate);
    if (dt > 0) slipRate += (1 - Math.exp(-dt / yawResponseSeconds)) *
      (wrapAngle(slip - previousSlip) / dt - slipRate);
    previousSlip = slip;
    previousCourse = course;
    const into = routeLength > 0
      ? signedDelta(corner.start, sample.s, routeLength)
      : sample.s - corner.start;
    const pastEnd = routeLength > 0
      ? signedDelta(corner.end, sample.s, routeLength)
      : sample.s - corner.end;
    // Keep the drift through the corner body, then release as soon as the
    // origin's 0.9 s lower-quartile episode length is satisfied. A fixed 8 m
    // tail over-drove long corners into the exit wall.
    // Resolve the release distance once from the entry speed. Recomputing it
    // from the live speed makes it move while the kart slows, which toggles
    // the drift key and restarts the sustained-drift timer mid-corner.
    resolvedDriftEndBuffer ??= configuredDriftEndBuffer ?? clamp(
      0.9 * Math.max(speed, DIGITAL_TIRE_DRIFT.speedMin) -
        corner.length + 1.0,
      1.5,
      12,
    );
    const driftEndBuffer = resolvedDriftEndBuffer;
    const drift = into >= -driftLead && pastEnd <= driftEndBuffer;
    if (drift && !wasDrift) {
      driftElapsed = 0;
      filteredPathYawRate = 0;
    }
    if (drift) driftElapsed += dt;
    wasDrift = drift;

    const pose = route
      ? poseAt(route, sample.s)
      : { x: state.x, z: state.z, yaw: sample.yaw, segment: -1 } as const;
    const pathYawSmooth = route
      ? smoothedYawAt(route, sample.s, yawSmoothingMeters)
      : pose.yaw;
    const radius = corner.length /
      Math.max(1e-6, Math.abs(corner.absoluteHeadingDegrees) * RAD);
    const lookahead = clamp(pursuitLookaheadBase + speed * pursuitLookaheadSpeed, 10, 28);
    const corridorLeft = sample.corridorLeft ?? -(route?.halfWidth ?? 20);
    const corridorRight = sample.corridorRight ?? (route?.halfWidth ?? 20);
    const safeLeft = corridorLeft + wallMargin;
    const safeRight = corridorRight - wallMargin;
    // The offset a chord cuts inside a circular bend limits how far the line
    // moves during one steering preview. Measure the footprint corridor at the
    // target station, so narrowing bridge decks influence steering in advance.
    const sagitta = radius - Math.sqrt(Math.max(0, radius ** 2 - (lookahead / 2) ** 2));
    const targetLineAt = (s: number, left: number, right: number) => {
      const station = routeLength > 0 ? signedDelta(corner.start, s, routeLength) : s - corner.start;
      const t = clamp(station / corner.length, 0, 1);
      const phase = clamp((t - lineHoldFraction) / (1 - 2 * lineHoldFraction), 0, 1);
      const shape = Math.sin(Math.PI * phase);
      const center = (left + right) / 2;
      const room = Math.max(0, (right - left) / 2 - wallMargin - apexInset);
      const outside = Math.min(room, outsideLine, sagitta);
      const apex = Math.min(room, apexLine, sagitta);
      const recovery = clamp(1 - Math.max(0, station - corner.length) / lookahead, 0, 1);
      return center + recovery * direction * (apex * shape - outside * (1 - shape));
    };
    const lateralTarget = targetLineAt(sample.s, corridorLeft, corridorRight);
    const velocityX = speed * Math.sin(course);
    const velocityZ = speed * Math.cos(course);
    const pathRightX = Math.cos(pathYawSmooth);
    const pathRightZ = -Math.sin(pathYawSmooth);
    const lateralVelocity =
      velocityX * pathRightX + velocityZ * pathRightZ;
    const predictedLateral =
      sample.lateral + lateralVelocity * predictionSeconds;
    const lateralError = predictedLateral - lateralTarget;
    const leftRoom = sample.lateral - safeLeft;
    const rightRoom = safeRight - sample.lateral;
    const wallCorrection =
      (leftRoom < 2 ? (2 - leftRoom) * wallAvoidGain * RAD : 0) -
      (rightRoom < 2 ? (2 - rightRoom) * wallAvoidGain * RAD : 0);
    const pathYaw = pathYawSmooth + clamp(
      -lateralError * crossTrackGain * RAD + wallCorrection,
      -45 * RAD,
      45 * RAD,
    );

    const curvatureSlip = Math.atan(
      Math.max(
        0,
        speed * speed / (ORIGINAL_TIRE_GRAVITY * radius) -
          DEFAULT_TUNING.maxSteerDeg * RAD,
      ) / 2,
    );
    let targetSlip = clamp(curvatureSlip + slipBias, 0, maxSlip);
    if (into >= 0 && into <= corner.length) {
      targetSlip = Math.max(targetSlip, minSlip);
    }
    if (into > corner.length - 6) {
      targetSlip *= clamp((corner.length + 4 - into) / 10, 0, 1);
    }
    if (into < 0) {
      targetSlip *= clamp((into + driftLead) / driftLead, 0, 1);
    }
    if (pastEnd > 0) {
      targetSlip *= clamp(1 - pastEnd / 6, 0, 1);
    }
    if (!drift) targetSlip = 0;
    if (drift) targetSlip *= clamp(driftElapsed / 0.35, 0, 1);
    const insideLineError = Math.max(
      0,
      direction * (sample.lateral - lateralTarget),
    );
    targetSlip = Math.max(
      0,
      targetSlip -
        Math.min(insideLineError * slipInsideGain, slipInsideMax),
    );
    // The corner's average radius is a poor feed-forward on long, varying
    // bends. Use the local route tangent derivative at the current progress;
    // that is the curvature the kart actually has to follow.
    const rawPathYawRate = route && into >= 0 && into <= corner.length
      ? wrapAngle(
          smoothedYawAt(
            route,
            sample.s + pathRateWindow / 2,
            yawSmoothingMeters,
          ) -
          smoothedYawAt(
            route,
            sample.s - pathRateWindow / 2,
            yawSmoothingMeters,
          ),
        ) * speed / pathRateWindow
      : into >= 0 && into <= corner.length
        ? direction * speed / radius
        : 0;
    const pathRateBlend = pathRateFilterSeconds <= 0 || dt <= 0
      ? 1
      : 1 - Math.exp(-dt / pathRateFilterSeconds);
    filteredPathYawRate +=
      (rawPathYawRate - filteredPathYawRate) * pathRateBlend;
    const pathYawRate = filteredPathYawRate;
    const desiredBodyYaw = pathYaw + direction * targetSlip;
    const headingError = wrapAngle(desiredBodyYaw - state.yaw);
    const courseError = wrapAngle(pathYaw - (state.yaw + slip));
    const slipShortfall =
      Math.abs(targetSlip) - Math.abs(slip);
    let desiredYawRate = clamp(
      pathYawRate +
        headingError * yawHeadingGain +
        courseError * yawCourseGain +
        direction * slipShortfall * slipYawGain,
      -yawRateCap,
      yawRateCap,
    );
    if (controlMode === "pursuit" && route && drift) {
      const futureS = sample.s + lookahead;
      const targetPose = poseAt(route, futureS);
      const future = sample.corridorAt?.(futureS);
      const targetLateral = targetLineAt(futureS, future?.left ?? corridorLeft, future?.right ?? corridorRight);
      const targetRightX = Math.cos(targetPose.yaw);
      const targetRightZ = -Math.sin(targetPose.yaw);
      const targetX = targetPose.x + targetRightX * targetLateral;
      const targetZ = targetPose.z + targetRightZ * targetLateral;
      const desiredCourse = Math.atan2(
        targetX - state.x,
        targetZ - state.z,
      );
      // Pure pursuit sets the curvature of the chord from the current velocity
      // vector to the preview point. Track its *measured course rate*, not a
      // guessed body slip angle: grade, throttle and bank all change tire load.
      const chord = Math.hypot(targetX - state.x, targetZ - state.z);
      const courseDemand = 2 * speed * Math.sin(wrapAngle(desiredCourse - course)) / Math.max(1, chord);
      const trackingRate = clamp(courseDemand + (courseDemand - courseRate) * speed /
        (2 * ORIGINAL_TIRE_GRAVITY * predictionSeconds), -yawRateCap, yawRateCap);
      // Use course acceleration feedback where there is less than a preview
      // distance across the road. In open space, body/yaw feedback also damps
      // rotation in preparation for release onto the exit straight.
      const roadWidth = (future?.right ?? corridorRight) - (future?.left ?? corridorLeft);
      const tight = clamp(1 - roadWidth / lookahead, 0, 1);
      const baseRate = clamp(pathYawRate + wrapAngle(desiredCourse + direction * targetSlip - state.yaw) * pursuitHeadingGain +
        wrapAngle(desiredCourse - course) * pursuitCourseGain - state.yawRate * pursuitYawDamping, -yawRateCap, yawRateCap);
      desiredYawRate = baseRate + tight * (trackingRate - baseRate);
    }
    if (controlMode === "equilibrium" && drift) {
      // A steady drift only needs the path curvature feed-forward plus small
      // corrections. Large heading gains turn into limit-cycle weaving because
      // the digital steering key has full-lock authority.
      const feedForwardRate = into >= 0 && into <= corner.length
        ? direction * speed / radius
        : 0;
      desiredYawRate = clamp(
        feedForwardRate +
          headingError * 0.45 +
          courseError * 0.2 +
          direction * slipShortfall * 0.35,
        -yawRateCap,
        yawRateCap,
      );
    }

    const config = {
      mass: DEFAULT_TUNING.mass,
      maxSteerDegrees: DEFAULT_TUNING.maxSteerDeg,
      steerConstraint: DEFAULT_TUNING.steerConstraint,
      frontGripFactor: DEFAULT_TUNING.frontGripFactor,
      rearGripFactor: DEFAULT_TUNING.rearGripFactor,
      driftTriggerFactor: DEFAULT_TUNING.driftTriggerFactor,
      driftSlipFactor: DEFAULT_TUNING.driftSlipFactor,
      cornerDrawFactor: DEFAULT_TUNING.cornerDrawFactor,
      driftLeanFactor: DEFAULT_TUNING.driftLeanFactor,
      steerLeanFactor: DEFAULT_TUNING.steerLeanFactor,
      heldDriftSteer: DEFAULT_TUNING.heldDriftSteer,
    } as const;
    const responseMode = state.driftPhase === "none"
      ? "grip" as const
      : "drift" as const;
    const response = (candidate: number) =>
      computeOriginalLateralResponse(config, {
        forwardVelocity: state.speed,
        lateralVelocity: state.lateralSpeed,
        yawRate: state.yawRate,
        steeringInput: candidate,
        forwardInput: 1,
        driftInputActive: drift && state.driftPhase !== "none",
        mode: responseMode,
      });

    let steer = 0;
    const building =
      drift &&
      (driftElapsed < DIGITAL_TIRE_DRIFT.kickSeconds ||
        (Math.abs(slip) <
          targetSlip * DIGITAL_TIRE_DRIFT.slipBuildFraction &&
          driftElapsed < DIGITAL_TIRE_DRIFT.slipBuildMaxSeconds));
    if (building) {
      steer = direction;
      torquePulse = 0;
    } else if (drift && controlMode === "modelPredict") {
      const horizon = 0.08;
      let bestSteer = predictiveSteer;
      let bestScore = Number.POSITIVE_INFINITY;
      for (const candidate of [-1, 0, 1]) {
        const yawAcceleration =
          response(candidate).yawTorque *
          (12 / DEFAULT_TUNING.mass);
        const predicted =
          state.yawRate + yawAcceleration * horizon;
        const switchingPenalty =
          candidate === predictiveSteer ? 0 : 0.04;
        const score =
          Math.abs(predicted - desiredYawRate) + switchingPenalty;
        if (score < bestScore) {
          bestScore = score;
          bestSteer = candidate;
        }
      }
      steer = bestSteer;
      predictiveSteer = steer;
      torquePulse = 0;
    } else if (drift && controlMode === "yawBang") {
      const tolerance = 6 * RAD;
      if (state.yawRate < desiredYawRate - tolerance) {
        steer = direction;
      } else if (state.yawRate > desiredYawRate + tolerance) {
        steer = -direction;
      } else {
        steer = 0;
      }
      torquePulse = 0;
    } else if (drift && controlMode === "slipBang") {
      const pathTarget = clamp(
        targetSlip + lateralError * slipPathGain,
        12 * RAD,
        60 * RAD,
      );
      if (Math.abs(slip) < pathTarget - slipBand) {
        steer = direction;
        torquePulse = 0;
      } else if (Math.abs(slip) > pathTarget + slipBand) {
        steer = -direction;
        torquePulse = 0;
      } else {
        steer = 0;
        torquePulse = 0;
      }
    } else if (drift && controlMode === "slip") {
      const pathTarget = clamp(
        targetSlip + lateralError * slipPathGain,
        12 * RAD,
        60 * RAD,
      );
      const slipError = pathTarget - Math.abs(slip);
      const desiredAcceleration =
        (desiredYawRate - state.yawRate) /
        yawResponseSeconds;
      const desiredTorque =
        desiredAcceleration * DEFAULT_TUNING.mass / 12;
      const torques = [-1, 0, 1].map(candidate =>
        response(candidate).yawTorque);
      const neutralTorque = torques[1];
      const pullTorque = direction > 0 ? torques[2] : torques[0];
      const span = pullTorque - neutralTorque;
      const yawDuty = Math.abs(span) > 1e-6
        ? clamp((desiredTorque - neutralTorque) / span, -1, 1)
        : 0;
      const slipDuty = Math.abs(slipError) > slipDeadband
        ? clamp(slipError / slipFullDuty, -1, 1)
        : 0;
      const duty = clamp(slipDuty + yawDuty * 0.35, -1, 1);
      torquePulse += duty;
      if (torquePulse >= 0.5) {
        steer = direction;
        torquePulse -= 1;
      } else if (torquePulse <= -0.5) {
        steer = -direction;
        torquePulse += 1;
      }
    } else if (drift) {
      const desiredAcceleration =
        (desiredYawRate - state.yawRate) /
        yawResponseSeconds;
      const desiredTorque =
        desiredAcceleration * DEFAULT_TUNING.mass / 12;
      const torques = [-1, 0, 1].map(candidate =>
        response(candidate).yawTorque);
      const neutralTorque = torques[1];
      const pullTorque = direction > 0 ? torques[2] : torques[0];
      const span = pullTorque - neutralTorque;
      const duty = Math.abs(span) > 1e-6
        ? clamp((desiredTorque - neutralTorque) / span, -1, 1)
        : 0;
      torquePulse += clamp(duty * yawDutyGain, -1, 1);
      if (torquePulse >= 0.5) {
        steer = direction > 0 ? 1 : -1;
        torquePulse -= 1;
      } else if (torquePulse <= -0.5) {
        steer = direction > 0 ? -1 : 1;
        torquePulse += 1;
      }
    } else {
      const gripTargetYaw = pathYaw -
        Math.sign(slip) * Math.min(Math.abs(slip), 35 * RAD) * 0.15;
      const headingError = wrapAngle(gripTargetYaw - state.yaw);
      const duty = clamp(headingError * 2.4 - state.yawRate * 0.5 + slip * 1.2, -1, 1);
      gripSteerPulse += duty;
      steer = gripSteerPulse >= 0.5 ? 1 : gripSteerPulse <= -0.5 ? -1 : 0;
      gripSteerPulse -= steer;
    }
    if (drift && controlMode === "slipPursuit") {
      const pathTarget = clamp(
        targetSlip + lateralError * slipPathGain,
        10 * RAD,
        60 * RAD,
      );
      if (Math.abs(slip) < pathTarget - slipBand) {
        steer = direction;
        torquePulse = 0;
      } else if (Math.abs(slip) > pathTarget + slipBand) {
        steer = -direction;
        torquePulse = 0;
      }
    }
    steer = clamp(steer, -1, 1);

    if (debug && controlStep % (options.debugEvery ?? 10) === 0) {
      debug({
        time,
        into,
        lateral: sample.lateral,
        lateralTarget,
        pathYaw,
        pathYawRate,
        desiredYawRate,
        yawRate,
        slip,
        targetSlip,
        targetSpeed,
        yawTorqueDemand: 0,
        steer,
        drift,
        speed,
        forwardSpeed: state.speed,
        lateralSpeed: state.lateralSpeed,
        grounded: state.suspension?.grounded ?? true,
        y: state.y,
        groundHeight: state.suspension?.surfaceHeight ?? null,
        corridorLeft,
        corridorRight,
      });
    }

    const speedTarget = targetSpeed;
    let throttle = 0;
    let brake = 0;
    // A speed governor alone brakes on a descent even as all the remaining
    // motion becomes sideways. If the velocity vector will cross the rear
    // half-plane within the controller preview + yaw response time, drive
    // the rear axle instead. Keep steering toward the road, not a slip target.
    const projectedSlip = slip + slipRate * (predictionSeconds + yawResponseSeconds);
    const losingForwardTravel = drift && slip * slipRate > 0 && Math.abs(projectedSlip) >= Math.PI / 2;
    if (losingForwardTravel || speed < speedTarget - DIGITAL_TIRE_DRIFT.throttleMargin) {
      throttle = 1;
    } else if (speed > speedTarget + DIGITAL_TIRE_DRIFT.brakeMargin) {
      brake = 1;
    }

    return {
      throttle,
      brake,
      steer,
      drift,
    };
  };
}
