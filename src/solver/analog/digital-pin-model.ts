/**
 * DigitalPinModel â€” MNA stamp helpers for digital pins.
 *
 * DigitalOutputPinModel stamps an ideal voltage source branch equation ("branch" role)
 * or a conductance+current-source ("direct" role) based on the role assigned at
 * construction. Loading (rOut, cOut) is stamped only when the loaded flag is true.
 *
 * DigitalInputPinModel is sense-only by default:
 *   - When loaded, stamps 1/rIn on the node diagonal.
 *   - Companion model for C_in via AnalogCapacitorElement child when loaded and cIn > 0.
 *   - Threshold detection always available regardless of loaded flag.
 *
 * Both classes expose getChildElements() so owning elements can aggregate
 * capacitor children into their own composite state-pool layout, following
 * the TransmissionLineElement composite pattern.
 */

import type { LoadContext } from "./load-context.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";
import type { AnalogElement, ReactiveAnalogElement } from "./element.js";
import { AnalogCapacitorElement } from "../../components/passives/capacitor.js";

/**
 * Read voltage for an MNA node from the solver solution vector.
 * MNA node 0 is ground (always 0 V; slot 0 is the ngspice ground
 * sentinel). Non-ground nodes are stored at solver index nodeId
 * (1-based: slots 1..nodeCount).
 */
export function readMnaVoltage(nodeId: number, voltages: Float64Array): number {
  return nodeId > 0 && nodeId < voltages.length ? voltages[nodeId] : 0;
}

// ---------------------------------------------------------------------------
// DigitalOutputPinModel
// ---------------------------------------------------------------------------

/**
 * Stamps the analog equivalent of one digital output pin into the MNA matrix.
 *
 * role "branch": ideal voltage-source branch equation (for bridge adapters).
 * role "direct": conductance+current-source (for behavioural elements).
 *
 * Loading (rOut, cOut) is stamped only when the loaded flag is true.
 * When loaded and cOut > 0 an AnalogCapacitorElement child handles companion
 * integration via the owning element's state-pool composite.
 */
export class DigitalOutputPinModel {
  private _spec: ResolvedPinElectrical;
  private readonly _loaded: boolean;
  private readonly _role: "branch" | "direct";

  /** Node this pin drives. Set by init(). */
  private _nodeId = -1;

  /** Absolute branch row/col in the augmented matrix. Set by init(). */
  private _branchIdx = -1;

  /** True when logic level is high. */
  private _high = false;

  /** True when in Hi-Z state. */
  private _hiZ = false;

  /** AnalogCapacitorElement child â€” allocated when loaded && cOut > 0 after init(). */
  private _capacitorChild: AnalogCapacitorElement | null = null;

  /** Cached matrix handles â€” allocated on first load(), keyed by role. */
  private _handlesInit = false;
  // branch role handles
  private _hBranchNode = -1;   // (branchIdx, nodeIdx)
  private _hBranchBranch = -1; // (branchIdx, branchIdx)
  private _hNodeBranch = -1;   // (nodeIdx, branchIdx)
  // direct and shared
  private _hNodeDiag = -1;     // (nodeIdx, nodeIdx)

  constructor(spec: ResolvedPinElectrical, loaded = false, role: "branch" | "direct" = "direct") {
    this._spec = { ...spec };
    this._loaded = loaded;
    this._role = role;
  }

  /**
   * Assign the node this pin drives and the branch variable index.
   *
   * branchIdx is the absolute row/col in the augmented MNA matrix
   * (= totalNodeCount + assignedBranchOffset). Pass -1 for direct-role pins
   * (no branch variable needed).
   *
   * Creates the AnalogCapacitorElement child when loaded and cOut > 0.
   */
  init(nodeId: number, branchIdx: number): void {
    this._nodeId = nodeId;
    this._branchIdx = branchIdx;
    this._handlesInit = false;
    if (this._loaded && this._spec.cOut > 0 && nodeId > 0) {
      const cap = new AnalogCapacitorElement(this._spec.cOut, 0, 0, 0, 300.15, 1, 1);
      cap.pinNodeIds = [nodeId, 0];
      this._capacitorChild = cap;
    } else {
      this._capacitorChild = null;
    }
  }

  /** Set the output logic level. High â†’ vOH, low â†’ vOL. */
  setLogicLevel(high: boolean): void {
    this._high = high;
  }

  /** Switch between driven and Hi-Z states. */
  setHighZ(hiZ: boolean): void {
    this._hiZ = hiZ;
  }

  /** Hot-update a single electrical parameter on this pin model. */
  setParam(key: string, value: number): void {
    if (key in this._spec) {
      (this._spec as unknown as Record<string, number>)[key] = value;
    }
  }

  /** Read-only introspection accessor. */
  get loaded(): boolean { return this._loaded; }

  /**
   * Returns the capacitor child element for state-pool composite aggregation.
   * Non-empty only when loaded && cOut > 0 and init() has been called.
   */
  getChildElements(): readonly AnalogCapacitorElement[] {
    if (this._capacitorChild !== null) {
      return [this._capacitorChild];
    }
    return [];
  }

  /**
   * Unified per-NR-iteration load. Dispatches on role:
   *
   * "branch": stamps ideal voltage-source branch equation.
   *   Drive mode:  branch eq enforces V_node = V_target.
   *   Hi-Z mode:   branch eq enforces I = 0.
   *   If loaded:   1/rOut (drive) or 1/rHiZ (Hi-Z) on node diagonal.
   *
   * "direct": stamps conductance+current-source Norton equivalent.
   *   Drive mode:  1/rOut diagonal + V_target/rOut RHS.
   *   Hi-Z mode:   1/rHiZ diagonal only.
   *   (loaded flag governs whether these stamps happen at all for "direct".)
   */
  load(ctx: LoadContext): void {
    const node = this._nodeId;
    if (node <= 0) return;
    const nodeIdx = node - 1;
    const solver = ctx.solver;

    if (this._role === "branch") {
      const bIdx = this._branchIdx;
      if (bIdx < 0) return;

      if (!this._handlesInit) {
        this._hBranchNode = solver.allocElement(bIdx, nodeIdx);
        this._hBranchBranch = solver.allocElement(bIdx, bIdx);
        this._hNodeBranch = solver.allocElement(nodeIdx, bIdx);
        if (this._loaded) {
          this._hNodeDiag = solver.allocElement(nodeIdx, nodeIdx);
        }
        this._handlesInit = true;
      }

      if (this._hiZ) {
        solver.stampElement(this._hBranchBranch, 1);
        solver.stampElement(this._hBranchNode, 0);
        solver.stampElement(this._hNodeBranch, 1);
        solver.stampRHS(bIdx, 0);
        if (this._loaded) {
          solver.stampElement(this._hNodeDiag, 1 / this._spec.rHiZ);
        }
      } else {
        solver.stampElement(this._hBranchNode, 1);
        solver.stampElement(this._hBranchBranch, 0);
        solver.stampElement(this._hNodeBranch, 1);
        solver.stampRHS(bIdx, this._high ? this._spec.vOH : this._spec.vOL);
        if (this._loaded) {
          solver.stampElement(this._hNodeDiag, 1 / this._spec.rOut);
        }
      }
    } else {
      // "direct" role â€” conductance+current-source Norton equivalent
      if (!this._handlesInit) {
        this._hNodeDiag = solver.allocElement(nodeIdx, nodeIdx);
        this._handlesInit = true;
      }

      if (this._hiZ) {
        solver.stampElement(this._hNodeDiag, 1 / this._spec.rHiZ);
      } else {
        const gOut = 1 / this._spec.rOut;
        solver.stampElement(this._hNodeDiag, gOut);
        solver.stampRHS(nodeIdx, (this._high ? this._spec.vOH : this._spec.vOL) * gOut);
      }
    }
  }

  /** The node ID assigned by init(). */
  get nodeId(): number {
    return this._nodeId;
  }

  /** The branch index assigned by init(). */
  get branchIndex(): number {
    return this._branchIdx;
  }

  /** The target output voltage (vOH or vOL). */
  get currentVoltage(): number {
    return this._high ? this._spec.vOH : this._spec.vOL;
  }

  /** Output capacitance in farads. */
  get capacitance(): number {
    return this._spec.cOut;
  }

  /** True when the output is in Hi-Z state. */
  get isHiZ(): boolean {
    return this._hiZ;
  }

  /** Output impedance in ohms. */
  get rOut(): number {
    return this._spec.rOut;
  }

  /** Hi-Z impedance in ohms. */
  get rHiZ(): number {
    return this._spec.rHiZ;
  }

  /** Role assigned at construction ("branch" or "direct"). */
  get role(): "branch" | "direct" {
    return this._role;
  }
}

// ---------------------------------------------------------------------------
// DigitalInputPinModel
// ---------------------------------------------------------------------------

/**
 * Stamps the analog equivalent of one digital input pin into the MNA matrix.
 *
 * Sense-only by default â€” threshold detection is always available.
 * When loaded, stamps 1/rIn on the node diagonal.
 * When loaded and cIn > 0 an AnalogCapacitorElement child handles companion
 * integration via the owning element's state-pool composite.
 */
export class DigitalInputPinModel {
  private _spec: ResolvedPinElectrical;
  private readonly _loaded: boolean;

  /** Node this pin reads. Set by init(). */
  private _nodeId = -1;

  /** AnalogCapacitorElement child â€” allocated when loaded && cIn > 0 after init(). */
  private _capacitorChild: AnalogCapacitorElement | null = null;

  /** Cached matrix handle for node diagonal. */
  private _hNodeDiag = -1;
  private _handlesInit = false;

  constructor(spec: ResolvedPinElectrical, loaded: boolean) {
    this._spec = { ...spec };
    this._loaded = loaded;
  }

  /**
   * Assign the node this pin reads.
   * Creates the AnalogCapacitorElement child when loaded and cIn > 0.
   */
  init(nodeId: number, _groundNode: number): void {
    this._nodeId = nodeId;
    this._handlesInit = false;
    if (this._loaded && this._spec.cIn > 0 && nodeId > 0) {
      const cap = new AnalogCapacitorElement(this._spec.cIn, 0, 0, 0, 300.15, 1, 1);
      cap.pinNodeIds = [nodeId, 0];
      this._capacitorChild = cap;
    } else {
      this._capacitorChild = null;
    }
  }

  /** Hot-update a single electrical parameter on this pin model. */
  setParam(key: string, value: number): void {
    if (key in this._spec) {
      (this._spec as unknown as Record<string, number>)[key] = value;
    }
  }

  /** Read-only introspection accessor. */
  get loaded(): boolean { return this._loaded; }

  /**
   * Returns the capacitor child element for state-pool composite aggregation.
   * Non-empty only when loaded && cIn > 0 and init() has been called.
   */
  getChildElements(): readonly AnalogCapacitorElement[] {
    if (this._capacitorChild !== null) {
      return [this._capacitorChild];
    }
    return [];
  }

  /**
   * Unified per-NR-iteration load.
   *
   * No-op when !_loaded. When loaded, stamps 1/rIn on the node diagonal.
   */
  load(ctx: LoadContext): void {
    if (!this._loaded) return;
    const node = this._nodeId;
    if (node <= 0) return;
    const nodeIdx = node - 1;
    const solver = ctx.solver;

    if (!this._handlesInit) {
      this._hNodeDiag = solver.allocElement(nodeIdx, nodeIdx);
      this._handlesInit = true;
    }

    solver.stampElement(this._hNodeDiag, 1 / this._spec.rIn);
  }

  /**
   * Apply threshold detection to a node voltage.
   *
   * Returns true  when voltage > vIH  (logic HIGH),
   *         false when voltage < vIL  (logic LOW),
   *         undefined               (indeterminate â€” between thresholds).
   */
  readLogicLevel(voltage: number): boolean | undefined {
    if (voltage > this._spec.vIH) return true;
    if (voltage < this._spec.vIL) return false;
    return undefined;
  }

  /** The node ID assigned by init(). */
  get nodeId(): number {
    return this._nodeId;
  }

  /** Input impedance in ohms. */
  get rIn(): number {
    return this._spec.rIn;
  }

  /** Input capacitance in farads. */
  get capacitance(): number {
    return this._spec.cIn;
  }
}

// ---------------------------------------------------------------------------
// Shared delegation helpers for elements that own pin models
// ---------------------------------------------------------------------------

/**
 * Route a composite pin-param key ("A.rOut", "D.vIH") to the correct
 * pin model's setParam. Returns true if the key was handled.
 *
 * Elements that hold DigitalInputPinModel / DigitalOutputPinModel instances
 * build a labelâ†’model map at construction time and delegate from setParam:
 *
 *   setParam(key: string, value: number): void {
 *     delegatePinSetParam(this._pinModelsByLabel, key, value);
 *   }
 */
export function delegatePinSetParam(
  pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>,
  key: string,
  value: number,
): boolean {
  const dot = key.indexOf('.');
  if (dot === -1) return false;
  const pinLabel = key.slice(0, dot);
  const paramName = key.slice(dot + 1);
  const model = pinModelsByLabel.get(pinLabel);
  if (model !== undefined) {
    model.setParam(paramName, value);
    return true;
  }
  return false;
}

/**
 * Collect AnalogCapacitorElement children from an array of pin models.
 *
 * Owning elements call this after constructing all pin models to build
 * their _childElements array for state-pool composite aggregation.
 * Follows the TransmissionLineElement composite pattern.
 */
export function collectPinModelChildren(
  pinModels: readonly (DigitalInputPinModel | DigitalOutputPinModel)[],
): AnalogCapacitorElement[] {
  const result: AnalogCapacitorElement[] = [];
  for (const model of pinModels) {
    for (const child of model.getChildElements()) {
      result.push(child);
    }
  }
  return result;
}
