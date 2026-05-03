/**
 * BridgeInputDriverElement- analog MNA element at a digital-engine input
 * pin's analog-side boundary.
 *
 * Sense-only by default. When loaded, stamps `1/rIn` on the node diagonal.
 * `cIn` companion model is delegated to a child `AnalogCapacitorElement`
 * when `loaded && cIn > 0`.
 *
 * The `DefaultSimulationCoordinator` calls `readLogicLevel(voltage)` after
 * each accepted analog timestep, passing `solution[bridge.inputNodeId]`. The
 * threshold-detected bit feeds the digital engine for its next step.
 *
 * Stamp pattern (loaded, drive):
 *   M[node, node] += 1/rIn
 *
 * Stamp pattern (unloaded): no-op (pure threshold-detection element).
 *
 * Per Composite M21 (phase-composite-architecture.md), J-135
 * (contracts_group_09.md). Logic migrated verbatim from the recovered
 * `DigitalInputPinModel.load()` and `readLogicLevel()` at
 * `.recovery/digital-pin-model.ts.orig:307-335`. Composite-class shape
 * (recovered `BridgeInputAdapter`) replaced with direct
 * PoolBackedAnalogElement implementation- the deleted `extends
 * CompositeElement` is forbidden by ss0 hard rule #16.
 *
 * `readLogicLevel` is a stateless threshold-detection method, NOT a
 * truth-function-driver-leaf pattern. Bridges are pin-level elements at
 * engine boundaries- they expose the cross-engine signal interface as
 * direct methods on the class.
 */

import { defineStateSchema, type StateSchema } from "../state-schema.js";
import { NGSPICE_LOAD_ORDER } from "../ngspice-load-order.js";
import type { PoolBackedAnalogElement } from "../element.js";
import type { StatePoolRef } from "../state-pool.js";
import type { SetupContext } from "../setup-context.js";
import type { LoadContext } from "../load-context.js";
import type { ResolvedPinElectrical } from "../../../core/pin-electrical.js";
import { AnalogCapacitorElement } from "../../../components/passives/capacitor.js";
import { PropertyBag } from "../../../core/properties.js";

const BRIDGE_INPUT_SCHEMA: StateSchema = defineStateSchema("BridgeInputDriver", []);

export class BridgeInputDriverElement implements PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  label = "";
  _pinNodes: Map<string, number>;
  branchIndex = -1;
  _stateBase = -1;

  readonly poolBacked = true as const;
  readonly stateSchema = BRIDGE_INPUT_SCHEMA;
  readonly stateSize: number;

  private _spec: ResolvedPinElectrical;
  private readonly _loaded: boolean;
  private readonly _nodeId: number;

  private readonly _capChild: AnalogCapacitorElement | null;
  private _hNodeDiag = -1;

  constructor(
    spec: ResolvedPinElectrical,
    nodeId: number,
    loaded: boolean,
  ) {
    this._spec = { ...spec };
    this._nodeId = nodeId;
    this._loaded = loaded;
    this._pinNodes = new Map([["node", nodeId]]);

    if (loaded && spec.cIn > 0 && nodeId > 0) {
      const bag = new PropertyBag();
      bag.setModelParam("capacitance", spec.cIn);
      const cap = new AnalogCapacitorElement(
        new Map<string, number>([["pos", nodeId], ["neg", 0]]),
        bag,
      );
      this._capChild = cap;
      this.stateSize = cap.stateSize;
    } else {
      this._capChild = null;
      this.stateSize = 0;
    }
  }

  setup(ctx: SetupContext): void {
    if (this._nodeId <= 0) return;
    if (this._loaded) {
      this._hNodeDiag = ctx.solver.allocElement(this._nodeId, this._nodeId);
    }
    if (this._capChild !== null) {
      this._stateBase = ctx.allocStates(this.stateSize);
      this._capChild._stateBase = this._stateBase;
      this._capChild.setup(ctx);
    } else {
      this._stateBase = ctx.allocStates(0);
    }
  }

  initState(pool: StatePoolRef): void {
    if (this._capChild !== null) {
      this._capChild.initState(pool);
    }
  }

  load(ctx: LoadContext): void {
    if (!this._loaded) return;
    const node = this._nodeId;
    if (node <= 0) return;
    ctx.solver.stampElement(this._hNodeDiag, 1 / this._spec.rIn);
    if (this._capChild !== null) {
      this._capChild.load(ctx);
    }
  }

  // ---------- Cross-engine interface ----------

  /**
   * Threshold-detect a node voltage to a digital level.
   *   voltage > vIH → true (HIGH)
   *   voltage < vIL → false (LOW)
   *   between thresholds → undefined (indeterminate)
   */
  readLogicLevel(voltage: number): boolean | undefined {
    if (voltage > this._spec.vIH) return true;
    if (voltage < this._spec.vIL) return false;
    return undefined;
  }

  setParam(key: string, value: number): void {
    switch (key) {
      case "rOut": this._spec.rOut = value; break;
      case "cOut": this._spec.cOut = value; break;
      case "rIn":  this._spec.rIn  = value; break;
      case "cIn":  this._spec.cIn  = value; break;
      case "vOH":  this._spec.vOH  = value; break;
      case "vOL":  this._spec.vOL  = value; break;
      case "vIH":  this._spec.vIH  = value; break;
      case "vIL":  this._spec.vIL  = value; break;
      case "rHiZ": this._spec.rHiZ = value; break;
    }
  }

  // ---------- Coordinator-readable getters ----------

  /** MNA node ID for this input pin. The coordinator reads voltage here. */
  get inputNodeId(): number {
    return this._nodeId;
  }

  /** Input impedance in ohms. */
  get rIn(): number {
    return this._spec.rIn;
  }

  /** True only when the cIn companion child is present (loaded && cIn > 0). */
  get isReactive(): boolean {
    return this._capChild !== null;
  }

  /**
   * Per-pin current for the single input node.
   * When loaded, 1/rIn is stamped from node to ground.
   * At convergence: I_into_element = V_node / rIn.
   * When unloaded, no conductance is stamped, so current contribution is 0.
   */
  getPinCurrents(rhs: Float64Array): number[] {
    if (!this._loaded) return [0];
    const node = this._nodeId;
    if (node <= 0 || node >= rhs.length) return [0];
    return [rhs[node] / this._spec.rIn];
  }
}

