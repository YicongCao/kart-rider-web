import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "playwright/test";
import {
  DRIFT_ACCEPTANCE,
  acceptanceDriftDriver,
  runTrackDrift,
  type CornerDriftRun,
} from "./support/drift-course";
import {
  compareWebDriftEpisodes,
  loadDriftReference,
  measureDriftEntryWindows,
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

function acceptanceReasons(run: CornerDriftRun) {
  const reasons = [...run.failures, ...run.analysis.failures];

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
  if (run.exitHeadingErrorDeg === null) {
    reasons.push("no exit heading measurement");
  } else if (run.exitHeadingErrorDeg > DRIFT_ACCEPTANCE.maxExitHeadingErrorDeg) {
    reasons.push(
      `exit heading error ${run.exitHeadingErrorDeg.toFixed(1)}deg > ` +
      `${DRIFT_ACCEPTANCE.maxExitHeadingErrorDeg}deg`,
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

  return [...new Set(reasons)];
}

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
    exitHeadingErrorDeg: rounded(run.exitHeadingErrorDeg, 1),
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
  for (const track of TRACKS) {
    test(`${track}: baseline drift through every real corner`, async () => {
      test.setTimeout(1_200_000);
      const startedAt = Date.now();
      const result = await runTrackDrift(track, ({ route, routeLength }) =>
        acceptanceDriftDriver({ route, routeLength }));
      const reference = loadDriftReference();
      const referenceWindowSeconds = reference.corpus.duration.median;
      if (referenceWindowSeconds === null) {
        throw new Error("drift reference has no median episode duration");
      }
      const rawEpisodes: WebDriftEpisode[] = [];
      const entryWindows: WebDriftEpisode[] = [];
      for (const run of result.runs) {
        for (const episode of run.analysis.episodes) {
          rawEpisodes.push({
            duration: episode.duration,
            speedRetention: episode.speedRetention,
            yawRateDegreesPerSecond: episode.yawRateDegreesPerSecond,
            medianSideSlipDegrees: episode.medianSideSlipDegrees,
          });
          entryWindows.push(...measureDriftEntryWindows(
            run.samples,
            [episode],
            referenceWindowSeconds,
          ));
        }
      }
      const effectComparison = compareWebDriftEpisodes(
        entryWindows,
        reference,
        { metrics: EFFECT_METRICS },
      );
      const rawEpisodeSummary = summarizeWebEpisodes(rawEpisodes);
      const effectBandMisses = effectComparison.checks.filter(
        (check) => !check.withinAcceptance,
      );
      const effectIqrMisses = effectComparison.checks.filter(
        (check) => check.withinReferenceIqr === false,
      );

      const cornerReports = result.runs.map(run => {
        const reasons = acceptanceReasons(run);
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
            windowSeconds: referenceWindowSeconds,
            basis:
              "first reference-duration window after each Web drift starts; " +
              "the Web acceptance driver intentionally holds Shift through " +
              "the full corner body plus 8 m",
            rawDurationNote:
              "raw Web episode duration is reported but excluded from the " +
              "effect pass/fail because sustained-corner drift is longer " +
              "than the KSV per-episode median by construction",
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
        windows: effectComparison.episodeCount,
        metrics: effectComparison.webMedians,
        reference: {
          yaw: reference.corpus.yawRate,
          sideSlip: reference.corpus.sideSlip,
          retention: reference.corpus.retention,
          duration: reference.corpus.duration,
        },
        rawEpisodeDuration: rawEpisodeSummary.duration,
        rawEpisodeMedianDuration: rawEpisodeSummary.duration.median,
        windowSeconds: referenceWindowSeconds,
      }));

      expect(result.runs.length, `${track}: no corners extracted`).toBeGreaterThan(0);
      expect(
        entryWindows.length,
        `${track}: missing measured drift entry windows`,
      ).toBeGreaterThanOrEqual(result.runs.length);
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
