import type { RouteData } from "../types";

const DEGREES = 180 / Math.PI;

export interface TrackCorner {
  index: number;
  /** Route distance at the start of the corner body. */
  start: number;
  /** Route distance at the end of the corner body. */
  end: number;
  /** Corner distance along the route, including a wrap across s=0. */
  length: number;
  /** Signed heading change through the corner. */
  headingDegrees: number;
  /** Total turning regardless of sign, useful for S bends. */
  absoluteHeadingDegrees: number;
  /** -1 for left, 1 for right. */
  direction: -1 | 1;
}

export interface DriftTelemetrySample {
  /** Seconds from an arbitrary common origin. */
  t: number;
  /** Distance along the same route used by the corner definitions. */
  s: number;
  yaw: number;
  /** Forward speed, in metres per second. */
  speed: number;
  /** Body-right speed, in metres per second. */
  lateralSpeed: number;
  drifting: boolean;
  /**
   * Vehicle drift phase when the sample was taken. KSV effect 2/3 corresponds
   * to the Web `active` phase, not the trigger or manual key press.
   */
  driftPhase?: "none" | "trigger" | "active" | "decay";
}

export interface DriftEpisode {
  startTime: number;
  endTime: number;
  duration: number;
  headingChangeDegrees: number;
  yawRateDegreesPerSecond: number;
  entrySpeed: number;
  exitSpeed: number;
  speedRetention: number;
  maxSideSlipDegrees: number;
  medianSideSlipDegrees: number;
}

export interface CornerDriftResult {
  corner: TrackCorner;
  driftDuration: number;
  cornerDuration: number;
  coverage: number;
  maxCoverageGap: number;
  episodes: DriftEpisode[];
  passes: boolean;
  failures: string[];
}

function wrapAngle(angle: number) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function positiveModulo(value: number, modulus: number) {
  return ((value % modulus) + modulus) % modulus;
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/** True when progress lies in a corner, including a corner crossing s=0. */
export function cornerContains(corner: TrackCorner, s: number, routeLength: number) {
  const progress = positiveModulo(s, routeLength);
  if (corner.start <= corner.end) {
    return progress >= corner.start && progress <= corner.end;
  }
  return progress >= corner.start || progress <= corner.end;
}

/**
 * Split a closed route into meaningful steering sections.
 *
 * Tiny numerical heading wiggles are ignored, same-direction events are
 * bridged across short straights, and very short connector artefacts are
 * discarded. The returned ranges do not overlap except at shared boundaries.
 */
export function extractCorners(
  route: Pick<RouteData, "length" | "points">,
  options: {
    minHeadingDegrees?: number;
    minLength?: number;
    maxGap?: number;
    turnThresholdDegrees?: number;
    padding?: number;
    /** Minimum flat run used to separate adjacent corners. */
    straightMinLength?: number;
    /** Heading slope below which a section counts as straight, in rad/m. */
    flatSlope?: number;
  } = {},
): TrackCorner[] {
  const {
    minHeadingDegrees = 20,
    minLength = 24,
    maxGap = 40,
    padding = 0,
    straightMinLength = 35,
    flatSlope = 0.0016,
  } = options;
  const { points, length } = route;
  if (points.length < 3 || length <= 0) return [];

  const segmentHeading: number[] = [];
  let previousHeading: number | null = null;
  let totalTurn = 0;
  for (let index = 0; index < points.length; index++) {
    const from = points[index].p;
    const to = points[(index + 1) % points.length].p;
    let heading = Math.atan2(to[0] - from[0], to[2] - from[2]);
    if (previousHeading !== null) {
      while (heading - previousHeading > Math.PI) heading -= Math.PI * 2;
      while (heading - previousHeading < -Math.PI) heading += Math.PI * 2;
      totalTurn += heading - previousHeading;
    }
    previousHeading = heading;
    segmentHeading.push(heading);
  }

  const headingAtRaw = (progress: number) => {
    const target = positiveModulo(progress, length);
    let low = 0;
    let high = points.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (points[middle].s <= target) low = middle;
      else high = middle - 1;
    }
    const point = points[low];
    const next = points[(low + 1) % points.length];
    const span = positiveModulo(next.s - point.s, length);
    const t = span > 1e-9
      ? Math.min(1, Math.max(0, positiveModulo(target - point.s, length) / span))
      : 0;
    const nextHeading = low + 1 < points.length
      ? segmentHeading[low + 1]
      : segmentHeading[0] + totalTurn;
    return segmentHeading[low] + (nextHeading - segmentHeading[low]) * t;
  };
  const headingAt = (progress: number) => {
    if (progress > length) return headingAtRaw(progress - length) + totalTurn;
    if (progress < 0) return headingAtRaw(progress + length) - totalTurn;
    return headingAtRaw(progress);
  };

  const sampleStep = 1;
  const sampleCount = Math.floor(length / sampleStep) + 1;
  const smooth = (values: number[], halfWindow: number) => {
    const prefix = new Array(values.length + 1).fill(0);
    for (let index = 0; index < values.length; index++) {
      prefix[index + 1] = prefix[index] + values[index];
    }
    return values.map((_, index) => {
      const from = Math.max(0, index - halfWindow);
      const to = Math.min(values.length - 1, index + halfWindow);
      return (prefix[to + 1] - prefix[from]) / (to - from + 1);
    });
  };
  const headings = smooth(
    smooth(
      Array.from({ length: sampleCount }, (_, index) =>
        headingAt(index * sampleStep)),
      5,
    ),
    8,
  );
  const indexOf = (progress: number) =>
    Math.min(sampleCount - 1, Math.max(0, Math.round(progress)));
  const headingSlope = (progress: number) => {
    const from = indexOf(progress - 8);
    const to = indexOf(progress + 8);
    return (headings[to] - headings[from]) / Math.max(1, to - from);
  };

  const straights: { start: number; end: number }[] = [];
  let straightStart: number | null = null;
  for (let progress = 0; progress <= length; progress += sampleStep) {
    const flat = Math.abs(headingSlope(progress)) < flatSlope;
    if (flat) {
      if (straightStart === null) straightStart = progress;
    } else if (straightStart !== null) {
      if (progress - straightStart >= Math.max(straightMinLength, minLength)) {
        straights.push({ start: straightStart, end: progress });
      }
      straightStart = null;
    }
  }
  if (straightStart !== null &&
      length - straightStart >= Math.max(straightMinLength, minLength)) {
    straights.push({ start: straightStart, end: length });
  }
  if (straights.length === 0) return [];

  const prominenceOf = (
    values: number[],
    index: number,
    from: number,
    to: number,
  ) => {
    const value = values[index];
    if (values[index] > values[index - 1]) {
      let left = index;
      let leftMinimum = value;
      while (left > from) {
        left--;
        if (values[left] > value) break;
        leftMinimum = Math.min(leftMinimum, values[left]);
      }
      let right = index;
      let rightMinimum = value;
      while (right < to) {
        right++;
        if (values[right] > value) break;
        rightMinimum = Math.min(rightMinimum, values[right]);
      }
      return value - Math.max(leftMinimum, rightMinimum);
    }
    let left = index;
    let leftMaximum = value;
    while (left > from) {
      left--;
      if (values[left] < value) break;
      leftMaximum = Math.max(leftMaximum, values[left]);
    }
    let right = index;
    let rightMaximum = value;
    while (right < to) {
      right++;
      if (values[right] < value) break;
      rightMaximum = Math.max(rightMaximum, values[right]);
    }
    return Math.min(leftMaximum, rightMaximum) - value;
  };

  const raw: TrackCorner[] = [];
  for (let straightIndex = 0; straightIndex < straights.length; straightIndex++) {
    const current = straights[straightIndex];
    const following = straights[(straightIndex + 1) % straights.length];
    const from = Math.round(current.end);
    let to = Math.round(following.start);
    if (straightIndex === straights.length - 1) to += Math.round(length);
    if (to <= from) continue;
    const distances: number[] = [];
    const values: number[] = [];
    for (let progress = from; progress <= to; progress += sampleStep) {
      distances.push(progress);
      values.push(headings[indexOf(progress % length)]);
    }
    const extrema: number[] = [0];
    for (let index = 1; index < values.length - 1; index++) {
      if ((values[index] > values[index - 1] && values[index] >= values[index + 1]) ||
          (values[index] < values[index - 1] && values[index] <= values[index + 1])) {
        extrema.push(index);
      }
    }
    extrema.push(values.length - 1);
    let vertices = extrema;
    const minimumProminence = 6 / DEGREES;
    while (vertices.length > 2) {
      let removeAt = -1;
      let smallest = Number.POSITIVE_INFINITY;
      for (let index = 1; index < vertices.length - 1; index++) {
        const prominence = prominenceOf(
          values,
          vertices[index],
          vertices[index - 1],
          vertices[index + 1],
        );
        if (prominence < smallest) {
          smallest = prominence;
          removeAt = index;
        }
      }
      if (smallest >= minimumProminence) break;
      vertices.splice(removeAt, 1);
    }
    for (let index = 0; index < vertices.length - 1; index++) {
      const startSample = vertices[index];
      const endSample = vertices[index + 1];
      const turn = values[endSample] - values[startSample];
      if (Math.abs(turn) * DEGREES < minHeadingDegrees) continue;
      const baselineStart = values[startSample];
      const baselineEnd = values[endSample];
      let refinedStart = startSample;
      let refinedEnd = endSample;
      while (
        refinedStart < refinedEnd - 2 &&
        Math.abs(values[refinedStart] - baselineStart) < 1.5 / DEGREES
      ) {
        refinedStart++;
      }
      while (
        refinedEnd > refinedStart + 2 &&
        Math.abs(values[refinedEnd] - baselineEnd) < 1.5 / DEGREES
      ) {
        refinedEnd--;
      }
      const start = distances[refinedStart];
      let end = distances[refinedEnd];
      if (end < start) end += length;
      const cornerLength = end - start;
      const headingDensity = Math.abs(turn) * DEGREES / Math.max(1, cornerLength);
      if (cornerLength < Math.max(12, minLength / 2) || headingDensity > 6) {
        continue;
      }
      raw.push({
        index: raw.length,
        start: positiveModulo(start - padding, length),
        end: positiveModulo(end + padding, length),
        length: cornerLength + padding * 2,
        headingDegrees: turn * DEGREES,
        absoluteHeadingDegrees: Math.abs(turn) * DEGREES,
        direction: Math.sign(turn) < 0 ? -1 : 1,
      });
    }
  }

  raw.sort((a, b) => {
    const aStart = a.start;
    const bStart = b.start;
    return aStart - bStart;
  });

  const filtered: TrackCorner[] = [];
  for (let index = 0; index < raw.length; index++) {
    const corner = raw[index];
    const next = raw[index + 1];
    if (next && Math.sign(corner.headingDegrees) !== Math.sign(next.headingDegrees)) {
      const a = corner.start;
      const b = positiveModulo(next.end, length);
      const span = positiveModulo(b - a, length);
      const net = corner.headingDegrees + next.headingDegrees;
      if (span < Math.max(35, maxGap) && Math.abs(net) < 15) {
        index++;
        continue;
      }
    }
    filtered.push(corner);
  }
  return filtered.map((corner, index) => ({ ...corner, index }));
}

function sideSlipDegrees(sample: DriftTelemetrySample) {
  return Math.atan2(
    sample.lateralSpeed,
    Math.max(0.1, Math.abs(sample.speed)),
  ) * DEGREES;
}

/** Compare a drift label across samples and merge short telemetry dropouts. */
export function findDriftEpisodes(
  samples: DriftTelemetrySample[],
  options: { mergeGapSeconds?: number; minDuration?: number } = {},
): DriftEpisode[] {
  const { mergeGapSeconds = 0.12, minDuration = 0.08 } = options;
  const ordered = [...samples].sort((a, b) => a.t - b.t);
  const runs: { start: number; end: number }[] = [];
  for (let index = 0; index < ordered.length;) {
    if (!ordered[index].drifting) {
      index++;
      continue;
    }
    const start = index;
    while (index + 1 < ordered.length && ordered[index + 1].drifting) index++;
    const end = index;
    index++;
    const previous = runs.at(-1);
    if (previous && ordered[start].t - ordered[previous.end].t <= mergeGapSeconds) {
      previous.end = end;
    } else {
      runs.push({ start, end });
    }
  }

  return runs.flatMap(({ start, end }) => {
    const run = ordered.slice(start, end + 1);
    if (run.length < 2) return [];
    const duration = run.at(-1)!.t - run[0].t;
    if (duration < minDuration) return [];
    const edgeDuration = Math.min(0.2, duration / 4);
    const entrySamples = run.filter((sample) => sample.t <= run[0].t + edgeDuration);
    const exitSamples = run.filter((sample) => sample.t >= run.at(-1)!.t - edgeDuration);
    const entrySpeed = median(entrySamples.map((sample) =>
      Math.hypot(sample.speed, sample.lateralSpeed)));
    const exitSpeed = median(exitSamples.map((sample) =>
      Math.hypot(sample.speed, sample.lateralSpeed)));
    let headingChange = 0;
    for (let index = 1; index < run.length; index++) {
      headingChange += wrapAngle(run[index].yaw - run[index - 1].yaw);
    }
    const slips = run.map(sideSlipDegrees);
    return [{
      startTime: run[0].t,
      endTime: run.at(-1)!.t,
      duration,
      headingChangeDegrees: headingChange * DEGREES,
      yawRateDegreesPerSecond: duration > 0
        ? headingChange / duration * DEGREES
        : 0,
      entrySpeed,
      exitSpeed,
      speedRetention: entrySpeed > 1e-6 ? exitSpeed / entrySpeed : 0,
      maxSideSlipDegrees: Math.max(...slips.map(Math.abs)),
      medianSideSlipDegrees: median(slips.map(Math.abs)),
    }];
  });
}

function coverageInside(
  samples: DriftTelemetrySample[],
  corner: TrackCorner,
  routeLength: number,
) {
  const inside = samples.filter((sample) =>
    cornerContains(corner, sample.s, routeLength));
  if (inside.length < 2) {
    return { duration: 0, driftDuration: 0, maxGap: 0 };
  }
  let duration = 0;
  let driftDuration = 0;
  let maxGap = 0;
  let gapStart: number | null = null;
  const totalDuration = inside.at(-1)!.t - inside[0].t;
  for (let index = 1; index < inside.length; index++) {
    const previous = inside[index - 1];
    const current = inside[index];
    const dt = Math.max(0, current.t - previous.t);
    duration += dt;
    if (previous.drifting || current.drifting) driftDuration += dt;
    if (previous.drifting || current.drifting) {
      maxGap = Math.max(maxGap, gapStart === null ? 0 : previous.t - gapStart);
      gapStart = null;
    } else if (gapStart === null) {
      gapStart = previous.t;
    }
  }
  if (gapStart !== null) {
    maxGap = Math.max(maxGap, inside.at(-1)!.t - gapStart);
  }
  return { duration: totalDuration, driftDuration, maxGap };
}

export function analyzeCornerDrift(
  samples: DriftTelemetrySample[],
  corners: TrackCorner[],
  routeLength: number,
  options: {
    minCoverage?: number;
    maxCoverageGap?: number;
    minDriftSeconds?: number;
  } = {},
): CornerDriftResult[] {
  const {
    minCoverage = 0.8,
    maxCoverageGap = 0.25,
    minDriftSeconds = 0.3,
  } = options;
  const episodes = findDriftEpisodes(samples);
  return corners.map((corner) => {
    const coverage = coverageInside(samples, corner, routeLength);
    const relevant = episodes.filter((episode) => {
      const midpoint = (episode.startTime + episode.endTime) / 2;
      return samples.some((sample) =>
        sample.t >= midpoint &&
        cornerContains(corner, sample.s, routeLength));
    });
    const ratio = coverage.duration > 0
      ? coverage.driftDuration / coverage.duration
      : 0;
    const failures: string[] = [];
    if (ratio < minCoverage) {
      failures.push(
        `drift coverage ${(ratio * 100).toFixed(0)}% < ${(minCoverage * 100).toFixed(0)}%`,
      );
    }
    if (coverage.maxGap > maxCoverageGap) {
      failures.push(
        `drift gap ${coverage.maxGap.toFixed(2)}s > ${maxCoverageGap.toFixed(2)}s`,
      );
    }
    if (coverage.driftDuration < minDriftSeconds) {
      failures.push(
        `drift time ${coverage.driftDuration.toFixed(2)}s < ${minDriftSeconds.toFixed(2)}s`,
      );
    }
    return {
      corner,
      driftDuration: coverage.driftDuration,
      cornerDuration: coverage.duration,
      coverage: ratio,
      maxCoverageGap: coverage.maxGap,
      episodes: relevant,
      passes: failures.length === 0,
      failures,
    };
  });
}

export function summarizeDriftResults(results: CornerDriftResult[]) {
  const episodes = results.flatMap((result) => result.episodes);
  return {
    corners: results.length,
    passed: results.filter((result) => result.passes).length,
    coverage: results.length
      ? results.reduce((sum, result) => sum + result.coverage, 0) / results.length
      : 0,
    duration: median(episodes.map((episode) => episode.duration)),
    speedRetention: median(episodes.map((episode) => episode.speedRetention)),
    yawRate: median(episodes.map((episode) =>
      Math.abs(episode.yawRateDegreesPerSecond))),
    sideSlip: median(episodes.map((episode) => episode.medianSideSlipDegrees)),
  };
}
