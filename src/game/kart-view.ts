import {
  type AnimationAction,
  AnimationMixer,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Group,
  LinearFilter,
  LoopOnce,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { KartExhaust } from "./exhaust";
import type { VehicleState } from "./vehicle";
import type { RouteSample } from "../types";

const KART_URL = "/assets/karts/cotton1/kart.gltf";
const CHARACTER_URL = "/assets/characters/dao/dao.gltf";
const RIDER_CLIPS = {
  forward: "f40",
  steerLeft: "f41",
  steerRight: "f42",
  lookBackLeft: "f46",
  lookBackRight: "f45",
};
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
  private riderActions = new Map<string, AnimationAction>();
  private activeRiderAction: AnimationAction | null = null;
  private handle: Mesh | null = null;
  private wheels: Array<Mesh | null> = [];
  private baseMatrices = new Map<Mesh, Matrix4>();
  private wheelSpin = 0;
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private shadow: Mesh | null = null;
  private exhaust: KartExhaust | null = null;
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
    const [kart, character, booster, wave, smoke] = await Promise.all([
      loader.loadAsync(KART_URL),
      loader.loadAsync(CHARACTER_URL),
      loader.loadAsync("/assets/effects/default-booster.glb"),
      loader.loadAsync("/assets/effects/default-wave.glb"),
      new TextureLoader(manager).loadAsync("/assets/effects/exhaust.png"),
    ]);

    const kartScene = this.prepareModel(kart, true);
    const characterScene = this.prepareModel(character, false);
    this.model.add(kartScene);

    // The seat node places the Y-up character rig in the kart.
    const rekart = kartScene.getObjectByName("ReKart");
    const riderRoot = characterScene.getObjectByName("char_root");
    if (rekart && riderRoot) {
      const seat = rekart.children.find((child) => child.name === "seat") ?? rekart.children[6];
      seat.add(riderRoot);
      this.rider = riderRoot;
      this.mixer = new AnimationMixer(this.rider);
      for (const name of Object.values(RIDER_CLIPS)) {
        const clip = character.animations.find((animation) => animation.name === name);
        if (!clip) continue;
        const action = this.mixer.clipAction(clip);
        if (name !== RIDER_CLIPS.forward) {
          action.setLoop(LoopOnce, 1);
          action.clampWhenFinished = true;
        }
        action.weight = name === RIDER_CLIPS.forward ? 1 : 0;
        this.riderActions.set(name, action);
      }

      const handleNode = rekart.children.find((child) => child.name === "handle");
      this.handle = (handleNode?.children[0] as Mesh | undefined) ?? null;
      this.wheels = ["wheel0", "wheel1", "wheel2", "wheel3"].map((name) => {
        const wheel = rekart.children.find((child) => child.name === name);
        return (wheel?.children[0] as Mesh | undefined) ?? null;
      });
      for (const mesh of [this.handle, ...this.wheels]) {
        if (!mesh) continue;
        mesh.updateMatrix();
        this.baseMatrices.set(mesh, mesh.matrix.clone());
        mesh.matrixAutoUpdate = false;
      }
    }

    const exhaustPort = kartScene.getObjectByName("port0");
    if (!rekart || !exhaustPort) throw new Error("Cotton1 exhaust attachment is missing");
    this.exhaust = new KartExhaust(exhaustPort, rekart, booster, wave, smoke, this.scene);
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

    this.updateRider(state, steer, dt);
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

    this.updateExhaust(state, dt);
    this.updateTrail(state);
  }

  updateExhaust(state: VehicleState, dt: number) {
    if (this.root.visible) this.exhaust?.update(state, dt);
  }

  resetTrail() {
    this.exhaust?.reset();
    this.trailStarted = false;
    this.trailVertexCount = 0;
    this.trailCursor = 0;
    this.trailGeometry.setDrawRange(0, 0);
  }

  setVisible(visible: boolean) {
    this.root.visible = visible && this.loaded;
    if (!visible) this.exhaust?.reset();
  }

  private updateRider(state: VehicleState, steer: number, dt: number) {
    let clip = RIDER_CLIPS.forward;
    if (state.speed < -0.5) {
      const keepLeft = steer === 0 && this.activeRiderAction?.getClip().name === RIDER_CLIPS.lookBackLeft;
      clip = steer < 0 || keepLeft ? RIDER_CLIPS.lookBackLeft : RIDER_CLIPS.lookBackRight;
    } else if (!state.drifting && steer !== 0) {
      clip = steer < 0 ? RIDER_CLIPS.steerLeft : RIDER_CLIPS.steerRight;
    }
    const next = this.riderActions.get(clip) ?? this.riderActions.get(RIDER_CLIPS.forward);
    if (!next || !this.mixer) return;

    if (next !== this.activeRiderAction || state.time === 0) {
      next.reset().play();
      this.activeRiderAction = next;
    }
    // Blend from the current weights so rapid steering changes can interrupt a pose smoothly.
    const blend = state.time === 0 ? 1 : 1 - Math.exp(-18 * dt);
    for (const action of this.riderActions.values()) {
      const target = action === next ? 1 : 0;
      if (action.weight === target) continue;
      action.weight += (target - action.weight) * blend;
      if (target === 0 && action.weight < 0.001) {
        action.weight = 0;
        action.stop();
      }
    }
    this.mixer.update(dt);
  }

  dispose() {
    this.scene.remove(this.root);
    this.scene.remove(this.trailMesh);
    this.trailGeometry.dispose();
    (this.trailMesh.material as MeshBasicMaterial).dispose();
    this.exhaust?.dispose();
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
