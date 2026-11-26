import type { TrackInfo, TrackRecord } from "../types";
import type { MinimapProjection } from "../game/world";
import { formatTime } from "../util/format";

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

export class Hud {
  private root: HTMLElement;
  private actions: HudActions;
  private noticeTimer = 0;
  private track: TrackInfo | null = null;
  private mounted = false;

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
      <section class="hud is-hidden" aria-label="比赛信息">
        <div class="hud-top-left">
          <div class="lap-panel">
            <span class="hud-kicker">LAP</span>
            <div class="lap-count"><strong data-lap>1</strong><span>/<span data-total-laps>2</span></span></div>
          </div>
          <div class="time-panel">
            <span class="hud-kicker">时间</span>
            <strong class="race-time" data-race-time>00:00.000</strong>
            <span class="lap-time" data-lap-time>本圈 00:00.000</span>
          </div>
        </div>

        <div class="hud-top-right">
          <div class="hud-buttons">
            <button type="button" class="hud-icon-button" data-hud-action="mute" aria-label="静音">${speakerIcon}</button>
            <button type="button" class="hud-icon-button" data-hud-action="fullscreen" aria-label="全屏">${fullscreenIcon}</button>
            <button type="button" class="hud-icon-button" data-hud-action="pause" aria-label="暂停">${pauseIcon}</button>
          </div>
          <div class="minimap-shell">
            <div class="minimap-frame">
              <svg data-minimap viewBox="0 0 256 256" role="img" aria-label="">
                <path data-minimap-path d="" />
              </svg>
              <div class="minimap-marker" data-minimap-marker><i></i></div>
              <div class="minimap-glass"></div>
            </div>
            <span class="minimap-name" data-map-name></span>
          </div>
        </div>

        <div class="race-center">
          <div class="wrong-way is-hidden" data-wrong-way>逆行</div>
          <div class="race-notice" data-race-notice></div>
        </div>

        <div class="hud-bottom-right">
          <div class="drift-status" data-drift-status>
            <span class="drift-label">DRIFT</span>
            <span class="drift-pips"><i></i><i></i><i></i></span>
          </div>
          <div class="speed-plate">
            <img src="/assets/ui/tacho_v1_baseBG_2.png" alt="" />
            <strong class="speed-number" data-speed>000</strong>
            <span class="boost-tag" data-boost-tag>N2O</span>
          </div>
        </div>

        <div class="hud-bottom-left">
          <div class="nitro-shell" data-nitro-shell>
            <div class="nitro-head">
              <span>氮气</span>
              <span class="nitro-key">CTRL</span>
            </div>
            <div class="nitro-track">
              <div class="nitro-bg"></div>
              <div class="nitro-fill" data-nitro-fill></div>
              <div class="nitro-frame"></div>
            </div>
          </div>
          <div class="race-controls-hint">
            <span><kbd>SHIFT</kbd> 漂移</span>
            <span><kbd>R</kbd> 重置</span>
            <span><kbd>ESC</kbd> 暂停</span>
          </div>
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
        <strong data-countdown></strong>
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
          <span class="modal-kicker">PAUSE</span>
          <h2>暂停</h2>
          <div class="pause-summary">
            <div><span>当前圈</span><strong data-pause-lap>1 / 2</strong></div>
            <div><span>用时</span><strong data-pause-time>00:00.000</strong></div>
          </div>
          <div class="modal-actions stack">
            <button type="button" class="primary-button" data-modal-action="resume">继续比赛</button>
            <button type="button" data-modal-action="restart">重新开始</button>
            <button type="button" data-modal-action="quit">选择赛道</button>
          </div>
          <div class="modal-footer-hint"><kbd>ESC</kbd> 继续</div>
        </section>
      </div>

      <div class="modal-layer is-hidden" data-result-overlay>
        <section class="modal-card result-card" role="dialog" aria-modal="true" aria-label="比赛结果">
          <span class="modal-kicker">FINISH</span>
          <h2 data-result-name></h2>
          <div class="result-time" data-result-time>00:00.000</div>
          <div class="record-badge is-hidden" data-record-badge>新纪录</div>
          <div class="result-stats">
            <div><span>最快圈</span><strong data-result-best-lap>00:00.000</strong></div>
            <div><span>上次最佳</span><strong data-result-previous>--:--.---</strong></div>
          </div>
          <div class="lap-list" data-result-laps></div>
          <div class="modal-actions">
            <button type="button" class="primary-button" data-modal-action="restart">再来一次</button>
            <button type="button" data-modal-action="quit">选择赛道</button>
          </div>
        </section>
      </div>
    `;

    this.root.addEventListener("click", this.onClick);
    this.hideAll();
  }

  show(track: TrackInfo, minimap: MinimapProjection | null) {
    this.track = track;
    this.mounted = true;
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
    this.setText("[data-map-name]", track.name);
    this.setText("[data-total-laps]", "2");
    this.setLap(1, 2);
    this.setTime(0);
    this.setLapTime(0);
    this.setSpeed(0);
    this.setGauge(0, false);
    this.setDrift(false, 0);
    this.setBoost(false);
    this.setWrongWay(false);
    this.hidePause();
    this.hideResult();
  }

  hide() {
    this.mounted = false;
    this.query(".hud")?.classList.add("is-hidden");
    this.root.classList.remove("hud-active");
    this.hideAll();
  }

  setLap(lap: number, total: number) {
    this.setText("[data-lap]", String(Math.min(total, lap)));
    this.setText("[data-total-laps]", String(total));
    this.setText("[data-pause-lap]", `${Math.min(total, lap)} / ${total}`);
  }

  setTime(milliseconds: number) {
    this.setText("[data-race-time]", formatTime(milliseconds));
    this.setText("[data-pause-time]", formatTime(milliseconds));
  }

  setLapTime(milliseconds: number) {
    this.setText("[data-lap-time]", `本圈 ${formatTime(milliseconds)}`);
  }

  setSpeed(kilometersPerHour: number) {
    this.setText("[data-speed]", Math.min(999, Math.round(kilometersPerHour)).toString().padStart(3, "0"));
  }

  setGauge(ratio: number, ready: boolean) {
    const shell = this.query("[data-nitro-shell]");
    const fill = this.query<HTMLElement>("[data-nitro-fill]");
    if (fill) {
      fill.style.transform = `scaleX(${Math.max(0, Math.min(1, ratio))})`;
    }
    shell?.classList.toggle("is-ready", ready);
  }

  setDrift(active: boolean, charge: number) {
    const status = this.query("[data-drift-status]");
    status?.classList.toggle("is-active", active);
    const pips = status?.querySelectorAll<HTMLElement>(".drift-pips i") ?? [];
    pips.forEach((pip, index) => {
      pip.classList.toggle("is-lit", active && charge >= (index + 1) / 3);
    });
  }

  setBoost(active: boolean) {
    const hud = this.query(".hud");
    hud?.classList.toggle("is-boosting", active);
    this.query("[data-boost-tag]")?.classList.toggle("is-active", active);
  }

  setWrongWay(active: boolean) {
    this.query("[data-wrong-way]")?.classList.toggle("is-hidden", !active);
  }

  setMinimap(x: number, y: number, heading: number, visible = true) {
    const marker = this.query<HTMLElement>("[data-minimap-marker]");
    if (!marker) {
      return;
    }
    marker.style.left = `${Math.max(-0.04, Math.min(1.04, x)) * 100}%`;
    marker.style.top = `${Math.max(-0.04, Math.min(1.04, y)) * 100}%`;
    marker.style.rotate = `${heading}rad`;
    marker.classList.toggle("is-hidden", !visible);
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

  showCountdown(text: string) {
    const layer = this.query("[data-countdown-layer]");
    if (!layer) {
      return;
    }
    layer.classList.remove("is-hidden");
    layer.classList.toggle("is-go", text === "GO!");
    const strong = layer.querySelector<HTMLElement>("[data-countdown]");
    if (strong) {
      strong.textContent = text;
      strong.classList.remove("pop");
      void strong.offsetWidth;
      strong.classList.add("pop");
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
  }

  hidePause() {
    this.query("[data-pause-overlay]")?.classList.add("is-hidden");
  }

  showResult(result: RaceResult) {
    this.hidePause();
    this.query("[data-result-overlay]")?.classList.remove("is-hidden");
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
