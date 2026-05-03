/**
 * BridgeOutputDriverElement- analog MNA element at a digital-engine output
 * pin's analog-side boundary.
 *
 * Stamps an ideal voltage-source branch equation- the branch variable at
 * `branchIndex` carries the source current. The logic level is set
 * externally by the `DefaultSimulationCoordinator` via `setLogicLevel(high)`
 * after each digital engine step. Re-stamping the branch equation on the
 * next NR iteration is sufficient- no NR convergence needed for a level
 * change.
 *
 * Stamp pattern (drive mode, branch role):
 *   M[branch, node]   += 1
 *   M[node,   branch] += 1
 *   rhs[branch]        = vOH or vOL
 *   if loaded:  M[node, node] += 1/rOut
 *
 * Stamp pattern (Hi-Z mode):
 *   M[branch, branch] += 1
 *   M[node,   branch] += 1
 *   rhs[branch]        = 0
 *   if loaded:  M[node, node] += 1/rHiZ
 *
 * `cOut` companion model is delegated to a child `AnalogCapacitorElement`
 * when `loaded && cOut > 0`; the bridge claims the child's stateSize so
 * the StatePool covers the companion slots, and forwards setup() / load() /
 * initState() / getLteTimestep() to the child.
 *
 * Per Composite M21 (phase-composite-architecture.md), J-136
 * (contracts_group_09.md). Logic migrated verbatim from the recovered
 * `DigitalOutputPinModel.load()` (`role="branch"` path) at
 * `.recovery/digital-pin-model.ts.orig:147-198`. Composite-class shape
 * (recovered `BridgeOutputAdapter`) replaced with direct PoolBackedAnalogElement
 * implementation- the deleted `extends CompositeElement` is forbidden by
 * ss0 hard rule #16.
 *
 * `setLogicLevel` / `setHighZ` are NOT part of the truth-function driver-leaf
 * pattern (those leaves read inputs and write slots only). Bridges are
 * pin-level elements at engine boundaries- they expose the cross-engine
 * signal interface as direct methods on the class.
 */

import { defineStateSchema, type StateSchema } from "../state-schema.js";
import { NGSPICE_LOAD_ORDER } from "../ngspice-load-order.js";
import type { PoolBackedAnalogElement } from "../element.js";
import type { StatePoolRef } from "../state-pool.js";
import type { SetupContext } from "../setup-context.js";
import type { LoadContext } from "../load-context.js";
import type { ResolvedPinElectrical } from "../../../core/pin-electrical.js";
import { AnalogCapacitorElement } from "../../../components/passives/capacitor.js";
import { stampRHS } from "../stamp-helpers.js";

// Bridges have no own pool slots- the cOut companion model lives in the
// AnalogCapacitorElement child's slots, which the StatePool covers because
// the bridge's stateSize includes the child's stateSize.
const BRIDGE_OUTPUT_SCHEMA: StateSchema = defineStateSchema("BridgeOutputDriver", []);

export class BridgeOutputDriverElement implements PoolBackedAnalogElement {
  // ---------- AnalogElement contract ----------
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  label = "";
  _pinNodes: Map<string, number>;
  branchIndex: number;
  _stateBase = -1;

  // ---------- PoolBackedAnalogElement contract ----------
  readonly poolBacked = true as const;
  readonly stateSchema = BRIDGE_OUTPUT_SCHEMA;
  readonly stateSize: number;

  // ---------- Cross-engine boundary state ----------
  // _level / _hiZ are coordinator-set boundary inputs- they are not mutated
  // by NR and so do not need pool-slot rollback (analogous to a
  // DcVoltageSource's _voltage instance field).
  private _spec: ResolvedPinElectrical;
  private readonly _loaded: boolean;
  private readonly _nodeId: number;
  private _level = false;
  private _hiZ = false;

  // ---------- Companion-model child ----------
  // AnalogCapacitorElement for cOut transient companion. Allocated when
  // loaded && cOut > 0. Its stateSize is folded into our stateSize so the
  // StatePool covers its companion slots.
  private readonly _capChild: AnalogCapacitorElement | null;

  // ---------- Cached matrix handles (allocated in setup()) ----------
  private _hBranchNode = -1;
  private _hBranchBranch = -1;
  private _hNodeBranch = -1;
  private _hNodeDiag = -1;

  constructor(
    spec: ResolvedPinElectrical,
    nodeId: number,
    branchIdx: number,
    loaded: boolean,
  ) {
    this._spec = { ...spec };
    this._nodeId = nodeId;
    this.branchIndex = branchIdx;
    this._loaded = loaded;
    this._pinNodes = new Map([["node", nodeId]]);

    if (loaded && spec.cOut > 0 && nodeId > 0) {
      const cap = new AnalogCapacitorElement(
        new Map<string, number>([["pos", nodeId], ["neg", 0]]),
        // capacitor.ts requires a PropertyBag for params; for boundary children
        // the simplest path is to construct a bare bag with C set inline. The
        // recovered original used the legacy 7-arg AnalogCapacitorElement
        // constructor; the current file uses (pinNodes, props) so adapt:
        makeCapPropsBag(spec.cOut),
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

    if (this.branchIndex > 0) {
      this._hBranchNode   = ctx.solver.allocElement(this.branchIndex, this._nodeId);
      this._hBranchBranch = ctx.solver.allocElement(this.branchIndex, this.branchIndex);
      this._hNodeBranch   = ctx.solver.allocElement(this._nodeId,     this.branchIndex);
    }
    if (this._loaded) {
      this._hNodeDiag = ctx.solver.allocElement(this._nodeId, this._nodeId);
    }

    // Allocate state slots for the cap child here so the bridge's _stateBase
    // covers them- the engine's pool-walk uses our stateSize.
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
    const node = this._nodeId;
    if (node <= 0) return;
    const solver = ctx.solver;
    const bIdx = this.branchIndex;
    if (bIdx <= 0) return;

    if (this._hiZ) {
      solver.stampElement(this._hBranchBranch, 1);
      solver.stampElement(this._hBranchNode, 0);
      solver.stampElement(this._hNodeBranch, 1);
      stampRHS(ctx.rhs, bIdx, 0);
      if (this._loaded) {
        solver.stampElement(this._hNodeDiag, 1 / this._spec.rHiZ);
      }
    } else {
      solver.stampElement(this._hBranchNode, 1);
      solver.stampElement(this._hBranchBranch, 0);
      solver.stampElement(this._hNodeBranch, 1);
      stampRHS(ctx.rhs, bIdx, this._level ? this._spec.vOH : this._spec.vOL);
      if (this._loaded) {
        solver.stampElement(this._hNodeDiag, 1 / this._spec.rOut);
      }
    }

    if (this._capChild !== null) {
      this._capChild.load(ctx);
    }
  }

  // ---------- Cross-engine interface (coordinator-callable) ----------

  /** Set the output logic level. High → vOH, low → vOL. */
  setLogicLevel(high: boolean): void {
    this._level = high;
  }

  /** Switch between driven and Hi-Z states. */
  setHighZ(hiZ: boolean): void {
    this._hiZ = hiZ;
  }

  /** Hot-update a single electrical parameter. */
  setParam(key: string, value: number): void {
    if (key in this._spec) {
      (this._spec as unknown as Record<string, number>)[key] = value;
    }
  }

  // ---------- Coordinator-readable getters ----------

  /** MNA node ID for this output pin. The coordinator reads voltage here. */
  get outputNodeId(): number {
    return this._nodeId;
  }

  /** Output impedance in ohms. */
  get rOut(): number {
    return this._spec.rOut;
  }

  /** True only when the cOut companion child is present (loaded && cOut > 0). */
  get isReactive(): boolean {
    return this._capChild !== null;
  }

  /** Branch-row current at convergence. */
  getPinCurrents(rhs: Float64Array): number[] {
    const i = this.branchIndex >= 0 && this.branchIndex < rhs.length
      ? rhs[this.branchIndex]
      : 0;
    return [i];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { PropertyBag } from "../../../core/properties.js";

function makeCapPropsBag(c: number): PropertyBag {
  const bag = new PropertyBag();
  bag.setModelParam("capacitance", c);
  return bag;
}

