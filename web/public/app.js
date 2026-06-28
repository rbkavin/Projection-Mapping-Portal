// @ts-nocheck
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  handleCalibrationMessage,
  calibrationSummary,
  calibrationDiagnostics,
  isCalibrated,
  mapSpecsPoseToWeb,
  mapPortalLocalPoseToWeb,
  defaultViewPosition,
  defaultViewQuaternion,
  getPortalCenter,
  getPortalWidth,
  getPortalHeight,
  specsDepthToWebZ,
  setDebugOverlayVisible,
  updateHeadDebugMarker,
  isDebugOverlayVisible,
  VIEWER_BUILD,
} from "./calibration.js";
import { createOrbitDebug, buildPortalHoleVisual } from "./orbit-debug.js";
import { applyPortalProjection, resetPerspectiveProjection } from "./portal-projection.js";
import { OrbitControls }    from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

// ── Renderer ──────────────────────────────────────────────────────────────────
const canvas = document.getElementById("canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace  = THREE.SRGBColorSpace;
renderer.toneMapping       = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

// ── Scene & lights ────────────────────────────────────────────────────────────
const innerScene = new THREE.Scene();
innerScene.background = new THREE.Color(0x060c14);

const worldRoot = new THREE.Group();
worldRoot.name = "world-root";
innerScene.add(worldRoot);

const hemiLight = new THREE.HemisphereLight(0xfff4e0, 0x444466, 1.5);
innerScene.add(hemiLight);
const ambientLight = new THREE.AmbientLight(0xfff4e0, 1.2);
innerScene.add(ambientLight);
const sunLight = new THREE.DirectionalLight(0xfff0cc, 1.8); // warm key light
sunLight.position.set(3, 6, 4);
innerScene.add(sunLight);
const fillLight = new THREE.DirectionalLight(0xe8f0ff, 0.6); // cool fill from below
fillLight.position.set(-2, -3, 2);
innerScene.add(fillLight);

// PBR image-based lighting — Sketchfab exports look flat without this
const pmremGenerator = new THREE.PMREMGenerator(renderer);
pmremGenerator.compileEquirectangularShader();
innerScene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;

// ── Camera ────────────────────────────────────────────────────────────────────
const innerCamera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 500);
innerCamera.position.copy(defaultViewPosition());
innerCamera.layers.set(0); // layer 1 = orbit-only debug markers

// ── Portal hole visual (orbit only, layer 1) ──────────────────────────────────
let portalHoleGroup = buildPortalHoleVisual(worldRoot);
portalHoleGroup.traverse(o => o.layers.set(1));

// ── Orbit debug ───────────────────────────────────────────────────────────────
const orbitDebug = createOrbitDebug({ canvas, innerScene, innerCamera, worldRoot });

// ── Models ────────────────────────────────────────────────────────────────────
const MODELS = [
  { name: "Isometric Room", path: "/assets/tiny_isometric_room.glb", scale: 0.00494, offsetX: 0, offsetY: -1.15, depthCm: 280, rotX: 0, rotY: 0, rotZ: 0 },
  { name: "Custom",         path: null,                               scale: 1,       offsetX: 0, offsetY: 0,     depthCm: 200, rotX: 0, rotY: 0, rotZ: 0 },
];

let activeModelIdx = 0;
let worldModel     = null;
const modelCache   = {};   // gltf.scene objects keyed by index
const loadingSet   = new Set(); // indices currently being fetched

// Live per-model transform overrides (seeded from MODELS defaults)
const modelOverrides = MODELS.map(m => ({
  scale: m.scale, offsetX: m.offsetX, offsetY: m.offsetY, depthCm: m.depthCm,
  rotX: m.rotX ?? 0, rotY: m.rotY ?? 0, rotZ: m.rotZ ?? 0,
}));

function getActiveOverride() { return modelOverrides[activeModelIdx]; }

// ── Persistence ───────────────────────────────────────────────────────────────
const STORAGE_KEY = "portal-studio-v1";

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      skyColor:  document.getElementById("sky-color")?.value ?? "#060c14",
      exposure:  renderer.toneMappingExposure,
      modelIdx:  activeModelIdx,
      overrides: modelOverrides.map(ov => ({
        scale: ov.scale, offsetX: ov.offsetX, offsetY: ov.offsetY,
        depthCm: ov.depthCm, rotX: ov.rotX, rotY: ov.rotY, rotZ: ov.rotZ,
      })),
      relayUrl: document.getElementById("relay-url-input")?.value ?? "",
      boundsX, boundsY, boundsZ,
    }));
  } catch (_) {}
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return 0;
    const data = JSON.parse(raw);
    if (data.skyColor) {
      const el = document.getElementById("sky-color");
      if (el) el.value = data.skyColor;
      innerScene.background = new THREE.Color(data.skyColor);
    }
    if (typeof data.exposure === "number") {
      renderer.toneMappingExposure = data.exposure;
      const slider = document.getElementById("exposure-slider");
      const val    = document.getElementById("exposure-val");
      if (slider) slider.value = String(data.exposure);
      if (val)    val.textContent = data.exposure.toFixed(2);
    }
    if (Array.isArray(data.overrides)) {
      data.overrides.forEach((ov, i) => {
        if (!modelOverrides[i]) return;
        ["scale","offsetX","offsetY","depthCm","rotX","rotY","rotZ"].forEach(k => {
          if (typeof ov[k] === "number") modelOverrides[i][k] = ov[k];
        });
      });
    }
    if (data.relayUrl) {
      const input = document.getElementById("relay-url-input");
      if (input) input.value = data.relayUrl;
    }
    if (typeof data.boundsX === "number") {
      boundsX = data.boundsX;
      const sl = document.getElementById("bounds-x"); if (sl) sl.value = String(boundsX);
      const vl = document.getElementById("bounds-x-val"); if (vl) vl.textContent = Math.round(boundsX * 100) + "%";
    }
    if (typeof data.boundsY === "number") {
      boundsY = data.boundsY;
      const sl = document.getElementById("bounds-y"); if (sl) sl.value = String(boundsY);
      const vl = document.getElementById("bounds-y-val"); if (vl) vl.textContent = Math.round(boundsY * 100) + "%";
    }
    if (typeof data.boundsZ === "number") {
      boundsZ = data.boundsZ;
      const sl = document.getElementById("bounds-z"); if (sl) sl.value = String(boundsZ);
      const vl = document.getElementById("bounds-z-val"); if (vl) vl.textContent = boundsZ.toFixed(2) + "m";
    }
    return (typeof data.modelIdx === "number" && data.modelIdx < MODELS.length)
      ? data.modelIdx : 0;
  } catch (_) { return 0; }
}

const SKETCHFAB_MODEL_IDX = new Set([]);  // no sketchfab presets remaining

function isGlowMaterial(m, meshName) {
  const label = (m.name || "") + " " + (meshName || "");
  return /ray/i.test(label);
}

function applyModelRenderProfile(modelIdx) {
  const sketch = SKETCHFAB_MODEL_IDX.has(modelIdx);
  renderer.toneMappingExposure = sketch ? 1.0 : 1.15;
  sunLight.intensity = sketch ? 1.2 : 1.8;
  ambientLight.intensity = sketch ? 0.55 : 1.2;
  hemiLight.intensity = sketch ? 0.85 : 1.5;
  fillLight.intensity = sketch ? 0.35 : 0.6;
}

function fixMaterials(obj, modelIdx) {
  const sketchfab = SKETCHFAB_MODEL_IDX.has(modelIdx);

  obj.traverse(node => {
    if (!node.isMesh || !node.material) return;
    const meshName = node.name || "";
    const mats = Array.isArray(node.material) ? node.material : [node.material];

    mats.forEach(m => {
      m.side = THREE.DoubleSide;
      if (!sketchfab) return;

      for (const key of ["map", "emissiveMap", "normalMap", "metalnessMap", "roughnessMap", "aoMap"]) {
        if (m[key]) m[key].colorSpace = THREE.SRGBColorSpace;
      }

      if (isGlowMaterial(m, meshName)) {
        m.transparent = true;
        m.depthWrite = false;
        m.blending = THREE.AdditiveBlending;
        m.emissiveIntensity = Math.min(m.emissiveIntensity ?? 1, 0.9);
        m.opacity = Math.min(m.opacity ?? 1, 0.28);
        node.renderOrder = 10;
        m.needsUpdate = true;
        return;
      }

      // Sketchfab BLEND atlases → alpha cutout (restores depth + sorting)
      if (m.map || m.transparent || (m.opacity != null && m.opacity < 0.99)) {
        m.alphaTest = 0.45;
        m.transparent = false;
        m.depthWrite = true;
        m.opacity = 1;
      }

      if (modelIdx === 3 && m.emissiveMap) {
        m.emissive.multiplyScalar(0.3);
        m.emissiveIntensity = Math.min(m.emissiveIntensity ?? 1, 0.45);
      } else if (m.emissive && (m.emissiveIntensity ?? 0) > 0) {
        const cap = modelIdx === 2 ? 1.4 : 1.0;
        m.emissiveIntensity = Math.min(m.emissiveIntensity ?? 1, cap);
      }

      // Cat Cafe: hide untextured near-black filler mesh
      if (modelIdx === 1 && !m.map && m.color) {
        if (m.color.r < 0.08 && m.color.g < 0.08 && m.color.b < 0.08) {
          node.visible = false;
          return;
        }
      }

      m.envMapIntensity = 0.95;
      if (m.roughness != null) m.roughness = Math.min(m.roughness + 0.08, 1);
      m.needsUpdate = true;
    });

    if (modelIdx === 3 && /room_lowpoly/i.test(meshName)) node.renderOrder = -1;
  });
}

function repositionModel() {
  if (!worldModel) return;
  const ov = getActiveOverride();
  const c  = getPortalCenter();
  worldModel.scale.setScalar(ov.scale);
  worldModel.position.set(c.x + ov.offsetX, c.y + ov.offsetY, specsDepthToWebZ(ov.depthCm));
  worldModel.rotation.set(ov.rotX, ov.rotY, ov.rotZ);
}

const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;

function updateTransformPanel() {
  const ov = getActiveOverride();
  const px = document.getElementById("tf-px");
  if (px && document.activeElement !== px) px.value = ov.offsetX.toFixed(3);
  const py = document.getElementById("tf-py");
  if (py && document.activeElement !== py) py.value = ov.offsetY.toFixed(3);
  const pz = document.getElementById("tf-pz");
  if (pz && document.activeElement !== pz) pz.value = ov.depthCm.toFixed(1);
  const rx = document.getElementById("tf-rx");
  if (rx && document.activeElement !== rx) rx.value = (ov.rotX * R2D).toFixed(1);
  const ry = document.getElementById("tf-ry");
  if (ry && document.activeElement !== ry) ry.value = (ov.rotY * R2D).toFixed(1);
  const rz = document.getElementById("tf-rz");
  if (rz && document.activeElement !== rz) rz.value = (ov.rotZ * R2D).toFixed(1);
  const sc = document.getElementById("tf-sc");
  if (sc && document.activeElement !== sc) sc.value = ov.scale.toExponential(3);
}

function bindTransformInputs() {
  function on(id, apply) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("input",  () => { const v = parseFloat(el.value); if (!isNaN(v)) { apply(v); repositionModel(); updateTestPanel(); saveSettings(); } });
    el.addEventListener("change", () => { const v = parseFloat(el.value); if (!isNaN(v)) { apply(v); repositionModel(); updateTestPanel(); saveSettings(); } });
  }
  on("tf-px", v => getActiveOverride().offsetX = v);
  on("tf-py", v => getActiveOverride().offsetY = v);
  on("tf-pz", v => getActiveOverride().depthCm = v);
  on("tf-rx", v => getActiveOverride().rotX = v * D2R);
  on("tf-ry", v => getActiveOverride().rotY = v * D2R);
  on("tf-rz", v => getActiveOverride().rotZ = v * D2R);
  on("tf-sc", v => { if (v > 0) getActiveOverride().scale = v; });
}

function updateTestPanel() {
  const loading = loadingSet.has(activeModelIdx);
  const loadingEl = document.getElementById("sb-loading");
  if (loadingEl) loadingEl.hidden = !loading;

  document.querySelectorAll(".preset-btn[data-model]").forEach(b => {
    const i = +b.dataset.model;
    b.classList.toggle("active", i === activeModelIdx);
    if (i === 4) return;  // custom btn label managed by loadUserModel
    b.textContent = MODELS[i].name + (loadingSet.has(i) ? " ···" : "");
  });
  updateTransformPanel();
}

function swapToModel(idx) {
  if (worldModel) { worldRoot.remove(worldModel); transformCtrl?.detach(); worldModel = null; }
  activeModelIdx = idx;
  const scene = modelCache[idx];
  if (!scene) { updateTestPanel(); return; }
  worldModel = scene;
  repositionModel();
  worldRoot.add(worldModel);
  applyModelRenderProfile(idx);
  if (testModeActive) transformCtrl?.attach(worldModel);
  updateTestPanel();
  updateHud();
  saveSettings();
}

const CUSTOM_IDX = MODELS.findIndex(m => m.path === null);  // index of the Custom slot

function autoFitToPortal(model) {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim < 0.0001) return;

  const targetSize = Math.max(getPortalHeight(), 1.0) * 0.85;
  const s = targetSize / maxDim;
  const ov = modelOverrides[CUSTOM_IDX];
  ov.scale   = s;
  ov.offsetX = -(center.x * s);
  ov.offsetY = -(center.y * s);
  ov.depthCm = 200;
  ov.rotX = 0; ov.rotY = 0; ov.rotZ = 0;
}

function loadUserModel(file) {
  const url = URL.createObjectURL(file);
  if (debugLogEl) debugLogEl.textContent = 'Loading "' + file.name + '"…';

  new GLTFLoader().load(url, (gltf) => {
    URL.revokeObjectURL(url);
    fixMaterials(gltf.scene, CUSTOM_IDX);
    autoFitToPortal(gltf.scene);
    modelCache[CUSTOM_IDX] = gltf.scene;
    loadingSet.delete(CUSTOM_IDX);

    const customBtn = document.getElementById("tp-custom-btn");
    if (customBtn) { customBtn.disabled = false; customBtn.textContent = file.name.replace(/\.[^.]+$/, ""); }
    const nameEl = document.getElementById("tp-upload-name");
    if (nameEl) { nameEl.textContent = file.name; nameEl.classList.add("loaded"); }

    swapToModel(CUSTOM_IDX);
    if (debugLogEl) debugLogEl.textContent = '"' + file.name + '" loaded — use transform panel to position';
  }, undefined, (err) => {
    URL.revokeObjectURL(url);
    loadingSet.delete(CUSTOM_IDX);
    console.error("[viewer] upload load error", err);
    if (debugLogEl) debugLogEl.textContent = 'Failed to load "' + file.name + '" — must be a valid GLB/GLTF';
  });
}

function loadModel(idx) {
  // Custom slot: only swap if a model has been uploaded
  if (idx === CUSTOM_IDX) {
    if (modelCache[CUSTOM_IDX]) swapToModel(CUSTOM_IDX);
    else if (debugLogEl) debugLogEl.textContent = 'No custom model yet — use "↑ Upload Model" in the panel';
    return;
  }

  // Instant swap if already cached
  if (modelCache[idx]) { swapToModel(idx); return; }

  // If already fetching, just mark it as the target and wait
  if (loadingSet.has(idx)) {
    if (worldModel) { worldRoot.remove(worldModel); transformCtrl?.detach(); worldModel = null; }
    activeModelIdx = idx;
    updateTestPanel();
    return;
  }

  // Start fetch
  loadingSet.add(idx);
  if (worldModel) { worldRoot.remove(worldModel); transformCtrl?.detach(); worldModel = null; }
  activeModelIdx = idx;
  updateTestPanel();

  new GLTFLoader().load(
    MODELS[idx].path,
    (gltf) => {
      fixMaterials(gltf.scene, idx);
      modelCache[idx] = gltf.scene;
      loadingSet.delete(idx);
      if (activeModelIdx === idx) swapToModel(idx);
      else updateTestPanel();
    },
    undefined,
    (err) => {
      loadingSet.delete(idx);
      console.error("[viewer] GLTF load error", err);
      if (debugLogEl) debugLogEl.textContent = "Load failed: " + MODELS[idx].path;
      updateTestPanel();
    }
  );
}

function preloadAll() {
  MODELS.forEach((m, i) => {
    if (modelCache[i] || loadingSet.has(i)) return;
    loadingSet.add(i);
    updateTestPanel();
    setTimeout(() => {
      new GLTFLoader().load(m.path, (gltf) => {
        fixMaterials(gltf.scene, i);
        modelCache[i] = gltf.scene;
        loadingSet.delete(i);
        if (activeModelIdx === i && !worldModel) swapToModel(i);
        else updateTestPanel();
      }, undefined, (err) => {
        loadingSet.delete(i);
        console.warn("[preload] failed", m.name, err);
        updateTestPanel();
      });
    }, i * 200);
  });
}

// ── Edit camera + gizmos (test mode) ─────────────────────────────────────────
let testModeActive = false;

const editCamera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 500);
editCamera.position.set(1.5, 1.2, 3.5);
editCamera.lookAt(0, 0, 0);
editCamera.layers.enable(1);   // also render layer-1 objects (portal frame outline + viewer helper)

const editOrbit = new OrbitControls(editCamera, canvas);
editOrbit.target.set(0, 0, 0);
editOrbit.enabled = false;

// Viewer-position frustum indicator — shows where the real camera is standing
const viewerHelper = new THREE.CameraHelper(innerCamera);
viewerHelper.layers.set(1);   // only visible in edit / orbit views
innerScene.add(viewerHelper);

const transformCtrl = new TransformControls(editCamera, canvas);
transformCtrl.setSize(0.8);
// Safely add to scene — r170+ may need getHelper(); older versions extend Object3D directly
try {
  const gizmoNode = typeof transformCtrl.getHelper === "function"
    ? transformCtrl.getHelper()
    : transformCtrl;
  innerScene.add(gizmoNode);
} catch (_) {
  /* swallow Object3D mismatch warning — controls still work */ }

transformCtrl.addEventListener("dragging-changed", e => {
  editOrbit.enabled = !e.value && testModeActive;
});

transformCtrl.addEventListener("change", () => {
  if (!worldModel) return;
  const ov = getActiveOverride();
  const c  = getPortalCenter();
  ov.offsetX = worldModel.position.x - c.x;
  ov.offsetY = worldModel.position.y - c.y;
  ov.depthCm = -worldModel.position.z / 0.01;
  ov.scale   = worldModel.scale.x;
  ov.rotX    = worldModel.rotation.x;
  ov.rotY    = worldModel.rotation.y;
  ov.rotZ    = worldModel.rotation.z;
  updateTestPanel();
});

// ── Pose state ────────────────────────────────────────────────────────────────
const targetPos = defaultViewPosition().clone();
const smoothPos = defaultViewPosition().clone();

let specsConnected  = false;
let receivingPose   = false;
let hasPose         = false;
let poseCount       = 0;
let poseSpace       = "none";
let lastPoseTime    = 0;
let lastLocalCm     = null;
let lockLocalCm     = null;
let lastRawPosCm    = null;
let lastRawQuat     = new THREE.Quaternion();
// First world-space pose becomes the anchor; all subsequent are offsets from it.
// This gives correct parallax without needing calibration for world-space streams.
let worldPoseAnchor = null;

const POSE_POS_DEADZONE_CM  = 1.5;
const POSE_ROT_DEADZONE_DOT = 0.99992;

function poseChangedEnough(rawPos, rawQuat, space) {
  if (!lastRawPosCm || space !== "portal_local") return true;
  const dx = rawPos.x - lastRawPosCm.x;
  const dy = rawPos.y - lastRawPosCm.y;
  const dz = rawPos.z - lastRawPosCm.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const dot  = Math.abs(rawQuat.dot(lastRawQuat));
  return dist >= POSE_POS_DEADZONE_CM || dot < POSE_ROT_DEADZONE_DOT;
}

function applyPose(msg) {
  if (!msg.position || !msg.rotation) return;

  const rawPos  = new THREE.Vector3(msg.position.x, msg.position.y, msg.position.z);
  const rawQuat = new THREE.Quaternion(msg.rotation.x, msg.rotation.y, msg.rotation.z, msg.rotation.w);
  poseSpace = msg.space || "world";

  if (!poseChangedEnough(rawPos, rawQuat, poseSpace)) return;

  lastRawPosCm = rawPos.clone();
  lastRawQuat.copy(rawQuat);

  let mapped;
  if (poseSpace === "portal_local") {
    // Calibrated path — exact portal-relative position
    mapped = mapPortalLocalPoseToWeb(rawPos, rawQuat);
    worldPoseAnchor = null;
    lastLocalCm = { x: rawPos.x, y: rawPos.y, z: rawPos.z };
  } else {
    // Uncalibrated world-space path — use delta from first pose so parallax works
    if (!worldPoseAnchor) worldPoseAnchor = rawPos.clone();
    const delta = rawPos.clone().sub(worldPoseAnchor).multiplyScalar(0.01); // cm → m
    mapped = {
      position: defaultViewPosition().add(delta),
      orientation: defaultViewQuaternion(),
    };
  }

  targetPos.copy(mapped.position);
  updateHeadDebugMarker(mapped.position);

  hasPose = true;
  receivingPose = true;
  poseCount++;
  lastPoseTime = Date.now();
  updateHud();
}

function resetPoseState() {
  hasPose = false;
  poseCount = 0;
  worldPoseAnchor = null;
  lastRawPosCm = null;
  targetPos.copy(defaultViewPosition());
  smoothPos.copy(defaultViewPosition());
}

// ── Calibration ───────────────────────────────────────────────────────────────
function onCalibrationMessage(msg) {
  if (!handleCalibrationMessage(msg, innerScene)) return false;
  lockLocalCm = msg.viewer?.local?.position
    ? { x: msg.viewer.local.position.x, y: msg.viewer.local.position.y, z: msg.viewer.local.position.z }
    : null;
  lastRawPosCm    = null;
  worldPoseAnchor = null;
  return true;
}

function onCalibrationUpdated({ resetPose = true, reapplyPose = null } = {}) {
  const w = getPortalWidth();
  const h = getPortalHeight();

  portalHoleGroup = buildPortalHoleVisual(worldRoot);
  portalHoleGroup.traverse(o => o.layers.set(1));

  innerCamera.aspect = w / Math.max(h, 0.01);
  innerCamera.updateProjectionMatrix();

  repositionModel();
  orbitDebug.onCalibrationUpdated();
  buildBoundsBox();

  if (resetPose) resetPoseState();
  if (reapplyPose) {
    applyPose(reapplyPose);
    smoothPos.copy(targetPos);
  }

  if (debugLogEl) {
    debugLogEl.textContent = calibrationSummary();
    console.info("[viewer] calibration locked", calibrationDiagnostics());
  }
  if (isDebugOverlayVisible()) setDebugOverlayVisible(true, worldRoot, innerScene);
}

// ── Status / HUD refs ─────────────────────────────────────────────────────────
const statusDotEl  = document.getElementById("status-dot");
const statusTextEl = document.getElementById("status-text");
const poseInfoEl   = document.getElementById("pose-info");
const debugLogEl   = document.getElementById("debug-log");
const debugBtn     = document.getElementById("debug-btn");

function updateHud() {
  if (!viewerWsOpen) {
    if (statusDotEl)  statusDotEl.className  = "offline";
    if (statusTextEl) statusTextEl.textContent = "Relay offline";
  } else if (!specsConnected) {
    if (statusDotEl)  statusDotEl.className  = "waiting";
    if (statusTextEl) statusTextEl.textContent = "Waiting for Specs";
  } else if (!receivingPose) {
    if (statusDotEl)  statusDotEl.className  = "waiting";
    if (statusTextEl) statusTextEl.textContent = "Connected";
  } else {
    if (statusDotEl)  statusDotEl.className  = "live";
    if (statusTextEl) statusTextEl.textContent = "Live";
  }

  if (receivingPose && hasPose) {
    const mode = poseSpace === "portal_local" ? "portal-local" : "world";
    let info = "pose #" + poseCount + " · " + mode + " · z=" + targetPos.z.toFixed(2) + "m";
    if (lastLocalCm && lockLocalCm) {
      const dx = (lastLocalCm.x - lockLocalCm.x).toFixed(0);
      const dy = (lastLocalCm.y - lockLocalCm.y).toFixed(0);
      const dz = (lastLocalCm.z - lockLocalCm.z).toFixed(0);
      info += " · Δ " + dx + "," + dy + "," + dz + "cm";
    }
    if (poseInfoEl) poseInfoEl.textContent = info;
  } else if (specsConnected && !isCalibrated()) {
    if (poseInfoEl) poseInfoEl.textContent = "surface-place portal to auto-calibrate";
  } else if (specsConnected) {
    if (poseInfoEl) poseInfoEl.textContent = "calibrated — waiting for pose";
  } else {
    if (poseInfoEl) poseInfoEl.textContent = VIEWER_BUILD + " · arrow keys preview parallax";
  }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
let viewerWs      = null;
let viewerWsOpen  = false;
let reconnectTimer = null;

function setSpecsConnected(connected) {
  specsConnected = connected;
  document.body.classList.toggle("specs-connected", connected);
  if (!connected) { receivingPose = false; resetPoseState(); }
  updateHud();
}

function handleServerSync(msg) {
  if (msg.calibration?.corners?.length === 4) {
    if (onCalibrationMessage(msg.calibration)) {
      const replayPose = msg.pose &&
        (msg.pose.space === "portal_local" || !calibrationDiagnostics().usesPortalLocal)
        ? msg.pose : null;
      onCalibrationUpdated({ resetPose: false, reapplyPose: replayPose });
      return;
    }
  }
  if (msg.pose) {
    applyPose(msg.pose);
    smoothPos.copy(targetPos);
  }
}

function showSpecsDebug(msg) {
  const line = (msg.build || "?") + " · " + (msg.note || "")
    + " · poses=" + (msg.posesSent ?? 0)
    + " · loops=" + (msg.loopTicks ?? 0);
  if (debugLogEl && !hasPose) debugLogEl.textContent = line + (msg.error ? " · ERR: " + msg.error : "");
}

async function fetchServerInfo() {
  try {
    const res  = await fetch("/api/info");
    const info = await res.json();
    // Show WS URL in splash
    const splashUrl = document.getElementById("splash-ws-url");
    if (splashUrl) splashUrl.textContent = info.wsUrl;
    // Pre-fill relay input if user hasn't set a custom one
    const relayInput = document.getElementById("relay-url-input");
    if (relayInput && !relayInput.value.trim()) relayInput.value = info.wsUrl;
    // Copy button
    document.getElementById("splash-copy-btn")?.addEventListener("click", () => {
      navigator.clipboard?.writeText(info.wsUrl).then(() => {
        const btn = document.getElementById("splash-copy-btn");
        btn?.classList.add("copied");
        setTimeout(() => btn?.classList.remove("copied"), 1500);
      });
    });
  } catch (_) {
    const splashUrl = document.getElementById("splash-ws-url");
    if (splashUrl) splashUrl.textContent = "ws://<your-lan-ip>:8765";
  }
}

function getRelayUrl() {
  const input = document.getElementById("relay-url-input");
  const custom = input?.value.trim();
  if (custom) return custom;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return proto + "//" + location.host;
}

function setSpecsHint(url) {
  const hint  = document.getElementById("specs-hint");
  const urlEl = document.getElementById("specs-url");
  if (!hint || !urlEl) return;
  if (url) { urlEl.textContent = url; hint.hidden = false; }
  else { hint.hidden = true; }
}

function connectWebSocket() {
  if (viewerWs && (viewerWs.readyState === WebSocket.OPEN || viewerWs.readyState === WebSocket.CONNECTING)) return;
  const url = getRelayUrl();

  // Populate the input so the user can see what we're connecting to
  const input = document.getElementById("relay-url-input");
  if (input && !input.value.trim()) input.value = url;

  const ws = new WebSocket(url);
  viewerWs = ws;

  ws.onopen = () => {
    viewerWsOpen = true;
    ws.send(JSON.stringify({ type: "hello", role: "viewer" }));
    updateHud();
    if (debugLogEl) debugLogEl.textContent = "relay connected — waiting for Specs…";
    setSpecsHint(url);
    saveSettings();
  };
  ws.onclose = (ev) => {
    viewerWsOpen = false;
    viewerWs = null;
    setSpecsConnected(false);
    setSpecsHint(null);
    if (debugLogEl) debugLogEl.textContent = "relay disconnected (code " + (ev.code || "?") + ") — retrying…";
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWebSocket, 2000);
  };
  ws.onerror = () => {
    if (debugLogEl) debugLogEl.textContent = "WebSocket error — check relay URL, retrying…";
  };
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if      (msg.type === "ack" && msg.role === "viewer") { /* registered */ }
      else if (msg.type === "sync")         handleServerSync(msg);
      else if (msg.type === "specs_status") setSpecsConnected(!!msg.connected);
      else if (msg.type === "pose")         applyPose(msg);
      else if (msg.type === "calibration")  { if (onCalibrationMessage(msg)) onCalibrationUpdated(); }
      else if (msg.type === "debug")        showSpecsDebug(msg);
      else if (msg.type === "ping")         ws.send(JSON.stringify({ type: "pong", role: "viewer" }));
    } catch (err) { console.error("[viewer] bad message", err); }
  };
}

// ── Arrow-key parallax preview ────────────────────────────────────────────────
const manualOffset = new THREE.Vector3();
const ARROW_SPEED  = 0.4; // m/s
const keyState     = { left: false, right: false, up: false, down: false };

// ── Buttons & keyboard ────────────────────────────────────────────────────────
debugBtn?.addEventListener("click", () => {
  setDebugOverlayVisible(!isDebugOverlayVisible(), worldRoot, innerScene);
  debugBtn.classList.toggle("active", isDebugOverlayVisible());
  debugBtn.textContent = isDebugOverlayVisible()
    ? "Hide calibration markers"
    : "Show calibration markers";
  if (debugLogEl) debugLogEl.textContent = isDebugOverlayVisible()
    ? "Markers: TL=red · TR=green · BR=blue · BL=yellow"
    : calibrationSummary();
});

function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen();
  else document.exitFullscreen();
}
document.getElementById("fs-btn")?.addEventListener("click", toggleFullscreen);

// Edit mode = orbit camera + transform gizmo, merged into one toggle
function toggleTestMode() {
  testModeActive = !testModeActive;
  document.body.classList.toggle("edit-mode",  testModeActive);
  document.body.classList.toggle("test-mode",  testModeActive);  // kept for portal-frame CSS
  editOrbit.enabled = testModeActive;

  if (testModeActive) {
    enterEditModeView();                              // always start from portal overview
    if (worldModel) transformCtrl.attach(worldModel);
  } else {
    transformCtrl.detach();
  }

  const editToggle = document.getElementById("edit-toggle");
  editToggle?.classList.toggle("active", testModeActive);
  updateTestPanel();
}

// Overview view when entering edit mode — shows portal frame + viewer indicator + model
function enterEditModeView() {
  const pw   = Math.max(getPortalWidth(),  1.0);
  const ph   = Math.max(getPortalHeight(), 0.8);
  const vd   = defaultViewPosition();          // where the viewer stands (z > 0)
  const fovR = editCamera.fov * Math.PI / 180;
  // Distance needed to fit portal height in frame with 30% padding
  const fitDist = (ph * 0.65) / Math.tan(fovR / 2);
  // Sit slightly above and to the right of the viewer, looking at portal plane
  editCamera.position.set(pw * 0.45, ph * 0.35, vd.z + fitDist * 0.55);
  editCamera.lookAt(0, 0, 0);
  editOrbit.target.set(0, 0, 0);
  editOrbit.update();
}

// Focus the edit camera tightly on the active model
function focusGizmoOnModel() {
  if (!worldModel) return;
  const box = new THREE.Box3().setFromObject(worldModel);
  const center = box.getCenter(new THREE.Vector3());
  const size   = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 0.5);
  const dist   = maxDim * 2.5;
  editCamera.position.set(center.x + maxDim * 0.3, center.y + maxDim * 0.2, center.z + dist);
  editCamera.lookAt(center);
  editOrbit.target.copy(center);
  editOrbit.update();
}

// Focus button
document.getElementById("gizmo-focus-btn")?.addEventListener("click", focusGizmoOnModel);

function resetCurrentModelTransform() {
  const defaults = MODELS[activeModelIdx];
  if (!defaults) return;
  const ov = modelOverrides[activeModelIdx];
  ov.scale   = defaults.scale;
  ov.offsetX = defaults.offsetX;
  ov.offsetY = defaults.offsetY;
  ov.depthCm = defaults.depthCm;
  ov.rotX    = defaults.rotX ?? 0;
  ov.rotY    = defaults.rotY ?? 0;
  ov.rotZ    = defaults.rotZ ?? 0;
  repositionModel();
  updateTestPanel();
  saveSettings();
}
document.getElementById("gizmo-reset-btn")?.addEventListener("click", resetCurrentModelTransform);

document.getElementById("relay-connect-btn")?.addEventListener("click", () => {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (viewerWs) { viewerWs.onclose = null; viewerWs.close(); viewerWs = null; }
  viewerWsOpen = false;
  setSpecsConnected(false);
  setSpecsHint(null);
  connectWebSocket();
});

// Gizmo mode buttons (Move / Rotate / Scale)
document.querySelectorAll(".gizmo-btn[data-mode]").forEach(btn => {
  btn.addEventListener("click", () => {
    transformCtrl.setMode(btn.dataset.mode);
    document.querySelectorAll(".gizmo-btn[data-mode]")
      .forEach(b => b.classList.toggle("active", b === btn));
  });
});

// Preset model buttons
document.querySelectorAll(".preset-btn[data-model]").forEach(btn => {
  btn.addEventListener("click", () => loadModel(+btn.dataset.model));
});

// Edit toggle button
document.getElementById("edit-toggle")?.addEventListener("click", toggleTestMode);

const SCALE_STEP  = 1.15;
const OFFSET_STEP = 0.05; // meters
const DEPTH_STEP  = 20;   // cm

window.addEventListener("keydown", e => {
  const ov = getActiveOverride();

  // Model position / scale adjustments (Shift + key)
  if (e.shiftKey) {
    if (e.key === "ArrowLeft")  { ov.offsetX -= OFFSET_STEP; repositionModel(); updateTestPanel(); saveSettings(); e.preventDefault(); return; }
    if (e.key === "ArrowRight") { ov.offsetX += OFFSET_STEP; repositionModel(); updateTestPanel(); saveSettings(); e.preventDefault(); return; }
    if (e.key === "ArrowUp")    { ov.offsetY += OFFSET_STEP; repositionModel(); updateTestPanel(); saveSettings(); e.preventDefault(); return; }
    if (e.key === "ArrowDown")  { ov.offsetY -= OFFSET_STEP; repositionModel(); updateTestPanel(); saveSettings(); e.preventDefault(); return; }
    if (e.key === "w" || e.key === "W") { ov.depthCm -= DEPTH_STEP; repositionModel(); updateTestPanel(); saveSettings(); e.preventDefault(); return; }
    if (e.key === "s" || e.key === "S") { ov.depthCm += DEPTH_STEP; repositionModel(); updateTestPanel(); saveSettings(); e.preventDefault(); return; }
  }

  // Scale with [ ]
  if (e.key === "[") { ov.scale /= SCALE_STEP; repositionModel(); updateTestPanel(); saveSettings(); return; }
  if (e.key === "]") { ov.scale *= SCALE_STEP; repositionModel(); updateTestPanel(); saveSettings(); return; }

  // Model select 1–4
  if (e.key === "1") { loadModel(0); return; }
  if (e.key === "2") { loadModel(1); return; }

  // Parallax preview (no shift)
  if (e.key === "ArrowLeft")  { keyState.left  = true; e.preventDefault(); }
  if (e.key === "ArrowRight") { keyState.right = true; e.preventDefault(); }
  if (e.key === "ArrowUp")    { keyState.up    = true; e.preventDefault(); }
  if (e.key === "ArrowDown")  { keyState.down  = true; e.preventDefault(); }

  if (e.key === "t" || e.key === "T") toggleTestMode();
  if (e.key === "g" || e.key === "G") {
    transformCtrl.setMode("translate");
    document.querySelectorAll(".gizmo-btn[data-mode]").forEach(b => b.classList.toggle("active", b.dataset.mode === "translate"));
  }
  if (e.key === "r" || e.key === "R") {
    transformCtrl.setMode("rotate");
    document.querySelectorAll(".gizmo-btn[data-mode]").forEach(b => b.classList.toggle("active", b.dataset.mode === "rotate"));
  }
  if (e.key === "d" || e.key === "D") debugBtn?.click();
  if (e.key === "f" || e.key === "F") toggleFullscreen();
});
window.addEventListener("keyup", e => {
  if (e.key === "ArrowLeft")  keyState.left  = false;
  if (e.key === "ArrowRight") keyState.right = false;
  if (e.key === "ArrowUp")    keyState.up    = false;
  if (e.key === "ArrowDown")  keyState.down  = false;
});

// ── Animate ───────────────────────────────────────────────────────────────────
const clock = new THREE.Clock();

// How much of the head movement is applied to the camera.
// 1.0 = full 1:1 physics. 0.0 = static world.
// Lower values anchor the world and reduce the "flying" feel.
const PARALLAX_SCALE_X = 0.8;
const PARALLAX_SCALE_Y = 0.5;
const PARALLAX_SCALE_Z = 0.05; // very small — walking toward/away should barely affect view

// Per-axis movement bounds. X/Y are fractions of portal size; Z is absolute meters.
let boundsX = 0.45;
let boundsY = 0.45;
let boundsZ = 0.20;

function applyParallaxOffset(rawPos) {
  const base = defaultViewPosition();
  const offset = rawPos.clone().sub(base);
  offset.x *= PARALLAX_SCALE_X;
  offset.y *= PARALLAX_SCALE_Y;
  offset.z *= PARALLAX_SCALE_Z;

  const maxX = getPortalWidth()  * boundsX;
  const maxY = getPortalHeight() * boundsY;
  const maxZ = boundsZ;
  offset.x = Math.max(-maxX, Math.min(maxX, offset.x));
  offset.y = Math.max(-maxY, Math.min(maxY, offset.y));
  offset.z = Math.max(-maxZ, Math.min(maxZ, offset.z));

  return base.add(offset);
}

// ── Bounds box visual (visible in edit mode) ──────────────────────────────────
let boundsBoxMesh = null;

function buildBoundsBox() {
  if (boundsBoxMesh) { innerScene.remove(boundsBoxMesh); boundsBoxMesh = null; }
  const w = Math.max(getPortalWidth()  * boundsX * 2, 0.01);
  const h = Math.max(getPortalHeight() * boundsY * 2, 0.01);
  const d = Math.max(boundsZ * 2, 0.01);
  const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d));
  boundsBoxMesh = new THREE.LineSegments(
    edges,
    new THREE.LineBasicMaterial({ color: 0x02a8cb, transparent: true, opacity: 0.7 })
  );
  boundsBoxMesh.position.copy(defaultViewPosition());
  boundsBoxMesh.layers.set(1); // edit-mode only
  innerScene.add(boundsBoxMesh);
}

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();

  if (hasPose && specsConnected) {
    const alpha = 1 - Math.pow(0.08, dt);
    smoothPos.lerp(targetPos, alpha);
    innerCamera.position.copy(applyParallaxOffset(smoothPos));
    manualOffset.set(0, 0, 0);
  } else {
    const speed = ARROW_SPEED * dt;
    if (keyState.left)  manualOffset.x -= speed;
    if (keyState.right) manualOffset.x += speed;
    if (keyState.up)    manualOffset.y += speed;
    if (keyState.down)  manualOffset.y -= speed;
    innerCamera.position.copy(applyParallaxOffset(defaultViewPosition().add(manualOffset)));
  }

  // Camera always points straight in -Z. The off-axis projection skews the
  // frustum to show the correct view through the portal for the current eye
  // position. Rotating the camera via lookAt fights the frustum skew and
  // inverts Y, so we intentionally leave the rotation at identity.

  if (receivingPose && Date.now() - lastPoseTime > 3000) {
    receivingPose = false;
    updateHud();
  }

  // Edit mode: orbit camera + gizmo; show portal frame outline + viewer frustum indicator
  if (testModeActive) {
    viewerHelper.update();   // sync CameraHelper to current innerCamera position
    editOrbit.update();
    renderer.setRenderTarget(null);
    renderer.render(innerScene, editCamera);
    return;
  }

  renderer.setRenderTarget(null);
  applyPortalProjection(innerCamera, innerCamera.position, getPortalWidth(), getPortalHeight());
  renderer.render(innerScene, innerCamera);
  resetPerspectiveProjection(innerCamera);
}

// ── Splash screen ─────────────────────────────────────────────────────────────
function initSplash() {
  const splash = document.getElementById("splash");
  if (!splash) return;
  const dismiss = () => splash.classList.add("hidden");
  document.getElementById("splash-start")?.addEventListener("click", dismiss);
  window.addEventListener("keydown", dismiss, { once: true });
}

// ── Upload handlers ───────────────────────────────────────────────────────────
const PORTAL_FRAME_DEFAULT = "/assets/portal-frame.png";

function initUploadHandlers() {
  // Model file input
  const modelInput = document.getElementById("model-upload");
  modelInput?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) loadUserModel(file);
    e.target.value = "";  // allow re-uploading same file
  });

  // Portal frame file input
  const frameInput = document.getElementById("frame-upload");
  const portalImg  = document.getElementById("portal-frame");
  let prevFrameUrl = null;
  frameInput?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (prevFrameUrl) URL.revokeObjectURL(prevFrameUrl);
    prevFrameUrl = URL.createObjectURL(file);
    portalImg.src = prevFrameUrl;
    e.target.value = "";
  });
  document.getElementById("frame-reset-btn")?.addEventListener("click", () => {
    if (prevFrameUrl) { URL.revokeObjectURL(prevFrameUrl); prevFrameUrl = null; }
    portalImg.src = PORTAL_FRAME_DEFAULT;
  });

  // Sky colour
  document.getElementById("sky-color")?.addEventListener("input", (e) => {
    innerScene.background = new THREE.Color(e.target.value);
    saveSettings();
  });

  // Exposure slider
  const exposureSlider = document.getElementById("exposure-slider");
  const exposureVal    = document.getElementById("exposure-val");
  exposureSlider?.addEventListener("input", () => {
    const v = parseFloat(exposureSlider.value);
    renderer.toneMappingExposure = v;
    if (exposureVal) exposureVal.textContent = v.toFixed(2);
    saveSettings();
  });

  // Movement bounds sliders — X, Y (% of portal), Z (meters)
  function bindBoundsSlider(id, valId, isZ) {
    const sl = document.getElementById(id);
    const vl = document.getElementById(valId);
    if (!sl) return;
    sl.addEventListener("input", () => {
      const v = parseFloat(sl.value);
      if (id === "bounds-x") boundsX = v;
      else if (id === "bounds-y") boundsY = v;
      else boundsZ = v;
      if (vl) vl.textContent = isZ ? v.toFixed(2) + "m" : Math.round(v * 100) + "%";
      buildBoundsBox();
      saveSettings();
    });
  }
  bindBoundsSlider("bounds-x", "bounds-x-val", false);
  bindBoundsSlider("bounds-y", "bounds-y-val", false);
  bindBoundsSlider("bounds-z", "bounds-z-val", true);

  // Drag-and-drop GLB onto canvas
  const dropOverlay = document.getElementById("drop-overlay");
  let dragCounter = 0;
  window.addEventListener("dragenter", (e) => {
    if ([...e.dataTransfer.items].some(i => i.kind === "file")) {
      dragCounter++;
      dropOverlay?.classList.add("visible");
    }
  });
  window.addEventListener("dragleave", () => {
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; dropOverlay?.classList.remove("visible"); }
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropOverlay?.classList.remove("visible");
    const file = [...e.dataTransfer.files].find(f => /\.(glb|gltf)$/i.test(f.name));
    if (file) {
      if (!testModeActive) toggleTestMode();  // auto-enter edit mode on drop
      loadUserModel(file);
    }
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────
bindTransformInputs();
initUploadHandlers();
initSplash();
fetchServerInfo();
const savedModelIdx = loadSettings();
buildBoundsBox();
loadModel(savedModelIdx);
connectWebSocket();
updateHud();
animate();
setTimeout(preloadAll, 2000); // start background preload after first model is up

window.addEventListener("resize", () => {
  const w = window.innerWidth, h = window.innerHeight;
  innerCamera.aspect = w / h;
  innerCamera.updateProjectionMatrix();
  editCamera.aspect = w / h;
  editCamera.updateProjectionMatrix();
  orbitDebug.resize(w, h);
  renderer.setSize(w, h);
});
