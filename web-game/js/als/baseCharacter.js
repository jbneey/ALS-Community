/**
 * ALS-Community port — Base Character.
 *
 * Web adaptation of ALSBaseCharacter.h/.cpp:
 *  - Implements the IALSAnimationProviderInterface consumer side (all montage / pose /
 *    curve calls go through this.animationProvider, never a renderer API directly).
 *  - State machine mirrors SetMovementState / SetMovementAction / SetGait / SetStance /
 *    SetRotationMode / SetViewMode / SetOverlayState / DropDown / HandleRollRequest.
 *  - VelocityDirection / LookingDirection / Aiming rotation logic ported from
 *    UpdateWorldFromMomentum.
 */

import {
  EALSGait, EALSMovementAction, EALSMovementState, EALSOverlayState,
  EALSRotationMode, EALSStance, EALSViewMode, EALSHipsDirection,
} from './enums.js';
import { clamp, findDeltaAngle, rInterpTo, yawOf } from './math.js';
import { ALSCharacterMovementComponent } from './movementComponent.js';
import { ALSMantleComponent } from './mantleComponent.js';
import { ALSGenericTimeline } from './mantleComponent.js';

const WALK_THRESHOLD = 10;
const JOG_STOP_THRESHOLD = 10;
const JOG_START_THRESHOLD = 175;   // walk->jog hysteresis like C++ defaults
const SPRINT_START_THRESHOLD = 250;
const MIN_WALK_SPEED = 175;

export class ALSBaseCharacter {
  /**
   * @param {object} opts { name, location, animationProvider, worldProbe, headless }
   */
  constructor(opts) {
    this.name = opts.name ?? 'ALS_Character';

    // ---- replicated state (mirrors the UPROPERTYs in ALSBaseCharacter.h) ----
    this.movementState = EALSMovementState.Grounded;
    this.movementAction = EALSMovementAction.None;
    this.gait = EALSGait.Running;
    this.rotationMode = EALSRotationMode.VelocityDirection;
    this.desiredRotationMode = EALSRotationMode.VelocityDirection;
    this.stance = EALSStance.Standing;
    this.viewMode = EALSViewMode.ThirdPerson;
    this.overlayState = EALSOverlayState.Default;
    this.bIsGrounded = true;
    this.bIsFlying = false;

    this.location = { ...(opts.location ?? { x: 0, y: 0, z: 0 }) };
    this.actorYaw = 0;            // mesh facing
    this.controlRotationYaw = 0;  // camera yaw
    this.controlPitch = 0;

    // movement data fed to the "anim graph" (renderer reads this, like FALSCharacterMovementData)
    this.movementData = makeMovementData();

    // ---- components ----
    this.animationProvider = opts.animationProvider; // IALSAnimationProviderInterface impl
    this.headless = !!opts.headless;                 // null-guards for dedicated-server mode
    this.movement = new ALSCharacterMovementComponent(this);
    this.mantle = new ALSMantleComponent(this, opts.worldProbe);

    this.rollCooldownUntil = 0;
    this.now = 0;
    this.lastMontageResult = null;
    this.events = []; // HUD event log

    // ragdoll timeline (DropDown -> GettingUp), replaces the UE Timeline + montage combo
    this.getUpTimeline = new ALSGenericTimeline({
      length: 1.4,
      onUpdate: (t) => this.updateGettingUp(t),
      onComplete: () => this.finishGettingUp(),
    });

    // input snapshot pushed by the player controller each frame
    this.inputWorld = { x: 0, y: 0 };
  }

  logEvent(msg) {
    this.events.push(msg);
    if (this.events.length > 6) this.events.shift();
  }

  peekInputWorld() { return this.inputWorld; }

  // ================= state setters (ports of the C++ Set* functions) =================

  setMovementState(state) {
    if (state === this.movementState) return;
    const prev = this.movementState;
    this.movementState = state;

    switch (state) {
      case EALSMovementState.Grounded:
        this.setMovementAction(EALSMovementAction.None);
        break;
      case EALSMovementState.InAir:
        this.setMovementAction(EALSMovementAction.None);
        break;
      case EALSMovementState.Mantling:
        this.movement.zeroMovement();
        break;
      case EALSMovementState.Ragdoll:
        this.setMovementAction(EALSMovementAction.None);
        this.movement.zeroMovement();
        // provider-driven pose capture before physics takes over (ALS_SavePoseSnapshot)
        this.animationProvider?.alsSavePoseSnapshot('RagdollEntry');
        break;
    }
    void prev;
  }

  setMovementAction(action) {
    this.movementAction = action;
    // NotifyStateMovementAction equivalent: rolling disables nav-like collisions handled by renderer
  }

  setGait(gait) {
    if (gait === this.gait) return;
    this.gait = gait;
  }

  /** Auto-gait with hysteresis — port of DetermineGait(). */
  determineGait(wantsSprint, wantsWalk, speed) {
    if (this.stance === EALSStance.Crouching) { this.gait = EALSGait.Walking; return; }
    let next = this.gait;
    switch (this.gait) {
      case EALSGait.Walking:
        if (speed > JOG_START_THRESHOLD && !wantsWalk) next = EALSGait.Running;
        break;
      case EALSGait.Running:
        if (speed > SPRINT_START_THRESHOLD && wantsSprint) next = EALSGait.Sprinting;
        else if (speed < WALK_THRESHOLD || wantsWalk) next = EALSGait.Walking;
        break;
      case EALSGait.Sprinting:
        if (speed < JOG_STOP_THRESHOLD || wantsWalk) next = EALSGait.Walking;
        else if (speed < SPRINT_START_THRESHOLD || !wantsSprint) next = EALSGait.Running;
        break;
    }
    if (wantsSprint && speed >= SPRINT_START_THRESHOLD) next = EALSGait.Sprinting;
    this.setGait(next);
  }

  setStance(stance) {
    if (stance === this.stance) return;
    if (stance === EALSStance.Crouching && this.movement.mode !== 1) return; // only while walking
    this.stance = stance;
    this.logEvent(stance ? 'Stance: Crouching' : 'Stance: Standing');
  }

  setRotationMode(mode) {
    if (mode === this.rotationMode) return;
    this.rotationMode = mode;
    this.onRotationModeChanged(mode);
  }

  setDesiredRotationMode(mode) { this.desiredRotationMode = mode; }

  onRotationModeChanged(mode) {
    // ports of VelocityDirectionAction / LookingDirectionAction / AimingAction
    if (mode === EALSRotationMode.Aiming && this.viewMode === EALSViewMode.FirstPerson) {
      this.setViewMode(EALSViewMode.ThirdPerson); // C++ forces TP when aiming
    }
    this.logEvent(`Rotation: ${['Velocity', 'Looking', 'Aiming'][mode]}`);
  }

  setViewMode(vm) {
    if (vm === this.viewMode) return;
    this.viewMode = vm;
    if (vm === EALSViewMode.FirstPerson && this.rotationMode === EALSRotationMode.Aiming) {
      this.setRotationMode(EALSRotationMode.LookingDirection);
    }
    this.logEvent(`View: ${vm ? 'FirstPerson' : 'ThirdPerson'}`);
  }

  setOverlayState(s) {
    this.overlayState = s;
  }

  // ================= actions =================

  handleRollRequest() {
    if (this.movementState !== EALSMovementState.Grounded) return;
    if (this.movementAction !== EALSMovementAction.None) return;
    if (this.now < this.rollCooldownUntil) return;
    this.rollCooldownUntil = this.now + 1.0;

    this.setMovementAction(EALSMovementAction.Rolling);
    this.movement.zeroMovement();
    const res = this.animationProvider?.alsPlayMontage('Roll', 1.0, -1);
    this.lastMontageResult = res;
    this.logEvent('Roll (montage via provider)');
    this.rollEndAt = this.now + 0.9;
  }

  dropDown() {
    if (this.movementState !== EALSMovementState.Grounded) return;
    if (this.movementAction !== EALSMovementAction.None) return;
    this.setMovementState(EALSMovementState.Ragdoll);
    this.movement.mode = 0; // MOVE_None — ragdoll owns the body
    const vel = this.movement.velocity;
    this.ragdollVel = { ...vel };
    this.ragdollTime = 0;
    this.logEvent('Ragdoll drop (headless-safe: no mesh required)');
  }

  updateRagdoll(dt) {
    this.ragdollTime += dt;
    // simple physical tumble integration (engine-independent stand-in for Chaos)
    this.ragdollVel.z -= this.movement.gravity * dt;
    this.location.x += this.ragdollVel.x * dt;
    this.location.y += this.ragdollVel.y * dt;
    this.location.z += this.ragdollVel.z * dt;
    const gh = this.groundHeightAt(this.location);
    if (this.location.z <= gh) {
      this.location.z = gh;
      this.ragdollVel.x *= 0.85; this.ragdollVel.y *= 0.85; this.ragdollVel.z = 0;
    }
    if (this.ragdollTime > 1.6) this.getUp();
  }

  getUp() {
    this.setMovementAction(EALSMovementAction.GettingUp);
    const res = this.animationProvider?.alsPlayMontage('GetUp', 1.0, -1);
    this.lastMontageResult = res;
    this.getUpTimeline.play(1.0);
    this.logEvent('GettingUp (pose snapshot blend-out)');
  }

  updateGettingUp(t) {
    // rise smoothly back onto feet; keep yaw where ragdoll left it
    this.actorYaw += findDeltaAngle(this.actorYaw, this.controlRotationYaw) * t * 0.1;
    void clamp;
  }

  finishGettingUp() {
    this.setMovementAction(EALSMovementAction.None);
    this.setMovementState(EALSMovementState.Grounded);
    this.movement.mode = 1;
    this.location.z = this.groundHeightAt(this.location);
  }

  tryMantle() {
    return this.mantle.tryMantle(this.inputWorld);
  }

  jump() { this.movement.handleJumpInput(true); }
  endJump() { this.movement.handleJumpInput(false); }

  onJumped() {
    this.setMovementState(EALSMovementState.InAir);
    this.animationProvider?.setCurveValue('AirTime', 0);
    this.logEvent('Jumped');
  }

  onLanded() {
    if (this.movementState === EALSMovementState.Ragdoll) return;
    this.setMovementState(EALSMovementState.Grounded);
    this.logEvent('Landed');
  }

  onFallenOutOfWorld() {
    this.location = { x: 0, y: 0, z: 0 };
    this.movement.mode = 1;
    this.movement.zeroMovement();
    this.setMovementState(EALSMovementState.Grounded);
    this.logEvent('Respawn (fell out of world)');
  }

  // ================= tick =================

  /** Ground height query — provided by the world adapter through mantle.probe. */
  groundHeightAt(pos) {
    return this.mantle.probe.groundHeight(pos);
  }

  tick(dt, input) {
    this.now += dt;
    this.inputWorld = input.moveWorld;

    // roll end notify (AN ends montage & clears action)
    if (this.movementAction === EALSMovementAction.Rolling && this.now >= this.rollEndAt) {
      this.setMovementAction(EALSMovementAction.None);
    }

    if (this.movementState === EALSMovementState.Ragdoll) {
      this.updateRagdoll(dt);
      this.mantle.tick(dt);
      return;
    }

    // NOTE: movementAction is intentionally NOT reset here — Mantling/GettingUp own the
    // action slot; ALSMantleComponent.endMantling() and finishGettingUp() clear it.
    this.mantle.tick(dt); // advance mantle timeline: transforms the body, ends with grounded state

    if (this.movementState === EALSMovementState.Mantling) {
      // physics frozen while mantling; only montage/curves keep ticking
      this.animationProvider?.advance(dt);
      return;
    }

    this.getUpTimeline.tick(dt);

    // physics
    this.movement.tick(input.moveWorld, dt,
      (p) => this.mantle.probe.resolve(p, 40),
      (p) => ({ height: this.mantle.probe.groundHeight(p), walkable: true }));

    if (this.movement.justLanded) this.onLanded();
    if (this.movement.mode === 2 && this.movementState !== EALSMovementState.InAir &&
        this.movementState !== EALSMovementState.Mantling) {
      this.setMovementState(EALSMovementState.InAir);
    }

    // gait determination
    const speed = Math.hypot(this.movement.velocity.x, this.movement.velocity.y);
    if (this.movementState === EALSMovementState.Grounded) {
      this.determineGait(input.wantsSprint, input.wantsWalk, speed);
    }

    // rotation system — port of UpdateWorldFromMomentum
    this.updateFacing(dt, speed, input);

    // animation provider tick (montage advance + curves)
    this.animationProvider?.advance(dt);
    this.updateMovementData(speed, input);
  }

  updateFacing(dt, speed, input) {
    if (this.movementState === EALSMovementState.Mantling) return;

    let targetYaw = this.actorYaw;
    if (this.rotationMode === EALSRotationMode.VelocityDirection) {
      if (speed > 15 && input.moveWorld) {
        targetYaw = yawOf(this.movement.velocity);
      }
    } else { // LookingDirection & Aiming face camera
      targetYaw = this.controlRotationYaw;
    }

    const interp = this.rotationMode === EALSRotationMode.Aiming ? 12 : 8;
    this.actorYaw = wrap(rInterpTo(this.actorYaw, targetYaw, dt, interp));
  }

  updateMovementData(speed, input) {
    const md = this.movementData;
    md.State = this.movementState;
    md.Action = this.movementAction;
    md.Gait = this.gait;
    md.Stance = this.stance;
    md.Overlay = this.overlayState;
    md.RotationMode = this.rotationMode;
    md.ViewMode = this.viewMode;
    md.Speed = speed;
    md.bMoving = speed > 10;
    md.bSprinting = this.gait === EALSGait.Sprinting;
    md.bRolling = this.movementAction === EALSMovementAction.Rolling;
    md.bMantling = this.movementState === EALSMovementState.Mantling;
    md.bInAir = this.movementState === EALSMovementState.InAir;
    md.bFirstPerson = this.viewMode === EALSViewMode.FirstPerson;
    md.bAiming = this.rotationMode === EALSRotationMode.Aiming;
    md.bCrouching = this.stance === EALSStance.Crouching;
    md.JumpAmount = this.movement.mode === 2 ? clamp(-this.movement.velocity.z / 600, 0, 1) : 0;
    md.LandAmount = this.movement.landDuration / 0.25;

    // RightSpeed (-1..1): strafe amount vs facing, drives Left/Right locomotion clips
    if (md.bMoving) {
      const localYaw = findDeltaAngle(this.actorYaw, yawOf(this.movement.velocity));
      md.RightSpeed = Math.sin(localYaw * Math.PI / 180);
      md.ForwardSpeed = Math.cos(localYaw * Math.PI / 180);
    } else { md.RightSpeed = 0; md.ForwardSpeed = 0; }

    // hips direction — port of GetHipsDirection (F/B/RF/RB/LF/LB sectors)
    md.HipsDirection = hipsDirection(findDeltaAngle(this.actorYaw, yawOf(input.moveWorld)), md.bMoving);

    // stride/diagonal blending parameters consumed by the procedural anim layer
    md.StrideBlend = clamp((speed - MIN_WALK_SPEED) / 200, 0, 1);
    md.DiagonalBlend = Math.abs(md.RightSpeed);
    md.MontageProgress = this.animationProvider?.alsGetCurveValue('MantleProgress') ?? 0;
  }
}

function hipsDirection(deltaDeg, moving) {
  if (!moving) return EALSHipsDirection.F;
  const a = deltaDeg;
  if (a > -22.5 && a <= 22.5) return EALSHipsDirection.F;
  if (a > 22.5 && a <= 67.5) return EALSHipsDirection.RF;
  if (a > 67.5 && a <= 112.5) return EALSHipsDirection.RB;
  if (a > 112.5 && a <= 157.5 || a > 157.5) return EALSHipsDirection.B;
  if (a < -22.5 && a >= -67.5) return EALSHipsDirection.LF;
  if (a < -67.5 && a >= -112.5) return EALSHipsDirection.LB;
  return EALSHipsDirection.B;
}

function wrap(yaw) { return ((yaw % 360) + 540) % 360 - 180; }

function makeMovementData() {
  return {
    State: 0, Action: 0, Gait: 1, Stance: 0, Overlay: 0, RotationMode: 0, ViewMode: 0,
    Speed: 0, bMoving: false, bSprinting: false, bRolling: false, bMantling: false,
    bInAir: false, bFirstPerson: false, bAiming: false, bCrouching: false,
    JumpAmount: 0, LandAmount: 0, RightSpeed: 0, ForwardSpeed: 0,
    HipsDirection: 0, StrideBlend: 0, DiagonalBlend: 0, MontageProgress: 0,
  };
}
