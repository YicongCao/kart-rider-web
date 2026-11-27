// P3563 reports a 58.8 m/s^2 ground-support gravity, but the recovered
// records do not include a jump. Keep the existing Web ballistic gravity for
// airborne motion so the evidence-backed contact model does not silently
// change the established ramp and ravine trajectories.
const GRAVITY = 9.81;
const CONTACT_TOLERANCE = 0.018;
const LANDING_REACH = 0.16;
const MAX_STEP_UP = 0.65;
const FRONT_AXLE = 0.435;
const REAR_AXLE = -0.497;
const FRONT_HALF_TRACK = 0.460;
const REAR_HALF_TRACK = 0.434;
const GAP_PROBE_DISTANCE = 18;
export const WHEEL_OFFSETS = [
  [FRONT_HALF_TRACK, FRONT_AXLE],
  [-FRONT_HALF_TRACK, FRONT_AXLE],
  [REAR_HALF_TRACK, REAR_AXLE],
  [-REAR_HALF_TRACK, REAR_AXLE],
] as const;

type GroundProbe = (x: number, z: number, height: number, ceiling: number) => number | null;

class Spring {
  value = 0;
  velocity = 0;

  reset(value = 0) {
    this.value = value;
    this.velocity = 0;
  }

  step(target: number, frequency: number, damping: number, dt: number) {
    this.velocity += ((target - this.value) * frequency ** 2 - 2 * damping * frequency * this.velocity) * dt;
    this.value += this.velocity * dt;
  }
}

export class KartSuspension {
  grounded = true;
  frontContact = 1;
  rearContact = 1;
  verticalSpeed = 0;
  surfaceHeight: number | null = null;
  readonly pitch = new Spring();
  readonly roll = new Spring();
  readonly heave = new Spring();
  private readonly wheelHeights: Array<number | null> = [null, null, null, null];
  private launchOffset = 0;
  private rideHeight = 0;
  private groundSlope = 0;
  private groundBank = 0;

  reset(surfaceHeight: number | null = null) {
    this.grounded = true;
    this.frontContact = 1;
    this.rearContact = 1;
    this.verticalSpeed = 0;
    this.surfaceHeight = surfaceHeight;
    this.wheelHeights.fill(null);
    this.launchOffset = 0;
    this.rideHeight = 0;
    this.groundSlope = 0;
    this.groundBank = 0;
    this.pitch.reset();
    this.roll.reset();
    this.heave.reset();
  }

  groundNormal(yaw: number) {
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const length = Math.hypot(1, this.groundSlope, this.groundBank);
    return {
      x: (-this.groundBank * cos - this.groundSlope * sin) / length,
      y: 1 / length,
      z: (this.groundBank * sin - this.groundSlope * cos) / length,
    };
  }

  travel() {
    return this.wheelHeights.map((height, index) => {
      if (!this.grounded) return -0.055;
      if (height === null) return 0;
      const [right, forward] = WHEEL_OFFSETS[index];
      const wheelPlane = this.rideHeight + this.heave.value +
        Math.sin(this.pitch.value) * forward + Math.sin(this.roll.value) * right;
      return Math.max(-0.12, Math.min(0.12, height - wheelPlane));
    });
  }

  step(x: number, y: number, z: number, yaw: number, speed: number, lateral: number, probe: GroundProbe, dt: number) {
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    let projectedVelocity = this.verticalSpeed - GRAVITY * dt;
    const projectedY = y + projectedVelocity * dt;
    const ceiling = this.grounded ? y + MAX_STEP_UP : Math.max(y, projectedY) + LANDING_REACH;
    const sample = (sampleX: number, sampleZ: number) => {
      const height = probe(sampleX, sampleZ, y, ceiling);
      return height !== null && height <= ceiling ? height : null;
    };
    const center = sample(x, z);
    for (const [index, [right, forward]] of WHEEL_OFFSETS.entries()) {
      this.wheelHeights[index] = sample(x + right * cos + forward * sin, z - right * sin + forward * cos);
    }
    const [frontRight, frontLeft, rearRight, rearLeft] = this.wheelHeights;
    const front = frontRight !== null && frontLeft !== null ? (frontRight + frontLeft) / 2 : frontRight ?? frontLeft;
    const rear = rearRight !== null && rearLeft !== null ? (rearRight + rearLeft) / 2 : rearRight ?? rearLeft;
    const slope = front !== null && rear !== null ? (front - rear) / (FRONT_AXLE - REAR_AXLE) : null;
    const frontBank = frontRight !== null && frontLeft !== null ? (frontRight - frontLeft) / (2 * FRONT_HALF_TRACK) : null;
    const rearBank = rearRight !== null && rearLeft !== null ? (rearRight - rearLeft) / (2 * REAR_HALF_TRACK) : null;
    const bank = frontBank !== null && rearBank !== null ? (frontBank + rearBank) / 2 : frontBank ?? rearBank;
    const wheelPlane = front !== null && rear !== null && slope !== null ? front - slope * FRONT_AXLE : null;
    const support = (wheelPlane !== null && center !== null
      ? Math.max(center - 0.09, Math.min(center + 0.09, wheelPlane)) : wheelPlane ?? center) ??
      (front !== null ? front - this.groundSlope * FRONT_AXLE :
        rear !== null ? rear - this.groundSlope * REAR_AXLE : null);
    this.surfaceHeight = center ?? support;

    if (support !== null && support >= projectedY - CONTACT_TOLERANCE &&
      (this.grounded || (projectedVelocity <= 0 && support <= y + LANDING_REACH))) {
      if (!this.grounded) {
        this.heave.velocity += Math.max(-5, projectedVelocity * 0.32);
      } else {
        const heightChange = support - y - this.verticalSpeed * dt;
        this.heave.value -= Math.max(-0.12, Math.min(0.12, heightChange));
      }
      this.grounded = true;
      this.launchOffset = 0;
      this.rideHeight = support;
      this.groundSlope = slope ?? this.groundSlope;
      this.groundBank = bank ?? this.groundBank;
      const touches = (height: number | null, right: number, forward: number) =>
        Number(height !== null && height >= support + this.groundSlope * forward + this.groundBank * right - 0.23);
      this.frontContact = (touches(frontRight, FRONT_HALF_TRACK, FRONT_AXLE) +
        touches(frontLeft, -FRONT_HALF_TRACK, FRONT_AXLE)) / 2;
      this.rearContact = (touches(rearRight, REAR_HALF_TRACK, REAR_AXLE) +
        touches(rearLeft, -REAR_HALF_TRACK, REAR_AXLE)) / 2;
      this.verticalSpeed = this.groundSlope * speed + this.groundBank * lateral;
      this.pitch.step(Math.atan(this.groundSlope), 24, 0.69, dt);
      this.roll.step(Math.atan(this.groundBank), 26, 0.72, dt);
      y = support;
    } else {
      if (this.grounded) {
        if (speed >= 20) {
          const launchSpeed = this.gapLaunchSpeed(x, y, z, sin, cos, speed, lateral, probe);
          projectedVelocity = Math.max(projectedVelocity, launchSpeed);
        }
        this.launchOffset = this.pitch.value - Math.atan2(projectedVelocity, Math.abs(speed));
      }
      this.grounded = false;
      this.frontContact = 0;
      this.rearContact = 0;
      this.verticalSpeed = projectedVelocity;
      this.launchOffset *= Math.exp(-3 * dt);
      const airPitch = Math.max(-0.48, Math.min(0.48, Math.atan2(this.verticalSpeed, Math.max(5, Math.abs(speed)))));
      this.pitch.step(airPitch + this.launchOffset, 12, 0.9, dt);
      this.roll.step(0, 7, 0.9, dt);
      y += projectedVelocity * dt;
    }
    this.heave.step(0, 26, 0.65, dt);
    this.heave.value = Math.max(-0.16, Math.min(0.16, this.heave.value));
    return y;
  }

  private gapLaunchSpeed(
    x: number, y: number, z: number, sin: number, cos: number, speed: number, lateral: number, probe: GroundProbe,
  ) {
    const planarSpeed = Math.hypot(speed, lateral);
    const directionX = (sin * speed + cos * lateral) / planarSpeed;
    const directionZ = (cos * speed - sin * lateral) / planarSpeed;
    let gapStart = 0;
    for (let distance = 1; distance <= GAP_PROBE_DISTANCE; distance += 0.5) {
      const landing = probe(x + directionX * distance, z + directionZ * distance, y, y + MAX_STEP_UP);
      if (landing === null || landing < y - 1.1) {
        if (!gapStart) gapStart = distance;
        continue;
      }
      if (!gapStart) {
        if (distance >= 3) break;
        continue;
      }
      if (distance - gapStart < 3) break;
      const flightTime = distance / planarSpeed * 1.08;
      const velocity = Math.max(0.3, (landing - y + 0.28) / flightTime + GRAVITY * flightTime / 2);
      return velocity <= 3.6 ? velocity : -Infinity;
    }
    return -Infinity;
  }
}
