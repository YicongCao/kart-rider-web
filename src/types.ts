export type Vec3 = [number, number, number];

export interface TrackInfo {
  id: string;
  name: string;
  theme: string;
  accent: string;
  difficulty: number;
  music: string;
  card: string;
  thumb: string;
  minimap: string;
  scene: string;
  sky: string;
  route: string;
  start: Vec3;
  startYaw: number;
  skyColor: string;
  fogColor: string;
  halfWidth: number;
  length: number;
}

export interface RoutePoint {
  p: Vec3;
  f: Vec3;
  u: Vec3;
  s: number;
  curvature: number;
}

export interface RouteData {
  length: number;
  halfWidth: number;
  points: RoutePoint[];
  warp?: { from: Vec3; to: Vec3; yaw: number; gate: [Vec3, Vec3, Vec3] };
}

export interface RouteSample {
  index: number;
  segment: number;
  s: number;
  x: number;
  y: number;
  z: number;
  forward: Vec3;
  up: Vec3;
  right: Vec3;
  lateral: number;
  roadWidth: number;
  onRoad: boolean;
}

export interface KartInput {
  throttle: boolean;
  brake: boolean;
  steer: number;
  drift: boolean;
  boost: boolean;
}

export interface KartSnapshot {
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
  forwardSpeed: number;
  lateralSpeed: number;
  gauge: number;
  boosting: boolean;
  boostTimeLeft: number;
  drifting: boolean;
  driftPhase: "none" | "trigger" | "active" | "decay";
  driftCharge: number;
  wallHit: number;
  startBoost: boolean;
}

export interface RaceLap {
  number: number;
  time: number;
}

export interface TrackRecord {
  bestTime: number | null;
  bestLap: number | null;
  runs: number;
}

export type RacePhase = "menu" | "loading" | "countdown" | "racing" | "paused" | "finished";
