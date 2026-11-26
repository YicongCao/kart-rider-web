import type { TrackInfo, TrackRecord } from "../types";
import { formatDistance, formatTime } from "../util/format";

interface MenuActions {
  onSelect: (trackId: string) => void;
  onStart: (trackId: string) => void;
  onToggleMute: () => boolean;
  onFullscreen: () => void;
}

const iconVolume = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path class="wave" d="M16 8.5a5 5 0 0 1 0 7M18.8 6a8.5 8.5 0 0 1 0 12"/></svg>`;
const iconMuted = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path class="wave" d="m16 9 5 5m0-5-5 5"/></svg>`;
const iconFullscreen = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg>`;

export class Menu {
  private root: HTMLElement;
  private tracks: TrackInfo[];
  private records: Record<string, TrackRecord>;
  private actions: MenuActions;
  private selectedId: string;
  private element: HTMLElement | null = null;

  constructor(
    root: HTMLElement,
    tracks: TrackInfo[],
    records: Record<string, TrackRecord>,
    actions: MenuActions,
  ) {
    this.root = root;
    this.tracks = tracks;
    this.records = records;
    this.actions = actions;
    this.selectedId = tracks[0]?.id ?? "";
  }

  mount() {
    this.root.innerHTML = `
      <section class="menu-screen" aria-label="赛道选择">
        <div class="menu-wash"></div>
        <div class="menu-grid-lines"></div>
        <header class="menu-topbar">
          <div class="brand" aria-label="跑跑卡丁车">
            <span class="brand-emblem"><span>KR</span></span>
            <span class="brand-copy">
              <span class="brand-kicker">KART RIDER</span>
              <span class="brand-title">跑跑卡丁车</span>
            </span>
          </div>
          <div class="menu-actions">
            <button class="round-action" type="button" data-menu-action="fullscreen" aria-label="全屏">${iconFullscreen}</button>
            <button class="round-action" type="button" data-menu-action="mute" aria-label="静音">${iconVolume}</button>
          </div>
        </header>

        <main class="menu-layout">
          <section class="track-hero" aria-live="polite">
            <div class="hero-backdrop"><img data-hero-backdrop alt="" /></div>
            <div class="hero-art">
              <img data-hero-card alt="" />
              <span class="hero-number" data-hero-number>01</span>
            </div>
            <div class="hero-copy">
              <span class="hero-theme" data-hero-theme></span>
              <h1 data-hero-name></h1>
              <div class="hero-facts">
                <span>2 圈</span>
                <span data-hero-length></span>
                <span data-hero-difficulty></span>
              </div>
              <div class="hero-best">
                <span>最佳</span>
                <strong data-hero-best>--:--.---</strong>
              </div>
            </div>
          </section>

          <aside class="track-picker">
            <div class="picker-heading">
              <span>赛道</span>
              <span data-track-count></span>
            </div>
            <div class="track-grid" role="listbox" aria-label="赛道列表">
              ${this.tracks
                .map(
                  (track, index) => `
                    <button class="track-option" type="button" role="option" data-track-id="${track.id}">
                      <span class="track-option-art">
                        <img src="/assets/${track.thumb}" alt="" draggable="false" />
                        <span class="track-index">${(index + 1).toString().padStart(2, "0")}</span>
                      </span>
                      <span class="track-option-copy">
                        <strong>${track.name}</strong>
                        <small data-option-record="${track.id}">--:--.---</small>
                      </span>
                      <span class="track-option-mark"></span>
                    </button>`,
                )
                .join("")}
            </div>
            <button class="start-button" type="button" data-menu-action="start">
              <span class="start-button-glow"></span>
              <span class="start-label">开始比赛</span>
              <span class="start-arrow">›</span>
            </button>
          </aside>
        </main>

        <footer class="menu-footer">
          <div class="control-chips">
            <span><kbd>W</kbd><kbd>S</kbd> 加速 / 刹车</span>
            <span><kbd>A</kbd><kbd>D</kbd> 转向</span>
            <span><kbd>SHIFT</kbd> 漂移</span>
            <span><kbd>CTRL</kbd> 氮气</span>
          </div>
          <div class="footer-rule"></div>
          <span class="footer-note">键盘 · 触屏</span>
        </footer>
      </section>
    `;

    this.element = this.root.querySelector(".menu-screen");
    this.root.addEventListener("click", this.onClick);
    this.refresh();
  }

  show(trackId?: string) {
    if (trackId) {
      this.selectedId = trackId;
    }
    this.refresh();
    this.root.classList.remove("is-hidden");
    this.root.classList.add("is-visible");
  }

  hide() {
    this.root.classList.remove("is-visible");
    this.root.classList.add("is-hidden");
  }

  setSelected(trackId: string) {
    if (!this.tracks.some((track) => track.id === trackId)) {
      return;
    }
    this.selectedId = trackId;
    this.refresh();
  }

  getSelectedId() {
    return this.selectedId;
  }

  refreshRecords(records: Record<string, TrackRecord>) {
    this.records = records;
    this.refresh();
  }

  setMuted(muted: boolean) {
    const button = this.root.querySelector<HTMLElement>('[data-menu-action="mute"]');
    if (!button) {
      return;
    }
    button.innerHTML = muted ? iconMuted : iconVolume;
    button.setAttribute("aria-label", muted ? "开启声音" : "静音");
    button.classList.toggle("is-muted", muted);
  }

  private refresh() {
    if (!this.element) {
      return;
    }
    const index = Math.max(
      0,
      this.tracks.findIndex((track) => track.id === this.selectedId),
    );
    const track = this.tracks[index];
    if (!track) {
      return;
    }
    const record = this.records[track.id];
    this.element.style.setProperty("--accent", track.accent);
    this.element.style.setProperty("--hero-image", `url("/assets/${track.card}")`);

    const backdrop = this.element.querySelector<HTMLImageElement>("[data-hero-backdrop]");
    const heroCard = this.element.querySelector<HTMLImageElement>("[data-hero-card]");
    if (backdrop) {
      backdrop.src = `/assets/${track.card}`;
    }
    if (heroCard) {
      heroCard.src = `/assets/${track.card}`;
      heroCard.alt = track.name;
    }
    this.setText("[data-hero-number]", (index + 1).toString().padStart(2, "0"));
    this.setText("[data-hero-theme]", track.theme);
    this.setText("[data-hero-name]", track.name);
    this.setText("[data-hero-length]", formatDistance(track.length));
    this.setText("[data-hero-difficulty]", ["简单", "适中", "困难"][track.difficulty - 1] ?? "适中");
    this.setText("[data-hero-best]", formatTime(record?.bestTime ?? null));
    this.setText("[data-track-count]", `${this.tracks.length} 条`);

    for (const option of this.element.querySelectorAll<HTMLElement>("[data-track-id]")) {
      const selected = option.dataset.trackId === this.selectedId;
      option.setAttribute("aria-selected", selected ? "true" : "false");
      option.classList.toggle("is-selected", selected);
    }
    for (const track of this.tracks) {
      const label = this.element.querySelector<HTMLElement>(
        `[data-option-record="${track.id}"]`,
      );
      if (label) {
        label.textContent = formatTime(this.records[track.id]?.bestTime ?? null);
      }
    }
  }

  private setText(selector: string, text: string) {
    const element = this.element?.querySelector<HTMLElement>(selector);
    if (element) {
      element.textContent = text;
    }
  }

  private onClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement;
    const option = target.closest<HTMLElement>("[data-track-id]");
    if (option?.dataset.trackId) {
      this.selectedId = option.dataset.trackId;
      this.refresh();
      this.actions.onSelect(this.selectedId);
      return;
    }

    const action = target.closest<HTMLElement>("[data-menu-action]")?.dataset.menuAction;
    if (action === "start") {
      this.actions.onStart(this.selectedId);
    } else if (action === "mute") {
      this.setMuted(this.actions.onToggleMute());
    } else if (action === "fullscreen") {
      this.actions.onFullscreen();
    }
  };
}
