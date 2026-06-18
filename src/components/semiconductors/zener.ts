/**
 * Zener diode analog component  Shockley equation with reverse breakdown.
 *
 * Extends the standard diode with a reverse breakdown region:
 *   When Vd < -tBV: Id = -IS * exp(-(Vd + tBV) / (NBV*Vt))
 *
 * The breakdown region produces a sharply increasing reverse current at
 * Vd = -tBV, modeling the Zener/avalanche effect.
 *
 * cite: ref/ngspice/src/spicelib/devices/dio/dioload.c (DIOload)
 * cite: ref/ngspice/src/spicelib/devices/dio/diotemp.c (DIOtemp  tBV derivation)
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, LABEL_PROPERTY_DEF } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type StandaloneComponentDefinition,
} from "../../core/registry.js";
import { PoolBackedAnalogElement } from "../../solver/analog/element.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import {
  MODEINITJCT,
  MODEINITFIX,
  MODEINITSMSIG,
  MODEINITTRAN,
  MODEINITPRED,
  MODETRANOP,
  MODEUIC,
} from "../../solver/analog/ckt-mode.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
import { pnjlim } from "../../solver/analog/newton-raphson.js";
import { defineModelParams, kelvinToCelsius } from "../../core/model-params.js";
import { createDiodeElement, dioTemp } from "./diode.js";
import type { DioTempInput, DioGeom } from "./diode.js";
import { defineStateSchema } from "../../solver/analog/state-schema.js";
import type { TempContext } from "../../solver/analog/temp-context.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

const CONSTe = Math.E;          // Euler's number, used in cubic approximation (dioload.c:254)

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: ZENER_PARAM_DEFS, defaults: ZENER_PARAM_DEFAULTS } = defineModelParams({
  primary: {
    IS:  { default: 1e-14, unit: "A", description: "Saturation current" },
    N:   { default: 1,                description: "Emission coefficient" },
    BV:  { default: 5.1,  unit: "V", description: "Reverse breakdown voltage" },
    NBV: { default: NaN,              description: "Breakdown emission coefficient (defaults to N)" },
    IBV: { default: 1e-3, unit: "A", description: "Current at breakdown voltage" },
    TCV: { default: 0,    unit: "V/°C", description: "Breakdown voltage temperature coefficient" },
    TNOM:{ default: 300.15, unit: "K",  description: "Parameter measurement temperature", spiceConverter: kelvinToCelsius },
  },
  secondary: {
  },
  instance: {
    TEMP: { default: 300.15, unit: "K", description: "Per-instance operating temperature", spiceConverter: kelvinToCelsius },
  },
});

// Full SPICE L1 zener param declarations (diode superset with BV as primary)
export const { paramDefs: ZENER_SPICE_L1_PARAM_DEFS, defaults: ZENER_SPICE_L1_DEFAULTS } = defineModelParams({
  primary: {
    BV:  { default: 5.1,      unit: "V", description: "Reverse breakdown voltage" },
    IS:  { default: 1e-14,    unit: "A", description: "Saturation current" },
    N:   { default: 1,                   description: "Emission coefficient" },
  },
  secondary: {
    RS:  { default: 0,        unit: "Ω",  description: "Ohmic (series) resistance" },
    CJO: { default: 0,        unit: "F",  description: "Zero-bias junction capacitance" },
    VJ:  { default: 1,        unit: "V",  description: "Junction built-in potential" },
    M:   { default: 0.5,                  description: "Grading coefficient" },
    TT:  { default: 0,        unit: "s",  description: "Transit time" },
    FC:  { default: 0.5,                  description: "Forward-bias capacitance coefficient" },
    IBV: { default: 1e-3,     unit: "A",  description: "Reverse breakdown current" },
    EG:  { default: 1.11,     unit: "eV", description: "Activation energy" },
    XTI: { default: 3,                    description: "Saturation current temperature exponent" },
    KF:  { default: 0,                    description: "Flicker noise coefficient" },
    AF:  { default: 1,                    description: "Flicker noise exponent" },
  },
  instance: {
    TEMP: { default: 300.15, unit: "K", description: "Per-instance operating temperature", spiceConverter: kelvinToCelsius },
  },
});

// ---------------------------------------------------------------------------
// State schema declaration
// ---------------------------------------------------------------------------

// ngspice diodefs.h:154-158 — diosetup.c:199 allocates 5 slots unconditionally.
// Q / CCAP are unused by the zener (no junction capacitance) but allocated for
// slot-layout parity with the unified diode schema.
const ZENER_STATE_SCHEMA = defineStateSchema("ZenerElement", [
  { name: "VD",   doc: "Junction voltage — diodefs.h DIOvoltage (DIOstate+0)" },
  { name: "ID",   doc: "GMIN-adjusted diode current — diodefs.h DIOcurrent (DIOstate+1)" },
  { name: "GEQ",  doc: "GMIN-adjusted junction conductance — diodefs.h DIOconduct (DIOstate+2)" },
  { name: "Q",    doc: "Junction charge (unused by zener) — diodefs.h DIOcapCharge (DIOstate+3)" },
  { name: "CAP_CURRENT", doc: "NIintegrate companion current (unused by zener) — diodefs.h DIOcapCurrent (DIOstate+4)" },
]);

// ---------------------------------------------------------------------------
// Temperature scaling
//
// ngspice has no separate zener device — a Zener is the standard DIO model with
// reverse-breakdown parameters (BV/IBV/NBV/TCV). The temperature-scaled
// saturation current (DIOtSatCur), Vcrit (DIOtVcrit) and breakdown voltage
// (DIOtBrkdwnV) are therefore sourced from the shared dioTemp() port
// (diotemp.c:18-247) rather than a partial local copy, so the DIO temperature
// physics has a single source of truth.
// ---------------------------------------------------------------------------

/** Geometry fed to dioTemp: the simplified zener carries no area/perimeter. */
const ZENER_GEOM: DioGeom = { area: 1, pj: 0, m: 1 };

// ---------------------------------------------------------------------------
// createZenerElement  AnalogElement factory
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ZenerAnalogElement  pool-backed class
// ---------------------------------------------------------------------------

interface ZenerTp {
  vt: number;
  nVt: number;
  nbvVt: number;
  tVcrit: number;
  vcritBrk: number;
  tBV: number;
  /** Temperature-scaled saturation current (DIOtSatCur) — diotemp.c:116. */
  tIS: number;
}

class ZenerAnalogElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.DIO;
  readonly deviceFamily: DeviceFamily = "DIO";
  readonly stateSchema = ZENER_STATE_SCHEMA;
  readonly stateSize = ZENER_STATE_SCHEMA.size;

  private readonly _params: Record<string, number>;
  private readonly _nodeCathode: number;
  private _tp: ZenerTp;

  // cite: diotemp.c:84-85 — DIOtempGiven mirrors PropertyBag givenness for TEMP.
  // When false, computeTemperature(ctx) uses ctx.cktTemp.
  private _tempGiven: boolean;

  // CKTreltol fed to dioTemp's breakdown-voltage match (diotemp.c:208). Seeded
  // with the field default until the engine temperature pass supplies the live
  // CKTreltol via computeTemperature(ctx); mirrors diode.ts:773-776.
  private _reltol = 1e-3;

  // Ephemeral per-iteration pnjlim limiting flag (ngspice Check / DIOload  CKTnoncon++)
  private _pnjlimLimited = false;

  // Internal prime node (DIOposPrimeNode)- set during setup(), read by load()
  private _posPrimeNode: number;

  // TSTALLOC handles- set during setup(), read inside load()
  private _hPosPP  = -1;
  private _hNegPP  = -1;
  private _hPPPos  = -1;
  private _hPPNeg  = -1;
  private _hPosPos = -1;
  private _hNegNeg = -1;
  private _hPPPP   = -1;

  // Internal node labels- recorded during setup() when RS > 0
  private readonly _internalLabels: string[] = [];

  // diogetic.c:28-31 — DIOinitCond. Zener exposes no IC param, so under UIC the
  // junction voltage is always V(anode)−V(cathode) read from the CKTic-seeded
  // rhs (getInitialConditions), matching the dio-model DEVsetic ngspice runs.
  private _uicVd = 0;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._tempGiven = props.isModelParamGiven("TEMP");
    const params: Record<string, number> = { ...ZENER_PARAM_DEFAULTS };
    for (const key of props.getModelParamKeys()) {
      params[key] = props.getModelParam<number>(key);
    }
    // diosetup.c:93-95: NBV (DIObrkdEmissionCoeff) defaults to N (DIOemissionCoeff)
    if (isNaN(params.NBV)) params.NBV = params.N;
    this._params = params;
    this._nodeCathode = pinNodes.get("K")!;
    this._posPrimeNode = pinNodes.get("A")!;
    this._tp = this._computeZenerTp();
  }

  /** ngspice DIOgetic (diogetic.c:28-31), dispatched by the engine's CKTic step
   *  under UIC before the boot DCOP reads the junction voltage. Zener has no IC
   *  param, so the UIC voltage is always V(anode)−V(cathode) from the seeded rhs. */
  getInitialConditions(rhs: Float64Array): void {
    this._uicVd = rhs[this.pinNodes.get("A")!] - rhs[this._nodeCathode];
  }

  private _computeZenerTp(): ZenerTp {
    const params = this._params;
    // cite: dioload.c / diotemp.c — per-instance TEMP (maps to ngspice DIOtemp).
    const circuitTemp = params.TEMP;
    // Source the temperature-scaled saturation current, Vcrit and breakdown
    // voltage from the shared DIO temperature port. At T == TNOM the saturation
    // current is unchanged (tIS == IS), so nominal-temperature behaviour is
    // bit-identical to the prior local derivation.
    const tp = dioTemp(this._dioTempInput(), circuitTemp, ZENER_GEOM, this._reltol);
    const vt = tp.vt;
    const nVt = params.N * vt;
    const nbvVt = params.NBV * vt;
    // vcritBrk: pnjlim vcrit for the breakdown domain, using nbvVt and the
    // temperature-scaled saturation current  cite: dioload.c:189-190.
    const vcritBrk = nbvVt * Math.log(nbvVt / (tp.tIS * Math.SQRT2));
    return { vt, nVt, nbvVt, tVcrit: tp.tVcrit, vcritBrk, tBV: tp.tBV, tIS: tp.tIS };
  }

  /**
   * Build the dioTemp model-parameter input. The simplified zener models only
   * IS/N/BV/NBV/IBV/TCV/TNOM (+ EG/XTI on the SPICE-L1 superset); the remaining
   * DIO fields take ngspice model defaults and feed only outputs the zener load()
   * ignores (sidewall / tunnel / recombination / junction-cap quantities). The
   * fields that DO reach the zener — vt, tIS, tVcrit, tBV — depend solely on
   * IS, N, BV, NBV, IBV, TCV, TNOM, EG, XTI and the LEVEL==1 breakdown-current
   * selection (cbv = m*IBV, matching the prior local computeTBV).
   */
  private _dioTempInput(): DioTempInput {
    const p = this._params;
    return {
      IS: p.IS, N: p.N, BV: p.BV, IBV: p.IBV, NBV: p.NBV, TNOM: p.TNOM,
      TCV: isFinite(p.TCV) ? p.TCV : 0,
      EG: isFinite(p.EG) ? p.EG : 1.11,   // diodefs.h DIOeg default
      XTI: isFinite(p.XTI) ? p.XTI : 3.0, // diodefs.h DIOxti default
      LEVEL: 1,                           // diotemp.c:523 — cbv = m*IBV
      VJ: 1, CJO: 0, M: 0.5,
      ISW: 0, NSW: 1, FC: 0.5, FCS: 0.5,
      CJSW: 0, VJSW: 1, MJSW: 0.33,
      TLEV: 0, TLEVC: 0, TM1: 0, TM2: 0, TTT1: 0, TTT2: 0,
      TRS: 0, TRS2: 0, CTA: 0, CTP: 0, TPB: 0, TPHP: 0,
      JTUN: 0, JTUNSW: 0, NTUN: 1, XTITUN: 3, KEG: 1,
      ISR: 0, NR: 1, TT: 0, RS: 0,
    };
  }

  setup(ctx: import("../../solver/analog/setup-context.js").SetupContext): void {
    const solver = ctx.solver;
    const posNode = this.pinNodes.get("A")!;
    const negNode = this.pinNodes.get("K")!;

    // State slots- diosetup.c:198-199 (*states += 5 unconditionally)
    this._stateBase = ctx.allocStates(this.stateSize);

    // Internal node- diosetup.c:204-224
    // ngspice gating: RS > 0 → allocate anode-prime node
    if (this._params.RS === 0 || !this._params.RS) {
      this._posPrimeNode = posNode;
    } else {
      this._posPrimeNode = ctx.makeVolt(this.label ?? "Z", "internal");
      this._internalLabels.push("internal");
    }

    // TSTALLOC sequence- diosetup.c:232-238 (identical to PB-DIO)
    this._hPosPP  = solver.allocElement(posNode,            this._posPrimeNode); // (1)
    this._hNegPP  = solver.allocElement(negNode,            this._posPrimeNode); // (2)
    this._hPPPos  = solver.allocElement(this._posPrimeNode, posNode);            // (3)
    this._hPPNeg  = solver.allocElement(this._posPrimeNode, negNode);            // (4)
    this._hPosPos = solver.allocElement(posNode,            posNode);            // (5)
    this._hNegNeg = solver.allocElement(negNode,            negNode);            // (6)
    this._hPPPP   = solver.allocElement(this._posPrimeNode, this._posPrimeNode); // (7)
  }

  getInternalNodeLabels(): readonly string[] {
    return this._internalLabels;
  }

  load(ctx: LoadContext): void {
    const SLOT_VD = 0, SLOT_ID = 1, SLOT_GEQ = 2;

    // Direct state-array access per call  no cached Float64Array refs.
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];
    const base = this._stateBase;

    const voltages = ctx.rhsOld;
    const mode = ctx.cktMode;
    const params = this._params;
    const tp = this._tp;

    // -----------------------------------------------------------------------
    // Z-W3-8: MODEINITSMSIG branch  cite: dioload.c:126-128
    // -----------------------------------------------------------------------
    if (mode & MODEINITSMSIG) {
      // Read vd from state0 (DC operating point voltage), compute OP values,
      // skip pnjlim and stamps, then return.
      const vdOp = s0[base + SLOT_VD];
      // compute conductance at OP point (for AC small-signal analysis)
      // three-region eval at vdOp  cite: dioload.c:245-265
      let gdOp: number;
      if (vdOp >= -3 * tp.nVt) {
        // forward
        const evd = Math.exp(vdOp / tp.nVt);
        gdOp = tp.tIS * evd / tp.nVt;
      } else if (!isFinite(tp.tBV) || vdOp >= -tp.tBV) {
        // reverse-cubic  cite: dioload.c:251-257
        const arg = 3 * tp.nVt / (vdOp * CONSTe);
        const arg3 = arg * arg * arg;
        gdOp = tp.tIS * 3 * arg3 / (-vdOp);
      } else {
        // breakdown  cite: dioload.c:261-263
        const evrev = Math.exp(-(tp.tBV + vdOp) / tp.nbvVt);
        gdOp = tp.tIS * evrev / tp.nbvVt;
      }
      // store capd (small-signal conductance)  dioload.c:363 stores capd here;
      // for a resistive zener (no cap), we store gd for any bypass/convergence use.
      s0[base + SLOT_GEQ] = gdOp + ctx.cktGmin;
      // cite: dioload.c:374: continue (skip stamps)
      return;
    }

    // -----------------------------------------------------------------------
    // Z-W3-4: 4-branch MODEINITJCT dispatch  cite: dioload.c:130-138
    // In-load priming: MODEINITJCT sets SLOT_VD = tVcrit (OFF==0) or 0 (OFF!=0)
    // directly inside load(), matching ngspice dioload.c:130-138.
    // -----------------------------------------------------------------------
    let vdRaw: number;
    if (mode & MODEINITTRAN) {
      // Z-W3-9: MODEINITTRAN seeds vd from state1  cite: dioload.c:128-129
      vdRaw = s1[base + SLOT_VD];
    } else if ((mode & MODEINITJCT) && (mode & MODETRANOP) && (mode & MODEUIC)) {
      // dioload.c:130-132: MODEINITJCT && MODETRANOP && MODEUIC  DIOinitCond.
      // DIOinitCond is V(anode)−V(cathode) from the CKTic-seeded rhs (diogetic.c),
      // populated by getInitialConditions(); zero in the common no-nodeset boot.
      vdRaw = this._uicVd;
    } else if ((mode & MODEINITJCT) && (params.OFF !== undefined && params.OFF !== 0)) {
      // dioload.c:133-134: MODEINITJCT && DIOoff  vd = 0
      vdRaw = 0;
    } else if (mode & MODEINITJCT) {
      // dioload.c:135-136: MODEINITJCT else  vd = tVcrit
      vdRaw = tp.tVcrit;
    } else if ((mode & MODEINITFIX) && (params.OFF !== undefined && params.OFF !== 0)) {
      // dioload.c:137-138: MODEINITFIX && DIOoff  vd = 0
      vdRaw = 0;
    } else if (mode & MODEINITPRED) {
      // cite: dioload.c:141-148
      s0[base + SLOT_VD]  = s1[base + SLOT_VD];
      s0[base + SLOT_ID]  = s1[base + SLOT_ID];
      s0[base + SLOT_GEQ] = s1[base + SLOT_GEQ];
      const xfact = ctx.deltaOld[0] / ctx.deltaOld[1];
      vdRaw = (1 + xfact) * s1[base + SLOT_VD] - xfact * s2[base + SLOT_VD];
    } else {
      // dioload.c:151-152: vd from rhsOld (current NR iterate voltages)
      const va = voltages[this._posPrimeNode];
      const vc = voltages[this._nodeCathode];
      vdRaw = va - vc;
    }

    // -----------------------------------------------------------------------
    // Apply pnjlim  cite: dioload.c:180-204
    // -----------------------------------------------------------------------
    const vdOld = s0[base + SLOT_VD];
    let vdLimited: number;

    if (mode & (MODEINITJCT | MODEINITTRAN)) {
      // These phases set vd directly  no pnjlim  cite: dioload.c:126-138
      vdLimited = vdRaw;
      this._pnjlimLimited = false;
    } else if (isFinite(tp.tBV) && vdRaw < Math.min(0, -tp.tBV + 10 * tp.nbvVt)) {
      // dioload.c:183-195: breakdown path  pnjlim in reflected domain.
      // Z-W3-6: use vcritBrk (computed from nbvVt) not tVcrit  cite: dioload.c:189-190
      const vdtemp = -(vdRaw + tp.tBV);
      const vdtempOld = -(vdOld + tp.tBV);
      const reflResult = pnjlim(vdtemp, vdtempOld, tp.nbvVt, tp.vcritBrk);
      this._pnjlimLimited = reflResult.limited;
      vdLimited = -(reflResult.value + tp.tBV);
    } else {
      // dioload.c:196-204: standard pnjlim for forward/normal-reverse.
      const vdResult = pnjlim(vdRaw, vdOld, tp.nVt, tp.tVcrit);
      vdLimited = vdResult.value;
      this._pnjlimLimited = vdResult.limited;
    }

    if (this._pnjlimLimited) ctx.noncon.value++;

    if (ctx.limitingCollector) {
      ctx.limitingCollector.push({
        elementIndex: this.elementIndex ?? -1,
        label: this.label ?? "",
        junction: "AK",
        limitType: "pnjlim",
        vBefore: vdRaw,
        vAfter: vdLimited,
        wasLimited: this._pnjlimLimited,
      });
    }

    // -----------------------------------------------------------------------
    // Z-W3-1/Z-W3-2: Three-region I-V structure  cite: dioload.c:245-265
    // Z-W3-5: use tBV (temperature-scaled) throughout  cite: diotemp.c:244
    // -----------------------------------------------------------------------
    let cdb: number;
    let gdb: number;

    if (vdLimited >= -3 * tp.nVt) {
      // Forward region  cite: dioload.c:245-249
      const evd = Math.exp(vdLimited / tp.nVt);
      cdb = tp.tIS * (evd - 1);
      gdb = tp.tIS * evd / tp.nVt;
    } else if (!isFinite(tp.tBV) || vdLimited >= -tp.tBV) {
      // Reverse-cubic region  cite: dioload.c:251-258
      // arg = 3*vte / (vd * CONSTe); cdb = -IS*(1+arg^3); gdb = IS*3*arg^3/(-vd)
      const arg = 3 * tp.nVt / (vdLimited * CONSTe);
      const arg3 = arg * arg * arg;
      cdb = -tp.tIS * (1 + arg3);
      gdb = tp.tIS * 3 * arg3 / (-vdLimited);
    } else {
      // Breakdown region  cite: dioload.c:259-264
      // cdb = -IS * exp(-(tBV+vd)/vtebrk); gdb = IS * exp(...)/vtebrk
      const evrev = Math.exp(-(tp.tBV + vdLimited) / tp.nbvVt);
      cdb = -tp.tIS * evrev;
      gdb = tp.tIS * evrev / tp.nbvVt;
    }

    // cd / gd = intrinsic junction values (no sidewall/tunnel for simplified model)
    let cd = cdb;
    let gd = gdb;

    // -----------------------------------------------------------------------
    // Z-W3-3: GMIN as Norton pair  cite: dioload.c:297-299, 310-311
    // Add GMIN to both gd and cd before ieq computation.
    // -----------------------------------------------------------------------
    gd += ctx.cktGmin;       // cite: dioload.c:298 (else branch: gd += CKTgmin)
    cd += ctx.cktGmin * vdLimited;  // cite: dioload.c:299: cd += CKTgmin*vd

    // -----------------------------------------------------------------------
    // Z-W3-7: state0 writes  store GMIN-adjusted pair  cite: dioload.c:417-419
    // ngspice writes the post-GMIN cd and gd to CKTstate0.
    // -----------------------------------------------------------------------
    s0[base + SLOT_VD]  = vdLimited;
    s0[base + SLOT_ID]  = cd;           // GMIN-adjusted (matches dioload.c:418)
    s0[base + SLOT_GEQ] = gd;           // GMIN-adjusted (matches dioload.c:419)

    // ngspice has no DIOieq slot — companion Norton current `cdeq = cd - gd*vd`
    // is a function-local in dioload.c, used at the stamp call site below.
    const ieq = cd - gd * vdLimited;

    // -----------------------------------------------------------------------
    // Stamp Norton companion  cite: dioload.c:429-441
    // Stamps through pre-allocated handles from setup()
    //
    // Series-resistance T-model (gspr) gating mirrors dioload.c:98 and the
    // setup-side gating at diosetup.c:204 (DIOresist == 0 → no prime node).
    // When RS == 0, _posPrimeNode aliases the external anode (zener.ts:264)
    // and the prime-side stamps collapse to no-ops- gspr is skipped to match.
    // When RS > 0, the seven stamps below mirror dioload.c:431-441 line for
    // line: gd contributes to (PP,PP), (Neg,Neg), (PP,Neg), (Neg,PP) and gspr
    // contributes to (PP,PP), (Pos,Pos), (Pos,PP), (PP,Pos). The (PP,PP)
    // diagonal carries gd+gspr per dioload.c:431.
    //
    // gspr = DIOtConductance * AREA (dioload.c:98). DIOtConductance = 1/RS
    // baseline (diotemp.c:72), with optional polynomial scaling by
    // DIOresistTemp1/2 (diotemp.c:253-257)- not yet applied here; tracked
    // for future bit-exact temp parity.
    // -----------------------------------------------------------------------
    const solver = ctx.solver;
    const gspr = params.RS > 0 ? (params.AREA ?? 1) / params.RS : 0;

    solver.stampElement(this._hPPPP,   gd + gspr);   // dioload.c:431
    solver.stampElement(this._hPPNeg,  -gd);         // dioload.c:436
    solver.stampElement(this._hNegPP,  -gd);         // dioload.c:437
    solver.stampElement(this._hNegNeg, gd);          // dioload.c:432
    if (gspr > 0) {
      solver.stampElement(this._hPosPos, gspr);      // dioload.c:433
      solver.stampElement(this._hPosPP,  -gspr);     // dioload.c:434
      solver.stampElement(this._hPPPos,  -gspr);     // dioload.c:435
    }
    stampRHS(ctx.rhs, this._posPrimeNode, -ieq);     // dioload.c:439 (cdeq sign-flipped)
    stampRHS(ctx.rhs, this._nodeCathode, ieq);       // dioload.c:440
  }

  checkConvergence(ctx: LoadContext): boolean {
    const SLOT_VD = 0, SLOT_ID = 1, SLOT_GEQ = 2;
    const s0 = this._pool.states[0];
    const base = this._stateBase;

    // dioload.c:411-416: CKTnoncon bump on pnjlim  non-convergence
    if (this._pnjlimLimited) return false;

    const voltages = ctx.rhsOld;
    const va = voltages[this._posPrimeNode];
    const vc = voltages[this._nodeCathode];
    const vdRaw = va - vc;

    // dioconv.c DIOconvTest: current-prediction convergence
    const delvd = vdRaw - s0[base + SLOT_VD];
    const id = s0[base + SLOT_ID];   // GMIN-adjusted
    const gd = s0[base + SLOT_GEQ]; // GMIN-adjusted
    const cdhat = id + gd * delvd;
    const tol = ctx.reltol * Math.max(Math.abs(cdhat), Math.abs(id)) + ctx.iabstol;
    return Math.abs(cdhat - id) <= tol;
  }

  getPinCurrents(_rhs: Float64Array): number[] {
    const SLOT_ID = 1;  // diodefs.h DIOcurrent
    // pinLayout order: [A (anode), K (cathode)]
    // Positive = current flowing INTO element at that pin.
    const id = this._pool.states[0][this._stateBase + SLOT_ID];
    return [id, -id];
  }

  /**
   * Engine-driven temperature callback — called by defaultTemperatureHandler on
   * every cktTemp(ctx) pass (end of _setup() and on setCircuitTemp()).
   *
   * cite: diotemp.c:84-85 — if(!DIOtempGiven) here->DIOtemp = ckt->CKTtemp + here->DIOdtemp
   * When no per-instance TEMP override is active (_tempGiven==false), propagate
   * ctx.cktTemp as the operating temperature and recompute all derived parameters.
   * When _tempGiven==true (user called setParam("TEMP", v)), the override is preserved.
   */
  computeTemperature(ctx: TempContext): void {
    // Adopt the live CKTreltol for the breakdown-voltage match (diotemp.c:208).
    this._reltol = ctx.reltol;
    // cite: diotemp.c:84-85 — per-instance TEMP takes precedence over circuit
    // ambient. With an override active (_tempGiven) the operating temperature is
    // owned by setParam("TEMP"); the ambient pass leaves it untouched.
    if (!this._tempGiven) {
      this._params["TEMP"] = ctx.cktTemp;
      this._tp = this._computeZenerTp();
    }
  }

  setParam(key: string, value: number): void {
    if (key in this._params) {
      this._params[key] = value;
      if (key === "TEMP") {
        // cite: diotemp.c:84 — DIOtempGiven marks an explicit per-instance override
        this._tempGiven = true;
      }
      this._tp = this._computeZenerTp();
    }
  }
}

export function createZenerElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
): ZenerAnalogElement {
  return new ZenerAnalogElement(pinNodes, props);
}

// ---------------------------------------------------------------------------
// ZenerElement  CircuitElement implementation
// ---------------------------------------------------------------------------

export class ZenerElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("ZenerDiode", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildZenerPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 0.6875,
      width: 4,
      height: 1.375,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const label = this._visibleLabel();

    const vA = signals?.getPinVoltage("A");
    const vK = signals?.getPinVoltage("K");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Geometry matching Falstad drawZenerDiode reference
    // p1={x:0,y:0}, p2={x:4,y:0}, bodyLen=1, hs=0.5
    const PX = 1 / 16;
    const hs = 8 * PX; // 0.5

    // lead1/lead2 from calcLeads with bodyLen=1
    const lead1 = { x: 1.5, y: 0 };
    const lead2 = { x: 2.5, y: 0 };

    // Anode lead
    drawColoredLead(ctx, signals, vA, 0, 0, lead1.x, lead1.y);

    // Cathode lead
    drawColoredLead(ctx, signals, vK, lead2.x, lead2.y, 4, 0);

    // Body (triangle, cathode bar, wings) stays COMPONENT color
    ctx.setColor("COMPONENT");

    // Filled diode triangle: lead1  lead2 tip
    ctx.drawPolygon([
      { x: lead1.x, y: -hs },
      { x: lead1.x, y: hs },
      { x: lead2.x, y: 0 },
    ], true);

    // Cathode bar: cath0/cath1 are perpendicular to lead1lead2 at lead2
    // direction is along y axis (perpendicular to horizontal wire)
    const cath0 = { x: lead2.x, y: -hs };
    const cath1 = { x: lead2.x, y: hs };
    ctx.drawLine(cath0.x, cath0.y, cath1.x, cath1.y);

    // Zener wings: bent ends at fraction -0.2 and 1.2 along cath0cath1
    // interpPointSingle(a,b,f,g): point at fraction f along ab, offset g perpendicular (along x for vertical bar)
    // Perpendicular to cath0cath1 (which is vertical) is horizontal
    // Wing tips at ±11/16 = ±0.6875 grid units (from Falstad pixel coords ±11 at 16px/unit)
    const wing0 = {
      x: cath0.x - hs,
      y: -11 / 16,
    };
    const wing1 = {
      x: cath1.x + hs,
      y: 11 / 16,
    };
    ctx.drawLine(cath0.x, cath0.y, wing0.x, wing0.y);
    ctx.drawLine(cath1.x, cath1.y, wing1.x, wing1.y);

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(label, 2, -(hs + 0.25), { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildZenerPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "A",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "K",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const ZENER_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const ZENER_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "model",
    propertyKey: "model",
    convert: (v) => v,
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// ZenerDiodeDefinition
// ---------------------------------------------------------------------------

function zenerCircuitFactory(props: PropertyBag): ZenerElement {
  return new ZenerElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const ZenerDiodeDefinition: StandaloneComponentDefinition = {
  name: "ZenerDiode",
  typeId: -1,
  factory: zenerCircuitFactory,
  pinLayout: buildZenerPinDeclarations(),
  voltageProbes: [{ name: "V", pos: "A", neg: "K" }],
  propertyDefs: ZENER_PROPERTY_DEFS,
  attributeMap: ZENER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "Zener Diode  Shockley diode with reverse breakdown at tBV.\n" +
    "Forward: Id = IS * (exp(Vd/(N*Vt)) - 1)\n" +
    "Reverse-cubic: Id = -IS*(1 + (3*nVt/(vd*e))^3)\n" +
    "Breakdown (Vd < -tBV): Id = -IS * exp(-(Vd+tBV)/(NBV*Vt))",
  models: {},
  modelRegistry: {
    "spice": {
      kind: "inline",
      factory: createDiodeElement,
      paramDefs: ZENER_SPICE_L1_PARAM_DEFS,
      params: ZENER_SPICE_L1_DEFAULTS,
      spice: { device: "DIO", deckNodeTokens: ["A", "K"] },
    },
    "simplified": {
      kind: "inline",
      factory: createZenerElement,
      paramDefs: ZENER_PARAM_DEFS,
      params: ZENER_PARAM_DEFAULTS,
      spice: { device: "DIO", deckNodeTokens: ["A", "K"] },
    },
  },
  defaultModel: "spice",
};
