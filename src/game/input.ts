import type { KartInput } from "../types";

type GameAction = "pause" | "reset" | "mute" | "confirm";

type SteeringDirection = -1 | 0 | 1;

/**
 * Original input arbitration: the most recent left/right press owns steering.
 * Releasing an older direction while the newer one remains held must not
 * cancel the newer direction.
 */
export class SteeringOwnership {
  private owner: SteeringDirection = 0;
  private sequence = 0;
  private readonly held = new Map<
    string,
    { direction: Exclude<SteeringDirection, 0>; sequence: number }
  >();

  get steer(): SteeringDirection {
    return this.owner;
  }

  press(source: string, direction: Exclude<SteeringDirection, 0>): void {
    this.held.set(source, { direction, sequence: ++this.sequence });
    this.owner = direction;
  }

  release(source: string): void {
    if (!this.held.has(source)) return;
    this.held.delete(source);

    let latest: { direction: Exclude<SteeringDirection, 0>; sequence: number } | undefined;
    for (const held of this.held.values()) {
      if (latest === undefined || held.sequence > latest.sequence) {
        latest = held;
      }
    }
    this.owner = latest?.direction ?? 0;
  }

  clear(): void {
    this.held.clear();
    this.owner = 0;
  }
}

const BLOCKED_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Space",
  "ShiftLeft",
  "ShiftRight",
]);

export class InputController {
  private pressed = new Set<string>();
  private steering = new SteeringOwnership();
  private touch = {
    throttle: false,
    brake: false,
    left: false,
    right: false,
    drift: false,
    boost: false,
  };
  private actionHandler: (action: GameAction) => void;
  private touchRoot: HTMLElement | null = null;
  private sampled = this.snapshot();
  private sampledSince = -Infinity;
  private changes: { at: number; keys: KartInput }[] = [];

  constructor(actionHandler: (action: GameAction) => void) {
    this.actionHandler = actionHandler;
    window.addEventListener("keydown", this.onKeyDown, { passive: false });
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.releaseAll);
  }

  bindTouch(root: HTMLElement) {
    this.touchRoot = root;
    for (const element of root.querySelectorAll<HTMLElement>("[data-control]")) {
      element.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        element.setPointerCapture?.(event.pointerId);
        this.setTouch(element.dataset.control ?? "", true);
        element.classList.add("is-down");
      });
      const release = (event: PointerEvent) => {
        event.preventDefault();
        this.setTouch(element.dataset.control ?? "", false);
        element.classList.remove("is-down");
      };
      element.addEventListener("pointerup", release);
      element.addEventListener("pointercancel", release);
      element.addEventListener("lostpointercapture", release);
    }
  }

  snapshot(): KartInput {
    return {
      throttle:
        this.pressed.has("KeyW") ||
        this.pressed.has("ArrowUp") ||
        this.touch.throttle,
      brake:
        this.pressed.has("KeyS") ||
        this.pressed.has("ArrowDown") ||
        this.touch.brake,
      steer: this.steering.steer,
      drift:
        this.pressed.has("ShiftLeft") ||
        this.pressed.has("ShiftRight") ||
        this.touch.drift,
      boost:
        this.pressed.has("ControlLeft") ||
        this.pressed.has("ControlRight") ||
        this.pressed.has("Space") ||
        this.touch.boost,
    };
  }

  // A throttle release and re-press can both arrive between animation frames.
  // Replay the intermediate states in order, giving each at least one physics tick.
  advanceFrame(
    start: number, end: number, tickMs: number,
    advance: (seconds: number, keys: KartInput) => void,
  ) {
    let cursor = start;
    let count = 0;
    for (const change of this.changes) {
      const at = Math.max(cursor, change.at, this.sampledSince + tickMs);
      if (at > end) break;
      if (at > cursor) advance((at - cursor) / 1000, this.sampled);
      this.sampled = change.keys;
      this.sampledSince = at;
      cursor = at;
      count++;
    }
    if (count) this.changes.splice(0, count);
    if (end > cursor) advance((end - cursor) / 1000, this.sampled);
  }

  discardTransitions() {
    if (this.changes.length) this.sampled = this.changes[this.changes.length - 1].keys;
    this.changes.length = 0;
    this.sampledSince = -Infinity;
  }

  private recordChange() {
    const keys = this.snapshot();
    const previous = this.changes.at(-1)?.keys ?? this.sampled;
    if (keys.throttle === previous.throttle && keys.brake === previous.brake &&
        keys.steer === previous.steer && keys.drift === previous.drift && keys.boost === previous.boost) return;
    this.changes.push({ at: performance.now(), keys });
  }

  releaseAll = () => {
    this.pressed.clear();
    this.steering.clear();
    this.touch = {
      throttle: false,
      brake: false,
      left: false,
      right: false,
      drift: false,
      boost: false,
    };
    this.changes.length = 0;
    this.sampled = this.snapshot();
    this.sampledSince = -Infinity;
    this.touchRoot
      ?.querySelectorAll(".is-down")
      .forEach((element) => element.classList.remove("is-down"));
  };

  private onKeyDown = (event: KeyboardEvent) => {
    const target = event.target;
    if (event.defaultPrevented || event.isComposing) return;
    if (target instanceof HTMLElement) {
      if (target.isContentEditable || target.closest("input, textarea, select")) return;
      const activatesControl = event.code === "Enter" || event.code === "Space";
      if (activatesControl && target.closest("button, a[href]")) return;
    }
    if (event.ctrlKey && !event.shiftKey && !event.altKey && event.code === "ControlLeft") {
      event.preventDefault();
    }
    if (BLOCKED_KEYS.has(event.code)) {
      event.preventDefault();
    }
    if (!this.pressed.has(event.code)) {
      this.pressed.add(event.code);
      if (event.code === "KeyA" || event.code === "ArrowLeft") {
        this.steering.press(event.code, -1);
      } else if (event.code === "KeyD" || event.code === "ArrowRight") {
        this.steering.press(event.code, 1);
      }
      this.recordChange();
    }

    if (event.repeat) {
      return;
    }
    if (event.code === "Escape" || event.code === "KeyP") {
      this.actionHandler("pause");
    } else if (event.code === "KeyR") {
      this.actionHandler("reset");
    } else if (event.code === "KeyM") {
      this.actionHandler("mute");
    } else if (event.code === "Enter") {
      this.actionHandler("confirm");
    }
  };

  private onKeyUp = (event: KeyboardEvent) => {
    if (this.pressed.delete(event.code)) {
      this.steering.release(event.code);
      this.recordChange();
    }
  };

  private setTouch(control: string, down: boolean) {
    if (control in this.touch) {
      const key = control as keyof typeof this.touch;
      if (this.touch[key] === down) return;
      if (control === "left") {
        if (down) this.steering.press("touch:left", -1);
        else this.steering.release("touch:left");
      } else if (control === "right") {
        if (down) this.steering.press("touch:right", 1);
        else this.steering.release("touch:right");
      }
      this.touch[key] = down;
      this.recordChange();
    }
  }
}
