/**
 * Hyst — bit-exact port of the ngspice XSPICE `hyst` analog code model
 * (ref/ngspice/src/xspice/icm/analog/hyst/cfunc.mod cm_hyst) together with the
 * MIF framework's voltage-output realization
 * (ref/ngspice/src/xspice/mif/mifload.c).
 *
 * `hyst` is a continuous, differentiable hysteresis transfer: analog `in` →
 * analog `out`, with a linear region of `slope = (out_upper-out_lower)/
 * (in_high-in_low)` between the rails, parabolic corner smoothing
 * (cm_smooth_corner, cmutil.c:77-104) to keep d(out)/d(in) continuous, and a
 * single leg-state bit (X_RISING / X_FALLING) that supplies the hysteresis.
 * Because the model returns OUTPUT(out) + PARTIAL(out,in), the analog solver
 * converges it and bounds it with LTE natively- there are NO breakpoints.
 *
 * Stamp (mifload.c): a `v`-type code-model output is a branch voltage source
 * (mifload.c:509-514): branch incidence ±1 and `rhs[branch] += out`. The
 * input partial for a v-output / v-controller pair is case `e`
 * (mifload.c:604-612): `(branch,inNode) -= pout_pin` and
 * `rhs[branch] -= pout_pin * V(in)`. This is the BV-source branch companion
 * (bsource.ts:368-382) with `factor ≡ 1`- a code-model output is NOT
 * source-ramped and carries no temperature coefficients, so the asrc
 * temp/srcFact factor is deliberately absent.
 */

import { PoolBackedAnalogElement } from "../../solver/analog/element.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { SparseSolverStamp } from "../../solver/analog/sparse-solver.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import { MODEINITSMSIG } from "../../solver/analog/ckt-mode.js";
import { defineStateSchema } from "../../solver/analog/state-schema.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";
import type { PropertyBag } from "../../core/properties.js";
import type { ComponentDefinition, ParamDef } from "../../core/registry.js";
import type { AnalogElement } from "../../solver/analog/element.js";

// ---------------------------------------------------------------------------
// State schema- one leg-state slot. Encoding: 0 = uninitialised (apply the
// cm_hyst INIT leg from the input, cfunc.mod:251-256), 1 = X_RISING,
// 2 = X_FALLING. The 0 sentinel survives the non-rotating DCOP so the INIT leg
// is consistent across its NR iterations; the committed leg takes over after
// the first transient state rotation (analog-engine.ts:412), exactly mirroring
// ngspice's old_hyst_state (cm_analog_get_ptr(TRUE,1)).
// ---------------------------------------------------------------------------

export const HYST_SCHEMA = defineStateSchema("HystElement", [
  { name: "HYST_STATE", doc: "Hysteresis leg: 0=uninit, 1=X_RISING, 2=X_FALLING." },
]);

const SLOT_HYST_STATE = HYST_SCHEMA.indexOf.get("HYST_STATE")!;

const STATE_RISING = 1;
const STATE_FALLING = 2;

// ---------------------------------------------------------------------------
// Pin layout. `in` is a high-Z voltage sense (v controller, neg=gnd); `out` is
// the branch voltage-source output (pos=out, neg=gnd). gnd is the shared
// reference (resolves to MNA node 0 via the reserved-port rule when embedded).
// ---------------------------------------------------------------------------

const HYST_PIN_LAYOUT: PinDeclaration[] = [
  { kind: "signal", direction: PinDirection.INPUT,  label: "in",  defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
  { kind: "signal", direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
  { kind: "signal", direction: PinDirection.INPUT,  label: "gnd", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
];

const HYST_PARAM_DEFS: ParamDef[] = [
  { key: "in_low",          default: 0.0 },
  { key: "in_high",         default: 1.0 },
  { key: "hyst",            default: 0.1 },
  { key: "out_lower_limit", default: 0.0 },
  { key: "out_upper_limit", default: 1.0 },
  { key: "input_domain",    default: 0.01 },
  // boolean: 1 = TRUE (domain is a fraction of in_high-in_low). ngspice's MIF
  // boolean param parser wants the TRUE/FALSE keyword on the `.model` card.
  { key: "fraction",        default: 1, spiceConverter: (v: number) => (v ? "TRUE" : "FALSE") },
];

/**
 * cm_smooth_corner (cmutil.c:77-104): parabolic blend joining `lower_slope`
 * into `upper_slope` across [x_center, x_center+domain], returning the smoothed
 * y and its derivative. Transcribed term-for-term.
 */
function cmSmoothCorner(
  xInput: number,
  xCenter: number,
  yCenter: number,
  domain: number,
  lowerSlope: number,
  upperSlope: number,
): { y: number; dydx: number } {
  const xUpper = xCenter + domain;
  const yUpper = yCenter + upperSlope * domain;
  const a = ((upperSlope - lowerSlope) / 4.0) * (1 / domain);
  const b = upperSlope - 2.0 * a * xUpper;
  const c = yUpper - a * xUpper * xUpper - b * xUpper;
  const dydx = 2.0 * a * xInput + b;
  const y = a * xInput * xInput + b * xInput + c;
  return { y, dydx };
}

// ---------------------------------------------------------------------------
// HystElement
// ---------------------------------------------------------------------------

export class HystElement extends PoolBackedAnalogElement {
  // XSPICE 'A'-device code model: ngspice appends it to DEVices[] after the
  // static built-ins, and a circuit containing one tightens LTE (CKTadevFlag →
  // CKTtrtol = 1, cktdojob.c:77-92), which the analog engine mirrors for the
  // XSPICE device family.
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.XSPICE;
  readonly deviceFamily: DeviceFamily = "XSPICE";
  readonly stateSchema = HYST_SCHEMA;
  readonly stateSize = HYST_SCHEMA.size;

  private _inLow: number;
  private _inHigh: number;
  private _hyst: number;
  private _outLower: number;
  private _outUpper: number;
  private _inputDomain: number;
  private _fraction: number;

  // mifload.c:509-514 branch incidence handles, plus the case-`e` (branch,in)
  // partial handle (mifload.c:610).
  private _hPosBr = -1; // (out, branch)
  private _hNegBr = -1; // (gnd, branch)
  private _hBrPos = -1; // (branch, out)
  private _hBrNeg = -1; // (branch, gnd)
  private _hBrIn  = -1; // (branch, in)

  private _inNode = -1;

  /** Stored OP partial for the AC reload (asrc-style _acValues analogue). */
  private _acGain = 0;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._inLow       = props.getModelParam<number>("in_low");
    this._inHigh      = props.getModelParam<number>("in_high");
    this._hyst        = props.getModelParam<number>("hyst");
    this._outLower    = props.getModelParam<number>("out_lower_limit");
    this._outUpper    = props.getModelParam<number>("out_upper_limit");
    this._inputDomain = props.getModelParam<number>("input_domain");
    this._fraction    = props.getModelParam<number>("fraction");
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
    const outNode = this.pinNodes.get("out")!;
    const gndNode = this.pinNodes.get("gnd")!;
    this._inNode = this.pinNodes.get("in")!;

    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this.label || "hyst", "branch");
    }
    const branch = this.branchIndex;

    // mifload.c:509-512 branch incidence, exact handle order.
    this._hPosBr = ctx.solver.allocElement(outNode, branch);
    this._hNegBr = ctx.solver.allocElement(gndNode, branch);
    this._hBrPos = ctx.solver.allocElement(branch, outNode);
    this._hBrNeg = ctx.solver.allocElement(branch, gndNode);
    // mifload.c:610 case-`e` (branch, controller) partial column.
    this._hBrIn = ctx.solver.allocElement(branch, this._inNode);
  }

  setParam(key: string, value: number): void {
    switch (key) {
      case "in_low":          this._inLow = value; break;
      case "in_high":         this._inHigh = value; break;
      case "hyst":            this._hyst = value; break;
      case "out_lower_limit": this._outLower = value; break;
      case "out_upper_limit": this._outUpper = value; break;
      case "input_domain":    this._inputDomain = value; break;
      case "fraction":        this._fraction = value; break;
    }
  }

  /**
   * Evaluate cm_hyst (cfunc.mod:211-340): returns the output, its partial, and
   * the (possibly flipped) leg state. `oldRising` is the committed leg.
   */
  private _evalHyst(vIn: number, oldRising: boolean): { out: number; pout: number; newRising: boolean } {
    // cfunc.mod:216-225 derived values.
    const slope = (this._outUpper - this._outLower) / (this._inHigh - this._inLow);
    const xRiseLinear = this._inLow + this._hyst;
    const xRiseZero = this._inHigh + this._hyst;
    const xFallLinear = this._inHigh - this._hyst;
    const xFallZero = this._inLow - this._hyst;
    // cfunc.mod:227-228 fraction → absolute domain.
    const dom = this._fraction !== 0 ? this._inputDomain * (this._inHigh - this._inLow) : this._inputDomain;

    let out: number;
    let pout: number;
    let newRising = oldRising;

    if (oldRising) {
      // cfunc.mod:278-309 lower leg, x rising.
      if (vIn <= xRiseLinear - dom) {
        out = this._outLower; pout = 0.0;
      } else if (vIn <= xRiseLinear + dom) {
        const r = cmSmoothCorner(vIn, xRiseLinear, this._outLower, dom, 0.0, slope);
        out = r.y; pout = r.dydx;
      } else if (vIn <= xRiseZero - dom) {
        out = (vIn - xRiseLinear) * slope + this._outLower; pout = slope;
      } else if (vIn <= xRiseZero + dom) {
        const r = cmSmoothCorner(vIn, xRiseZero, this._outUpper, dom, slope, 0.0);
        out = r.y; pout = r.dydx;
      } else {
        out = this._outUpper; pout = 0.0; newRising = false; // → X_FALLING
      }
    } else {
      // cfunc.mod:310-340 upper leg, x falling.
      if (vIn >= xFallLinear + dom) {
        out = this._outUpper; pout = 0.0;
      } else if (vIn >= xFallLinear - dom) {
        const r = cmSmoothCorner(vIn, xFallLinear, this._outUpper, dom, slope, 0.0);
        out = r.y; pout = r.dydx;
      } else if (vIn >= xFallZero + dom) {
        out = (vIn - xFallZero) * slope + this._outLower; pout = slope;
      } else if (vIn >= xFallZero - dom) {
        const r = cmSmoothCorner(vIn, xFallZero, this._outLower, dom, 0.0, slope);
        out = r.y; pout = r.dydx;
      } else {
        out = this._outLower; pout = 0.0; newRising = true; // → X_RISING
      }
    }
    return { out, pout, newRising };
  }

  /** cfunc.mod:251-256 INIT leg from the input when the slot is uninitialised. */
  private _initRising(vIn: number): boolean {
    const xRiseZero = this._inHigh + this._hyst;
    const dom = this._fraction !== 0 ? this._inputDomain * (this._inHigh - this._inLow) : this._inputDomain;
    return vIn < xRiseZero + dom; // < ⇒ X_RISING
  }

  override load(ctx: LoadContext): void {
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;

    const vIn = ctx.rhsOld[this._inNode]!;

    // Committed leg (cm_hyst old_hyst_state); 0 ⇒ apply INIT from input.
    const committed = s1[base + SLOT_HYST_STATE]!;
    const oldRising = committed < 0.5 ? this._initRising(vIn) : committed < 1.5;

    const { out, pout, newRising } = this._evalHyst(vIn, oldRising);

    const solver = ctx.solver;
    const branch = this.branchIndex;

    // mifload.c:509-512 branch incidence ±1.
    solver.stampElement(this._hPosBr, 1.0);
    solver.stampElement(this._hNegBr, -1.0);
    solver.stampElement(this._hBrPos, 1.0);
    solver.stampElement(this._hBrNeg, -1.0);

    // mifload.c:610 case-`e` partial (branch, in) -= pout.
    solver.stampElement(this._hBrIn, -pout);

    // mifload.c:514 output + :612 linearisation: rhs[branch] += out - pout*V(in).
    ctx.rhs[branch] += out - pout * vIn;

    if (ctx.cktMode & MODEINITSMSIG) {
      this._acGain = pout;
    }

    s0[base + SLOT_HYST_STATE] = newRising ? STATE_RISING : STATE_FALLING;
  }

  /**
   * AC reload (mifload.c case `e`, AC branch :604-607): stamp only the operating-
   * point partial into (branch, in); no RHS. The Jacobian is frequency-
   * independent, so `omega` is unused.
   */
  stampAc(
    solver: SparseSolverStamp,
    _omega: number,
    _ctx: LoadContext,
    _rhsRe: Float64Array,
    _rhsIm: Float64Array,
  ): void {
    solver.stampElement(this._hPosBr, 1.0);
    solver.stampElement(this._hNegBr, -1.0);
    solver.stampElement(this._hBrPos, 1.0);
    solver.stampElement(this._hBrNeg, -1.0);
    solver.stampElement(this._hBrIn, -this._acGain);
  }

  /** Per-pin currents [in, out, gnd]: in is a pure sense; the branch leaves out, arrives gnd. */
  getPinCurrents(rhs: Float64Array): number[] {
    const iBranch = this.branchIndex >= 0 ? rhs[this.branchIndex]! : 0;
    return [0, iBranch, -iBranch];
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const HystDefinition: ComponentDefinition = {
  name: "Hyst",
  typeId: -1,
  internalOnly: true,
  pinLayout: HYST_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: HYST_PARAM_DEFS,
      params: {},
      // Harness deck emission: `a<name> <in> <out> <model>` + `.model <model>
      // hyst (...)`. XSPICE code-model device family; in/out mint deck nodes in
      // this order (gnd is the implicit ground reference, node 0 when embedded).
      spice: { device: "XSPICE", deckNodeTokens: ["in", "out"] },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag): AnalogElement =>
        new HystElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
