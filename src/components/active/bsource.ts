/**
 * Behavioural / arbitrary source (SPICE `B`-element) analog components.
 *
 * The ngspice ASRC device is a parse-tree-driven controlled source: its output
 * is an arbitrary expression `V=f(...)` (voltage) or `I=f(...)` (current) over N
 * controlling variables, each independently a node voltage (`IF_NODE`) or a
 * branch current (`IF_INSTANCE`). digiTS splits ngspice's single ASRC device
 * into two components selected by the output topology:
 *
 *   - `BV` — V-mode (`ASRC_VOLTAGE`): a branch-row element like a voltage
 *     source. Implements asrcload.c:93-107 (the V-mode branch of ASRCload).
 *   - `BI` — I-mode (`ASRC_CURRENT`): an RHS-only element like a current
 *     source. Implements asrcload.c:108-119 (the I-mode branch).
 *
 * Both build their parse tree (the `CompiledBSourceTree` IFeval surface,
 * `expression.ts buildBSourceTree`) at construction, resolve their N
 * controlling-variable row indices at `setup()` (asrcset.c:92-119), evaluate
 * the tree once per NR iteration for `rhs` + the per-variable partials
 * (asrcload.c:80), and stamp the linearized companion model.
 *
 * Both subclass `AnalogElement` directly (NOT `ControlledSourceElement`, whose
 * single scalar control cannot host N controlling variables).
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type StandaloneComponentDefinition,
} from "../../core/registry.js";
import { AnalogElement } from "../../solver/analog/element.js";
import { buildBSourceTree } from "../../solver/analog/expression.js";
import type { CompiledBSourceTree, BSourceVar } from "../../solver/analog/expression.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SparseSolverStamp } from "../../solver/analog/sparse-solver.js";
import { MODETRANOP, MODETRAN, MODEINITSMSIG } from "../../solver/analog/ckt-mode.js";
import { defineModelParams } from "../../core/model-params.js";
import { kelvinToCelsius } from "../../core/model-params.js";

/** ngspice CONSTCtoK (const.h): Celsius→Kelvin offset for the `temp` param. */
const CONSTCtoK = 273.15;

/** ngspice ASRCload reference temperature: the literal `300.15` hardcoded at
 *  asrcload.c:41 (ngspice's own source annotates this constant as suspect;
 *  reproduced exactly here for bit-parity). */
const ASRC_REF_TEMP = 300.15;

// ---------------------------------------------------------------------------
// Shared model parameters (asrcset.c:46-55, asrctemp.c:23-26)
// ---------------------------------------------------------------------------

/**
 * The temperature + multiplier block both `BV` and `BI` carry (it is
 * topology-independent in ngspice — asrcset.c:46-55 applies to both modes).
 * All are instance-partition params so the harness deck emitter writes them as
 * per-instance tokens (`tc1=…`, `temp=…`, …). `temp` is Celsius-in /
 * Kelvin-internal: the deck converter subtracts 273.15 (asrcpar.c:50 adds it).
 */
function bsourceParamSpec() {
  return defineModelParams({
    primary: {},
    instance: {
      // asrcset.c:46-47 default 0; asrcpar.c:30-31 ASRCtc1Given.
      TC1: { default: 0.0, spiceName: "tc1", description: "First-order temperature coefficient" },
      // asrcset.c:48-49 default 0; asrcpar.c:34-35.
      TC2: { default: 0.0, spiceName: "tc2", description: "Second-order temperature coefficient" },
      // asrcset.c:54-55 default 1; asrcpar.c:38-39.
      M: { default: 1.0, spiceName: "m", description: "Output multiplier" },
      // asrcset.c:50-51 default 0; asrcpar.c:42-43. Emitted as a value (0/1).
      RECIPROCTC: { default: 0, spiceName: "reciproctc", description: "Use 1/tc factor" },
      // asrcset.c:52-53 default 0; asrcpar.c:46-47.
      RECIPROCM: { default: 0, spiceName: "reciprocm", description: "Divide by m instead of multiply" },
      // asrctemp.c:23-24 default CKTtemp; asrcpar.c:50-51 (+CONSTCtoK), emitted in Celsius.
      TEMP: { default: CONSTCtoK + 27, spiceName: "temp", spiceConverter: kelvinToCelsius, description: "Instance temperature" },
      // asrctemp.c:26 default 0; asrcpar.c:54-55.
      DTEMP: { default: 0.0, spiceName: "dtemp", description: "Delta temperature" },
    },
  });
}

const { paramDefs: BSOURCE_PARAM_DEFS, defaults: BSOURCE_DEFAULTS } = bsourceParamSpec();

export const BV_PARAM_DEFS = BSOURCE_PARAM_DEFS;
export const BV_DEFAULTS = BSOURCE_DEFAULTS;
export const BI_PARAM_DEFS = BSOURCE_PARAM_DEFS;
export const BI_DEFAULTS = BSOURCE_DEFAULTS;

// ---------------------------------------------------------------------------
// Shared instance state + temperature/srcFact factor
// ---------------------------------------------------------------------------

/**
 * Common per-instance state and helpers shared by `BV` and `BI`. Holds the
 * hot-loadable temperature/multiplier params with their ngspice `*Given`
 * flags, the parsed tree, the per-controller scratch buffers, the convergence
 * `prev_value`, and the AC-precompute store (asrcdefs.h:39-47).
 */
abstract class BSourceAnalogElement extends AnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.ASRC;
  readonly deviceFamily: DeviceFamily = "ASRC";

  protected readonly _tree: CompiledBSourceTree;

  /** Resolved 1-based row indices of the N controllers (ngspice ASRCvars[]). */
  protected readonly _vars: number[];
  /** Per-controller values from the prior NR iterate (ngspice asrc_vals[]). */
  protected readonly _vals: Float64Array;
  /** Stored derivs + factor*rhs for AC reload (ngspice ASRCacValues[], len numVars+1). */
  protected readonly _acValues: Float64Array;
  /** Last evaluated rhs, for the convergence test (ngspice ASRCprev_value). */
  protected _prevValue = 0;

  // Temperature / multiplier params (asrcset.c:46-55) with *Given flags.
  protected _tc1 = 0.0;          protected _tc1Given = false;
  protected _tc2 = 0.0;          protected _tc2Given = false;
  protected _m = 1.0;            protected _mGiven = false;
  protected _reciproctc = 0;     protected _reciproctcGiven = false;
  protected _reciprocm = 0;      protected _reciprocmGiven = false;
  protected _temp = CONSTCtoK + 27; protected _tempGiven = false;
  protected _dtemp = 0.0;        protected _dtempGiven = false;

  constructor(pinNodes: ReadonlyMap<string, number>, tree: CompiledBSourceTree) {
    super(pinNodes);
    this._tree = tree;
    this._vars = new Array<number>(tree.numVars).fill(0);
    this._vals = new Float64Array(tree.numVars);
    this._acValues = new Float64Array(tree.numVars + 1);
  }

  /**
   * Hot-loadable param write (asrcpar.c:29-56): store the value and set the
   * matching `*Given` flag so the next `load()` recomputes `factor`. `temp` is
   * Celsius-in / Kelvin-internal (asrcpar.c:50 `+ CONSTCtoK`).
   */
  setParam(key: string, value: number): void {
    switch (key) {
      case "TC1": this._tc1 = value; this._tc1Given = true; break;
      case "TC2": this._tc2 = value; this._tc2Given = true; break;
      case "M": this._m = value; this._mGiven = true; break;
      case "RECIPROCTC": this._reciproctc = value; this._reciproctcGiven = true; break;
      case "RECIPROCM": this._reciprocm = value; this._reciprocmGiven = true; break;
      case "TEMP": this._temp = value + CONSTCtoK; this._tempGiven = true; break;
      case "DTEMP": this._dtemp = value; this._dtempGiven = true; break;
    }
  }

  /**
   * Seed the params + `*Given` flags from the property bag at construction.
   * Only user-set params (isModelParamGiven) flip the `*Given` flag, matching
   * ngspice's parse-time *Given semantics (asrcpar.c).
   */
  seedParams(props: PropertyBag): void {
    // given(k) ⇒ the param was explicitly set ⇒ it is present in the bag, so
    // read() dereferences it directly (asrcpar.c parse-time *Given semantics).
    const given = (k: string): boolean => props.isModelParamGiven(k);
    const read = (k: string): number => props.getModelParam<number>(k);
    if (given("TC1")) { this._tc1 = read("TC1"); this._tc1Given = true; }
    if (given("TC2")) { this._tc2 = read("TC2"); this._tc2Given = true; }
    if (given("M")) { this._m = read("M"); this._mGiven = true; }
    if (given("RECIPROCTC")) { this._reciproctc = read("RECIPROCTC"); this._reciproctcGiven = true; }
    if (given("RECIPROCM")) { this._reciprocm = read("RECIPROCM"); this._reciprocmGiven = true; }
    if (given("TEMP")) { this._temp = read("TEMP") + CONSTCtoK; this._tempGiven = true; }
    if (given("DTEMP")) { this._dtemp = read("DTEMP"); this._dtempGiven = true; }
  }

  /**
   * asrctemp.c:23-31 — resolve the instance temperature against the circuit
   * temperature: `temp` unset ⇒ use `ctx.temp` (CKTtemp) and `dtemp` defaults
   * to 0; `temp` set ⇒ `dtemp` is forced to 0.
   */
  protected _resolveTemp(ctx: LoadContext): { temp: number; dtemp: number } {
    if (!this._tempGiven) {
      return { temp: ctx.temp, dtemp: this._dtempGiven ? this._dtemp : 0.0 };
    }
    return { temp: this._temp, dtemp: 0.0 };
  }

  /**
   * The temperature + multiplier factor (asrcload.c:41-52) plus the
   * MODETRANOP-only srcFact ramp (asrcload.c:58). The gate is narrower than the
   * independent-source ramp: asrc ramps ONLY during the transient operating-
   * point solve, not the DC operating point or the DC-transfer-curve sweep.
   */
  protected _factor(ctx: LoadContext): number {
    const { temp, dtemp } = this._resolveTemp(ctx);
    // asrcload.c:41 — difference against the hardcoded 300.15 reference.
    const difference = (temp + dtemp) - ASRC_REF_TEMP;
    // asrcload.c:42-44 — quadratic temperature coefficient.
    let factor = 1.0 + this._tc1 * difference + this._tc2 * difference * difference;
    // asrcload.c:46-47 — reciprocal-tc.
    if (this._reciproctc === 1) factor = 1 / factor;
    // asrcload.c:49-52 — divide-vs-multiply by m.
    if (this._reciprocm === 1) factor = factor / this._m;
    else factor = factor * this._m;
    // asrcload.c:58 — MODETRANOP-only source-ramp factor.
    if (ctx.cktMode & MODETRANOP) {
      factor *= ctx.srcFact;
    }
    return factor;
  }

  /**
   * The AC-path temperature + multiplier factor (asrcacld.c:34-45): identical
   * to `_factor` minus the MODETRANOP srcFact gate (the ramp is transient-only,
   * not re-applied during the AC sweep).
   */
  protected _acFactor(ctx: LoadContext): number {
    const { temp, dtemp } = this._resolveTemp(ctx);
    const difference = (temp + dtemp) - ASRC_REF_TEMP;
    let factor = 1.0 + this._tc1 * difference + this._tc2 * difference * difference;
    if (this._reciproctc === 1) factor = 1 / factor;
    if (this._reciprocm === 1) factor = factor / this._m;
    else factor = factor * this._m;
    return factor;
  }

  /**
   * Evaluate the parse tree at the prior NR iterate (asrcload.c:77-80):
   * fill `_vals[i] = rhsOld[_vars[i]]`, then run the single IFeval returning
   * `{ rhs, derivs }`. Captures `_prevValue` (asrcload.c:86) for the
   * convergence test, and the AC partials under MODEINITSMSIG (asrcload.c:89-91).
   */
  protected _evalTree(ctx: LoadContext): { rhs: number; derivs: number[] } {
    for (let i = 0; i < this._tree.numVars; i++) {
      this._vals[i] = ctx.rhsOld[this._vars[i]!] ?? 0;
    }
    const ev = this._tree.eval({
      vals: this._vals,
      gmin: ctx.cktGmin,
      time: ctx.time,
      temp: ctx.temp,
      modeTran: (ctx.cktMode & MODETRAN) !== 0,
    });
    this._prevValue = ev.rhs;
    if (ctx.cktMode & MODEINITSMSIG) {
      for (let i = 0; i < this._tree.numVars; i++) this._acValues[i] = ev.derivs[i]!;
    }
    return ev;
  }

  /**
   * Re-evaluate the tree and run the ngspice convergence test
   * (asrcconv.c:34-55): `diff = |prev - rhs|`,
   * `tol = reltol*MAX(|rhs|,|prev|) + (voltTol | abstol)`, non-converged on
   * `diff > tol`. The voltage / current tolerance choice is the subclass's.
   */
  checkConvergence(ctx: LoadContext): boolean {
    for (let i = 0; i < this._tree.numVars; i++) {
      this._vals[i] = ctx.rhsOld[this._vars[i]!] ?? 0;
    }
    const ev = this._tree.eval({
      vals: this._vals,
      gmin: ctx.cktGmin,
      time: ctx.time,
      temp: ctx.temp,
      modeTran: (ctx.cktMode & MODETRAN) !== 0,
    });
    const rhs = ev.rhs;
    const prev = this._prevValue;
    const diff = Math.abs(prev - rhs);
    const tol = ctx.reltol * Math.max(Math.abs(rhs), Math.abs(prev)) + this._convAbsTol(ctx);
    const converged = !(diff > tol);
    if (ctx.convergenceCollector) {
      ctx.convergenceCollector.push({
        elementIndex: this.elementIndex ?? -1,
        label: this.label,
        converged,
        delta: diff,
        tol,
      });
    }
    if (!converged) ctx.noncon.value++;
    return converged;
  }

  /** Resolve one controller's 1-based row index (asrcset.c:95-109). */
  protected _resolveVarRow(ctx: SetupContext, v: BSourceVar): number {
    if (v.kind === "branch") {
      // IF_INSTANCE: the controlling source's branch row (asrcset.c:97-102).
      const column = ctx.findBranch(v.label);
      if (column === 0) {
        throw new Error(`${this.label || "B"}: unknown controlling source ${v.label}`);
      }
      return column;
    }
    // Composite path: a controller whose label matches one of this element's
    // own pins binds to that pin's resolved node — the parent subcircuit wires
    // it by connectivity (compiler.ts:568-576), so the flat-circuit net-label
    // map never carries the (prefixed, colon-bearing) internal net name.
    const pinNode = this.pinNodes.get(v.label);
    if (pinNode !== undefined) return pinNode;
    // IF_NODE: the controlling net's node id (asrcset.c:104-105).
    const column = ctx.findNode(v.label);
    if (column === 0) {
      throw new Error(`${this.label || "B"}: unknown controlling node ${v.label}`);
    }
    return column;
  }

  /** Convergence absolute-tolerance term: voltTol (BV) / abstol (BI). */
  protected abstract _convAbsTol(ctx: LoadContext): number;
}

// ---------------------------------------------------------------------------
// BV — V-mode (branch-row) element
// ---------------------------------------------------------------------------

/**
 * V-mode behavioural source: `V = f(...)`. A branch-row element like a voltage
 * source; ports asrcset.c:77-119 (V-branches) and asrcload.c:93-107.
 */
export class BVAnalogElement extends BSourceAnalogElement {
  // asrcset.c:86-89 — branch-incidence handles, in exact order.
  private _hPosBr = -1; // (posNode, branch)  :86
  private _hNegBr = -1; // (negNode, branch)  :87
  private _hBrNeg = -1; // (branch, negNode)  :88
  private _hBrPos = -1; // (branch, posNode)  :89
  // asrcset.c:114 — one (branch, column) Jacobian handle per controller.
  private _varHandles: number[] = [];

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const posNode = this.pinNodes.get("out+")!; // ASRCposNode
    const negNode = this.pinNodes.get("out-")!; // ASRCnegNode

    // asrcset.c:40-44 — a V-mode ASRC across a single node is a shorted source.
    if (posNode === negNode) {
      throw new Error(`instance ${this.label || "bv"} is a shorted ASRC`);
    }

    // asrcset.c:79-84 — branch row allocation (idempotent makeCur guard).
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this.label || "bv", "branch");
    }
    const branch = this.branchIndex;

    // asrcset.c:86-89 — branch incidence, exact handle order.
    this._hPosBr = solver.allocElement(posNode, branch); // :86
    this._hNegBr = solver.allocElement(negNode, branch); // :87
    this._hBrNeg = solver.allocElement(branch, negNode); // :88
    this._hBrPos = solver.allocElement(branch, posNode); // :89

    // asrcset.c:92-119 — one Jacobian column per controlling variable.
    this._varHandles = new Array<number>(this._tree.numVars);
    for (let i = 0; i < this._tree.numVars; i++) {
      const column = this._resolveVarRow(ctx, this._tree.vars[i]!); // asrcset.c:95-109
      this._vars[i] = column;                                       // asrcset.c:111
      this._varHandles[i] = solver.allocElement(branch, column);    // asrcset.c:114
    }
  }

  override load(ctx: LoadContext): void {
    const factor = this._factor(ctx);          // Part D temp + srcFact
    const ev = this._evalTree(ctx);            // asrcload.c:77-91
    let rhs = ev.rhs;
    const derivs = ev.derivs;
    const solver = ctx.solver;

    // asrcload.c:95-98 — branch incidence ±1.
    solver.stampElement(this._hPosBr, 1.0);
    solver.stampElement(this._hNegBr, -1.0);
    solver.stampElement(this._hBrNeg, -1.0);
    solver.stampElement(this._hBrPos, 1.0);

    // asrcload.c:100-104 — one Jacobian column + RHS correction per controller,
    // in exact accumulation order (the rhs -= sum is FP-order-sensitive).
    for (let i = 0; i < this._tree.numVars; i++) {
      rhs -= this._vals[i]! * derivs[i]!;                              // asrcload.c:101
      solver.stampElement(this._varHandles[i]!, -derivs[i]! * factor); // asrcload.c:103
    }

    // asrcload.c:106 — branch RHS.
    ctx.rhs[this.branchIndex] += factor * rhs;

    // asrcload.c:122-123 — AC rhs store (factor*rhs), MODEINITSMSIG only.
    if (ctx.cktMode & MODEINITSMSIG) {
      this._acValues[this._tree.numVars] = factor * rhs;
    }
  }

  /**
   * AC reload (asrcacld.c:57-65): stamp ONLY the Jacobian (no RHS), reading the
   * stored partials `_acValues[i]` with the AC factor (no MODETRANOP srcFact).
   * The asrc AC Jacobian is frequency-independent, so `omega` is unused; the
   * branch incidence + controller columns are the same conductance pattern at
   * every frequency.
   */
  stampAc(
    solver: SparseSolverStamp,
    _omega: number,
    ctx: LoadContext,
    _rhsRe: Float64Array,
    _rhsIm: Float64Array,
  ): void {
    const factor = this._acFactor(ctx);
    solver.stampElement(this._hPosBr, 1.0);  // asrcacld.c:59
    solver.stampElement(this._hNegBr, -1.0); // asrcacld.c:60
    solver.stampElement(this._hBrNeg, -1.0); // asrcacld.c:61
    solver.stampElement(this._hBrPos, 1.0);  // asrcacld.c:62
    for (let i = 0; i < this._tree.numVars; i++) {
      solver.stampElement(this._varHandles[i]!, -this._acValues[i]! * factor); // asrcacld.c:64-65
    }
  }

  /**
   * Lazy branch-row allocation hook (ASRCfindBr, asrcfbr.c:14-35): another
   * device naming this BV as a current controller resolves its branch row,
   * allocating it on first request regardless of setup order.
   */
  override findBranchFor(_name: string, ctx: SetupContext): number {
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this.label || "bv", "branch");
    }
    return this.branchIndex;
  }

  // asrcconv.c:45-46 — voltage form uses CKTvoltTol.
  protected _convAbsTol(ctx: LoadContext): number {
    return ctx.voltTol;
  }

  /** Per-pin currents [out+, out-]: the branch variable, leaving out+/arriving out-. */
  getPinCurrents(rhs: Float64Array): number[] {
    const iOut = this.branchIndex >= 0 ? rhs[this.branchIndex]! : 0;
    return [iOut, -iOut];
  }
}

// ---------------------------------------------------------------------------
// BI — I-mode (RHS-only) element
// ---------------------------------------------------------------------------

/**
 * I-mode behavioural source: `I = f(...)`. An RHS-only element like a current
 * source; ports asrcset.c:92-118 (I-branches) and asrcload.c:108-119. Owns no
 * branch row.
 */
export class BIAnalogElement extends BSourceAnalogElement {
  // asrcset.c:116-117 — two (node, column) Jacobian handles per controller.
  private _varHandlesPos: number[] = [];
  private _varHandlesNeg: number[] = [];

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const posNode = this.pinNodes.get("out+")!; // ASRCposNode
    const negNode = this.pinNodes.get("out-")!; // ASRCnegNode

    // asrcset.c:92-118 — two Jacobian columns per controlling variable; no branch.
    this._varHandlesPos = new Array<number>(this._tree.numVars);
    this._varHandlesNeg = new Array<number>(this._tree.numVars);
    for (let i = 0; i < this._tree.numVars; i++) {
      const column = this._resolveVarRow(ctx, this._tree.vars[i]!); // asrcset.c:95-109
      this._vars[i] = column;                                       // asrcset.c:111
      this._varHandlesPos[i] = solver.allocElement(posNode, column); // asrcset.c:116
      this._varHandlesNeg[i] = solver.allocElement(negNode, column); // asrcset.c:117
    }
  }

  override load(ctx: LoadContext): void {
    const factor = this._factor(ctx);
    const ev = this._evalTree(ctx);
    let rhs = ev.rhs;
    const derivs = ev.derivs;
    const solver = ctx.solver;
    const posNode = this.pinNodes.get("out+")!;
    const negNode = this.pinNodes.get("out-")!;

    // asrcload.c:110-115 — two Jacobian columns + RHS correction per controller.
    for (let i = 0; i < this._tree.numVars; i++) {
      rhs -= this._vals[i]! * derivs[i]!;                                  // asrcload.c:111
      solver.stampElement(this._varHandlesPos[i]!, derivs[i]! * factor);  // asrcload.c:113
      solver.stampElement(this._varHandlesNeg[i]!, -derivs[i]! * factor); // asrcload.c:114
    }

    // asrcload.c:117-118 — output-node RHS pair (SPICE source convention).
    ctx.rhs[posNode] -= factor * rhs;
    ctx.rhs[negNode] += factor * rhs;

    // asrcload.c:122-123 — AC rhs store, MODEINITSMSIG only.
    if (ctx.cktMode & MODEINITSMSIG) {
      this._acValues[this._tree.numVars] = factor * rhs;
    }
  }

  /**
   * AC reload (asrcacld.c:67-72): stamp the two Jacobian columns per controller
   * from the stored partials `_acValues[i]` with the AC factor; no RHS. The asrc
   * AC Jacobian is frequency-independent, so `omega` is unused.
   */
  stampAc(
    solver: SparseSolverStamp,
    _omega: number,
    ctx: LoadContext,
    _rhsRe: Float64Array,
    _rhsIm: Float64Array,
  ): void {
    const factor = this._acFactor(ctx);
    for (let i = 0; i < this._tree.numVars; i++) {
      solver.stampElement(this._varHandlesPos[i]!, this._acValues[i]! * factor);  // asrcacld.c:70
      solver.stampElement(this._varHandlesNeg[i]!, -this._acValues[i]! * factor); // asrcacld.c:71
    }
  }

  // asrcconv.c:48-49 — current form uses CKTabstol.
  protected _convAbsTol(ctx: LoadContext): number {
    return ctx.iabstol;
  }

  /** Per-pin currents [out+, out-]: f(...) leaves out+, arrives out- (G-element convention). */
  getPinCurrents(_rhs: Float64Array): number[] {
    return [-this._prevValue, this._prevValue];
  }
}

// ---------------------------------------------------------------------------
// Pin layout (shared 2-pin output port)
// ---------------------------------------------------------------------------

function buildBSourcePinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.OUTPUT,
      label: "out+",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "out-",
      defaultBitWidth: 1,
      position: { x: 4, y: 2 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// CircuitElement wrappers (editor-facing)
// ---------------------------------------------------------------------------

class BSourceCircuitElement extends AbstractCircuitElement {
  constructor(
    typeName: string,
    private readonly _outputKey: "V" | "I",
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super(typeName, instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildBSourcePinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y - 1, width: 4, height: 4 };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vOutP = signals?.getPinVoltage("out+");
    const vOutN = signals?.getPinVoltage("out-");

    ctx.save();
    ctx.setLineWidth(1);
    ctx.setColor("COMPONENT");
    // Diamond-ish source body.
    ctx.drawLine(2, -1, 4, 1);
    ctx.drawLine(4, 1, 2, 3);
    ctx.drawLine(2, 3, 0, 1);
    ctx.drawLine(0, 1, 2, -1);

    drawColoredLead(ctx, signals, vOutP, 4, 0, 4, 0);
    drawColoredLead(ctx, signals, vOutN, 4, 2, 4, 2);

    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText(this._outputKey, 2, 1, { horizontal: "center", vertical: "middle" });
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Property + attribute definitions
// ---------------------------------------------------------------------------

function bsourcePropertyDefs(outputKey: "V" | "I"): PropertyDefinition[] {
  return [
    {
      key: "expression",
      type: PropertyType.STRING,
      label: outputKey === "V" ? "Output voltage" : "Output current",
      defaultValue: "0",
      description:
        `Behavioural expression for the output ${outputKey === "V" ? "voltage" : "current"}, ` +
        `over node voltages V(net) and branch currents I(source).`,
    },
    {
      key: "label",
      type: PropertyType.STRING,
      label: "Label",
      defaultValue: "",
      description: "Optional display label.",
    },
  ];
}

const BSOURCE_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "expression", propertyKey: "expression", convert: (v) => v },
  { xmlName: "tc1", propertyKey: "TC1", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "tc2", propertyKey: "TC2", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "m", propertyKey: "M", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "reciproctc", propertyKey: "RECIPROCTC", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "reciprocm", propertyKey: "RECIPROCM", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "temp", propertyKey: "TEMP", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "dtemp", propertyKey: "DTEMP", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// Component definitions
// ---------------------------------------------------------------------------

export const BVDefinition: StandaloneComponentDefinition = {
  name: "BV",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildBSourcePinDeclarations(),
  voltageProbes: [{ name: "V", pos: "out+", neg: "out-" }],
  propertyDefs: bsourcePropertyDefs("V"),
  attributeMap: BSOURCE_ATTRIBUTE_MAPPINGS,

  helpText:
    "Behavioural voltage source (SPICE B-element, V=expr) — output voltage is " +
    "an arbitrary expression over node voltages V(net) and branch currents I(source).",

  factory(props: PropertyBag): BSourceCircuitElement {
    return new BSourceCircuitElement("BV", "V", crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    behavioral: {
      kind: "inline",
      factory: (pinNodes, props) => {
        const exprText = props.getOrDefault<string>("expression", "0");
        const tree = buildBSourceTree(exprText);
        const el = new BVAnalogElement(pinNodes, tree);
        el.seedParams(props);
        return el;
      },
      paramDefs: BV_PARAM_DEFS,
      params: BV_DEFAULTS,
      spice: { device: "ASRC", deckNodeTokens: ["out+", "out-"] },
    },
  },
  defaultModel: "behavioral",
};

export const BIDefinition: StandaloneComponentDefinition = {
  name: "BI",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildBSourcePinDeclarations(),
  voltageProbes: [{ name: "V", pos: "out+", neg: "out-" }],
  propertyDefs: bsourcePropertyDefs("I"),
  attributeMap: BSOURCE_ATTRIBUTE_MAPPINGS,

  helpText:
    "Behavioural current source (SPICE B-element, I=expr) — output current is " +
    "an arbitrary expression over node voltages V(net) and branch currents I(source).",

  factory(props: PropertyBag): BSourceCircuitElement {
    return new BSourceCircuitElement("BI", "I", crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    behavioral: {
      kind: "inline",
      factory: (pinNodes, props) => {
        const exprText = props.getOrDefault<string>("expression", "0");
        const tree = buildBSourceTree(exprText);
        const el = new BIAnalogElement(pinNodes, tree);
        el.seedParams(props);
        return el;
      },
      paramDefs: BI_PARAM_DEFS,
      params: BI_DEFAULTS,
      spice: { device: "ASRC", deckNodeTokens: ["out+", "out-"] },
    },
  },
  defaultModel: "behavioral",
};
