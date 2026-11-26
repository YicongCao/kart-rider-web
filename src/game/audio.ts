type SoundName = "click" | "start" | "countdown" | "booster" | "boostDrift" | "collide" | "finish";

const AUDIO_BASE = "/assets/audio";

export class AudioManager {
  private master = 1;
  private muted = false;
  private unlocked = false;
  private menuMusic = this.createLoop(`${AUDIO_BASE}/menu.ogg`, 0);
  private raceMusic = this.createLoop("", 0);
  private engine = this.createLoop(`${AUDIO_BASE}/engine.ogg`, 0);
  private drift = this.createLoop(`${AUDIO_BASE}/drift.ogg`, 0);
  private sounds = new Map<SoundName, string>([
    ["click", `${AUDIO_BASE}/click.ogg`],
    ["start", `${AUDIO_BASE}/start.ogg`],
    ["countdown", `${AUDIO_BASE}/countdown.ogg`],
    ["booster", `${AUDIO_BASE}/booster.ogg`],
    ["boostDrift", `${AUDIO_BASE}/boosterDrift.ogg`],
    ["collide", `${AUDIO_BASE}/collide.ogg`],
    ["finish", `${AUDIO_BASE}/start.ogg`],
  ]);
  private target = {
    menu: 0,
    race: 0,
    engine: 0,
    drift: 0,
  };
  private driftWasAudible = false;

  constructor() {
    this.engine.preservesPitch = false;
    this.engine.volume = 0;
    this.drift.preservesPitch = false;
    this.drift.volume = 0;
    this.menuMusic.volume = 0;
    this.raceMusic.volume = 0;
  }

  async unlock() {
    if (this.unlocked) {
      return;
    }
    this.unlocked = true;
    await this.safePlay(this.menuMusic);
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    for (const audio of [this.menuMusic, this.raceMusic, this.engine, this.drift]) {
      audio.muted = muted;
    }
    return this.muted;
  }

  toggleMute() {
    return this.setMuted(!this.muted);
  }

  isMuted() {
    return this.muted;
  }

  playMenu() {
    this.target.menu = 0.34;
    this.target.race = 0;
    this.target.engine = 0;
    this.target.drift = 0;
    void this.safePlay(this.menuMusic);
  }

  playRace(musicUrl: string) {
    this.target.menu = 0;
    this.target.race = 0.26;
    this.menuMusic.pause();
    this.menuMusic.currentTime = 0;
    if (this.raceMusic.dataset.source !== musicUrl) {
      this.raceMusic.pause();
      this.raceMusic.src = `/assets/${musicUrl}`;
      this.raceMusic.dataset.source = musicUrl;
      this.raceMusic.currentTime = 0;
    }
    void this.safePlay(this.raceMusic);
  }

  stopRace() {
    this.target.race = 0;
    this.target.engine = 0;
    this.target.drift = 0;
    this.raceMusic.pause();
    this.engine.pause();
    this.drift.pause();
  }

  update(delta: number, speed: number, throttle: boolean, drifting: boolean, boosting: boolean) {
    const safeDelta = Math.min(delta, 0.1);
    this.target.engine =
      speed > 1 || throttle ? Math.min(0.2, 0.07 + Math.abs(speed) * 0.0015) : 0;
    this.target.drift = drifting && speed > 14 ? 0.16 : 0;

    this.engine.playbackRate = Math.max(0.52, Math.min(1.75, 0.62 + Math.abs(speed) * 0.0042));
    this.drift.playbackRate = Math.max(0.82, Math.min(1.35, 0.86 + Math.abs(speed) * 0.0018));

    this.menuMusic.volume = this.lerpVolume(this.menuMusic.volume, this.target.menu, safeDelta, 2.2);
    this.raceMusic.volume = this.lerpVolume(this.raceMusic.volume, this.target.race, safeDelta, 1.7);
    this.engine.volume = this.lerpVolume(
      this.engine.volume,
      this.target.engine * (boosting ? 1.28 : 1),
      safeDelta,
      5,
    );
    this.drift.volume = this.lerpVolume(this.drift.volume, this.target.drift, safeDelta, 7);

    if (this.target.engine > 0 && this.unlocked) {
      void this.safePlay(this.engine);
    }
    if (this.target.drift > 0 && this.unlocked) {
      void this.safePlay(this.drift);
    } else if (this.target.drift === 0 && this.drift.volume < 0.004) {
      this.drift.pause();
    }

    const audible = this.target.drift > 0;
    if (audible !== this.driftWasAudible) {
      this.driftWasAudible = audible;
    }
  }

  sfx(name: SoundName) {
    const source = this.sounds.get(name);
    if (!source || !this.unlocked) {
      return;
    }
    const audio = new Audio(source);
    audio.volume = this.muted ? 0 : 0.58;
    audio.playbackRate = name === "finish" ? 0.9 : 1;
    void this.safePlay(audio);
  }

  private createLoop(source: string, volume: number) {
    const audio = source ? new Audio(source) : new Audio();
    audio.loop = true;
    audio.preload = "auto";
    audio.volume = volume;
    return audio;
  }

  private lerpVolume(current: number, target: number, delta: number, speed: number) {
    const wanted = this.muted ? 0 : target * this.master;
    return current + (wanted - current) * Math.min(1, delta * speed);
  }

  private async safePlay(audio: HTMLAudioElement) {
    try {
      await audio.play();
    } catch {
      // Browsers may still refuse playback until the next direct gesture.
    }
  }
}
