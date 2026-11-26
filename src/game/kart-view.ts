import {
  AdditiveBlending,
  AnimationMixer,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Group,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  Scene,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Texture,
  Vector3,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import type { VehicleState } from "./vehicle";
import type { RouteSample } from "../types";

const KART_URL = "/assets/karts/cotton1/kart.gltf";
const CHARACTER_URL = "/assets/characters/dao/dao.gltf";
const MAX_TRAIL_VERTICES = 4200;
const REAR_TIRE_EDGES = [-0.76, -0.48, 0.48, 0.76];

function makeMaterialShaderFlat(root: Group) {
  root.traverse((object) => {
    if (!(object instanceof Mesh)) {
      return;
    }
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!(material instanceof MeshBasicMaterial)) {
        continue;
      }
      material.toneMapped = false;
      material.fog = true;
      if (material.map) {
        material.map.colorSpace = SRGBColorSpace;
        material.map.minFilter = LinearFilter;
        material.map.needsUpdate = true;
      }
    }
  });
}

export class KartView {
  readonly root = new Group();
  readonly model = new Group();

  private scene: Scene;
  private rider: Object3D | null = null;
  private mixer: AnimationMixer | null = null;
  private handle: Mesh | null = null;
  private wheels: Array<Mesh | null> = [];
  private baseMatrices = new Map<Mesh, Matrix4>();
  private wheelSpin = 0;
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private shadow: Mesh | null = null;
  private boostFlames: Sprite[] = [];
  private driftSmoke: Sprite[] = [];
  private flameTexture: Texture | null = null;
  private smokeTexture: Texture | null = null;
  private previousYaw = 0;
  private roll = 0;
  private bounce = 0;
  private previousTread = REAR_TIRE_EDGES.map(() => new Vector3());
  private currentTread = REAR_TIRE_EDGES.map(() => new Vector3());
  private trailGeometry = new BufferGeometry();
  private trailMesh: Mesh;
  private trailPositions = new Float32Array(MAX_TRAIL_VERTICES * 3);
  private trailVertexCount = 0;
  private trailCursor = 0;
  private trailStarted = false;
  private roadNormal = new Vector3();
  private bodyForward = new Vector3();
  private bodyXAxis = new Vector3();
  private bodyBasis = new Matrix4();

  constructor(scene: Scene) {
    this.scene = scene;
    this.root.add(this.model);
    this.root.rotation.order = "YXZ";
    this.root.visible = false;
    this.shadow = this.createShadow();
    this.root.add(this.shadow);
    this.trailMesh = this.createTrail();
    this.scene.add(this.trailMesh);
    this.scene.add(this.root);
  }

  async load(onProgress?: (progress: number) => void) {
    if (this.loaded) {
      return;
    }
    if (this.loadPromise) {
      return this.loadPromise;
    }
    this.loadPromise = this.loadInternal(onProgress);
    return this.loadPromise;
  }

  private async loadInternal(onProgress?: (progress: number) => void) {
    const manager = new GLTFLoader().manager;
    manager.onProgress = (_url, loaded, total) => {
      onProgress?.(total > 0 ? loaded / total : 0);
    };
    const loader = new GLTFLoader(manager);
    const [kart, character] = await Promise.all([
      loader.loadAsync(KART_URL),
      loader.loadAsync(CHARACTER_URL),
    ]);

    const kartScene = this.prepareModel(kart, true);
    this.model.add(kartScene);

    // The official seat is Relement (sixth ReKart child). The character rides
    // with its authored f45 pose, already posed in the Y-up rider rig.
    const rekart = kartScene.getObjectByName("ReKart");
    const riderRoot = character.scene.getObjectByName("char_root");
    if (rekart && riderRoot) {
      const seat = rekart.children[6];
      seat.add(riderRoot);
      this.rider = riderRoot;
      this.mixer = new AnimationMixer(riderRoot);
      const ridePose =
        character.animations.find((animation) => animation.name === "f45") ??
        character.animations.find((animation) => animation.name === "f40") ??
        character.animations[0];
      if (ridePose) {
        const action = this.mixer.clipAction(ridePose);
        action.play();
      }

      this.handle = (rekart.children[1]?.children[0] as Mesh | undefined) ?? null;
      this.wheels = [2, 3, 4, 5].map(
        (index) => (rekart.children[index]?.children[0] as Mesh | undefined) ?? null,
      );
      for (const mesh of [this.handle, ...this.wheels]) {
        if (!mesh) continue;
        mesh.updateMatrix();
        this.baseMatrices.set(mesh, mesh.matrix.clone());
        mesh.matrixAutoUpdate = false;
      }
    }

    this.buildFlames();
    this.loaded = true;
    this.root.visible = true;
    onProgress?.(1);
  }

  update(state: VehicleState, dt: number, sample: RouteSample, steer = 0) {
    if (!this.loaded) {
      return;
    }
    this.root.position.set(state.x, state.y + 0.015, state.z);

    this.roadNormal.fromArray(sample.up).normalize();
    this.bodyXAxis.set(Math.cos(state.yaw), 0, -Math.sin(state.yaw));
    this.bodyForward.crossVectors(this.bodyXAxis, this.roadNormal).normalize();
    this.bodyXAxis.crossVectors(this.roadNormal, this.bodyForward).normalize();
    this.bodyBasis.makeBasis(this.bodyXAxis, this.roadNormal, this.bodyForward);
    this.root.quaternion.setFromRotationMatrix(this.bodyBasis);

    const yawDelta = normalizeAngle(state.yaw - this.previousYaw);
    this.previousYaw = state.yaw;
    const targetRoll = Math.max(-0.15, Math.min(0.15, -yawDelta * 3.4 - state.lateralSpeed * 0.012));
    this.roll += (targetRoll - this.roll) * Math.min(1, dt * 8);
    this.model.rotation.z = this.roll;

    const targetBounce =
      state.drifting ? Math.sin(performance.now() * 0.022) * 0.015 : 0;
    this.bounce += (targetBounce - this.bounce) * Math.min(1, dt * 12);
    this.model.position.y = this.bounce;

    this.mixer?.update(dt);
    this.wheelSpin = (this.wheelSpin + Math.abs(state.speed) * dt * 3.2) % (Math.PI * 2);
    const steerRotation = new Matrix4().makeRotationZ(-steer * 0.62);
    const spinRotation = new Matrix4().makeRotationX(this.wheelSpin);
    if (this.handle) {
      this.applyPartRotation(this.handle, steerRotation);
    }
    this.wheels.forEach((wheel, index) => {
      if (!wheel) return;
      const rotation = index < 2 ? steerRotation.clone().multiply(spinRotation) : spinRotation;
      this.applyPartRotation(wheel, rotation);
    });

    const speedScale = Math.min(1, Math.abs(state.speed) / 45);
    for (const [index, flame] of this.boostFlames.entries()) {
      const active = state.boosting || (state.drifting && speedScale > 0.4);
      flame.visible = active;
      if (active) {
        const flicker = 0.75 + Math.random() * 0.55;
        flame.scale.set(0.23 + speedScale * 0.08, (0.65 + speedScale * 0.9) * flicker, 1);
        (flame.material as SpriteMaterial).color.set(state.boosting ? "#ffb23d" : "#58d9ff");
        (flame.material as SpriteMaterial).opacity = 0.55 + Math.random() * 0.35;
        flame.position.x = (index === 0 ? -1 : 1) * 0.38;
      }
    }

    for (const smoke of this.driftSmoke) {
      smoke.visible = state.drifting && speedScale > 0.35;
      if (smoke.visible) {
        const scale = 0.6 + Math.random() * 0.8;
        smoke.scale.set(scale, scale, 1);
        (smoke.material as SpriteMaterial).opacity = 0.12 + Math.random() * 0.08;
      }
    }

    this.updateTrail(state);
  }

  resetTrail() {
    this.trailStarted = false;
    this.trailVertexCount = 0;
    this.trailCursor = 0;
    this.trailGeometry.setDrawRange(0, 0);
  }

  setVisible(visible: boolean) {
    this.root.visible = visible && this.loaded;
  }

  dispose() {
    this.scene.remove(this.root);
    this.scene.remove(this.trailMesh);
    this.trailGeometry.dispose();
    (this.trailMesh.material as MeshBasicMaterial).dispose();
    this.flameTexture?.dispose();
    this.smokeTexture?.dispose();
    this.root.traverse((object) => {
      if (object instanceof Mesh) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if (material instanceof MeshBasicMaterial && material.map) material.map.dispose();
          material.dispose();
        }
      }
    });
  }

  private prepareModel(gltf: GLTF, isKart: boolean) {
    const root = gltf.scene;
    makeMaterialShaderFlat(root);
    if (isKart) {
      root.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        object.frustumCulled = false;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          material.side = 2;
        }
      });
    } else {
      root.traverse((object) => {
        if (object instanceof Mesh) object.frustumCulled = false;
      });
    }
    return root;
  }

  private applyPartRotation(mesh: Mesh, rotation: Matrix4) {
    const base = this.baseMatrices.get(mesh);
    if (!base) return;
    mesh.matrix.copy(rotation).multiply(base);
    mesh.matrixWorldNeedsUpdate = true;
  }

  private createShadow() {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext("2d");
    if (context) {
      const gradient = context.createRadialGradient(64, 64, 3, 64, 64, 62);
      gradient.addColorStop(0, "rgba(0,0,0,.44)");
      gradient.addColorStop(0.55, "rgba(0,0,0,.22)");
      gradient.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = gradient;
      context.fillRect(0, 0, 128, 128);
    }
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const mesh = new Mesh(
      new PlaneGeometry(2.3, 3),
      new MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        opacity: 0.9,
        toneMapped: false,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.03;
    mesh.renderOrder = 2;
    return mesh;
  }

  private buildFlames() {
    if (!this.flameTexture) this.flameTexture = this.createFlameTexture();
    if (!this.smokeTexture) this.smokeTexture = this.createSmokeTexture();

    for (const offset of [-1, 1]) {
      const material = new SpriteMaterial({
        map: this.flameTexture,
        color: "#62daff",
        transparent: true,
        opacity: 0.78,
        depthWrite: false,
        blending: AdditiveBlending,
        toneMapped: false,
      });
      const flame = new Sprite(material);
      flame.position.set(offset * 0.38, 0.31, -0.88);
      flame.renderOrder = 5;
      this.model.add(flame);
      this.boostFlames.push(flame);

      const smokeMaterial = new SpriteMaterial({
        map: this.smokeTexture,
        color: "#d8f6ff",
        transparent: true,
        opacity: 0.15,
        depthWrite: false,
        toneMapped: false,
      });
      const smoke = new Sprite(smokeMaterial);
      smoke.position.set(offset * 0.62, 0.24, -0.7);
      smoke.renderOrder = 4;
      this.model.add(smoke);
      this.driftSmoke.push(smoke);
    }
  }

  private createFlameTexture() {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 128;
    const context = canvas.getContext("2d");
    if (context) {
      context.translate(32, 70);
      const gradient = context.createRadialGradient(0, 0, 3, 0, 0, 64);
      gradient.addColorStop(0, "rgba(255,255,255,1)");
      gradient.addColorStop(0.22, "rgba(255,244,190,.96)");
      gradient.addColorStop(0.5, "rgba(255,151,48,.62)");
      gradient.addColorStop(1, "rgba(255,78,16,0)");
      context.fillStyle = gradient;
      context.beginPath();
      context.ellipse(0, 0, 30, 62, 0, 0, Math.PI * 2);
      context.fill();
    }
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    return texture;
  }

  private createSmokeTexture() {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    if (context) {
      const gradient = context.createRadialGradient(32, 32, 2, 32, 32, 31);
      gradient.addColorStop(0, "rgba(255,255,255,.75)");
      gradient.addColorStop(0.55, "rgba(220,244,255,.22)");
      gradient.addColorStop(1, "rgba(220,244,255,0)");
      context.fillStyle = gradient;
      context.fillRect(0, 0, 64, 64);
    }
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    return texture;
  }

  private createTrail() {
    this.trailGeometry.setAttribute("position", new BufferAttribute(this.trailPositions, 3));
    this.trailGeometry.setDrawRange(0, 0);
    const material = new MeshBasicMaterial({
      color: "#15191b",
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      toneMapped: false,
    });
    const mesh = new Mesh(this.trailGeometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    return mesh;
  }

  private updateTrail(state: VehicleState) {
    if (!state.drifting || Math.abs(state.speed) < 4) {
      this.trailStarted = false;
      return;
    }

    for (const [index, edge] of REAR_TIRE_EDGES.entries()) {
      this.currentTread[index].set(edge, 0.03, -0.50)
        .applyQuaternion(this.root.quaternion).add(this.root.position);
    }
    if (this.trailStarted) {
      if (this.previousTread[0].distanceToSquared(this.currentTread[0]) < 0.12 ** 2) return;
      for (const edge of [0, 2]) {
        const previousInner = this.previousTread[edge];
        const previousOuter = this.previousTread[edge + 1];
        const inner = this.currentTread[edge];
        const outer = this.currentTread[edge + 1];
        for (const vertex of [previousInner, inner, previousOuter, previousOuter, inner, outer]) {
          vertex.toArray(this.trailPositions, this.trailCursor * 3);
          this.trailCursor = (this.trailCursor + 1) % MAX_TRAIL_VERTICES;
        }
      }
      this.trailVertexCount = Math.min(MAX_TRAIL_VERTICES, this.trailVertexCount + 12);
      this.trailGeometry.getAttribute("position").needsUpdate = true;
      this.trailGeometry.setDrawRange(0, this.trailVertexCount);
    }
    [this.previousTread, this.currentTread] = [this.currentTread, this.previousTread];
    this.trailStarted = true;
  }
}

function normalizeAngle(value: number) {
  let angle = value % (Math.PI * 2);
  if (angle > Math.PI) angle -= Math.PI * 2;
  if (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}
