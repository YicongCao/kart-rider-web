import "./race-hud.css";
import type { TrackInfo } from "../types";
import type { MinimapProjection } from "../game/world";
import { formatTime } from "../util/format";

export const GRID_SIGNALS = ["开始", "1", "2", "3"] as const;

interface HudActions {
  onPause: () => void;
  onResume: () => void;
  onRestart: () => void;
  onQuit: () => void;
  onRetry: () => void;
  onToggleMute: () => boolean;
  onFullscreen: () => void;
}

export interface RaceResult {
  trackName: string;
  totalTime: number;
  laps: number[];
  bestLap: number;
  isRecord: boolean;
  previousBest: number | null;
}

const pauseIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>`;
const speakerIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.8 6a8.5 8.5 0 0 1 0 12"/></svg>`;
const mutedIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="m16 9 5 5m0-5-5 5"/></svg>`;
const fullscreenIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg>`;

function raceClock(milliseconds: number) {
  const hundredths = Math.max(0, Math.floor(milliseconds / 10));
  return [Math.floor(hundredths / 6000), Math.floor(hundredths / 100) % 60, hundredths % 100]
    .map((part) => String(part).padStart(2, "0")).join(":");
}

export class Hud {
  private root: HTMLElement;
  private actions: HudActions;
  private noticeTimer = 0;
  private track: TrackInfo | null = null;
  private overview = false;
  private mapPosition = { x: 0.5, y: 0.5, heading: 0 };
  private lastSpeed = -1;

  constructor(root: HTMLElement, actions: HudActions) {
    this.root = root;
    this.actions = actions;
    this.mount();
  }

  get touchRoot() {
    return this.root.querySelector<HTMLElement>(".touch-controls");
  }

  private mount() {
    this.root.innerHTML = `
      <section class="hud race-hud is-hidden" aria-label="比赛信息">
        <div class="race-slots" aria-label="道具栏">
          <i class="race-slot"></i><i class="race-slot race-slot-current" data-item-slot></i>
        </div>
        <div class="race-item-tip" data-item-tip><b aria-hidden="true">!</b><span>漂移集气，充满后按 Ctrl 加速</span><small>漂移集气，充满后点按氮气</small></div>
        <div class="race-standing" aria-label="当前排名，第 1 名，共 1 人">
          <div class="race-place"><b>1</b><strong>st</strong><small>/1</small></div>
          <div class="race-driver"><b>1</b><span>车手</span></div>
        </div>

        <div class="race-score">
          <div class="race-lap" aria-label="圈数"><b data-lap>1</b><small>/<span data-total-laps>2</span></small></div>
          <div class="race-clock"><span>比赛时间</span><strong data-race-time>00:00:00</strong></div>
          <div class="race-clock"><span>最佳单圈</span><strong data-best-lap>00:00:00</strong></div>
        </div>
        <div class="race-map" data-race-map>
          <div class="race-map-window">
            <button type="button" class="race-map-switch" data-hud-action="map" aria-label="全图模式" aria-pressed="false" title="切换局部地图或全图">M</button>
            <div class="race-map-road">
              <svg data-minimap viewBox="0 0 256 256" preserveAspectRatio="none" role="img" aria-label="">
                <g data-minimap-road><path data-minimap-path d="" /></g>
              </svg>
            </div>
            <svg class="race-map-arrow" data-minimap-marker viewBox="0 0 62 47" aria-hidden="true">
              <path d="m31 2 28 42-28-11L3 44Z" fill="#b9290b" stroke="#100a08" stroke-width="3" stroke-linejoin="round"/>
              <path d="m31 5 24 35-24-10Z" fill="#812008"/>
            </svg>
          </div>
          <div class="race-map-stats"><span>撞击</span><b data-hit-count>0 次</b><span>加速</span><b data-boost-count>0 次</b></div>
        </div>

        <div class="grid-preview is-hidden" data-grid-preview>
          <div class="grid-mode">标准速度　计时赛 / 个人赛</div>
          <div class="grid-theme" data-grid-theme></div>
          <div class="grid-track" data-grid-track></div>
          <div class="grid-card">
            <img data-grid-card alt="" />
            <div class="grid-difficulty"><b>难度</b><span data-grid-difficulty></span></div>
          </div>
        </div>

        <div class="race-center">
          <div class="wrong-way is-hidden" data-wrong-way>逆行</div>
          <div class="race-notice" data-race-notice></div>
        </div>
        <div class="race-instruments">
          <div class="race-nitro" data-nitro-shell role="meter" aria-label="氮气" aria-valuemin="0" aria-valuemax="100">
            <div data-nitro-fill></div>
          </div>
          <div class="race-tacho" data-tacho>
            <div class="race-tacho-label">SHIFT</div>
            <div class="race-slip" data-drift-status><i data-slip-fill></i></div>
            <div class="race-boost-keys"><kbd>SPACE</kbd><kbd>CTRL</kbd></div>
            <div class="race-speed" aria-label="时速">
              <strong data-speed>0</strong><span aria-hidden="true" data-speed-digits><i></i><i></i><i></i></span>
            </div>
            <div class="race-tacho-icons" aria-hidden="true"><i></i><i></i><i></i></div>
          </div>
        </div>
        <div class="race-actions">
          <button type="button" data-hud-action="pause" aria-label="暂停" title="暂停（Esc）">${pauseIcon}</button>
          <button type="button" data-hud-action="mute" aria-label="静音" title="声音（M）">${speakerIcon}</button>
          <button type="button" data-hud-action="fullscreen" aria-label="全屏" title="全屏">${fullscreenIcon}</button>
        </div>

        <div class="touch-controls" data-touch-controls>
          <div class="touch-steer">
            <button type="button" data-control="left" aria-label="向左">‹</button>
            <button type="button" data-control="right" aria-label="向右">›</button>
          </div>
          <div class="touch-pedals">
            <button type="button" class="touch-mini" data-control="drift">漂移</button>
            <button type="button" class="touch-mini" data-control="boost">氮气</button>
            <button type="button" class="touch-mini" data-control="brake">刹车</button>
            <button type="button" class="touch-throttle" data-control="throttle">加速</button>
          </div>
        </div>
      </section>

      <div class="countdown-layer is-hidden" data-countdown-layer role="status" aria-live="assertive" aria-atomic="true">
        <span class="sr-only" data-countdown></span>
        ${GRID_SIGNALS.map(signal => `<img hidden alt="" width="250" height="98" data-signal="${signal}" src="/assets/ui/countdown/${signal === "开始" ? "start" : signal}.png">`).join("")}
      </div>

      <div class="loading-screen is-hidden" data-loading>
        <div class="loading-art"><img data-loading-art alt="" /></div>
        <div class="loading-panel">
          <span class="loading-kicker">赛道加载</span>
          <h2 data-loading-name></h2>
          <div class="loading-progress"><i data-loading-progress></i></div>
          <span class="loading-hint" data-loading-hint>准备中</span>
          <button type="button" class="loading-retry is-hidden" data-modal-action="retry">重试</button>
        </div>
      </div>

      <div class="modal-layer is-hidden" data-pause-overlay>
        <section class="modal-card pause-card" role="dialog" aria-modal="true" aria-label="暂停">
          <h2 class="window-title">菜单</h2>
          <button type="button" class="window-close" data-modal-action="resume" aria-label="继续比赛">×</button>
          <div class="pause-actions">
            <button type="button" data-modal-action="restart"><span aria-hidden="true">⟲</span>重新开始</button>
            <button type="button" data-modal-action="quit"><span aria-hidden="true">☰</span>返回计时赛</button>
          </div>
        </section>
      </div>

      <div class="modal-layer is-hidden" data-result-overlay>
        <section class="modal-card result-card" role="dialog" aria-modal="true" aria-label="比赛结果">
          <h2 class="window-title">计时赛成绩</h2>
          <h3 data-result-name></h3>
          <div class="result-time" data-result-time>00:00.000</div>
          <div class="record-badge is-hidden" data-record-badge>新纪录</div>
          <div class="result-stats">
            <div><span>最快圈</span><strong data-result-best-lap>00:00.000</strong></div>
            <div><span>上次最佳</span><strong data-result-previous>--:--.---</strong></div>
          </div>
          <div class="lap-list" data-result-laps></div>
          <div class="modal-actions">
            <button type="button" class="primary-button" data-modal-action="restart">再来一次</button>
            <button type="button" data-modal-action="quit">返回计时赛</button>
          </div>
        </section>
      </div>
    `;

    this.root.addEventListener("click", this.onClick);
    this.hideAll();
  }

  show(track: TrackInfo, minimap: MinimapProjection | null) {
    this.track = track;
    const hud = this.query(".hud");
    hud?.classList.remove("is-hidden");
    this.root.classList.add("hud-active");
    const map = this.query<SVGSVGElement>("[data-minimap]");
    if (map) {
      const width = minimap?.width ?? 256;
      const height = minimap?.height ?? 256;
      map.setAttribute("viewBox", `0 0 ${width} ${height}`);
      map.setAttribute("aria-label", `${track.name} 地图`);
      this.query<SVGPathElement>("[data-minimap-path]")?.setAttribute(
        "d",
        minimap?.path ?? "",
      );
    }
    this.overview = false;
    this.query("[data-race-map]")?.classList.remove("is-overview");
    this.query('[data-hud-action="map"]')?.setAttribute("aria-pressed", "false");
    this.setText("[data-grid-track]", track.name);
    this.setText("[data-grid-theme]", `${track.theme}主题`);
    const gridCard = this.query<HTMLImageElement>("[data-grid-card]");
    if (gridCard) gridCard.src = `/assets/${track.card}`;
    const difficulty = this.query("[data-grid-difficulty]");
    if (difficulty) {
      difficulty.setAttribute("aria-label", `难度 ${track.difficulty} 级`);
      difficulty.innerHTML = Array.from({ length: 6 }, (_, index) =>
        `<i class="${index < track.difficulty ? "filled" : ""}"></i>`,
      ).join("");
    }
    this.setGridPreview(true);
    this.setText("[data-total-laps]", "2");
    this.setLap(1, 2);
    this.setTime(0);
    this.setBestLap(null);
    this.setRaceCounts(0, 0);
    this.lastSpeed = -1;
    this.setSpeed(0);
    this.setGauge(0, false);
    this.setDrift(false, 0);
    this.setBoost(false);
    this.setWrongWay(false);
    this.hidePause();
    this.hideResult();
  }

  hide() {
    this.query(".hud")?.classList.add("is-hidden");
    this.root.classList.remove("hud-active");
    this.hideAll();
  }

  setLap(lap: number, total: number) {
    this.setText("[data-lap]", String(Math.min(total, lap)));
    this.setText("[data-total-laps]", String(total));
  }

  setTime(milliseconds: number) {
    this.setText("[data-race-time]", raceClock(milliseconds));
    this.query("[data-item-tip]")?.classList.toggle("is-visible", milliseconds > 0 && milliseconds < 8000);
  }

  setBestLap(milliseconds: number | null) {
    this.setText("[data-best-lap]", raceClock(milliseconds ?? 0));
  }

  setRaceCounts(collisions: number, boosts: number) {
    this.setText("[data-hit-count]", `${collisions} 次`);
    this.setText("[data-boost-count]", `${boosts} 次`);
  }

  setGridPreview(visible: boolean) {
    this.query("[data-grid-preview]")?.classList.toggle("is-hidden", !visible);
  }

  setSpeed(kilometersPerHour: number) {
    const speed = Math.max(0, Math.min(999, Math.round(kilometersPerHour)));
    if (speed === this.lastSpeed) return;
    this.lastSpeed = speed;
    const digits = String(speed);
    this.setText("[data-speed]", digits);
    const dial = this.query("[data-tacho]");
    dial?.classList.toggle("is-moving", speed > 0);
    dial?.classList.toggle("is-fast", speed >= 160);
    this.query("[data-speed-digits]")?.querySelectorAll("i").forEach((sprite, index) => {
      const digit = digits[index];
      sprite.hidden = digit === undefined;
      if (digit !== undefined) {
        const cell = (Number(digit) + 9) % 10;
        sprite.style.backgroundPositionX = `${cell * 100 / 9}%`;
      }
    });
  }

  setGauge(ratio: number, ready: boolean) {
    const shell = this.query("[data-nitro-shell]");
    const fill = this.query<HTMLElement>("[data-nitro-fill]");
    if (fill) {
      const percent = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
      fill.style.clipPath = `inset(0 ${100 - percent}% 0 0)`;
      shell?.setAttribute("aria-valuenow", String(percent));
    }
    shell?.classList.toggle("is-ready", ready);
    const slot = this.query("[data-item-slot]");
    slot?.classList.toggle("is-ready", ready);
    slot?.setAttribute("aria-label", ready ? "氮气已就绪" : "空道具栏");
  }

  setDrift(active: boolean, charge: number) {
    const status = this.query("[data-drift-status]");
    status?.classList.toggle("is-active", active);
    const fill = this.query("[data-slip-fill]");
    if (fill) fill.style.transform = `scaleX(${active ? Math.max(0, Math.min(1, charge)) : 0})`;
  }

  setBoost(active: boolean) {
    const hud = this.query(".hud");
    hud?.classList.toggle("is-boosting", active);
  }

  setWrongWay(active: boolean) {
    this.query("[data-wrong-way]")?.classList.toggle("is-hidden", !active);
  }

  setMinimap(x: number, y: number, heading: number, visible = true) {
    this.mapPosition.x = x;
    this.mapPosition.y = y;
    this.mapPosition.heading = heading;
    const marker = this.query<HTMLElement>("[data-minimap-marker]");
    if (!marker) {
      return;
    }
    marker.classList.toggle("is-hidden", !visible);
    this.drawMap(marker);
  }

  private drawMap(marker: HTMLElement) {
    const { x, y, heading } = this.mapPosition;
    const gridHeading = this.track?.startYaw ?? 0;
    const road = this.query<SVGGElement>("[data-minimap-road]");
    road?.setAttribute("transform", this.overview ? "translate(0 256) scale(1 -1)" :
      `translate(128 115) scale(-2.8 2.8) rotate(${-gridHeading * 180 / Math.PI}) translate(${-x * 256} ${-y * 256})`);
    marker.style.left = `${this.overview ? x * 100 : 50}%`;
    marker.style.top = `${this.overview ? (1 - y) * 100 : 115 / 256 * 100}%`;
    marker.style.rotate = `${this.overview ? Math.PI - heading : gridHeading - heading}rad`;
  }

  notice(text: string, duration = 1800, kind: "good" | "warn" = "good") {
    const element = this.query("[data-race-notice]");
    if (!element) {
      return;
    }
    window.clearTimeout(this.noticeTimer);
    element.textContent = text;
    element.className = `race-notice is-visible ${kind}`;
    this.noticeTimer = window.setTimeout(() => {
      element.classList.remove("is-visible");
    }, duration);
  }

  showCountdown(signal: (typeof GRID_SIGNALS)[number]) {
    const layer = this.query("[data-countdown-layer]");
    if (!layer) {
      return;
    }
    layer.classList.remove("is-hidden");
    this.setText("[data-countdown]", signal);
    for (const image of layer.querySelectorAll<HTMLImageElement>("[data-signal]")) {
      image.hidden = image.dataset.signal !== signal;
    }
  }

  hideCountdown() {
    this.query("[data-countdown-layer]")?.classList.add("is-hidden");
  }

  showLoading(track: TrackInfo) {
    const loading = this.query("[data-loading]");
    loading?.classList.remove("is-hidden");
    const art = this.query<HTMLImageElement>("[data-loading-art]");
    if (art) {
      art.src = `/assets/${track.card}`;
      art.alt = "";
    }
    this.setText("[data-loading-name]", track.name);
    this.query("[data-loading-hint]")?.classList.remove("is-hidden", "is-error");
    this.query(".loading-retry")?.classList.add("is-hidden");
    this.setLoadingProgress(0, "准备中");
  }

  setLoadingProgress(progress: number, hint: string) {
    const bar = this.query<HTMLElement>("[data-loading-progress]");
    if (bar) {
      bar.style.transform = `scaleX(${Math.max(0.03, Math.min(1, progress))})`;
    }
    this.setText("[data-loading-hint]", hint);
  }

  hideLoading() {
    this.query("[data-loading]")?.classList.add("is-hidden");
    this.query("[data-loading-hint]")?.classList.remove("is-error");
    this.query("[data-loading-hint]")?.classList.add("is-hidden");
    this.query(".loading-retry")?.classList.add("is-hidden");
  }

  showLoadError(message: string) {
    this.query("[data-loading]")?.classList.remove("is-hidden");
    const hint = this.query("[data-loading-hint]");
    if (hint) {
      hint.textContent = message;
      hint.classList.remove("is-hidden");
      hint.classList.add("is-error");
    }
    this.query(".loading-retry")?.classList.remove("is-hidden");
  }

  showPause() {
    this.query("[data-pause-overlay]")?.classList.remove("is-hidden");
    this.query(".hud")?.setAttribute("inert", "");
    this.query('[data-modal-action="resume"]')?.focus();
  }

  hidePause() {
    this.query("[data-pause-overlay]")?.classList.add("is-hidden");
    this.query(".hud")?.removeAttribute("inert");
  }

  showResult(result: RaceResult) {
    this.hidePause();
    this.query("[data-result-overlay]")?.classList.remove("is-hidden");
    this.query(".hud")?.setAttribute("inert", "");
    this.query('[data-result-overlay] [data-modal-action="restart"]')?.focus();
    this.setText("[data-result-name]", result.trackName);
    this.setText("[data-result-time]", formatTime(result.totalTime));
    this.setText("[data-result-best-lap]", formatTime(result.bestLap));
    this.setText("[data-result-previous]", formatTime(result.previousBest));
    const lapList = this.query<HTMLElement>("[data-result-laps]");
    if (lapList) {
      lapList.innerHTML = result.laps
        .map(
          (time, index) =>
            `<div class="lap-row"><span>第 ${index + 1} 圈</span><strong>${formatTime(time)}</strong></div>`,
        )
        .join("");
    }
    this.query("[data-record-badge]")?.classList.toggle("is-hidden", !result.isRecord);
  }

  hideResult() {
    this.query("[data-result-overlay]")?.classList.add("is-hidden");
    this.query(".hud")?.removeAttribute("inert");
  }

  setMuted(muted: boolean) {
    const button = this.query<HTMLElement>('[data-hud-action="mute"]');
    if (!button) {
      return;
    }
    button.innerHTML = muted ? mutedIcon : speakerIcon;
    button.setAttribute("aria-label", muted ? "开启声音" : "静音");
    button.classList.toggle("is-muted", muted);
  }

  private hideAll() {
    for (const selector of [
      "[data-loading]",
      "[data-countdown-layer]",
      "[data-pause-overlay]",
      "[data-result-overlay]",
    ]) {
      this.query(selector)?.classList.add("is-hidden");
    }
    this.query("[data-race-notice]")?.classList.remove("is-visible");
  }

  private onClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement;
    const hudAction = target.closest<HTMLElement>("[data-hud-action]")?.dataset.hudAction;
    if (hudAction === "map") {
      this.overview = !this.overview;
      this.query("[data-race-map]")?.classList.toggle("is-overview", this.overview);
      this.query('[data-hud-action="map"]')?.setAttribute("aria-pressed", String(this.overview));
      const marker = this.query<HTMLElement>("[data-minimap-marker]");
      if (marker) this.drawMap(marker);
      return;
    }
    if (hudAction === "pause") {
      this.actions.onPause();
      return;
    }
    if (hudAction === "mute") {
      this.setMuted(this.actions.onToggleMute());
      return;
    }
    if (hudAction === "fullscreen") {
      this.actions.onFullscreen();
      return;
    }

    const modalAction = target.closest<HTMLElement>("[data-modal-action]")?.dataset.modalAction;
    if (modalAction === "resume") {
      this.actions.onResume();
    } else if (modalAction === "restart") {
      this.actions.onRestart();
    } else if (modalAction === "quit") {
      this.actions.onQuit();
    } else if (modalAction === "retry") {
      this.actions.onRetry();
    }
  };

  private query<T extends Element = HTMLElement>(selector: string) {
    return this.root.querySelector<T>(selector);
  }

  private setText(selector: string, text: string) {
    const element = this.query(selector);
    if (element) {
      element.textContent = text;
    }
  }
}
