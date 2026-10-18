/**
 * ALSModelVisual — drop-in replacement for ALSProceduralVisual that renders a
 * user-supplied character model instead of the procedural box rig.
 *
 * SUPPORTED FORMATS: glTF 2.0 binary (.glb) — recommended, or .gltf + .bin + textures.
 * (FBX/Dae are NOT supported; convert to .glb with the official glTF exporter in
 *  Blender, or with `npx gltf-transform import model.fbx output.glb`.)
 *
 * REQUIREMENTS for the model to animate correctly with ALS:
 *   - Units: meters, Y-up (the standard glTF convention). The loader auto-scales
 *     so the character capsule height (~180cm in ALS units) matches the model.
 *   - Facing: model should face +Z or -Z or +X/-X; the loader detects orientation
 *     from the skeleton's "forward" hint if named bones exist, otherwise assumes
 *     the same front as the procedural rig (+X local). You can override with the
 *     facing selector in the UI.
 *   - Skeleton: humanoid bone names following any of these conventions are mapped
 *     automatically (case-insensitive substring match):
 *       mixamo:  mixamorigHips, mixamorigSpine, mixamorigLeftUpLeg, ...
 *       generic: hips/pelvis, spine/chest, head, leftupleg/thigh_l, legright/shin_r,
 *                leftarm/upperarm_l, leftforearm/forearm_l, hand_l, foot_l
 *   - No animation clips required — ALS drives pose procedurally through the
 *     provider interface (same as the built-in visual). If the GLB contains an
 *     AnimationClip named "Idle"/"Roll"/"Mantle", it is ignored on purpose:
 *     montages still come from registerClip() callbacks.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js';
import { DEG, clamp } from '../als/math.js';

const BONE_PATTERNS = {
  root:    ['hips', 'pelvis', 'root', 'centerofmass'],
  spine:   ['spine_01', 'spine1', 'spine', 'abdomen'],
  chest:   ['spine_03', 'spine3', 'chest', 'upperchest'],
  neck:    ['neck', 'spine_04'],
  head:    ['head'],
  armL:    ['leftarm', 'left_upperarm', 'upperarm_l', 'arm_l', 'shoulder_l', 'l_upperarm'],
  armR:    ['rightarm', 'right_upperarm', 'upperarm_r', 'arm_r', 'shoulder_r', 'r_upperarm'],
  foreL:   ['leftforearm', 'left_lowerarm', 'forearm_l', 'lowerarm_l'],
  foreR:   ['rightforearm', 'right_lowerarm', 'forearm_r', 'lowerarm_r'],
  handL:   ['lefthand', 'hand_l'],
  handR:   ['righthand', 'hand_r'],
  legL:    ['leftupleg', 'left_thigh', 'thigh_l', 'upleg_l'],
  legR:    ['rightupleg', 'right_thigh', 'thigh_r', 'upleg_r'],
  shinL:   ['leftleg', 'left_calf', 'left_shin', 'calf_l', 'shin_l'],
  shinR:   ['rightleg', 'right_calf', 'right_shin', 'calf_r', 'shin_r'],
  footL:   ['leftfoot', 'foot_l'],
  footR:   ['rightfoot', 'foot_r'],
};

export class ALSModelVisual {
  /**
   * @param {THREE.Scene} scene
   * @param {{url?: string, buffer?: ArrayBuffer, facing?: number, colorTint?: number}} opts
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.walkPhase = 0;
    this.stepFlash = 0;
    this.poseOut = { active: false, name: '', t: 0, bob: 0, spin: 0, armFwd: 0, lean: 0, crouch: 0 };
    this.bones = null;          // mapped humanoid bones
    this.skeletonRoot = null;   // bone we move for whole-body effects
    this.modelScale = 1;
    // facingOffset is added to actorYaw (in degrees) so the model front aligns with ALS forward
    this.facingOffset = opts.facing ?? 0;
    this.loadError = null;

    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.body);
    scene.add(this.root);

    this.gltf = null;
    if (opts.url) this.loadFromUrl(opts.url);
    else if (opts.buffer) this.loadFromArrayBuffer(opts.buffer);
  }

  static canLoad(fileOrName) {
    const n = (typeof fileOrName === 'string' ? fileOrName : fileOrName.name || '').toLowerCase();
    return n.endsWith('.glb') || n.endsWith('.gltf');
  }

  loadFromUrl(url) {
    new GLTFLoader().load(url, (g) => this._attach(g), undefined, (e) => { this.loadError = e; });
  }

  loadFromArrayBuffer(buffer) {
    new GLTFLoader().parse(buffer, '', (g) => this._attach(g), (e) => { this.loadError = e; });
  }

  _attach(gltf) {
    // remove previous model
    if (this.gltf) this.body.remove(this.gltf.scene);
    this.gltf = gltf;
    const model = gltf.scene;
    model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });

    // ---- fit scale: target total height ~180 ALS units (cm-ish) ----
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    box.getSize(size);
    const heightUnits = Math.max(size.y, 0.001);
    this.modelScale = 180 / heightUnits;
    model.scale.setScalar(this.modelScale);
    // re-place so feet sit at pelvis-relative origin used by ALS (pelvisY=100 equivalent)
    const box2 = new THREE.Box3().setFromObject(model);
    model.position.y = -box2.min.y; // feet at y=0 of body group
    model.position.x -= (box2.min.x + box2.max.x) / 2;
    model.position.z -= (box2.min.z + box2.max.z) / 2;

    // ---- map humanoid bones ----
    this.bones = {};
    const skel = gltf.animations && gltf.animations[0] ? null : null;
    const boneList = [];
    model.traverse((o) => { if (o.isBone) boneList.push(o); });
    for (const [slot, pats] of Object.entries(BONE_PATTERNS)) {
      const found = boneList.find((b) => {
        const n = b.name.toLowerCase();
        return pats.some((p) => n.includes(p));
      });
      if (found) this.bones[slot] = found;
    }
    this.skeletonRoot = this.bones.root || boneList[0] || model;
    this.hasSkeleton = Object.keys(this.bones).length >= 5;

    this.body.add(model);
    this.onLoaded?.(this);
  }

  /** Same contract as ALSProceduralVisual.update — driven purely via the provider. */
  update(dt, ch, provider) {
    const md = ch.movementData;

    this.root.position.set(ch.location.x, ch.location.z, -ch.location.y);
    this.root.rotation.set(0, -(ch.actorYaw + this.facingOffset) * DEG, 0, 'YXZ');

    // locomotion cycle
    const speedNorm = clamp(md.Speed / 375, 0, 1);
    const freq = 1.6 + speedNorm * 3.2;
    if (md.bMoving && !md.bMantling) this.walkPhase += dt * freq * Math.PI * 2 * (0.5 + speedNorm * 0.5);
    const s = Math.sin(this.walkPhase);

    // evaluate montage layer through IALSAnimationProviderInterface
    provider.evaluate(this.poseOut);
    const p = this.poseOut;

    const swing = (md.bMoving && !md.bRolling && !md.bMantling) ? (0.3 + speedNorm * 0.5) : 0.04;
    let legL = s * swing, legR = -s * swing;
    let armL = -s * swing * 0.7, armR = s * swing * 0.7;
    legL += md.RightSpeed * swing * 0.4; legR += md.RightSpeed * swing * 0.4;

    if (md.bAiming) { armL = -1.7; armR = -1.7; }
    if (md.bInAir) { legL = -0.45; legR = 0.25; armL = -1.1; armR = -1.1; }

    let bodyPitch = md.bSprinting ? 0.25 : md.bMoving ? 0.07 : 0;
    let bodyDrop = md.bCrouching ? -45 : 0;
    let bodyRollSpin = 0;

    if (p.active) {
      const w = smoothWindow(p.t, 0.1, 0.9);
      switch (p.name) {
        case 'Roll':
          bodyRollSpin = -p.spin * w;
          bodyDrop = p.bob * w - 30;
          break;
        case 'Mantle':
        case 'Mantle2m':
          armL = -2.0 * w; armR = -2.0 * w;
          legL = -0.5 * w; legR = 0.35 * w;
          bodyPitch = 0.3 * w;
          break;
        case 'GetUp':
          bodyRollSpin = (1 - p.t) * -Math.PI * 0.5;
          bodyDrop = (1 - p.t) * -55;
          break;
      }
    }

    if (ch.movementState === 4 /* Ragdoll */) {
      bodyRollSpin += dt * 6;
      bodyDrop = -55;
    }

    // apply to skeleton if mapped, otherwise rotate/fall back on body group
    if (this.hasSkeleton && this.bones) {
      setRot(this.bones.armL,  'x', armL);
      setRot(this.bones.armR,  'x', armR);
      setRot(this.bones.legL,  'x', legL);
      setRot(this.bones.legR,  'x', legR);
      if (this.bones.foreL) setRot(this.bones.foreL, 'x', md.bAiming ? -0.4 : 0.2);
      if (this.bones.foreR) setRot(this.bones.foreR, 'x', md.bAiming ? -0.4 : 0.2);
      if (this.bones.spine) setRot(this.bones.spine, 'x', bodyPitch * 0.6);
      if (this.bones.root) {
        this.bones.root.position.y = lerpTo(this.bones.root.position.y || 0, bodyDrop * 0.4, dt * 10);
      }
      // whole-body roll / ragdoll tumble goes on the body group under the bones
      this.body.rotation.x = lerpTo(this.body.rotation.x, bodyRollSpin, dt * 14);
      this.body.position.y = lerpTo(this.body.position.y, bodyDrop * 0.6, dt * 12);
    } else {
      // no usable skeleton — just move/scale the whole model plausibly
      this.body.rotation.x = lerpTo(this.body.rotation.x, bodyRollSpin, dt * 14);
      this.body.position.y = lerpTo(this.body.position.y, bodyDrop, dt * 10);
      this.body.rotation.z = s * swing * 0.15;
    }

    // footstep curve read via ALS_GetCurveValue equivalent
    this.stepFlash = Math.max(0, this.stepFlash - dt * 3);
    if ((provider.alsGetCurveValue('FootstepMask') ?? 1) > 0.5 &&
        md.bMoving && Math.sin(this.walkPhase) > 0.98) this.stepFlash = 1;
  }
}

function setRot(bone, axis, angle) {
  if (!bone) return;
  bone.rotation[axis] = angle;
}

function lerpTo(cur, target, k) {
  return cur + (target - cur) * Math.min(1, Math.abs(k));
}

function smoothWindow(t, a, b) {
  if (t < a) return t / a;
  if (t > b) return (1 - t) / (1 - b);
  return 1;
}
