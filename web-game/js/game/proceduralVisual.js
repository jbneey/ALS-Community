/**
 * Procedural character visual — the renderer-side half of the ALS animation system.
 *
 * This is what an ALSAnimationProvider implementation plugs into on a web engine:
 * it never reads gameplay state directly for one-shots; montages are evaluated via
 * provider.evaluate(pose) (ALS_SavePoseSnapshot / ALS_GetCurveValue equivalents),
 * while continuous locomotion blends use FALSCharacterMovementData-style state.
 */

import * as THREE from 'three';
import { DEG } from '../als/math.js';

export class ALSProceduralVisual {
  constructor(scene, color = 0xff9d4d) {
    this.scene = scene;
    this.walkPhase = 0;
    this.poseSmooth = 0.15; // blend smoothing

    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x33383f, roughness: 0.8 });

    this.root = new THREE.Group();       // position + yaw
    this.body = new THREE.Group();       // pitch/roll lean + crouch squash
    this.root.add(this.body);
    scene.add(this.root);

    const mk = (sx, sy, sz, m) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), m);
      mesh.castShadow = true;
      return mesh;
    };

    // torso pivot at pelvis (ALS z=100 -> Three y=100); front of body = local +X
    this.pelvisY = 100;
    this.torso = mk(30, 68, 46, mat);            // X=depth(front), Y=tall, Z=wide
    this.torso.position.y = this.pelvisY + 34;
    this.head = mk(30, 30, 30, mat);
    this.head.position.y = this.pelvisY + 85;
    this.body.add(this.torso, this.head);

    // limbs as pivoted groups; segments hang along -Y. Swing forward/back rotates about
    // the local Z axis (model faces +X); arms/legs separate left-right on the Z axis.
    this.limb = (name, zOff, y, len, m) => {
      const g = new THREE.Group();
      g.position.set(0, y, zOff);
      const seg = mk(16, len, 16, m);
      seg.position.y = -len / 2;
      g.add(seg);
      this.body.add(g);
      g.userData.name = name;
      return g;
    };
    this.armL = this.limb('armL', -31, this.pelvisY + 66, 60, mat);
    this.armR = this.limb('armR', 31, this.pelvisY + 66, 60, mat);
    this.legL = this.limb('legL', -14, this.pelvisY, 70, darkMat);
    this.legR = this.limb('legR', 14, this.pelvisY, 70, darkMat);

    // feet markers for step events (footstep notify equivalent)
    this.stepFlash = 0;

    this.poseOut = { active: false, name: '', t: 0, bob: 0, spin: 0, armFwd: 0, lean: 0, crouch: 0 };
  }

  /**
   * @param {ALSBaseCharacter} ch
   * @param {ALSProceduralAnimationProvider} provider
   */
  update(dt, ch, provider) {
    const md = ch.movementData;

    // root transform: ALS Z-up -> Three Y-up. actorYaw 0 = +X; model front = local +X.
    this.root.position.set(ch.location.x, ch.location.z, -ch.location.y);
    this.root.rotation.set(0, -ch.actorYaw * DEG, 0, 'YXZ');

    // ---- locomotion cycle ----
    const speedNorm = Math.min(1, md.Speed / 375);
    const freq = 1.6 + speedNorm * 3.2;
    if (md.bMoving && !md.bMantling) this.walkPhase += dt * freq * Math.PI * 2 * (0.5 + speedNorm * 0.5);

    const swing = (md.bMoving && !md.bRolling && !md.bMantling) ? (0.35 + speedNorm * 0.55) : 0.05;
    const s = Math.sin(this.walkPhase), c2 = Math.cos(this.walkPhase);

    let legLSwing = s * swing, legRswing = -s * swing;
    let armLSwing = -s * swing * 0.8, armRswing = s * swing * 0.8;

    // strafe/diagonal blend (RightSpeed drives side-step like ALS Left/Right clips)
    const strafe = md.RightSpeed;
    legLSwing += strafe * swing * 0.5;
    legRswing += strafe * swing * 0.5;

    // crouch pose
    const crouchT = md.bCrouching ? 1 : 0;
    this.body.position.y = lerpTo(this.body.position.y, -crouchT * 45, dt * 10);
    this.torso.scale.y = 1 - crouchT * 0.15;

    // aim overlay: arms forward
    if (md.bAiming) {
      armLSwing = -1.9; armRswing = -1.9;
    }

    // jump / land pose
    if (md.bInAir) {
      legLSwing = -0.5; legRswing = 0.3; armLSwing = -1.2; armRswing = -1.2;
    } else if (md.LandAmount > 0) {
      const la = md.LandAmount;
      this.body.position.y -= la * 20;
      armLSwing = 0.8 * la; armRswing = 0.8 * la;
    }

    // sprint lean
    const leanTarget = (md.bSprinting ? 0.28 : md.bMoving ? 0.08 : 0) + md.JumpAmount * -0.15;

    // ---- montage layer via the Animation Provider interface ----
    provider.evaluate(this.poseOut);
    const p = this.poseOut;
    if (p.active) {
      const w = smoothWindow(p.t, 0.1, 0.9); // blend in/out windows
      switch (p.name) {
        case 'Roll': {
          this.body.rotation.x = -p.spin * w;            // full backward rotation
          this.body.position.y = p.bob * w;
          break;
        }
        case 'Mantle':
        case 'Mantle2m': {
          armLSwing = -2.2 * w; armRswing = -2.2 * w;
          legLSwing = -0.6 * w; legRswing = 0.4 * w;
          this.body.rotation.x = 0.35 * w;
          break;
        }
        case 'GetUp': {
          this.body.rotation.x = (1 - p.t) * -Math.PI * 0.5; // rising from back
          this.body.position.y = (1 - p.t) * -60;
          break;
        }
      }
      void c2;
    } else {
      // ease body rotation back
      this.body.rotation.x = lerpTo(this.body.rotation.x, leanTarget, dt * 8);
    }

    if (ch.movementState === 4 /* Ragdoll */) {
      // tumble visually without any physics coupling to the renderer
      this.body.rotation.x += dt * 6;
      this.body.position.y = -60;
      this.armL.rotation.z = 1; this.armR.rotation.z = -1;
      this.legL.rotation.z = -0.8; this.legR.rotation.z = 0.8;
      return;
    }

    this.armL.rotation.z = armLSwing;
    this.armR.rotation.z = armRswing;
    this.legL.rotation.z = legLSwing;
    this.legR.rotation.z = legRswing;

    // footstep curve demo: read ALS_GetCurveValue('FootstepMask')
    this.stepFlash = Math.max(0, this.stepFlash - dt * 3);
    if ((provider.alsGetCurveValue('FootstepMask') ?? 1) > 0.5 &&
        md.bMoving && Math.sin(this.walkPhase) > 0.98) this.stepFlash = 1;
    this.head.material.emissive?.setHex(0x000000);
  }
}

function lerpTo(cur, target, k) {
  return cur + (target - cur) * Math.min(1, Math.abs(k));
}

function smoothWindow(t, a, b) {
  if (t < a) return t / a;
  if (t > b) return (1 - t) / (1 - b);
  return 1;
}
