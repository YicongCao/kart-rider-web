import type { BodyAxes, Vec3 } from "./original-kinematics";

/**
 * Four-wheel support spring recovered from P3563 FUN_00B53380.
 *
 * The live P3563 contact sample reports 2940 N/m spring strength, zero
 * compression damping and 588 N/(m/s) rebound damping. At rest each wheel
 * carries 0.5 m of compression, giving 5880 N total against the native
 * 58.8 m/s^2 world gravity.
 */
export const ORIGINAL_SPRING_STRENGTH = 2940;
export const ORIGINAL_COMPRESSION_DAMPING = 0;
export const ORIGINAL_REBOUND_DAMPING = 588;
export const ORIGINAL_REST_COMPRESSION = 0.5;
/** B52240 reads these race-kart dimensions and the wheel inset separately. */
export const ORIGINAL_SUPPORT_HALF_WIDTH = 0.7667911648750305;
export const ORIGINAL_SUPPORT_HALF_LENGTH = 0.8172281980514526;
export const ORIGINAL_SUPPORT_PROBE_INSET = 0.8;
/** Chassis centre of mass above the wheel contact patch, in metres. */
export const ORIGINAL_CONTACT_HEIGHT = 0.5;
/**
 * P3563 B53380 applies a 0.1 scale to the torque from the signed body
 * half-width and half-length. B52240 uses the inset for the wheel rays.
 */
export const ORIGINAL_SUPPORT_TORQUE_SCALE = 0.1;
export const ORIGINAL_WHEEL_SIGNS = [
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
] as const;

export interface WheelSupportSample {
  active: boolean;
  compression: number;
  /** Ground normal, in the Web world basis. */
  normal: Vec3;
}

export interface SupportForceOutput {
  /** World-space force, accumulated on the chassis centre of mass. */
  force: Vec3;
  /**
   * Body-local torque in the Web body basis (X right, Y up, Z forward).
   * The native torque is stored in the original [right, forward, up] basis;
   * its roll component is sign-flipped when mapped to Web +Z.
   */
  torque: Vec3;
}

/**
 * P3563 applies each loaded spring along the chassis up axis, scaled by the
 * ground-normal projection. The chassis offset therefore creates the real
 * load-transfer torque rather than a separate fitted roll spring.
 */
export function computeOriginalSupportForces(
  axes: BodyAxes,
  samples: readonly WheelSupportSample[],
  previousCompressions: readonly number[],
  deltaSeconds: number,
): SupportForceOutput {
  const force = { x: 0, y: 0, z: 0 };
  const torque = { x: 0, y: 0, z: 0 };
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    if (!sample?.active) continue;
    const compressionVelocity = deltaSeconds > 0
      ? (sample.compression - previousCompressions[index]) / deltaSeconds
      : 0;
    const damping = compressionVelocity <= 0
      ? ORIGINAL_REBOUND_DAMPING
      : ORIGINAL_COMPRESSION_DAMPING;
    const springForce = Math.max(
      0,
      ORIGINAL_SPRING_STRENGTH * sample.compression +
        damping * compressionVelocity,
    );
    const normalProjection =
      sample.normal.x * axes.up.x +
      sample.normal.y * axes.up.y +
      sample.normal.z * axes.up.z;
    const magnitude = springForce * Math.max(0, normalProjection);
    const wheelForce = {
      x: axes.up.x * magnitude,
      y: axes.up.y * magnitude,
      z: axes.up.z * magnitude,
    };
    const [signRight, signForward] = ORIGINAL_WHEEL_SIGNS[index];
    const torqueScale = ORIGINAL_SUPPORT_TORQUE_SCALE * magnitude;
    force.x += wheelForce.x;
    force.y += wheelForce.y;
    force.z += wheelForce.z;
    // Native local axes are [right, forward, up]. Support torque has no yaw
    // component; the Web roll axis is +Z, opposite the native +forward axis.
    torque.x += -torqueScale * ORIGINAL_SUPPORT_HALF_LENGTH * signForward;
    torque.z += torqueScale * ORIGINAL_SUPPORT_HALF_WIDTH * signRight;
  }
  return { force, torque };
}
