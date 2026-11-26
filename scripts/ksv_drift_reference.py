#!/usr/bin/env python3
"""Build a compact drift-distribution reference from original KSV replays.

The output contains no raw replay samples or player names.  It reports
cross-track episode distributions plus a separate per-replay racing-line
corner coverage test; it does not map those corners onto the Web track's route
coordinates.
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
from bisect import bisect_left, bisect_right
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from ksv_telemetry import decode_ksv  # noqa: E402


SAMPLE_RATE_HZ = 10.0
DRIFT_EFFECTS = frozenset((2, 3))
MAX_DROPOUT_TICKS = 2  # 0.2 s at 10 Hz
MIN_DURATION_TICKS = 4  # 0.4 s at 10 Hz
SPEED_WINDOW_FRAMES = 5
SPEED_WINDOW_RADIUS = SPEED_WINDOW_FRAMES // 2
SIDE_SLIP_MIN_SPEED = 5.0
REPRESENTATIVE_EPISODE_COUNT = 20
PATH_SAMPLE_STEP = 2.0
PATH_TANGENT_RADIUS = 3
PATH_SMOOTH_HALF_WINDOWS = (3, 4)
PATH_SLOPE_HALF_WINDOW = 4
PATH_FLAT_SLOPE = 0.0016
PATH_STRAIGHT_MIN_LENGTH = 35.0
PATH_CORNER_MIN_TURN_DEG = 35.0
PATH_CORNER_MIN_LENGTH = 18.0
PATH_CORNER_COVERAGE_THRESHOLD = 0.8
PATH_PROMINENCE_DEG = 6.0
PATH_BOUNDARY_REFINE_DEG = 1.5
PATH_JUMP_MIN_DISTANCE = 40.0
PATH_JUMP_MEDIAN_FACTOR = 5.0
PATH_MIN_SEGMENT_SAMPLES = 10
PATH_MIN_ROUTE_LENGTH = 2.0 * PATH_STRAIGHT_MIN_LENGTH

PERCENTILES = (
    ("p10", 0.10),
    ("p25", 0.25),
    ("median", 0.50),
    ("p75", 0.75),
    ("p90", 0.90),
)


@dataclass
class EpisodeMetrics:
    track: str
    duration: float
    heading_change_deg: float
    yaw_rate: float
    entry_speed: float
    exit_speed: float
    retention: float | None
    side_slip_median: float | None
    side_slip_max: float | None


@dataclass
class PathAnalysis:
    samples: list[dict]
    sample_s: list[float]
    s: list[float]
    headings: list[float]
    straights: list[tuple[int, int]]
    length: float


@dataclass
class PathCorner:
    track: str
    start: float
    end: float
    heading_change_deg: float
    coverage: float


def wrap_radians(angle: float) -> float:
    return (angle + math.pi) % (2.0 * math.pi) - math.pi


def percentile(sorted_values: list[float], fraction: float) -> float | None:
    if not sorted_values:
        return None
    position = (len(sorted_values) - 1) * fraction
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return sorted_values[lower]
    blend = position - lower
    return (
        sorted_values[lower] * (1.0 - blend)
        + sorted_values[upper] * blend
    )


def distribution(values: list[float]) -> dict:
    ordered = sorted(values)
    return {
        name: percentile(ordered, fraction)
        for name, fraction in PERCENTILES
    }


def window_bounds(index: int, count: int, radius: int) -> tuple[int, int]:
    lower = index - radius
    upper = index + radius
    if lower < 0:
        upper -= lower
        lower = 0
    if upper >= count:
        lower -= upper - (count - 1)
        upper = count - 1
    return max(0, lower), upper


def planar_velocity(
    ticks: list[int],
    xs: list[float],
    ys: list[float],
    index: int,
    radius: int,
) -> tuple[float, float, float]:
    lower, upper = window_bounds(index, len(ticks), radius)
    elapsed = (ticks[upper] - ticks[lower]) / SAMPLE_RATE_HZ
    if elapsed <= 0.0 or lower == upper:
        return 0.0, 0.0, 0.0
    vx = (xs[upper] - xs[lower]) / elapsed
    vy = (ys[upper] - ys[lower]) / elapsed
    return vx, vy, math.hypot(vx, vy)


def window_speed(
    ticks: list[int],
    xs: list[float],
    ys: list[float],
    start: int,
    end: int,
) -> float:
    elapsed = (ticks[end] - ticks[start]) / SAMPLE_RATE_HZ
    if elapsed <= 0.0 or start == end:
        return 0.0
    return math.hypot(xs[end] - xs[start], ys[end] - ys[start]) / elapsed


def drift_groups(samples: list[dict]) -> list[tuple[int, int]]:
    drift_indices = [
        index for index, sample in enumerate(samples)
        if sample["effect"] in DRIFT_EFFECTS
    ]
    if not drift_indices:
        return []

    groups = []
    start = previous = drift_indices[0]
    for index in drift_indices[1:]:
        gap_ticks = samples[index]["tick"] - samples[previous]["tick"]
        if 0 <= gap_ticks <= MAX_DROPOUT_TICKS:
            previous = index
        else:
            groups.append((start, previous))
            start = previous = index
    groups.append((start, previous))
    return groups


def measure_record(samples: list[dict], track: str) -> list[EpisodeMetrics]:
    if len(samples) < SPEED_WINDOW_FRAMES:
        return []

    ticks = [sample["tick"] for sample in samples]
    xs = [sample["x"] for sample in samples]
    ys = [sample["y"] for sample in samples]
    headings = [sample["heading"] for sample in samples]
    velocities = [
        planar_velocity(ticks, xs, ys, index, SPEED_WINDOW_RADIUS)
        for index in range(len(samples))
    ]

    episodes = []
    for start, end in drift_groups(samples):
        span_ticks = ticks[end] - ticks[start]
        if span_ticks < MIN_DURATION_TICKS:
            continue
        duration = span_ticks / SAMPLE_RATE_HZ
        if duration <= 0.0:
            continue

        previous_heading = headings[start]
        heading_change = 0.0
        side_slips = []
        for index in range(start, end + 1):
            heading = headings[index]
            heading_change += wrap_radians(heading - previous_heading)
            previous_heading = heading

            vx, vy, speed = velocities[index]
            if speed > SIDE_SLIP_MIN_SPEED:
                velocity_heading = math.atan2(vx, vy)
                side_slips.append(
                    abs(math.degrees(wrap_radians(velocity_heading - heading)))
                )

        heading_change_deg = math.degrees(heading_change)
        entry_speed = window_speed(
            ticks, xs, ys, start, min(start + SPEED_WINDOW_FRAMES - 1, end)
        )
        exit_speed = window_speed(
            ticks, xs, ys, max(end - SPEED_WINDOW_FRAMES + 1, start), end
        )
        retention = exit_speed / entry_speed if entry_speed > 0.0 else None
        ordered_slips = sorted(side_slips)
        if not ordered_slips:
            side_slip_median = None
        elif len(ordered_slips) % 2 == 1:
            side_slip_median = ordered_slips[len(ordered_slips) // 2]
        else:
            middle = len(ordered_slips) // 2
            side_slip_median = (
                ordered_slips[middle - 1] + ordered_slips[middle]
            ) / 2.0

        episodes.append(EpisodeMetrics(
            track=track,
            duration=duration,
            heading_change_deg=heading_change_deg,
            yaw_rate=abs(heading_change_deg) / duration,
            entry_speed=entry_speed,
            exit_speed=exit_speed,
            retention=retention,
            side_slip_median=side_slip_median,
            side_slip_max=max(ordered_slips) if ordered_slips else None,
        ))
    return episodes


def split_path_segments(samples: list[dict]) -> list[list[dict]]:
    start = 0
    while (
        start < len(samples)
        and samples[start]["x"] == 0.0
        and samples[start]["y"] == 0.0
    ):
        start += 1
    valid = samples[start:]
    if len(valid) < PATH_MIN_SEGMENT_SAMPLES:
        return []

    steps = [
        math.hypot(
            valid[index]["x"] - valid[index - 1]["x"],
            valid[index]["y"] - valid[index - 1]["y"],
        )
        for index in range(1, len(valid))
    ]
    median_step = statistics.median(steps) if steps else 0.0
    jump_threshold = max(
        PATH_JUMP_MIN_DISTANCE,
        median_step * PATH_JUMP_MEDIAN_FACTOR,
    )

    segments = []
    segment_start = 0
    for index, step in enumerate(steps, 1):
        if step > jump_threshold:
            if index - segment_start >= PATH_MIN_SEGMENT_SAMPLES:
                segments.append(valid[segment_start:index])
            segment_start = index
    if len(valid) - segment_start >= PATH_MIN_SEGMENT_SAMPLES:
        segments.append(valid[segment_start:])
    return segments


def moving_average(values: list[float], half_window: int) -> list[float]:
    prefix = [0.0]
    for value in values:
        prefix.append(prefix[-1] + value)
    return [
        (
            prefix[min(len(values) - 1, index + half_window) + 1]
            - prefix[max(0, index - half_window)]
        ) / (
            min(len(values) - 1, index + half_window)
            - max(0, index - half_window)
            + 1
        )
        for index in range(len(values))
    ]


def build_path_analysis(samples: list[dict]) -> PathAnalysis | None:
    # Use the replay's horizontal (x, y) plane as the pseudo-route (x, z) plane.
    points = [(sample["x"], sample["y"]) for sample in samples]
    sample_s = [0.0]
    for index in range(1, len(points)):
        sample_s.append(
            sample_s[-1]
            + math.hypot(
                points[index][0] - points[index - 1][0],
                points[index][1] - points[index - 1][1],
            )
        )

    geometry_points = [points[0]]
    geometry_s = [0.0]
    for index in range(1, len(points)):
        if sample_s[index] > geometry_s[-1] + 1e-9:
            geometry_points.append(points[index])
            geometry_s.append(sample_s[index])

    length = geometry_s[-1]
    if length < PATH_MIN_ROUTE_LENGTH or len(geometry_points) < 4:
        return None

    resampled_s = [
        index * PATH_SAMPLE_STEP
        for index in range(int(length // PATH_SAMPLE_STEP) + 1)
    ]
    if resampled_s[-1] < length - 1e-9:
        resampled_s.append(length)

    xs = []
    ys = []
    pointer = 0
    for target in resampled_s:
        while (
            pointer + 1 < len(geometry_s) - 1
            and geometry_s[pointer + 1] < target
        ):
            pointer += 1
        span = geometry_s[pointer + 1] - geometry_s[pointer]
        fraction = 0.0 if span <= 0.0 else (
            (target - geometry_s[pointer]) / span
        )
        xs.append(
            geometry_points[pointer][0]
            + (geometry_points[pointer + 1][0] - geometry_points[pointer][0])
            * fraction
        )
        ys.append(
            geometry_points[pointer][1]
            + (geometry_points[pointer + 1][1] - geometry_points[pointer][1])
            * fraction
        )

    count = len(xs)
    raw_headings: list[float | None] = []
    for index in range(count):
        lower = max(0, index - PATH_TANGENT_RADIUS)
        upper = min(count - 1, index + PATH_TANGENT_RADIUS)
        dx = xs[upper] - xs[lower]
        dy = ys[upper] - ys[lower]
        if math.hypot(dx, dy) < 1e-9:
            raw_headings.append(None)
        else:
            raw_headings.append(math.atan2(dx, dy))
    valid_heading_indices = [
        index for index, value in enumerate(raw_headings) if value is not None
    ]
    if not valid_heading_indices:
        return None
    for index, value in enumerate(raw_headings):
        if value is not None:
            continue
        nearest = min(
            valid_heading_indices,
            key=lambda candidate: abs(candidate - index),
        )
        raw_headings[index] = raw_headings[nearest]

    first_heading = raw_headings[0]
    if first_heading is None:
        return None
    unwrapped = [first_heading]
    for index in range(1, count):
        heading = raw_headings[index]
        if heading is None:
            return None
        unwrapped.append(
            unwrapped[-1]
            + wrap_radians(heading - unwrapped[-1])
        )
    headings = unwrapped
    for half_window in PATH_SMOOTH_HALF_WINDOWS:
        headings = moving_average(headings, half_window)

    slopes = []
    for index in range(count):
        lower = max(0, index - PATH_SLOPE_HALF_WINDOW)
        upper = min(count - 1, index + PATH_SLOPE_HALF_WINDOW)
        span = resampled_s[upper] - resampled_s[lower]
        slopes.append(
            0.0 if span <= 0.0 else (
                (headings[upper] - headings[lower]) / span
            )
        )

    straights = []
    run_start: int | None = None
    for index, slope in enumerate(slopes):
        flat = abs(slope) < PATH_FLAT_SLOPE
        if flat and run_start is None:
            run_start = index
        elif not flat and run_start is not None:
            if (
                resampled_s[index - 1] - resampled_s[run_start]
                >= PATH_STRAIGHT_MIN_LENGTH
            ):
                straights.append((run_start, index - 1))
            run_start = None
    if (
        run_start is not None
        and resampled_s[-1] - resampled_s[run_start]
        >= PATH_STRAIGHT_MIN_LENGTH
    ):
        straights.append((run_start, count - 1))

    return PathAnalysis(
        samples=samples,
        sample_s=sample_s,
        s=resampled_s,
        headings=headings,
        straights=straights,
        length=length,
    )


def path_prominence(
    values: list[float],
    index: int,
    left: int,
    right: int,
) -> float:
    value = values[index]
    if values[index] > values[index - 1]:
        left_minimum = value
        cursor = index
        while cursor > left:
            cursor -= 1
            if values[cursor] > value:
                break
            left_minimum = min(left_minimum, values[cursor])
        right_minimum = value
        cursor = index
        while cursor < right:
            cursor += 1
            if values[cursor] > value:
                break
            right_minimum = min(right_minimum, values[cursor])
        return value - max(left_minimum, right_minimum)

    left_maximum = value
    cursor = index
    while cursor > left:
        cursor -= 1
        if values[cursor] < value:
            break
        left_maximum = max(left_maximum, values[cursor])
    right_maximum = value
    cursor = index
    while cursor < right:
        cursor += 1
        if values[cursor] < value:
            break
        right_maximum = max(right_maximum, values[cursor])
    return min(left_maximum, right_maximum) - value


def extract_path_corners(
    analysis: PathAnalysis,
) -> list[tuple[float, float, float]]:
    corners = []
    for straight_index in range(len(analysis.straights) - 1):
        from_index = analysis.straights[straight_index][1]
        to_index = analysis.straights[straight_index + 1][0]
        if to_index - from_index < 2:
            continue

        values = analysis.headings[from_index:to_index + 1]
        distances = analysis.s[from_index:to_index + 1]
        if len(values) < 3:
            continue

        extrema = [0]
        for index in range(1, len(values) - 1):
            if (
                values[index] > values[index - 1]
                and values[index] >= values[index + 1]
            ) or (
                values[index] < values[index - 1]
                and values[index] <= values[index + 1]
            ):
                extrema.append(index)
        extrema.append(len(values) - 1)

        vertices = extrema
        while len(vertices) > 2:
            remove_at = -1
            smallest = math.inf
            for index in range(1, len(vertices) - 1):
                prominence = path_prominence(
                    values,
                    vertices[index],
                    vertices[index - 1],
                    vertices[index + 1],
                )
                if prominence < smallest:
                    smallest = prominence
                    remove_at = index
            if smallest >= math.radians(PATH_PROMINENCE_DEG):
                break
            vertices.pop(remove_at)

        for index in range(len(vertices) - 1):
            start_sample = vertices[index]
            end_sample = vertices[index + 1]
            turn = values[end_sample] - values[start_sample]
            if (
                abs(math.degrees(turn))
                < PATH_CORNER_MIN_TURN_DEG
            ):
                continue

            baseline_start = values[start_sample]
            baseline_end = values[end_sample]
            refined_start = start_sample
            refined_end = end_sample
            while (
                refined_start < refined_end - 2
                and abs(values[refined_start] - baseline_start)
                < math.radians(PATH_BOUNDARY_REFINE_DEG)
            ):
                refined_start += 1
            while (
                refined_end > refined_start + 2
                and abs(values[refined_end] - baseline_end)
                < math.radians(PATH_BOUNDARY_REFINE_DEG)
            ):
                refined_end -= 1

            start = distances[refined_start]
            end = distances[refined_end]
            if end - start < PATH_CORNER_MIN_LENGTH:
                continue
            corners.append((start, end, math.degrees(turn)))
    return corners


def path_corner_coverage(
    analysis: PathAnalysis,
    start: float,
    end: float,
) -> float | None:
    lower = bisect_left(analysis.sample_s, start)
    upper = bisect_right(analysis.sample_s, end)
    total = upper - lower
    if total < 2:
        return None
    drifting = sum(
        1
        for index in range(lower, upper)
        if analysis.samples[index]["effect"] in DRIFT_EFFECTS
    )
    return drifting / total


def measure_path_corners(
    samples: list[dict],
    track: str,
) -> list[PathCorner]:
    corners = []
    for segment in split_path_segments(samples):
        analysis = build_path_analysis(segment)
        if analysis is None:
            continue
        for start, end, heading_change_deg in extract_path_corners(analysis):
            coverage = path_corner_coverage(analysis, start, end)
            if coverage is None:
                continue
            corners.append(PathCorner(
                track=track,
                start=start,
                end=end,
                heading_change_deg=heading_change_deg,
                coverage=coverage,
            ))
    return corners


def path_corner_stats(corners: list[PathCorner]) -> dict:
    count = len(corners)
    if count == 0:
        return {
            "cornerCount": 0,
            "driftedCornerCount": 0,
            "driftedFraction": None,
            "medianCoverage": None,
        }
    drifted = sum(
        1
        for corner in corners
        if corner.coverage >= PATH_CORNER_COVERAGE_THRESHOLD
    )
    return {
        "cornerCount": count,
        "driftedCornerCount": drifted,
        "driftedFraction": stable_round(drifted / count, 4),
        "medianCoverage": stable_round(
            percentile(sorted(corner.coverage for corner in corners), 0.5),
            4,
        ),
    }


def path_corner_summary(
    corners: list[PathCorner],
    tracks: list[str],
) -> dict:
    return {
        "coverageThreshold": PATH_CORNER_COVERAGE_THRESHOLD,
        **path_corner_stats(corners),
        "tracks": {
            track: path_corner_stats([
                corner for corner in corners if corner.track == track
            ])
            for track in sorted(tracks)
        },
    }


def stable_round(value: float | None, digits: int) -> float | None:
    if value is None:
        return None
    rounded = round(value, digits)
    return 0.0 if rounded == 0.0 else rounded


def rounded_distribution(values: list[float], digits: int) -> dict:
    return {
        name: stable_round(value, digits)
        for name, value in distribution(values).items()
    }


def track_summary(
    episodes: list[EpisodeMetrics],
    replay_count: int,
    record_count: int,
) -> dict:
    return {
        "replayCount": replay_count,
        "playerRecordCount": record_count,
        "episodeCount": len(episodes),
        "duration": rounded_distribution(
            [episode.duration for episode in episodes], 3
        ),
        "retention": rounded_distribution(
            [
                episode.retention for episode in episodes
                if episode.retention is not None
            ],
            4,
        ),
        "yawRate": rounded_distribution(
            [episode.yaw_rate for episode in episodes], 3
        ),
        "sideSlip": rounded_distribution(
            [
                episode.side_slip_median for episode in episodes
                if episode.side_slip_median is not None
            ],
            3,
        ),
        "sideSlipMax": rounded_distribution(
            [
                episode.side_slip_max for episode in episodes
                if episode.side_slip_max is not None
            ],
            3,
        ),
    }


def representative_episodes(
    episodes: list[EpisodeMetrics],
    count: int,
) -> list[dict]:
    candidates = [
        episode for episode in episodes
        if episode.retention is not None
        and episode.side_slip_median is not None
    ]
    candidates.sort(key=lambda episode: (
        episode.duration,
        episode.side_slip_median,
        episode.yaw_rate,
        episode.retention,
    ))
    if not candidates:
        return []
    if len(candidates) <= count:
        chosen = candidates
    else:
        last = len(candidates) - 1
        chosen = [
            candidates[((2 * index + 1) * last) // (2 * count)]
            for index in range(count)
        ]
    return [
        {
            "duration": stable_round(episode.duration, 3),
            "retention": stable_round(episode.retention, 4),
            "yawRate": stable_round(episode.yaw_rate, 3),
            "sideSlip": stable_round(episode.side_slip_median, 3),
            "sideSlipMax": stable_round(episode.side_slip_max, 3),
        }
        for episode in chosen
    ]


def collect_files(inputs: list[Path]) -> list[Path]:
    files: set[Path] = set()
    for input_path in inputs:
        if input_path.is_dir():
            files.update(
                path.resolve()
                for path in input_path.iterdir()
                if path.is_file() and path.suffix.lower() == ".ksv"
            )
        elif input_path.is_file():
            files.add(input_path.resolve())
        else:
            raise SystemExit(f"Input does not exist: {input_path}")
    if not files:
        raise SystemExit("No KSV files found")
    return sorted(files, key=lambda path: str(path))


def build_reference(files: list[Path]) -> dict:
    replay_counts: Counter = Counter()
    record_counts: Counter = Counter()
    episodes: list[EpisodeMetrics] = []
    path_corners: list[PathCorner] = []
    record_total = 0

    for path in files:
        replay = decode_ksv(path)
        track = replay["trackName"].strip() or "unknown"
        replay_counts[track] += 1
        record_total += len(replay["records"])
        record_counts[track] += len(replay["records"])
        for record in replay["records"]:
            episodes.extend(measure_record(record["samples"], track))
            path_corners.extend(
                measure_path_corners(record["samples"], track)
            )

    if not episodes:
        raise SystemExit("No drift episodes found")

    tracks = {}
    for track in sorted(replay_counts):
        track_episodes = [
            episode for episode in episodes if episode.track == track
        ]
        tracks[track] = track_summary(
            track_episodes,
            replay_counts[track],
            record_counts[track],
        )

    corpus = {
        "trackCount": len(replay_counts),
        "replayCount": len(files),
        "playerRecordCount": record_total,
        "episodeCount": len(episodes),
        "duration": rounded_distribution(
            [episode.duration for episode in episodes], 3
        ),
        "retention": rounded_distribution(
            [
                episode.retention for episode in episodes
                if episode.retention is not None
            ],
            4,
        ),
        "yawRate": rounded_distribution(
            [episode.yaw_rate for episode in episodes], 3
        ),
        "sideSlip": rounded_distribution(
            [
                episode.side_slip_median for episode in episodes
                if episode.side_slip_median is not None
            ],
            3,
        ),
        "sideSlipMax": rounded_distribution(
            [
                episode.side_slip_max for episode in episodes
                if episode.side_slip_max is not None
            ],
            3,
        ),
    }

    return {
        "schemaVersion": 1,
        "method": {
            "sampleRateHz": SAMPLE_RATE_HZ,
            "driftEffects": sorted(DRIFT_EFFECTS),
            "maxDropoutSeconds": MAX_DROPOUT_TICKS / SAMPLE_RATE_HZ,
            "minDurationSeconds": MIN_DURATION_TICKS / SAMPLE_RATE_HZ,
            "speedWindowFrames": SPEED_WINDOW_FRAMES,
            "sideSlipSpeedFloor": SIDE_SLIP_MIN_SPEED,
            "yawRate": "absolute unwrapped heading change per second",
            "sideSlip": "absolute velocity heading minus body heading; episode median and max",
            "retention": "exit planar speed / entry planar speed",
            "speedUnits": "replay units per second; output reports ratios and rates only",
            "percentiles": "linear interpolation between closest ranks",
            "episodeSampling": "20 midpoint duration quantiles after deterministic sort",
            "pathCornerDetection": {
                "basis": "per-replay racing-line corner test, not a route-coordinate mapping to the Web track; repeated laps contribute repeated sections",
                "segmentation": "resample each continuous x/y path at fixed distance, smooth position tangents, split at straights and heading inflections",
                "coverage": "fraction of 10 Hz samples inside each corner with drift effect 2 or 3",
                "sampleStep": PATH_SAMPLE_STEP,
                "straightMinLength": PATH_STRAIGHT_MIN_LENGTH,
                "minTurnDegrees": PATH_CORNER_MIN_TURN_DEG,
                "minLength": PATH_CORNER_MIN_LENGTH,
                "coverageThreshold": PATH_CORNER_COVERAGE_THRESHOLD,
                "jumpSplit": "position jumps > max(40, 5x median step)",
            },
        },
        "units": {
            "duration": "seconds",
            "retention": "ratio",
            "yawRate": "degrees/second",
            "sideSlip": "degrees",
            "sideSlipMax": "degrees",
            "pathCornerCoverage": "ratio",
            "pathCornerDriftedFraction": "ratio",
        },
        "corpus": corpus,
        "tracks": tracks,
        "pathCorners": path_corner_summary(
            path_corners, sorted(replay_counts)
        ),
        "representativeEpisodes": representative_episodes(
            episodes, REPRESENTATIVE_EPISODE_COUNT
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build a compact drift reference from original KSV replays."
    )
    parser.add_argument(
        "--inputs",
        nargs="+",
        type=Path,
        required=True,
        help="KSV files or directories containing .ksv files",
    )
    parser.add_argument(
        "--out",
        type=Path,
        required=True,
        help="Fixture JSON output path",
    )
    args = parser.parse_args()

    files = collect_files(args.inputs)
    reference = build_reference(files)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(
        reference,
        ensure_ascii=True,
        indent=2,
        sort_keys=True,
        allow_nan=False,
    )
    args.out.write_text(text + "\n", encoding="utf-8")

    corpus = reference["corpus"]
    print(
        f"replays={corpus['replayCount']} "
        f"tracks={corpus['trackCount']} "
        f"episodes={corpus['episodeCount']}"
    )
    print(
        "median "
        f"duration={corpus['duration']['median']}s "
        f"retention={corpus['retention']['median']} "
        f"yawRate={corpus['yawRate']['median']}deg/s "
        f"sideSlip={corpus['sideSlip']['median']}deg"
    )
    path_corners = reference["pathCorners"]
    print(
        f"pathCorners={path_corners['cornerCount']} "
        f"driftedFraction={path_corners['driftedFraction']} "
        f"medianCoverage={path_corners['medianCoverage']}"
    )
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
