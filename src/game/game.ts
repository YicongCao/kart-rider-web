import { MathUtils, Vector3 } from "three";
import type { RacePhase, TrackInfo, TrackRecord } from "../types";
import { AudioManager } from "./audio";
import { InputController } from "./input";
import { KartView } from "./kart-view";
import { RaceWorld } from "./world";
import type { MinimapProjection } from "./world";
import {
  KartVehicle,
  type RoadSurface,
  type VehicleState,
} from "./vehicle";
import { Menu } from "../ui/menu";
import { Hud, type RaceResult } from "../ui/hud";
import { formatTime } from "../util/format";

const TOTAL_LAPS = 2;
const RECORD_KEY = "kart-rider-remake.records.v1";

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
  private progressInitialized = false;
  private lapArmed = false;
  private bestLap = Number.POSITIVE_INFINITY;
  private wrongWay = false;
  private previousBoostCount = 0;
  private previousGauge = 0;
  private collisionCooldown = 0;
  private previousSpeed = 0;
  private kartLoaded = false;
  private cameraInitialized = false;
  private cameraTarget = new Vector3();
  private finishAt = 0;
  private debug = false;

  constructor(canvas: HTMLCanvasElement, menuRoot: HTMLElement, gameUiRoot: HTMLElement) {
    this.canvas = canvas;
    this.menuRoot = menuRoot;
    this.gameUiRoot = gameUiRoot;
    this.audio = new AudioManager();
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
      if (document.hidden && this.phase === "racing") {
        this.pause();
      }
    });
    window.addEventListener("resize", () => {
      this.cameraInitialized = false;
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
    const rawDelta = this.lastFrame > 0 ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    this.collisionCooldown = Math.max(0, this.collisionCooldown - rawDelta);

    if (this.phase === "menu" || this.phase === "loading") {
      return;
    }

    if (this.phase === "racing" && this.vehicle) {
      const keys = this.input.snapshot();
      const state = this.vehicle.step(rawDelta, {
        throttle: keys.throttle ? 1 : 0,
        brake: keys.brake ? 1 : 0,
        /// Physics' +right turns to the chase-camera's left; invert for D = right.
        steer: -keys.steer,
        drift: keys.drift,
        boost: keys.boost,
      });
      this.updateRace(state, rawDelta);
    } else if (this.phase === "paused" || this.phase === "finished") {
      this.audio.update(rawDelta, 0, false, false, false);
    } else if (this.phase === "countdown" && this.vehicle) {
      this.audio.update(rawDelta, 0, false, false, false);
      this.updateCamera(rawDelta, this.vehicle.state, true);
    }

    if (this.phase === "racing" && this.vehicle) {
      const state = this.vehicle.state;
      this.audio.update(
        rawDelta,
        state.speed,
        this.input.snapshot().throttle,
        state.drifting,
        state.boosting,
      );
    }

    this.world.update(rawDelta);
    this.world.render();
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
    this.menu.hide();
    this.hud.hide();
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
    this.phase = "countdown";
    this.resetRaceState(track);
    this.startCountdown(generation);
  }

  private beginSession(track: TrackInfo) {
    if (!this.world.route) {
      throw new Error("赛道路线缺失");
    }
    this.world.route.query(track.start[0], track.start[2]);
    this.vehicle = null;
  }

  private resetRaceState(track: TrackInfo) {
    const route = this.world.route;
    if (!route) {
      return;
    }
    const start = route.points[0];
    const yaw = Math.atan2(start.f[0], start.f[2]);
    const localSampler = {
      length: route.length,
      nearest: (x: number, z: number, hint = -1) => {
        const sample = route.query(x, z, hint);
        return {
          x: sample.x,
          y: sample.y,
          z: sample.z,
          tangentX: sample.forward[0],
          tangentZ: sample.forward[2],
          rightX: -sample.forward[2],
          rightZ: sample.forward[0],
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
      roadHalfWidth: Math.max(4, route.halfWidth - 0.45),
      surfaceAt,
      followRouteHeight: true,
    });
    this.lapStartTime = 0;
    this.laps = [];
    this.currentLap = 0;
    this.bestLap = Number.POSITIVE_INFINITY;
    this.previousBoostCount = 0;
    this.previousGauge = 0;
    this.previousSpeed = 0;
    this.routeForward = [start.f[0], start.f[1], start.f[2]];
    this.wrongWay = false;
    this.hud.setLap(1, TOTAL_LAPS);
    this.hud.setTime(0);
    this.hud.setLapTime(0);
    this.hud.setGauge(0, false);
    this.hud.setDrift(false, 0);
    this.hud.setWrongWay(false);
    this.kartView.resetTrail();
    this.kartView.setVisible(true);
    this.cameraInitialized = false;
    const sample = route.query(start.p[0], start.p[2]);
    this.previousProgress = 0;
    this.routeHint = 0;
    this.progressInitialized = true;
    this.lapArmed = false;
    this.kartView.update(this.vehicle.state, 0.016, sample);
    this.updateCamera(0.016, this.vehicle.state, true, true);
  }

  private async startCountdown(generation: number) {
    this.hud.hidePause();
    this.hud.hideResult();
    this.phase = "countdown";
    this.hud.showCountdown("3");
    this.audio.sfx("countdown");
    await sleep(900);
    if (generation !== this.raceGeneration) return;
    this.hud.showCountdown("2");
    this.audio.sfx("countdown");
    await sleep(900);
    if (generation !== this.raceGeneration) return;
    this.hud.showCountdown("1");
    this.audio.sfx("countdown");
    await sleep(900);
    if (generation !== this.raceGeneration) return;
    this.phase = "racing";
    this.lastFrame = performance.now();
    this.vehicle?.setStartAt(0);
    this.vehicle?.primeThrottleHeld(this.input.snapshot().throttle);
    this.hud.showCountdown("GO!");
    this.audio.sfx("start");
    window.setTimeout(() => {
      if (generation === this.raceGeneration) this.hud.hideCountdown();
    }, 760);
  }

  private updateRace(state: VehicleState, delta: number) {
    if (!this.currentTrack) {
      return;
    }
    const route = this.world.route;
    if (!route) {
      return;
    }
    const sample = route.query(state.x, state.z, this.routeHint);
    this.routeHint = sample.index;
    this.routeForward = sample.forward;
    this.kartView.update(state, delta, sample, this.input.snapshot().steer);
    this.updateCamera(delta, state, false);

    const timeMs = state.time * 1000;
    this.hud.setTime(timeMs);
    this.hud.setLapTime((state.time - this.lapStartTime) * 1000);
    this.hud.setSpeed(Math.abs(state.speed) * 3.6);
    this.hud.setGauge(state.gauge, state.gauge >= 0.999);
    this.hud.setDrift(state.drifting, state.gauge);
    this.hud.setBoost(state.boosting);

    if (this.minimapProjection) {
      const projection = this.minimapProjection;
      const mapX =
        ((state.x - projection.centerX) * projection.scale + projection.width / 2) /
        projection.width;
      const mapY =
        ((-state.z - projection.centerY) * projection.scale + projection.height / 2) /
        projection.height;
      this.hud.setMinimap(mapX, mapY, normalizeAngle(state.yaw));
    }

    const forwardDot =
      Math.sin(state.yaw) * this.routeForward[0] + Math.cos(state.yaw) * this.routeForward[2];
    const isWrong = forwardDot < -0.35 && Math.abs(state.speed) > 3;
    if (isWrong !== this.wrongWay) {
      this.wrongWay = isWrong;
      this.hud.setWrongWay(isWrong);
    }

    if (state.boostCount > this.previousBoostCount) {
      const wasStartBoost = state.boostCount === 1 && state.boosting && state.time < 1.2;
      this.audio.sfx(wasStartBoost ? "boostDrift" : "booster");
      if (wasStartBoost) this.hud.notice("完美起步", 1300);
    }
    this.previousBoostCount = state.boostCount;

    if (state.gauge >= 0.999 && this.previousGauge < 0.999) {
      this.hud.notice("氮气已就绪", 1500);
    }
    this.previousGauge = state.gauge;

    if (
      this.collisionCooldown <= 0 &&
      this.previousSpeed - state.speed > 2.5 &&
      Math.abs(state.lateralOffset) > route.halfWidth - 2.5
    ) {
      this.audio.sfx("collide");
      this.collisionCooldown = 0.45;
    }
    this.previousSpeed = state.speed;

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
      this.lapStartTime = state.time;
      if (this.currentLap >= TOTAL_LAPS) {
        this.finishRace(timeMs);
        return;
      }
      this.hud.setLap(this.currentLap + 1, TOTAL_LAPS);
      this.hud.notice(`第 ${this.currentLap} 圈  ${formatTime(lapTime * 1000)}`, 1900);
    }
  }

  private updateCamera(
    delta: number,
    state: VehicleState,
    countdown: boolean,
    instant = false,
  ) {
    const route = this.world.route;
    if (!route) {
      return;
    }
    const sample = route.query(state.x, state.z);
    const forward = new Vector3(sample.forward[0], 0, sample.forward[2]).normalize();
    const speed = Math.abs(state.speed);
    const distance = countdown ? 9.2 : 7.6 + Math.min(1.8, speed * 0.028);
    const height = countdown ? 4.05 : 3.1 + Math.min(0.5, speed * 0.005);
    const desired = new Vector3(
      state.x - forward.x * distance,
      state.y + height,
      state.z - forward.z * distance,
    );
    const look = new Vector3(
      state.x + forward.x * (countdown ? 3 : 5.4),
      state.y + 1.05,
      state.z + forward.z * (countdown ? 3 : 5.4),
    );
    if (state.boosting) {
      desired.x += (Math.random() - 0.5) * 0.045;
      desired.y += (Math.random() - 0.5) * 0.035;
    }
    if (instant || !this.cameraInitialized) {
      this.world.camera.position.copy(desired);
      this.cameraTarget.copy(look);
      this.cameraInitialized = true;
    } else {
      const follow = 1 - Math.exp(-Math.max(0.001, delta) * (countdown ? 3.2 : 6.5));
      const targetFollow = 1 - Math.exp(-Math.max(0.001, delta) * 8);
      this.world.camera.position.lerp(desired, follow);
      this.cameraTarget.lerp(look, targetFollow);
    }
    this.world.camera.up.set(0, 1, 0);
    this.world.camera.lookAt(this.cameraTarget);
    const targetFov = (countdown ? 58 : 60) + Math.min(10, speed * 0.17) + (state.boosting ? 4 : 0);
    this.world.camera.fov += (targetFov - this.world.camera.fov) * Math.min(1, delta * 3);
    this.world.camera.updateProjectionMatrix();
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

  private async restart() {
    if (!this.selectedTrackId) {
      return;
    }
    this.raceGeneration += 1;
    const generation = this.raceGeneration;
    this.phase = "countdown";
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
    this.hud.hideCountdown();
    this.hud.setSpeed(0);
    this.hud.setBoost(false);
    this.hud.setGauge(0, false);
    this.resetRaceState(track);
    this.audio.playRace(track.music);
    this.startCountdown(generation);
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
    const sample = route.query(state.x, state.z);
    const yaw = Math.atan2(sample.forward[0], sample.forward[2]);
    this.vehicle.resetPose(sample.x, sample.y, sample.z, yaw);
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
        void this.startRace(this.menu.getSelectedId());
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
      snapshot: (): DebugSnapshot => ({
        phase: this.phase,
        track: this.currentTrack?.id ?? null,
        time: this.vehicle?.state.time ?? 0,
        lap: this.currentLap,
        speedKmh: Math.abs(this.vehicle?.state.speed ?? 0) * 3.6,
        gauge: this.vehicle?.state.gauge ?? 0,
        drifting: this.vehicle?.state.drifting ?? false,
        boosting: this.vehicle?.state.boosting ?? false,
        x: this.vehicle?.state.x ?? 0,
        y: this.vehicle?.state.y ?? 0,
        z: this.vehicle?.state.z ?? 0,
        yaw: this.vehicle?.state.yaw ?? 0,
        lateralSpeed: this.vehicle?.state.lateralSpeed ?? 0,
        lapProgress: this.vehicle?.state.lapProgress ?? 0,
        driftPhase: this.vehicle?.state.driftPhase ?? "none",
      }),
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
