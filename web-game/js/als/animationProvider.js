/**
 * ALS-Community port — Animation Provider abstraction.
 *
 * Faithful JS re-implementation of
 *   Source/ALSV4_CPP/Public/Library/ALSAnimationProvider.h
 *   (IALSAnimationProviderInterface + EALSAnimationPlayResult)
 *
 * In the C++ plugin, AALSBaseCharacter implements this interface and, by default,
 * routes calls to GetMesh()->GetAnimInstance(). For a web engine we implement it
 * with a procedural "clip" system: every montage is a data-driven one-shot
 * animation segment (bob/spin/arm-pose functions), so gameplay logic never touches
 * any renderer-specific API — exactly what the decoupling commit intended.
 */

import { EALSAnimationPlayResult } from './enums.js';

/**
 * Interface contract (documented, mirrors the UFUNCTION list of the C++ header):
 *
 *   alsPlayMontage(montageName, playRate, startingPosition) -> EALSAnimationPlayResult
 *   alsStopMontage(blendOutTime)                            -> void
 *   alsSavePoseSnapshot(snapshotName)                       -> void
 *   alsGetCurveValue(curveName)                             -> float
 *   alsGetVisualMeshComponent()                             -> visual object or null
 */
export class ALSAnimationProviderBase {
  alsPlayMontage(/* montage, playRate, startPosition */) {
    return EALSAnimationPlayResult.Unavailable;
  }
  alsStopMontage(/* blendOutTime */) {}
  alsSavePoseSnapshot(/* snapshotName */) {}
  alsGetCurveValue(/* curveName */) { return 0; }
  alsGetVisualMeshComponent() { return null; }
}

/**
 * Headless provider — used for dedicated servers / tests without visuals.
 * Mirrors the null-guards added in BeginPlay/ragdoll logic in the C++ port:
 * ALS gameplay must keep running even when no skeletal mesh exists.
 */
export class ALSHeadlessAnimationProvider extends ALSAnimationProviderBase {
  alsPlayMontage() { return EALSAnimationPlayResult.Unavailable; }
  advance(/* dt */) { return null; }          // tick driver is a no-op
  evaluate(out) { out.active = false; return out; }
  setCurveValue(name, v) { this.curveValues.set(String(name), v); }
  constructor() { super(); this.curveValues = new Map(); this.log = null; }
}

/**
 * Procedural provider for browser engines (Three.js / WebGL / WebGPU meshes).
 * "Montages" are registered as named clips with a sample(tNorm, outState) function.
 */
export class ALSProceduralAnimationProvider extends ALSAnimationProviderBase {
  constructor(visualComponent = null) {
    super();
    this.visual = visualComponent;
    this.clips = new Map();          // name -> { length, sample }
    this.current = null;             // { name, clip, playRate, time, position }
    this.curveValues = new Map();    // FName -> float
    this.snapshots = new Map();      // name -> pose snapshot
    this.onMontageEnded = null;      // callback(name, interrupted) — mirrors FOnMontageEnded
    this.log = [];                   // diagnostics for the HUD
  }

  registerClip(name, lengthSeconds, sampleFn) {
    this.clips.set(name, { length: lengthSeconds, sample: sampleFn });
  }

  // ---- IALSAnimationProviderInterface implementation ----

  alsPlayMontage(name, playRate = 1, startingPosition = 0) {
    const clip = this.clips.get(name);
    if (!clip) {
      this.log.push(`Montage refused: ${name}`);
      return EALSAnimationPlayResult.Refused;
    }
    if (startingPosition < 0) startingPosition = clip.length * 0.25; // -1 == auto offset
    this.current = {
      name,
      clip,
      playRate: Math.max(0.1, playRate),
      time: 0,
      position: clampPos(startingPosition, clip.length),
    };
    this.log.push(`Montage played: ${name} @${playRate.toFixed(2)}x`);
    if (this.log.length > 8) this.log.shift();
    return EALSAnimationPlayResult.Played;
  }

  alsStopMontage(blendOutTime = 0.35) {
    if (!this.current) return;
    const ended = this.current.name;
    this.current = null;
    if (this.onMontageEnded) this.onMontageEnded(ended, true);
    void blendOutTime; // procedural blending handled by pose smoothing in the renderer
  }

  alsSavePoseSnapshot(snapshotName) {
    if (this.visual && this.visual.getPose) {
      this.snapshots.set(String(snapshotName), this.visual.getPose());
    }
  }

  alsGetCurveValue(curveName) {
    return this.curveValues.get(String(curveName)) ?? 0;
  }

  setCurveValue(curveName, v) {
    this.curveValues.set(String(curveName), v);
  }

  alsGetVisualMeshComponent() {
    return this.visual;
  }

  // ---- driver (called once per frame by the character's tick) ----

  advance(dt) {
    if (!this.current) return null;
    const m = this.current;
    m.time += dt * m.playRate;
    if (m.time >= m.clip.length) {
      this.current = null;
      if (this.onMontageEnded) this.onMontageEnded(m.name, false);
      return { name: m.name, finished: true, t: 1 };
    }
    return { name: m.name, finished: false, t: m.time / m.clip.length };
  }

  /** Evaluate the active montage into a pose modifier struct consumed by the renderer. */
  evaluate(out) {
    if (!this.current) {
      out.active = false;
      out.name = '';
      return out;
    }
    out.active = true;
    out.name = this.current.name;
    out.t = this.current.time / this.current.clip.length;
    this.current.clip.sample(out.t, out);
    return out;
  }
}

function clampPos(p, len) {
  return p < 0 ? 0 : p > len ? len : p;
}
