import { readFileSync } from "node:fs";
import type {
  DriftEpisode,
  DriftTelemetrySample,
} from "../../src/game/drift-analysis";

export interface DriftPercentiles {
  p10: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  p90: number | null;
}

export interface DriftDistributions {
  duration: DriftPercentiles;
  retention: DriftPercentiles;
  yawRate: DriftPercentiles;
  sideSlip: DriftPercentiles;
  sideSlipMax: DriftPercentiles;
}

export interface DriftCorpusReference extends DriftDistributions {
  trackCount: number;
  replayCount: number;
  playerRecordCount: number;
  episodeCount: number;
}

export interface DriftTrackReference extends DriftDistributions {
  replayCount: number;
  playerRecordCount: number;
  episodeCount: number;
}

export interface PathCornerTrackReference {
  cornerCount: number;
  driftedCornerCount: number;
  driftedFraction: number;
  medianCoverage: number;
}

export interface PathCornerReference {
  cornerCount: number;
  coverageThreshold: number;
  driftedCornerCount: number;
  driftedFraction: number;
  medianCoverage: number;
  tracks: Record<string, PathCornerTrackReference>;
}

export interface RepresentativeDriftEpisode {
  duration: number;
  retention: number;
  yawRate: number;
  sideSlip: number;
  sideSlipMax: number;
}

export interface DriftReferenceMethod {
  sampleRateHz: number;
  driftEffects: number[];
  maxDropoutSeconds: number;
  minDurationSeconds: number;
  speedWindowFrames: number;
  sideSlipSpeedFloor: number;
  yawRate: string;
  sideSlip: string;
  retention: string;
  speedUnits: string;
  percentiles: string;
  episodeSampling: string;
  pathCornerDetection: {
    basis: string;
    segmentation: string;
    coverage: string;
    sampleStep: number;
    straightMinLength: number;
    minTurnDegrees: number;
    minLength: number;
    coverageThreshold: number;
    jumpSplit: string;
  };
}

/**
 * Compact summary of original KSV replays.
 *
 * The corpus distributions span all tracks and must not be read as a Web
 * same-track result. `pathCorners` holds original per-replay racing-line
 * statistics, not corner coordinates that can be mapped onto a Web route.
 */
export interface DriftReference {
  schemaVersion: number;
  method: DriftReferenceMethod;
  units: Record<string, string>;
  corpus: DriftCorpusReference;
  tracks: Record<string, DriftTrackReference>;
  pathCorners: PathCornerReference;
  representativeEpisodes: RepresentativeDriftEpisode[];
}

export interface WebDriftEpisode {
  duration: number;
  speedRetention: number;
  yawRateDegreesPerSecond: number;
  medianSideSlipDegrees: number;
}

export interface WebDriftEpisodes {
  episodes: readonly WebDriftEpisode[];
}

export interface DriftComparisonOptions {
  /** Restrict the comparison to the metrics that share a measurement basis. */
  metrics?: readonly DriftMetricName[];
}

export type DriftMetricName =
  | "duration"
  | "speedRetention"
  | "yawRateDegreesPerSecond"
  | "medianSideSlipDegrees";

export interface DriftAcceptanceBand {
  min: number;
  max: number;
}

export interface DriftMetricCheck {
  metric: DriftMetricName;
  referenceKey: keyof DriftDistributions;
  unit: "seconds" | "ratio" | "degrees/second" | "degrees";
  webMedian: number | null;
  reference: {
    p25: number | null;
    p50: number | null;
    p75: number | null;
  };
  acceptanceBand: DriftAcceptanceBand;
  withinAcceptance: boolean;
  withinReferenceIqr: boolean | null;
  deviationFromReferenceMedian: {
    absolute: number | null;
    percent: number | null;
    direction: "below" | "above" | "equal" | "unknown";
  };
  pass: boolean;
  failures: string[];
}

export interface DriftDistributionComparison {
  episodeCount: number;
  passed: boolean;
  checks: DriftMetricCheck[];
  webMedians: {
    duration: number | null;
    speedRetention: number | null;
    yawRateDegreesPerSecond: number | null;
    medianSideSlipDegrees: number | null;
  };
  referenceIqrHits: number;
  failures: string[];
}

export const DRIFT_ACCEPTANCE_BANDS: Record<
  DriftMetricName,
  DriftAcceptanceBand
> = {
  duration: { min: 0.9, max: 2.3 },
  speedRetention: { min: 0.8, max: 1.15 },
  yawRateDegreesPerSecond: { min: 25, max: 100 },
  medianSideSlipDegrees: { min: 25, max: 70 },
};

const FIXTURE_URL = new URL(
  "../fixtures/drift-reference.json",
  import.meta.url,
);

export function loadDriftReference(
  fixture: string | URL = FIXTURE_URL,
): DriftReference {
  return JSON.parse(readFileSync(fixture, "utf8")) as DriftReference;
}

/** Linear interpolation between closest ranks, matching the fixture method. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  if (!Number.isFinite(p)) {
    throw new RangeError(`percentile fraction must be finite, got ${p}`);
  }
  const fraction = Math.min(1, Math.max(0, p));
  const ordered = [...values].sort((a, b) => a - b);
  const position = (ordered.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower];
  const blend = position - lower;
  return ordered[lower] * (1 - blend) + ordered[upper] * blend;
}

export function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}

const DEGREES = 180 / Math.PI;
const REFERENCE_SPEED_EDGE_SECONDS = 0.2;
const ALL_DRIFT_METRICS: readonly DriftMetricName[] = [
  "duration",
  "speedRetention",
  "yawRateDegreesPerSecond",
  "medianSideSlipDegrees",
];

function wrapAngle(angle: number) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function planarSpeed(sample: DriftTelemetrySample) {
  return Math.hypot(sample.speed, sample.lateralSpeed);
}

/**
 * Measure the first reference-duration window of each sustained Web drift.
 *
 * The corner test intentionally holds Shift through the whole corner, so a
 * long bend produces a much longer episode than the KSV corpus's 1.5 s median
 * episode. Comparing the leading 1.5 s puts the two measurements on the same
 * time basis without discarding the raw episode duration from the report.
 */
export function measureDriftEntryWindows(
  samples: readonly DriftTelemetrySample[],
  episodes: readonly DriftEpisode[],
  windowSeconds: number,
): WebDriftEpisode[] {
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    throw new RangeError(
      `windowSeconds must be a positive finite number, got ${windowSeconds}`,
    );
  }
  const ordered = [...samples].sort((a, b) => a.t - b.t);
  return episodes.flatMap((episode) => {
    const windowStart = episode.startTime;
    const windowEnd = windowStart + windowSeconds;
    if (windowEnd > episode.endTime + 1e-6) return [];
    const inside = ordered.filter((sample) =>
      sample.t >= windowStart - 1e-6 &&
      sample.t <= windowEnd + 1e-6);
    if (inside.length < 2) return [];
    let headingChange = 0;
    for (let index = 1; index < inside.length; index++) {
      headingChange += wrapAngle(
        inside[index].yaw - inside[index - 1].yaw,
      );
    }
    const entry = inside.filter((sample) =>
      sample.t <= windowStart + REFERENCE_SPEED_EDGE_SECONDS);
    const exit = inside.filter((sample) =>
      sample.t >= windowEnd - REFERENCE_SPEED_EDGE_SECONDS);
    const entrySpeed = median(entry.map(planarSpeed));
    const exitSpeed = median(exit.map(planarSpeed));
    const slips = inside.map((sample) =>
      Math.abs(Math.atan2(
        sample.lateralSpeed,
        Math.max(0.1, Math.abs(sample.speed)),
      )) * DEGREES);
    const elapsed = inside.at(-1)!.t - inside[0].t;
    return [{
      duration: windowSeconds,
      speedRetention: entrySpeed > 1e-6 ? exitSpeed / entrySpeed : 0,
      yawRateDegreesPerSecond: elapsed > 0
        ? headingChange / elapsed * DEGREES
        : 0,
      medianSideSlipDegrees: median(slips),
    }];
  });
}

export interface DriftEpisodeDistribution {
  count: number;
  p25: number | null;
  median: number | null;
  p75: number | null;
  p90: number | null;
}

export function summarizeWebEpisodes(
  episodes: readonly WebDriftEpisode[],
): {
  duration: DriftEpisodeDistribution;
  speedRetention: DriftEpisodeDistribution;
  yawRateDegreesPerSecond: DriftEpisodeDistribution;
  medianSideSlipDegrees: DriftEpisodeDistribution;
} {
  const summarize = (values: readonly number[]): DriftEpisodeDistribution => {
    const finite = values.filter(Number.isFinite);
    if (finite.length === 0) {
      return { count: 0, p25: null, median: null, p75: null, p90: null };
    }
    return {
      count: finite.length,
      p25: percentile(finite, 0.25),
      median: percentile(finite, 0.5),
      p75: percentile(finite, 0.75),
      p90: percentile(finite, 0.9),
    };
  };
  return {
    duration: summarize(episodes.map((episode) => episode.duration)),
    speedRetention: summarize(episodes.map((episode) =>
      episode.speedRetention)),
    yawRateDegreesPerSecond: summarize(episodes.map((episode) =>
      Math.abs(episode.yawRateDegreesPerSecond))),
    medianSideSlipDegrees: summarize(episodes.map((episode) =>
      Math.abs(episode.medianSideSlipDegrees))),
  };
}

function finiteMedian(values: readonly number[]): number | null {
  const finite = values.filter(Number.isFinite);
  return finite.length > 0 ? median(finite) : null;
}

function deviation(
  webMedian: number | null,
  referenceMedian: number | null,
): DriftMetricCheck["deviationFromReferenceMedian"] {
  if (webMedian === null || referenceMedian === null) {
    return { absolute: null, percent: null, direction: "unknown" };
  }
  const absolute = webMedian - referenceMedian;
  const percent = referenceMedian === 0
    ? null
    : absolute / Math.abs(referenceMedian) * 100;
  const direction = Math.abs(absolute) < 1e-9
    ? "equal"
    : absolute < 0
      ? "below"
      : "above";
  return { absolute, percent, direction };
}

function formatNumber(value: number | null, unit: string) {
  return value === null ? "missing" : `${value.toFixed(3)}${unit}`;
}

function compareMetric(
  metric: DriftMetricName,
  referenceKey: keyof DriftDistributions,
  unit: DriftMetricCheck["unit"],
  webValues: readonly number[],
  referenceDistribution: DriftPercentiles,
): DriftMetricCheck {
  const acceptanceBand = DRIFT_ACCEPTANCE_BANDS[metric];
  const webMedian = finiteMedian(webValues);
  const p25 = referenceDistribution.p25;
  const p50 = referenceDistribution.median;
  const p75 = referenceDistribution.p75;
  const withinAcceptance = webMedian !== null
    && Number.isFinite(webMedian)
    && webMedian >= acceptanceBand.min
    && webMedian <= acceptanceBand.max;
  const withinReferenceIqr = webMedian === null
    || p25 === null
    || p75 === null
    ? null
    : webMedian >= p25 && webMedian <= p75;
  const failures: string[] = [];
  if (webMedian === null) {
    failures.push(`${metric}: no finite Web episode values`);
  } else if (!withinAcceptance) {
    failures.push(
      `${metric}: Web median ${formatNumber(webMedian, unit)} is outside `
        + `${formatNumber(acceptanceBand.min, unit)}–`
        + `${formatNumber(acceptanceBand.max, unit)}`,
    );
  }
  return {
    metric,
    referenceKey,
    unit,
    webMedian,
    reference: { p25, p50, p75 },
    acceptanceBand,
    withinAcceptance,
    withinReferenceIqr,
    deviationFromReferenceMedian: deviation(webMedian, p50),
    pass: withinAcceptance,
    failures,
  };
}

/**
 * Compare measured Web episode medians with the original KSV corpus.
 *
 * Pass/fail is controlled by the hard acceptance bands only. The original
 * p25/p50/p75 values and the signed deviation from p50 are reported alongside
 * each check; the cross-track original IQR is not a Web same-track mapping.
 */
export function compareDriftDistributions(
  web: WebDriftEpisodes,
  reference: DriftReference,
  options: DriftComparisonOptions = {},
): DriftDistributionComparison {
  const episodes = web.episodes;
  const metricSet = new Set(options.metrics ?? ALL_DRIFT_METRICS);
  const checks: DriftMetricCheck[] = [
    compareMetric(
      "duration",
      "duration",
      "seconds",
      episodes.map((episode) => episode.duration),
      reference.corpus.duration,
    ),
    compareMetric(
      "speedRetention",
      "retention",
      "ratio",
      episodes.map((episode) => episode.speedRetention),
      reference.corpus.retention,
    ),
    compareMetric(
      "yawRateDegreesPerSecond",
      "yawRate",
      "degrees/second",
      episodes.map((episode) => Math.abs(episode.yawRateDegreesPerSecond)),
      reference.corpus.yawRate,
    ),
    compareMetric(
      "medianSideSlipDegrees",
      "sideSlip",
      "degrees",
      episodes.map((episode) => Math.abs(episode.medianSideSlipDegrees)),
      reference.corpus.sideSlip,
    ),
  ].filter((check) => metricSet.has(check.metric));
  const byMetric = new Map(checks.map((check) => [check.metric, check]));
  return {
    episodeCount: episodes.length,
    passed: checks.every((check) => check.pass),
    checks,
    webMedians: {
      duration: byMetric.get("duration")?.webMedian ?? null,
      speedRetention: byMetric.get("speedRetention")?.webMedian ?? null,
      yawRateDegreesPerSecond:
        byMetric.get("yawRateDegreesPerSecond")?.webMedian ?? null,
      medianSideSlipDegrees:
        byMetric.get("medianSideSlipDegrees")?.webMedian ?? null,
    },
    referenceIqrHits: checks.filter(
      (check) => check.withinReferenceIqr === true,
    ).length,
    failures: checks.flatMap((check) => check.failures),
  };
}

/**
 * Handoff for tests/drift-corners.spec.ts: pass real measured Web episodes
 * here once that test has them. It compares corpus-level distributions only;
 * it does not claim a village corner-by-corner correspondence.
 */
export function compareWebDriftEpisodes(
  episodes: readonly WebDriftEpisode[],
  reference: DriftReference = loadDriftReference(),
  options: DriftComparisonOptions = {},
): DriftDistributionComparison {
  return compareDriftDistributions({ episodes }, reference, options);
}
