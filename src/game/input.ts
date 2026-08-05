import type { ControlBindings } from './profile';
import type { ControlState } from './vehicle';
import { neutralControls } from './vehicle';
import { clamp, clamp01, deadzone } from '../core/mathx';

/**
 * Turns keyboard, gamepad, and touch into a single {@link ControlState}.
 *
 * Digital inputs are ramped rather than switched. A key is either down or up,
 * but a craft steered by an instantaneously-full-lock input feels like it is on
 * ice; ramping the axis over a few tens of milliseconds gives a keyboard player
 * something close to the proportional control a stick provides, without making
 * the stick feel mushy (analogue sources bypass the ramp entirely).
 */

/** Seconds for a digital steering input to reach full lock. */
const STEER_ATTACK = 0.16;
/** Seconds for steering to return to centre once released. */
const STEER_RELEASE = 0.09;
/** Seconds for a digital throttle to reach full. */
const THROTTLE_ATTACK = 0.1;

export type InputSource = 'keyboard' | 'gamepad' | 'touch';

export interface TouchControlState {
  steer: number;
  throttle: number;
  brake: number;
  airbrakeLeft: number;
  airbrakeRight: number;
  boost: boolean;
  useItem: boolean;
}

/** Standard-gamepad button indices, named so the mapping is readable. */
const PAD = {
  cross: 0,
  circle: 1,
  square: 2,
  triangle: 3,
  l1: 4,
  r1: 5,
  l2: 6,
  r2: 7,
  select: 8,
  start: 9,
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15,
} as const;

export class InputManager {
  private readonly pressed = new Set<string>();
  private readonly justPressed = new Set<string>();
  private bindings: ControlBindings;
  private deadzoneAmount = 0.15;
  private invertPitch = false;

  private readonly state = neutralControls();
  private steerAxis = 0;
  private throttleAxis = 0;
  private brakeAxis = 0;

  /** Whichever source most recently produced input, for on-screen prompts. */
  lastSource: InputSource = 'keyboard';
  gamepadConnected = false;
  /** Set by the touch layer when the player is using on-screen controls. */
  touch: TouchControlState | null = null;

  private readonly onKeyDown = (e: KeyboardEvent) => {
    // Never swallow the browser's own shortcuts or the tab order.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!this.pressed.has(e.code)) this.justPressed.add(e.code);
    this.pressed.add(e.code);
    this.lastSource = 'keyboard';
    if (this.shouldPreventDefault(e.code)) e.preventDefault();
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.pressed.delete(e.code);
  };

  private readonly onBlur = () => {
    // Losing focus mid-corner must not leave a key stuck down.
    this.pressed.clear();
  };

  private readonly onGamepadConnected = () => {
    this.gamepadConnected = true;
  };
  private readonly onGamepadDisconnected = () => {
    this.gamepadConnected = navigator.getGamepads?.().some(Boolean) ?? false;
  };

  constructor(bindings: ControlBindings) {
    this.bindings = bindings;
  }

  attach(target: Window = window): void {
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.onBlur);
    target.addEventListener('gamepadconnected', this.onGamepadConnected);
    target.addEventListener('gamepaddisconnected', this.onGamepadDisconnected);
  }

  detach(target: Window = window): void {
    target.removeEventListener('keydown', this.onKeyDown);
    target.removeEventListener('keyup', this.onKeyUp);
    target.removeEventListener('blur', this.onBlur);
    target.removeEventListener('gamepadconnected', this.onGamepadConnected);
    target.removeEventListener('gamepaddisconnected', this.onGamepadDisconnected);
    this.pressed.clear();
  }

  configure(options: { bindings?: ControlBindings; deadzone?: number; invertPitch?: boolean }): void {
    if (options.bindings) this.bindings = options.bindings;
    if (options.deadzone !== undefined) this.deadzoneAmount = options.deadzone;
    if (options.invertPitch !== undefined) this.invertPitch = options.invertPitch;
  }

  private shouldPreventDefault(code: string): boolean {
    // Arrows and space scroll the page; everything else can pass through.
    return (
      code === 'Space' ||
      code === 'ArrowUp' ||
      code === 'ArrowDown' ||
      code === 'ArrowLeft' ||
      code === 'ArrowRight'
    );
  }

  private isDown(action: string): boolean {
    const keys = this.bindings[action];
    if (!keys) return false;
    for (const k of keys) if (this.pressed.has(k)) return true;
    return false;
  }

  /** True only on the frame the action was first pressed. */
  consumePress(action: string): boolean {
    const keys = this.bindings[action];
    if (!keys) return false;
    for (const k of keys) {
      if (this.justPressed.has(k)) {
        this.justPressed.delete(k);
        return true;
      }
    }
    return false;
  }

  private pad(): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  /** Builds this frame's control state. Call once per frame before stepping. */
  sample(dt: number): ControlState {
    const s = this.state;
    const pad = this.pad();
    this.gamepadConnected = pad !== null;

    // --- Digital sources ---------------------------------------------------
    let steerTarget = (this.isDown('steerRight') ? 1 : 0) - (this.isDown('steerLeft') ? 1 : 0);
    let throttleTarget = this.isDown('throttle') ? 1 : 0;
    let brakeTarget = this.isDown('brake') ? 1 : 0;
    let airbrakeLeft = this.isDown('airbrakeLeft') ? 1 : 0;
    let airbrakeRight = this.isDown('airbrakeRight') ? 1 : 0;
    let boost = this.isDown('boost');
    let useItem = this.isDown('useItem');
    let pitch = (this.isDown('pitchUp') ? 1 : 0) - (this.isDown('pitchDown') ? 1 : 0);
    let analogue = false;

    // --- Gamepad -----------------------------------------------------------
    if (pad) {
      const axisSteer = deadzone(pad.axes[0] ?? 0, this.deadzoneAmount);
      const axisPitch = deadzone(pad.axes[1] ?? 0, this.deadzoneAmount);
      const r2 = pad.buttons[PAD.r2]?.value ?? 0;
      const l2 = pad.buttons[PAD.l2]?.value ?? 0;

      if (Math.abs(axisSteer) > 0 || r2 > 0.02 || l2 > 0.02) {
        this.lastSource = 'gamepad';
        analogue = true;
      }
      if (Math.abs(axisSteer) > Math.abs(steerTarget)) steerTarget = axisSteer;
      throttleTarget = Math.max(throttleTarget, r2);
      brakeTarget = Math.max(brakeTarget, l2);
      airbrakeLeft = Math.max(airbrakeLeft, pad.buttons[PAD.l1]?.value ?? 0);
      airbrakeRight = Math.max(airbrakeRight, pad.buttons[PAD.r1]?.value ?? 0);
      boost = boost || (pad.buttons[PAD.cross]?.pressed ?? false);
      useItem = useItem || (pad.buttons[PAD.square]?.pressed ?? false);
      if (Math.abs(axisPitch) > Math.abs(pitch)) pitch = -axisPitch;
      // D-pad doubles as digital steering.
      if (pad.buttons[PAD.dpadLeft]?.pressed) steerTarget = -1;
      if (pad.buttons[PAD.dpadRight]?.pressed) steerTarget = 1;
    }

    // --- Touch -------------------------------------------------------------
    if (this.touch) {
      const t = this.touch;
      if (t.steer !== 0 || t.throttle !== 0) {
        this.lastSource = 'touch';
        analogue = true;
      }
      if (Math.abs(t.steer) > Math.abs(steerTarget)) steerTarget = t.steer;
      throttleTarget = Math.max(throttleTarget, t.throttle);
      brakeTarget = Math.max(brakeTarget, t.brake);
      airbrakeLeft = Math.max(airbrakeLeft, t.airbrakeLeft);
      airbrakeRight = Math.max(airbrakeRight, t.airbrakeRight);
      boost = boost || t.boost;
      useItem = useItem || t.useItem;
    }

    // --- Ramping -----------------------------------------------------------
    // Analogue sources are already proportional; ramping them would only add
    // latency, so the smoothing is reserved for on/off inputs.
    if (analogue) {
      this.steerAxis = steerTarget;
      this.throttleAxis = throttleTarget;
      this.brakeAxis = brakeTarget;
    } else {
      // Returning to centre is quicker than reaching lock, which is what makes
      // a keyboard car feel like it has self-centring rather than momentum.
      const returning = Math.abs(steerTarget) < Math.abs(this.steerAxis) || steerTarget === 0;
      this.steerAxis = approach(this.steerAxis, steerTarget, returning ? STEER_RELEASE : STEER_ATTACK, dt);
      this.throttleAxis = approach(this.throttleAxis, throttleTarget, THROTTLE_ATTACK, dt);
      this.brakeAxis = approach(this.brakeAxis, brakeTarget, THROTTLE_ATTACK, dt);
    }

    s.steer = clamp(this.steerAxis, -1, 1);
    s.throttle = clamp01(this.throttleAxis);
    s.brake = clamp01(this.brakeAxis);
    s.airbrakeLeft = clamp01(airbrakeLeft);
    s.airbrakeRight = clamp01(airbrakeRight);
    s.boost = boost;
    s.useItem = useItem;
    s.pitch = clamp(this.invertPitch ? -pitch : pitch, -1, 1);
    return s;
  }

  /** Clears one-shot press state. Call at the very end of the frame. */
  endFrame(): void {
    this.justPressed.clear();
  }

  /** Menu-facing edge detection, so the UI can be driven by the pad too. */
  padPressed(button: keyof typeof PAD): boolean {
    const pad = this.pad();
    if (!pad) return false;
    return pad.buttons[PAD[button]]?.pressed ?? false;
  }

  isLookingBack(): boolean {
    return this.isDown('lookBack') || this.padPressed('circle');
  }

  /** Raw key state, for the rebinding capture flow. */
  rawPressed(): ReadonlySet<string> {
    return this.pressed;
  }
}

/** Framerate-independent approach with a time constant in seconds. */
function approach(current: number, target: number, tau: number, dt: number): number {
  if (tau <= 0) return target;
  const t = 1 - Math.exp(-dt / tau);
  return current + (target - current) * t;
}
