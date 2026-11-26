import type { KartInput } from "../types";

type GameAction = "pause" | "reset" | "mute" | "confirm";

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
    const left = this.pressed.has("KeyA") || this.pressed.has("ArrowLeft") || this.touch.left;
    const right = this.pressed.has("KeyD") || this.pressed.has("ArrowRight") || this.touch.right;
    return {
      throttle:
        this.pressed.has("KeyW") ||
        this.pressed.has("ArrowUp") ||
        this.touch.throttle,
      brake:
        this.pressed.has("KeyS") ||
        this.pressed.has("ArrowDown") ||
        this.touch.brake,
      steer: (right ? 1 : 0) - (left ? 1 : 0),
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

  releaseAll = () => {
    this.pressed.clear();
    this.touch = {
      throttle: false,
      brake: false,
      left: false,
      right: false,
      drift: false,
      boost: false,
    };
    this.touchRoot
      ?.querySelectorAll(".is-down")
      .forEach((element) => element.classList.remove("is-down"));
  };

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey && !event.shiftKey && !event.altKey && event.code === "ControlLeft") {
      event.preventDefault();
    }
    if (BLOCKED_KEYS.has(event.code)) {
      event.preventDefault();
    }
    this.pressed.add(event.code);

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
    this.pressed.delete(event.code);
  };

  private setTouch(control: string, down: boolean) {
    if (control in this.touch) {
      this.touch[control as keyof typeof this.touch] = down;
    }
  }
}
