/**
 * ALS-Community port — Player Camera Manager.
 *
 * Port of ALSPlayerCameraManager.cpp: spring-arm camera with camera-lag,
 * shoulder offsets per rotation mode, wall pull-in via probe trace,
 * FirstPerson / ThirdPersonShoulder / ThirdPerson view modes and aim zoom FOV.
 */

import { EALSRotationMode, EALSViewMode } from './enums.js';
import { DEG, clamp, vAdd, vScale } from './math.js';

export class ALSPlayerCameraManager {
  constructor(character, worldProbe) {
    this.character = character;
    this.probe = worldProbe;

    // defaults from ALSPlayerCameraManager.h (cm)
    this.defaultArmLength = 450;
    this.aimArmLength = 250;
    this.firstPersonArmLength = 30;
    this.cameraLagSpeed = 12;
    this.rotationLagSpeed = 10;
    this.defaultFieldOfView = 90;
    this.aimFieldOfView = 60;

    this.position = { x: 0, y: -450, z: 180 }; // smoothed camera location
    this.target = { x: 0, y: 0, z: 140 };      // look-at point
    this.currentArmLength = this.defaultArmLength;
    this.fieldOfView = this.defaultFieldOfView;
  }

  update(dt) {
    const c = this.character;
    const yaw = c.controlRotationYaw * DEG;
    const pitch = clamp(c.controlPitch, -75, 75) * DEG;

    // shoulder offset by rotation mode (GetShoulderLocation switch)
    let shoulder = { x: 0, y: 0, z: 0 };
    if (c.rotationMode === EALSRotationMode.VelocityDirection) shoulder.y = 0;
    else if (c.rotationMode === EALSRotationMode.LookingDirection) shoulder.y = 25;
    else shoulder.y = 35; // Aiming — right shoulder

    const aiming = c.rotationMode === EALSRotationMode.Aiming;
    const fp = c.viewMode === EALSViewMode.FirstPerson;

    let armLen = fp ? this.firstPersonArmLength : aiming ? this.aimArmLength : this.defaultArmLength;
    if (c.movementState === 3 /* Mantling */) armLen *= 0.8;

    // desired target at pelvis/eye height
    const eyeZ = fp ? c.location.z + (c.stance ? 110 : 150) : c.location.z + (c.stance ? 90 : 140);
    const pivot = { x: c.location.x, y: c.location.y, z: eyeZ };

    // camera direction (forward from pivot toward viewer)
    const dir = {
      x: Math.cos(pitch) * Math.cos(yaw),
      y: Math.cos(pitch) * Math.sin(yaw),
      z: Math.sin(pitch),
    };
    // shoulder in camera-right space
    const right = { x: -Math.sin(yaw), y: Math.cos(yaw), z: 0 };
    pivotOffset(pivot, right, shoulder.y);

    // wall pull-in trace (camera collision)
    const wantPos = vAdd(pivot, vScale(dir, -armLen));
    const tr = this.probe.lineTraceSimple(pivot, wantPos);
    if (tr && tr.hit) {
      armLen = Math.max(60, tr.distance - 30);
    }
    const finalWant = vAdd(pivot, vScale(dir, -armLen));

    // camera lag smoothing
    const k = 1 - Math.exp(-this.cameraLagSpeed * dt);
    this.position.x += (finalWant.x - this.position.x) * k;
    this.position.y += (finalWant.y - this.position.y) * k;
    this.position.z += (finalWant.z - this.position.z) * k;
    this.target.x += (pivot.x - this.target.x) * Math.min(1, k * 1.5);
    this.target.y += (pivot.y - this.target.y) * Math.min(1, k * 1.5);
    this.target.z += (pivot.z - this.target.z) * Math.min(1, k * 1.5);

    this.currentArmLength = armLen;
    const wantFov = aiming ? this.aimFieldOfView : this.defaultFieldOfView;
    this.fieldOfView += (wantFov - this.fieldOfView) * k;
  }
}

function pivotOffset(p, right, amount) {
  p.x += right.x * amount;
  p.y += right.y * amount;
}
