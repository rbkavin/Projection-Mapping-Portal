/**
 * Orbit debug — fly around the inner scene to inspect portal plane, camera, and content.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  getPortalCenter,
  getPortalWidth,
  getPortalHeight,
  getMappedCornerPositions,
} from "./calibration.js";

const CORNER_COLORS = { tl: 0xff4444, tr: 0x44ff44, br: 0x4488ff, bl: 0xffcc44 };
const CORNER_IDS = ["tl", "tr", "br", "bl"];

export function createOrbitDebug({ canvas, innerScene, innerCamera, worldRoot }) {
  let active = false;

  const orbitCamera = new THREE.PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    0.05,
    400
  );

  const controls = new OrbitControls(orbitCamera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enabled = false;

  function aimOrbitCamera() {
    const c = getPortalCenter();
    orbitCamera.position.set(c.x + 3.5, c.y + 1.2, c.z + 6);
    controls.target.copy(c);
  }
  aimOrbitCamera();

  const gizmoRoot = new THREE.Group();
  gizmoRoot.name = "orbit-gizmos";
  innerScene.add(gizmoRoot);

  const cameraHelper = new THREE.CameraHelper(innerCamera);
  cameraHelper.visible = false;
  gizmoRoot.add(cameraHelper);

  const viewerMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.14, 20, 14),
    new THREE.MeshBasicMaterial({ color: 0xffaa22 })
  );
  viewerMarker.visible = false;
  gizmoRoot.add(viewerMarker);

  const viewArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(),
    0.9,
    0xffcc44,
    0.2,
    0.12
  );
  viewArrow.visible = false;
  gizmoRoot.add(viewArrow);

  const panoShell = new THREE.Mesh(
    new THREE.SphereGeometry(40, 36, 20),
    new THREE.MeshBasicMaterial({
      color: 0x6688aa,
      wireframe: true,
      transparent: true,
      opacity: 0.12,
    })
  );
  panoShell.visible = false;
  worldRoot.add(panoShell);

  const grid = new THREE.GridHelper(24, 24, 0x444466, 0x222233);
  grid.visible = false;
  innerScene.add(grid);

  const axes = new THREE.AxesHelper(1.5);
  axes.visible = false;
  innerScene.add(axes);

  function syncPortalAnchors() {
    const c = getPortalCenter();
    panoShell.position.copy(c);
    grid.position.set(c.x, c.y - 2, c.z);
    axes.position.copy(c);
  }
  syncPortalAnchors();

  function setGizmosVisible(on) {
    cameraHelper.visible = on;
    viewerMarker.visible = on;
    viewArrow.visible = on;
    panoShell.visible = on;
    grid.visible = on;
    axes.visible = on;
  }

  function syncGizmos() {
    cameraHelper.update();
    viewerMarker.position.copy(innerCamera.position);
    const lookDir = new THREE.Vector3(0, 0, -1).applyQuaternion(innerCamera.quaternion).normalize();
    viewArrow.position.copy(innerCamera.position);
    viewArrow.setDirection(lookDir);
  }

  return {
    isActive() {
      return active;
    },

    setActive(on) {
      active = on;
      controls.enabled = on;
      setGizmosVisible(on);
      if (on) {
        aimOrbitCamera();
        syncPortalAnchors();
        syncGizmos();
      }
    },

    toggle() {
      this.setActive(!active);
      return active;
    },

    onCalibrationUpdated() {
      aimOrbitCamera();
      syncPortalAnchors();
    },

    update() {
      if (!active) return;
      controls.update();
      syncGizmos();
    },

    render(renderer) {
      // Don't overwrite the user's sky colour — use whatever innerScene.background is set to
      renderer.setRenderTarget(null);
      renderer.render(innerScene, orbitCamera);
    },

    resize(w, h) {
      orbitCamera.aspect = w / h;
      orbitCamera.updateProjectionMatrix();
    },
  };
}

function disposeGroup(group) {
  if (!group) return;
  group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
  group.parent?.remove(group);
}

function addEdgeBar(group, a, b, color, thickness) {
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const len = a.distanceTo(b);
  if (len < 0.001) return;

  const dir = b.clone().sub(a).normalize();
  const up = Math.abs(dir.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);

  const bar = new THREE.Mesh(
    new THREE.BoxGeometry(thickness, len, thickness),
    new THREE.MeshBasicMaterial({ color })
  );
  bar.position.copy(mid);
  bar.quaternion.copy(quat);
  group.add(bar);
}

/**
 * Portal window = exact quad from your 4 Lens corner cubes.
 * Colored posts at corners + bright frame rails along each edge.
 */
export function buildPortalHoleVisual(worldRoot) {
  const existing = worldRoot.getObjectByName("portal-hole");
  if (existing) {
    disposeGroup(existing);
  }

  const group = new THREE.Group();
  group.name = "portal-hole";

  const mapped = getMappedCornerPositions();
  const w = getPortalWidth();
  const h = getPortalHeight();
  const c = getPortalCenter();

  let worldCorners;
  if (mapped && mapped.length === 4) {
    worldCorners = mapped;
  } else {
    const hw = w / 2;
    const hh = h / 2;
    worldCorners = [
      new THREE.Vector3(c.x - hw, c.y + hh, c.z),
      new THREE.Vector3(c.x + hw, c.y + hh, c.z),
      new THREE.Vector3(c.x + hw, c.y - hh, c.z),
      new THREE.Vector3(c.x - hw, c.y - hh, c.z),
    ];
  }

  // Corner posts = where your Lens cubes land on the web portal
  CORNER_IDS.forEach((id, i) => {
    const post = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.12, 0.12),
      new THREE.MeshBasicMaterial({ color: CORNER_COLORS[id] })
    );
    post.position.copy(worldCorners[i]);
    post.name = "portal-corner-" + id;
    group.add(post);
  });

  // Frame rails along each edge (the hole boundary)
  const edgeColors = [0x66ffaa, 0x66ffaa, 0x66ffaa, 0x66ffaa];
  for (let i = 0; i < 4; i++) {
    addEdgeBar(group, worldCorners[i], worldCorners[(i + 1) % 4], edgeColors[i], 0.04);
  }

  const outlineMat = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 2 });
  const outlineGeo = new THREE.BufferGeometry().setFromPoints([...worldCorners, worldCorners[0]]);
  group.add(new THREE.Line(outlineGeo, outlineMat));

  worldRoot.add(group);
  return group;
}
