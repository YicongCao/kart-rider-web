import { expect, test } from "playwright/test";
import {
  compareDriftDistributions,
  compareWebDriftEpisodes,
  loadDriftReference,
  measureDriftEntryWindows,
  summarizeWebEpisodes,
  type DriftReference,
  type WebDriftEpisode,
} from "./support/drift-reference";
import type {
  DriftEpisode,
  DriftTelemetrySample,
} from "../src/game/drift-analysis";

/**
 * This fixture describes original KSV replays, not the Web runtime:
 * - corpus distributions span 17 tracks and are not a same-track Web result;
 * - pathCorners counts come from each replay's own racing line, not route
 *   coordinates shared with the Web track;
 * - village_R01 has no original replay, so no corner-by-corner claim is
 *   possible for it.
 *
 * Synthetic episodes below verify the comparison helper. They are not
 * presented as measured Web telemetry.
 */

type UnknownRecord = Record<string, unknown>;

const EXPECTED = {
  replays: 31,
  tracks: 17,
  playerRecords: 218,
  driftEpisodes: 7454,
  pathCorners: 5610,
  driftedPathCorners: 3259,
  coverageThreshold: 0.8,
} as const;

function record(value: unknown, context: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as UnknownRecord;
}

function numericField(
  value: unknown,
  candidates: readonly string[],
  context: string,
): number {
  const object = record(value, context);
  for (const candidate of candidates) {
    const field = object[candidate];
    if (typeof field === "number" && Number.isFinite(field)) return field;
  }
  throw new Error(
    `${context} is missing a numeric field: ${candidates.join(" or ")}`,
  );
}

function fixtureQuantileEpisodes(reference: DriftReference): WebDriftEpisode[] {
  const value = (candidate: number | null, label: string) => {
    if (candidate === null) throw new Error(`reference ${label} is missing`);
    return candidate;
  };
  const durations = ["p25", "median", "p75"].map((key) =>
    value(
      reference.corpus.duration[key as keyof typeof reference.corpus.duration],
      `duration.${key}`,
    ));
  const retentions = ["p25", "median", "p75"].map((key) =>
    value(
      reference.corpus.retention[key as keyof typeof reference.corpus.retention],
      `retention.${key}`,
    ));
  const yawRates = ["p25", "median", "p75"].map((key) =>
    value(
      reference.corpus.yawRate[key as keyof typeof reference.corpus.yawRate],
      `yawRate.${key}`,
    ));
  const sideSlips = ["p25", "median", "p75"].map((key) =>
    value(
      reference.corpus.sideSlip[key as keyof typeof reference.corpus.sideSlip],
      `sideSlip.${key}`,
    ));
  return durations.map((duration, index) => ({
    duration,
    speedRetention: retentions[index],
    yawRateDegreesPerSecond: yawRates[index],
    medianSideSlipDegrees: sideSlips[index],
  }));
}

function syntheticEpisodes(
  values: {
    duration: number[];
    speedRetention: number[];
    yawRateDegreesPerSecond: number[];
    medianSideSlipDegrees: number[];
  },
): WebDriftEpisode[] {
  return values.duration.map((duration, index) => ({
    duration,
    speedRetention: values.speedRetention[index],
    yawRateDegreesPerSecond: values.yawRateDegreesPerSecond[index],
    medianSideSlipDegrees: values.medianSideSlipDegrees[index],
  }));
}

test("fixture is an original KSV cross-track summary, not a Web same-track mapping", () => {
  const reference = loadDriftReference();
  expect(reference.schemaVersion).toBe(1);

  const corpus = record(reference.corpus, "corpus");
  expect(numericField(
    corpus,
    ["replayCount", "replays", "replayTotal"],
    "corpus.replayCount",
  )).toBe(EXPECTED.replays);
  expect(numericField(
    corpus,
    ["trackCount", "tracks", "trackTotal"],
    "corpus.trackCount",
  )).toBe(EXPECTED.tracks);
  expect(numericField(
    corpus,
    ["playerRecordCount", "playerRecords", "recordCount"],
    "corpus.playerRecordCount",
  )).toBe(EXPECTED.playerRecords);
  expect(numericField(
    corpus,
    ["episodeCount", "driftEpisodeCount", "driftEpisodes", "episodes"],
    "corpus.episodeCount",
  )).toBe(EXPECTED.driftEpisodes);

  const pathCorners = record(reference.pathCorners, "pathCorners");
  expect(numericField(
    pathCorners,
    ["cornerCount", "pathCornerCount", "pathCorners", "corners"],
    "pathCorners.cornerCount",
  )).toBe(EXPECTED.pathCorners);
  expect(numericField(
    pathCorners,
    ["coverageThreshold", "driftedCoverageThreshold"],
    "pathCorners.coverageThreshold",
  )).toBe(EXPECTED.coverageThreshold);
  expect(numericField(
    pathCorners,
    ["driftedCornerCount", "driftedCorners", "drifted"],
    "pathCorners.driftedCornerCount",
  )).toBe(EXPECTED.driftedPathCorners);

  const tracks = record(reference.tracks, "tracks");
  expect(Object.keys(tracks)).toHaveLength(EXPECTED.tracks);
  expect(
    Object.values(tracks).reduce(
      (sum, value) => sum
        + numericField(value, ["replayCount", "replays"], "track.replayCount"),
      0,
    ),
  ).toBe(EXPECTED.replays);
  expect(
    Object.values(tracks).reduce(
      (sum, value) => sum
        + numericField(
          value,
          ["playerRecordCount", "playerRecords", "recordCount"],
          "track.playerRecordCount",
        ),
      0,
    ),
  ).toBe(EXPECTED.playerRecords);
  expect(
    Object.values(tracks).reduce(
      (sum, value) => sum
        + numericField(
          value,
          ["episodeCount", "driftEpisodeCount", "driftEpisodes", "episodes"],
          "track.episodeCount",
        ),
      0,
    ),
  ).toBe(EXPECTED.driftEpisodes);
});

test("every original track has its own path-corner drift coverage statistics", () => {
  const reference = loadDriftReference();
  const pathCornerTracks = record(
    reference.pathCorners.tracks,
    "pathCorners.tracks",
  );
  const trackNames = Object.keys(pathCornerTracks);
  expect(trackNames).toHaveLength(EXPECTED.tracks);
  expect(trackNames).toEqual(
    expect.arrayContaining(["china_R11", "forest_R04", "desert_R02"]),
  );

  let cornerTotal = 0;
  let driftedTotal = 0;
  for (const track of trackNames) {
    const stats = pathCornerTracks[track];
    const cornerCount = numericField(
      stats,
      ["cornerCount", "pathCornerCount", "pathCorners", "corners"],
      `${track}.pathCorners`,
    );
    const driftedCornerCount = numericField(
      stats,
      ["driftedCornerCount", "driftedCorners", "drifted"],
      `${track}.driftedCorners`,
    );
    const medianCoverage = numericField(
      stats,
      ["medianCoverage", "medianDriftCoverage"],
      `${track}.medianCoverage`,
    );
    const driftedFraction = numericField(
      stats,
      ["driftedFraction", "driftedCoverage"],
      `${track}.driftedFraction`,
    );

    expect(cornerCount, `${track} corner count`).toBeGreaterThan(0);
    expect(driftedCornerCount, `${track} drifted corners`)
      .toBeGreaterThanOrEqual(0);
    expect(driftedCornerCount, `${track} drifted corners`)
      .toBeLessThanOrEqual(cornerCount);
    expect(medianCoverage, `${track} median coverage`)
      .toBeGreaterThanOrEqual(0);
    expect(medianCoverage, `${track} median coverage`)
      .toBeLessThanOrEqual(1);
    expect(driftedFraction, `${track} drifted fraction`)
      .toBeCloseTo(driftedCornerCount / cornerCount, 4);

    cornerTotal += cornerCount;
    driftedTotal += driftedCornerCount;
    expect(
      Object.hasOwn(reference.tracks, track),
      `${track} has a replay distribution entry`,
    ).toBe(true);
  }

  expect(cornerTotal).toBe(EXPECTED.pathCorners);
  expect(driftedTotal).toBe(EXPECTED.driftedPathCorners);
  expect(
    numericField(
      reference.pathCorners,
      ["driftedFraction"],
      "pathCorners.driftedFraction",
    ),
  ).toBeCloseTo(EXPECTED.driftedPathCorners / EXPECTED.pathCorners, 4);
});

test("village has no original replay, so no corner-by-corner comparison is claimed", () => {
  const reference = loadDriftReference();
  const originalTracks = [
    ...Object.keys(reference.tracks),
    ...Object.keys(reference.pathCorners.tracks),
  ];
  expect(originalTracks.filter((track) => track.startsWith("village_"))).toEqual(
    [],
  );
  // A future village check may compare Web corpus distributions with the hard
  // acceptance bands, but the original fixture has no village corners to map.
});

test("comparator passes synthetic episodes at the reference quartiles", () => {
  const reference = loadDriftReference();
  const episodes = fixtureQuantileEpisodes(reference);
  const result = compareDriftDistributions({ episodes }, reference);

  expect(result.episodeCount).toBe(3);
  expect(result.passed).toBe(true);
  expect(result.failures).toEqual([]);
  expect(result.referenceIqrHits).toBe(4);
  expect(result.checks).toHaveLength(4);
  expect(result.checks.map((check) => check.metric)).toEqual([
    "duration",
    "speedRetention",
    "yawRateDegreesPerSecond",
    "medianSideSlipDegrees",
  ]);

  expect(result.webMedians).toEqual({
    duration: reference.corpus.duration.median,
    speedRetention: reference.corpus.retention.median,
    yawRateDegreesPerSecond: reference.corpus.yawRate.median,
    medianSideSlipDegrees: reference.corpus.sideSlip.median,
  });

  const duration = result.checks[0];
  expect(duration.reference).toEqual({
    p25: reference.corpus.duration.p25,
    p50: reference.corpus.duration.median,
    p75: reference.corpus.duration.p75,
  });
  expect(duration.acceptanceBand).toEqual({ min: 0.9, max: 2.3 });
  expect(duration.withinAcceptance).toBe(true);
  expect(duration.withinReferenceIqr).toBe(true);
  expect(duration.deviationFromReferenceMedian.absolute).toBeCloseTo(0, 9);
  expect(duration.deviationFromReferenceMedian.percent).toBeCloseTo(0, 9);
  expect(duration.deviationFromReferenceMedian.direction).toBe("equal");

  for (const check of result.checks) {
    expect(check.pass, `${check.metric} passes`).toBe(true);
    expect(check.reference.p25).not.toBeNull();
    expect(check.reference.p50).not.toBeNull();
    expect(check.reference.p75).not.toBeNull();
    expect(check.deviationFromReferenceMedian.absolute).not.toBeNull();
    expect(check.deviationFromReferenceMedian.percent).not.toBeNull();
  }
});

test("comparator fails synthetic episodes outside every hard acceptance band", () => {
  const reference = loadDriftReference();
  const episodes = syntheticEpisodes({
    duration: [0.4, 0.5, 0.6],
    speedRetention: [0.6, 0.7, 0.75],
    yawRateDegreesPerSecond: [-10, 0, 10],
    medianSideSlipDegrees: [75, 80, 85],
  });
  const result = compareDriftDistributions({ episodes }, reference);

  expect(result.episodeCount).toBe(3);
  expect(result.passed).toBe(false);
  expect(result.checks.every((check) => !check.pass)).toBe(true);
  expect(result.checks.every((check) => !check.withinAcceptance)).toBe(true);
  expect(result.failures).toHaveLength(4);
  expect(result.failures.join("\n")).toMatch(/duration/);
  expect(result.failures.join("\n")).toMatch(/speedRetention/);
  expect(result.failures.join("\n")).toMatch(/yawRateDegreesPerSecond/);
  expect(result.failures.join("\n")).toMatch(/medianSideSlipDegrees/);
  expect(result.referenceIqrHits).toBe(0);
});

test("hard bands decide pass/fail while reference IQR misses stay visible", () => {
  const reference = loadDriftReference();
  const episodes = syntheticEpisodes({
    duration: [2.2, 2.2, 2.2],
    speedRetention: [1.1, 1.1, 1.1],
    yawRateDegreesPerSecond: [98, 98, 98],
    medianSideSlipDegrees: [68, 68, 68],
  });
  const result = compareWebDriftEpisodes(episodes, reference);

  expect(result.passed).toBe(true);
  expect(result.failures).toEqual([]);
  expect(result.referenceIqrHits).toBe(1);
  const byMetric = new Map(
    result.checks.map((check) => [check.metric, check]),
  );
  expect(byMetric.get("duration")!.withinReferenceIqr).toBe(true);
  expect(byMetric.get("speedRetention")!.withinReferenceIqr).toBe(false);
  expect(byMetric.get("yawRateDegreesPerSecond")!.withinReferenceIqr)
    .toBe(false);
  expect(byMetric.get("medianSideSlipDegrees")!.withinReferenceIqr).toBe(false);
  expect(byMetric.get("speedRetention")!.deviationFromReferenceMedian.percent)
    .toBeGreaterThan(0);
});

test("comparator reports missing Web data instead of throwing", () => {
  const reference = loadDriftReference();
  const result = compareWebDriftEpisodes([], reference);

  expect(result.episodeCount).toBe(0);
  expect(result.passed).toBe(false);
  expect(result.failures).toHaveLength(4);
  expect(result.webMedians).toEqual({
    duration: null,
    speedRetention: null,
    yawRateDegreesPerSecond: null,
    medianSideSlipDegrees: null,
  });
  expect(result.checks.every((check) => check.webMedian === null)).toBe(true);
});

test("entry-window measurement uses the reference duration and preserves slip", () => {
  const samples: DriftTelemetrySample[] = [];
  const dt = 0.01;
  let yaw = 0;
  for (let index = 0; index <= 300; index++) {
    const slip = 50 * Math.PI / 180;
    samples.push({
      t: index * dt,
      s: index * 0.15,
      yaw,
      speed: 15 * Math.cos(slip),
      lateralSpeed: -15 * Math.sin(slip),
      drifting: true,
    });
    yaw += 60 * Math.PI / 180 * dt;
  }
  const episode: DriftEpisode = {
    startTime: 0,
    endTime: 3,
    duration: 3,
    headingChangeDegrees: 180,
    yawRateDegreesPerSecond: 60,
    entrySpeed: 15,
    exitSpeed: 15,
    speedRetention: 1,
    maxSideSlipDegrees: 50,
    medianSideSlipDegrees: 50,
  };
  const [window] = measureDriftEntryWindows(samples, [episode], 1.5);

  expect(window.duration).toBe(1.5);
  expect(window.yawRateDegreesPerSecond).toBeCloseTo(60, 0);
  expect(window.medianSideSlipDegrees).toBeCloseTo(50, 3);
  expect(window.speedRetention).toBeCloseTo(1, 3);
});

test("entry-window measurement skips an episode shorter than the reference window", () => {
  const samples: DriftTelemetrySample[] = [
    { t: 0, s: 0, yaw: 0, speed: 15, lateralSpeed: 0, drifting: true },
    { t: 0.5, s: 7.5, yaw: 0.5, speed: 15, lateralSpeed: 0, drifting: true },
  ];
  const episode: DriftEpisode = {
    startTime: 0,
    endTime: 0.5,
    duration: 0.5,
    headingChangeDegrees: 28.6,
    yawRateDegreesPerSecond: 57.3,
    entrySpeed: 15,
    exitSpeed: 15,
    speedRetention: 1,
    maxSideSlipDegrees: 0,
    medianSideSlipDegrees: 0,
  };

  expect(measureDriftEntryWindows(samples, [episode], 1.5)).toEqual([]);
});

test("effect comparison excludes the protocol-dependent duration metric", () => {
  const reference = loadDriftReference();
  const episodes = fixtureQuantileEpisodes(reference);
  const result = compareWebDriftEpisodes(episodes, reference, {
    metrics: [
      "speedRetention",
      "yawRateDegreesPerSecond",
      "medianSideSlipDegrees",
    ],
  });

  expect(result.checks.map((check) => check.metric)).toEqual([
    "speedRetention",
    "yawRateDegreesPerSecond",
    "medianSideSlipDegrees",
  ]);
  expect(result.webMedians.duration).toBeNull();
  expect(result.passed).toBe(true);
  expect(result.referenceIqrHits).toBe(3);
  expect(result.episodeCount).toBe(3);
});

test("episode summaries report percentiles for measured Web data", () => {
  const summary = summarizeWebEpisodes([
    {
      duration: 1,
      speedRetention: 0.9,
      yawRateDegreesPerSecond: 40,
      medianSideSlipDegrees: 45,
    },
    {
      duration: 2,
      speedRetention: 1,
      yawRateDegreesPerSecond: 50,
      medianSideSlipDegrees: 50,
    },
    {
      duration: 3,
      speedRetention: 1.1,
      yawRateDegreesPerSecond: 60,
      medianSideSlipDegrees: 55,
    },
  ]);

  expect(summary.duration).toMatchObject({
    count: 3,
    median: 2,
  });
  expect(summary.speedRetention.median).toBe(1);
  expect(summary.yawRateDegreesPerSecond.median).toBe(50);
  expect(summary.medianSideSlipDegrees.median).toBe(50);
});
