/**
 * Two-winding transformer component.
 *
 * Wraps a CoupledInductorPair to present a 4-terminal device:
 *   P1 (primary+), P2 (primary−), S1 (secondary+), S2 (secondary−)
 *
 * Derived parameters:
 *   L_secondary = L_primary · N²
 *   M = k · √(L_primary · L_secondary) = k · L_primary · N
 *
 * Each winding includes a series winding resistance for ohmic loss modelling.
 *
 * The MNA stamp follows the "pre-compute then stamp" pattern from inductor.ts:
 * stampCompanion() recomputes the companion coefficients and updates history
 * state; stamp() applies the stored coefficients to the solver.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElementCore, ReactiveAnalogElement, IntegrationMethod, LoadContext } from "../../solver/analog/element.js";
import { niIntegrate } from "../../solver/analog/ni-integrate.js";
import { MODEDC, MODEINITPRED, MODEINITTRAN, MODEUIC } from "../../solver/analog/ckt-mode.js";
import { CoupledInductorPair } from "../../solver/analog/coupled-inductor.js";
import { defineModelParams } from "../../core/model-params.js";
import type { StatePoolRef } from "../../core/analog-types.js";
import { defineStateSchema, applyInitialValues } from "../../solver/analog/state-schema.js";
import type { StateSchema } from "../../solver/analog/state-schema.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: TRANSFORMER_PARAM_DEFS, defaults: TRANSFORMER_DEFAULTS } = defineModelParams({
  primary: {
    turnsRatio:          { default: 1.0,   description: "Secondary to primary turns ratio N (output/input)", min: 0.001 },
    primaryInductance:   { default: 10e-3, unit: "H", description: "Primary winding self-inductance in henries", min: 1e-12 },
    couplingCoefficient: { default: 0.99,  description: "Magnetic coupling coefficient (0 = no coupling, 1 = ideal)", min: 0, max: 1 },
  },
  secondary: {
    primaryResistance:   { default: 1.0,   unit: "Ω", description: "Primary winding series resistance in ohms", min: 0 },
    secondaryResistance: { default: 1.0,   unit: "Ω", description: "Secondary winding series resistance in ohms", min: 0 },
    IC1:  { default: NaN, unit: "A", description: "Initial condition current for primary winding (UIC)" },
    IC2:  { default: NaN, unit: "A", description: "Initial condition current for secondary winding (UIC)" },
    M:    { default: 1,               description: "Parallel multiplicity factor (applied at stamp time per indload.c:41,107)" },
  },
});

// ---------------------------------------------------------------------------
// State pool schema — 13 slots
// ---------------------------------------------------------------------------

// Slot layout — 13 slots total. Previous values are read from s1/s2/s3
// at the same offsets (pointer-rotation history).
const TRANSFORMER_SCHEMA: StateSchema = defineStateSchema("AnalogLinearTransformerElement", [
  { name: "G11",   doc: "Companion conductance self-1",                               init: { kind: "zero" } },
  { name: "G22",   doc: "Companion conductance self-2",                               init: { kind: "zero" } },
  { name: "G12",   doc: "Companion mutual conductance",                               init: { kind: "zero" } },
  { name: "HIST1", doc: "History voltage source winding 1",                           init: { kind: "zero" } },
  { name: "HIST2", doc: "History voltage source winding 2",                           init: { kind: "zero" } },
  { name: "I1",    doc: "Winding 1 branch current this step",                         init: { kind: "zero" } },
  { name: "I2",    doc: "Winding 2 branch current this step",                         init: { kind: "zero" } },
  { name: "PHI1",  doc: "Total flux linkage winding 1",                               init: { kind: "zero" } },
  { name: "PHI2",  doc: "Total flux linkage winding 2",                               init: { kind: "zero" } },
  { name: "CCAP1", doc: "NIintegrate ccap history winding 1 (maps to CKTstate1+INDflux implicit)", init: { kind: "zero" } },
  { name: "CCAP2", doc: "NIintegrate ccap history winding 2 (maps to CKTstate1+INDflux implicit)", init: { kind: "zero" } },
  { name: "VOLT1", doc: "Winding 1 terminal voltage (indload.c:114-116 INDvolt)",     init: { kind: "zero" } },
  { name: "VOLT2", doc: "Winding 2 terminal voltage (indload.c:114-116 INDvolt)",     init: { kind: "zero" } },
]);

const SLOT_G11   = 0;
const SLOT_G22   = 1;
const SLOT_G12   = 2;
const SLOT_HIST1 = 3;
const SLOT_HIST2 = 4;
const SLOT_I1    = 5;
const SLOT_I2    = 6;
const SLOT_PHI1  = 7;
const SLOT_PHI2  = 8;
const SLOT_CCAP1 = 9;
const SLOT_CCAP2 = 10;
const SLOT_VOLT1 = 11;
const SLOT_VOLT2 = 12;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildTransformerPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "P1",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "P2",
      defaultBitWidth: 1,
      position: { x: 0, y: 2 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "S1",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "S2",
      defaultBitWidth: 1,
      position: { x: 4, y: 2 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// TransformerElement — CircuitElement (visual/editor representation)
// ---------------------------------------------------------------------------

export class TransformerElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Transformer", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildTransformerPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    // Pins at y=0 and y=2 (grid units); bounding box spans full extent
    return {
      x: this.position.x,
      y: this.position.y,
      width: 4,
      height: 2,
    };
  }

  draw(ctx: RenderContext, _signals?: PinVoltageAccess): void {
    // Falstad reference (64×32px bounding box, 16px = 1 grid unit):
    //   Two vertical coil columns: primary at x=21px, secondary at x=43px
    //   Each column has 3 arcs stacked vertically at cy=5.333, 16, 26.667px
    //   All arcs: start=3π/2 (top), end=5π/2 (bottom+wrap) — right-facing semicircles
    //   Vertical connecting lines at x=21 and x=43 between arc segments
    //   Core: two vertical lines at x=30 and x=34, y=0 to y=32
    //   Lead lines: (0,0)→(21,0), (0,32)→(21,32), (64,0)→(43,0), (64,32)→(43,32)

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    const r = 5.333333 / 16; // arc radius in grid units
    const arcStart = (3 * Math.PI) / 2; // 4.71238898038469
    const arcEnd   = (5 * Math.PI) / 2; // 7.85398163397448

    // Lead lines — horizontal from pins to coil columns
    ctx.drawLine(0, 0, 21 / 16, 0);
    ctx.drawLine(4, 0, 43 / 16, 0);
    ctx.drawLine(0, 2, 21 / 16, 2);
    ctx.drawLine(4, 2, 43 / 16, 2);

    // Coil arc centers (cy) in grid units
    const coilCy = [5.333333 / 16, 16 / 16, 26.666667 / 16];
    // Vertical segment endpoints between arcs (top of col, between arcs, bottom of col)
    const segY = [0, 10.666667 / 16, 21.333333 / 16, 2];

    // Primary coil — vertical column at cx=21/16
    const priCx = 21 / 16;
    for (let i = 0; i < 3; i++) {
      ctx.drawArc(priCx, coilCy[i], r, arcStart, arcEnd);
      ctx.drawLine(priCx, segY[i], priCx, segY[i + 1]);
    }

    // Secondary coil — vertical column at cx=43/16
    const secCx = 43 / 16;
    for (let i = 0; i < 3; i++) {
      ctx.drawArc(secCx, coilCy[i], r, arcStart, arcEnd);
      ctx.drawLine(secCx, segY[i], secCx, segY[i + 1]);
    }

    // Iron core — two vertical parallel lines
    ctx.drawLine(30 / 16, 0, 30 / 16, 2);
    ctx.drawLine(34 / 16, 0, 34 / 16, 2);

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// AnalogTransformerElement — MNA implementation
// ---------------------------------------------------------------------------

/**
 * MNA element for the two-winding transformer.
 *
 * Uses two consecutive branch rows: branch1 (primary) and branch1+1
 * (secondary). The element pre-computes companion coefficients in
 * stampCompanion() and applies them in stamp() — identical to the pattern
 * used by AnalogInductorElement in inductor.ts.
 *
 * Node layout (pinNodeIds array positions):
 *   [0] = P1 (primary+)   [1] = P2 (primary−)
 *   [2] = S1 (secondary+) [3] = S2 (secondary−)
 */
export class AnalogTransformerElement implements ReactiveAnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly branchIndex: number;
  readonly isNonlinear = false;
  readonly isReactive = true;
  readonly poolBacked = true as const;
  readonly stateSchema = TRANSFORMER_SCHEMA;
  readonly stateSize = TRANSFORMER_SCHEMA.size;
  stateBaseOffset = -1;

  private _pair: CoupledInductorPair;
  private readonly _branch2: number;
  private _rPri: number;
  private _rSec: number;
  private _IC1: number;
  private _IC2: number;
  private _M: number;
  private _pool!: StatePoolRef;

  constructor(
    pinNodeIds: number[],
    branch1: number,
    lPrimary: number,
    turnsRatio: number,
    k: number,
    rPri: number,
    rSec: number,
    IC1: number = NaN,
    IC2: number = NaN,
    multiplicity: number = 1,
  ) {
    this.pinNodeIds = pinNodeIds;
    this.allNodeIds = pinNodeIds;
    this.branchIndex = branch1;
    this._branch2 = branch1 + 1;
    // turnsRatio = N_primary / N_secondary (e.g. 10 means 10:1 step-down)
    // L_secondary = L_primary / N² so that V_sec = V_pri / N for ideal coupling
    const lSecondary = lPrimary / (turnsRatio * turnsRatio);
    this._pair = new CoupledInductorPair(lPrimary, lSecondary, k);
    this._rPri = rPri;
    this._rSec = rSec;
    this._IC1 = IC1;
    this._IC2 = IC2;
    this._M = multiplicity;
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
    applyInitialValues(TRANSFORMER_SCHEMA, pool, this.stateBaseOffset, {});
  }

  setParam(_key: string, _value: number): void {}

  updateDerivedParams(lPrimary: number, turnsRatio: number, k: number, rPri: number, rSec: number, IC1: number = NaN, IC2: number = NaN, multiplicity: number = 1): void {
    const lSecondary = lPrimary / (turnsRatio * turnsRatio);
    this._pair = new CoupledInductorPair(lPrimary, lSecondary, k);
    this._rPri = rPri;
    this._rSec = rSec;
    this._IC1 = IC1;
    this._IC2 = IC2;
    this._M = multiplicity;
    if (!this._pool) {
      throw new Error("AnalogTransformerElement.updateDerivedParams called before initState");
    }
    applyInitialValues(TRANSFORMER_SCHEMA, this._pool, this.stateBaseOffset, {});
  }

  /**
   * Unified load() — two-winding coupled inductor transformer.
   *
   * Mirrors indload.c:INDload for each winding plus the inline MUTUAL block
   * (indload.c:52-77) for off-diagonal coupling stamps.
   *
   * T-W3-2: Integration gate is !(MODEDC) per indload.c:88, not MODETRAN.
   * T-W3-3: Two niIntegrate() calls (one per winding); SLOT_CCAP1/CCAP2 tracked.
   *         Mutual companion: g12 = ag[0] * M per indload.c:74-75.
   * T-W3-4: UIC flux seed per indload.c:44-46 (IC1/IC2 params).
   * T-W3-5: M (multiplicity) applied at stamp time per indload.c:41,107 (user ruling 3).
   * T-W3-6: SLOT_VOLT1/VOLT2 + MODEINITTRAN copy per indload.c:114-116.
   */
  load(ctx: LoadContext): void {
    const solver = ctx.solver;
    const [p1, p2, sec1, sec2] = this.pinNodeIds;
    const b1 = this.branchIndex;
    const b2 = this._branch2;
    const mode = ctx.cktMode;
    const ag = ctx.ag;

    // T-W3-5: multiplicity factor m per indload.c:41 (m = INDm).
    // Applied at stamp time: newmind = L/m (indload.c:107).
    const m = this._M;
    const L1 = this._pair.l1 / m;
    const L2 = this._pair.l2 / m;
    // Mutual factor scales by m too: MUTfactor = k*sqrt(L1_raw*L2_raw)/m = M_raw/m.
    const Mcoup = this._pair.m / m;

    const voltages = ctx.voltages;
    const base = this.stateBaseOffset;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];
    const s3 = this._pool.states[3];

    // Winding resistances (topology-constant, always stamped).
    if (this._rPri > 0) {
      const gPri = 1 / this._rPri;
      if (p1 !== 0) solver.stampElement(solver.allocElement(p1 - 1, p1 - 1), gPri);
      if (p2 !== 0) solver.stampElement(solver.allocElement(p2 - 1, p2 - 1), gPri);
      if (p1 !== 0 && p2 !== 0) {
        solver.stampElement(solver.allocElement(p1 - 1, p2 - 1), -gPri);
        solver.stampElement(solver.allocElement(p2 - 1, p1 - 1), -gPri);
      }
    }
    if (this._rSec > 0) {
      const gSec = 1 / this._rSec;
      if (sec1 !== 0) solver.stampElement(solver.allocElement(sec1 - 1, sec1 - 1), gSec);
      if (sec2 !== 0) solver.stampElement(solver.allocElement(sec2 - 1, sec2 - 1), gSec);
      if (sec1 !== 0 && sec2 !== 0) {
        solver.stampElement(solver.allocElement(sec1 - 1, sec2 - 1), -gSec);
        solver.stampElement(solver.allocElement(sec2 - 1, sec1 - 1), -gSec);
      }
    }

    // B sub-matrix: branch current incidence in KCL node rows.
    if (p1 !== 0) solver.stampElement(solver.allocElement(p1 - 1, b1), 1);
    if (p2 !== 0) solver.stampElement(solver.allocElement(p2 - 1, b1), -1);
    if (sec1 !== 0) solver.stampElement(solver.allocElement(sec1 - 1, b2), 1);
    if (sec2 !== 0) solver.stampElement(solver.allocElement(sec2 - 1, b2), -1);

    // C sub-matrix: KVL voltage incidence (topology-constant ±1 entries).
    if (p1 !== 0) solver.stampElement(solver.allocElement(b1, p1 - 1), 1);
    if (p2 !== 0) solver.stampElement(solver.allocElement(b1, p2 - 1), -1);
    if (sec1 !== 0) solver.stampElement(solver.allocElement(b2, sec1 - 1), 1);
    if (sec2 !== 0) solver.stampElement(solver.allocElement(b2, sec2 - 1), -1);

    // T-W3-4: UIC branch current override for flux seeding — indload.c:44-46.
    // Applied only when (MODEUIC && MODEINITTRAN) and IC is finite.
    let i1Now = voltages[b1];
    let i2Now = voltages[b2];
    if ((mode & MODEUIC) && (mode & MODEINITTRAN)) {
      if (isFinite(this._IC1)) i1Now = this._IC1;
      if (isFinite(this._IC2)) i2Now = this._IC2;
    }

    // Flux-state update gated on !(MODEDC | MODEINITPRED), per indload.c:43.
    // T-W3-4: UIC path seeds phi1 = L1*IC1 (indload.c:45-46 flux = L/m * initCond).
    if (!(mode & (MODEDC | MODEINITPRED))) {
      s0[base + SLOT_PHI1] = L1 * i1Now + Mcoup * i2Now;
      s0[base + SLOT_PHI2] = L2 * i2Now + Mcoup * i1Now;
      if (mode & MODEINITTRAN) {
        s1[base + SLOT_PHI1] = s0[base + SLOT_PHI1];
        s1[base + SLOT_PHI2] = s0[base + SLOT_PHI2];
      }
    } else if (mode & MODEINITPRED) {
      s0[base + SLOT_PHI1] = s1[base + SLOT_PHI1];
      s0[base + SLOT_PHI2] = s1[base + SLOT_PHI2];
    }

    // Companion coefficients — zero at DC; niIntegrate-derived otherwise.
    // T-W3-2: gate is !(MODEDC) per indload.c:88, not MODETRAN.
    // T-W3-3: two niIntegrate() calls per winding; SLOT_CCAP1/CCAP2 tracked.
    //         Mutual companion g12 = ag[0]*M per indload.c:74-75.
    let g11 = 0, g22 = 0, g12 = 0, hist1 = 0, hist2 = 0;
    if (!(mode & MODEDC)) {
      const phi1_0 = s0[base + SLOT_PHI1];
      const phi2_0 = s0[base + SLOT_PHI2];
      const phi1_1 = s1[base + SLOT_PHI1];
      const phi2_1 = s1[base + SLOT_PHI2];
      const phi1_2 = s2[base + SLOT_PHI1];
      const phi2_2 = s2[base + SLOT_PHI2];
      const phi1_3 = s3[base + SLOT_PHI1];
      const phi2_3 = s3[base + SLOT_PHI2];
      const ccap1Prev = s1[base + SLOT_CCAP1];
      const ccap2Prev = s1[base + SLOT_CCAP2];

      const ni1 = niIntegrate(
        ctx.method, ctx.order, L1, ag,
        phi1_0, phi1_1,
        [phi1_2, phi1_3, 0, 0, 0],
        ccap1Prev,
      );
      const ni2 = niIntegrate(
        ctx.method, ctx.order, L2, ag,
        phi2_0, phi2_1,
        [phi2_2, phi2_3, 0, 0, 0],
        ccap2Prev,
      );

      s0[base + SLOT_CCAP1] = ni1.ccap;
      s0[base + SLOT_CCAP2] = ni2.ccap;
      // T-W3-3: MODEINITTRAN seeds ccap history per indload.c:114-116 pattern
      // (state1 ← state0 for the integration history slot).
      if (mode & MODEINITTRAN) {
        s1[base + SLOT_CCAP1] = ni1.ccap;
        s1[base + SLOT_CCAP2] = ni2.ccap;
      }

      g11  = ni1.geq;                // ag[0] * L1
      g22  = ni2.geq;                // ag[0] * L2
      g12  = ag[0] * Mcoup;          // indload.c:74-75: MUTbr1br2 -= MUTfactor*ag[0]
      hist1 = ni1.ceq;
      hist2 = ni2.ceq;
    }

    // Unconditional 2×2 branch block stamp — matches indload.c:119-123 twice
    // (self-inductance diagonals) plus indload.c:74-75 (mutual off-diagonals).
    // Pattern is stable across modes; allocElement handle table is idempotent.
    solver.stampElement(solver.allocElement(b1, b1), -g11);
    solver.stampElement(solver.allocElement(b1, b2), -g12);
    solver.stampElement(solver.allocElement(b2, b1), -g12);
    solver.stampElement(solver.allocElement(b2, b2), -g22);
    solver.stampRHS(b1, hist1);
    solver.stampRHS(b2, hist2);

    // T-W3-6: SLOT_VOLT1/VOLT2 — terminal voltage state, MODEINITTRAN copy
    // per indload.c:114-116 (state1[INDvolt] = state0[INDvolt]).
    const v1Now = (p1 !== 0 ? voltages[p1 - 1] : 0) - (p2 !== 0 ? voltages[p2 - 1] : 0);
    const v2Now = (sec1 !== 0 ? voltages[sec1 - 1] : 0) - (sec2 !== 0 ? voltages[sec2 - 1] : 0);
    s0[base + SLOT_VOLT1] = v1Now;
    s0[base + SLOT_VOLT2] = v2Now;
    if (mode & MODEINITTRAN) {
      s1[base + SLOT_VOLT1] = v1Now;
      s1[base + SLOT_VOLT2] = v2Now;
    }

    // Diagnostic cache (mode-invariant bookkeeping).
    s0[base + SLOT_G11]   = g11;
    s0[base + SLOT_G22]   = g22;
    s0[base + SLOT_G12]   = g12;
    s0[base + SLOT_HIST1] = hist1;
    s0[base + SLOT_HIST2] = hist2;
    s0[base + SLOT_I1]    = i1Now;
    s0[base + SLOT_I2]    = i2Now;
  }

  getLteTimestep(
    dt: number,
    deltaOld: readonly number[],
    order: number,
    method: IntegrationMethod,
    lteParams: import("../../solver/analog/ckt-terr.js").LteParams,
  ): number {
    const base = this.stateBaseOffset;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];
    const s3 = this._pool.states[3];
    // Winding 1 flux — mirrors inductor.ts getLteTimestep pattern with ccap history.
    const phi1_0 = s0[base + SLOT_PHI1];
    const phi1_1 = s1[base + SLOT_PHI1];
    const phi1_2 = s2[base + SLOT_PHI1];
    const phi1_3 = s3[base + SLOT_PHI1];
    const ccap1_0 = s0[base + SLOT_CCAP1];
    const ccap1_1 = s1[base + SLOT_CCAP1];
    const dt1 = cktTerr(dt, deltaOld, order, method, phi1_0, phi1_1, phi1_2, phi1_3, ccap1_0, ccap1_1, lteParams);
    // Winding 2 flux.
    const phi2_0 = s0[base + SLOT_PHI2];
    const phi2_1 = s1[base + SLOT_PHI2];
    const phi2_2 = s2[base + SLOT_PHI2];
    const phi2_3 = s3[base + SLOT_PHI2];
    const ccap2_0 = s0[base + SLOT_CCAP2];
    const ccap2_1 = s1[base + SLOT_CCAP2];
    const dt2 = cktTerr(dt, deltaOld, order, method, phi2_0, phi2_1, phi2_2, phi2_3, ccap2_0, ccap2_1, lteParams);
    return Math.min(dt1, dt2);
  }

  getPinCurrents(voltages: Float64Array): number[] {
    const iPri = voltages[this.branchIndex];
    const iSec = voltages[this._branch2];
    // pinLayout order: P1, P2, S1, S2
    // Primary current enters at P1 (+) and exits at P2 (-)
    // Secondary current enters at S1 (+) and exits at S2 (-)
    return [iPri, -iPri, iSec, -iSec];
  }

  /** Second branch index (secondary winding current). */
  get branch2(): number {
    return this._branch2;
  }

  /** Mutual inductance for test access. */
  get mutualInductance(): number {
    return this._pair.m;
  }

  /** Primary inductance. */
  get primaryInductance(): number {
    return this._pair.l1;
  }

  /** Secondary inductance. */
  get secondaryInductance(): number {
    return this._pair.l2;
  }
}

// ---------------------------------------------------------------------------
// analogFactory
// ---------------------------------------------------------------------------

function buildTransformerElement(
  pinNodes: ReadonlyMap<string, number>,
  branchIdx: number,
  primaryInductance: number,
  turnsRatio: number,
  couplingCoefficient: number,
  primaryResistance: number,
  secondaryResistance: number,
  IC1: number = NaN,
  IC2: number = NaN,
  M: number = 1,
): AnalogElementCore {
  const p = { primaryInductance, turnsRatio, couplingCoefficient, primaryResistance, secondaryResistance, IC1, IC2, M };
  const el = new AnalogTransformerElement(
    [pinNodes.get("P1")!, pinNodes.get("P2")!, pinNodes.get("S1")!, pinNodes.get("S2")!],
    branchIdx,
    p.primaryInductance,
    p.turnsRatio,
    p.couplingCoefficient,
    p.primaryResistance,
    p.secondaryResistance,
    p.IC1,
    p.IC2,
    p.M,
  );
  (el as AnalogElementCore).setParam = function(key: string, value: number): void {
    if (key in p) {
      (p as Record<string, number>)[key] = value;
      el.updateDerivedParams(
        p.primaryInductance,
        p.turnsRatio,
        p.couplingCoefficient,
        p.primaryResistance,
        p.secondaryResistance,
        p.IC1,
        p.IC2,
        p.M,
      );
    }
  };
  return el;
}

function createTransformerElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  return buildTransformerElement(
    pinNodes,
    branchIdx,
    props.getModelParam<number>("primaryInductance"),
    props.getModelParam<number>("turnsRatio"),
    props.getModelParam<number>("couplingCoefficient"),
    props.getModelParam<number>("primaryResistance"),
    props.getModelParam<number>("secondaryResistance"),
    props.hasModelParam("IC1") ? props.getModelParam<number>("IC1") : NaN,
    props.hasModelParam("IC2") ? props.getModelParam<number>("IC2") : NaN,
    props.hasModelParam("M") ? props.getModelParam<number>("M") : 1,
  );
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const TRANSFORMER_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "primaryResistance",
    type: PropertyType.FLOAT,
    label: "Primary Resistance (Ω)",
    unit: "Ω",
    defaultValue: 1.0,
    min: 0,
    description: "Primary winding series resistance in ohms",
  },
  {
    key: "secondaryResistance",
    type: PropertyType.FLOAT,
    label: "Secondary Resistance (Ω)",
    unit: "Ω",
    defaultValue: 1.0,
    min: 0,
    description: "Secondary winding series resistance in ohms",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional component label",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const TRANSFORMER_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "turnsRatio", propertyKey: "turnsRatio", modelParam: true, convert: (v) => parseFloat(v) },
  {
    xmlName: "primaryInductance",
    propertyKey: "primaryInductance",
    modelParam: true,
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "couplingCoefficient",
    propertyKey: "couplingCoefficient",
    modelParam: true,
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "primaryResistance",
    propertyKey: "primaryResistance",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "secondaryResistance",
    propertyKey: "secondaryResistance",
    convert: (v) => parseFloat(v),
  },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// TransformerDefinition
// ---------------------------------------------------------------------------

function transformerCircuitFactory(props: PropertyBag): TransformerElement {
  return new TransformerElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const TransformerDefinition: ComponentDefinition = {
  name: "Transformer",
  typeId: -1,
  factory: transformerCircuitFactory,
  pinLayout: buildTransformerPinDeclarations(),
  propertyDefs: TRANSFORMER_PROPERTY_DEFS,
  attributeMap: TRANSFORMER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Two-winding transformer using coupled inductor companion model.\n" +
    "Specify turns ratio N, primary inductance, coupling coefficient k, and winding resistances.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createTransformerElement,
      paramDefs: TRANSFORMER_PARAM_DEFS,
      params: TRANSFORMER_DEFAULTS,
      branchCount: 2,
    },
  },
  defaultModel: "behavioral",
};
