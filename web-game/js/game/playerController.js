/**
 * ALS-Community port — Player Controller (input mapping).
 *
 * Web adaptation of ALSPlayerController.cpp: instead of UE input components we use
 * keyboard/mouse handlers, but the *actions* are identical to the C++ bindings:
 *   MoveForward/MoveRight, Jump (IA_Jump), Mantle (Hold_TryMantle), Roll (DoubleTap_P),
 *   DropDown, Stance toggle, Sprint/Walk modifiers, rotation mode cycle, aim, view toggle.
 */

import { EALSRotationMode, EALSViewMode, EALSOverlayState } from '../als/enums.js';
import { DEG } from '../als/math.js';

export class ALSPlayerController {
  constructor(character, camera) {
    this.character = character;
    this.camera = camera;
    this.keys = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wantsSprint = false;
    this.wantsWalk = false;
    this.bMouseDown = false;
    this.pointerLocked = false;

    // double-tap roll detection (DoubleTap input action in ALS)
    this.lastRollTap = -10;

    this.bind(window);
  }

  bind(target) {
    target.addEventListener('keydown', (e) => this.onKey(e, true));
    target.addEventListener('keyup', (e) => this.onKey(e, false));
    target.addEventListener('mousedown', (e) => {
      if (!this.pointerLocked) return;
      if (e.button === 0) { this.bMouseDown = true; this.updateAiming(); }
    });
    target.addEventListener('mouseup', (e) => {
      if (e.button === 0) { this.bMouseDown = false; this.updateAiming(); }
    });
    target.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      const sens = 0.12;
      this.character.controlRotationYaw = wrap(this.character.controlRotationYaw + e.movementX * sens);
      this.character.controlPitch = clamp(this.character.controlPitch - e.movementY * sens, -75, 75);
    });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === target.document?.body ||
                            !!document.pointerLockElement;
      document.getElementById('overlay-start')?.classList.toggle('hidden', this.pointerLocked);
    });
  }

  onKey(e, down) {
    const code = e.code;
    if (down && !e.repeat) {
      switch (code) {
        case 'Space':
          this.character.jump();
          // double-tap space == roll request (ALS DoubleTap pattern)
          if (this.now() - this.lastRollTap < 0.28) this.character.handleRollRequest();
          this.lastRollTap = this.now();
          break;
        case 'KeyQ': this.character.tryMantle(); break;
        case 'KeyE': this.character.dropDown(); break;
        case 'KeyP': this.character.handleRollRequest(); break;
        case 'ShiftLeft': case 'ShiftRight': this.wantsSprint = true; break;
        case 'ControlLeft': case 'ControlRight':
          this.character.setStance(this.character.stance ? 0 : 1); break;
        case 'Tab':
          e.preventDefault();
          cycleRotation(this.character); break;
        case 'KeyV':
          this.character.setViewMode(
            this.character.viewMode === EALSViewMode.ThirdPerson
              ? EALSViewMode.FirstPerson : EALSViewMode.ThirdPerson);
          break;
        case 'KeyB': // overlay state demo cycling (Default -> Rifle -> Box ...)
          this.character.setOverlayState((this.character.overlayState + 1) % 3); break;
        case 'KeyH': this.headlessToggle?.(); break;
      }
      this.keys.add(code);
    } else if (!down) {
      switch (code) {
        case 'Space': this.character.endJump(); break;
        case 'ShiftLeft': case 'ShiftRight': this.wantsSprint = false; break;
      }
      this.keys.delete(code);
    }
  }

  updateAiming() {
    const c = this.character;
    if (this.bMouseDown) {
      if (c.rotationMode !== EALSRotationMode.Aiming) {
        c.prevRotationMode = c.rotationMode;
        c.setRotationMode(EALSRotationMode.Aiming);
      }
    } else if (c.rotationMode === EALSRotationMode.Aiming) {
      c.setRotationMode(c.prevRotationMode ?? EALSRotationMode.VelocityDirection);
    }
  }

  /** Build the input struct consumed by ALSBaseCharacter.tick (like IA_Move inputs). */
  composeInput() {
    let x = 0, y = 0;
    if (this.keys.has('KeyW')) x += 1;
    if (this.keys.has('KeyS')) x -= 1;
    if (this.keys.has('KeyD')) y += 1;
    if (this.keys.has('KeyA')) y -= 1;

    const camYaw = this.character.controlRotationYaw * DEG;
    // WASD relative to camera yaw (UE input vector rotated by control rotation)
    const wx = x * Math.cos(camYaw) - y * Math.sin(camYaw);
    const wy = x * Math.sin(camYaw) + y * Math.cos(camYaw);
    const len = Math.hypot(wx, wy);

    this.wantsWalk = this.keys.has('AltLeft') || this.keys.has('AltRight');

    return {
      moveWorld: len > 0.01 ? { x: wx / len, y: wy / len } : { x: 0, y: 0 },
      wantsSprint: this.wantsSprint,
      wantsWalk: this.wantsWalk,
    };
  }

  now() { return performance.now() / 1000; }
}

function cycleRotation(c) {
  const order = [EALSRotationMode.VelocityDirection, EALSRotationMode.LookingDirection];
  const i = order.indexOf(c.rotationMode);
  c.setRotationMode(order[(i + 1) % order.length]);
}

function wrap(yaw) { return ((yaw % 360) + 540) % 360 - 180; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
