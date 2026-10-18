/**
 * ALS-Community port — Math library.
 * Mirror of ALSMathLibrary.h (ClampMagnitude, MapRangeClamped, RInterpTo, VInterpTo)
 * plus the small vector/quaternion helpers a web engine needs.
 */

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** ALSMathLibrary::ClampMagnitude */
export function clampMagnitude(v, maxLen) {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len <= maxLen || len === 0) return { ...v };
  const s = maxLen / len;
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

/** ALSMathLibrary::MapRangeClamped */
export function mapRangeClamped(inVal, inMin, inMax, outMin, outMax) {
  const mapped = outMin + ((inVal - inMin) * (outMax - outMin)) / (inMax - inMin || 1);
  return clamp(mapped, Math.min(outMin, outMax), Math.max(outMin, outMax));
}

/** ALSMathLibrary::RInterpTo — framerate-aware rotation interpolation (degrees). */
export function rInterpTo(cur, target, dt, interpSpeed) {
  if (interpSpeed < 0) return findDeltaAngle(cur, target); // snap
  let delta = findDeltaAngle(cur, target);
  const step = delta * clamp(interpSpeed * dt, 0, 1);
  // limit to half the distance like UE's FInterpTo on shortest path
  if (Math.abs(step) > Math.abs(delta)) return target;
  return cur + step;
}

/** Shortest signed delta between two yaw angles (degrees). */
export function findDeltaAngle(from, to) {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/** ALSMathLibrary::VInterpTo */
export function vInterpTo(cur, target, dt, interpSpeed) {
  if (interpSpeed < 0) return { ...target };
  const k = clamp(interpSpeed * dt, 0, 1);
  return {
    x: cur.x + (target.x - cur.x) * k,
    y: cur.y + (target.y - cur.y) * k,
    z: cur.z + (target.z - cur.z) * k,
  };
}

export function vLerp(a, b, t) {
  t = clamp(t, 0, 1);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

export function vAdd(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
export function vSub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
export function vScale(a, s) { return { x: a.x * s, y: a.y * s, z: a.z * s }; }
export function vLen(a) { return Math.hypot(a.x, a.y, a.z); }
export function vDist(a, b) { return vLen(vSub(a, b)); }

export function vNormalize(a) {
  const l = vLen(a);
  return l > 1e-6 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 };
}

export function vDot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

/** Yaw (degrees) of a vector projected onto XZ plane. Matches UE FRotator.Yaw semantics. */
export function yawOf(v) {
  if (Math.abs(v.x) < 1e-9 && Math.abs(v.y) < 1e-9) return 0;
  return Math.atan2(v.y, v.x) * RAD;
}

export function lerpScalar(a, b, t) { return a + (b - a) * clamp(t, 0, 1); }

/** Smooth damp toward target with exponential decay, framerate independent. */
export function expDecay(cur, target, rate, dt) {
  const k = 1 - Math.exp(-rate * dt);
  return cur + (target - cur) * k;
}
