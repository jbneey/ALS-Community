/**
 * ALS-Community port — Character Movement Component.
 *
 * Web-engine adaptation of ALSCharacterMovementComponent.h / .cpp:
 * UE's SetMovementMode(MOVE_Walking/Falling/Swimming/None) is replaced by a
 * generic movement-mode enum, gravity/friction/braking follow the same formulas
 * as ACharacterMovementSettings in the C++ source.
 */

export const EALSMovementMode = Object.freeze({
  None: 0,      // MOVE_None — frozen (mantling, ragdoll cinematic, etc.)
  Walking: 1,   // MOVE_Walking
  Falling: 2,   // MOVE_Falling
});

const WALK_FRICTION = 8.0;
const AIR_CONTROL = 0.35;

export class ALSCharacterMovementComponent {
  constructor(character) {
    this.character = character;

    // Defaults taken from ACharacterMovementSettings (ALSBaseCharacter.h)
    this.walkSpeed = 175;
    this.runSpeed = 250;
    this.sprintSpeed = 375;
    this.crouchWalkSpeed = 150;
    this.sprintingTurnBoost = 1.067;

    this.maxWalkSpeed = this.runSpeed;
    this.brakingDecelerationWalking = 800;
    this.brakingDecelerationFalling = 0;
    this.groundFriction = WALK_FRICTION;
    this.airControl = AIR_CONTROL;

    this.gravity = 2400;          // ~ UE default 2400 cm/s^2 (world units = cm)
    this.jumpZVelocity = 620;     // JumpMaxHeight=125 -> sqrt(2*h*g)
    this.jumpHoldTime = 0.35;
    this.jumpInputTime = -1;

    this.mode = EALSMovementMode.Walking;
    this.velocity = { x: 0, y: 0, z: 0 };
    this.justLanded = false;
    this.landDuration = 0;        // for landing animation falloff
    this.stepOffsetHeight = 45;   // auto step-up like CharacterMovement bAutoStepUp
  }

  /** Mirror of SetMaxWalkSpeed() switch on stance/gait in ALSBaseCharacter.cpp. */
  applySpeedForState(stance, gait, rotationMode) {
    if (stance === 1 /* Crouching */) {
      this.maxWalkSpeed = this.crouchWalkSpeed;
    } else {
      this.maxWalkSpeed = [this.walkSpeed, this.runSpeed, this.sprintSpeed][gait];
      if (gait === 2 /* Sprinting */ && rotationMode !== 2 /* Aiming */) {
        this.maxWalkSpeed *= this.sprintingTurnBoost;
      }
    }
  }

  handleJumpInput(pressed) {
    const c = this.character;
    if (pressed) {
      this.jumpInputTime = 0;
      // ledge grab: a mantle request may have already switched the state to Mantling — don't override it
      if (this.mode === EALSMovementMode.Walking &&
          c.movementState !== 3 /* Mantling */ &&
          c.movementAction === 0 /* None */) {
        this.velocity.z = this.jumpZVelocity;
        this.mode = EALSMovementMode.Falling;
        // set InAir immediately so later SetMovementState(Grounded) landings are real transitions
        c.setMovementState(2 /* InAir */);
        c.onJumped?.();
      }
    } else if (this.velocity.z > this.jumpZVelocity * 0.35) {
      // variable jump height: cut velocity on early release
      this.velocity.z = this.jumpZVelocity * 0.35;
    }
  }

  /**
   * Physics tick. `input` is world-space desired acceleration direction (normalized XZ),
   * `dt` seconds. `collide(pos)->pos` resolves horizontal collisions,
   * `groundAt(pos)->{height, walkable}` samples the floor.
   */
  tick(input, dt, collide, groundAt) {
    this.justLanded = false;
    if (this.landDuration > 0) this.landDuration = Math.max(0, this.landDuration - dt);

    if (this.character.movementAction !== 0 || this.character.movementState === 3 /* Mantling */ ||
        this.character.movementState === 4 /* Ragdoll */) {
      return; // actions own the transform via timeline
    }

    const c = this.character;
    this.applySpeedForState(c.stance, c.gait, c.rotationMode);

    if (this.mode === EALSMovementMode.None) return;

    if (this.mode === EALSMovementMode.Walking) {
      const ground = groundAt(c.location);
      let targetSpeed = 0;
      let moveDir = { x: 0, y: 0 };

      if (input.x !== 0 || input.y !== 0) {
        moveDir = input;
        targetSpeed = this.maxWalkSpeed;
      }

      // Acceleration toward desired velocity + friction when no input (UE walking model)
      const accel = targetSpeed > 0 ? 3200 : 0;
      const curHoriz = { x: this.velocity.x, y: this.velocity.y };
      const desired = { x: moveDir.x * targetSpeed, y: moveDir.y * targetSpeed };

      if (targetSpeed > 0) {
        const k = Math.min(1, (accel * dt) / Math.max(1, magnitude2(desired, curHoriz)));
        this.velocity.x += (desired.x - curHoriz.x) * Math.min(1, accel * dt / 100);
        this.velocity.y += (desired.y - curHoriz.y) * Math.min(1, accel * dt / 100);
        void k;
      } else {
        const speed = Math.hypot(this.velocity.x, this.velocity.y);
        if (speed > 0) {
          const drop = speed * this.groundFriction * dt;
          const ns = Math.max(0, speed - drop - this.brakingDecelerationWalking * dt);
          this.velocity.x *= ns / speed;
          this.velocity.y *= ns / speed;
        }
      }

      // clamp to max
      const hs = Math.hypot(this.velocity.x, this.velocity.y);
      if (hs > this.maxWalkSpeed) {
        this.velocity.x *= this.maxWalkSpeed / hs;
        this.velocity.y *= this.maxWalkSpeed / hs;
      }

      // integrate horizontally with collision + auto step-up
      const next = {
        x: c.location.x + this.velocity.x * dt,
        y: c.location.y + this.velocity.y * dt,
        z: c.location.z,
      };
      const resolved = collide(next);
      c.location.x = resolved.x;
      c.location.y = resolved.y;

      // snap to ground / step up ledges within step offset, fall off edges
      const g2 = groundAt(c.location);
      const rise = g2.height - c.location.z;
      if (rise > 0 && rise <= this.stepOffsetHeight && g2.walkable) {
        c.location.z = g2.height;
      } else if (Math.abs(g2.height - c.location.z) < 90 && this.velocity.z <= 0) {
        c.location.z = g2.height;
        this.velocity.z = 0;
      } else {
        this.mode = EALSMovementMode.Falling; // walked off a ledge
      }
      c.bIsGrounded = this.mode === EALSMovementMode.Walking;
    }

    if (this.mode === EALSMovementMode.Falling) {
      // air control (UE-style): limited acceleration toward input
      if (input.x !== 0 || input.y !== 0) {
        const desired = { x: input.x * this.maxWalkSpeed, y: input.y * this.maxWalkSpeed };
        this.velocity.x += clampDelta(desired.x - this.velocity.x, this.maxWalkSpeed * this.airControl * dt * 4);
        this.velocity.y += clampDelta(desired.y - this.velocity.y, this.maxWalkSpeed * this.airControl * dt * 4);
      }
      this.velocity.z -= this.gravity * dt;

      const next = {
        x: c.location.x + this.velocity.x * dt,
        y: c.location.y + this.velocity.y * dt,
        z: c.location.z + this.velocity.z * dt,
      };
      const resolved = collide(next);
      c.location.x = resolved.x;
      c.location.y = resolved.y;

      const g2 = groundAt({ x: c.location.x, y: c.location.y, z: c.location.z });
      if (this.velocity.z <= 0 && c.location.z <= g2.height + 0.001) {
        c.location.z = g2.height;
        this.velocity.z = 0;
        this.mode = EALSMovementMode.Walking;
        this.justLanded = true;
        this.landDuration = 0.25;
        c.onLanded?.();
      }
      c.bIsGrounded = false;
      // safety net: fell out of the world -> ask the game to respawn us
      if (c.location.z < -500 && c.onFallenOutOfWorld) c.onFallenOutOfWorld();
    }
  }

  /** Freeze velocity (used when entering Mantling/Ragdoll, mirrors ZeroMovement). */
  zeroMovement() {
    this.velocity.x = 0; this.velocity.y = 0; this.velocity.z = 0;
  }
}

function magnitude2(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clampDelta(v, m) {
  return v > m ? m : v < -m ? -m : v;
}
