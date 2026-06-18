/**
 * DacBridge — bit-exact port of the ngspice XSPICE `dac_bridge` digital code
 * model (ref/ngspice/src/xspice/icm/digital/dac_bridge/cfunc.mod) realized as a
 * MIF `v`-output branch (ref/ngspice/src/xspice/mif/mifload.c).
 *
 * `dac_bridge` is the digital→analog boundary device: it maps a digital input
 * level (ZERO/ONE/UNKNOWN) to an analog output that SLEWS toward the
 * corresponding rail (out_low/out_high/out_undef) at a finite rise/fall rate,
 * rather than stepping instantaneously. It is the faithful replacement for the
 * instantaneous `eDrive` VCVS the digital-output pin used before.
 *
 * Digital input (digiTS): ngspice's `in` port is a digital event stream- a
 * discrete state, never an analog voltage. We mirror that: the digital level is
 * delivered as a discrete control value `level` (0 = ZERO, 1 = ONE, 0.5 =
 * UNKNOWN), set per step by the digital side (the coordinator's value-transfer
 * role). The leaf maps the discrete state to its target rail. There is NO analog
 * input node and NO thresholding- classifying an analog voltage is adc_bridge's
 * job, not dac_bridge's; the level is an authoritative discrete state, so it
 * never enters the Jacobian.
 *
 * Slew (cfunc.mod:266-331): level_inc = out_high - out_low;
 *   rise_slope = level_inc / t_rise;  fall_slope = level_inc / t_fall.
 * Each transient step the output advances from the previous accepted output
 * toward the target by slope * dt, clamped at the target:
 *   target > out_old:  out = min(out_old + rise_slope*dt, target)
 *   target < out_old:  out = max(out_old - fall_slope*dt, target)
 * At DC/OP (dt = 0) the output snaps to the target (cfunc.mod:189-224, 273-287).
 *
 * Stamp (mifload.c:509-514): a `v`-type code-model output is a branch voltage
 * source- branch incidence ±1 and `rhs[branch] += out`. Unlike `hyst`, the
 * output is the slewed STATE (independent of present node voltages within the
 * step), so there is NO input partial column- exactly as dac_bridge computes
 * OUTPUT(out) with no PARTIAL.
 *
 * Breakpoints (cfunc.mod:259, 413-414): two forward permanent posts, exactly
 * mirroring ngspice's `cm_analog_set_perm_bkpt`:
 *   - on a level change, the change time (so the analog solver lands on it);
 *   - on an incomplete ramp, `TIME + when` (when = remaining / slope), so a
 *     step lands on the ramp corner. No temporary/backup breakpoints.
 */

import { PoolBackedAnalogElement } from "../../solver/analog/element.js";
import type { AnalogElement } from "../../solver/analog/element.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { SparseSolverStamp } from "../../solver/analog/sparse-solver.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import { defineStateSchema } from "../../solver/analog/state-schema.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";
import type { PropertyBag } from "../../core/properties.js";
import type { ComponentDefinition, ParamDef } from "../../core/registry.js";

// ---------------------------------------------------------------------------
// State schema- one slot: the slewed analog output level. state0 is this
// step's output, state1 the previous accepted output the ramp advances from
// (mirrors dac_bridge's cm_analog_alloc out/out_old history).
// ---------------------------------------------------------------------------

export const DAC_BRIDGE_SCHEMA = defineStateSchema("DacBridgeElement", [
  { name: "OUT_LEVEL", doc: "Slewed analog output level (V). state0=now, state1=prev accepted." },
]);

const SLOT_OUT_LEVEL = DAC_BRIDGE_SCHEMA.indexOf.get("OUT_LEVEL")!;

// Discrete digital-state decode of the `level` control value. `level` is an
// authoritative {0, 0.5, 1} state set by the digital side (never a sensed
// analog voltage); the bands map it to ZERO / UNKNOWN / ONE without analog
// thresholding semantics.
const LEVEL_ZERO_MAX = 0.25;
const LEVEL_ONE_MIN = 0.75;

// ---------------------------------------------------------------------------
// Pin layout. `out` is the branch voltage-source output; `gnd` the shared
// reference (resolves to MNA node 0 via the reserved-port rule when embedded).
// There is NO analog input pin- the digital state arrives via the `level`
// param, mirroring ngspice's digital `in` port.
// ---------------------------------------------------------------------------

const DAC_BRIDGE_PIN_LAYOUT: PinDeclaration[] = [
  { kind: "signal", direction: PinDirection.OUTPUT, label: "out", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
  { kind: "signal", direction: PinDirection.INPUT,  label: "gnd", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
];

const DAC_BRIDGE_PARAM_DEFS: ParamDef[] = [
  { key: "out_low",    default: 0.0 },
  { key: "out_high",   default: 1.0 },
  { key: "out_undef",  default: 0.5 },
  { key: "t_rise",     default: 1.0e-9 },
  { key: "t_fall",     default: 1.0e-9 },
  // Discrete digital input state (0=ZERO, 1=ONE, 0.5=UNKNOWN), set per step by
  // the digital side. ngspice's `in` is a digital event; this is its carrier.
  { key: "level",      default: 0.0 },
];

// ---------------------------------------------------------------------------
// DacBridgeElement
// ---------------------------------------------------------------------------

export class DacBridgeElement extends PoolBackedAnalogElement {
  // XSPICE 'A'-device code model (same device class as hyst): ngspice appends it
  // to DEVices[] after the static built-ins and tightens LTE for the circuit
  // (CKTadevFlag -> CKTtrtol = 1, cktdojob.c:77-92), which the engine mirrors.
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.XSPICE;
  readonly deviceFamily: DeviceFamily = "XSPICE";
  readonly stateSchema = DAC_BRIDGE_SCHEMA;
  readonly stateSize = DAC_BRIDGE_SCHEMA.size;

  private _outLow: number;
  private _outHigh: number;
  private _outUndef: number;
  private _tRise: number;
  private _tFall: number;
  private _level: number;

  // mifload.c:509-512 branch incidence handles (no partial column- see header).
  private _hPosBr = -1; // (out, branch)
  private _hNegBr = -1; // (gnd, branch)
  private _hBrPos = -1; // (branch, out)
  private _hBrNeg = -1; // (branch, gnd)

  private _gndNode = -1;

  // The target rail for the level observed in the most recent load() this step,
  // and the target committed at the last accepted step- used by acceptStep to
  // post the change + completion breakpoints (cfunc.mod:259, 413-414).
  private _target = 0;
  private _committedTarget = NaN;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._outLow   = props.getModelParam<number>("out_low");
    this._outHigh  = props.getModelParam<number>("out_high");
    this._outUndef = props.getModelParam<number>("out_undef");
    this._tRise    = props.getModelParam<number>("t_rise");
    this._tFall    = props.getModelParam<number>("t_fall");
    this._level    = props.getModelParam<number>("level");
  }

  setup(ctx: SetupContext): void {
    this._stateBase = ctx.allocStates(this.stateSize);
    const outNode = this.pinNodes.get("out")!;
    this._gndNode = this.pinNodes.get("gnd")!;

    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this.label || "dac_bridge", "branch");
    }
    const branch = this.branchIndex;

    // mifload.c:509-512 branch incidence, exact handle order.
    this._hPosBr = ctx.solver.allocElement(outNode, branch);
    this._hNegBr = ctx.solver.allocElement(this._gndNode, branch);
    this._hBrPos = ctx.solver.allocElement(branch, outNode);
    this._hBrNeg = ctx.solver.allocElement(branch, this._gndNode);
  }

  setParam(key: string, value: number): void {
    switch (key) {
      case "out_low":   this._outLow = value; break;
      case "out_high":  this._outHigh = value; break;
      case "out_undef": this._outUndef = value; break;
      case "t_rise":    this._tRise = value; break;
      case "t_fall":    this._tFall = value; break;
      case "level":     this._level = value; break;
    }
  }

  /** Map the discrete digital state to its target rail (cfunc.mod:273-287). */
  private _targetForLevel(level: number): number {
    if (level <= LEVEL_ZERO_MAX) return this._outLow;   // ZERO
    if (level >= LEVEL_ONE_MIN) return this._outHigh;   // ONE
    return this._outUndef;                              // UNKNOWN
  }

  override load(ctx: LoadContext): void {
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;

    const target = this._targetForLevel(this._level);
    this._target = target;

    let out: number;
    if (ctx.dt <= 0) {
      // DC / operating point: snap to target, no ramp (cfunc.mod:189-224, 273-287).
      out = target;
    } else {
      // Transient slew (cfunc.mod:266-331). Advance from the previous accepted
      // output toward the target; the slope magnitude is fixed within the step,
      // so this is recomputed each NR iteration from the SAME out_old (state1).
      const levelInc = this._outHigh - this._outLow;
      const outOld = s1[base + SLOT_OUT_LEVEL]!;
      if (target > outOld) {
        const riseSlope = levelInc / this._tRise;
        out = Math.min(outOld + riseSlope * ctx.dt, target);
      } else if (target < outOld) {
        const fallSlope = levelInc / this._tFall;
        out = Math.max(outOld - fallSlope * ctx.dt, target);
      } else {
        out = target;
      }
    }

    const solver = ctx.solver;
    const branch = this.branchIndex;

    // mifload.c:509-512 branch incidence ±1; :514 output rhs[branch] += out.
    // No partial column- the slewed output does not depend on present node
    // voltages within the step (dac_bridge has no PARTIAL).
    solver.stampElement(this._hPosBr, 1.0);
    solver.stampElement(this._hNegBr, -1.0);
    solver.stampElement(this._hBrPos, 1.0);
    solver.stampElement(this._hBrNeg, -1.0);
    ctx.rhs[branch] += out;

    s0[base + SLOT_OUT_LEVEL] = out;
  }

  /**
   * AC reload: the slewed output is a fixed bias within an AC analysis (it has
   * no frequency dependence and no controlling-node partial), so the branch is
   * a short with zero AC value- stamp the incidence only.
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
  }

  /**
   * Post the forward permanent breakpoints (cfunc.mod:259, 413-414), mirroring
   * ngspice's two `cm_analog_set_perm_bkpt` calls:
   *   - the change time when the level just changed (so the solver lands on it);
   *   - TIME + when when the ramp has not reached the target (when = remaining
   *     distance / slope), so a step lands exactly on the ramp corner.
   */
  override acceptStep(
    simTime: number,
    addBreakpoint: (t: number) => void,
    _atBreakpoint: boolean,
    _setTempBreakpoint: (t: number) => void,
  ): void {
    const target = this._target;

    // cfunc.mod:259- level change posts a breakpoint at the change time.
    if (!Number.isNaN(this._committedTarget) && target !== this._committedTarget) {
      addBreakpoint(simTime);
    }
    this._committedTarget = target;

    // cfunc.mod:413-414- incomplete ramp posts the completion corner.
    const out = this._pool.states[0][this._stateBase + SLOT_OUT_LEVEL]!;
    const remaining = target - out;
    if (remaining !== 0) {
      const levelInc = this._outHigh - this._outLow;
      const slope = remaining > 0 ? levelInc / this._tRise : levelInc / this._tFall;
      if (slope > 0) {
        const when = Math.abs(remaining) / slope;
        if (when > 0) addBreakpoint(simTime + when);
      }
    }
  }

  /** Per-pin currents [out, gnd]: branch leaves out, arrives gnd. */
  getPinCurrents(rhs: Float64Array): number[] {
    const iBranch = this.branchIndex >= 0 ? rhs[this.branchIndex]! : 0;
    return [iBranch, -iBranch];
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const DacBridgeDefinition: ComponentDefinition = {
  name: "DacBridge",
  typeId: -1,
  internalOnly: true,
  pinLayout: DAC_BRIDGE_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: DAC_BRIDGE_PARAM_DEFS,
      params: {},
      branchCount: 1,
      // XSPICE code-model device family. The digital `in` port is fed by a
      // digital source in the ngspice deck (not an analog node), so cross-engine
      // validation uses a bespoke paired deck rather than verbatim auto-emission;
      // `out` is the single analog node this leaf mints (gnd → node 0).
      spice: { device: "XSPICE", deckNodeTokens: ["out"] },
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag): AnalogElement =>
        new DacBridgeElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
