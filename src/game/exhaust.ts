import {
  AdditiveBlending,
  type AnimationAction,
  AnimationMixer,
  type Group,
  Mesh,
  type MeshBasicMaterial,
  NumberKeyframeTrack,
  type Object3D,
  type Scene,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  type Texture,
  Vector3,
} from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import type { VehicleState } from "./vehicle";

type Atlas = {
  texture: Texture;
  frames: Array<[number, number, number]>;
  period: number;
};

interface ExhaustPuff {
  sprite: Sprite;
  direction: Vector3;
  inherited: Vector3;
  age: number;
}

const SMOKE_ALPHA = 125 / 255;
const SMOKE_LIFETIME = 0.24;

class BoosterEffect {
  readonly root: Group;
  private readonly mixer: AnimationMixer;
  private readonly action: AnimationAction;
  private readonly atlases: Atlas[] = [];

  constructor(port: Object3D, gltf: GLTF) {
    this.root = gltf.scene;
    this.root.visible = false;
    port.add(this.root);
    const clip = gltf.animations[0].clone();
    const materials = new Set<MeshBasicMaterial>();
    this.root.traverse((node) => {
      if (!(node instanceof Mesh)) return;
      node.renderOrder = 5;
      const material: MeshBasicMaterial = node.material;
      if (materials.has(material)) return;
      materials.add(material);
      material.depthWrite = false;
      material.toneMapped = false;
      if (material.userData.additive) material.blending = AdditiveBlending;
      const { uvScale, uvFrames, uvPeriodMs, opacityFrames } = material.userData;
      if (uvFrames && material.map) {
        material.map.repeat.fromArray(uvScale);
        this.atlases.push({ texture: material.map, frames: uvFrames, period: uvPeriodMs });
      }
      if (opacityFrames) {
        const keys: Array<[number, number]> = opacityFrames;
        clip.tracks.push(new NumberKeyframeTrack(
          node.uuid + ".material.opacity", keys.map(([ms]) => ms / 1000), keys.map(([, value]) => value),
        ));
      }
    });
    this.mixer = new AnimationMixer(this.root);
    this.action = this.mixer.clipAction(clip);
    this.action.play();
  }

  sample(time: number, restart: boolean) {
    if (restart) this.action.reset().play();
    this.mixer.setTime(time);
    for (const atlas of this.atlases) {
      const ms = time * 1000 % atlas.period;
      let index = 0;
      while (index + 1 < atlas.frames.length && atlas.frames[index + 1][0] <= ms) index++;
      const [, x, y] = atlas.frames[index];
      atlas.texture.offset.set(x, y);
    }
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
  }
}

export class KartExhaust {
  private readonly booster: BoosterEffect;
  private readonly wave: BoosterEffect;
  private readonly puffs: ExhaustPuff[] = [];
  private readonly lastPort = new Vector3();
  private readonly portPosition = new Vector3();
  private hasLastPort = false;
  private nextEmission = 0;
  private puffIndex = 0;
  private ignition = -1;

  constructor(
    private readonly port: Object3D,
    body: Object3D,
    booster: GLTF,
    wave: GLTF,
    private readonly smoke: Texture,
    scene: Scene,
  ) {
    this.booster = new BoosterEffect(port, booster);
    this.wave = new BoosterEffect(body, wave);

    smoke.colorSpace = SRGBColorSpace;
    for (let i = 0; i < 10; i++) {
      const sprite = new Sprite(new SpriteMaterial({
        map: smoke, color: 0xbac0c7, transparent: true,
        depthWrite: false, toneMapped: false,
      }));
      sprite.visible = false;
      sprite.renderOrder = 4;
      scene.add(sprite);
      this.puffs.push({ sprite, age: 0, direction: new Vector3(), inherited: new Vector3() });
    }
  }

  update(state: VehicleState, dt: number) {
    const lit = state.boostKind !== "none";
    this.booster.root.visible = lit;
    this.wave.root.visible = lit;
    if (lit) {
      const restart = state.boostCount !== this.ignition;
      this.ignition = state.boostCount;
      this.booster.sample(state.boostElapsed, restart);
      this.wave.sample(state.boostElapsed, restart);
      if (restart) this.resetSmoke();
      return;
    }

    this.port.updateWorldMatrix(true, false);
    this.portPosition.setFromMatrixPosition(this.port.matrixWorld);
    if (!this.hasLastPort) this.lastPort.copy(this.portPosition);
    for (const puff of this.puffs) {
      if (puff.sprite.visible) this.advancePuff(puff, dt);
    }
    // Space emissions over the travelled segment when rendering below the emission rate.
    const kmh = Math.hypot(state.speed, state.lateralSpeed) * 3.6;
    const interval = Math.max(0.01, 0.12 - kmh * 0.0003);
    this.nextEmission -= dt;
    while (this.nextEmission <= 0) {
      const age = -this.nextEmission;
      this.nextEmission += interval;
      if (age >= SMOKE_LIFETIME) continue;
      const puff = this.puffs[this.puffIndex];
      this.puffIndex = (this.puffIndex + 1) % this.puffs.length;
      puff.age = 0;
      puff.sprite.visible = true;
      puff.direction.set(Math.random() * 0.2 - 0.1, -1, Math.random() * 0.2 - 0.1)
        .transformDirection(this.port.matrixWorld);
      puff.sprite.position.copy(this.portPosition)
        .lerp(this.lastPort, dt > 0 ? age / dt : 0)
        .addScaledVector(puff.direction, Math.random() * 0.1);
      const cos = Math.cos(state.yaw);
      const sin = Math.sin(state.yaw);
      puff.inherited.set(sin * state.speed + cos * state.lateralSpeed, 0,
        cos * state.speed - sin * state.lateralSpeed);
      this.advancePuff(puff, age);
    }
    this.lastPort.copy(this.portPosition);
    this.hasLastPort = true;
  }

  private advancePuff(puff: ExhaustPuff, dt: number) {
    puff.age += dt;
    puff.sprite.visible = puff.age < SMOKE_LIFETIME;
    if (!puff.sprite.visible) return;
    puff.sprite.position.addScaledVector(puff.direction, (5 - puff.age * 0.01) * dt)
      .addScaledVector(puff.inherited, dt);
    puff.inherited.multiplyScalar(Math.pow(0.9, dt));
    puff.sprite.scale.setScalar(0.22 + 0.65 * puff.age);
    puff.sprite.material.opacity = SMOKE_ALPHA * (1 - puff.age / SMOKE_LIFETIME);
  }

  reset() {
    this.booster.root.visible = false;
    this.wave.root.visible = false;
    this.ignition = -1;
    this.resetSmoke();
  }

  private resetSmoke() {
    this.hasLastPort = false;
    this.nextEmission = 0;
    for (const puff of this.puffs) puff.sprite.visible = false;
  }

  dispose() {
    this.booster.dispose();
    this.wave.dispose();
    // KartView disposes the attached effects together with the kart meshes.
    for (const { sprite } of this.puffs) {
      sprite.removeFromParent();
      sprite.material.dispose();
    }
    this.smoke.dispose();
  }
}
