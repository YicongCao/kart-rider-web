import "./menu.css";
import type { TrackInfo, TrackRecord } from "../types";
import { formatDistance, formatTime } from "../util/format";

interface MenuActions {
  onSelect: (trackId: string) => void;
  onStart: (trackId: string) => void;
  onToggleMute: () => boolean;
  onFullscreen: () => void;
}

type Screen = "home" | "solo" | "practice" | "room";
const storageKey = "kart-rider-remake.menu-track.v1";
const art = "/assets/ui/lobby/";
const paths = {
  home: "M2 10 12 2l10 8-2 1v10h-6v-6h-4v6H4V11z",
  clock:
    "M10 1h4v2h-4z M12 4a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 3a6 6 0 1 1 0 12 6 6 0 0 1 0-12zm-1 1h2v5l-3 3-1.5-1.5 2.5-2.5z",
  track:
    "M4 4h13a5 5 0 0 1 0 10h-3v4a4 4 0 0 1-8 0v-4a5 5 0 0 1-2-10zm1 3a2 2 0 0 0 0 4h4v7a1 1 0 0 0 2 0v-7h6a2 2 0 0 0 0-4z",
  flag: "M4 2h2v20H4z M7 3c5-3 7 3 13 0v10c-6 3-8-3-13 0z",
  volume:
    "M2 9h4l6-5v16l-6-5H2z M15 8a5 5 0 0 1 0 8l-1.1-1.6a3 3 0 0 0 0-4.8z M17 4a10 10 0 0 1 0 16l-1-1.7a8 8 0 0 0 0-12.6z",
  mute: "M2 9h4l6-5v16l-6-5H2z M15 9l1.4-1.4L19 10l2.6-2.4L23 9l-2.6 2.6L23 14.2l-1.4 1.4L19 13l-2.6 2.6-1.4-1.4 2.6-2.6z",
  full: "M2 2h8v3H5v5H2z M14 2h8v8h-3V5h-5z M22 14v8h-8v-3h5v-5z M2 14h3v5h5v3H2z",
} as const;

function icon(name: keyof typeof paths) {
  return `<svg aria-hidden="true" viewBox="0 0 24 24"><path fill="currentColor" fill-rule="evenodd" d="${paths[name]}"/></svg>`;
}

function escape(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}

function trackName(track: TrackInfo) {
  return escape(track.name.replace(track.theme, track.theme + " "));
}

function award(label: string, image: string, time?: number | null) {
  return `<div class="p-award">
    <h3>${label}</h3>
    <img src="${art}${image}.webp" alt="">
    <strong>${time == null ? "暂无记录" : formatTime(time)}</strong>
  </div>`;
}

function recordBoard(track: TrackInfo, record?: TrackRecord) {
  return `<div class="p-awards">
    ${award("最佳用时", "rank-medals", record?.bestTime)}
    ${award("最快单圈", "lap-medal", record?.bestLap)}
  </div>
  <div class="p-current">
    <img src="/assets/${track.thumb}" alt="">
    <div><span>当前赛道</span><strong>${trackName(track)}</strong></div>
    <button type="button" data-menu-action="tracks">更换赛道 ›</button>
  </div>`;
}

export class Menu {
  private selectedId: string;
  private page: Screen = "home";
  private mounted = false;
  private shown = false;
  private muted = false;
  private picking = false;
  private draftId = "";
  private theme = "";

  constructor(
    private root: HTMLElement,
    private tracks: TrackInfo[],
    private records: Record<string, TrackRecord>,
    private actions: MenuActions,
  ) {
    this.selectedId = tracks[0]?.id ?? "";
    try {
      const previous = localStorage.getItem(storageKey);
      if (previous && tracks.some((track) => track.id === previous))
        this.selectedId = previous;
    } catch {
      this.selectedId = tracks[0]?.id ?? "";
    }
  }

  mount() {
    this.mounted = true;
    this.root.addEventListener("click", this.onClick);
    this.root.addEventListener("input", (event) => {
      if ((event.target as HTMLElement).matches("[data-search]"))
        this.filterTracks();
    });
    window.addEventListener("keydown", this.onKeyDown);
    this.render();
  }

  show(trackId?: string) {
    if (
      this.shown &&
      trackId &&
      this.tracks.some((track) => track.id === trackId)
    ) {
      this.selectedId = trackId;
      this.page = "room";
    }
    this.shown = true;
    this.root.classList.remove("is-hidden");
    this.render();
  }

  hide() {
    this.closePicker();
    this.root.classList.add("is-hidden");
  }

  getSelectedId() {
    return this.selectedId;
  }

  setSelected(trackId: string) {
    if (!this.tracks.some((track) => track.id === trackId)) return;
    this.selectedId = trackId;
    this.actions.onSelect(trackId);
    this.render();
    try {
      localStorage.setItem(storageKey, trackId);
    } catch {
      return;
    }
  }

  refreshRecords(records: Record<string, TrackRecord>) {
    this.records = records;
    this.render();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    const button = this.root.querySelector("[data-menu-action=mute]");
    if (button) {
      button.innerHTML = icon(muted ? "mute" : "volume");
      button.setAttribute("aria-pressed", String(muted));
      button.setAttribute("aria-label", muted ? "开启声音" : "静音");
      button.setAttribute("title", muted ? "开启声音" : "静音");
    }
  }

  confirm() {
    if (this.picking) {
      const option = this.root.querySelector<HTMLElement>(
        "[data-track-id][aria-pressed=true]",
      );
      if (option && !option.hidden) {
        this.closePicker();
        this.page = "room";
        this.setSelected(this.draftId);
      }
      return;
    }
    if (this.page === "room") this.actions.onStart(this.selectedId);
    else
      this.navigate(
        this.page === "home"
          ? "solo"
          : this.page === "solo"
            ? "practice"
            : "room",
      );
  }

  private navigate(page: Screen) {
    this.closePicker();
    this.page = page;
    this.render();
    this.root
      .querySelector<HTMLElement>("[data-arrival]")
      ?.focus({ preventScroll: true });
  }

  private render() {
    if (!this.mounted) return;
    const track = this.tracks.find((entry) => entry.id === this.selectedId);
    if (!track) return;
    const nav = (
      action: string,
      name: string,
      symbol: keyof typeof paths,
      active: boolean,
    ) =>
      `<button type="button" data-menu-action="${action}" ${active ? 'aria-current="page"' : ""}>${icon(symbol)}<span>${name}</span></button>`;
    this.root.innerHTML = `<main class="p-lobby" data-screen="${this.page}">
      <div class="p-profile"><img src="${art}profile.webp" alt=""><span>车手</span></div>
      ${this.page === "room" ? this.room(track) : this.hall(track)}
      <footer class="p-dock">
        <span class="p-mark" aria-hidden="true"><i></i></span>
        <nav aria-label="主菜单">
          ${nav("home", "大厅", "home", this.page === "home")}
          ${nav("solo", "单人游戏", "clock", this.page === "solo" || this.page === "practice")}
          ${nav("room", "练习房", "flag", this.page === "room")}
          ${nav("tracks", "选择赛道", "track", false)}
        </nav>
        <div class="p-tools"><button type="button" data-menu-action="mute"></button><button type="button" data-menu-action="fullscreen" title="全屏" aria-label="全屏">${icon("full")}</button></div>
      </footer>
    </main>`;
    this.setMuted(this.muted);
  }

  private hall(track: TrackInfo) {
    const home = this.page === "home";
    const solo = this.page === "solo";
    const quick = (
      action: string,
      title: string,
      variant: string,
      image: string,
    ) =>
      `<button type="button" class="p-quick ${variant}" data-menu-action="${action}"><img src="${art}${image}.webp" alt=""><b>${title}</b><span aria-hidden="true">❯❯</span></button>`;
    const card = (action: string, title: string, image: string) =>
      `<button type="button" class="p-mode" data-menu-action="${action}"><img src="${image}" alt=""><strong>${title} ›</strong></button>`;
    const modeTitle = solo ? "计时赛" : "练习计时赛";
    const modeAction = solo ? "practice" : "room";
    const modeCards = `<div class="p-mode-grid">
      ${card(modeAction, modeTitle, art + (solo ? "solo-art.webp" : "practice-art.webp"))}
      ${card("tracks", "选择赛道", "/assets/" + track.card)}
    </div>`;
    return `<div class="p-hall">
      <section class="p-shortcuts">
        <h1 class="p-strip" tabindex="-1" data-arrival>${home ? "快速开始设置" : "单人游戏"}</h1>
        ${home ? "" : '<button class="p-tab" type="button" data-menu-action="practice">◴　计时赛</button>'}
        ${quick(home ? "room" : modeAction, home ? "个人竞速赛" : modeTitle, "speed", "speed-rider")}
        ${quick("tracks", "选择赛道", "tracks", "track-rider")}
      </section>
      <section class="p-side"><h2 class="p-strip">${home ? "计时赛记录" : solo ? "单人游戏" : "计时赛"}</h2>
        <div class="p-board">${home ? recordBoard(track, this.records[track.id]) : modeCards}</div>
      </section>
    </div>`;
  }

  private room(track: TrackInfo) {
    const record = this.records[track.id];
    const row = (key: string, value: string) =>
      `<div><dt>${key}</dt><dd>${value}</dd></div>`;
    return `<section class="p-room">
      <h1 class="p-title" tabindex="-1" data-arrival>计时赛<button type="button" data-menu-action="practice" aria-label="返回计时赛模式">×</button></h1>
      <div class="p-studio">
        <div class="p-objectives">
          <h2>练习目标</h2>
          <b>完成赛道</b>
          <div class="p-progress"><span style="width:${record?.runs ? "100%" : "0"}"></span></div>
          <span>已完赛 ${record?.runs ?? 0} 次</span>
        </div>
      </div>
      <div class="p-room-controls">
        <button type="button" class="p-course" data-menu-action="tracks">
          <img src="/assets/${track.card}" alt=""><strong>${trackName(track)}</strong>
        </button>
        <div class="p-spec">
          <h2>目前记录</h2>
          <dl>
            ${row("最高纪录", formatTime(record?.bestTime ?? null))}
            ${row("最快单圈", formatTime(record?.bestLap ?? null))}
            ${row("完赛次数", String(record?.runs ?? 0))}
          </dl>
        </div>
        <div class="p-spec">
          <h2>设置</h2>
          <dl>
            ${row("竞速模式", "个人赛")}
            ${row("赛道圈数", "2 圈")}
            ${row("单圈距离", formatDistance(track.length))}
          </dl>
        </div>
        <div class="p-room-actions">
          <button type="button" class="p-primary" data-menu-action="start">▶　开始 (F5)</button>
          <button type="button" data-menu-action="tracks">${icon("track")}选择赛道</button>
        </div>
      </div>
    </section>`;
  }

  private openPicker() {
    if (this.picking) return;
    this.picking = true;
    this.draftId = this.selectedId;
    this.theme = "";
    const dialog = document.createElement("dialog");
    dialog.className = "p-picker";
    dialog.setAttribute("aria-label", "选择赛道");
    const themes = ["", ...new Set(this.tracks.map((track) => track.theme))];
    const categories = themes.map(
      (theme) =>
        `<button type="button" data-theme="${escape(theme)}" aria-pressed="${!theme}">${escape(theme) || "全部赛道"}</button>`,
    );
    const options = this.tracks.map(
      (
        track,
      ) => `<button class="p-tile" type="button" data-track-id="${escape(track.id)}" aria-pressed="${this.draftId === track.id}">
      <img src="/assets/${track.card}" alt="">
      <strong>${trackName(track)}</strong>
    </button>`,
    );
    dialog.innerHTML = `<h2 class="p-title">
        选择赛道<button data-menu-action="cancel" aria-label="关闭" type="button">×</button>
      </h2>
      <div class="p-search">
        <span>搜索全部赛道</span>
        <input data-search type="search" aria-label="搜索赛道" placeholder="输入赛道名称">
      </div>
      <div class="p-browser">
        <nav aria-label="赛道主题">${categories.join("")}</nav>
        <div class="p-courses">
          ${options.join("")}
          <p data-no-matches hidden>没有匹配的赛道</p>
        </div>
      </div>
      <div class="p-picker-actions">
        <button type="button" data-menu-action="apply" class="p-primary">确认</button>
        <button type="button" data-menu-action="cancel">取消</button>
      </div>`;
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.closePicker();
    });
    this.root.append(dialog);
    dialog.showModal();
  }

  private filterTracks() {
    const query =
      this.root
        .querySelector<HTMLInputElement>("[data-search]")
        ?.value.replace(/\s/g, "") ?? "";
    const visible = this.tracks.filter(
      (track) =>
        (!this.theme || track.theme === this.theme) &&
        track.name.replace(/\s/g, "").includes(query),
    );
    if (!visible.some((track) => track.id === this.draftId))
      this.draftId = visible[0]?.id ?? "";
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(
      "[data-track-id]",
    )) {
      button.hidden = !visible.some(
        (track) => track.id === button.dataset.trackId,
      );
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.trackId === this.draftId),
      );
    }
    for (const button of this.root.querySelectorAll("[data-theme]")) {
      button.setAttribute(
        "aria-pressed",
        String(button.getAttribute("data-theme") === this.theme),
      );
    }
    this.root.querySelector<HTMLElement>("[data-no-matches]")!.hidden =
      visible.length > 0;
    this.root.querySelector<HTMLButtonElement>(
      "[data-menu-action=apply]",
    )!.disabled = !this.draftId;
  }

  private closePicker() {
    const dialog = this.root.querySelector("dialog");
    dialog?.close();
    dialog?.remove();
    this.picking = false;
  }

  private onClick = (event: MouseEvent) => {
    const button = (event.target as Element).closest<HTMLButtonElement>(
      "button",
    );
    if (!button) return;
    if (button.dataset.trackId) {
      this.draftId = button.dataset.trackId;
      this.filterTracks();
      return;
    }
    if (button.dataset.theme !== undefined) {
      this.theme = button.dataset.theme;
      this.filterTracks();
      return;
    }
    const action = button.dataset.menuAction;
    if (
      action === "home" ||
      action === "solo" ||
      action === "practice" ||
      action === "room"
    )
      this.navigate(action);
    else if (action === "tracks") this.openPicker();
    else if (action === "cancel") this.closePicker();
    else if (action === "apply" || action === "start") this.confirm();
    else if (action === "mute") this.setMuted(this.actions.onToggleMute());
    else if (action === "fullscreen") this.actions.onFullscreen();
  };

  private onKeyDown = (event: KeyboardEvent) => {
    if (
      this.root.classList.contains("is-hidden") ||
      event.repeat ||
      event.defaultPrevented
    )
      return;
    if (
      this.picking &&
      event.key === "Enter" &&
      !event.isComposing &&
      event.target instanceof HTMLInputElement &&
      event.target.matches("[data-search]")
    ) {
      event.preventDefault();
      this.confirm();
    } else if (event.key === "F5" && !this.picking && this.page === "room") {
      event.preventDefault();
      this.confirm();
    } else if (
      event.key === "Escape" &&
      !this.picking &&
      this.page !== "home"
    ) {
      event.preventDefault();
      this.navigate(
        this.page === "room"
          ? "practice"
          : this.page === "practice"
            ? "solo"
            : "home",
      );
    }
  };
}
