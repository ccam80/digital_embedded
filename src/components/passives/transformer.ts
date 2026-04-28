/**
 * Two-winding transformer component.
 *
 * Wraps InductorSubElement (L1) + InductorSubElement (L2) + MutualInductorElement (K)
 * to present a 4-terminal device:
 *   P1 (primary+), P2 (primary−), S1 (secondary+), S2 (secondary−)
 *
 * Derived parameters:
 *   L_secondary = L_primary · N²
 *   M = k · √(L_primary · L_secondary) = k · L_primary · N
 *
 * Each winding includes a series winding resistance for ohmic loss modelling.
 *
 * ngspice anchors:
 *   indsetup.c:84-100  — IND branch allocation and TSTALLOC sequence
 *   mutsetup.c:30-70   — MUT branch resolution and TSTALLOC sequence
 *   indload.c          — IND load (companion model)
 *   mutload.c          — MUT load (off-diagonal coupling stamps)
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
import type { AnalogElementCore } from "../../core/analog-types.js";
import { NGSPICE_LOAD_ORDER } from "../../core/analog-types.js";
import type { ReactiveAnalogElement, IntegrationMethod, LoadContext } from "../../solver/analog/element.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
import { niIntegrate } from "../../solver/analog/ni-integrate.js";
import { MODEDC, MODEINITPRED, MODEINITTRAN, MODEUIC } from "../../solver/analog/ckt-mode.js";
import { CoupledInductorPair } from "../../solver/analog/coupled-inductor.js";
import { defineModelParams } from "../../core/model-params.js";
import type { StatePoolRef } from "../../core/analog-types.js";
import { defineStateSchema, applyInitialValues } from "../../solver/analog/state-schema.js";
import type { StateSchema } from "../../solver/analog/state-schema.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import { InductorSubElement, MutualInductorElement } from "./mutual-inductor.js";

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
// State pool schema  13 slots
// ---------------------------------------------------------------------------

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
// TransformerElement  CircuitElement (visual/editor representation)
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
    return {
      x: this.position.x,
      y: this.position.y,
      width: 4,
      height: 2,
    };
  }

  draw(ctx: RenderContext, _signals?: PinVoltageAccess): void {
    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    const r = 5.333333 / 16;
    const arcStart = (3 * Math.PI) / 2;
    const arcEnd   = (5 * Math.PI) / 2;

    ctx.drawLine(0, 0, 21 / 16, 0);
    ctx.drawLine(4, 0, 43 / 16, 0);
    ctx.drawLine(0, 2, 21 / 16, 2);
    ctx.drawLine(4, 2, 43 / 16, 2);

    const coilCy = [5.333333 / 16, 16 / 16, 26.666667 / 16];
    const segY = [0, 10.666667 / 16, 21.333333 / 16, 2];

    const priCx = 21 / 16;
    for (let i = 0; i < 3; i++) {
      ctx.drawArc(priCx, coilCy[i], r, arcStart, arcEnd);
      ctx.drawLine(priCx, segY[i], priCx, segY[i + 1]);
    }

    const secCx = 43 / 16;
    for (let i = 0; i < 3; i++) {
      ctx.drawArc(secCx, coilCy[i], r, arcStart, arcEnd);
      ctx.drawLine(secCx, segY[i], secCx, segY[i + 1]);
    }

    ctx.drawLine(30 / 16, 0, 30 / 16, 2);
    ctx.drawLine(34 / 16, 0, 34 / 16, 2);

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// AnalogTransformerElement  MNA implementation
// ---------------------------------------------------------------------------

/**
 * MNA element for the two-winding transformer.
 *
 * Composed of three sub-elements:
 *   _l1  (InductorSubElement) — primary winding, pins P1/P2
 *   _l2  (InductorSubElement) — secondary winding, pins S1/S2
 *   _mut (MutualInductorElement) — coupling K element
 *
 * Node layout (pinNodeIds array positions):
 *   [0] = P1 (primary+)   [1] = P2 (primary−)
 *   [2] = S1 (secondary+) [3] = S2 (secondary−)
 */
export class AnalogTransformerElement implements ReactiveAnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  branchIndex: number = -1;
  _stateBase: number = -1;
  _pinNodes: Map<string, number> = new Map();
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.MUT;
  readonly isNonlinear = false;
  readonly isReactive = true;
  readonly poolBacked = true as const;
  readonly stateSchema = TRANSFORMER_SCHEMA;
  readonly stateSize = TRANSFORMER_SCHEMA.size;
  stateBaseOffset = -1;

  private readonly _l1: InductorSubElement;
  private readonly _l2: InductorSubElement;
  private readonly _mut: MutualInductorElement;
  private _pair: CoupledInductorPair;
  private _rPri: number;
  private _rSec: number;
  private _IC1: number;
  private _IC2: number;
  private _M: number;
  private _pool!: StatePoolRef;

  // Cached handles for winding resistance stamps (allocated in setup, used in load)
  private _hRP1P1: number = -1;
  private _hRP2P2: number = -1;
  private _hRP1P2: number = -1;
  private _hRP2P1: number = -1;
  private _hRS1S1: number = -1;
  private _hRS2S2: number = -1;
  private _hRS1S2: number = -1;
  private _hRS2S1: number = -1;

  // Cached handles for B/C sub-matrix stamps (from load TSTALLOC in original code)
  private _hP1B1: number = -1;
  private _hP2B1: number = -1;
  private _hS1B2: number = -1;
  private _hS2B2: number = -1;
  private _hB1P1: number = -1;
  private _hB1P2: number = -1;
  private _hB2S1: number = -1;
  private _hB2S2: number = -1;

  constructor(
    pinNodeIds: number[],
    lPrimary: number,
    turnsRatio: number,
    k: number,
    rPri: number,
    rSec: number,
    label: string,
    IC1: number = NaN,
    IC2: number = NaN,
    multiplicity: number = 1,
  ) {
    this.pinNodeIds = pinNodeIds;
    this.allNodeIds = pinNodeIds;
    const lSecondary = lPrimary / (turnsRatio * turnsRatio);
    this._pair = new CoupledInductorPair(lPrimary, lSecondary, k);
    this._rPri = rPri;
    this._rSec = rSec;
    this._IC1 = IC1;
    this._IC2 = IC2;
    this._M = multiplicity;

    const [p1, p2, s1, s2] = pinNodeIds;
    this._l1 = new InductorSubElement(p1, p2, `${label}.L1`);
    this._l2 = new InductorSubElement(s1, s2, `${label}.L2`);
    this._mut = new MutualInductorElement(k, this._l1, this._l2);
  }

  setup(ctx: SetupContext): void {
    // Composite setup: call sub-elements in order L1, L2, MUT.
    // Ordering invariant: _l1.setup() and _l2.setup() MUST complete before
    // _mut.setup() is called, because _mut reads _l1.branchIndex and
    // _l2.branchIndex (set during IND setup) directly — no findDevice needed.
    this._l1.setup(ctx);
    this._l2.setup(ctx);
    this._mut.setup(ctx);

    // Cache branch indices for use in load()
    this.branchIndex = this._l1.branchIndex;

    // Allocate handles for winding resistance stamps
    const solver = ctx.solver;
    const [p1, p2, sec1, sec2] = this.pinNodeIds;
    const b1 = this._l1.branchIndex;
    const b2 = this._l2.branchIndex;

    if (this._rPri > 0) {
      if (p1 !== 0) this._hRP1P1 = solver.allocElement(p1, p1);
      if (p2 !== 0) this._hRP2P2 = solver.allocElement(p2, p2);
      if (p1 !== 0 && p2 !== 0) {
        this._hRP1P2 = solver.allocElement(p1, p2);
        this._hRP2P1 = solver.allocElement(p2, p1);
      }
    }
    if (this._rSec > 0) {
      if (sec1 !== 0) this._hRS1S1 = solver.allocElement(sec1, sec1);
      if (sec2 !== 0) this._hRS2S2 = solver.allocElement(sec2, sec2);
      if (sec1 !== 0 && sec2 !== 0) {
        this._hRS1S2 = solver.allocElement(sec1, sec2);
        this._hRS2S1 = solver.allocElement(sec2, sec1);
      }
    }

    // Allocate handles for B/C sub-matrix stamps (KCL/KVL incidence)
    if (p1 !== 0) this._hP1B1 = solver.allocElement(p1, b1);
    if (p2 !== 0) this._hP2B1 = solver.allocElement(p2, b1);
    if (sec1 !== 0) this._hS1B2 = solver.allocElement(sec1, b2);
    if (sec2 !== 0) this._hS2B2 = solver.allocElement(sec2, b2);
    if (p1 !== 0) this._hB1P1 = solver.allocElement(b1, p1);
    if (p2 !== 0) this._hB1P2 = solver.allocElement(b1, p2);
    if (sec1 !== 0) this._hB2S1 = solver.allocElement(b2, sec1);
    if (sec2 !== 0) this._hB2S2 = solver.allocElement(b2, sec2);
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
    applyInitialValues(TRANSFORMER_SCHEMA, pool, this.stateBaseOffset, {});
  }

  setParam(key: string, value: number): void {
    if (key.startsWith("L1.")) {
      const subKey = key.slice(3);
      if (subKey === "inductance") {
        const lPrimary = value;
        const lSecondary = lPrimary / (this._pair.k > 0 ? (this._pair.l1 / this._pair.l2) : 1);
        this._pair = new CoupledInductorPair(lPrimary, this._pair.l2, this._pair.k);
      }
    } else if (key.startsWith("L2.")) {
      const subKey = key.slice(3);
      if (subKey === "inductance") {
        this._pair = new CoupledInductorPair(this._pair.l1, value, this._pair.k);
      }
    } else if (key === "K" || key === "coupling") {
      this._pair = new CoupledInductorPair(this._pair.l1, this._pair.l2, value);
    } else if (key === "primaryInductance") {
      const lPrimary = value;
      const turnsRatio = Math.sqrt(this._pair.l1 / this._pair.l2);
      const lSecondary = lPrimary / (turnsRatio * turnsRatio);
      this._pair = new CoupledInductorPair(lPrimary, lSecondary, this._pair.k);
    } else if (key === "turnsRatio") {
      const lPrimary = this._pair.l1;
      const lSecondary = lPrimary / (value * value);
      this._pair = new CoupledInductorPair(lPrimary, lSecondary, this._pair.k);
    } else {
      throw new Error(`Unrecognized setParam key: ${key}`);
    }
    if (this._pool) {
      applyInitialValues(TRANSFORMER_SCHEMA, this._pool, this.stateBaseOffset, {});
    }
  }

  /**
   * Unified load()  two-winding coupled inductor transformer.
   *
   * Mirrors indload.c:INDload for each winding plus the inline MUTUAL block
   * (indload.c:52-77) for off-diagonal coupling stamps.
   *
   * All solver entries written through cached handles from setup() only.
   * No solver.allocElement() calls inside load().
   */
  load(ctx: LoadContext): void {
    const solver = ctx.solver;
    const [p1, p2, sec1, sec2] = this.pinNodeIds;
    const b1 = this._l1.branchIndex;
    const b2 = this._l2.branchIndex;
    const mode = ctx.cktMode;
    const ag = ctx.ag;

    const m = this._M;
    const L1 = this._pair.l1 / m;
    const L2 = this._pair.l2 / m;
    const Mcoup = this._pair.m / m;

    const voltages = ctx.rhsOld;
    const base = this.stateBaseOffset;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];
    const s3 = this._pool.states[3];

    // Winding resistances — stamped through cached handles
    if (this._rPri > 0) {
      const gPri = 1 / this._rPri;
      if (this._hRP1P1 !== -1) solver.stampElement(this._hRP1P1, gPri);
      if (this._hRP2P2 !== -1) solver.stampElement(this._hRP2P2, gPri);
      if (this._hRP1P2 !== -1) solver.stampElement(this._hRP1P2, -gPri);
      if (this._hRP2P1 !== -1) solver.stampElement(this._hRP2P1, -gPri);
    }
    if (this._rSec > 0) {
      const gSec = 1 / this._rSec;
      if (this._hRS1S1 !== -1) solver.stampElement(this._hRS1S1, gSec);
      if (this._hRS2S2 !== -1) solver.stampElement(this._hRS2S2, gSec);
      if (this._hRS1S2 !== -1) solver.stampElement(this._hRS1S2, -gSec);
      if (this._hRS2S1 !== -1) solver.stampElement(this._hRS2S1, -gSec);
    }

    // B sub-matrix: branch current incidence in KCL node rows — cached handles
    if (this._hP1B1 !== -1) solver.stampElement(this._hP1B1, 1);
    if (this._hP2B1 !== -1) solver.stampElement(this._hP2B1, -1);
    if (this._hS1B2 !== -1) solver.stampElement(this._hS1B2, 1);
    if (this._hS2B2 !== -1) solver.stampElement(this._hS2B2, -1);

    // C sub-matrix: KVL voltage incidence — cached handles
    if (this._hB1P1 !== -1) solver.stampElement(this._hB1P1, 1);
    if (this._hB1P2 !== -1) solver.stampElement(this._hB1P2, -1);
    if (this._hB2S1 !== -1) solver.stampElement(this._hB2S1, 1);
    if (this._hB2S2 !== -1) solver.stampElement(this._hB2S2, -1);

    // UIC branch current override for flux seeding — indload.c:44-46
    let i1Now = voltages[b1];
    let i2Now = voltages[b2];
    if ((mode & MODEUIC) && (mode & MODEINITTRAN)) {
      if (isFinite(this._IC1)) i1Now = this._IC1;
      if (isFinite(this._IC2)) i2Now = this._IC2;
    }

    // Flux-state update gated on !(MODEDC | MODEINITPRED), per indload.c:43
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

    // Companion coefficients — zero at DC; niIntegrate-derived otherwise
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
      if (mode & MODEINITTRAN) {
        s1[base + SLOT_CCAP1] = ni1.ccap;
        s1[base + SLOT_CCAP2] = ni2.ccap;
      }

      g11  = ni1.geq;
      g22  = ni2.geq;
      g12  = ag[0] * Mcoup;
      hist1 = ni1.ceq;
      hist2 = ni2.ceq;
    }

    // 2×2 branch block stamp — cached handles from sub-elements
    solver.stampElement(this._l1.hIbrIbr, -g11);
    solver.stampElement(this._mut.hBr1Br2, -g12);
    solver.stampElement(this._mut.hBr2Br1, -g12);
    solver.stampElement(this._l2.hIbrIbr, -g22);
    stampRHS(ctx.rhs, b1, hist1);
    stampRHS(ctx.rhs, b2, hist2);

    // SLOT_VOLT1/VOLT2 — terminal voltage state, MODEINITTRAN copy
    const v1Now = (voltages[p1]) - (voltages[p2]);
    const v2Now = (voltages[sec1]) - (voltages[sec2]);
    s0[base + SLOT_VOLT1] = v1Now;
    s0[base + SLOT_VOLT2] = v2Now;
    if (mode & MODEINITTRAN) {
      s1[base + SLOT_VOLT1] = v1Now;
      s1[base + SLOT_VOLT2] = v2Now;
    }

    // Diagnostic cache
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
    const phi1_0 = s0[base + SLOT_PHI1];
    const phi1_1 = s1[base + SLOT_PHI1];
    const phi1_2 = s2[base + SLOT_PHI1];
    const phi1_3 = s3[base + SLOT_PHI1];
    const ccap1_0 = s0[base + SLOT_CCAP1];
    const ccap1_1 = s1[base + SLOT_CCAP1];
    const dt1 = cktTerr(dt, deltaOld, order, method, phi1_0, phi1_1, phi1_2, phi1_3, ccap1_0, ccap1_1, lteParams);
    const phi2_0 = s0[base + SLOT_PHI2];
    const phi2_1 = s1[base + SLOT_PHI2];
    const phi2_2 = s2[base + SLOT_PHI2];
    const phi2_3 = s3[base + SLOT_PHI2];
    const ccap2_0 = s0[base + SLOT_CCAP2];
    const ccap2_1 = s1[base + SLOT_CCAP2];
    const dt2 = cktTerr(dt, deltaOld, order, method, phi2_0, phi2_1, phi2_2, phi2_3, ccap2_0, ccap2_1, lteParams);
    return Math.min(dt1, dt2);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const iPri = rhs[this._l1.branchIndex];
    const iSec = rhs[this._l2.branchIndex];
    return [iPri, -iPri, iSec, -iSec];
  }

  findBranchFor(name: string, ctx: SetupContext): number {
    const r1 = this._l1.findBranchFor(name, ctx);
    if (r1 !== 0) return r1;
    return this._l2.findBranchFor(name, ctx);
  }

  get branch2(): number {
    return this._l2.branchIndex;
  }

  get mutualInductance(): number {
    return this._pair.m;
  }

  get primaryInductance(): number {
    return this._pair.l1;
  }

  get secondaryInductance(): number {
    return this._pair.l2;
  }
}

// ---------------------------------------------------------------------------
// analogFactory
// ---------------------------------------------------------------------------

function createTransformerElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): AnalogElementCore {
  const primaryInductance    = props.getModelParam<number>("primaryInductance");
  const turnsRatio           = props.getModelParam<number>("turnsRatio");
  const couplingCoefficient  = props.getModelParam<number>("couplingCoefficient");
  const primaryResistance    = props.getModelParam<number>("primaryResistance");
  const secondaryResistance  = props.getModelParam<number>("secondaryResistance");
  const IC1 = props.hasModelParam("IC1") ? props.getModelParam<number>("IC1") : NaN;
  const IC2 = props.hasModelParam("IC2") ? props.getModelParam<number>("IC2") : NaN;
  const M   = props.hasModelParam("M")   ? props.getModelParam<number>("M")   : 1;

  const label = props.getOrDefault<string>("label", "T");
  const el = new AnalogTransformerElement(
    [pinNodes.get("P1")!, pinNodes.get("P2")!, pinNodes.get("S1")!, pinNodes.get("S2")!],
    primaryInductance,
    turnsRatio,
    couplingCoefficient,
    primaryResistance,
    secondaryResistance,
    label,
    IC1,
    IC2,
    M,
  );
  el._pinNodes = new Map(pinNodes);
  return el;
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
    },
  },
  defaultModel: "behavioral",
};
