/**
 * Projection mapping — WebSocket, calibrate/show modes, 4-corner lock, head pose.
 * Corners are now placed dynamically via placeCorner() from OnboardingController.
 */

enum ProjectionMode {
  Calibrate = "calibrate",
  Show = "show",
}

@component
export class ProjectionMappingController extends BaseScriptComponent {
  @input
  internetModule: InternetModule;

  @input
  cameraObject: SceneObject;

  @input
  @hint("Visual marker for top-left corner — positioned at runtime via pinch")
  cornerTL: SceneObject;

  @input
  @hint("Visual marker for top-right corner — positioned at runtime via pinch")
  cornerTR: SceneObject;

  @input
  @hint("Visual marker for bottom-right corner — positioned at runtime via pinch")
  cornerBR: SceneObject;

  @input
  @hint("Visual marker for bottom-left corner — positioned at runtime via pinch")
  cornerBL: SceneObject;

  @input
  @hint("Preview: ws://127.0.0.1:8765 | Device: ws://<mac-ip>:8765")
  serverUrl: string = "ws://127.0.0.1:8765";

  @input
  @hint("If true, only runs on real Specs (not Lens Studio preview)")
  deviceOnly: boolean = false;

  @input
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Calibrate (move corners)", "calibrate"),
      new ComboBoxItem("Show (hide corners, stream)", "show"),
    ])
  )
  mode: string = "calibrate";

  @input
  sendRateHz: number = 30;

  @input
  reconnectDelaySec: number = 2;

  @input
  enableLogging: boolean = true;

  @input
  @hint("Show mode only: reveal corners + green quad outline to verify alignment")
  debugShowCalibration: boolean = false;

  // ── Public callbacks wired by OnboardingController ────────────────────────
  public onConnectedCallback: (() => void) | null = null;
  public onDisconnectedCallback: (() => void) | null = null;

  // ── Public getters ────────────────────────────────────────────────────────
  public get socketOpen(): boolean {
    return !!this.socket && this.socket.readyState === 1;
  }

  public get placedCount(): number {
    return this.rawCornerPositions.length;
  }

  public get cornerCenter(): vec3 | null {
    if (this.rawCornerPositions.length < 4) return null;
    const sum = this.rawCornerPositions.reduce(
      (acc, p) => acc.add(p),
      new vec3(0, 0, 0)
    );
    return sum.uniformScale(1 / this.rawCornerPositions.length);
  }

  public get wallNormalPublic(): vec3 | null {
    return this.wallNormal;
  }

  /** Width and height of the pinched rectangle in wall-plane space. */
  public get cornerSpan(): { width: number; height: number } | null {
    if (this.rawCornerPositions.length < 4 || !this.wallNormal) return null;
    const wallNorm = this.wallNormal;
    let wallRight = wallNorm.cross(vec3.up());
    if (wallRight.dot(wallRight) < 0.0001) wallRight = wallNorm.cross(vec3.forward());
    wallRight = wallRight.normalize();
    const wallUp = wallRight.cross(wallNorm).normalize();
    const us = this.rawCornerPositions.map(p => p.dot(wallRight));
    const vs = this.rawCornerPositions.map(p => p.dot(wallUp));
    return {
      width:  Math.max(...us) - Math.min(...us),
      height: Math.max(...vs) - Math.min(...vs),
    };
  }

  // ── Private state ─────────────────────────────────────────────────────────
  private static readonly BUILD = "phase-c-portal-local";

  private socket: WebSocket;
  private posesSent = 0;
  private loopTicks = 0;
  private calibrationSent = false;
  private lastMode: string = "";
  private reconnectEvent: DelayedCallbackEvent;
  private poseLoopEvent: DelayedCallbackEvent;
  private debugLoopEvent: DelayedCallbackEvent;
  private isDestroyed = false;
  private lastError = "";

  private cornerObjects: SceneObject[] = [];
  private lockedCornerPositions: vec3[] | null = null;
  private wallFrame: {
    center: vec3;
    xAxis: vec3;
    yAxis: vec3;
    zAxis: vec3;
    wallToWorld: quat;
  } | null = null;
  private isConnecting = false;
  private socketGeneration = 0;
  private lastLockViewerLocal: { pos: vec3; rot: quat } | null = null;
  private debugRoot: SceneObject | null = null;
  private debugEdges: SceneObject[] = [];
  private debugQuadPlane: SceneObject | null = null;
  private debugLineThickness = 0.015;
  private lastDebugShow = false;

  // Pinch-placed corner data (raw, before auto-sort)
  private rawCornerPositions: vec3[] = [];
  private wallNormal: vec3 | null = null;

  // ── Public API for OnboardingController ───────────────────────────────────

  /** Place one corner at a world position from a pinch hit. Returns new placedCount. */
  public placeCorner(worldPos: vec3, hitNormal: vec3): number {
    if (this.rawCornerPositions.length >= 4) return 4;
    const idx = this.rawCornerPositions.length;
    this.rawCornerPositions.push(worldPos);
    if (idx === 0) {
      this.wallNormal = hitNormal.normalize();
    }
    const marker = this.cornerObjects[idx];
    if (marker) {
      marker.getTransform().setWorldPosition(worldPos);
      marker.enabled = true;
    }
    return this.rawCornerPositions.length;
  }

  /** Remove the last placed corner. Returns new placedCount. */
  public undoCorner(): number {
    if (this.rawCornerPositions.length === 0) return 0;
    const idx = this.rawCornerPositions.length - 1;
    this.rawCornerPositions.pop();
    const marker = this.cornerObjects[idx];
    if (marker) marker.enabled = false;
    if (this.rawCornerPositions.length === 0) this.wallNormal = null;
    return this.rawCornerPositions.length;
  }

  /**
   * Sort the 4 raw pinch positions into TL/TR/BR/BL using the wall plane,
   * then lock the calibration and enter Show mode.
   */
  public autoSortAndLock(): void {
    if (this.rawCornerPositions.length < 4 || !this.wallNormal) return;

    // Derive wall-plane axes from the stored wall normal
    const wallNorm  = this.wallNormal;
    let wallRight   = wallNorm.cross(vec3.up());
    // Fallback for near-horizontal normals (shouldn't happen for walls)
    if (wallRight.dot(wallRight) < 0.0001) {
      wallRight = wallNorm.cross(vec3.forward());
    }
    wallRight = wallRight.normalize();
    const wallUp = wallRight.cross(wallNorm).normalize();

    // Project each point onto wall-space (u = horizontal, v = vertical)
    const pts = this.rawCornerPositions.map((p) => ({
      pos: p,
      u: p.dot(wallRight),
      v: p.dot(wallUp),
    }));

    // Sort by v descending → top 2 have higher v, bottom 2 have lower v
    pts.sort((a, b) => b.v - a.v);
    const topRow = [pts[0], pts[1]].sort((a, b) => a.u - b.u); // [TL, TR]
    const botRow = [pts[2], pts[3]].sort((a, b) => a.u - b.u); // [BL, BR]

    this.cornerTL.getTransform().setWorldPosition(topRow[0].pos);
    this.cornerTR.getTransform().setWorldPosition(topRow[1].pos);
    this.cornerBR.getTransform().setWorldPosition(botRow[1].pos);
    this.cornerBL.getTransform().setWorldPosition(botRow[0].pos);

    // Lock directly (don't rely on mode-change detection — mode may already be "show")
    this.calibrationSent = false;
    this.lockedCornerPositions = null;
    this.wallFrame = null;
    this.lockCalibration();
    this.mode = "show";
    this.lastMode = "show";
    this.applyModeVisuals();
    this.startPoseLoop();
  }

  /** Reset all corners and re-enter Calibrate mode. */
  public clearCorners(): void {
    this.rawCornerPositions = [];
    this.wallNormal = null;
    this.calibrationSent = false;
    this.lockedCornerPositions = null;
    this.wallFrame = null;
    for (const c of this.cornerObjects) {
      if (c) c.enabled = false;
    }
    this.mode = "calibrate";
  }

  // ── Legacy methods (kept for editor ComboBox / direct invocation) ─────────
  setModeCalibrate(): void { this.mode = "calibrate"; }
  setModeShow(): void      { this.mode = "show"; }

  onPortalPlaced(): void {
    this.calibrationSent = false;
    this.lockedCornerPositions = null;
    this.wallFrame = null;
    this.lockCalibration();
    this.mode = ProjectionMode.Show;
    this.lastMode = ProjectionMode.Show;
    this.applyModeVisuals();
    this.startPoseLoop();
    this.report("onPortalPlaced — calibration locked, streaming portal_local");
  }

  onPlacementReset(): void {
    this.calibrationSent = false;
    this.lockedCornerPositions = null;
    this.wallFrame = null;
    this.rawCornerPositions = [];
    this.wallNormal = null;
    this.mode = ProjectionMode.Calibrate;
    this.lastMode = ProjectionMode.Calibrate;
    this.applyModeVisuals();
    this.report("onPlacementReset — waiting for new surface placement");
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  onAwake(): void {
    this.reconnectEvent = this.createEvent("DelayedCallbackEvent");
    this.reconnectEvent.bind(() => this.connect());
    this.poseLoopEvent = this.createEvent("DelayedCallbackEvent");
    this.poseLoopEvent.bind(() => this.onPoseLoop());
    this.debugLoopEvent = this.createEvent("DelayedCallbackEvent");
    this.debugLoopEvent.bind(() => this.onDebugLoop());
    this.createEvent("UpdateEvent").bind(() => this.onUpdate());
    this.createEvent("OnStartEvent").bind(() => this.onStart());

    this.cornerObjects = [this.cornerTL, this.cornerTR, this.cornerBR, this.cornerBL];

    if (!this.internetModule) { this.reportError("ERROR: assign Internet Module"); return; }
    if (!this.cameraObject)   { this.reportError("ERROR: assign Camera Object");   return; }
    if (!this.validateCorners()) return;
    if (this.deviceOnly && global.deviceInfoSystem.isEditor()) {
      this.reportError("Preview blocked (deviceOnly=true). Set deviceOnly=false to test in editor.");
      return;
    }

    this.report("Awake " + ProjectionMappingController.BUILD + " mode=" + this.mode + " url=" + this.serverUrl);
    this.setupDebugOverlay();
    this.applyModeVisuals();
    this.lastMode = this.mode;
    this.lastDebugShow = this.debugShowCalibration;
  }

  private onStart(): void {
    if (this.socket && this.socket.readyState === 1) {
      this.report("OnStart — already connected");
      return;
    }
    this.report("OnStart — connecting");
    this.connect();
  }

  onDestroy(): void {
    this.isDestroyed = true;
    this.closeSocket();
  }

  // ── Validation ────────────────────────────────────────────────────────────
  private validateCorners(): boolean {
    const names   = ["cornerTL", "cornerTR", "cornerBR", "cornerBL"];
    const corners = [this.cornerTL, this.cornerTR, this.cornerBR, this.cornerBL];
    for (let i = 0; i < corners.length; i++) {
      if (!corners[i]) { this.reportError("ERROR: assign " + names[i]); return false; }
    }
    return true;
  }

  // ── Update loop ───────────────────────────────────────────────────────────
  private onUpdate(): void {
    if (this.mode !== this.lastMode) {
      this.onModeChanged(this.lastMode, this.mode);
      this.lastMode = this.mode;
    }
    if (this.debugShowCalibration !== this.lastDebugShow) {
      this.lastDebugShow = this.debugShowCalibration;
      this.applyModeVisuals();
      this.pushDebug("debug overlay " + (this.debugShowCalibration ? "on" : "off"));
    }
    this.updateDebugOverlay();
  }

  private shouldStreamPose(): boolean { return true; }

  private onModeChanged(_from: string, to: string): void {
    this.report("Mode → " + to);
    if (to === ProjectionMode.Show) {
      this.lockCalibration();
      this.applyModeVisuals();
      this.startPoseLoop();
    } else {
      this.calibrationSent = false;
      this.lockedCornerPositions = null;
      this.wallFrame = null;
      this.applyModeVisuals();
      if (!this.shouldStreamPose()) {
        this.stopPoseLoop();
      } else {
        this.startPoseLoop();
      }
    }
  }

  /**
   * Calibrate mode: only show corners that have been placed (placedCount).
   * Show mode: hide all corners unless debug overlay is on.
   */
  private applyModeVisuals(): void {
    if (this.mode === ProjectionMode.Calibrate) {
      const placed = this.rawCornerPositions.length;
      for (let i = 0; i < this.cornerObjects.length; i++) {
        if (this.cornerObjects[i]) {
          this.cornerObjects[i].enabled = i < placed;
        }
      }
      if (this.debugRoot) this.debugRoot.enabled = false;
    } else {
      const showDebug = this.debugShowCalibration;
      for (const corner of this.cornerObjects) {
        if (corner) corner.enabled = showDebug;
      }
      if (this.debugRoot) this.debugRoot.enabled = showDebug;
    }
  }

  // ── Calibration lock ──────────────────────────────────────────────────────
  private lockCalibration(): void {
    if (this.calibrationSent) return;
    const corners = this.collectCorners();
    const camT = this.cameraObject.getTransform();
    const cp = camT.getWorldPosition();
    const cr = camT.getWorldRotation();

    const tl = this.cornerTL.getTransform().getWorldPosition();
    const tr = this.cornerTR.getTransform().getWorldPosition();
    const br = this.cornerBR.getTransform().getWorldPosition();
    const bl = this.cornerBL.getTransform().getWorldPosition();
    this.buildWallFrame(tl, tr, br, bl, cp);

    const localPos = this.worldToLocal(cp);
    const localRot = this.worldQuatToLocal(cr);
    this.lastLockViewerLocal = { pos: localPos, rot: localRot };

    const ok = this.sendJson({
      type: "calibration",
      t: Date.now(),
      locked: true,
      build: ProjectionMappingController.BUILD,
      corners: corners,
      viewer: {
        position: { x: cp.x, y: cp.y, z: cp.z },
        rotation: { x: cr.x, y: cr.y, z: cr.z, w: cr.w },
        local: {
          position: { x: localPos.x, y: localPos.y, z: localPos.z },
          rotation: { x: localRot.x, y: localRot.y, z: localRot.z, w: localRot.w },
        },
      },
    });
    if (ok) {
      this.calibrationSent = true;
      this.storeLockedCorners();
      const center = new vec3(
        (tl.x + tr.x + bl.x + br.x) * 0.25,
        (tl.y + tr.y + bl.y + br.y) * 0.25,
        (tl.z + tr.z + bl.z + br.z) * 0.25
      );
      const wCm = tl.distance(tr);
      const hCm = tl.distance(bl);
      const distCm = cp.distance(center);
      this.report(
        "Calibration LOCKED wall " + wCm.toFixed(0) + "x" + hCm.toFixed(0) +
        " cm · eye " + distCm.toFixed(0) + " cm from center"
      );
      this.pushDebug("calibration locked");
    }
  }

  private storeLockedCorners(): void {
    this.lockedCornerPositions = [];
    for (const obj of [this.cornerTL, this.cornerTR, this.cornerBR, this.cornerBL]) {
      this.lockedCornerPositions.push(obj.getTransform().getWorldPosition());
    }
  }

  private buildWallFrame(tl: vec3, tr: vec3, br: vec3, bl: vec3, viewerPos: vec3): void {
    const center   = tl.add(tr).add(br).add(bl).uniformScale(0.25);
    const topEdge  = tr.sub(tl);
    const leftEdge = tl.sub(bl);
    const rightEdge = tr.sub(br);

    let xAxis = topEdge.normalize();
    let yAxis = leftEdge.add(rightEdge).normalize();
    let zAxis = xAxis.cross(yAxis).normalize();

    const toHead = viewerPos.sub(center);
    if (toHead.dot(zAxis) < 0) zAxis = zAxis.uniformScale(-1);

    yAxis = zAxis.cross(xAxis).normalize();
    xAxis = yAxis.cross(zAxis).normalize();

    const basis = new mat3();
    basis.column0 = xAxis;
    basis.column1 = yAxis;
    basis.column2 = zAxis;
    const wallToWorld = quat.fromRotationMat(basis);

    this.wallFrame = { center, xAxis, yAxis, zAxis, wallToWorld };
  }

  private worldToLocal(p: vec3): vec3 {
    if (!this.wallFrame) return p;
    const rel = p.sub(this.wallFrame.center);
    return new vec3(
      rel.dot(this.wallFrame.xAxis),
      rel.dot(this.wallFrame.yAxis),
      rel.dot(this.wallFrame.zAxis)
    );
  }

  private worldQuatToLocal(q: quat): quat {
    if (!this.wallFrame) return q;
    const basis = new mat3();
    basis.column0 = this.wallFrame.xAxis;
    basis.column1 = this.wallFrame.yAxis;
    basis.column2 = this.wallFrame.zAxis;
    const worldToWall = quat.fromRotationMat(basis).invert();
    return worldToWall.multiply(q);
  }

  // ── Debug overlay ─────────────────────────────────────────────────────────
  private getDebugCornerPositions(): vec3[] {
    if (this.mode === ProjectionMode.Show && this.lockedCornerPositions) {
      return this.lockedCornerPositions;
    }
    return [
      this.cornerTL.getTransform().getWorldPosition(),
      this.cornerTR.getTransform().getWorldPosition(),
      this.cornerBR.getTransform().getWorldPosition(),
      this.cornerBL.getTransform().getWorldPosition(),
    ];
  }

  private setupDebugOverlay(): void {
    const ref = this.cornerTL.getComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    if (!ref || !ref.mesh) {
      this.reportError("Debug overlay: cornerTL needs RenderMeshVisual + mesh");
      return;
    }

    this.debugRoot = global.scene.createSceneObject("CalibrationDebugOverlay");
    this.debugRoot.setParent(this.sceneObject);
    this.debugRoot.enabled = false;

    for (let i = 0; i < 4; i++) {
      const edge = global.scene.createSceneObject("CalibEdge" + i);
      edge.setParent(this.debugRoot);
      const rmv = edge.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
      rmv.mesh = ref.mesh;
      rmv.mainMaterial = ref.mainMaterial.clone();
      const pass = rmv.mainMaterial.mainPass;
      if (pass.baseColor) pass.baseColor = new vec4(0.2, 1.0, 0.45, 1.0);
      this.debugEdges.push(edge);
    }

    this.debugQuadPlane = global.scene.createSceneObject("CalibQuadFill");
    this.debugQuadPlane.setParent(this.debugRoot);
    const planeRmv = this.debugQuadPlane.createComponent("Component.RenderMeshVisual") as RenderMeshVisual;
    planeRmv.mesh = ref.mesh;
    const planeMat = ref.mainMaterial.clone();
    planeRmv.mainMaterial = planeMat;
    const planePass = planeMat.mainPass;
    if (planePass.baseColor) planePass.baseColor = new vec4(0.2, 1.0, 0.45, 0.18);
  }

  private drawDebugEdge(start: vec3, end: vec3, edgeObj: SceneObject): void {
    const mid = start.add(end).uniformScale(0.5);
    const len = start.distance(end);
    if (len < 0.001) { edgeObj.enabled = false; return; }
    edgeObj.enabled = true;
    const dir = end.sub(start).normalize();
    const up  = Math.abs(dir.dot(vec3.up())) > 0.999 ? vec3.right() : vec3.up();
    const t = edgeObj.getTransform();
    t.setWorldPosition(mid);
    t.setWorldRotation(quat.lookAt(dir, up));
    t.setLocalScale(new vec3(this.debugLineThickness, this.debugLineThickness, len));
  }

  private updateDebugQuadPlane(corners: vec3[]): void {
    if (!this.debugQuadPlane) return;
    const tl = corners[0];
    const tr = corners[1];
    const bl = corners[3];
    const center = tl.add(tr).add(corners[2]).add(bl).uniformScale(0.25);
    const width   = tr.distance(tl);
    const height  = tl.distance(bl);
    const xAxis   = tr.sub(tl).normalize();
    const yAxis   = bl.sub(tl).normalize();
    let zAxis     = xAxis.cross(yAxis).normalize();
    if (zAxis.length < 0.001) { this.debugQuadPlane.enabled = false; return; }
    this.debugQuadPlane.enabled = true;
    const basis = new mat3();
    basis.column0 = xAxis;
    basis.column1 = yAxis;
    basis.column2 = zAxis;
    const t = this.debugQuadPlane.getTransform();
    t.setWorldPosition(center);
    t.setWorldRotation(quat.fromRotationMat(basis));
    t.setLocalScale(new vec3(width, height, 0.002));
  }

  private updateDebugOverlay(): void {
    if (!this.debugRoot || !this.debugRoot.enabled) return;
    const corners = this.getDebugCornerPositions();
    this.drawDebugEdge(corners[0], corners[1], this.debugEdges[0]);
    this.drawDebugEdge(corners[1], corners[2], this.debugEdges[1]);
    this.drawDebugEdge(corners[2], corners[3], this.debugEdges[2]);
    this.drawDebugEdge(corners[3], corners[0], this.debugEdges[3]);
    this.updateDebugQuadPlane(corners);
  }

  // ── Corner data collection ────────────────────────────────────────────────
  private collectCorners(): object[] {
    const ids  = ["tl", "tr", "br", "bl"];
    const objs = [this.cornerTL, this.cornerTR, this.cornerBR, this.cornerBL];
    const out: object[] = [];
    for (let i = 0; i < 4; i++) {
      const t = objs[i].getTransform();
      const p = t.getWorldPosition();
      const r = t.getWorldRotation();
      out.push({ id: ids[i], position: { x: p.x, y: p.y, z: p.z }, rotation: { x: r.x, y: r.y, z: r.z, w: r.w } });
    }
    return out;
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────
  private connect(): void {
    if (this.isDestroyed || !this.internetModule || this.isConnecting) return;

    this.socketGeneration += 1;
    this.closeSocket();
    this.isConnecting = true;
    const generation = this.socketGeneration;

    try {
      this.socket = this.internetModule.createWebSocket(this.serverUrl);
      this.socket.binaryType = "blob";

      this.socket.onopen = () => {
        if (generation !== this.socketGeneration) return;
        this.isConnecting = false;
        this.report("WebSocket OPEN mode=" + this.mode);
        this.sendJson({
          type: "hello",
          role: "specs",
          sessionId: "specs-" + Date.now().toString(),
          build: ProjectionMappingController.BUILD,
          mode: this.mode,
        });
        if (this.shouldStreamPose()) this.startPoseLoop();
        if (this.mode === ProjectionMode.Show) {
          if (!this.calibrationSent) {
            this.lockCalibration();
          } else if (this.wallFrame) {
            this.resendCalibration();
          } else if (this.lockedCornerPositions) {
            const c  = this.lockedCornerPositions;
            const cp = this.cameraObject.getTransform().getWorldPosition();
            this.buildWallFrame(c[0], c[1], c[2], c[3], cp);
            this.resendCalibration();
          }
        }
        this.pushDebug(
          this.mode === ProjectionMode.Calibrate
            ? "calibrate — pose streams; switch to show mode to lock corners"
            : "show — streaming pose + calibration"
        );
        this.debugLoopEvent.reset(10.0);
        // Notify OnboardingController
        if (this.onConnectedCallback) this.onConnectedCallback();
      };

      this.socket.onclose = () => {
        if (generation !== this.socketGeneration) return;
        this.isConnecting = false;
        this.report("WebSocket CLOSED");
        this.stopPoseLoop();
        this.scheduleReconnect();
        // Notify OnboardingController
        if (this.onDisconnectedCallback) this.onDisconnectedCallback();
      };

      this.socket.onerror = () => {
        if (generation !== this.socketGeneration) return;
        this.report("WebSocket ERROR");
      };
    } catch (e) {
      this.isConnecting = false;
      this.report("connect failed: " + e);
      this.scheduleReconnect();
    }
  }

  private resendCalibration(): void {
    if (!this.wallFrame || !this.lastLockViewerLocal) return;
    const corners = this.collectCorners();
    const cp = this.cameraObject.getTransform().getWorldPosition();
    const cr = this.cameraObject.getTransform().getWorldRotation();
    const lp = this.lastLockViewerLocal.pos;
    const lr = this.lastLockViewerLocal.rot;
    this.sendJson({
      type: "calibration",
      t: Date.now(),
      locked: true,
      build: ProjectionMappingController.BUILD,
      resend: true,
      corners: corners,
      viewer: {
        position: { x: cp.x, y: cp.y, z: cp.z },
        rotation: { x: cr.x, y: cr.y, z: cr.z, w: cr.w },
        local: {
          position: { x: lp.x, y: lp.y, z: lp.z },
          rotation: { x: lr.x, y: lr.y, z: lr.z, w: lr.w },
        },
      },
    });
    this.pushDebug("calibration resent (reconnect)");
  }

  private startPoseLoop(): void {
    if (!this.shouldStreamPose()) return;
    this.poseLoopEvent.reset(1.0 / Math.max(1, this.sendRateHz));
  }

  private stopPoseLoop(): void { this.poseLoopEvent.reset(99999); }

  private onPoseLoop(): void {
    if (this.isDestroyed || !this.shouldStreamPose()) return;
    this.loopTicks += 1;
    this.startPoseLoop();
    this.sendPoseFrame();
  }

  private onDebugLoop(): void {
    if (this.isDestroyed) return;
    this.debugLoopEvent.reset(15.0);
    if (this.enableLogging) this.pushDebug("heartbeat loops=" + this.loopTicks + " poses=" + this.posesSent);
  }

  private scheduleReconnect(): void {
    if (!this.isDestroyed) this.reconnectEvent.reset(this.reconnectDelaySec);
  }

  private closeSocket(): void {
    if (!this.socket) return;
    try { this.socket.close(); } catch (e) {}
    this.socket = null;
  }

  private sendPoseFrame(): void {
    if (!this.socket || !this.cameraObject) return;
    try {
      const camT = this.cameraObject.getTransform();
      const p    = camT.getWorldPosition();
      const r    = camT.getWorldRotation();

      let position = { x: p.x, y: p.y, z: p.z };
      let rotation = { x: r.x, y: r.y, z: r.z, w: r.w };
      let space    = "world";

      if (this.wallFrame && this.mode === ProjectionMode.Show) {
        const lp = this.worldToLocal(p);
        const lr = this.worldQuatToLocal(r);
        position = { x: lp.x, y: lp.y, z: lp.z };
        rotation = { x: lr.x, y: lr.y, z: lr.z, w: lr.w };
        space    = "portal_local";
      }

      const ok = this.sendJson({ type: "pose", t: Date.now(), position, rotation, space });
      if (ok) {
        this.posesSent += 1;
        if (this.posesSent === 1) {
          this.report("FIRST pose sent space=" + space);
          if (space === "portal_local") {
            this.pushDebug("first pose local " + position.x.toFixed(1) + "," + position.y.toFixed(1) + "," + position.z.toFixed(1) + " cm");
          } else {
            this.pushDebug("first pose");
          }
        }
      } else {
        this.reportError("pose send returned false");
      }
    } catch (e) {
      this.lastError = "pose: " + e;
      this.pushDebug(this.lastError);
    }
  }

  private sendJson(payload: object): boolean {
    if (!this.socket) return false;
    try { this.socket.send(JSON.stringify(payload)); return true; }
    catch (e) { this.lastError = "send: " + e; return false; }
  }

  private pushDebug(note: string): void {
    if (!this.socket || !this.enableLogging) return;
    this.sendJson({ type: "debug", t: Date.now(), build: ProjectionMappingController.BUILD, note, mode: this.mode, posesSent: this.posesSent, calibrationSent: this.calibrationSent, error: this.lastError });
  }

  private report(message: string): void {
    if (this.enableLogging) print("[ProjectionMapping] " + message);
  }

  private reportError(message: string): void {
    this.lastError = message;
    if (this.enableLogging) print("[ProjectionMapping] " + message);
  }
}
