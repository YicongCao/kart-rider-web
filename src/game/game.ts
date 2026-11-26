import { MathUtils, Vector3 } from "three";
import type { RacePhase, TrackInfo, TrackRecord, Vec3 } from "../types";
import { AudioManager } from "./audio";
import { InputController } from "./input";
import { KartView } from "./kart-view";
import { RaceWorld } from "./world";
import type { MinimapProjection } from "./world";
import {
  FIXED_STEP_SECONDS,
  KartVehicle,
  type RoadSurface,
  type VehicleState,
} from "./vehicle";
import { Menu } from "../ui/menu";
import { GRID_SIGNALS, Hud, type RaceResult } from "../ui/hud";
import { formatTime } from "../util/format";

const TOTAL_LAPS = 2;
const RECORD_KEY = "kart-rider-remake.records.v1";
const GRID_INTRO_SECONDS = 3.6;
const START_SIGNAL_SECONDS = 1.3;

interface StoredRecords {
  [trackId: string]: TrackRecord;
}

interface DebugSnapshot {
  phase: RacePhase;
  track: string | null;
  time: number;
  lap: number;
  speedKmh: number;
  gauge: number;
  drifting: boolean;
  boosting: boolean;
  boostKind: VehicleState["boostKind"];
  miniBoostCount: number;
  nitroCount: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  lateralSpeed: number;
  lapProgress: number;
  driftPhase: VehicleState["driftPhase"];
}

const sleep = (milliseconds: number) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

function normalizeAngle(value: number) {
  let angle = value % (Math.PI * 2);
  if (angle > Math.PI) angle -= Math.PI * 2;
  if (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

function groundSpeed(state: VehicleState) {
  return Math.hypot(state.speed, state.lateralSpeed);
}

export class Game {
  private canvas: HTMLCanvasElement;
  private menuRoot: HTMLElement;
  private gameUiRoot: HTMLElement;
  private tracks: TrackInfo[] = [];
  private records: StoredRecords = {};
  private menu: Menu;
  private hud: Hud;
  private audio = new AudioManager();
  private input: InputController;
  private world: RaceWorld;
  private kartView: KartView;
  private vehicle: KartVehicle | null = null;
  private phase: RacePhase = "menu";
  private selectedTrackId = "";
  private currentTrack: TrackInfo | null = null;
  private minimapProjection: MinimapProjection | null = null;
  private routeForward: [number, number, number] = [0, 0, 1];
  private lastFrame = 0;
  private animationFrame = 0;
  private raceGeneration = 0;
  private lapStartTime = 0;
  private laps: number[] = [];
  private currentLap = 0;
  private previousProgress = 0;
  private routeHint = -1;
  private lastRacePosition: Vec3 = [0, 0, 0];
  private offCourseSeconds = 0;
  private progressInitialized = false;
  private lapArmed = false;
  private bestLap = Number.POSITIVE_INFINITY;
  private wrongWay = false;
  private previousBoostCount = 0;
  private previousGauge = 0;
  private previousCollisionCount = 0;
  private kartLoaded = false;
  private gridElapsed = 0;
  private countdownBeat = 0;
  private cameraYaw = 0;
  private cameraTarget = new Vector3();
  private finishAt = 0;
  private debug = false;

  constructor(canvas: HTMLCanvasElement, menuRoot: HTMLElement, gameUiRoot: HTMLElement) {
    this.canvas = canvas;
    this.menuRoot = menuRoot;
    this.gameUiRoot = gameUiRoot;
    this.world = new RaceWorld(canvas);
    this.kartView = new KartView(this.world.scene);
    this.input = new InputController(this.onAction);
    this.hud = new Hud(gameUiRoot, {
      onPause: () => this.pause(),
      onResume: () => this.resume(),
      onRestart: () => void this.restart(),
      onQuit: () => this.quitToMenu(),
      onRetry: () => void this.startRace(this.selectedTrackId),
      onToggleMute: () => this.toggleMute(),
      onFullscreen: () => void this.toggleFullscreen(),
    });
    this.menu = new Menu(menuRoot, [], this.records, {
      onSelect: (trackId) => {
        this.selectedTrackId = trackId;
        void this.audio.unlock();
      },
      onStart: (trackId) => void this.startRace(trackId),
      onToggleMute: () => this.toggleMute(),
      onFullscreen: () => void this.toggleFullscreen(),
    });
    this.input.bindTouch(this.hud.touchRoot ?? gameUiRoot);
    window.addEventListener("pointerdown", this.unlockAudio, { once: true });
    document.addEventListener("visibilitychange", () => {
      this.lastFrame = performance.now();
      if (document.hidden && this.phase === "racing") {
        this.pause();
      }
    });
    this.animationFrame = requestAnimationFrame(this.frame);
  }

  async init() {
    this.records = this.readRecords();
    const response = await fetch("/assets/tracks.json");
    if (!response.ok) {
      throw new Error("无法读取赛道列表");
    }
    this.tracks = (await response.json()) as TrackInfo[];
    this.menu = new Menu(this.menuRoot, this.tracks, this.records, {
      onSelect: (trackId) => {
        this.selectedTrackId = trackId;
        void this.audio.unlock().then(() => this.audio.playMenu());
      },
      onStart: (trackId) => void this.startRace(trackId),
      onToggleMute: () => this.toggleMute(),
      onFullscreen: () => void this.toggleFullscreen(),
    });
    this.menu.mount();
    this.menu.setMuted(this.audio.isMuted());
    this.menu.show(this.selectedTrackId || this.tracks[0]?.id);
    this.selectedTrackId = this.menu.getSelectedId();
    this.hud.hide();
    this.exposeDebugApi();

    // Preload the small kart/character payload while the player is choosing.
    window.setTimeout(() => {
      void this.kartView
        .load()
        .then(() => {
          this.kartLoaded = true;
        })
        .catch(() => {
          this.kartLoaded = false;
        });
    }, 350);
  }

  private frame = (now: number) => {
    this.animationFrame = requestAnimationFrame(this.frame);
    const elapsed = this.lastFrame > 0 ? Math.max(0, (now - this.lastFrame) / 1000) : 0;
    const rawDelta = Math.min(0.1, elapsed);
    this.lastFrame = now;
    if (this.phase !== "racing") this.input.discardTransitions();

    if (this.phase === "menu" || this.phase === "loading") {
      this.audio.update(rawDelta, 0, false, false, false);
      return;
    }

    if (this.phase === "racing" && this.vehicle) {
      const vehicle = this.vehicle;
      this.input.advanceFrame(now - rawDelta * 1000, now, FIXED_STEP_SECONDS * 1000, (seconds, keys) => {
        vehicle.step(seconds, {
          throttle: Number(keys.throttle),
          brake: Number(keys.brake),
          steer: -keys.steer, // Positive physics yaw turns left on the chase camera.
          drift: keys.drift,
          boost: keys.boost,
        });
      });
      this.updateRace(vehicle.state, rawDelta);
    } else if (this.phase === "paused" || this.phase === "finished") {
      this.audio.update(rawDelta, 0, false, false, false);
    } else if (this.phase === "countdown" && this.vehicle) {
      this.audio.update(rawDelta, 0, false, false, false);
      // Keep beats in real time on slower GPUs, while still presenting each number after a stall.
      if (!document.hidden) this.updateGrid(Math.min(1, elapsed));
    }

    let blur = 0;
    if (this.phase === "racing" && this.vehicle) {
      const state = this.vehicle.state;
      this.audio.update(
        rawDelta,
        groundSpeed(state),
        this.input.snapshot().throttle,
        state.drifting,
        state.boosting,
      );
      if (state.boostKind === "drift") {
        blur = 0.035 * MathUtils.smoothstep(state.boostElapsed, 0, 0.1) *
          MathUtils.smoothstep(state.boostRemaining, 0, 0.18);
      }
    }
    this.world.update(rawDelta);
    this.world.render(blur);
  };

  private async startRace(trackId: string) {
    const track = this.tracks.find((candidate) => candidate.id === trackId);
    if (!track) {
      return;
    }
    this.raceGeneration += 1;
    const generation = this.raceGeneration;
    this.selectedTrackId = trackId;
    this.phase = "loading";
    this.input.releaseAll();
    (document.activeElement as HTMLElement | null)?.blur();
    this.world.update(0);
    this.world.render();
    this.menu.hide();
    this.hud.hide();
    void this.audio.unlock();
    this.audio.stopRace();
    this.audio.playRace(track.music);
    this.audio.sfx("click");

    const canReuse =
      this.currentTrack?.id === track.id &&
      this.world.route !== null &&
      this.kartLoaded &&
      this.world.track?.id === track.id;

    try {
      if (!canReuse) {
        this.hud.showLoading(track);
        let worldProgress = 0;
        let kartProgress = this.kartLoaded ? 1 : 0;
        const report = () => {
          const total = worldProgress * 0.82 + kartProgress * 0.18;
          this.hud.setLoadingProgress(total, total >= 0.99 ? "准备起跑" : "加载中");
        };
        const [loaded] = await Promise.all([
          this.world.load(track, (progress, hint) => {
            worldProgress = Math.max(worldProgress, progress);
            this.hud.setLoadingProgress(worldProgress * 0.82 + kartProgress * 0.18, hint);
          }),
          this.kartView.load((progress) => {
            kartProgress = progress;
            report();
          }),
        ]);
        if (generation !== this.raceGeneration) {
          return;
        }
        this.kartLoaded = true;
        this.minimapProjection = loaded.minimap;
        this.currentTrack = track;
        this.hud.setLoadingProgress(1, "准备起跑");
        await sleep(150);
        this.hud.hideLoading();
      }
    } catch (error) {
      if (generation !== this.raceGeneration) {
        return;
      }
      this.phase = "menu";
      this.hud.showLoadError(
        error instanceof Error && error.message ? error.message : "赛道加载失败",
      );
      this.audio.stopRace();
      this.audio.playMenu();
      return;
    }

    if (generation !== this.raceGeneration) {
      return;
    }
    this.currentTrack = track;
    this.beginSession(track);
    this.hud.hideLoading();
    this.hud.show(track, this.minimapProjection);
    this.hud.setMuted(this.audio.isMuted());
    this.kartView.setVisible(true);
    this.resetRaceState(track);
  }

  private beginSession(track: TrackInfo) {
    if (!this.world.route) {
      throw new Error("赛道路线缺失");
    }
    this.world.route.query(track.start[0], track.start[2]);
    this.vehicle = null;
  }

  private resetRaceState(track: TrackInfo) {
    const { route, collision } = this.world;
    if (!route || !collision) {
      return;
    }
    const start = route.points[0];
    const yaw = Math.atan2(start.f[0], start.f[2]);
    const localSampler = {
      length: route.length,
      nearest: (x: number, z: number, hint = -1, height?: number) => {
        const sample = route.query(x, z, hint, height);
        return {
          x: sample.x,
          y: sample.y,
          z: sample.z,
          tangentX: sample.forward[0],
          tangentZ: sample.forward[2],
          rightX: sample.right[0],
          rightZ: sample.right[2],
          progress: sample.s,
          lateral: sample.lateral,
          segment: sample.index,
        };
      },
    };
    const surfaceAt = (_x: number, _z: number, _progress: number): RoadSurface => {
      if (track.id === "ice") {
        return { grip: 0.64, drag: 0.9, acceleration: 0.94, driftGauge: 0.95 };
      }
      if (track.id === "desert") {
        return { grip: 0.94, drag: 1.03, acceleration: 1, driftGauge: 1 };
      }
      if (track.id === "forest") {
        return { grip: 0.97, drag: 1, acceleration: 1, driftGauge: 1 };
      }
      return { grip: 1, drag: 1, acceleration: 1, driftGauge: 1 };
    };
    this.vehicle = new KartVehicle({
      position: { x: start.p[0], y: start.p[1], z: start.p[2] },
      yaw,
      speed: 0,
      startAtSeconds: 0,
      route: localSampler,
      wallContactAt: collision.queryWall.bind(collision),
      groundHeightAt: (x, z, _progress, height) => collision.groundHeight(x, height, z),
      surfaceAt,
      followRouteHeight: true,
    });
    this.lapStartTime = 0;
    this.laps = [];
    this.currentLap = 0;
    this.bestLap = Number.POSITIVE_INFINITY;
    this.previousBoostCount = 0;
    this.previousGauge = 0;
    this.previousCollisionCount = 0;
    this.routeForward = [start.f[0], start.f[1], start.f[2]];
    this.wrongWay = false;
    this.hud.setLap(1, TOTAL_LAPS);
    this.hud.setTime(0);
    this.hud.setGauge(0, false);
    this.hud.setDrift(false, 0);
    this.hud.setWrongWay(false);
    this.kartView.resetTrail();
    this.kartView.setVisible(true);
    const sample = route.query(start.p[0], start.p[2]);
    this.previousProgress = 0;
    this.routeHint = 0;
    this.lastRacePosition = [...start.p];
    this.offCourseSeconds = 0;
    this.progressInitialized = true;
    this.lapArmed = false;
    this.kartView.update(this.vehicle.state, 0.016, sample);
    this.updateMinimap(this.vehicle.state);
    this.gridElapsed = 0;
    this.countdownBeat = 0;
    this.cameraYaw = yaw;
    this.phase = "countdown";
    this.hud.hideCountdown();
    this.updateGridCamera(this.vehicle.state, 0);
  }

  private updateGrid(delta: number) {
    if (!this.vehicle) return;
    this.kartView.updateExhaust(this.vehicle.state, delta);
    this.gridElapsed += delta;
    const remaining = GRID_INTRO_SECONDS + 3 - this.gridElapsed;
    this.updateGridCamera(this.vehicle.state, Math.min(1, this.gridElapsed / GRID_INTRO_SECONDS));
    if (this.gridElapsed < GRID_INTRO_SECONDS) return;
    if (remaining > 0) {
      const beat = Math.ceil(remaining);
      if (beat !== this.countdownBeat) {
        this.countdownBeat = beat;
        this.hud.showCountdown(GRID_SIGNALS[beat]);
        this.audio.sfx("countdown");
      }
      return;
    }
    this.phase = "racing";
    this.vehicle.setStartAt(0);
    this.vehicle.primeThrottleHeld(this.input.snapshot().throttle);
    this.hud.showCountdown("开始");
    this.audio.sfx("start");
  }

  private updateRace(state: VehicleState, delta: number) {
    if (!this.currentTrack || !this.vehicle) {
      return;
    }
    const route = this.world.route;
    if (!route) {
      return;
    }
    const position: Vec3 = [state.x, state.y, state.z];
    const warp = route.data.warp;
    if (warp && route.crossesWarp(this.lastRacePosition, position)) {
      this.vehicle.resetPose(...warp.to, warp.yaw, groundSpeed(state));
      state = this.vehicle.state;
      this.routeHint = route.warpIndex + 1;
      this.cameraYaw = warp.yaw;
      this.kartView.resetTrail();
    }
    this.lastRacePosition = [state.x, state.y, state.z];
    const sample = route.query(state.x, state.z, this.routeHint, state.y);
    this.routeHint = sample.index;
    // Allow jumps and mesh seams. Recover only after staying beyond the course
    // with no drivable surface under the kart.
    const outside = Math.hypot(state.x - sample.x, state.z - sample.z) > route.halfWidth + 2;
    this.offCourseSeconds = outside && this.world.collision?.groundHeight(state.x, state.y, state.z) === null
      ? this.offCourseSeconds + delta : 0;
    if (this.offCourseSeconds > 1) {
      this.resetVehicle();
      return;
    }
    this.routeForward = sample.forward;
    this.kartView.update(state, delta, sample, this.input.snapshot().steer);
    this.updateChaseCamera(delta, state);
    if (this.countdownBeat && state.time >= START_SIGNAL_SECONDS) {
      this.hud.hideCountdown();
      this.hud.setGridPreview(false);
      this.countdownBeat = 0;
    }

    const timeMs = state.time * 1000;
    this.hud.setTime(timeMs, this.phase === "racing");
    this.hud.setSpeed(groundSpeed(state) * 3.6);
    this.hud.setGauge(state.gauge, state.gauge >= 0.999);
    this.hud.setDrift(state.drifting, state.gauge);
    this.hud.setBoost(state.boostKind === "start" || state.boostKind === "nitro");

    this.updateMinimap(state);

    const forwardDot =
      Math.sin(state.yaw) * this.routeForward[0] + Math.cos(state.yaw) * this.routeForward[2];
    const isWrong = forwardDot < -0.35 && Math.abs(state.speed) > 3;
    if (isWrong !== this.wrongWay) {
      this.wrongWay = isWrong;
      this.hud.setWrongWay(isWrong);
    }

    if (state.boostCount > this.previousBoostCount) {
      this.audio.sfx(state.lastBoostKind === "drift" ? "boostDrift" : "booster");
      if (state.lastBoostKind === "start") {
        this.hud.notice("完美起步", 1300);
      }
      this.hud.setRaceCounts(state.collisionCount, state.nitroCount);
    }
    this.previousBoostCount = state.boostCount;

    if (state.gauge >= 0.999 && this.previousGauge < 0.999) {
      this.hud.notice("氮气已就绪", 1500);
    }
    this.previousGauge = state.gauge;

    if (state.collisionCount !== this.previousCollisionCount) {
      this.previousCollisionCount = state.collisionCount;
      this.hud.setRaceCounts(state.collisionCount, state.nitroCount);
      this.audio.sfx("collide");
    }

    const progressDelta = sample.s - this.previousProgress;
    if (
      !this.lapArmed &&
      sample.s > route.length * 0.2 &&
      sample.s < route.length * 0.8
    ) {
      this.lapArmed = true;
    }
    const wrappedForward =
      this.progressInitialized &&
      this.lapArmed &&
      progressDelta < -route.length * 0.5 &&
      this.previousProgress > route.length * 0.7 &&
      sample.s < route.length * 0.3;
    this.previousProgress = sample.s;

    if (wrappedForward) {
      this.lapArmed = false;
      this.currentLap += 1;
      const lapTime = state.time - this.lapStartTime;
      this.laps.push(lapTime);
      this.bestLap = Math.min(this.bestLap, lapTime);
      this.hud.setBestLap(this.bestLap * 1000);
      this.lapStartTime = state.time;
      if (this.currentLap >= TOTAL_LAPS) {
        this.finishRace(timeMs);
        return;
      }
      this.hud.setLap(this.currentLap + 1, TOTAL_LAPS);
      this.hud.notice(`第 ${this.currentLap} 圈  ${formatTime(lapTime * 1000)}`, 1900);
    }
  }

  private updateMinimap(state: VehicleState) {
    const projection = this.minimapProjection;
    if (!projection) return;
    const mapX = 0.5 + (state.x - projection.centerX) * projection.scale / projection.width;
    const mapY = 0.5 + (-state.z - projection.centerY) * projection.scale / projection.height;
    this.hud.setMinimap(mapX, mapY, normalizeAngle(state.yaw));
  }

  private updateGridCamera(state: VehicleState, progress: number) {
    if (progress >= 1) {
      this.updateChaseCamera(0, state, true);
      return;
    }
    // The grid shot descends in front of the driver, then cuts directly to the chase camera.
    const descent = MathUtils.smootherstep(progress, 0, 0.78);
    const push = MathUtils.smootherstep(progress, 0.18, 0.96);
    const arc = Math.sin(Math.PI * progress);
    const angle = state.yaw + Math.PI - 0.32 * arc;
    const aspect = this.world.camera.aspect;
    const fov = MathUtils.lerp(43, 37.5, push);
    // Preserve the close-up's horizontal framing on portrait screens.
    const framing = Math.max(1, 0.68 / aspect);
    const portraitFov = MathUtils.radToDeg(2 * Math.atan(Math.tan(MathUtils.degToRad(fov / 2)) * framing));
    this.placeCamera(
      state, angle, MathUtils.lerp(6.5, 4.4, push), MathUtils.lerp(7.1, 1.65, descent),
      state.yaw, 0, portraitFov, MathUtils.lerp(0.85, 0.73, descent),
      0.88 * arc * MathUtils.smoothstep(aspect, 0.6, 1.4),
    );
  }

  private updateChaseCamera(delta: number, state: VehicleState, snap = false) {
    const speed = groundSpeed(state);
    const slip = Math.atan2(state.lateralSpeed, Math.max(state.speed, 1));
    const travelYaw = state.yaw + MathUtils.clamp(slip, -0.9, 0.9) * MathUtils.smoothstep(state.speed, 1, 6);
    const yawError = normalizeAngle(travelYaw - this.cameraYaw);
    this.cameraYaw = normalizeAngle(this.cameraYaw + yawError * (1 - Math.exp(-5.5 * delta)));
    const distance = 6.6 + Math.min(0.65, speed * 0.013);
    const height = 2.8 + Math.min(0.3, speed * 0.005);
    const mini = state.boostKind === "drift";
    const boostFov = mini ? 4 * MathUtils.smoothstep(state.boostRemaining, 0, 0.12) : state.boosting ? 4 : 0;
    const targetFov = 60 + Math.min(6, speed * 0.12) + boostFov;
    const fov = snap ? targetFov : MathUtils.damp(this.world.camera.fov, targetFov, mini ? 9 : 3, delta);
    this.placeCamera(state, this.cameraYaw, distance, height, this.cameraYaw, 5.4, fov, 0.55);
  }

  private placeCamera(
    state: VehicleState, orbitYaw: number, distance: number, height: number,
    lookYaw: number, lookAhead: number, fov: number, lookHeight: number, leftOffset = 0,
  ) {
    const [forwardX, forwardY, forwardZ] = this.routeForward;
    const grade = forwardY / Math.max(0.25, forwardX * forwardX + forwardZ * forwardZ);
    const offsetX = -Math.sin(orbitYaw) * distance;
    const offsetZ = -Math.cos(orbitYaw) * distance;
    const aheadX = Math.sin(lookYaw) * lookAhead + Math.cos(orbitYaw) * leftOffset;
    const aheadZ = Math.cos(lookYaw) * lookAhead - Math.sin(orbitYaw) * leftOffset;
    const camera = this.world.camera;
    camera.position.set(
      state.x + offsetX,
      state.y + height + grade * (offsetX * forwardX + offsetZ * forwardZ),
      state.z + offsetZ,
    );
    this.cameraTarget.set(
      state.x + aheadX,
      state.y + lookHeight + grade * (aheadX * forwardX + aheadZ * forwardZ),
      state.z + aheadZ,
    );
    camera.lookAt(this.cameraTarget);
    if (Math.abs(camera.fov - fov) > 0.001) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  private finishRace(timeMs: number) {
    if (!this.currentTrack || !this.vehicle) {
      return;
    }
    this.phase = "finished";
    this.finishAt = performance.now();
    this.input.releaseAll();
    this.audio.sfx("finish");
    const previous = this.records[this.currentTrack.id] ?? null;
    const previousBest = previous?.bestTime ?? null;
    const isRecord = previousBest === null || timeMs < previousBest;
    this.records[this.currentTrack.id] = {
      bestTime: isRecord ? timeMs : previousBest,
      bestLap: Math.min(
        previous?.bestLap ?? Number.POSITIVE_INFINITY,
        this.bestLap * 1000,
      ),
      runs: (previous?.runs ?? 0) + 1,
    };
    if (!Number.isFinite(this.records[this.currentTrack.id].bestLap)) {
      this.records[this.currentTrack.id].bestLap = null;
    }
    this.writeRecords(this.records);
    this.menu.refreshRecords(this.records);
    const result: RaceResult = {
      trackName: this.currentTrack.name,
      totalTime: timeMs,
      laps: this.laps.map((lap) => lap * 1000),
      bestLap: this.bestLap * 1000,
      isRecord,
      previousBest,
    };
    this.hud.setTime(timeMs);
    this.hud.showResult(result);
    this.hud.setBoost(false);
  }

  private pause() {
    if (this.phase !== "racing") {
      return;
    }
    this.phase = "paused";
    this.input.releaseAll();
    this.hud.showPause();
  }

  private resume() {
    if (this.phase !== "paused") {
      return;
    }
    this.phase = "racing";
    this.lastFrame = performance.now();
    this.input.releaseAll();
    this.hud.hidePause();
    (document.activeElement as HTMLElement | null)?.blur();
  }

  private restart() {
    if (!this.selectedTrackId) {
      return;
    }
    this.raceGeneration += 1;
    this.hud.hidePause();
    this.hud.hideResult();
    this.input.releaseAll();
    const track = this.currentTrack;
    if (!track) {
      return;
    }
    this.hud.show(track, this.minimapProjection);
    this.kartView.resetTrail();
    this.kartView.setVisible(true);
    this.hud.setSpeed(0);
    this.hud.setBoost(false);
    this.hud.setGauge(0, false);
    this.resetRaceState(track);
    this.audio.playRace(track.music);
  }

  private quitToMenu() {
    this.raceGeneration += 1;
    this.phase = "menu";
    this.input.releaseAll();
    this.hud.hide();
    this.kartView.setVisible(false);
    this.kartView.resetTrail();
    this.audio.stopRace();
    this.audio.playMenu();
    if (this.currentTrack) {
      this.menu.show(this.currentTrack.id);
    } else {
      this.menu.show();
    }
  }

  private resetVehicle() {
    if (!this.vehicle || this.phase !== "racing") {
      return;
    }
    const route = this.world.route;
    if (!route) {
      return;
    }
    const state = this.vehicle.state;
    const sample = route.query(state.x, state.z, this.routeHint, state.y);
    const yaw = Math.atan2(sample.forward[0], sample.forward[2]);
    this.vehicle.resetPose(sample.x, sample.y, sample.z, yaw);
    this.lastRacePosition = [sample.x, sample.y, sample.z];
    this.offCourseSeconds = 0;
    this.cameraYaw = yaw;
    this.previousProgress = sample.s;
    this.routeHint = sample.index;
    this.lapArmed =
      sample.s > route.length * 0.2 && sample.s < route.length * 0.8;
    this.kartView.resetTrail();
    this.hud.notice("重置", 900, "warn");
  }

  private onAction = (action: "pause" | "reset" | "mute" | "confirm") => {
    if (action === "pause") {
      if (this.phase === "racing") this.pause();
      else if (this.phase === "paused") this.resume();
    } else if (action === "reset") {
      this.resetVehicle();
    } else if (action === "mute") {
      this.toggleMute();
    } else if (action === "confirm") {
      if (this.phase === "menu") {
        this.menu.confirm();
      } else if (this.phase === "finished") {
        void this.restart();
      } else if (this.phase === "paused") {
        this.resume();
      }
    }
  };

  private unlockAudio = () => {
    void this.audio.unlock().then(() => {
      if (this.phase === "menu") this.audio.playMenu();
    });
  };

  private toggleMute() {
    const muted = this.audio.toggleMute();
    this.menu.setMuted(muted);
    this.hud.setMuted(muted);
    return muted;
  }

  private async toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      // Fullscreen is optional on browsers that do not expose it.
    }
  }

  private readRecords(): StoredRecords {
    try {
      const raw = localStorage.getItem(RECORD_KEY);
      return raw ? (JSON.parse(raw) as StoredRecords) : {};
    } catch {
      return {};
    }
  }

  private writeRecords(records: StoredRecords) {
    try {
      localStorage.setItem(RECORD_KEY, JSON.stringify(records));
    } catch {
      // Private browsing can reject storage; records simply remain in memory.
    }
  }

  private exposeDebugApi() {
    const api = {
      snapshot: (): DebugSnapshot => {
        const state = this.vehicle?.state;
        return {
          phase: this.phase,
          track: this.currentTrack?.id ?? null,
          time: state?.time ?? 0,
          lap: this.currentLap,
          speedKmh: state ? groundSpeed(state) * 3.6 : 0,
          gauge: state?.gauge ?? 0,
          drifting: state?.drifting ?? false,
          boosting: state?.boosting ?? false,
          boostKind: state?.boostKind ?? "none",
          miniBoostCount: state?.miniBoostCount ?? 0,
          nitroCount: state?.nitroCount ?? 0,
          x: state?.x ?? 0,
          y: state?.y ?? 0,
          z: state?.z ?? 0,
          yaw: state?.yaw ?? 0,
          lateralSpeed: state?.lateralSpeed ?? 0,
          lapProgress: state?.lapProgress ?? 0,
          driftPhase: state?.driftPhase ?? "none",
        };
      },
      startTrack: (id: string) => this.startRace(id),
      quit: () => this.quitToMenu(),
      tracks: () => this.tracks.map((track) => track.id),
    };
    (window as Window & { kartGame?: typeof api }).kartGame = api;
    (window as Window & { __kartDebug?: unknown }).__kartDebug = {
      world: this.world,
      kartView: this.kartView,
      camera: this.world.camera,
      game: this,
    };
  }
}
