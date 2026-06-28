/**
 * Off-axis projection — camera sees exactly through the portal quad (your 4 corner cubes).
 */

import * as THREE from "three";

function setObliqueProjection(camera, left, right, bottom, top, near, far) {
  const x = (2 * near) / (right - left);
  const y = (2 * near) / (top - bottom);
  const a = (right + left) / (right - left);
  const b = (top + bottom) / (top - bottom);
  const c = -(far + near) / (far - near);
  const d = (-2 * far * near) / (far - near);

  camera.projectionMatrix.set(x, 0, a, 0, 0, y, b, 0, 0, 0, c, d, 0, 0, -1, 0);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

/** Portal wall at z = 0; eye in +Z. Frustum passes through portal width × height. */
export function applyPortalProjection(camera, eye, portalW, portalH) {
  const near = camera.near;
  const far = camera.far;
  const rd = Math.max(eye.z, near + 0.05);
  const hw = portalW / 2;
  const hh = portalH / 2;

  const left = (-hw - eye.x) * (near / rd);
  const right = (hw - eye.x) * (near / rd);
  const bottom = (-hh - eye.y) * (near / rd);
  const top = (hh - eye.y) * (near / rd);

  setObliqueProjection(camera, left, right, bottom, top, near, far);
}

export function resetPerspectiveProjection(camera) {
  camera.updateProjectionMatrix();
}
