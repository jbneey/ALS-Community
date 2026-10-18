/**
 * ALS WEB DEMO — entry point.
 *
 * Wires the ported ALS system (js/als/*) to a Three.js renderer through two adapters:
 *   - ALSWorld (js/game/threeWorld.js)          -> physics/probe contract for movement & mantle
 *   - ALSProceduralAnimationProvider + Visual   -> IALSAnimationProviderInterface implementation
 * Nothing inside js/als/ imports three.js — exactly the decoupling goal of the plugin port.
 */

import * as THREE from 'three';
import { ALSBaseCharacter } from './als/baseCharacter.js';
import { ALSProceduralAnimationProvider, ALSHeadlessAnimationProvider } from './als/animationProvider.js';
import { ALSPlayerCameraManager } from './als/cameraManager.js';
import { EnumNames } from './als/enums.js';
import { ALSWorld, toThree } from './game/threeWorld.js';
import { ALSProceduralVisual } from './game/proceduralVisual.js';
import { ALSModelVisual } from './game/modelVisual.js';
import { ALSPlayerController } from './game/playerController.js';

// ---------------- renderer / scene ----------------
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x182033);
scene.fog = new THREE.Fog(0x182033, 1500, 4500);

const sun = new THREE.DirectionalLight(0xfff2d8, 2.2);
sun.position.set(600, 1200, 900);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -1500; sun.shadow.camera.right = 1500;
sun.shadow.camera.top = 1500; sun.shadow.camera.bottom = -1500;
scene.add(sun);
scene.add(new THREE.HemisphereLight(0x91a7ff, 0x33415a, 0.9));

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 1, 8000);

// ---------------- world ----------------
const world = new ALSWorld(scene);
const spawn = world.buildLevel();

// helper markers in the level
addLabel('LowMantle', 300, -120, 110);
addLabel('HighMantle', 300, -400, 220);
addLabel('Слишком высоко', -500, 220, 420);

function addLabel(text, x, y, z) {
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 128;
  const cx = cv.getContext('2d');
  cx.fillStyle = 'rgba(10,14,24,.75)'; roundRect(cx, 8, 8, 496, 112, 18); cx.fill();
  cx.strokeStyle = '#7fa8ff'; cx.lineWidth = 3; roundRect(cx, 8, 8, 496, 112, 18); cx.stroke();
  cx.font = 'bold 52px Segoe UI'; cx.fillStyle = '#ffd27f'; cx.textAlign = 'center'; cx.textBaseline = 'middle';
  cx.fillText(text, 256, 66);
  const tex = new THREE.CanvasTexture(cv);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  spr.scale.set(220, 55, 1);
  spr.position.set(x, z, -y);
  scene.add(spr);
}
function roundRect(cx, x, y, w, h, r) {
  cx.beginPath(); cx.moveTo(x + r, y);
  cx.arcTo(x + w, y, x + w, y + h, r); cx.arcTo(x + w, y + h, x, y + h, r);
  cx.arcTo(x, y + h, x, y, r); cx.arcTo(x, y, x + w, y, r); cx.closePath();
}

// ---------------- ALS character stack ----------------
const proceduralVisual = new ALSProceduralVisual(scene);
let visual = proceduralVisual;   // active visual (procedural or user model)
let provider = new ALSProceduralAnimationProvider(visual);
registerMontages(provider);

// ---- custom character model upload (.glb / .gltf) ----
const modelInput = document.createElement('input');
modelInput.type = 'file';
modelInput.accept = '.glb,.gltf';
modelInput.style.display = 'none';
document.body.appendChild(modelInput);

const btnModel = document.createElement('button');
btnModel.id = 'toggle-model';
btnModel.textContent = 'Загрузить модель (.glb)';
document.body.appendChild(btnModel);
btnModel.addEventListener('click', () => {
  if (visual !== proceduralVisual) { switchToProcedural(); return; }
  modelInput.click();
});

modelInput.addEventListener('change', async () => {
  const file = modelInput.files[0];
  if (!file) return;
  if (!ALSModelVisual.canLoad(file)) { alert('Нужен формат glTF 2.0: .glb (рекомендуется) или .gltf'); return; }
  try {
    const buffer = await file.arrayBuffer();
    switchToModel(buffer, file.name);
  } catch (e) {
    alert('Не удалось прочитать файл: ' + e.message);
  }
  modelInput.value = '';
});

function switchToModel(buffer, name) {
  const mv = new ALSModelVisual(scene, { buffer });
  mv.onLoaded = (v) => {
    if (!v.hasSkeleton) {
      statusEl.textContent = `Модель «${name}» загружена, но скелет не распознан — работает режим whole-body.`;
    } else {
      const slots = Object.keys(v.bones).length;
      statusEl.textContent = `Модель «${name}»: скелет распознан (${slots} костей), ALS-анимация подключена.`;
    }
  };
  mv.loadError = null;
  visual = mv;
  provider.visual = mv;               // provider talks to the visual only via interface fields
  btnModel.textContent = 'Сбросить на процедурного персонажа';
  statusEl.style.display = 'block';
  facingSelect.style.display = 'inline-block';
  applyFacing();
}

function switchToProcedural() {
  scene.remove(visual.root);
  visual = proceduralVisual;
  provider.visual = visual;
  btnModel.textContent = 'Загрузить модель (.glb)';
  statusEl.style.display = 'none';
  facingSelect.style.display = 'none';
}

// facing correction for models that don't face +X like the procedural rig
const facingSelect = document.createElement('select');
facingSelect.id = 'facing-select';
facingSelect.style.display = 'none';
[['Вперёд = -Z (mixamo/Blender)', 90], ['Вперёд = +Z', -90], ['Вперёд = +X (как у нас)', 0], ['Вперёд = -X', 180]]
  .forEach(([label, deg]) => {
    const o = document.createElement('option');
    o.textContent = label; o.value = deg; facingSelect.appendChild(o);
  });
document.body.appendChild(facingSelect);
facingSelect.addEventListener('change', applyFacing);
function applyFacing() {
  if (visual instanceof ALSModelVisual) visual.facingOffset = parseFloat(facingSelect.value) || 0;
}

const statusEl = document.createElement('div');
statusEl.id = 'model-status';
statusEl.style.display = 'none';
document.body.appendChild(statusEl);

const character = new ALSBaseCharacter({
  name: 'ALS_WebCharacter',
  location: spawn,
  animationProvider: provider,
  worldProbe: world,
});
character.controlRotationYaw = 90; // face into the level

const camManager = new ALSPlayerCameraManager(character, world);
const playerController = new ALSPlayerController(character, camManager);

// lightweight mantle toggle for browsers (the flag added by the web-decoupling commit)
character.mantle.mantleAssets.LowMantle.bUseLightweightMantle = true;
character.mantle.mantleAssets.LowMantle.LightweightTimelinePlayRate = 1.35;

// headless toggle — demonstrates dedicated-server null-guards
function setHeadless(on) {
  if (on) {
    character.animationProvider = new ALSHeadlessAnimationProvider();
    visual.root.visible = false;
    btn.textContent = 'Headless-режим: ВКЛ (H)';
  } else {
    character.animationProvider = provider;
    visual.root.visible = true;
    btn.textContent = 'Headless-режим (H)';
  }
}

const btn = document.getElementById('toggle-headless');
btn.addEventListener('click', () => setHeadless(!(character.animationProvider instanceof ALSProceduralAnimationProvider)));
playerController.headlessToggle = () => setHeadless(!(character.animationProvider instanceof ALSProceduralAnimationProvider));

// pointer lock
const overlay = document.getElementById('overlay-start');
overlay.addEventListener('click', () => renderer.domElement.requestPointerLock());
document.addEventListener('pointerlockchange', () => {
  overlay.classList.toggle('hidden', !!document.pointerLockElement);
});

// ---------------- montage ("clip") library ----------------
function registerMontages(p) {
  // Roll: forward roll ~0.9s
  p.registerClip('Roll', 0.9, (t, out) => {
    out.spin = t * Math.PI * 2;                 // full rotation
    out.bob = Math.sin(t * Math.PI) * 45;       // hop arc
  });
  // Low mantle
  p.registerClip('Mantle', 1.2, (t, out) => { out.lean = Math.sin(t * Math.PI); });
  // High (2m) mantle
  p.registerClip('Mantle2m', 1.7, (t, out) => { out.lean = Math.sin(t * Math.PI); });
  // Get up from ragdoll
  p.registerClip('GetUp', 1.4, (t, out) => { out.crouch = 1 - t; });

  // footstep notify equivalent: mask curve toggled by locomotion each frame below
  p.setCurveValue('FootstepMask', 1);
}

// ---------------- HUD ----------------
const $ = (id) => document.getElementById(id);
function updateHUD() {
  const md = character.movementData;
  $('v-state').textContent = EnumNames.MovementState[md.State];
  $('v-action').textContent = EnumNames.MovementAction[md.Action];
  $('v-gait').textContent = `${EnumNames.Gait[md.Gait]} · ${md.Speed.toFixed(0)} u/s`;
  $('v-rot').textContent = EnumNames.RotationMode[md.RotationMode];
  $('v-stance').textContent = `${EnumNames.Stance[md.Stance]} / ${EnumNames.ViewMode[md.ViewMode]}`;
  $('v-overlay').textContent = EnumNames.OverlayState[md.Overlay];
  $('v-hips').textContent = ['F', 'B', 'RF', 'RB', 'LF', 'LB'][md.HipsDirection];
  $('v-blend').textContent = `${md.StrideBlend.toFixed(2)} / ${md.DiagonalBlend.toFixed(2)}`;
  $('v-mantle').textContent = character.mantle.debugInfo?.reason ?? '—';
  const prov = character.animationProvider;
  const logLines = prov.log ? [...prov.log].reverse() : ['HEADLESS — все запросы возвращают Unavailable'];
  $('provider-log').innerHTML = logLines.map((l) => `› ${l}`).join('<br/>') || '› …';
}

// ---------------- main loop ----------------
let last = performance.now();
let hudTimer = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  const input = playerController.composeInput();
  character.tick(dt, input);

  // footstep curve writer (ALSAnimNotifyFootstep equivalent on the provider side)
  const moving = character.movementData.bMoving && !character.movementData.bInAir;
  provider.setCurveValue('FootstepMask', moving ? 1 : 0);

  visual.update(dt, character, character.animationProvider);
  camManager.update(dt);

  // push ALS camera manager result into the Three.js camera
  const cp = toThree(camManager.position);
  const ct = toThree(camManager.target);
  camera.position.copy(cp);
  camera.up.set(0, 0, 1); // our world is Z-up before conversion; keep sky up
  camera.up.set(0, 1, 0);
  camera.lookAt(ct);
  camera.fov = camManager.fieldOfView;
  camera.updateProjectionMatrix();

  renderer.render(scene, camera);

  hudTimer += dt;
  if (hudTimer > 0.1) { hudTimer = 0; updateHUD(); }
}
requestAnimationFrame(frame);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
