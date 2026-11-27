/**
 * Rigid-body kinematics recovered from the original kart simulation.
 *
 * The original keeps a world-space linear velocity, a body-local angular
 * velocity, and a unit quaternion. World forces are accumulated in world
 * space, while drag and lateral tire torques are evaluated in the body frame.
 * Keeping the same split matters because roll changes the horizontal
 * projection of the tire force vector.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  w: number;
  x: number;
  y: number;
  z: number;
}

export interface BodyAxes {
  right: Vec3;
  forward: Vec3;
  up: Vec3;
}

export const ORIGINAL_WORLD_GRAVITY = -58.8;
export const ORIGINAL_MINIMUM_UP_Z = 0.5;

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function addVec3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function scaleVec3(value: Vec3, amount: number): Vec3 {
  return { x: value.x * amount, y: value.y * amount, z: value.z * amount };
}

export function dotVec3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function crossVec3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function normalizeVec3(value: Vec3): Vec3 {
  const length = Math.hypot(value.x, value.y, value.z);
  return length > 0
    ? scaleVec3(value, 1 / length)
    : { x: 0, y: 0, z: 0 };
}

/**
 * Body axes in the Web basis: local +X is right, +Y is up, +Z is forward.
 * This is the standard right-handed quaternion matrix; the original uses the
 * same rotation with its forward/up basis relabelled.
 */
export function bodyAxes(orientation: Quat): BodyAxes {
  const { w, x, y, z } = orientation;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return {
    right: {
      x: 1 - 2 * (yy + zz),
      y: 2 * (xy + wz),
      z: 2 * (xz - wy),
    },
    up: {
      x: 2 * (xy - wz),
      y: 1 - 2 * (xx + zz),
      z: 2 * (yz + wx),
    },
    forward: {
      x: 2 * (xz + wy),
      y: 2 * (yz - wx),
      z: 1 - 2 * (xx + yy),
    },
  };
}

/**
 * Quaternion derivative for a body-local angular velocity, followed by
 * normalization. This is the original `quat_integrate_local`.
 */
export function integrateOrientation(
  orientation: Quat,
  angularVelocity: Vec3,
  deltaSeconds: number,
): Quat {
  const half = deltaSeconds * 0.5;
  const { w, x, y, z } = orientation;
  const omega = angularVelocity;
  let next: Quat = {
    w: w + (-x * omega.x - y * omega.y - z * omega.z) * half,
    x: x + (y * omega.z + w * omega.x - z * omega.y) * half,
    y: y + (z * omega.x + w * omega.y - x * omega.z) * half,
    z: z + (x * omega.y + w * omega.z - y * omega.x) * half,
  };
  const length = Math.hypot(next.w, next.x, next.y, next.z);
  if (length > 0) {
    next = {
      w: next.w / length,
      x: next.x / length,
      y: next.y / length,
      z: next.z / length,
    };
  }
  return next;
}

export interface PoseOutput {
  position: Vec3;
  orientation: Quat;
  angularVelocity: Vec3;
  upZ: number;
  tiltRetries: number;
  tiltClamped: boolean;
}

/**
 * Original 0x00430ed0: integrate position, orientation, and clamp a body that
 * has rolled past the 60-degree upright limit.
 */
export function integratePose(
  position: Vec3,
  orientation: Quat,
  linearVelocity: Vec3,
  angularVelocity: Vec3,
  deltaSeconds: number,
): PoseOutput {
  let nextPosition = addVec3(
    position,
    scaleVec3(linearVelocity, deltaSeconds),
  );
  let nextAngular = { ...angularVelocity };
  let nextOrientation = integrateOrientation(
    orientation,
    nextAngular,
    deltaSeconds,
  );
  let upZ = bodyAxes(nextOrientation).up.y;
  let tiltRetries = 0;

  for (let retry = 0; retry < 3 && upZ < ORIGINAL_MINIMUM_UP_Z; retry++) {
    nextAngular.x *= 0.1;
    nextAngular.z *= 0.1;
    nextOrientation = integrateOrientation(
      orientation,
      nextAngular,
      deltaSeconds,
    );
    upZ = bodyAxes(nextOrientation).up.y;
    tiltRetries += 1;
  }

  let tiltClamped = false;
  if (upZ < ORIGINAL_MINIMUM_UP_Z) {
    nextAngular.x = 0;
    nextAngular.z = 0;
    nextOrientation = integrateOrientation(
      orientation,
      nextAngular,
      deltaSeconds,
    );
    upZ = bodyAxes(nextOrientation).up.y;
    tiltClamped = true;
  }

  return {
    position: nextPosition,
    orientation: nextOrientation,
    angularVelocity: nextAngular,
    upZ,
    tiltRetries,
    tiltClamped,
  };
}

/** Diagonal inverse inertia `12 / mass`, as in the original 0x0042e5d5. */
export function inverseInertiaDiagonal(mass: number): number {
  return mass > 0 ? 12 / mass : 0;
}

/**
 * Angular half of the original integrator. The inertia is isotropic, so the
 * gyroscopic term is only retained for completeness.
 */
export function integrateAngularVelocity(
  angularVelocity: Vec3,
  torque: Vec3,
  inverseInertia: number,
  deltaSeconds: number,
): Vec3 {
  const inertiaVelocity = scaleVec3(angularVelocity, inverseInertia);
  const gyroscopic = crossVec3(angularVelocity, inertiaVelocity);
  const effectiveTorque = addVec3(torque, scaleVec3(gyroscopic, -1));
  return addVec3(
    angularVelocity,
    scaleVec3(effectiveTorque, inverseInertia * deltaSeconds),
  );
}

export interface DragOutput {
  force: Vec3;
  torque: Vec3;
}

/**
 * Original 0x00430640. Quadratic ground drag uses the full world speed and
 * acts opposite the world velocity; air friction also damps angular velocity.
 */
export function computeDrag(
  linearVelocity: Vec3,
  angularVelocity: Vec3,
  airFriction: number,
  dragFactor: number,
  grounded: boolean,
  groundedDragScale: number,
): DragOutput {
  const speed = Math.hypot(
    linearVelocity.x,
    linearVelocity.y,
    linearVelocity.z,
  );
  const factor = airFriction +
    (grounded ? speed * dragFactor * groundedDragScale : 0);
  return {
    force: scaleVec3(linearVelocity, -factor),
    torque: scaleVec3(angularVelocity, -airFriction),
  };
}

/**
 * Convert the Web simulator's yaw convention into the original quaternion
 * basis. Web forward is +Z at yaw 0 and right is +X, so a positive yaw is a
 * rotation around +Y.
 */
export function quatFromYaw(yaw: number): Quat {
  const half = yaw * 0.5;
  return { w: Math.cos(half), x: 0, y: Math.sin(half), z: 0 };
}

/**
 * Yaw followed by a positive roll around the body forward (+Z) axis. This is
 * the planar subset used by the Web kart; the original's full quaternion is
 * still exercised by the trajectory oracle.
 */
export function quatFromYawRoll(yaw: number, roll: number): Quat {
  const yawHalf = yaw * 0.5;
  const rollHalf = roll * 0.5;
  const cy = Math.cos(yawHalf);
  const sy = Math.sin(yawHalf);
  const cr = Math.cos(rollHalf);
  const sr = Math.sin(rollHalf);
  // q = qYaw * qRoll (local +Z roll after the world yaw).
  return {
    w: cy * cr,
    x: -sy * sr,
    y: sy * cr,
    z: cy * sr,
  };
}

export function yawFromOrientation(orientation: Quat): number {
  const { forward } = bodyAxes(orientation);
  return Math.atan2(forward.x, forward.z);
}

export function rollFromOrientation(orientation: Quat): number {
  return Math.asin(
    Math.max(-1, Math.min(1, bodyAxes(orientation).right.y)),
  );
}
