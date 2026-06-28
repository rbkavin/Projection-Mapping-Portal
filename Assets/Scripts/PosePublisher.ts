/**
 * Streams camera pose to a WebSocket relay for the projection-mapping web viewer.
 * Debug messages are sent to the browser HUD (no Lens Studio device logs needed).
 */

@component
export class PosePublisher extends BaseScriptComponent {
  @input
  internetModule: InternetModule;

  @input
  cameraObject: SceneObject;

  @input
  referenceObject: SceneObject;

  @input
  @hint("Preview: ws://127.0.0.1:8765 | Device: ws://<mac-ip>:8765")
  serverUrl: string = "ws://127.0.0.1:8765";

  @input
  @hint("If true, only runs on real Specs. Set false to test in Lens Studio preview.")
  deviceOnly: boolean = false;

  @input
  sendRateHz: number = 30;

  @input
  reconnectDelaySec: number = 2;

  @input
  enableLogging: boolean = true;

  private static readonly BUILD = "v3-debug";

  private socket: WebSocket;
  private posesSent = 0;
  private loopTicks = 0;
  private reconnectEvent: DelayedCallbackEvent;
  private poseLoopEvent: DelayedCallbackEvent;
  private debugLoopEvent: DelayedCallbackEvent;
  private isDestroyed = false;
  private lastError = "";

  onAwake(): void {
    this.reconnectEvent = this.createEvent("DelayedCallbackEvent");
    this.reconnectEvent.bind(() => this.connect());
    this.poseLoopEvent = this.createEvent("DelayedCallbackEvent");
    this.poseLoopEvent.bind(() => this.onPoseLoop());
    this.debugLoopEvent = this.createEvent("DelayedCallbackEvent");
    this.debugLoopEvent.bind(() => this.onDebugLoop());

    this.createEvent("OnStartEvent").bind(() => this.onStart());

    if (!this.internetModule) {
      this.report("ERROR: assign Internet Module");
      return;
    }
    if (!this.cameraObject) {
      this.report("ERROR: assign Camera Object");
      return;
    }
    if (!this.serverUrl || this.serverUrl.length === 0) {
      this.report("ERROR: set Server Url ws://<mac-ip>:8765");
      return;
    }
    if (this.deviceOnly && global.deviceInfoSystem.isEditor()) {
      this.report("Preview blocked (deviceOnly). Push to Specs.");
      return;
    }

    this.report("Awake OK " + PosePublisher.BUILD + " url=" + this.serverUrl);
  }

  private onStart(): void {
    this.report("OnStart — connecting");
    this.connect();
    this.debugLoopEvent.reset(1.0);
  }

  onDestroy(): void {
    this.isDestroyed = true;
    this.closeSocket();
  }

  private connect(): void {
    if (this.isDestroyed || !this.internetModule) {
      return;
    }

    try {
      this.socket = this.internetModule.createWebSocket(this.serverUrl);
      this.socket.binaryType = "blob";

      this.socket.onopen = () => {
        this.report("WebSocket OPEN");
        this.sendJson({
          type: "hello",
          role: "specs",
          sessionId: "specs-" + Date.now().toString(),
          build: PosePublisher.BUILD,
        });
        this.startPoseLoop();
        const kick = this.createEvent("DelayedCallbackEvent");
        kick.bind(() => {
          this.sendPoseFrame();
          this.pushDebug("kick pose after open");
        });
        kick.reset(0.05);
      };

      this.socket.onclose = () => {
        this.report("WebSocket CLOSED — retry " + this.reconnectDelaySec + "s");
        this.stopPoseLoop();
        this.scheduleReconnect();
      };

      this.socket.onerror = () => {
        this.report("WebSocket ERROR");
      };
    } catch (e) {
      this.report("createWebSocket failed: " + e);
      this.scheduleReconnect();
    }
  }

  private startPoseLoop(): void {
    const interval = 1.0 / Math.max(1, this.sendRateHz);
    this.poseLoopEvent.reset(interval);
  }

  private stopPoseLoop(): void {
    this.poseLoopEvent.reset(99999);
  }

  private onPoseLoop(): void {
    if (this.isDestroyed) {
      return;
    }
    this.loopTicks += 1;
    this.startPoseLoop();
    this.sendPoseFrame();
  }

  private onDebugLoop(): void {
    if (this.isDestroyed) {
      return;
    }
    this.debugLoopEvent.reset(1.0);
    this.pushDebug("heartbeat");
  }

  private scheduleReconnect(): void {
    if (!this.isDestroyed) {
      this.reconnectEvent.reset(this.reconnectDelaySec);
    }
  }

  private closeSocket(): void {
    if (!this.socket) {
      return;
    }
    try {
      this.socket.close();
    } catch (e) {
      this.report("close error: " + e);
    }
    this.socket = null;
  }

  private sendPoseFrame(): void {
    if (!this.socket || !this.cameraObject) {
      return;
    }

    try {
      const pose = this.getCameraPose();
      const ok = this.sendJson({
        type: "pose",
        t: Date.now(),
        position: pose.position,
        rotation: pose.rotation,
        space: pose.space,
      });

      if (ok) {
        this.posesSent += 1;
        if (this.posesSent === 1) {
          this.pushDebug(
            "FIRST pose sent pos " +
              pose.position.x.toFixed(2) + "," +
              pose.position.y.toFixed(2) + "," +
              pose.position.z.toFixed(2)
          );
        }
      }
    } catch (e) {
      this.lastError = "pose error: " + e;
      this.pushDebug(this.lastError);
    }
  }

  private getCameraPose(): {
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number; w: number };
    space: string;
  } {
    const camT = this.cameraObject.getTransform();
    let position = camT.getWorldPosition();
    let rotation = camT.getWorldRotation();
    let space = "world";

    if (this.referenceObject) {
      const refT = this.referenceObject.getTransform();
      const refPos = refT.getWorldPosition();
      const refRot = refT.getWorldRotation();
      const invRefRot = refRot.invert();
      position = invRefRot.multiplyVec3(position.sub(refPos));
      rotation = invRefRot.multiply(rotation);
      space = "reference";
    }

    return {
      position: { x: position.x, y: position.y, z: position.z },
      rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
      space: space,
    };
  }

  private sendJson(payload: object): boolean {
    if (!this.socket) {
      return false;
    }
    try {
      this.socket.send(JSON.stringify(payload));
      return true;
    } catch (e) {
      this.lastError = "send failed: " + e;
      this.pushDebug(this.lastError);
      return false;
    }
  }

  private pushDebug(note: string): void {
    if (!this.socket) {
      return;
    }
    const state = this.socket.readyState;
    let camPos = "n/a";
    if (this.cameraObject) {
      const p = this.cameraObject.getTransform().getWorldPosition();
      camPos = p.x.toFixed(2) + "," + p.y.toFixed(2) + "," + p.z.toFixed(2);
    }
    this.sendJson({
      type: "debug",
      t: Date.now(),
      build: PosePublisher.BUILD,
      note: note,
      posesSent: this.posesSent,
      loopTicks: this.loopTicks,
      readyState: state,
      camPos: camPos,
      error: this.lastError,
    });
  }

  private report(message: string): void {
    if (this.enableLogging) {
      print("[PosePublisher] " + message);
    }
    this.lastError = message;
  }
}
