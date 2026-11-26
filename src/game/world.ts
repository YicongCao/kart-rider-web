import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Fog,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  SRGBColorSpace,
  Scene,
  Texture,
  WebGLRenderer,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import type { RouteData, TrackInfo } from "../types";
import { Route } from "./route";

export interface MinimapProjection {
  centerX: number;
  centerY: number;
  scale: number;
  width: number;
  height: number;
  path: string;
}

export interface TrackLoadResult {
  route: Route;
  minimap: MinimapProjection;
}

interface WeatherCue {
  color: string;
  blending: typeof NormalBlending | typeof AdditiveBlending;
  size: number;
  opacity: number;
  gravity: number;
  driftX: number;
  driftZ: number;
}

function weatherFor(theme: string): WeatherCue {
  if (theme === "冰山") {
    return {
      color: "#ffffff",
      blending: NormalBlending,
      size: 0.34,
      opacity: 0.68,
      gravity: 2.4,
      driftX: 0.9,
      driftZ: 0.2,
    };
  }
  if (theme === "沙漠") {
    return {
      color: "#f5d29d",
      blending: NormalBlending,
      size: 0.2,
      opacity: 0.42,
      gravity: 0.06,
      driftX: 4.2,
      driftZ: 0.6,
    };
  }
  if (theme === "森林") {
    return {
      color: "#d9ff8f",
      blending: AdditiveBlending,
      size: 0.3,
      opacity: 0.48,
      gravity: 0.55,
      driftX: 0.7,
      driftZ: 0.5,
    };
  }
  return {
    color: "#e8fbff",
    blending: NormalBlending,
    size: 0.16,
    opacity: 0.42,
    gravity: 0.35,
    driftX: 0.25,
    driftZ: 0.2,
  };
}

export class RaceWorld {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly trackRoot = new Group();
  readonly skyRoot = new Group();
  readonly weatherRoot = new Group();

  route: Route | null = null;
  minimap: MinimapProjection | null = null;
  track: TrackInfo | null = null;

  private currentTrackScene: Group | null = null;
  private currentSkyScene: Group | null = null;
  private weather: Points | null = null;
  private weatherPositions: Float32Array | null = null;
  private weatherVelocity: Float32Array | null = null;
  private weatherCue: WeatherCue | null = null;
  private particleTexture: Texture | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor("#0b1e2b", 1);

    this.camera = new PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.08, 12000);
    this.camera.position.set(0, 3, -8);

    this.scene.add(this.trackRoot);
    this.scene.add(this.weatherRoot);
    this.scene.add(this.skyRoot);
    this.skyRoot.renderOrder = -1000;
    this.skyRoot.frustumCulled = false;

    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(document.body);
  }

  async load(
    track: TrackInfo,
    onProgress: (progress: number, hint: string) => void,
  ): Promise<TrackLoadResult> {
    this.unloadTrack();
    this.track = track;
    this.scene.background = new Color(track.skyColor);
    this.scene.fog = new Fog(track.fogColor, 280, track.id === "ice" ? 1600 : 2100);

    let reported = 0;
    const manager = new GLTFLoader().manager;
    manager.onProgress = (url, loaded, total) => {
      const raw = total > 0 ? loaded / total : 0;
      reported = Math.max(reported, raw * 0.88);
      onProgress(
        reported,
        /\.(png|dds|tga)$/i.test(url) ? "加载贴图" : "构建赛道",
      );
    };

    const loader = new GLTFLoader(manager);
    const [trackGltf, skyGltf, routeResponse] = await Promise.all([
      loader.loadAsync(`/assets/${track.scene}`),
      loader.loadAsync(`/assets/${track.sky}`),
      fetch(`/assets/${track.route}`),
    ]);

    if (!routeResponse.ok) {
      throw new Error("赛道数据读取失败");
    }
    const routeData = (await routeResponse.json()) as RouteData;
    this.route = new Route(routeData, track.start);
    this.minimap = this.buildMinimapProjection(this.route.data);

    reported = Math.max(reported, 0.94);
    onProgress(reported, "准备起跑");

    this.prepareTrack(trackGltf);
    this.prepareSky(skyGltf);
    this.buildWeather(track.theme);
    onProgress(1, "准备起跑");

    return { route: this.route, minimap: this.minimap };
  }

  update(delta: number) {
    this.skyRoot.position.copy(this.camera.position);
    this.weatherRoot.position.copy(this.camera.position);
    this.updateWeather(delta);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.unloadTrack();
    this.renderer.dispose();
  }

  private prepareTrack(gltf: GLTF) {
    this.currentTrackScene = gltf.scene;
    const anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    let adIndex = 0;

    gltf.scene.traverse((object) => {
      if (!(object instanceof Mesh)) {
        return;
      }
      object.castShadow = false;
      object.receiveShadow = false;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!(material instanceof MeshBasicMaterial)) {
          continue;
        }
        const materialName = String(material.name ?? "");
        if (material.map) {
          material.map.colorSpace = SRGBColorSpace;
          material.map.anisotropy = anisotropy;
          material.map.minFilter = LinearFilter;
          material.map.needsUpdate = true;
        }
        material.fog = true;
        material.toneMapped = false;
        if (materialName.startsWith("ad_") && !material.map) {
          material.map = this.createAdTexture(adIndex);
          material.map.colorSpace = SRGBColorSpace;
          material.map.anisotropy = anisotropy;
          material.color.set("#ffffff");
          material.needsUpdate = true;
          adIndex += 1;
        }
      }
    });

    this.trackRoot.add(gltf.scene);
  }

  private prepareSky(gltf: GLTF) {
    this.currentSkyScene = gltf.scene;
    const anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    gltf.scene.traverse((object) => {
      if (!(object instanceof Mesh)) {
        return;
      }
      object.frustumCulled = false;
      object.renderOrder = -1000;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!(material instanceof MeshBasicMaterial)) {
          continue;
        }
        material.depthTest = false;
        material.depthWrite = false;
        material.fog = false;
        material.toneMapped = false;
        material.side = DoubleSide;
        if (material.map) {
          material.map.colorSpace = SRGBColorSpace;
          material.map.anisotropy = anisotropy;
          material.map.needsUpdate = true;
        }
      }
    });
    this.skyRoot.add(gltf.scene);
  }

  private buildWeather(theme: string) {
    this.clearWeather();
    const cue = weatherFor(theme);
    this.weatherCue = cue;
    const count = 320;
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
      positions[index * 3] = (Math.random() - 0.5) * 80;
      positions[index * 3 + 1] = (Math.random() - 0.5) * 28;
      positions[index * 3 + 2] = (Math.random() - 0.5) * 80;
      velocities[index * 3] = cue.driftX * (0.4 + Math.random());
      velocities[index * 3 + 1] = -cue.gravity * (0.5 + Math.random());
      velocities[index * 3 + 2] = cue.driftZ * (0.4 + Math.random());
    }

    this.weatherPositions = positions;
    this.weatherVelocity = velocities;
    this.particleTexture ??= this.createParticleTexture();

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    const material = new PointsMaterial({
      color: cue.color,
      size: cue.size,
      sizeAttenuation: true,
      map: this.particleTexture,
      transparent: true,
      opacity: cue.opacity,
      depthWrite: false,
      blending: cue.blending,
      alphaTest: 0.01,
    });
    this.weather = new Points(geometry, material);
    this.weather.frustumCulled = false;
    this.weatherRoot.add(this.weather);
  }

  private updateWeather(delta: number) {
    if (
      !this.weather ||
      !this.weatherPositions ||
      !this.weatherVelocity ||
      !this.weatherCue
    ) {
      return;
    }
    const positions = this.weatherPositions;
    const velocities = this.weatherVelocity;
    const count = positions.length / 3;
    const cue = this.weatherCue;
    for (let index = 0; index < count; index += 1) {
      const offset = index * 3;
      positions[offset] += velocities[offset] * delta;
      positions[offset + 1] += velocities[offset + 1] * delta;
      positions[offset + 2] += velocities[offset + 2] * delta;
      if (positions[offset] > 40) positions[offset] -= 80;
      if (positions[offset] < -40) positions[offset] += 80;
      if (positions[offset + 1] < -14) positions[offset + 1] += 28;
      if (positions[offset + 1] > 14) positions[offset + 1] -= 28;
      if (positions[offset + 2] > 40) positions[offset + 2] -= 80;
      if (positions[offset + 2] < -40) positions[offset + 2] += 80;
      if (cue.gravity < 0.1) {
        velocities[offset + 1] =
          Math.sin((positions[offset] + positions[offset + 2]) * 0.12) * 0.08;
      }
    }
    const attribute = this.weather.geometry.getAttribute("position");
    attribute.needsUpdate = true;
  }

  private createAdTexture(index: number) {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 256;
    const context = canvas.getContext("2d");
    if (context) {
      context.translate(canvas.width, 0);
      context.scale(-1, 1);
      const palettes = [
        ["#0b4b88", "#28b7ec", "#ffcc3f"],
        ["#d24a24", "#f6b23d", "#1f3457"],
        ["#10253d", "#40d2c4", "#ffe066"],
        ["#6d1d2b", "#f26a45", "#ffd166"],
      ];
      const palette = palettes[index % palettes.length];
      const gradient = context.createLinearGradient(0, 0, 512, 256);
      gradient.addColorStop(0, palette[0]);
      gradient.addColorStop(1, palette[1]);
      context.fillStyle = gradient;
      context.fillRect(0, 0, 512, 256);

      context.save();
      context.translate(256, 128);
      context.rotate(-0.16);
      context.fillStyle = "rgba(255,255,255,.15)";
      for (let x = -440; x < 440; x += 62) {
        context.fillRect(x, -190, 28, 380);
      }
      context.restore();

      context.fillStyle = "#ffffff";
      context.font = "900 72px sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.shadowColor = "rgba(0,0,0,.35)";
      context.shadowBlur = 12;
      context.fillText("KART RIDER", 256, 116);
      context.fillStyle = palette[2];
      context.fillRect(98, 173, 316, 13);
      context.font = "700 25px sans-serif";
      context.fillStyle = "rgba(255,255,255,.8)";
      context.fillText("1.0", 256, 207);
    }
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    // Track ad meshes mirror U and invert V relative to authored textures.
    texture.center.set(0.5, 0.5);
    texture.rotation = Math.PI;
    return texture;
  }

  private createParticleTexture() {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    if (context) {
      const gradient = context.createRadialGradient(32, 32, 1, 32, 32, 31);
      gradient.addColorStop(0, "rgba(255,255,255,1)");
      gradient.addColorStop(0.4, "rgba(255,255,255,.75)");
      gradient.addColorStop(1, "rgba(255,255,255,0)");
      context.fillStyle = gradient;
      context.fillRect(0, 0, 64, 64);
    }
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    return texture;
  }

  private clearWeather() {
    if (this.weather) {
      this.weatherRoot.remove(this.weather);
      this.weather.geometry.dispose();
      const material = this.weather.material as PointsMaterial;
      material.dispose();
      this.weather = null;
    }
    this.weatherPositions = null;
    this.weatherVelocity = null;
    this.weatherCue = null;
  }

  private buildMinimapProjection(route: RouteData): MinimapProjection {
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const point of route.points) {
      minX = Math.min(minX, point.p[0]);
      maxX = Math.max(maxX, point.p[0]);
      minZ = Math.min(minZ, point.p[2]);
      maxZ = Math.max(maxZ, point.p[2]);
    }
    const width = 256;
    const height = 256;
    const padding = 22;
    const scale = (Math.min(width, height) - padding * 2) / Math.max(maxX - minX, maxZ - minZ, 1);
    const centerX = (minX + maxX) / 2;
    const centerY = -(minZ + maxZ) / 2;
    let path = "";
    let previousX = Number.NaN;
    let previousY = Number.NaN;
    for (const point of route.points) {
      const x = (point.p[0] - centerX) * scale + width / 2;
      const y = (-point.p[2] - centerY) * scale + height / 2;
      if (Math.hypot(x - previousX, y - previousY) < 0.45) {
        continue;
      }
      path += `${path ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
      previousX = x;
      previousY = y;
    }
    const first = route.points[0];
    const last = route.points[route.points.length - 1];
    if (first && last && Math.hypot(first.p[0] - last.p[0], first.p[2] - last.p[2]) < 8) {
      path += "Z";
    }
    return {
      centerX,
      centerY,
      scale,
      width,
      height,
      path,
    };
  }

  private unloadTrack() {
    if (this.currentTrackScene) {
      this.trackRoot.remove(this.currentTrackScene);
      this.disposeObject(this.currentTrackScene);
      this.currentTrackScene = null;
    }
    if (this.currentSkyScene) {
      this.skyRoot.remove(this.currentSkyScene);
      this.disposeObject(this.currentSkyScene);
      this.currentSkyScene = null;
    }
    this.clearWeather();
    this.route = null;
    this.minimap = null;
  }

  private disposeObject(root: Group) {
    root.traverse((object) => {
      if (!(object instanceof Mesh)) {
        return;
      }
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (material instanceof MeshBasicMaterial && material.map) {
          material.map.dispose();
        }
        material.dispose();
      }
    });
  }
}
