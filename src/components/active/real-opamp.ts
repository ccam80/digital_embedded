/**
 * Real Op-Amp composite model.
 *
 * Extends the ideal op-amp with physically realistic effects:
 *   - Finite open-loop gain (A_OL)
 *   - Finite gain-bandwidth product (GBW)  single-pole first-order rolloff
 *   - Input offset voltage (V_os)
 *   - Input bias current (I_bias) at both inputs
 *   - Input resistance (R_in)
 *   - Slew rate limiting (clamped integrator)
 *   - Output resistance (R_out)
 *   - Output current limiting (|I_out| â‰¤ I_max)
 *   - Rail saturation (output clamps to V_supply Â± V_sat) via railLim
 *
 * State is held entirely in StatePool slots (REAL_OPAMP_SCHEMA, 8 slots) per
 * ss1.1; the class is a PoolBackedAnalogElement. There is no `accept()` method-
 * the bottom-of-load() history write idiom (ngspice CKTstate0,
 * dioload.c:325-326, bjtload.c:744-746) handles slot promotion via StatePool
 * rotation.
 *
 * The post-init rail-limit block uses the ngspice MODEINIT* gate
 * (dioload.c:139-205): railLim is only invoked when none of the init bits
 * (MODEINITSMSIG, MODEINITTRAN, MODEINITJCT, MODEINITFIX, MODEINITPRED) are
 * set. When railLim clips, ctx.noncon is incremented and a
 * LimitingEvent { limitType: "railLim" } is pushed to the limitingCollector.
 *
 * .MODEL support:
 *   Standard op-amp models (741, LM358, TL072, OPA2134) are pre-defined.
 *   Keys in the model params record:
 *     A     open-loop gain (default 100000)
 *     GBW   gain-bandwidth product in Hz (default 1e6)
 *     SR    slew rate in V/s (default 0.5e6)
 *     Vos   input offset voltage in V (default 1e-3)
 *     Ibias  input bias current in A (default 80e-9)
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
import type { PoolBackedAnalogElement } from "../../solver/analog/element.js";
import type { StatePoolRef } from "../../solver/analog/state-pool.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
import {
  MODETRAN,
  MODEINITSMSIG,
  MODEINITTRAN,
  MODEINITJCT,
  MODEINITFIX,
  MODEINITPRED,
} from "../../solver/analog/ckt-mode.js";
import {
  defineStateSchema,
  type StateSchema,
} from "../../solver/analog/state-schema.js";
import { railLim, type LimitingEvent } from "../../solver/analog/newton-raphson.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// State-pool schema (8 slots per Component C1)
// ---------------------------------------------------------------------------

export const REAL_OPAMP_SCHEMA = defineStateSchema("RealOpAmpElement", [
  { name: "VINT",         doc: "Integrator state (post-companion update)" },
  { name: "VOUT",         doc: "Post-railLim output voltage" },
  { name: "VOUT_LIMITED", doc: "Observability slot for railLim output" },
  { name: "GEQ_INT",      doc: "Recomputed each load(); slot for observability" },
  { name: "AEFF",         doc: "Effective gain after companion / slew adjustments" },
  { name: "OUT_SAT_FLAG", doc: "1 when output is rail-saturated, else 0" },
  { name: "I_LIMIT_FLAG", doc: "1 when output current limit is engaged, else 0" },
  { name: "SLEW_FLAG",    doc: "1 when slew-rate limiting clamped the integrator delta" },
]) satisfies StateSchema;

const SLOT_VINT         = 0;
const SLOT_VOUT         = 1;
const SLOT_VOUT_LIMITED = 2;
const SLOT_GEQ_INT      = 3;
const SLOT_AEFF         = 4;
const SLOT_OUT_SAT_FLAG = 5;
const SLOT_I_LIMIT_FLAG = 6;
const SLOT_SLEW_FLAG    = 7;

// ---------------------------------------------------------------------------
// Built-in op-amp model presets
// ---------------------------------------------------------------------------

/** Pre-defined op-amp parameter presets keyed by model name. */
export const REAL_OPAMP_MODELS: Record<string, {
  aol: number;
  gbw: number;
  slewRate: number;
  vos: number;
  iBias: number;
  rIn: number;
  rOut: number;
  iMax: number;
  vSatPos: number;
  vSatNeg: number;
}> = {
  "741": {
    aol: 200000,
    gbw: 1e6,
    slewRate: 0.5e6,
    vos: 2e-3,
    iBias: 80e-9,
    rIn: 2e6,
    rOut: 75,
    iMax: 25e-3,
    vSatPos: 2.0,
    vSatNeg: 2.0,
  },
  "LM358": {
    aol: 100000,
    gbw: 1e6,
    slewRate: 0.3e6,
    vos: 2e-3,
    iBias: 45e-9,
    rIn: 2e6,
    rOut: 75,
    iMax: 30e-3,
    vSatPos: 2.0,
    vSatNeg: 0.05,
  },
  "TL072": {
    aol: 200000,
    gbw: 3e6,
    slewRate: 13e6,
    vos: 3e-3,
    iBias: 30e-12,
    rIn: 1e12,
    rOut: 75,
    iMax: 10e-3,
    vSatPos: 1.5,
    vSatNeg: 1.5,
  },
  "OPA2134": {
    aol: 1e6,
    gbw: 8e6,
    slewRate: 20e6,
    vos: 500e-6,
    iBias: 5e-12,
    rIn: 1e13,
    rOut: 40,
    iMax: 40e-3,
    vSatPos: 1.0,
    vSatNeg: 1.0,
  },
};

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: REAL_OPAMP_PARAM_DEFS, defaults: REAL_OPAMP_DEFAULTS } = defineModelParams({
  primary: {
    aol:      { default: 100000, description: "Open-loop DC voltage gain" },
    gbw:      { default: 1e6,    unit: "Hz", description: "Gain-bandwidth product" },
    slewRate: { default: 0.5e6, unit: "V/s", description: "Slew rate" },
    vos:      { default: 1e-3,  unit: "V",   description: "Input offset voltage" },
    iBias:    { default: 80e-9, unit: "A",   description: "Input bias current" },
  },
  secondary: {
    rIn:      { default: 2e6,   unit: "Î©",   description: "Input resistance" },
    rOut:     { default: 75,    unit: "Î©",   description: "Output resistance" },
    iMax:     { default: 25e-3, unit: "A",   description: "Output current limit" },
    vSatPos:  { default: 1.5,   unit: "V",   description: "Positive rail saturation drop" },
    vSatNeg:  { default: 1.5,   unit: "V",   description: "Negative rail saturation drop" },
  },
});

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildRealOpAmpPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "in-",
      defaultBitWidth: 1,
      position: { x: 0, y: -1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "in+",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "Vcc+",
      defaultBitWidth: 1,
      position: { x: 2, y: -2 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "Vcc-",
      defaultBitWidth: 1,
      position: { x: 2, y: 2 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// RealOpAmpElement  CircuitElement
// ---------------------------------------------------------------------------

export class RealOpAmpElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("RealOpAmp", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildRealOpAmpPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 2,
      width: 4,
      height: 4,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vVccP = signals?.getPinVoltage("Vcc+");
    const vVccN = signals?.getPinVoltage("Vcc-");

    ctx.save();
    ctx.setLineWidth(1);

    const triLeft = 0;
    const triRight = 4;

    // Triangle body  stays COMPONENT color
    ctx.setColor("COMPONENT");
    ctx.drawPolygon(
      [{ x: triLeft, y: -2 }, { x: triRight, y: 0 }, { x: triLeft, y: 2 }],
      false,
    );

    // Supply rail stubs: Vcc+ stub
    drawColoredLead(ctx, signals, vVccP, 2, -2, 2, -1);

    // Supply rail stubs: Vcc- stub
    drawColoredLead(ctx, signals, vVccN, 2, 2, 2, 1);

    // +/- signs  body decoration, stays COMPONENT color
    ctx.setColor("COMPONENT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText('-', 13 / 16, -18 / 16, { horizontal: "center", vertical: "middle" });
    ctx.drawText('+', 13 / 16, 16 / 16, { horizontal: "center", vertical: "middle" });

    // Supply pin labels
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.5 });
    ctx.drawText("V+", 2.4, -1.0, { horizontal: "left", vertical: "middle" });
    ctx.drawText("Vâˆ’", 2.4, 1.0, { horizontal: "left", vertical: "middle" });

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// RealOpAmpAnalogElement- PoolBackedAnalogElement implementation
// ---------------------------------------------------------------------------

/**
 * MNA implementation of the real op-amp.
 *
 * Node assignment (1-based, 0 = ground):
 *   _pinNodes.get("in+")  = non-inverting input
 *   _pinNodes.get("in-")  = inverting input
 *   _pinNodes.get("out")  = output
 *   _pinNodes.get("Vcc+") = positive supply
 *   _pinNodes.get("Vcc-") = negative supply
 *
 * MNA formulation- Norton/VCVS hybrid with proper Jacobian:
 *
 * Input stage:
 *   - R_in conductance between in+ and in-
 *   - Bias current sources I_bias stamped at the input nodes
 *
 * Gain stage (DC: same as ideal op-amp VCVS; transient: companion integrator):
 *   In the unsaturated, non-current-limited region the gain stage provides
 *     V_out = A_eff * (V_diff + V_os)
 *   The NR linearization at operating point (Vinp0, Vinn0, Vout0) stamps
 *   G_out on the diagonal and -A_eff*G_out / +A_eff*G_out coupling against the
 *   inputs, with RHS = G_out * (V_int - A_eff*(Vinp0 - Vinn0)).
 *
 * Saturation:
 *   Output rail saturation is enforced by the railLim post-init pass on V_out
 *   matching the dioload.c:139-205 mode-mask gate. railLim emits
 *   LimitingEvent { limitType: "railLim" } and increments ctx.noncon when
 *   clipping occurs.
 *
 * Current limiting:
 *   When |I_out| > I_max during saturation the RHS clamps to Â±I_max instead of
 *   the rail-driven Norton current.
 *
 * Transient:
 *   A_eff is reduced by the companion integrator's bandwidth-limiting factor.
 *   The effective gain at frequency Ï‰ is A_OL / (1 + jÏ‰*Ï„), implemented as a
 *   first-order backward-Euler update of V_int each timestep with slew-rate
 *   clamping. Slew "previous" voltage is read from s1[VINT] (last-accepted).
 */
export class RealOpAmpAnalogElement implements PoolBackedAnalogElement {
  label: string = "";
  _pinNodes: Map<string, number> = new Map();
  _stateBase: number = -1;
  branchIndex: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.VCVS;
  readonly poolBacked = true as const;
  readonly stateSchema = REAL_OPAMP_SCHEMA;
  readonly stateSize = REAL_OPAMP_SCHEMA.size;
  elementIndex?: number;

  // Cached parameter record (mutable via setParam).
  private readonly p: Record<string, number>;

  // Source scale for source-stepping- captured each load(), consumed by getPinCurrents().
  private _lastSrcFact = 1;

  // Cached TSTALLOC handles- allocated once in setup(), used every NR iteration.
  private _hInpInp = -1;
  private _hInnInn = -1;
  private _hInpInn = -1;
  private _hInnInp = -1;
  private _hOutOut = -1;
  private _hOutInp = -1;
  private _hOutInn = -1;

  private _pool!: StatePoolRef;

  constructor(pinNodes: ReadonlyMap<string, number>, p: Record<string, number>) {
    this._pinNodes = new Map(pinNodes);
    this.p = p;
  }

  setup(ctx: SetupContext): void {
    if (this._stateBase === -1) {
      this._stateBase = ctx.allocStates(this.stateSize);
    }
    const solver = ctx.solver;
    const nInp = this._pinNodes.get("in+")!;
    const nInn = this._pinNodes.get("in-")!;
    const nOut = this._pinNodes.get("out")!;

    // Input resistance stamp: conductance between nInp and nInn.
    if (nInp > 0) this._hInpInp = solver.allocElement(nInp, nInp);
    if (nInn > 0) this._hInnInn = solver.allocElement(nInn, nInn);
    if (nInp > 0 && nInn > 0) {
      this._hInpInn = solver.allocElement(nInp, nInn);
      this._hInnInp = solver.allocElement(nInn, nInp);
    }
    // Output conductance and gain-stage Jacobian coupling.
    if (nOut > 0) {
      this._hOutOut = solver.allocElement(nOut, nOut);
      if (nInp > 0) this._hOutInp = solver.allocElement(nOut, nInp);
      if (nInn > 0) this._hOutInn = solver.allocElement(nOut, nInn);
    }
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
  }

  load(ctx: LoadContext): void {
    const p = this.p;
    const solver = ctx.solver;
    const voltages = ctx.rhsOld;
    const scale = ctx.srcFact;
    this._lastSrcFact = scale;

    const base = this._stateBase;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];

    const nInp = this._pinNodes.get("in+")!;
    const nInn = this._pinNodes.get("in-")!;
    const nOut = this._pinNodes.get("out")!;
    const nVccP = this._pinNodes.get("Vcc+")!;
    const nVccN = this._pinNodes.get("Vcc-")!;

    const G_in   = 1 / Math.max(p.rIn,  1e-9);
    const G_out  = 1 / Math.max(p.rOut, 1e-9);
    const iMax   = Math.max(p.iMax,   1e-12);
    const vSatPos = Math.max(p.vSatPos, 0);
    const vSatNeg = Math.max(p.vSatNeg, 0);
    const aol    = Math.max(p.aol, 1);

    // Companion coefficient. During transient NR: geq_int = tau/dt. During DC: 0.
    let geq_int: number;
    if ((ctx.cktMode & MODETRAN) && ctx.dt > 0) {
      const tau = aol / (2 * Math.PI * Math.max(p.gbw, 1));
      geq_int = tau / ctx.dt;
    } else {
      geq_int = 0;
    }

    // Operating-point voltages from the current NR-iterate.
    const vInp  = voltages[nInp];
    const vInn  = voltages[nInn];
    const vVccP = voltages[nVccP];
    const vVccN = voltages[nVccN];
    let   vOut  = voltages[nOut];

    const vDiff = vInp - vInn;
    const vOsScaled = p.vos * scale;

    const vRailPos = vVccP - vSatPos;
    const vRailNeg = vVccN + vSatNeg;

    // Slew "previous" reads s1[VINT] (post-rotation last-accepted). No *_PREV slot.
    const vIntPrev = s1[base + SLOT_VINT];

    let vInt: number;
    let aEff: number;
    let slewLimited: boolean;

    if (geq_int > 0) {
      // Transient: re-evaluate slew state from current NR-iterate voltages.
      const g = geq_int;
      const tau = aol / (2 * Math.PI * Math.max(p.gbw, 1));
      const dt = tau / g;
      const slewLimit = Math.max(p.slewRate, 1e-6) * dt;
      const target = (aol * (vDiff + vOsScaled) + g * vIntPrev) / (1 + g);
      const delta = target - vIntPrev;
      const clampedDelta = Math.max(-slewLimit, Math.min(slewLimit, delta));
      slewLimited = Math.abs(delta) > slewLimit;
      vInt = vIntPrev + clampedDelta;
      aEff = slewLimited ? 0 : aol / (1 + g);

      if (vVccP > vVccN) {
        vInt = Math.max(vRailNeg, Math.min(vRailPos, vInt));
      } else {
        vInt = Math.max(-1000, Math.min(1000, vInt));
      }
    } else {
      vInt = aol * (vDiff + vOsScaled);
      aEff = aol;
      slewLimited = false;
      if (vVccP > vVccN) {
        vInt = Math.max(vRailNeg, Math.min(vRailPos, vInt));
      } else {
        vInt = Math.max(-1000, Math.min(1000, vInt));
      }
    }

    // Post-init rail-limit on vOut. Mode-mask gate matches dioload.c:139-205:
    // railLim is invoked only when none of MODEINIT* (SMSIG, TRAN, JCT, FIX,
    // PRED) are set- i.e. on the post-init NR iterations.
    const initBits = ctx.cktMode & (
      MODEINITSMSIG | MODEINITTRAN | MODEINITJCT | MODEINITFIX | MODEINITPRED
    );
    if (initBits === 0) {
      const vOutOld = s1[base + SLOT_VOUT];
      const r = railLim(vOut, vOutOld, vRailPos, vRailNeg);
      const vOutBefore = vOut;
      vOut = r.value;
      if (r.limited) {
        ctx.noncon.value++;
        if (ctx.limitingCollector) {
          const event: LimitingEvent = {
            elementIndex: this.elementIndex ?? -1,
            label: this.label ?? "",
            junction: "OUT",
            limitType: "railLim",
            vBefore: vOutBefore,
            vAfter: vOut,
            wasLimited: true,
          };
          ctx.limitingCollector.push(event);
        }
      }
    }
    s0[base + SLOT_VOUT_LIMITED] = vOut;

    // Determine saturation / current-limit flags from the post-railLim vOut.
    let outputSaturated = false;
    let outputClampLevel = 0;
    if (vVccP > vVccN && vOut >= vRailPos) {
      outputSaturated  = true;
      outputClampLevel = vRailPos;
    } else if (vVccP > vVccN && vOut <= vRailNeg) {
      outputSaturated  = true;
      outputClampLevel = vRailNeg;
    }

    let currentLimited = false;
    let iOutLimited = 0;
    if (outputSaturated) {
      const iOutNow = (outputClampLevel - vOut) * G_out;
      if (Math.abs(iOutNow) > iMax) {
        currentLimited = true;
        iOutLimited    = iOutNow > 0 ? iMax : -iMax;
      }
    }

    // Linear topology stamps using cached handles.
    if (this._hInpInp >= 0) solver.stampElement(this._hInpInp,  G_in);
    if (this._hInnInn >= 0) solver.stampElement(this._hInnInn,  G_in);
    if (this._hInpInn >= 0) solver.stampElement(this._hInpInn, -G_in);
    if (this._hInnInp >= 0) solver.stampElement(this._hInnInp, -G_in);
    if (this._hOutOut >= 0) solver.stampElement(this._hOutOut, G_out);

    // Input bias currents
    const iBiasScaled = Math.abs(p.iBias) * scale;
    if (nInp > 0) stampRHS(ctx.rhs, nInp, -iBiasScaled);
    if (nInn > 0) stampRHS(ctx.rhs, nInn, -iBiasScaled);

    if (nOut > 0) {
      // Gain-stage output
      if (outputSaturated) {
        stampRHS(ctx.rhs, nOut, outputClampLevel * G_out);
      } else if (currentLimited) {
        stampRHS(ctx.rhs, nOut, iOutLimited);
      } else if (slewLimited) {
        stampRHS(ctx.rhs, nOut, vInt * G_out);
      } else {
        // Normal operation: bandwidth-limited VCVS with backward-Euler history current.
        const aEffScaled = aEff * scale;
        const ieq = geq_int > 0
          ? (geq_int / (1 + geq_int)) * vIntPrev * G_out
          : 0;
        if (this._hOutInp >= 0) solver.stampElement(this._hOutInp, -aEffScaled * G_out);
        if (this._hOutInn >= 0) solver.stampElement(this._hOutInn,  aEffScaled * G_out);
        stampRHS(ctx.rhs, nOut, ieq + aEffScaled * G_out * p.vos * scale);
      }
    }

    // ngspice CKTstate0 idiom- bottom-of-load history writes (bjtload.c:744-746,
    // dioload.c:325-326). vInt clamp at the integrator stage above is preserved-
    // it does not signal noncon.
    s0[base + SLOT_VINT]         = vInt;
    s0[base + SLOT_VOUT]         = vOut;
    s0[base + SLOT_GEQ_INT]      = geq_int;
    s0[base + SLOT_AEFF]         = aEff;
    s0[base + SLOT_OUT_SAT_FLAG] = outputSaturated ? 1 : 0;
    s0[base + SLOT_I_LIMIT_FLAG] = currentLimited ? 1 : 0;
    s0[base + SLOT_SLEW_FLAG]    = slewLimited ? 1 : 0;
  }

  getPinCurrents(rhs: Float64Array): number[] {
    // pinLayout order: in-, in+, out, Vcc+, Vcc-
    //
    // Input resistance G_in is stamped between nInp and nInn.
    // Current into element at each input terminal from the resistor:
    //   I_resistor_at_nInn = (vInn - vInp) * G_in
    //   I_resistor_at_nInp = (vInp - vInn) * G_in
    // Bias currents: stampRHS injects -iBias into each node  element draws +iBias.
    //
    // Output (Norton equivalent, G_out stamped on diagonal to ground):
    //   Normal/slewing:        Norton target = vInt  I_out = (vOut - vInt) * G_out
    //   Saturated (no limit):  Norton target = outputClampLevel  I_out = (vOut - outputClampLevel) * G_out
    //   Current limited:       RHS carries iOutLimited directly (injects INTO node)
    //                           element draws -iOutLimited; diagonal G_out drives to ground
    //                           I_out = vOut * G_out - iOutLimited
    //
    // Supply pins: by KCL the sum of all 5 pin currents must be zero.
    // Total supply current = -(I_inn + I_inp + I_out).
    // Split by output polarity: Vcc+ provides current when output sources,
    // Vcc- sinks current when output sinks.

    const p = this.p;
    const nInp = this._pinNodes.get("in+")!;
    const nInn = this._pinNodes.get("in-")!;
    const nOut = this._pinNodes.get("out")!;
    const nVccP = this._pinNodes.get("Vcc+")!;
    const nVccN = this._pinNodes.get("Vcc-")!;

    const vInp = nInp > 0 ? rhs[nInp] : 0;
    const vInn = nInn > 0 ? rhs[nInn] : 0;
    const vOut = nOut > 0 ? rhs[nOut] : 0;

    const G_in  = 1 / Math.max(p.rIn,  1e-9);
    const G_out = 1 / Math.max(p.rOut, 1e-9);
    const iBiasScaled = Math.abs(p.iBias) * this._lastSrcFact;

    const base = this._stateBase;
    const s1 = this._pool.states[1];
    const vInt           = s1[base + SLOT_VINT];
    const outputSaturated = s1[base + SLOT_OUT_SAT_FLAG] !== 0;
    const currentLimited  = s1[base + SLOT_I_LIMIT_FLAG] !== 0;

    // Recompute the saturation clamp level for current accounting using the
    // latest accepted supply voltages.
    const vVccP = nVccP > 0 ? rhs[nVccP] : 0;
    const vVccN = nVccN > 0 ? rhs[nVccN] : 0;
    const vRailPos = vVccP - Math.max(p.vSatPos, 0);
    const vRailNeg = vVccN + Math.max(p.vSatNeg, 0);
    let outputClampLevel = 0;
    if (outputSaturated) {
      outputClampLevel = vOut >= vRailPos ? vRailPos : vRailNeg;
    }
    let iOutLimited = 0;
    if (currentLimited) {
      const iMax = Math.max(p.iMax, 1e-12);
      const iOutNow = (outputClampLevel - vOut) * G_out;
      iOutLimited = iOutNow > 0 ? iMax : -iMax;
    }

    // Input pin currents (resistor + bias)
    const iInn = (nInn > 0 ? (vInn - vInp) * G_in : 0) + iBiasScaled;
    const iInp = (nInp > 0 ? (vInp - vInn) * G_in : 0) + iBiasScaled;

    // Output pin current (into element)
    let iOut: number;
    if (nOut <= 0) {
      iOut = 0;
    } else if (currentLimited) {
      iOut = vOut * G_out - iOutLimited;
    } else if (outputSaturated) {
      iOut = (vOut - outputClampLevel) * G_out;
    } else {
      iOut = (vOut - vInt) * G_out;
    }

    // Supply currents: enforce KCL (sum of all pin currents = 0)
    const iSupplyTotal = -(iInn + iInp + iOut);
    let iVccP: number;
    let iVccN: number;
    if (iSupplyTotal >= 0) {
      iVccP = nVccP > 0 ? iSupplyTotal : 0;
      iVccN = 0;
    } else {
      iVccP = 0;
      iVccN = nVccN > 0 ? iSupplyTotal : 0;
    }

    return [iInn, iInp, iOut, iVccP, iVccN];
  }

  setParam(key: string, value: number): void {
    if (key in this.p) this.p[key] = value;
  }
}

// ---------------------------------------------------------------------------
// createRealOpAmpElement  PoolBackedAnalogElement factory
// ---------------------------------------------------------------------------

export function createRealOpAmpElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): PoolBackedAnalogElement {
  const p: Record<string, number> = {
    aol:      props.getModelParam<number>("aol"),
    gbw:      props.getModelParam<number>("gbw"),
    slewRate: props.getModelParam<number>("slewRate"),
    vos:      props.getModelParam<number>("vos"),
    iBias:    props.getModelParam<number>("iBias"),
    rIn:      props.getModelParam<number>("rIn"),
    rOut:     props.getModelParam<number>("rOut"),
    iMax:     props.getModelParam<number>("iMax"),
    vSatPos:  props.getModelParam<number>("vSatPos"),
    vSatNeg:  props.getModelParam<number>("vSatNeg"),
  };

  // Apply named model overrides if specified
  const modelName = props.getOrDefault<string>("model", "");
  if (modelName.length > 0) {
    const preset = REAL_OPAMP_MODELS[modelName];
    if (preset) {
      p.aol      = preset.aol;
      p.gbw      = preset.gbw;
      p.slewRate = preset.slewRate;
      p.vos      = preset.vos;
      p.iBias    = preset.iBias;
    }
  }

  return new RealOpAmpAnalogElement(pinNodes, p);
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const REAL_OPAMP_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional display label.",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

const REAL_OPAMP_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "model",    propertyKey: "model",    convert: (v) => v },
  { xmlName: "aol",      propertyKey: "aol",      convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "gbw",      propertyKey: "gbw",      convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "slewRate", propertyKey: "slewRate", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "vos",      propertyKey: "vos",      convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "iBias",    propertyKey: "iBias",    convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "rIn",      propertyKey: "rIn",      convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "rOut",     propertyKey: "rOut",     convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "iMax",     propertyKey: "iMax",     convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "vSatPos",  propertyKey: "vSatPos",  convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "vSatNeg",  propertyKey: "vSatNeg",  convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Label",    propertyKey: "label",    convert: (v) => v },
];

// ---------------------------------------------------------------------------
// RealOpAmpDefinition
// ---------------------------------------------------------------------------

export const RealOpAmpDefinition: StandaloneComponentDefinition = {
  name: "RealOpAmp",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildRealOpAmpPinDeclarations(),
  propertyDefs: REAL_OPAMP_PROPERTY_DEFS,
  attributeMap: REAL_OPAMP_ATTRIBUTE_MAPPINGS,

  helpText:
    "Real Op-Amp  composite model with finite gain, GBW, slew rate, " +
    "input offset/bias, output resistance, current limiting, and rail saturation. " +
    "Pins: in+, in-, out, Vcc+, Vcc-.",

  factory(props: PropertyBag): RealOpAmpElement {
    return new RealOpAmpElement(
      crypto.randomUUID(),
      { x: 0, y: 0 },
      0,
      false,
      props,
    );
  },

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: (pinNodes, props, getTime) =>
        createRealOpAmpElement(pinNodes, props, getTime),
      paramDefs: REAL_OPAMP_PARAM_DEFS,
      params: REAL_OPAMP_DEFAULTS,
    },
    ...Object.fromEntries(
      Object.entries(REAL_OPAMP_MODELS).map(([name, params]) => [
        name,
        {
          kind: "inline" as const,
          factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, getTime: () => number) =>
            createRealOpAmpElement(pinNodes, props, getTime),
          paramDefs: REAL_OPAMP_PARAM_DEFS,
          params,
        },
      ]),
    ),
  },
  defaultModel: "behavioral",
};
