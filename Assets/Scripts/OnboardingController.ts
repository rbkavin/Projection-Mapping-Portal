import { RectangleButton } from "SpectaclesUIKit.lspkg/Scripts/Components/Button/RectangleButton";
import { SIK } from "SpectaclesInteractionKit.lspkg/SIK";
import { InteractorInputType } from "SpectaclesInteractionKit.lspkg/Core/Interactor/Interactor";
import { ProjectionMappingController } from "./ProjectionMappingController";

const WorldQueryModule = require("LensStudio:WorldQueryModule") as WorldQueryModule;

enum OnboardingState {
  Connecting = "connecting",
  Calibrating = "calibrating",
  Confirming = "confirming",
  Live = "live",
}

@component
export class OnboardingController extends BaseScriptComponent {

  // ── Controller ────────────────────────────────────────────────────────────
  @input
  @hint("SceneObject that has ProjectionMappingController on it")
  controllerObject: SceneObject;

  // ── Single panel — shown during setup, hidden when live ───────────────────
  @input
  @hint("The whole onboarding UI panel (Frame). Hidden after confirm.")
  calibrationPanel: SceneObject;

  // ── Text objects inside the panel ─────────────────────────────────────────
  @input
  @hint("Main instruction / status text")
  statusTextObject: SceneObject;

  @input
  @hint("Step dots counter  ● ● ○ ○")
  stepDotsObject: SceneObject;

  // ── Reticle (cursor that snaps to wall) ───────────────────────────────────
  @input
  @hint("Small visual that follows the wall hit point while calibrating")
  reticle: SceneObject;

  // ── Confirm button — shown after 4 corners are placed ────────────────────
  @input
  @hint("RectangleButton shown in CONFIRMING state to lock and go live")
  confirmButtonObject: SceneObject;

  // ── Undo button — optional, removes last corner ───────────────────────────
  @input
  @hint("RectangleButton to undo the last placed corner (optional)")
  undoButtonObject: SceneObject;

  // ── Gap between the two buttons — tune in inspector if overlapping ───────────
  @input
  @hint("Vertical gap between Confirm (top) and Undo (bottom), in scene units")
  buttonGap: number = 5;

  // ── Private state ─────────────────────────────────────────────────────────
  private state: OnboardingState = OnboardingState.Connecting;
  private controller: ProjectionMappingController | null = null;
  private hitSession: HitTestSession | null = null;
  private lastHitPos: vec3 | null = null;
  private lastHitNormal: vec3 | null = null;
  private confirmBtn: RectangleButton | null = null;
  private undoBtn: RectangleButton | null = null;

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.onStart());
    this.createEvent("UpdateEvent").bind(() => this.onUpdate());
  }

  private onStart(): void {
    if (!this.controllerObject) {
      print("[Onboarding] ERROR: assign controllerObject");
      return;
    }

    this.controller = this.controllerObject.getComponent(
      ProjectionMappingController.getTypeName()
    ) as ProjectionMappingController;

    if (!this.controller) {
      print("[Onboarding] ERROR: no ProjectionMappingController on controllerObject");
      return;
    }

    // Wire connection callbacks
    this.controller.onConnectedCallback = () => {
      if (this.state === OnboardingState.Connecting) {
        this.setState(OnboardingState.Calibrating);
      }
    };
    this.controller.onDisconnectedCallback = () => {
      if (this.state !== OnboardingState.Connecting) {
        this.setState(OnboardingState.Connecting);
      }
    };

    // If socket already open when we start
    if (this.controller.socketOpen) {
      this.setState(OnboardingState.Calibrating);
    } else {
      this.setState(OnboardingState.Connecting);
    }

    // Wall hit-test session
    const opts = HitTestSessionOptions.create();
    opts.filter = true;
    this.hitSession = WorldQueryModule.createHitTestSessionWithOptions(opts);

    // Buttons
    this.confirmBtn = this.findButton(this.confirmButtonObject);
    this.undoBtn = this.findButton(this.undoButtonObject);

    if (this.confirmBtn) this.confirmBtn.onTriggerUp.add(() => this.onConfirmPressed());
    if (this.undoBtn) this.undoBtn.onTriggerUp.add(() => this.onUndoPressed());

    // Pinch detection via SIK
    const allInteractors = SIK.InteractionManager.getInteractorsByType(InteractorInputType.All);
    for (const interactor of allInteractors) {
      interactor.onTriggerEnd.add(() => {
        if (this.state !== OnboardingState.Calibrating) return;
        if (!this.lastHitPos || !this.lastHitNormal) return;
        const targeting = SIK.InteractionManager.getTargetingInteractors();
        if (targeting.indexOf(interactor) < 0) return;
        this.onCornerPinched(this.lastHitPos, this.lastHitNormal);
      });
    }
  }

  private onUpdate(): void {
    if (this.state !== OnboardingState.Calibrating) {
      if (this.reticle) this.reticle.enabled = false;
      return;
    }
    this.updateHitTest();
  }

  // ── Hit testing ───────────────────────────────────────────────────────────
  private updateHitTest(): void {
    if (!this.hitSession) return;

    const targeting = SIK.InteractionManager.getTargetingInteractors();
    const interactor = targeting[0];

    if (!interactor || !interactor.isActive()) {
      this.clearHit();
      return;
    }

    const start = interactor.startPoint;
    const end = interactor.endPoint;
    if (!start || !end) {
      this.clearHit();
      return;
    }

    this.hitSession.hitTest(start, end, (result) => {
      if (!result) { this.clearHit(); return; }
      // Vertical walls only (reject floor/ceiling)
      if (Math.abs(result.normal.y) > 0.3) { this.clearHit(); return; }
      this.lastHitPos = result.position;
      this.lastHitNormal = result.normal;
      if (this.reticle) {
        this.reticle.enabled = true;
        this.reticle.getTransform().setWorldPosition(result.position);
      }
    });
  }

  private clearHit(): void {
    this.lastHitPos = null;
    this.lastHitNormal = null;
    if (this.reticle) this.reticle.enabled = false;
  }

  // ── Corner placement ──────────────────────────────────────────────────────
  private onCornerPinched(pos: vec3, normal: vec3): void {
    if (!this.controller) return;
    const count = this.controller.placeCorner(pos, normal);
    this.updateStepDots(count);
    this.setStatusText(this.getInstruction(count));
    if (this.undoButtonObject) this.undoButtonObject.enabled = count > 0;
    if (count >= 4) this.setState(OnboardingState.Confirming);
  }

  // ── Button handlers ───────────────────────────────────────────────────────
  private onConfirmPressed(): void {
    if (!this.controller) return;
    this.controller.autoSortAndLock();
    this.setState(OnboardingState.Live);
  }

  private onUndoPressed(): void {
    if (!this.controller) return;
    const count = this.controller.undoCorner();
    this.updateStepDots(count);
    this.setStatusText(this.getInstruction(count));
    if (this.undoButtonObject) this.undoButtonObject.enabled = count > 0;
    if (count < 4 && this.state === OnboardingState.Confirming) {
      this.setState(OnboardingState.Calibrating);
    }
  }

  // ── State machine ─────────────────────────────────────────────────────────
  private setState(newState: OnboardingState): void {
    this.state = newState;

    // Reset interactive elements each transition
    if (this.confirmButtonObject) this.confirmButtonObject.enabled = false;
    if (this.undoButtonObject) this.undoButtonObject.enabled = false;

    const count = this.controller ? this.controller.placedCount : 0;

    switch (newState) {
      case OnboardingState.Connecting:
        if (this.calibrationPanel) this.calibrationPanel.enabled = true;
        this.setStatusText("Connecting to relay…");
        this.updateStepDots(0);
        break;

      case OnboardingState.Calibrating:
        if (this.calibrationPanel) this.calibrationPanel.enabled = true;
        this.setStatusText(this.getInstruction(count));
        this.updateStepDots(count);
        if (this.undoButtonObject) this.undoButtonObject.enabled = count > 0;
        break;

      case OnboardingState.Confirming:
        if (this.calibrationPanel) this.calibrationPanel.enabled = true;
        this.setStatusText("All done — confirm to go live");
        this.updateStepDots(4);
        this.positionConfirmButtons();
        if (this.confirmButtonObject) this.confirmButtonObject.enabled = true;
        if (this.undoButtonObject) this.undoButtonObject.enabled = true;
        break;

      case OnboardingState.Live:
        // Hide everything — clean AR view
        if (this.calibrationPanel) this.calibrationPanel.enabled = false;
        if (this.reticle) this.reticle.enabled = false;
        break;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  private positionConfirmButtons(): void {
    if (!this.controller) return;
    const center = this.controller.cornerCenter;
    if (!center) return;

    const wallNorm = this.controller.wallNormalPublic;
    const nudge = wallNorm ? wallNorm.uniformScale(0.05) : new vec3(0, 0, 0);
    const base = center.add(nudge);

    // Uniform scale based on rectangle size — no stretching
    const span = this.controller.cornerSpan;
    if (span) {
      const s = (span.width + span.height) * 0.04;
      const uniform = new vec3(s, s, s);
      if (this.confirmButtonObject) this.confirmButtonObject.getTransform().setLocalScale(uniform);
      if (this.undoButtonObject) this.undoButtonObject.getTransform().setLocalScale(uniform);
    }

    const gap = span ? Math.max(this.buttonGap, span.height * 0.18) : this.buttonGap;

    if (this.confirmButtonObject) {
      this.confirmButtonObject.getTransform().setWorldPosition(
        base.add(new vec3(0, gap, 0))
      );
    }
    if (this.undoButtonObject) {
      this.undoButtonObject.getTransform().setWorldPosition(
        base.add(new vec3(0, -gap, 0))
      );
    }
  }

  private getInstruction(count: number): string {
    switch (count) {
      case 0: return "Pinch the 4 corners of\nthe projected image";
      case 1: return "3 more — pinch the next corner";
      case 2: return "2 more corners to go";
      case 3: return "Last corner — almost done!";
      default: return "";
    }
  }

  private updateStepDots(count: number): void {
    let dots = "";
    for (let i = 0; i < 4; i++) {
      dots += i < count ? "●" : "○";
      if (i < 3) dots += "  ";
    }
    this.setText(this.stepDotsObject, dots);
  }

  private setStatusText(text: string): void {
    this.setText(this.statusTextObject, text);
  }

  private setText(obj: SceneObject, text: string): void {
    if (!obj) return;
    let comp = obj.getComponent("Component.Text") as Text;
    if (!comp) {
      for (let i = 0; i < obj.getChildrenCount(); i++) {
        comp = obj.getChild(i).getComponent("Component.Text") as Text;
        if (comp) break;
      }
    }
    if (comp) comp.text = text;
  }

  private findButton(obj: SceneObject): RectangleButton | null {
    if (!obj) return null;
    let btn = obj.getComponent(RectangleButton.getTypeName()) as RectangleButton;
    if (!btn) {
      for (let i = 0; i < obj.getChildrenCount(); i++) {
        btn = obj.getChild(i).getComponent(RectangleButton.getTypeName()) as RectangleButton;
        if (btn) break;
      }
    }
    return btn;
  }
}
