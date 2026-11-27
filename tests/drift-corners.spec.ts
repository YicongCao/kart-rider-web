import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "playwright/test";
import { Route } from "../src/game/route";
import {
  digitalTireDriftDriver,
  digitalTireTargetSpeed,
  driftAcceptanceReasons,
  runTrackDrift,
  projectNear,
  type CornerDriftRun,
} from "./support/drift-course";
import {
  compareWebDriftEpisodes,
  loadDriftReference,
  measureEffectEpisodes,
  summarizeWebEpisodes,
  type DriftMetricName,
  type WebDriftEpisode,
} from "./support/drift-reference";

const TRACKS = ["village", "desert", "forest", "ice"] as const;
const REPORT_DIR = new URL("../test-results/drift-corners/", import.meta.url);
const EFFECT_METRICS: readonly DriftMetricName[] = [
  "speedRetention",
  "yawRateDegreesPerSecond",
  "medianSideSlipDegrees",
];

function rounded(value: number | null, digits = 2) {
  return value === null ? null : Number(value.toFixed(digits));
}

function metricsFor(run: CornerDriftRun) {
  return {
    startS: rounded(run.startS, 1),
    finishS: rounded(run.finishS, 1),
    initialSpeed: rounded(run.initialSpeed, 1),
    duration: rounded(run.duration, 2),
    reachedExit: run.reachedExit,
    collisions: run.collisions,
    collisionDetail: run.collisionDetail || null,
    offroad: run.offroad,
    offroadDetail: run.offroadDetail || null,
    reversed: run.reversed,
    reverseDetail: run.reverseDetail || null,
    timedOut: run.timedOut,
    maxLateral: rounded(run.maxLateral, 2),
    minGroundedChassisOffset: run.minGroundedChassisOffset,
    exitHeadingErrorDeg: rounded(run.exitHeadingErrorDeg, 1),
    cornerEndHeadingErrorDeg: rounded(run.cornerEndHeadingErrorDeg, 1),
    cornerEndBodyHeadingErrorDeg:
      rounded(run.cornerEndBodyHeadingErrorDeg, 1),
    finalHeadingErrorDeg: rounded(run.finalHeadingErrorDeg, 1),
    coverage: rounded(run.coverage, 3),
    maxCoverageGap: rounded(run.maxCoverageGap, 3),
    longestDriftSeconds: rounded(run.longestDriftSeconds, 2),
    driftSamplesInCorner: run.driftSamplesInCorner,
    medianSideSlipDeg: rounded(run.medianSideSlipDeg, 1),
    cornerSpeedRetention: rounded(run.cornerSpeedRetention, 2),
    driftSpeedRetention: rounded(run.driftSpeedRetention, 2),
    driftInputStartS: rounded(run.driftInputStartS, 1),
    driftInputLeadMeters: rounded(run.driftInputLeadMeters, 1),
    driftInputStartTime: rounded(run.driftInputStartTime, 2),
    driftInputStartedBeforeCorner: run.driftInputStartedBeforeCorner,
    driftInputActiveAtCornerStart: run.driftInputActiveAtCornerStart,
  };
}

test.describe("drift corner acceptance", () => {
  const expectedCorners = { village: 13, desert: 27, forest: 33, ice: 21 };
  for (const track of TRACKS) {
    test(`${track}: baseline drift through every real corner`, async () => {
      test.setTimeout(1_200_000);
      const startedAt = Date.now();
      const result = await runTrackDrift(track, ({ route, routeLength }) => {
        const drive = digitalTireDriftDriver({ route, routeLength });
        return context => {
          const input = drive(context);
          const { throttle = 0, brake = 0, steer = 0 } = input;
          if (![0, 1].includes(throttle) || ![0, 1].includes(brake) || ![-1, 0, 1].includes(steer)) {
            throw new Error(`${track} corner ${context.corner.index}: non-keyboard input ${JSON.stringify(input)}`);
          }
          return input;
        };
      }, {
        initialSpeedForCorner: (corner, route) => digitalTireTargetSpeed(corner, { route }),
      });
      const reference = loadDriftReference();
      const measured = result.runs.map(run => measureEffectEpisodes(run.samples, reference.method));
      const effectEpisodes = measured.flatMap(run => run.episodes);
      const rawEpisodes: WebDriftEpisode[] = result.runs.flatMap(run => run.analysis.episodes);
      const effectComparison = compareWebDriftEpisodes(
        effectEpisodes,
        reference,
        { metrics: EFFECT_METRICS },
      );
      const rawEpisodeSummary = summarizeWebEpisodes(rawEpisodes);
      const effectBandMisses = effectComparison.checks.filter(
        (check) => !check.withinAcceptance,
      );
      const effectIqrMisses = effectComparison.checks.filter(
        (check) => check.withinReferenceIqr !== true,
      );

      const cornerReports = result.runs.map(run => {
        const reasons = driftAcceptanceReasons(run);
        return {
          index: run.corner.index,
          s: `${run.corner.start.toFixed(1)}..${run.corner.end.toFixed(1)}`,
          length: Number(run.corner.length.toFixed(1)),
          headingDegrees: Number(run.corner.headingDegrees.toFixed(1)),
          direction: run.corner.direction,
          passed: reasons.length === 0,
          reasons,
          metrics: metricsFor(run),
        };
      });
      const failures = cornerReports.filter(corner => !corner.passed);
      const failureReasons: Record<string, number> = {};
      for (const failure of failures) {
        for (const reason of failure.reasons) {
          failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
        }
      }
      const report = {
        track,
        routeLength: result.routeLength,
        generatedAt: new Date().toISOString(),
        filteredShortCorners: result.filteredShortCorners,
        summary: {
          corners: result.corners.length,
          passed: cornerReports.length - failures.length,
          failed: failures.length,
          failureReasons,
          harness: result.summary,
          elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
        },
        referenceComparison: {
          fixture: {
            schemaVersion: reference.schemaVersion,
            trackCount: reference.corpus.trackCount,
            replayCount: reference.corpus.replayCount,
            episodeCount: reference.corpus.episodeCount,
          },
          protocol: {
            effectMetrics: EFFECT_METRICS,
            basis: "Complete active/linger episodes, sampled at 10 Hz using KSV position differences",
            measuredCorners: measured.filter(run => run.episodes.length > 0).length,
            truncatedEpisodes: measured.reduce((n, run) => n + run.truncated, 0),
          },
          effect: effectComparison,
          effectIqrMisses: effectIqrMisses.map((check) => check.metric),
          rawEpisodes: rawEpisodeSummary,
          rawDurationReference: reference.corpus.duration,
        },
        failures,
        corners: cornerReports,
      };

      mkdirSync(REPORT_DIR, { recursive: true });
      const reportPath = fileURLToPath(new URL(`${track}.json`, REPORT_DIR));
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

      for (const failure of failures) {
        console.log("DRIFT_FAIL", JSON.stringify(failure));
      }
      for (const miss of effectIqrMisses) {
        console.log("DRIFT_REFERENCE_MISS", JSON.stringify({
          track,
          metric: miss.metric,
          webMedian: miss.webMedian,
          reference: miss.reference,
        }));
      }
      console.log("DRIFT_TRACK_SUMMARY", JSON.stringify({
        track,
        reportPath,
        ...report.summary,
      }));
      console.log("DRIFT_REFERENCE", JSON.stringify({
        track,
        effectEpisodes: effectComparison.episodeCount,
        metrics: effectComparison.webMedians,
        reference: {
          yaw: reference.corpus.yawRate,
          sideSlip: reference.corpus.sideSlip,
          retention: reference.corpus.retention,
          duration: reference.corpus.duration,
        },
        rawEpisodeDuration: rawEpisodeSummary.duration,
        rawEpisodeMedianDuration: rawEpisodeSummary.duration.median,
      }));

      expect(result.runs).toHaveLength(expectedCorners[track]);
      expect(report.referenceComparison.protocol.measuredCorners,
        `${track}: each corner must supply a complete effect episode`).toBe(result.runs.length);
      expect(report.referenceComparison.protocol.truncatedEpisodes,
        `${track}: effect still active at end of telemetry`).toBe(0);
      expect(
        effectBandMisses,
        `${track}: drift effect medians outside the hard acceptance bands: ` +
        JSON.stringify(effectBandMisses.map((check) => check.metric)),
      ).toEqual([]);
      expect(
        effectIqrMisses,
        `${track}: drift effect medians outside the original KSV IQR: ` +
        JSON.stringify(effectIqrMisses.map((check) => check.metric)),
      ).toEqual([]);
      expect(
        failures.length,
        `${track}: ${failures.length}/${cornerReports.length} corners failed; ` +
        `details in ${reportPath}`,
      ).toBe(0);
    });
  }
});


test("continuous projection stays on the approached branch and crosses the lap seam", () => {
  const route = new Route({ length: 42, halfWidth: 2, points: [
    { s: 0, p: [0, 0, 0], f: [0, 0, 1], u: [0, 1, 0], curvature: 0 },
    { s: 20, p: [0, 0, 20], f: [0, 0, 1], u: [0, 1, 0], curvature: 0 },
    { s: 21, p: [1, 0, 20], f: [0, 0, -1], u: [0, 1, 0], curvature: 0 },
    { s: 41, p: [1, 0, 0], f: [-1, 0, 0], u: [0, 1, 0], curvature: 0 },
  ] });
  // The returning straight is nearer in world space but twenty metres later.
  expect(projectNear(route, 10, 0.5, 0.8, 10.2).s).toBeCloseTo(10.2);
  expect(projectNear(route, 41.9, 0.5, 0, 0.2).s).toBeCloseTo(0.2);
});
