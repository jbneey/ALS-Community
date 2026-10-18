/**
 * Headless smoke test — runs the full ALS port with a stub world probe (no DOM, no three.js).
 * Verifies: state machine transitions, gait hysteresis, mantle request pipeline through the
 * Animation Provider interface, ragdoll -> get-up cycle, and headless provider safety.
 *
 *   node tests/smoke.mjs
 */

import { ALSBaseCharacter } from '../js/als/baseCharacter.js';
import { ALSProceduralAnimationProvider, ALSHeadlessAnimationProvider } from '../js/als/animationProvider.js';
import { EALSGait, EALSMovementAction, EALSMovementState, EALSAnimationPlayResult, EALSRotationMode } from '../js/als/enums.js';

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' [' + extra + ']' : ''}`);
  if (!cond) failures++;
}

// ---- stub probe: flat ground at z=0, one wall at x>=300 with a low ledge top z=100 ----
const stubProbe = {
  groundHeight: () => 0,
  resolve: (p) => ({ x: p.x > 260 ? 260 : p.x, y: p.y }),
  sphereTrace: (from, dir, dist) => {
    const t = (300 - from.x) / (dir.x || 1e-9);
    if (t > 0 && t < dist) return { hit: true, point: { x: 300, y: from.y + dir.y * t, z: from.z }, normal: { x: -1, y: 0, z: 0 }, distance: t };
    return { hit: false };
  },
  lineTraceDown: (start, end) => {
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const x = start.x + (end.x - start.x) * k;
      const z = start.z + (end.z - start.z) * k;
      if (x >= 300 && x <= 420 && z <= 100 && z >= 55) {
        return { hit: true, point: { x, y: start.y, z: 100 }, normal: { x: 0, y: 0, z: 1 }, distance: k };
      }
    }
    return { hit: false };
  },
  lineTraceSimple: () => ({ hit: false }),
};

function makeChar(provider) {
  return new ALSBaseCharacter({ location: { x: 0, y: 0, z: 0 }, animationProvider: provider, worldProbe: stubProbe });
}

function tick(ch, seconds, input) {
  for (let i = 0; i < Math.round(seconds / 0.016); i++) ch.tick(0.016, input);
}

// ================= 1. locomotion & gait =================
{
  const provider = new ALSProceduralAnimationProvider();
  provider.registerClip('Roll', 0.9, () => {});
  const ch = makeChar(provider);

  const runInput = { moveWorld: { x: 1, y: 0 }, wantsSprint: false, wantsWalk: false };
  tick(ch, 2.0, runInput);
  check('grounded after start', ch.movementState === EALSMovementState.Grounded);
  check('running gait at speed', ch.gait === EALSGait.Running);
  check('velocity ~run speed', Math.abs(ch.movement.velocity.x - 250) < 30, `vx=${ch.movement.velocity.x.toFixed(0)}`);
  check('actor faces velocity (VelocityDirection)', Math.abs(ch.actorYaw) < 10);

  tick(ch, 2.5, { moveWorld: { x: 1, y: 0 }, wantsSprint: true, wantsWalk: false });
  check('sprinting gait engaged', ch.gait === EALSGait.Sprinting);

  tick(ch, 1.5, { moveWorld: { x: 1, y: 0 }, wantsSprint: false, wantsWalk: true });
  check('walk modifier -> Walking gait', ch.gait === EALSGait.Walking);

  tick(ch, 2.0, { moveWorld: { x: 0, y: 0 }, wantsSprint: false, wantsWalk: false });
  check('brings to rest', ch.movementData.Speed < 15, `speed=${ch.movementData.Speed.toFixed(1)}`);
}

// ================= 2. jump / land =================
{
  const provider = new ALSProceduralAnimationProvider();
  const ch = makeChar(provider);
  ch.jump();
  check('jump enters InAir', ch.movementState === EALSMovementState.InAir && ch.location.z > 0);
  tick(ch, 1.4, { moveWorld: { x: 0, y: 0 }, wantsSprint: false, wantsWalk: false });
  check('lands back grounded', ch.movementState === EALSMovementState.Grounded && Math.abs(ch.location.z) < 1);
}

// ================= 3. roll via montage provider =================
{
  const provider = new ALSProceduralAnimationProvider();
  provider.registerClip('Roll', 0.9, () => {});
  const ch = makeChar(provider);
  tick(ch, 0.5, { moveWorld: { x: 1, y: 0 }, wantsSprint: false, wantsWalk: false });
  ch.handleRollRequest();
  check('roll action set', ch.movementAction === EALSMovementAction.Rolling);
  check('roll montage played via provider', !!provider.current && provider.current.name === 'Roll');
  tick(ch, 1.2, { moveWorld: { x: 0, y: 0 }, wantsSprint: false, wantsWalk: false });
  check('roll action cleared', ch.movementAction === EALSMovementAction.None);
}

// ================= 4. mantle pipeline =================
{
  const provider = new ALSProceduralAnimationProvider();
  provider.registerClip('Mantle', 1.2, () => {});
  provider.registerClip('Mantle2m', 1.7, () => {});
  const ch = makeChar(provider);
  ch.inputWorld = { x: 1, y: 0 };

  tick(ch, 1.2, { moveWorld: { x: 1, y: 0 }, wantsSprint: false, wantsWalk: false });
  const ok = ch.tryMantle();
  check('mantle accepted near ledge', ok === true, JSON.stringify(ch.mantle.debugInfo));
  check('movement state Mantling', ch.movementState === EALSMovementState.Mantling);
  check('action LowMantle', ch.movementAction === EALSMovementAction.LowMantle);
  check('montage routed through provider', provider.current?.name === 'Mantle');
  check('play result Played', ch.lastMontageResult === EALSAnimationPlayResult.Played);

  tick(ch, 2.0, { moveWorld: { x: 0, y: 0 }, wantsSprint: false, wantsWalk: false });
  check('mantle completed -> grounded', ch.movementState === EALSMovementState.Grounded);
  check('mantled up to ledge height', Math.abs(ch.location.z - 100) < 2, `z=${ch.location.z.toFixed(1)}`);
  check('curve value readable (ALS_GetCurveValue)', typeof provider.alsGetCurveValue('MantleProgress') === 'number');
}

// ================= 5. ragdoll -> getup =================
{
  const provider = new ALSProceduralAnimationProvider();
  provider.registerClip('GetUp', 1.4, () => {});
  const ch = makeChar(provider);
  tick(ch, 1.0, { moveWorld: { x: 1, y: 0 }, wantsSprint: false, wantsWalk: false });
  ch.dropDown();
  check('ragdoll state entered', ch.movementState === EALSMovementState.Ragdoll);
  tick(ch, 1.8, { moveWorld: { x: 0, y: 0 }, wantsSprint: false, wantsWalk: false });
  check('get-up montage played', provider.current?.name === 'GetUp' || provider.log.some((l) => l.includes('GetUp')));
  tick(ch, 2.0, { moveWorld: { x: 0, y: 0 }, wantsSprint: false, wantsWalk: false });
  check('back to grounded after getup', ch.movementState === EALSMovementState.Grounded);
}

// ================= 6. headless provider safety =================
{
  const ch = makeChar(new ALSHeadlessAnimationProvider());
  tick(ch, 1.0, { moveWorld: { x: 1, y: 0 }, wantsSprint: false, wantsWalk: false });
  ch.handleRollRequest();
  ch.dropDown();
  tick(ch, 4.0, { moveWorld: { x: 0, y: 0 }, wantsSprint: false, wantsWalk: false });
  check('headless gameplay survives without visuals', ch.movementState === EALSMovementState.Grounded);
}

// ================= 7. rotation modes =================
{
  const provider = new ALSProceduralAnimationProvider();
  const ch = makeChar(provider);
  ch.controlRotationYaw = 90;
  ch.setRotationMode(EALSRotationMode.LookingDirection);
  tick(ch, 1.0, { moveWorld: { x: 0, y: 1 }, wantsSprint: false, wantsWalk: false });
  check('LookingDirection faces camera yaw', Math.abs(ch.actorYaw - 90) < 15, `yaw=${ch.actorYaw.toFixed(1)}`);
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
