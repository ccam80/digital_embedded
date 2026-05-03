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
import type { PoolBackedAnalogElement } from "../../solver/analog/element.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import {
  MODEINITJCT,
  MODEINITFIX,
  MODEINITSMSIG,
  MODEINITTRAN,
  MODETRANOP,
  MODEUIC,
} from "../../solver/analog/ckt-mode.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
import { pnjlim } from "../../solver/analog/newton-raphson.js";
import { defineModelParams, kelvinToCelsius } from "../../core/model-params.js";
import { createDiodeElement } from "./diode.js";
import type { StatePoolRef } from "../../solver/analog/state-pool.js";
import { defineStateSchema } from "../../solver/analog/state-schema.js";

// ---------------------------------------------------------------------------
// Physical constants (ngspice ngspice.h / const.h values)
// ---------------------------------------------------------------------------

const CONSTboltz = 1.3806226e-23;
const CHARGE = 1.6021918e-19;
const CONSTe = Math.E;          // used in cubic approximation (dioload.c:254)
const REFTEMP = 300.15;         // 27 Â°C reference temperature

/** Minimum conductance for numerical stability (GMIN). */
const GMIN = 1e-12;

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
    TCV: { default: 0,    unit: "V/Â°C", description: "Breakdown voltage temperature coefficient" },
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
    RS:  { default: 0,        unit: "ÃŽ",  description: "Ohmic (series) resistance" },
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

const ZENER_STATE_SCHEMA = defineStateSchema("ZenerElement", [
  { name: "VD",  doc: "Diode junction voltage (V)" },
  { name: "GEQ", doc: "GMIN-adjusted junction conductance (S)" },
  { name: "IEQ", doc: "Linearized current source (A)" },
  { name: "ID",  doc: "GMIN-adjusted diode current (A)" },
]);

// ---------------------------------------------------------------------------
// Temperature scaling  tBV derivation (cite: diotemp.c:206-244)
// ---------------------------------------------------------------------------

/**
 * Compute the temperature-scaled breakdown voltage (DIOtBrkdwnV) from BV and IBV.
 *
 * cite: diotemp.c:208-244  temperature-adjusts BV using DIOtcv (tlev==0 path),
 * then iterates xbv to find the intersection of the forward and reverse diode
 * characteristics at the breakdown current cbv.
 *
 * @param BV    Room-temperature breakdown voltage
 * @param IBV   Breakdown current (DIObreakdownCurrent)
 * @param NBV   Breakdown emission coefficient (DIObrkdEmissionCoeff)
 * @param IS    Temperature-scaled saturation current (DIOtSatCur)
 * @param vt    Thermal voltage at circuit temperature
 * @param TCV   Voltage temperature coefficient (DIOtcv), default 0
 * @param dt    Temperature deviation from TNOM in Â°C (T - TNOM)
 */
function computeTBV(
  BV: number,
  IBV: number,
  NBV: number,
  IS: number,
  vt: number,
  TCV: number,
  dt: number,
): number {
  if (!isFinite(BV) || BV >= 1e99) return Infinity;

  // cite: diotemp.c:209-210 (DIOtlev==0 path)
  const tBreakdownVoltage = BV - TCV * dt;

  let cbv = IBV;
  // cite: diotemp.c:219-220: ensure cbv is not unreasonably small
  if (cbv < IS * tBreakdownVoltage / vt) {
    cbv = IS * tBreakdownVoltage / vt;
  }

  // cite: diotemp.c:229-244: iterative xbv refinement
  const tol = 1e-3 * cbv;  // CKTreltol * cbv (using 1e-3 = default reltol)
  let xbv = tBreakdownVoltage - NBV * vt * Math.log(1 + cbv / IS);
  for (let iter = 0; iter < 25; iter++) {
    xbv = tBreakdownVoltage - NBV * vt * Math.log(cbv / IS + 1 - xbv / vt);
    const xcbv = IS * (Math.exp((tBreakdownVoltage - xbv) / (NBV * vt)) - 1 + xbv / vt);
    if (Math.abs(xcbv - cbv) <= tol) break;
  }
  return xbv;
}

// ---------------------------------------------------------------------------
// createZenerElement  AnalogElement factory
// ---------------------------------------------------------------------------

export function createZenerElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): PoolBackedAnalogElement {
  const nodeAnode = pinNodes.get("A")!;
  const nodeCathode = pinNodes.get("K")!;

  const params: Record<string, number> = { ...ZENER_PARAM_DEFAULTS };
  for (const key of props.getModelParamKeys()) {
    params[key] = props.getModelParam<number>(key);
  }
  // diosetup.c:93-95: NBV (DIObrkdEmissionCoeff) defaults to N (DIOemissionCoeff)
  if (isNaN(params.NBV)) params.NBV = params.N;

  // Temperature-derived working values  recomputed whenever params.TEMP changes.
  // cite: dioload.c / diotemp.c  per-instance TEMP (maps to ngspice DIOtemp)
  interface ZenerTp {
    vt: number;
    nVt: number;
    nbvVt: number;
    tVcrit: number;
    vcritBrk: number;
    tBV: number;
  }

  function computeZenerTp(): ZenerTp {
    // cite: dioload.c / diotemp.c  per-instance TEMP (maps to ngspice DIOtemp)
    const circuitTemp = params.TEMP;
    const dt = circuitTemp - (isFinite(params.TNOM) ? params.TNOM : REFTEMP);
    const vt = (CONSTboltz * circuitTemp) / CHARGE;
    const nVt = params.N * vt;
    const nbvVt = params.NBV * vt;
    // tVcrit: DIOtVcrit = vt * ln(vt / (IS * sqrt(2)))  cite: diotemp.c
    const tVcrit = nVt * Math.log(nVt / (params.IS * Math.SQRT2));
    // vcritBrk: pnjlim vcrit for breakdown domain using nbvVt  cite: dioload.c:189-190
    const vcritBrk = nbvVt * Math.log(nbvVt / (params.IS * Math.SQRT2));
    // tBV: temperature-scaled breakdown voltage  cite: diotemp.c:208-244
    const tBV = computeTBV(
      params.BV, params.IBV, params.NBV, params.IS, vt,
      isFinite(params.TCV) ? params.TCV : 0,
      dt,
    );
    return { vt, nVt, nbvVt, tVcrit, vcritBrk, tBV };
  }

  let tp = computeZenerTp();

  // State pool slot indices
  const SLOT_VD = 0, SLOT_GEQ = 1, SLOT_IEQ = 2, SLOT_ID = 3;

  // Pool binding  only the pool reference is retained. Individual state
  // arrays are NOT cached as member variables: every access inside load()
  // reads pool.states[N] at call time. Mirrors ngspice CKTstate0 pointer
  // access (dioload.c never caches state pointers on devices).
  let pool: StatePoolRef;
  let base: number;

  // Ephemeral per-iteration pnjlim limiting flag (ngspice Check / DIOload  CKTnoncon++)
  let pnjlimLimited = false;

  // Internal prime node (DIOposPrimeNode)- set during setup(), read by load()
  let _posPrimeNode = nodeAnode;

  // TSTALLOC handles- closure-local, set during setup(), read inside load()
  let _hPosPP  = -1;
  let _hNegPP  = -1;
  let _hPPPos  = -1;
  let _hPPNeg  = -1;
  let _hPosPos = -1;
  let _hNegNeg = -1;
  let _hPPPP   = -1;

  // Internal node labels- recorded during setup() when RS > 0
  const internalLabels: string[] = [];

  const zenerElement: PoolBackedAnalogElement = {
    label: "",
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.DIO,

    _pinNodes: new Map(pinNodes),
    _stateBase: -1,
    branchIndex: -1,

    poolBacked: true as const,
    stateSize: 4,
    stateSchema: ZENER_STATE_SCHEMA,

    setup(ctx: import("../../solver/analog/setup-context.js").SetupContext): void {
      const solver = ctx.solver;
      const posNode = zenerElement._pinNodes.get("A")!;
      const negNode = zenerElement._pinNodes.get("K")!;

      // State slots- diosetup.c:198-199
      zenerElement._stateBase = ctx.allocStates(4);
      base = zenerElement._stateBase;

      // Internal node- diosetup.c:204-224
      // ngspice gating: RS > 0 â†’ allocate anode-prime node
      if (params.RS === 0 || !params.RS) {
        _posPrimeNode = posNode;
      } else {
        _posPrimeNode = ctx.makeVolt(zenerElement.label ?? "Z", "internal");
        internalLabels.push("internal");
      }

      // TSTALLOC sequence- diosetup.c:232-238 (identical to PB-DIO)
      _hPosPP  = solver.allocElement(posNode,       _posPrimeNode); // (1)
      _hNegPP  = solver.allocElement(negNode,       _posPrimeNode); // (2)
      _hPPPos  = solver.allocElement(_posPrimeNode, posNode);       // (3)
      _hPPNeg  = solver.allocElement(_posPrimeNode, negNode);       // (4)
      _hPosPos = solver.allocElement(posNode,       posNode);       // (5)
      _hNegNeg = solver.allocElement(negNode,       negNode);       // (6)
      _hPPPP   = solver.allocElement(_posPrimeNode, _posPrimeNode); // (7)
    },

    getInternalNodeLabels(): readonly string[] {
      return internalLabels;
    },

    initState(poolRef: StatePoolRef): void {
      pool = poolRef;
      base = zenerElement._stateBase;
    },

    load(ctx: LoadContext): void {
      // Direct state-array access per call  no cached Float64Array refs.
      const s0 = pool.states[0];
      const s1 = pool.states[1];

      const voltages = ctx.rhsOld;
      const mode = ctx.cktMode;

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
          gdOp = params.IS * evd / tp.nVt;
        } else if (!isFinite(tp.tBV) || vdOp >= -tp.tBV) {
          // reverse-cubic  cite: dioload.c:251-257
          const arg = 3 * tp.nVt / (vdOp * CONSTe);
          const arg3 = arg * arg * arg;
          gdOp = params.IS * 3 * arg3 / (-vdOp);
        } else {
          // breakdown  cite: dioload.c:261-263
          const evrev = Math.exp(-(tp.tBV + vdOp) / tp.nbvVt);
          gdOp = params.IS * evrev / tp.nbvVt;
        }
        // store capd (small-signal conductance)  dioload.c:363 stores capd here;
        // for a resistive zener (no cap), we store gd for any bypass/convergence use.
        s0[base + SLOT_GEQ] = gdOp + GMIN;
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
        // dioload.c:130-132: MODEINITJCT && MODETRANOP && MODEUIC  DIOinitCond
        // Simplified model has no IC param; fall back to 0  (DIOinitCond default).
        vdRaw = 0;
      } else if ((mode & MODEINITJCT) && (params.OFF !== undefined && params.OFF !== 0)) {
        // dioload.c:133-134: MODEINITJCT && DIOoff  vd = 0
        vdRaw = 0;
      } else if (mode & MODEINITJCT) {
        // dioload.c:135-136: MODEINITJCT else  vd = tVcrit
        vdRaw = tp.tVcrit;
      } else if ((mode & MODEINITFIX) && (params.OFF !== undefined && params.OFF !== 0)) {
        // dioload.c:137-138: MODEINITFIX && DIOoff  vd = 0
        vdRaw = 0;
      } else {
        // dioload.c:151-152: vd from rhsOld (current NR iterate voltages)
        const va = voltages[_posPrimeNode];
        const vc = voltages[nodeCathode];
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
        pnjlimLimited = false;
      } else if (isFinite(tp.tBV) && vdRaw < Math.min(0, -tp.tBV + 10 * tp.nbvVt)) {
        // dioload.c:183-195: breakdown path  pnjlim in reflected domain.
        // Z-W3-6: use vcritBrk (computed from nbvVt) not tVcrit  cite: dioload.c:189-190
        const vdtemp = -(vdRaw + tp.tBV);
        const vdtempOld = -(vdOld + tp.tBV);
        const reflResult = pnjlim(vdtemp, vdtempOld, tp.nbvVt, tp.vcritBrk);
        pnjlimLimited = reflResult.limited;
        vdLimited = -(reflResult.value + tp.tBV);
      } else {
        // dioload.c:196-204: standard pnjlim for forward/normal-reverse.
        const vdResult = pnjlim(vdRaw, vdOld, tp.nVt, tp.tVcrit);
        vdLimited = vdResult.value;
        pnjlimLimited = vdResult.limited;
      }

      if (pnjlimLimited) ctx.noncon.value++;

      if (ctx.limitingCollector) {
        ctx.limitingCollector.push({
          elementIndex: zenerElement.elementIndex ?? -1,
          label: zenerElement.label ?? "",
          junction: "AK",
          limitType: "pnjlim",
          vBefore: vdRaw,
          vAfter: vdLimited,
          wasLimited: pnjlimLimited,
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
        cdb = params.IS * (evd - 1);
        gdb = params.IS * evd / tp.nVt;
      } else if (!isFinite(tp.tBV) || vdLimited >= -tp.tBV) {
        // Reverse-cubic region  cite: dioload.c:251-258
        // arg = 3*vte / (vd * CONSTe); cdb = -IS*(1+arg^3); gdb = IS*3*arg^3/(-vd)
        const arg = 3 * tp.nVt / (vdLimited * CONSTe);
        const arg3 = arg * arg * arg;
        cdb = -params.IS * (1 + arg3);
        gdb = params.IS * 3 * arg3 / (-vdLimited);
      } else {
        // Breakdown region  cite: dioload.c:259-264
        // cdb = -IS * exp(-(tBV+vd)/vtebrk); gdb = IS * exp(...)/vtebrk
        const evrev = Math.exp(-(tp.tBV + vdLimited) / tp.nbvVt);
        cdb = -params.IS * evrev;
        gdb = params.IS * evrev / tp.nbvVt;
      }

      // cd / gd = intrinsic junction values (no sidewall/tunnel for simplified model)
      let cd = cdb;
      let gd = gdb;

      // -----------------------------------------------------------------------
      // Z-W3-3: GMIN as Norton pair  cite: dioload.c:297-299, 310-311
      // Add GMIN to both gd and cd before ieq computation.
      // -----------------------------------------------------------------------
      gd += GMIN;       // cite: dioload.c:298 (else branch: gd += CKTgmin)
      cd += GMIN * vdLimited;  // cite: dioload.c:299: cd += CKTgmin*vd

      // -----------------------------------------------------------------------
      // Z-W3-7: state0 writes  store GMIN-adjusted pair  cite: dioload.c:417-419
      // ngspice writes the post-GMIN cd and gd to CKTstate0.
      // -----------------------------------------------------------------------
      s0[base + SLOT_VD]  = vdLimited;
      s0[base + SLOT_ID]  = cd;           // GMIN-adjusted (matches dioload.c:418)
      s0[base + SLOT_GEQ] = gd;           // GMIN-adjusted (matches dioload.c:419)

      const ieq = cd - gd * vdLimited;
      s0[base + SLOT_IEQ] = ieq;

      // -----------------------------------------------------------------------
      // Stamp Norton companion  cite: dioload.c:429-441
      // Stamps through pre-allocated handles from setup()
      //
      // Series-resistance T-model (gspr) gating mirrors dioload.c:98 and the
      // setup-side gating at diosetup.c:204 (DIOresist == 0 â†’ no prime node).
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

      solver.stampElement(_hPPPP,   gd + gspr);   // dioload.c:431
      solver.stampElement(_hPPNeg,  -gd);         // dioload.c:436
      solver.stampElement(_hNegPP,  -gd);         // dioload.c:437
      solver.stampElement(_hNegNeg, gd);          // dioload.c:432
      if (gspr > 0) {
        solver.stampElement(_hPosPos, gspr);      // dioload.c:433
        solver.stampElement(_hPosPP,  -gspr);     // dioload.c:434
        solver.stampElement(_hPPPos,  -gspr);     // dioload.c:435
      }
      stampRHS(ctx.rhs, _posPrimeNode, -ieq);     // dioload.c:439 (cdeq sign-flipped)
      stampRHS(ctx.rhs, nodeCathode, ieq);        // dioload.c:440
    },

    checkConvergence(ctx: LoadContext): boolean {
      const s0 = pool.states[0];
      // dioload.c:411-416: CKTnoncon bump on pnjlim  non-convergence
      if (pnjlimLimited) return false;

      const voltages = ctx.rhsOld;
      const va = voltages[_posPrimeNode];
      const vc = voltages[nodeCathode];
      const vdRaw = va - vc;

      // dioconv.c DIOconvTest: current-prediction convergence
      const delvd = vdRaw - s0[base + SLOT_VD];
      const id = s0[base + SLOT_ID];   // GMIN-adjusted
      const gd = s0[base + SLOT_GEQ]; // GMIN-adjusted
      const cdhat = id + gd * delvd;
      const tol = ctx.reltol * Math.max(Math.abs(cdhat), Math.abs(id)) + ctx.iabstol;
      return Math.abs(cdhat - id) <= tol;
    },

    getPinCurrents(_rhs: Float64Array): number[] {
      // pinLayout order: [A (anode), K (cathode)]
      // Positive = current flowing INTO element at that pin.
      const id = pool.states[0][base + SLOT_ID];
      return [id, -id];
    },

    setParam(key: string, value: number): void {
      if (key in params) {
        params[key] = value;
        tp = computeZenerTp();
      }
    },
  };

  return zenerElement;
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
    // Wing tips at Â±11/16 = Â±0.6875 grid units (from Falstad pixel coords Â±11 at 16px/unit)
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
    },
    "simplified": {
      kind: "inline",
      factory: createZenerElement,
      paramDefs: ZENER_PARAM_DEFS,
      params: ZENER_PARAM_DEFAULTS,
    },
  },
  defaultModel: "spice",
};
