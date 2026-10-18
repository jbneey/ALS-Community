/**
 * ALS-Community port — Mantle Component.
 *
 * Web adaptation of ALSMantleComponent.cpp:
 *  - UTimelineComponent            -> ALSGenericTimeline (data-driven tracks)
 *  - AALSBaseCharacter::TraceInputLocation raycasts -> engine-supplied probe callbacks
 *  - FALSMantleAsset               -> plain object incl. the new bUseLightweightMantle
 *    flag added for constrained/browser runtimes (skips heavy root motion, plays the
 *    mantle faster with a lighter pose budget).
 */

import { EALSMovementAction, EALSMovementState, EALSAnimationPlayResult } from './enums.js';
import { clamp, findDeltaAngle, rInterpTo, yawOf } from './math.js';

/** Minimal reimplementation of the ALS Generic Timeline (CurveTable rows become JS funcs). */
export class ALSGenericTimeline {
  constructor({ length, onUpdate, onComplete }) {
    this.length = length;
    this.onUpdate = onUpdate;
    this.onComplete = onComplete;
    this.time = 0;
    this.playRate = 1;
    this.playing = false;
  }
  play(playRate = 1) {
    this.time = 0;
    this.playRate = Math.max(0.1, playRate);
    this.playing = true;
  }
  stop() { this.playing = false; }
  tick(dt) {
    if (!this.playing) return;
    this.time += dt * this.playRate;
    const t = clamp(this.time / this.length, 0, 1);
    this.onUpdate(t);
    if (t >= 1) {
      this.playing = false;
      this.onComplete?.();
    }
  }
}

/** Smoothstep helper used by all mantle tracks (mirrors the ease curves in the C++ timelines). */
const ease = (t) => t * t * (3 - 2 * t);

export class ALSMantleComponent {
  /**
   * @param {ALSBaseCharacter} character
   * @param {object} worldProbe  engine adapter:
   *   probe.sphereTrace(from, dir, dist, radius) -> { hit, point, normal, distance } | null
   *   probe.overlapLedge(point, extents)         -> { ledgeHeight, surfacePoint } | null
   */
  constructor(character, worldProbe) {
    this.character = character;
    this.probe = worldProbe;

    // MantleHelper settings (defaults from ALSMantleComponent.h)
    this.castRadius = 50;
    this.stepOffset = 60;
    this.wallTraceLength = 75;
    this.edgeTraceLength = 90;
    this.searchAngle = 50;
    this.highTraceStart = 100;
    this.highTraceEnd = 230;
    this.lowTraceStart = 40;
    this.lowTraceEnd = 130;
    this.minLedgeAngle = 50;
    this.forbiddenLedgeAngle = 80;
    this.bMaintainMantleMovement = true;
    this.bIKFootLocking = true;
    this.blockHighMantleWhenMovingAway = true;

    // FALSMantleAsset defaults (with the lightweight profile from the web-decoupling commit)
    this.mantleAssets = {
      LowMantle: {
        montage: 'Mantle',
        playRate: 1.0,
        startPoint: [0.0, 0.25, 0.5],
        endPoint: [0.0, 0.55, 0.75],
        timelineLength: 1.2,
        bUseLightweightMantle: false,
        LightweightTimelinePlayRate: 1.0,
      },
      HighMantle: {
        montage: 'Mantle2m',
        playRate: 1.0,
        startPoint: [0.0, 0.30, 0.6],
        endPoint: [0.0, 0.60, 0.8],
        timelineLength: 1.7,
        bUseLightweightMantle: false,
        LightweightTimelinePlayRate: 1.0,
      },
    };

    this.timeline = new ALSGenericTimeline({
      length: 1,
      onUpdate: (t) => this.updateTimeline(t),
      onComplete: () => this.endMantling(),
    });

    // runtime state
    this.active = false;
    this.asset = null;
    this.startLoc = { x: 0, y: 0, z: 0 };
    this.targetLoc = { x: 0, y: 0, z: 0 };
    this.startYaw = 0;
    this.targetYaw = 0;
    this.inputVectorAtRequest = { x: 0, y: 0 };
    this.lastMoveDelta = { x: 0, y: 0 };
    this.debugInfo = null; // last trace result for HUD
  }

  /** Mantle AS — port of the CanMant checks + TraceForLedge + PlayMantle. */
  tryMantle(inputWorld) {
    const c = this.character;
    if (c.movementState !== EALSMovementState.Grounded) return false;
    if (c.movementAction !== EALSMovementAction.None) return false;
    if (c.stance === 1 /* Crouching */) return false;

    const inputMag = Math.hypot(inputWorld.x, inputWorld.y);
    const hasInput = inputMag > 0.1;
    const moveDir = hasInput ? { x: inputWorld.x / inputMag, y: inputWorld.y / inputMag } : facingDir(c.controlRotationYaw);

    // sphere trace forward at pelvis height
    const eyeZ = c.location.z + 140;
    const from = { x: c.location.x, y: c.location.y, z: eyeZ };
    const wall = this.probe.sphereTrace(from, moveDir, this.wallTraceLength + this.castRadius, this.castRadius);
    if (!wall || !wall.hit) return false;

    const wallNormal = wall.normal;
    const dot = Math.abs(wallNormal.x * moveDir.x + wallNormal.y * moveDir.y);
    const wallAngleFromVertical = Math.acos(clamp(dot, 0, 1)) * 180 / Math.PI;
    if (wallAngleFromVertical > this.forbiddenLedgeAngle) {
      this.debugInfo = { reason: `Wall too sloped (${wallAngleFromVertical.toFixed(0)}°)` };
      return false;
    }

    // edge traces: high & low, along ±searchAngle around move direction
    const hit = this.traceForLedge(moveDir, wall.point);
    if (!hit) {
      this.debugInfo = { reason: 'No ledge found' };
      return false;
    }

    const ledgeHeight = hit.ledgeHeight - c.location.z;
    let type = null;
    if (ledgeHeight <= this.stepOffset) {
      this.debugInfo = { reason: `Step-height ledge (${ledgeHeight.toFixed(0)}) — walkable` };
      return false; // just walk up via step offset
    }
    if (ledgeHeight < 140) type = 'LowMantle';
    else if (ledgeHeight < 240) type = 'HighMantle';
    else {
      this.debugInfo = { reason: `Ledge too high (${ledgeHeight.toFixed(0)})` };
      return false;
    }

    // block high mantle when moving away from the wall
    if (type === 'HighMantle' && this.blockHighMantleWhenMovingAway && hasInput) {
      const vel = c.movement.velocity;
      const vd = { x: vel.x, y: vel.y };
      if (vd.x * moveDir.x + vd.y * moveDir.y < 0) {
        this.debugInfo = { reason: 'Moving away — blocked' };
        return false;
      }
    }

    this.debugInfo = {
      reason: `${type} @ ${ledgeHeight.toFixed(0)}u`,
      ledgeHeight,
      point: hit.surfacePoint,
    };

    this.playMantle(type, hit.surfacePoint, moveDir, inputWorld);
    return true;
  }

  traceForLedge(moveDir, wallPoint) {
    const probes = [
      { name: 'high', z0: this.highTraceStart, z1: this.highTraceEnd },
      { name: 'low', z0: this.lowTraceStart, z1: this.lowTraceEnd },
    ];
    const base = this.character.location;
    const angles = [0, this.searchAngle, -this.searchAngle];
    let best = null;

    for (const p of probes) {
      for (const aDeg of angles) {
        const a = aDeg * Math.PI / 180;
        const dir = rotate2D(moveDir, a);
        const start = { x: base.x, y: base.y, z: base.z + p.z0 };
        const end = { x: base.x + dir.x * this.edgeTraceLength * 2, y: base.y + dir.y * this.edgeTraceLength * 2, z: base.z + p.z1 };
        const tr = this.probe.lineTraceDown(start, end, this.castRadius);
        if (tr && tr.hit) {
          const nDotUp = tr.normal.z; // ledge top should be roughly horizontal
          const angleDeg = Math.acos(clamp(nDotUp, 0, 1)) * 180 / Math.PI;
          if (angleDeg > 90 - this.minLedgeAngle) continue;
          const cand = { ledgeHeight: tr.point.z, surfacePoint: tr.point, probe: p.name, angleDeg };
          if (!best || cand.ledgeHeight > best.ledgeHeight) best = cand;
          break; // closest along this fan ray
        }
      }
    }
    void wallPoint;
    return best;
  }

  /** Port of ALSMantleComponent::PlayMantle — routes montage through the provider interface. */
  playMantle(type, targetSurface, moveDir, inputWorld) {
    const c = this.character;
    const asset = this.mantleAssets[type];
    this.asset = asset;
    this.active = true;

    this.startLoc = { ...c.location };
    this.targetLoc = { x: targetSurface.x - moveDir.x * 25, y: targetSurface.y - moveDir.y * 25, z: targetSurface.z };
    this.startYaw = c.actorYaw;
    this.targetYaw = c.controlRotationYaw;
    this.inputVectorAtRequest = { x: inputWorld.x, y: inputWorld.y };
    this.lastMoveDelta = { x: 0, y: 0 };

    // SetMovementState(Mantling) + freeze physics
    c.setMovementState(EALSMovementState.Mantling);
    c.setMovementAction(type === 'LowMantle' ? EALSMovementAction.LowMantle : EALSMovementAction.HighMantle);
    c.movement.zeroMovement();
    c.movement.mode = 0; // MOVE_None during mantle

    // **Decoupled animation call** — exactly the path introduced by the IALSAnimationProviderInterface commit
    const lightweight = asset.bUseLightweightMantle;
    const rate = lightweight ? asset.LightweightTimelinePlayRate : asset.playRate;
    const res = c.animationProvider.alsPlayMontage(asset.montage, rate, -1);
    c.lastMontageResult = res;
    if (res === EALSAnimationPlayResult.Refused && lightweight) {
      // fallback like GetMantleAsset override chain
      c.animationProvider.alsPlayMontage('Mantle', 1.0, -1);
    }

    this.timeline.length = asset.timelineLength / (lightweight ? Math.max(1, asset.LightweightTimelinePlayRate) : 1);
    this.timeline.play(1.0);
  }

  updateTimeline(t) {
    const c = this.character;
    const a = this.asset;
    const s0 = a.startPoint[1], e0 = a.endPoint[1];
    const s1 = a.startPoint[2], e1 = a.endPoint[2];

    // MantleRootMotion curve: smoothstep between mapped ranges
    let curveT = 0;
    if (t > s0 && t < e0) curveT = ease((t - s0) / (e0 - s0));
    else if (t >= e0) curveT = 1;

    // Z track: 0 -> 110% of height then settle to 100%
    const height = this.targetLoc.z - this.startLoc.z;
    let zLift;
    if (t < s1) zLift = 0;
    else if (t < e1) {
      const k = ease((t - s1) / (e1 - s1));
      zLift = k * height * 1.1;
    } else {
      const k = ease((t - e1) / (1 - e1));
      zLift = height * (1.1 - 0.1 * k);
    }

    // XY track follows curveT along the straight line to target
    const xy = ease(mapUnit(t, s0, e1));
    let nx = lerpN(this.startLoc.x, this.targetLoc.x, xy);
    let ny = lerpN(this.startLoc.y, this.targetLoc.y, xy);
    let nz = this.startLoc.z + zLift;

    // bMaintainMantleMovement: residual player input still nudges the mantle
    if (this.bMaintainMantleMovement) {
      const iv = c.peekInputWorld();
      const mag = Math.hypot(iv.x, iv.y);
      if (mag > 0.1) {
        const scale = 150 * (1 - xy) / 250; // slower as we approach
        this.lastMoveDelta = { x: iv.x * scale, y: iv.y * scale };
        nx += this.lastMoveDelta.x;
        ny += this.lastMoveDelta.y;
      }
    }

    c.location = { x: nx, y: ny, z: nz };
    // yaw blend toward camera facing over the first half
    c.actorYaw = this.startYaw + findDeltaAngle(this.startYaw, this.targetYaw) * ease(mapUnit(t, 0, 0.5));

    // feed normalized progress into the montage via an anim curve (ALS_GetCurveValue demo)
    c.animationProvider.setCurveValue('MantleProgress', t);
    void curveT;
  }

  endMantling() {
    const c = this.character;
    this.active = false;
    this.asset = null;
    c.animationProvider.alsStopMontage(0.25);
    c.movement.mode = 1; // Walking
    c.setMovementAction(EALSMovementAction.None);
    c.setMovementState(EALSMovementState.Grounded);
    // land velocity inherits residual movement (like the C++ component)
    c.movement.velocity.x = this.lastMoveDelta.x * 60;
    c.movement.velocity.y = this.lastMoveDelta.y * 60;
    c.movement.velocity.z = 0;
    c.location.z = c.groundHeightAt(c.location);
  }

  tick(dt) {
    this.timeline.tick(dt);
  }
}

function mapUnit(t, a, b) { return clamp((t - a) / (b - a || 1), 0, 1); }
function lerpN(a, b, t) { return a + (b - a) * t; }
function rotate2D(v, rad) {
  const cs = Math.cos(rad), sn = Math.sin(rad);
  return { x: v.x * cs - v.y * sn, y: v.x * sn + v.y * cs };
}
function facingDir(yawDeg) {
  const r = yawDeg * Math.PI / 180;
  return { x: Math.cos(r), y: Math.sin(r) };
}
export { rInterpTo, yawOf };
