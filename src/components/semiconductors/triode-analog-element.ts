/**
 * TriodeAnalogElement — Koren plate-current analog leaf.
 *
 * Internal-only sub-element emitted by the user-facing `Triode` parent
 * (`triode.ts`, `kind: "netlist"`). Carries the full Koren two-voltage
 * nonlinearity, per-NR linearisation (gm = ∂I_P/∂V_GK, gds = ∂I_P/∂V_PK),
 * V_GK step limiting, BJTconvTest-style `cphat` convergence check, and
 * Koren-linearised pin currents.
 *
 *   E1  = V_PK / K_P · ln(1 + exp(K_P · (1/µ + V_GK / sqrt(K_VB + V_PK²))))
 *   I_P = (E1 / K_G1)^EX   when E1 > 0, else 0
 *
 * Pin labels (3): P (plate / anode), G (grid), K (cathode).
 *
 * 6 TSTALLOC handles, allocated unconditionally in setup() in the same
 * order the original closure-bound composite issued them via the inner
 * VCCS sub-element + 2 own gds entries:
 *   (P,G) +gm   (P,K) -gm   (K,G) -gm   (K,K) +gm   (P,P) +gds   (K,P) -gds
 *
 * Pool-backed (`PoolBackedAnalogElement`): per-NR state lives in
 * the shared StatePool so NR rollback recovers `_vgk` and the cached
 * Koren operating-point (`ip`, `gm`, `gds`, `vgk`, `vpk`) on retries.
 */

import {
  PoolBackedAnalogElement,
  type AnalogElement,
} from "../../solver/analog/element.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
import { defineStateSchema } from "../../solver/analog/state-schema.js";
import type { StateSchema } from "../../solver/analog/state-schema.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";
import { PropertyBag } from "../../core/properties.js";
import type { ComponentDefinition, ParamDef } from "../../core/registry.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

/** Minimum conductance for numerical stability. */
const GMIN = 1e-12;

/** Maximum V_GK step per NR iteration (prevents exponential overflow). */
const VGK_MAX_STEP = 1.0;

// ---------------------------------------------------------------------------
// State schema
// ---------------------------------------------------------------------------

const TRIODE_ANALOG_SCHEMA: StateSchema = defineStateSchema("TriodeAnalog", [
  { name: "VGK", doc: "Effective V_GK after step limiting (NR-iteration cached)" },
  { name: "VPK", doc: "Cached V_PK for op-point linearisation" },
  { name: "IP",  doc: "Plate current at the cached operating point" },
  { name: "GM",  doc: "Transconductance dI_P/dV_GK at the cached op-point" },
  { name: "GDS", doc: "Plate output conductance dI_P/dV_PK at the cached op-point" },
]);

const SLOT_VGK = 0;
const SLOT_VPK = 1;
const SLOT_IP  = 2;
const SLOT_GM  = 3;
const SLOT_GDS = 4;

// ---------------------------------------------------------------------------
// Koren operating-point computation
// ---------------------------------------------------------------------------

interface TriodeOperatingPoint {
  vgk: number;
  vpk: number;
  ip: number;
  /** dI_P/dV_GK- transconductance */
  gm: number;
  /** dI_P/dV_PK- plate (output) conductance */
  gds: number;
}

function computeTriodeOp(
  vgk: number,
  vpk: number,
  mu: number,
  kp: number,
  kvb: number,
  kg1: number,
  ex: number,
): TriodeOperatingPoint {
  // Clamp V_PK to avoid sqrt of negative
  const vpkSafe = Math.max(vpk, 0);

  // Koren E1 inner argument
  const innerArg = kp * (1 / mu + vgk / Math.sqrt(kvb + vpkSafe * vpkSafe));

  // E1 = V_PK/K_P · ln(1 + exp(innerArg)), clamped to prevent overflow
  const clampedArg = Math.min(innerArg, 500);
  const logTerm = Math.log1p(Math.exp(clampedArg));
  const e1 = (vpkSafe / kp) * logTerm;

  // I_P = (E1/K_G1)^EX when E1 > 0
  const ip = e1 > 0 ? Math.pow(e1 / kg1, ex) : 0;

  // --- Analytical Jacobian for NR linearisation ---
  //
  // Let sq = sqrt(kvb + vpkSafe²), so dSq/dVpk = vpkSafe/sq.
  // innerArg = kp*(1/mu + vgk/sq)
  // d(innerArg)/dVpk = kp * vgk * (-1/sq²) * (vpkSafe/sq) = -kp*vgk*vpkSafe/sq³
  //
  // dE1/dVpk = logTerm/kp + (vpkSafe/kp)*sigmoid*(-kp*vgk*vpkSafe/sq³)
  //          = logTerm/kp - vpkSafe²*vgk*sigmoid/sq³
  //   where sigmoid = exp(innerArg)/(1+exp(innerArg))

  const sq = Math.sqrt(kvb + vpkSafe * vpkSafe);
  const sigmoid = clampedArg > 499
    ? 1.0
    : Math.exp(clampedArg) / (1 + Math.exp(clampedArg));

  const dE1dVgk = e1 > 0 ? vpkSafe * sigmoid / sq : 0;
  const dE1dVpk = e1 > 0
    ? logTerm / kp - vpkSafe * vpkSafe * vgk * sigmoid / (sq * sq * sq)
    : 0;

  // dI_P/dE1 = EX * (E1/K_G1)^(EX-1) / K_G1  when E1 > 0
  const dIpdE1 = e1 > 0 ? ex * Math.pow(e1 / kg1, ex - 1) / kg1 : 0;

  const gm = dIpdE1 * dE1dVgk + GMIN;
  const gds = dIpdE1 * dE1dVpk + GMIN;

  return { vgk, vpk, ip, gm, gds };
}

// ---------------------------------------------------------------------------
// Param declarations
// ---------------------------------------------------------------------------

const TRIODE_ANALOG_PARAM_DEFS: ParamDef[] = [
  { key: "mu",  default: 100  },
  { key: "kp",  default: 600  },
  { key: "kg1", default: 1060 },
  { key: "kvb", default: 300  },
  { key: "ex",  default: 1.4  },
  { key: "rGI", default: 2000 },
];

const TRIODE_ANALOG_DEFAULTS: Record<string, number> = {
  mu: 100, kp: 600, kg1: 1060, kvb: 300, ex: 1.4, rGI: 2000,
};

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

const TRIODE_ANALOG_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.OUTPUT, label: "P", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "G", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "K", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// TriodeAnalogElement
// ---------------------------------------------------------------------------

export class TriodeAnalogElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BJT;
  readonly stateSchema: StateSchema = TRIODE_ANALOG_SCHEMA;
  readonly stateSize: number = TRIODE_ANALOG_SCHEMA.size;

  /** Plate node (digiTS pin "P"). */
  private readonly _nodeP: number;
  /** Cathode node (digiTS pin "K"). */
  private readonly _nodeK: number;
  /** Grid node (digiTS pin "G"). */
  private readonly _nodeG: number;

  /** TSTALLOC handle (P,G) +gm. */
  private _hPG = -1;
  /** TSTALLOC handle (P,K) -gm. */
  private _hPK = -1;
  /** TSTALLOC handle (K,G) -gm. */
  private _hKG = -1;
  /** TSTALLOC handle (K,K) +gm. */
  private _hKK = -1;
  /** TSTALLOC handle (P,P) +gds. */
  private _hPP_gds = -1;
  /** TSTALLOC handle (K,P) -gds. */
  private _hKP_gds = -1;

  /** Koren model parameters. */
  private _p: {
    mu: number;
    kp: number;
    kvb: number;
    kg1: number;
    ex: number;
    rGI: number;
  };

  constructor(
    pinNodes: ReadonlyMap<string, number>,
    props: PropertyBag,
  ) {
    super(pinNodes);
    this._nodeP = pinNodes.get("P")!; // plate
    this._nodeG = pinNodes.get("G")!; // grid
    this._nodeK = pinNodes.get("K")!; // cathode

    this._p = {
      mu:  props.getModelParam<number>("mu"),
      kp:  props.getModelParam<number>("kp"),
      kvb: props.getModelParam<number>("kvb"),
      kg1: props.getModelParam<number>("kg1"),
      ex:  props.getModelParam<number>("ex"),
      rGI: props.getModelParam<number>("rGI"),
    };
  }

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const nP = this._nodeP;
    const nG = this._nodeG;
    const nK = this._nodeK;

    // State slots- per-NR cached operating point.
    if (this._stateBase === -1) {
      this._stateBase = ctx.allocStates(this.stateSize);
    }

    // Seed cached op-point at V_GK=0, V_PK=0 so the first NR iteration's
    // step-limiter reads a sensible prior value out of the pool.
    const seed = computeTriodeOp(
      0, 0, this._p.mu, this._p.kp, this._p.kvb, this._p.kg1, this._p.ex,
    );
    const s0 = this._pool.states[0];
    const base = this._stateBase;
    s0[base + SLOT_VGK] = seed.vgk;
    s0[base + SLOT_VPK] = seed.vpk;
    s0[base + SLOT_IP]  = seed.ip;
    s0[base + SLOT_GM]  = seed.gm;
    s0[base + SLOT_GDS] = seed.gds;

    // 6-stamp TSTALLOC sequence- 4 transconductance entries (gm, matching
    // VCCS sub-element ordering: pCtP / pCtN / nCtP / nCtN) followed by the
    // 2 composite-owned plate output-conductance entries.
    this._hPG     = solver.allocElement(nP, nG);  // (P,G) +gm
    this._hPK     = solver.allocElement(nP, nK);  // (P,K) -gm
    this._hKG     = solver.allocElement(nK, nG);  // (K,G) -gm
    this._hKK     = solver.allocElement(nK, nK);  // (K,K) +gm
    this._hPP_gds = solver.allocElement(nP, nP);  // (P,P) +gds
    this._hKP_gds = solver.allocElement(nK, nP);  // (K,P) -gds
  }

  load(ctx: LoadContext): void {
    const voltages = ctx.rhsOld;
    const vP = voltages[this._nodeP];
    const vG = voltages[this._nodeG];
    const vK = voltages[this._nodeK];

    const vgkNew = vG - vK;
    const vpkNew = vP - vK;

    const s0 = this._pool.states[0];
    const base = this._stateBase;
    const vgkPrev = s0[base + SLOT_VGK];

    // Voltage limiting: clamp V_GK step (prevents exponential overflow in Koren formula)
    const dvgk = vgkNew - vgkPrev;
    const limitedDvgk = Math.max(-VGK_MAX_STEP, Math.min(VGK_MAX_STEP, dvgk));
    const limited = limitedDvgk !== dvgk;
    const vgkLimited = vgkPrev + limitedDvgk;
    if (limited) ctx.noncon.value++;

    const op = computeTriodeOp(
      vgkLimited, vpkNew,
      this._p.mu, this._p.kp, this._p.kvb, this._p.kg1, this._p.ex,
    );

    const { ip, gm, gds } = op;
    const vgkOp = op.vgk;
    const vpkOp = op.vpk;

    const solver = ctx.solver;

    // Transconductance gm stamps:
    //   (P,G) +gm   (P,K) -gm   (K,G) -gm   (K,K) +gm
    solver.stampElement(this._hPG, +gm);
    solver.stampElement(this._hPK, -gm);
    solver.stampElement(this._hKG, -gm);
    solver.stampElement(this._hKK, +gm);

    // Output conductance gds stamps:
    //   (P,P) +gds   (K,P) -gds
    solver.stampElement(this._hPP_gds, +gds);
    solver.stampElement(this._hKP_gds, -gds);

    // Norton equivalent RHS:
    //   ieq = Ip - gm*Vgk - gds*Vpk
    //   stampRHS(P, -ieq); stampRHS(K, +ieq)
    const ieq = ip - gm * vgkOp - gds * vpkOp;
    stampRHS(ctx.rhs, this._nodeP, -ieq);
    stampRHS(ctx.rhs, this._nodeK, +ieq);

    // Cache operating point in pool slots- read by getPinCurrents,
    // checkConvergence, and the next NR iteration's step limiter.
    s0[base + SLOT_VGK] = vgkLimited;
    s0[base + SLOT_VPK] = vpkNew;
    s0[base + SLOT_IP]  = ip;
    s0[base + SLOT_GM]  = gm;
    s0[base + SLOT_GDS] = gds;
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const vP = rhs[this._nodeP];
    const vG = rhs[this._nodeG];
    const vK = rhs[this._nodeK];

    const s0 = this._pool.states[0];
    const base = this._stateBase;
    const ip    = s0[base + SLOT_IP];
    const gm    = s0[base + SLOT_GM];
    const gds   = s0[base + SLOT_GDS];
    const vgkOp = s0[base + SLOT_VGK];
    const vpkOp = s0[base + SLOT_VPK];

    // Plate current: I_P = ip + gm*(V_GK - vgkOp) + gds*(V_PK - vpkOp)
    // Positive = flowing into the plate (from external circuit into element)
    const iPlate = ip + gm * ((vG - vK) - vgkOp) + gds * ((vP - vK) - vpkOp);

    // Grid current: zero (no grid-current model in spec body).
    const iGrid = 0;

    // Cathode current: KCL- all three must sum to zero
    const iCathode = -(iPlate + iGrid);

    // pinLayout order: P, G, K
    return [iPlate, iGrid, iCathode];
  }

  checkConvergence(ctx: LoadContext): boolean {
    const voltages = ctx.rhsOld;
    const vP = voltages[this._nodeP];
    const vG = voltages[this._nodeG];
    const vK = voltages[this._nodeK];

    const vgkRaw = vG - vK;
    const vpkRaw = vP - vK;

    const s0 = this._pool.states[0];
    const base = this._stateBase;
    const ip    = s0[base + SLOT_IP];
    const gmOp  = s0[base + SLOT_GM];
    const gdsOp = s0[base + SLOT_GDS];
    const vgkPrev = s0[base + SLOT_VGK];
    const vpkPrev = s0[base + SLOT_VPK];

    // BJTconvTest-style current prediction for triode
    const delvgk = vgkRaw - vgkPrev;
    const delvpk = vpkRaw - vpkPrev;

    const cphat = ip + gmOp * delvgk + gdsOp * delvpk;

    const tolP = ctx.reltol * Math.max(Math.abs(cphat), Math.abs(ip)) + ctx.iabstol;

    return Math.abs(cphat - ip) <= tolP;
  }

  setParam(key: string, value: number): void {
    if (key in this._p) {
      (this._p as Record<string, number>)[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const TriodeAnalogDefinition: ComponentDefinition = {
  name: "TriodeAnalog",
  typeId: -1,
  internalOnly: true,
  pinLayout: TRIODE_ANALOG_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: TRIODE_ANALOG_PARAM_DEFS,
      params: TRIODE_ANALOG_DEFAULTS,
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number): AnalogElement =>
        new TriodeAnalogElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
