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
  /** Last road sample before a discontinuous transfer to the next sample. */
  readonly warpIndex: number;

  constructor(data: RouteData, grid?: Vec3) {
    this.length = data.length;
    this.halfWidth = data.halfWidth;
    let startIndex = 0;
    if (grid) {
      let closest = Infinity;
      for (const [index, point] of data.points.entries()) {
        const [x, y, z] = point.p;
        const distance = (x - grid[0]) ** 2 + (y - grid[1]) ** 2 + (z - grid[2]) ** 2;
        if (distance < closest) {
          closest = distance;
          startIndex = index;
        }
      }
    }
    this.points = data.points;
    if (startIndex > 0) {
      const startS = data.points[startIndex].s;
      const ordered = data.points.slice(startIndex).concat(data.points.slice(0, startIndex));
      this.points = ordered.map((point) => ({
        ...point,
        s: point.s >= startS ? point.s - startS : point.s + data.length - startS,
      }));
    }
    this.data = { ...data, points: this.points };
    const departure = data.warp?.from;
    this.warpIndex = departure
      ? this.points.findIndex(({ p }) => p.every((v, i) => Math.abs(v - departure[i]) < 0.01))
      : -1;
  }

  pointAt(index: number) {
    return this.points[wrapIndex(index, this.points.length)];
  }

  /** Test the swept kart position against the finite warpnext gate, in race direction. */
  crossesWarp(previous: Vec3, current: Vec3) {
    const warp = this.data.warp;
    if (!warp || this.warpIndex < 0) return false;
    const [a, b, top] = warp.gate;
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const forward = this.points[this.warpIndex].f;
    const sign = Math.sign(dz * forward[0] - dx * forward[2]);
    const distance = (p: Vec3) => sign * ((p[0] - a[0]) * dz - (p[2] - a[2]) * dx);
    const before = distance(previous);
    const after = distance(current);
    if (before > 0 || after <= 0) return false;
    const t = before / (before - after);
    const x = lerp(previous[0], current[0], t) - a[0];
    const z = lerp(previous[2], current[2], t) - a[2];
    const u = (x * dx + z * dz) / (dx * dx + dz * dz);
    const y = lerp(previous[1], current[1], t);
    return u >= 0 && u <= 1 && y >= Math.min(a[1], b[1]) - 1 && y <= top[1];
  }

  query(x: number, z: number, hint = -1, height?: number): RouteSample {
    const count = this.points.length;
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    const first = hint >= 0 ? hint - 48 : 0;
    const last = hint >= 0 ? hint + 48 : count - 1;
    for (let i = first; i <= last; i++) {
      const index = wrapIndex(i, count);
      const point = this.points[index].p;
      const dx = x - point[0];
      const dz = z - point[2];
      const dy = height === undefined ? 0 : height - point[1];
      const distance = dx * dx + dy * dy + dz * dz;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }

    let bestSegment = bestIndex;
    let bestSegmentDistance = Number.POSITIVE_INFINITY;
    let bestT = 0;

    for (const startIndex of [bestIndex, wrapIndex(bestIndex - 1, count)]) {
      if (startIndex === this.warpIndex) continue;
      const endIndex = wrapIndex(startIndex + 1, count);
      const start = this.points[startIndex].p;
      const end = this.points[endIndex].p;
      const segmentX = end[0] - start[0];
      const segmentY = height === undefined ? 0 : end[1] - start[1];
      const segmentZ = end[2] - start[2];
      const segmentLengthSq = segmentX * segmentX + segmentY * segmentY + segmentZ * segmentZ;
      const dy = height === undefined ? 0 : height - start[1];
      const along = (x - start[0]) * segmentX + dy * segmentY + (z - start[2]) * segmentZ;
      const t =
        segmentLengthSq > 1e-9
          ? Math.max(0, Math.min(1, along / segmentLengthSq))
          : 0;
      const pointX = start[0] + segmentX * t;
      const pointZ = start[2] + segmentZ * t;
      const distance = (x - pointX) ** 2 + (dy - segmentY * t) ** 2 + (z - pointZ) ** 2;
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

    const segmentEnd = bestSegment === count - 1 ? this.length : b.s;

    return {
      index: bestSegment,
      segment: bestSegment,
      s: lerp(a.s, segmentEnd, bestT) % this.length,
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
