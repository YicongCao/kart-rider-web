import type { RouteData, RouteSample, Vec3 } from "../types";

const wrapIndex = (value: number, size: number) => ((value % size) + size) % size;

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function normalize(vector: Vec3): Vec3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * A closed, arc-length sampled racing line. Queries are resolved against a
 * local window when a hint is supplied so overpasses never snap to a
 * geometrically nearby but distant part of the course.
 */
export class Route {
  readonly data: RouteData;
  readonly points: RouteData["points"];
  readonly length: number;
  readonly halfWidth: number;

  private readonly cumulative: number[] = [0];

  constructor(data: RouteData) {
    this.data = data;
    this.points = data.points;
    this.length = data.length;
    this.halfWidth = data.halfWidth;

    for (let index = 1; index < this.points.length; index += 1) {
      const previous = this.points[index - 1].p;
      const current = this.points[index].p;
      this.cumulative.push(
        this.cumulative[index - 1] +
          Math.hypot(
            current[0] - previous[0],
            current[1] - previous[1],
            current[2] - previous[2],
          ),
      );
    }
  }

  pointAt(index: number) {
    return this.points[wrapIndex(index, this.points.length)];
  }

  query(x: number, z: number, hint = -1): RouteSample {
    const count = this.points.length;
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    if (hint >= 0) {
      for (let offset = -48; offset <= 48; offset += 1) {
        const index = wrapIndex(hint + offset, count);
        const point = this.points[index].p;
        const dx = x - point[0];
        const dz = z - point[2];
        const distance = dx * dx + dz * dz;
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      }
    } else {
      for (let index = 0; index < count; index += 1) {
        const point = this.points[index].p;
        const dx = x - point[0];
        const dz = z - point[2];
        const distance = dx * dx + dz * dz;
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      }
    }

    let bestSegment = bestIndex;
    let bestSegmentDistance = Number.POSITIVE_INFINITY;
    let bestT = 0;

    for (const startIndex of [wrapIndex(bestIndex - 1, count), bestIndex]) {
      const endIndex = wrapIndex(startIndex + 1, count);
      const start = this.points[startIndex].p;
      const end = this.points[endIndex].p;
      const segmentX = end[0] - start[0];
      const segmentZ = end[2] - start[2];
      const segmentLengthSq = segmentX * segmentX + segmentZ * segmentZ;
      const t =
        segmentLengthSq > 1e-9
          ? Math.max(0, Math.min(1, ((x - start[0]) * segmentX + (z - start[2]) * segmentZ) / segmentLengthSq))
          : 0;
      const pointX = start[0] + segmentX * t;
      const pointZ = start[2] + segmentZ * t;
      const distance = (x - pointX) ** 2 + (z - pointZ) ** 2;
      if (distance < bestSegmentDistance) {
        bestSegmentDistance = distance;
        bestSegment = startIndex;
        bestT = t;
      }
    }

    const a = this.points[bestSegment];
    const b = this.pointAt(bestSegment + 1);
    const forward = normalize([
      lerp(a.f[0], b.f[0], bestT),
      lerp(a.f[1], b.f[1], bestT),
      lerp(a.f[2], b.f[2], bestT),
    ]);
    const up = normalize([
      lerp(a.u[0], b.u[0], bestT),
      lerp(a.u[1], b.u[1], bestT),
      lerp(a.u[2], b.u[2], bestT),
    ]);
    const right = normalize(cross(forward, up));
    const centerX = lerp(a.p[0], b.p[0], bestT);
    const centerY = lerp(a.p[1], b.p[1], bestT);
    const centerZ = lerp(a.p[2], b.p[2], bestT);
    const lateral = (x - centerX) * right[0] + (z - centerZ) * right[2];

    let segmentStart = a.s;
    let segmentEnd = b.s;
    if (segmentEnd <= segmentStart) {
      segmentStart = this.cumulative[bestSegment];
      segmentEnd = this.cumulative[bestSegment + 1] ?? this.length;
    }

    return {
      index: bestSegment,
      segment: bestSegment,
      s: lerp(segmentStart, segmentEnd, bestT),
      x: centerX,
      y: centerY,
      z: centerZ,
      forward,
      up,
      right,
      lateral,
      roadWidth: this.halfWidth,
      onRoad: Math.abs(lateral) <= this.halfWidth,
    };
  }

  progressAt(index: number) {
    return this.points[wrapIndex(index, this.points.length)].s;
  }

  startYaw() {
    const forward = this.points[0].f;
    return Math.atan2(forward[0], forward[2]);
  }
}
