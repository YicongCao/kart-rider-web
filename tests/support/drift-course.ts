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
import { TrackCollision } from "../../src/game/track-collision";
import {
  KartVehicle,
  type VehicleInput,
  type VehicleState,
} from "../../src/game/vehicle";
import type { RouteData } from "../../src/types";

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

/** Length below which an extracted section is treated as a route artefact. */
export const MIN_DRIFT_CORNER_LENGTH = 20;

export const DRIFT_ACCEPTANCE = {
  minCoverage: 0.8,
  maxCoverageGap: 0.25,
  minDriftSeconds: 0.9,
  maxExitHeadingErrorDeg: 30,
  minMedianSideSlipDeg: 20,
  maxMedianSideSlipDeg: 70,
  minSpeedRetention: 0.75,
  maxSpeedRetention: 1.2,
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
  /** Fixed simulation step, in seconds. */
  step?: number;
  /** Wall-clock simulation limit for a single corner. */
  maxDuration?: number;
  /** Continue measuring for this distance after the corner body. */
  finishBuffer?: number;
  /** Temporary physics overrides for calibration probes. */
  tuning?: Partial<import("../../src/game/vehicle").VehicleTuning>;
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
  samples: DriftTelemetrySample[];
  analysis: CornerDriftResult;
  collisions: number;
  collisionDetail: string;
  offroad: boolean;
  offroadDetail: string;
  reversed: boolean;
  reverseDetail: string;
  timedOut: boolean;
  reachedExit: boolean;
  /** Heading error at the end of the telemetry window (corner end + 20 m). */
  exitHeadingErrorDeg: number | null;
  /** Heading error where the kart crosses the corner body's end. */
  cornerEndHeadingErrorDeg: number | null;
  finalHeadingErrorDeg: number;
  maxLateral: number;
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

export interface AcceptanceDriftDriverOptions {
  /** Route geometry used for lookahead and cross-track correction. */
  route?: Route;
  /** Absolute route length, so the driver can resolve s=0 crossings. */
  routeLength?: number;
  /** Distance before the corner body where drift input starts. */
  driftLead?: number;
  /** Peak line offset toward the inside of the bend, in metres. */
  insideOffset?: number;
  /** Initial full-lock phase before the line controller takes over. */
  kickSeconds?: number;
  /** Maximum body slip requested by the line controller, in degrees. */
  slipTargetDeg?: number;
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
  return {
    grip: track === "desert" ? 0.94 : track === "forest" ? 0.97 : 1,
    drag: 1,
    acceleration: 1,
    driftGauge: 1,
  };
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

export function defaultCornerSpeed(corner: TrackCorner) {
  const heading = Math.max(0.1, Math.abs(corner.headingDegrees) * RAD);
  const radius = corner.length / heading;
  return clamp(radius * 0.85, 15, 17);
}

function sideSlipDegrees(sample: DriftTelemetrySample) {
  return Math.abs(Math.atan2(
    sample.lateralSpeed,
    Math.max(0.1, Math.abs(sample.speed)),
  ) * DEG);
}

/**
 * Run one corner from a fixed 25 m approach with a 100 Hz controller cadence.
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
  let approach = options.approach ?? 25;
  const step = options.step ?? 0.01;
  const maxDuration = options.maxDuration ?? 40;
  const finishBuffer = options.finishBuffer ?? 20;
  const startOutside = options.startOutside ?? 2.5;
  const initialSpeed = options.initialSpeed ?? defaultCornerSpeed(corner);
  let startS = positiveModulo(corner.start - approach, route.length);
  let startPose = poseAt(route, startS);
  let startY: number | null = collision.groundHeight(
    startPose.x,
    startPose.y,
    startPose.z,
  );
  while (startY === null && approach > 6) {
    approach -= 1;
    startS = positiveModulo(corner.start - approach, route.length);
    startPose = poseAt(route, startS);
    startY = collision.groundHeight(startPose.x, startPose.y, startPose.z);
  }
  const finishS = positiveModulo(corner.start - approach + corner.length + finishBuffer,
    route.length);
  const routeRightX = -Math.cos(startPose.yaw);
  const routeRightZ = Math.sin(startPose.yaw);
  const startLateral = corner.direction * startOutside;
  const startX = startPose.x + routeRightX * startLateral;
  const startZ = startPose.z + routeRightZ * startLateral;
  const resolvedStartY = collision.groundHeight(
    startX,
    startPose.y,
    startZ,
  ) ?? startY ?? startPose.y;

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
  const initialQuery = route.query(kart.state.x, kart.state.z, startPose.segment, kart.state.y);
  const samples: DriftTelemetrySample[] = [{
    t: kart.state.time,
    s: initialQuery.s,
    yaw: kart.state.yaw,
    speed: kart.state.speed,
    lateralSpeed: kart.state.lateralSpeed,
    drifting: kart.state.drifting,
  }];

  let hint = initialQuery.segment;
  let collisions = 0;
  let collisionDetail = "";
  let offroad = false;
  let offroadDetail = "";
  let reversed = false;
  let reverseDetail = "";
  let timedOut = false;
  let reachedExit = false;
  let cornerEndHeadingErrorDeg: number | null = null;
  let finalHeadingErrorDeg = 0;
  let maxLateral = 0;
  let cornerEntrySpeed: number | null = null;
  let cornerExitSpeed: number | null = null;
  let enteredCorner = false;
  let driftInputStartS: number | null = null;
  let driftInputStartTime: number | null = null;
  let driftInputLeadMeters: number | null = null;
  let driftInputActiveAtCornerStart: boolean | null = null;
  let finished = false;

  const maxFrames = Math.ceil(maxDuration / step);
  for (let frame = 0; frame < maxFrames; frame++) {
    const state = kart.state;
    const before = route.query(state.x, state.z, hint, state.y);
    hint = before.segment;
    const into = signedDelta(startS, before.s, route.length);
    const routeYaw = Math.atan2(before.forward[0], before.forward[2]);
    const input = driver({
      state,
      sample: { s: before.s, lateral: before.lateral, yaw: routeYaw },
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
    const sample = route.query(kart.state.x, kart.state.z, hint, kart.state.y);
    hint = sample.segment;
    const speed = Math.hypot(kart.state.speed, kart.state.lateralSpeed);
    const afterInto = signedDelta(startS, sample.s, route.length);
    const sampleYaw = Math.atan2(sample.forward[0], sample.forward[2]);

    samples.push({
      t: kart.state.time,
      s: sample.s,
      yaw: kart.state.yaw,
      speed: kart.state.speed,
      lateralSpeed: kart.state.lateralSpeed,
      drifting: kart.state.drifting,
    });
    maxLateral = Math.max(maxLateral, Math.abs(sample.lateral));
    finalHeadingErrorDeg = Math.abs(wrapAngle(kart.state.yaw - sampleYaw) * DEG);

    if (!enteredCorner && afterInto >= cornerStartOffset) {
      enteredCorner = true;
      cornerEntrySpeed = speed;
    }
    if (!reachedExit && afterInto >= cornerEndOffset) {
      reachedExit = true;
      cornerExitSpeed = speed;
      const endPose = poseAt(route, corner.end);
      cornerEndHeadingErrorDeg = Math.abs(
        wrapAngle(kart.state.yaw - endPose.yaw) * DEG,
      );
    }

    if (next.collisionCount > previousCollisionCount) {
      collisions = next.collisionCount;
      collisionDetail =
        `s=${sample.s.toFixed(1)} lateral=${sample.lateral.toFixed(2)} ` +
        `impact=${next.impactSpeed.toFixed(2)} drifting=${next.drifting}`;
      break;
    }
    if (Math.abs(sample.lateral) > route.halfWidth) {
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
    if (afterInto >= finishOffset) {
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
    minDriftSeconds: DRIFT_ACCEPTANCE.minDriftSeconds,
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
  const exitHeadingErrorDeg = finalHeadingErrorDeg;

  const failures: string[] = [];
  if (collisions > 0) failures.push(`collision (${collisionDetail})`);
  if (offroad) failures.push(`offroad (${offroadDetail})`);
  if (reversed) failures.push(`reverse (${reverseDetail})`);
  if (timedOut) failures.push(`timeout (${kart.state.time.toFixed(2)}s)`);
  if (!reachedExit) {
    failures.push("did not reach corner exit");
  } else if (
    exitHeadingErrorDeg > DRIFT_ACCEPTANCE.maxExitHeadingErrorDeg
  ) {
    failures.push(
      `exit heading error ${exitHeadingErrorDeg.toFixed(1)}deg > ` +
      `${DRIFT_ACCEPTANCE.maxExitHeadingErrorDeg}deg`,
    );
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
    collisionDetail,
    offroad,
    offroadDetail,
    reversed,
    reverseDetail,
    timedOut,
    reachedExit,
    exitHeadingErrorDeg,
    cornerEndHeadingErrorDeg,
    finalHeadingErrorDeg,
    maxLateral,
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
    const driver = driverFactory({
      track,
      corner,
      route,
      routeLength: route.length,
    });
    runs.push(await runCornerDrift(track, corner, driver, options));
  }

  const failureReasons: Record<string, number> = {};
  for (const run of runs) {
    for (const reason of run.failures) {
      const key = reason.split(" ")[0];
      failureReasons[key] = (failureReasons[key] ?? 0) + 1;
    }
  }
  const summary: TrackDriftSummary = {
    corners: runs.length,
    passed: runs.filter(run => run.failures.length === 0).length,
    failed: runs.filter(run => run.failures.length > 0).length,
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
  speedMin: 15,
  speedCap: 17,
  radiusRate: 0.85,
  driftLead: 5,
  driftTail: 8,
  slipTaperTail: 3,
  kickSeconds: 0.3,
  kickSteer: 1,
  slipTargetDeg: 45,
  slipMinDeg: 30,
  slipCurvatureGain: 0.3,
  slipCurvatureOffsetDeg: 12,
  slipRampSeconds: 0.5,
  slipExitTaperDistance: 8,
  slipExitTargetDeg: 8,
  insideOffset: 2,
  lookaheadRadiusWindow: 18,
  lookaheadRadiusScale: 0.55,
  lookaheadMin: 8,
  lookaheadMax: 11,
  crossTrackGainDeg: 0.8,
  crossTrackMaxDeg: 16,
  pursuitBearingLimitDeg: 12,
  yawHeadingGain: 1.6,
  yawCourseGain: 0.9,
  slipGain: 0.1,
  yawRateCapDeg: 84,
  yawRateCapGain: 0.06,
  releaseCounterSeconds: 0.35,
  releaseCounterSteer: 0.35,
  releaseSlipGain: 1.2,
  gripHeadingGain: 2.4,
  gripYawRateGain: 0.5,
  minSteer: 0.07,
  throttleMargin: 0.35,
  brakeMargin: 0.75,
  brakeGain: 1,
} as const;

function targetDriftSpeed(corner: TrackCorner) {
  const heading = Math.max(0.1, corner.absoluteHeadingDegrees * RAD);
  const radius = corner.length / heading;
  return clamp(
    radius * ACCEPTANCE_DRIFT.radiusRate,
    ACCEPTANCE_DRIFT.speedMin,
    ACCEPTANCE_DRIFT.speedCap,
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
  const driftTail = ACCEPTANCE_DRIFT.driftTail;
  const kickSeconds = options.kickSeconds ?? ACCEPTANCE_DRIFT.kickSeconds;
  const slipTarget = (options.slipTargetDeg ?? ACCEPTANCE_DRIFT.slipTargetDeg) * RAD;
  const driftEndBuffer = options.driftEndBuffer ?? driftTail;
  const slipTaperTail = options.slipTaperTail ?? ACCEPTANCE_DRIFT.slipTaperTail;
  const gripHeadingGain =
    options.gripHeadingGain ?? ACCEPTANCE_DRIFT.gripHeadingGain;
  const gripYawRateGain =
    options.gripYawRateGain ?? ACCEPTANCE_DRIFT.gripYawRateGain;
  const releaseCounterSteer =
    options.releaseCounterSteer ?? ACCEPTANCE_DRIFT.releaseCounterSteer;
  const insideOffset = options.insideOffset ?? ACCEPTANCE_DRIFT.insideOffset;
  let kickStart: number | null = null;
  let releasedAt = -Infinity;
  let releaseDirection = 0;
  let targetSpeed: number | null = null;
  let previousTime = 0;
  let previousYaw = 0;
  let yawRate = 0;
  let driftElapsed = 0;
  let wasDriftRequested = false;

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
    targetSpeed ??= targetDriftSpeed(corner);
    const into = routeLength > 0
      ? signedDelta(corner.start, sample.s, routeLength)
      : sample.s - corner.start;
    const pastEnd = routeLength > 0
      ? signedDelta(corner.end, sample.s, routeLength)
      : sample.s - corner.end;
    const driftRequested = into >= -driftLead && pastEnd <= driftEndBuffer;
    if (driftRequested && !wasDriftRequested) {
      driftElapsed = 0;
    }
    if (driftRequested) {
      if (kickStart === null) kickStart = time;
      driftElapsed += frameDt;
    } else if (wasDriftRequested) {
      releasedAt = time;
      releaseDirection = corner.direction;
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
    const pathAhead = route
      ? poseAt(route, sample.s + 12)
      : pose;
    const pathYawRate =
      speed * wrapAngle(pathAhead.yaw - pose.yaw) / 12;
    const lookTarget = route
      ? poseAt(route, sample.s + clamp(
        8 + speed * 0.35,
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
    const lateralTarget = -corner.direction * insideOffset * lineShape;
    pathYaw += clamp(
      (sample.lateral - lateralTarget) *
        ACCEPTANCE_DRIFT.crossTrackGainDeg * RAD,
      -ACCEPTANCE_DRIFT.crossTrackMaxDeg * RAD,
      ACCEPTANCE_DRIFT.crossTrackMaxDeg * RAD,
    );

    let steer: number;
    if (driftRequested && kickStart !== null &&
        time - kickStart < kickSeconds) {
      steer = direction * ACCEPTANCE_DRIFT.kickSteer;
    } else if (driftRequested) {
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
        ACCEPTANCE_DRIFT.slipMinDeg,
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
        desiredYawRate * direction / speedFactor;
      let intoDrift = yawDemand >= 0.82
        ? (yawDemand - 0.82) / 0.62
        : (yawDemand - 0.82) / 1.5;
      intoDrift += (Math.abs(targetSlip) - Math.abs(slip)) *
        ACCEPTANCE_DRIFT.slipGain;
      intoDrift = clamp(intoDrift, -1, 1);
      steer = direction * intoDrift;
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
        Math.abs(steer) < ACCEPTANCE_DRIFT.minSteer) {
      steer = direction * ACCEPTANCE_DRIFT.minSteer;
    }
    steer = clamp(steer, -1, 1);

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
