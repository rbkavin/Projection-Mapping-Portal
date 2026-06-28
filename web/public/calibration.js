/**
 * Phase B — map Specs world (cm) → web scene (meters).
 *
 * Contract: 1 Lens cm = 0.01 web meters (uniform).
 * Portal hole = quad from 4 corners; content behind; viewer in front (+Z).
 */

import * as THREE from "three";

/** Web viewer build — shown in HUD so you can confirm the browser loaded new code. */
export const VIEWER_BUILD = "phase-c-portal-local";

/** Lens Studio world units are centimeters → Three.js uses meters. */
export const METERS_PER_CM = 0.01;

/** Portal center in web world (meters). Wall plane at z = 0. */
export const PORTAL_ORIGIN = new THREE.Vector3(0, 0, 0);

const _euler = new THREE.Euler();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _lookMat = new THREE.Matrix4();
const _lookEye = new THREE.Vector3();
const _lookTarget = new THREE.Vector3();
const _lookUp = new THREE.Vector3(0, 1, 0);

let calibrated = false;
let lastCalibration = null;
let calibrationOutlineGroup = null;
let transform = null;
let debugOverlayVisible = false;
let debugOverlayGroup = null;
let headDebugMarker = null;

/** Portal size in meters (from locked corners, or defaults before cal). */
let portalWidthM = 1.6;
let portalHeightM = 1.0;
/** Viewer distance from portal at lock (meters). */
let viewDepthM = 2.0;

export function isCalibrated() {
  return calibrated && transform !== null;
}

export function getCalibration() {
  return lastCalibration;
}

export function getTransform() {
  return transform;
}

export function getPortalCenter() {
  return PORTAL_ORIGIN.clone();
}

export function getPortalWidth() {
  return portalWidthM;
}

export function getPortalHeight() {
  return portalHeightM;
}

export function getViewDepthM() {
  return viewDepthM;
}

/** @deprecated use getPortalCenter() */
export const CANONICAL_PORTAL_CENTER = PORTAL_ORIGIN;

function vec3(p) {
  return new THREE.Vector3(p.x, p.y, p.z);
}

function quat(r) {
  return new THREE.Quaternion(r.x, r.y, r.z, r.w);
}

/** Build wall frame from corners; sizes in cm, scales uniformly to meters. */
export function buildTransform(corners, viewer) {
  const byId = {};
  for (const c of corners) {
    byId[c.id] = c.position;
  }

  const tl = vec3(byId.tl);
  const tr = vec3(byId.tr);
  const br = vec3(byId.br);
  const bl = vec3(byId.bl);

  const center = tl.clone().add(tr).add(br).add(bl).multiplyScalar(0.25);

  const topEdge = tr.clone().sub(tl);
  const botEdge = br.clone().sub(bl);
  const specsW = (topEdge.length() + botEdge.length()) * 0.5;

  const leftEdge = tl.clone().sub(bl);
  const rightEdge = tr.clone().sub(br);
  const specsH = (leftEdge.length() + rightEdge.length()) * 0.5;

  const xAxis = topEdge.normalize();
  let yAxis = leftEdge.clone().add(rightEdge).normalize();

  let zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis).normalize();

  if (viewer?.position) {
    const toHead = vec3(viewer.position).sub(center);
    if (toHead.dot(zAxis) < 0) {
      zAxis.negate();
    }
  }

  // Right-handed wall frame: x = right along wall, y = up, z = toward viewer (+web Z)
  yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
  xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis).normalize();

  const basis = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);

  let refDepthCm = 200;
  if (viewer?.position) {
    refDepthCm = Math.abs(vec3(viewer.position).clone().sub(center).dot(zAxis));
  }
  refDepthCm = Math.max(refDepthCm, 0.001);

  portalWidthM = specsW * METERS_PER_CM;
  portalHeightM = specsH * METERS_PER_CM;
  viewDepthM = refDepthCm * METERS_PER_CM;

  transform = {
    center,
    xAxis,
    yAxis,
    zAxis,
    specsW,
    specsH,
    refDepthCm,
    portalWidthM,
    portalHeightM,
    viewDepthM,
    basis,
    qSpecsToCanon: new THREE.Quaternion().setFromRotationMatrix(basis).invert(),
    poseOriginPos: null,
    poseOriginQuat: null,
    lockViewerLocalPosM: null,
    lockViewerLocalQuat: null,
  };

  if (viewer?.local?.position) {
    const lp = vec3(viewer.local.position);
    transform.lockViewerLocalPosM = lp.clone().multiplyScalar(METERS_PER_CM);
    if (viewer.local.rotation) {
      transform.lockViewerLocalQuat = quat(viewer.local.rotation);
    }
    viewDepthM = Math.max(Math.abs(lp.z) * METERS_PER_CM, 0.05);
    transform.viewDepthM = viewDepthM;
    transform.poseOriginPos = defaultViewPosition().clone();
    transform.poseOriginQuat = defaultViewQuaternion().clone();
  } else if (viewer?.position && viewer?.rotation) {
    transform.poseOriginPos = mapSpecsPoint(vec3(viewer.position));
    transform.poseOriginQuat = mapSpecsOrientation(quat(viewer.rotation));

    if (transform.poseOriginPos.z < 0) {
      zAxis.negate();
      yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
      xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis).normalize();
      transform.xAxis = xAxis;
      transform.yAxis = yAxis;
      transform.zAxis = zAxis;
      transform.basis.makeBasis(xAxis, yAxis, zAxis);
      transform.qSpecsToCanon.setFromRotationMatrix(transform.basis).invert();
      transform.poseOriginPos = mapSpecsPoint(vec3(viewer.position));
      transform.poseOriginQuat = mapSpecsOrientation(quat(viewer.rotation));
      console.info("[calibration] flipped wall normal — viewer now z=", transform.poseOriginPos.z);
    }
  }

  return transform;
}

/** Map Specs world position (cm) → web position (m). */
export function mapSpecsPoint(specsPos) {
  if (!transform) return specsPos.clone().multiplyScalar(METERS_PER_CM);

  const rel = specsPos.clone().sub(transform.center);
  const lx = rel.dot(transform.xAxis);
  const ly = rel.dot(transform.yAxis);
  const lz = rel.dot(transform.zAxis);

  return new THREE.Vector3(
    PORTAL_ORIGIN.x + lx * METERS_PER_CM,
    PORTAL_ORIGIN.y + ly * METERS_PER_CM,
    PORTAL_ORIGIN.z + lz * METERS_PER_CM
  );
}

export function mapSpecsOrientation(specsQuat) {
  if (!transform) return specsQuat.clone();

  _q.copy(specsQuat);
  _q2.copy(transform.qSpecsToCanon).multiply(_q);

  _euler.setFromQuaternion(_q2, "YXZ");
  _euler.x = -_euler.x;
  _q.setFromEuler(_euler);

  return _q.clone();
}

export function getLockViewerLocalPosM() {
  return transform?.lockViewerLocalPosM?.clone() ?? null;
}

export function mapPortalLocalPoseToWeb(localPos, localQuat) {
  if (!transform?.lockViewerLocalPosM) {
    return mapSpecsPoseToWeb(localPos, localQuat);
  }

  const lp = vec3(localPos).multiplyScalar(METERS_PER_CM);
  const pos = defaultViewPosition().add(lp.clone().sub(transform.lockViewerLocalPosM));

  let orient = defaultViewQuaternion();
  if (localQuat && transform.lockViewerLocalQuat) {
    const lq = quat(localQuat);
    const delta = transform.lockViewerLocalQuat.clone().invert().multiply(lq);
    _euler.setFromQuaternion(delta, "YXZ");
    _euler.x = -_euler.x;
    _q.setFromEuler(_euler);
    orient = defaultViewQuaternion().multiply(_q);
  }

  return { position: pos, orientation: orient };
}

export function mapSpecsPoseToWeb(specsPos, specsQuat) {
  const mappedPos = mapSpecsPoint(specsPos);
  const mappedQuat = mapSpecsOrientation(specsQuat);

  if (!transform?.poseOriginPos || !transform?.poseOriginQuat) {
    return { position: mappedPos, orientation: mappedQuat };
  }

  const pos = defaultViewPosition().add(
    mappedPos.clone().sub(transform.poseOriginPos)
  );
  const orient = defaultViewQuaternion().multiply(
    transform.poseOriginQuat.clone().invert().multiply(mappedQuat)
  );

  return { position: pos, orientation: orient };
}

export function handleCalibrationMessage(msg, scene) {
  if (!msg.corners || msg.corners.length !== 4) {
    return false;
  }

  if (lastCalibration && calibrationCornersMatch(lastCalibration, msg)) {
    return false;
  }

  lastCalibration = msg;
  buildTransform(msg.corners, msg.viewer);
  calibrated = true;
  updateDebugOutline(scene, msg.corners);
  logCalibrationDiagnostics();
  return true;
}

function calibrationCornersMatch(a, b) {
  if (!a.corners || !b.corners || a.corners.length !== 4) {
    return false;
  }
  const tol = 0.05;
  for (const id of ["tl", "tr", "br", "bl"]) {
    const ca = a.corners.find((c) => c.id === id);
    const cb = b.corners.find((c) => c.id === id);
    if (!ca || !cb) return false;
    const dx = ca.position.x - cb.position.x;
    const dy = ca.position.y - cb.position.y;
    const dz = ca.position.z - cb.position.z;
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) > tol) {
      return false;
    }
  }
  return true;
}

/** Phase 0 — measurement log for Lens cm → web m verification. */
export function calibrationDiagnostics() {
  if (!transform) {
    return {
      calibrated: false,
      metersPerCm: METERS_PER_CM,
    };
  }
  const viewer = lastCalibration?.viewer;
  const mappedViewer = viewer?.position
    ? mapSpecsPoint(vec3(viewer.position))
    : null;

  return {
    calibrated: true,
    metersPerCm: METERS_PER_CM,
    wallWidthCm: transform.specsW,
    wallHeightCm: transform.specsH,
    viewerDistanceCm: transform.refDepthCm,
    portalWidthM: transform.portalWidthM,
    portalHeightM: transform.portalHeightM,
    portalAspect: transform.portalWidthM / Math.max(transform.portalHeightM, 0.001),
    viewDepthM: transform.viewDepthM,
    usesPortalLocal: !!transform.lockViewerLocalPosM,
    cornerSource: "lens_cubes",
    mappedCorners: getMappedCornerPositions()?.map((p) => ({
      x: p.x,
      y: p.y,
      z: p.z,
    })),
    viewerSpecsCm: viewer?.position ?? null,
    viewerWebM: mappedViewer
      ? { x: mappedViewer.x, y: mappedViewer.y, z: mappedViewer.z }
      : null,
    viewerShouldBeInFront: transform?.poseOriginPos ? transform.poseOriginPos.z > 0 : null,
    lockAnchorWebM: transform.poseOriginPos
      ? {
          x: transform.poseOriginPos.x,
          y: transform.poseOriginPos.y,
          z: transform.poseOriginPos.z,
        }
      : null,
  };
}

export function calibrationSummary() {
  const d = calibrationDiagnostics();
  if (!d.calibrated) return "not calibrated";
  return (
    "cm→m · wall " +
    d.wallWidthCm.toFixed(0) +
    "×" +
    d.wallHeightCm.toFixed(0) +
    " cm → " +
    d.portalWidthM.toFixed(2) +
    "×" +
    d.portalHeightM.toFixed(2) +
    " m · aspect " +
    d.portalAspect.toFixed(2) +
    (d.usesPortalLocal ? " · portal-local" : " · world") +
    " · eye " +
    d.viewerDistanceCm.toFixed(0) +
    " cm → " +
    d.viewDepthM.toFixed(2) +
    " m"
  );
}

function logCalibrationDiagnostics() {
  const d = calibrationDiagnostics();
  console.info("[calibration] Phase 0 diagnostics", d);
}

export function getMappedCornerPositions() {
  if (!lastCalibration?.corners) return null;
  const order = ["tl", "tr", "br", "bl"];
  const pts = [];
  for (const id of order) {
    const corner = lastCalibration.corners.find((c) => c.id === id);
    if (!corner) return null;
    pts.push(mapSpecsPoint(vec3(corner.position)));
  }
  return pts;
}

function portalCornersWeb() {
  const mapped = getMappedCornerPositions();
  if (mapped) return mapped;
  const hw = portalWidthM / 2;
  const hh = portalHeightM / 2;
  const c = PORTAL_ORIGIN;
  return [
    new THREE.Vector3(c.x - hw, c.y + hh, c.z),
    new THREE.Vector3(c.x + hw, c.y + hh, c.z),
    new THREE.Vector3(c.x + hw, c.y - hh, c.z),
    new THREE.Vector3(c.x - hw, c.y - hh, c.z),
  ];
}

function updateDebugOutline(scene) {
  if (!scene) return;

  if (calibrationOutlineGroup) {
    scene.remove(calibrationOutlineGroup);
    calibrationOutlineGroup.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }

  calibrationOutlineGroup = new THREE.Group();
  calibrationOutlineGroup.name = "calibration-debug";

  const canonPts = portalCornersWeb();
  const lineMat = new THREE.LineBasicMaterial({ color: 0x44ff88 });
  const lineGeo = new THREE.BufferGeometry().setFromPoints([...canonPts, canonPts[0]]);
  calibrationOutlineGroup.add(new THREE.Line(lineGeo, lineMat));

  const marker = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 0.1, 0.1),
    new THREE.MeshBasicMaterial({ color: 0x44ff88, wireframe: true })
  );
  marker.position.copy(PORTAL_ORIGIN);
  calibrationOutlineGroup.add(marker);

  scene.add(calibrationOutlineGroup);
}

export function defaultViewPosition() {
  return PORTAL_ORIGIN.clone().add(new THREE.Vector3(0, 0, viewDepthM));
}

export function defaultViewQuaternion() {
  _lookEye.copy(defaultViewPosition());
  _lookTarget.copy(PORTAL_ORIGIN);
  _lookMat.lookAt(_lookEye, _lookTarget, _lookUp);
  return new THREE.Quaternion().setFromRotationMatrix(_lookMat);
}

/** Depth behind portal: positive specsDepthCm → negative web Z. */
export function specsDepthToWebZ(specsDepthCm) {
  return -specsDepthCm * METERS_PER_CM;
}

const CORNER_COLORS = { tl: 0xff4444, tr: 0x44ff44, br: 0x4488ff, bl: 0xffcc44 };
const CORNER_IDS = ["tl", "tr", "br", "bl"];

export function setDebugOverlayVisible(visible, worldRoot, innerScene) {
  debugOverlayVisible = visible;
  if (debugOverlayGroup) {
    (worldRoot || innerScene).remove(debugOverlayGroup);
    debugOverlayGroup.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    debugOverlayGroup = null;
  }
  if (headDebugMarker && innerScene) {
    innerScene.remove(headDebugMarker);
    headDebugMarker.geometry.dispose();
    headDebugMarker.material.dispose();
    headDebugMarker = null;
  }
  if (!visible) return;

  debugOverlayGroup = new THREE.Group();
  debugOverlayGroup.name = "calibration-debug-overlay";

  const canonPts = portalCornersWeb();
  const lineMat = new THREE.LineBasicMaterial({ color: 0x44ff88, linewidth: 2 });
  const outline = new THREE.BufferGeometry().setFromPoints([...canonPts, canonPts[0]]);
  debugOverlayGroup.add(new THREE.Line(outline, lineMat));

  CORNER_IDS.forEach((id, i) => {
    const pos = canonPts[i];
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.08, 0.08),
      new THREE.MeshBasicMaterial({ color: CORNER_COLORS[id] })
    );
    m.position.copy(pos);
    m.name = "corner-" + id;
    debugOverlayGroup.add(m);
  });

  const centerMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  );
  centerMarker.position.copy(PORTAL_ORIGIN);
  debugOverlayGroup.add(centerMarker);

  [50, 100, 200].forEach((depthCm, i) => {
    const planeMarker = new THREE.Mesh(
      new THREE.PlaneGeometry(portalWidthM, portalHeightM),
      new THREE.MeshBasicMaterial({
        color: 0x88ffcc,
        transparent: true,
        opacity: 0.06 + i * 0.04,
        side: THREE.DoubleSide,
      })
    );
    planeMarker.position.set(PORTAL_ORIGIN.x, PORTAL_ORIGIN.y, specsDepthToWebZ(depthCm));
    debugOverlayGroup.add(planeMarker);
  });

  (worldRoot || innerScene).add(debugOverlayGroup);

  headDebugMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.1, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 })
  );
  headDebugMarker.name = "head-debug";
  innerScene.add(headDebugMarker);
}

export function isDebugOverlayVisible() {
  return debugOverlayVisible;
}

export function updateHeadDebugMarker(worldPos) {
  if (!debugOverlayVisible || !headDebugMarker || !worldPos) return;
  headDebugMarker.position.copy(worldPos);
  headDebugMarker.visible = true;
}
