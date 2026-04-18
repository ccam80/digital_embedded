/**
 * Quartz crystal analog component — Butterworth-Van Dyke (BVD) equivalent circuit.
 *
 * The BVD model represents the mechanical resonance of a quartz crystal as a
 * series RLC branch (motional arm) in parallel with a shunt electrode capacitance:
 *
 *   Series (motional) arm: R_s — L_s — C_s  (between terminal A and B)
 *   Shunt arm:             C_0               (directly across A and B)
 *
 * This produces two resonant frequencies:
 *   Series resonance:   f_s = 1 / (2π √(L_s · C_s))
 *   Parallel resonance: f_p ≈ f_s · √(1 + C_s / C_0)   (slightly above f_s)
 *
 * MNA topology (1-based node indices, 0 = ground):
 *   pinNodeIds[0] = n_A      external terminal A
 *   pinNodeIds[1] = n_B      external terminal B
 *   pinNodeIds[2] = n1       junction between R_s and L_s
 *   pinNodeIds[3] = n2       junction between L_s and C_s
 *   branchIndex               branch current row for L_s
 *
 * Elements stamped:
 *   R_s: conductance G_s = 1/R_s between n_A and n1
 *   L_s: companion model (geq, ieq, branch row) between n1 and n2
 *   C_s: companion model (geq_cs, ieq_cs) between n2 and n_B
 *   C_0: companion model (geq_c0, ieq_c0) between n_A and n_B
 *
 * Derived parameters from user-specified frequency, Q, C_s, C_0:
 *   L_s = 1 / (4π² · f² · C_s)
 *   R_s = 2π · f · L_s / Q
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import { formatSI } from "../../editor/si-format.js";
import type { AnalogElementCore, ReactiveAnalogElement, IntegrationMethod, LoadContext } from "../../solver/analog/element.js";
import { stampG } from "../../solver/analog/stamp-helpers.js";
import { defineModelParams } from "../../core/model-params.js";
import type { StatePoolRef } from "../../core/analog-types.js";
import {
  defineStateSchema,
  applyInitialValues,
  type StateSchema,
} from "../../solver/analog/state-schema.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";

// ---------------------------------------------------------------------------
// State-pool schema
// ---------------------------------------------------------------------------

// Slot layout — 15 slots total (3 reactive stores × 4 slots each + 3 CCAP slots).
// Previous values are read from s1/s2/s3 at the same offsets.
const CRYSTAL_SCHEMA: StateSchema = defineStateSchema("AnalogCrystalElement", [
  // L_s (inductor motional arm)
  { name: "GEQ_L",  doc: "L_s companion conductance",         init: { kind: "zero" } },
  { name: "IEQ_L",  doc: "L_s companion history current",     init: { kind: "zero" } },
  { name: "I_L",    doc: "L_s branch current this step",      init: { kind: "zero" } },
  { name: "PHI_L",  doc: "L_s flux phi=Ls*i this step",       init: { kind: "zero" } },
  // C_s (series motional capacitor)
  { name: "GEQ_CS", doc: "C_s companion conductance",         init: { kind: "zero" } },
  { name: "IEQ_CS", doc: "C_s companion history current",     init: { kind: "zero" } },
  { name: "V_CS",   doc: "C_s terminal voltage this step",    init: { kind: "zero" } },
  { name: "Q_CS",   doc: "C_s charge Cs*V this step",         init: { kind: "zero" } },
  // C_0 (shunt electrode capacitor)
  { name: "GEQ_C0", doc: "C_0 companion conductance",         init: { kind: "zero" } },
  { name: "IEQ_C0", doc: "C_0 companion history current",     init: { kind: "zero" } },
  { name: "V_C0",   doc: "C_0 terminal voltage this step",    init: { kind: "zero" } },
  { name: "Q_C0",   doc: "C_0 charge C0*V this step",         init: { kind: "zero" } },
  // CCAP slots (NIintegrate companion current, stored for LTE reuse)
  { name: "CCAP_L",  doc: "L_s companion current",  init: { kind: "zero" } },
  { name: "CCAP_CS", doc: "C_s companion current",  init: { kind: "zero" } },
  { name: "CCAP_C0", doc: "C_0 companion current",  init: { kind: "zero" } },
]);

// Slot indices — must match the layout above.
const SLOT_GEQ_L  = 0;
const SLOT_IEQ_L  = 1;
const SLOT_I_L    = 2;
const SLOT_PHI_L  = 3;
const SLOT_GEQ_CS = 4;
const SLOT_IEQ_CS = 5;
const SLOT_V_CS   = 6;
const SLOT_Q_CS   = 7;
const SLOT_GEQ_C0 = 8;
const SLOT_IEQ_C0 = 9;
const SLOT_V_C0   = 10;
const SLOT_Q_C0   = 11;
const SLOT_CCAP_L  = 12;
const SLOT_CCAP_CS = 13;
const SLOT_CCAP_C0 = 14;

// ---------------------------------------------------------------------------
// Derived parameter helpers
// ---------------------------------------------------------------------------

/**
 * Compute motional inductance from series resonant frequency and motional capacitance.
 * L_s = 1 / (4π² · f² · C_s)
 */
export function crystalMotionalInductance(freqHz: number, Cs: number): number {
  return 1 / (4 * Math.PI * Math.PI * freqHz * freqHz * Cs);
}

/**
 * Compute series resistance from frequency, motional inductance, and quality factor.
 * R_s = 2π · f · L_s / Q
 */
export function crystalSeriesResistance(freqHz: number, Ls: number, Q: number): number {
  return (2 * Math.PI * freqHz * Ls) / Q;
}

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: CRYSTAL_PARAM_DEFS, defaults: CRYSTAL_DEFAULTS } = defineModelParams({
  primary: {
    frequency:           { default: 32768,   unit: "Hz", description: "Series resonant frequency in hertz", min: 1 },
    qualityFactor:       { default: 50000,   description: "Quality factor controlling resonance bandwidth", min: 1 },
  },
  secondary: {
    motionalCapacitance: { default: 12.5e-15, unit: "F", description: "Series motional capacitance in farads", min: 1e-18 },
    shuntCapacitance:    { default: 3e-12,    unit: "F", description: "Parallel electrode capacitance in farads", min: 1e-18 },
  },
});

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildCrystalPinDeclarations(): PinDeclaration[] {
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
      label: "B",
      defaultBitWidth: 1,
      position: { x: 2, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// CrystalCircuitElement — AbstractCircuitElement (editor/visual layer)
// ---------------------------------------------------------------------------

export class CrystalCircuitElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("QuartzCrystal", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildCrystalPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 0.5,
      width: 2,
      height: 1,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const freq = this._properties.getModelParam<number>("frequency");
    const label = this._visibleLabel();

    ctx.save();
    ctx.setLineWidth(1);

    const vA = signals?.getPinVoltage("A");
    const vB = signals?.getPinVoltage("B");
    const hasVoltage = vA !== undefined && vB !== undefined;

    // Left lead + plate — colored by pin A voltage
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vA, 0, 0, 0.6, 0);
    ctx.drawLine(0.6, -0.4, 0.6, 0.4);

    // Right lead + plate — colored by pin B voltage
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vB, 1.4, 0, 2, 0);
    ctx.drawLine(1.4, -0.4, 1.4, 0.4);

    // Rectangular crystal body between the plates — gradient
    if (hasVoltage && ctx.setLinearGradient) {
      ctx.setLinearGradient(0.7, 0, 1.3, 0, [
        { offset: 0, color: signals!.voltageColor(vA) },
        { offset: 1, color: signals!.voltageColor(vB) },
      ]);
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(0.7, -0.3, 1.3, -0.3);
    ctx.drawLine(0.7, 0.3, 1.3, 0.3);
    ctx.drawLine(0.7, -0.3, 0.7, 0.3);
    ctx.drawLine(1.3, -0.3, 1.3, 0.3);

    // Value label below body
    const displayLabel = label.length > 0 ? label : (this._shouldShowValue() ? formatSI(freq, "Hz") : "");
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText(displayLabel, 1, 0.65, { horizontal: "center", vertical: "top" });

    ctx.restore();
  }

}


// ---------------------------------------------------------------------------
// AnalogCrystalElement — MNA implementation
// ---------------------------------------------------------------------------

export class AnalogCrystalElement implements ReactiveAnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly branchIndex: number;
  readonly isNonlinear = false;
  readonly isReactive = true;
  readonly poolBacked = true as const;
  readonly stateSchema = CRYSTAL_SCHEMA;
  readonly stateSize = CRYSTAL_SCHEMA.size;
  stateBaseOffset = -1;
  setParam(_key: string, _value: number): void {}

  // Series resistance
  private G_s: number;

  // Physical params for companion model recomputation
  private L_s: number;
  private C_s: number;
  private C_0: number;

  // Pool references — bound in initState()
  s0!: Float64Array;
  s1!: Float64Array;
  s2!: Float64Array;
  s3!: Float64Array;
  private base!: number;

  /**
   * @param pinNodeIds - [n_A, n_B, n1, n2] where n1 and n2 are internal nodes
   * @param branchIndex - Absolute MNA row index for L_s branch current
   * @param Rs          - Series (motional) resistance in ohms
   * @param Ls          - Motional inductance in henries
   * @param Cs          - Motional capacitance in farads
   * @param C0          - Shunt electrode capacitance in farads
   */
  constructor(
    pinNodeIds: number[],
    branchIndex: number,
    Rs: number,
    Ls: number,
    Cs: number,
    C0: number,
  ) {
    this.pinNodeIds = pinNodeIds;
    this.allNodeIds = pinNodeIds;
    this.branchIndex = branchIndex;
    this.G_s = 1 / Math.max(Rs, 1e-12);
    this.L_s = Ls;
    this.C_s = Cs;
    this.C_0 = C0;
  }

  initState(pool: StatePoolRef): void {
    this.s0 = pool.states[0];
    this.s1 = pool.states[1];
    this.s2 = pool.states[2];
    this.s3 = pool.states[3];
    this.base = this.stateBaseOffset;
    applyInitialValues(CRYSTAL_SCHEMA, pool, this.base, {});
  }

  updateDerivedParams(Rs: number, Ls: number, Cs: number, C0: number): void {
    this.G_s = 1 / Math.max(Rs, 1e-12);
    this.L_s = Ls;
    this.C_s = Cs;
    this.C_0 = C0;
  }

  /**
   * Unified load() — BVD crystal model.
   *
   * Stamps in one pass:
   *   - R_s series conductance (nA ↔ n1, topology-constant).
   *   - L_s branch incidence + NIintegrate companion (n1 ↔ n2).
   *   - C_s series capacitor companion (n2 ↔ nB) via inline NIintegrate.
   *   - C_0 shunt capacitor companion (nA ↔ nB) via inline NIintegrate.
   * All three reactive components use ctx.ag[] coefficients directly.
   */
  load(ctx: LoadContext): void {
    const { solver, voltages, initMode, isDcOp, isTransient, ag } = ctx;
    const nA = this.pinNodeIds[0];
    const nB = this.pinNodeIds[1];
    const n1 = this.pinNodeIds[2];
    const n2 = this.pinNodeIds[3];
    const b = this.branchIndex;
    const base = this.base;

    // R_s conductance (nA ↔ n1).
    stampG(solver, nA, nA, this.G_s);
    stampG(solver, nA, n1, -this.G_s);
    stampG(solver, n1, nA, -this.G_s);
    stampG(solver, n1, n1, this.G_s);

    // L_s branch incidence (B sub-matrix).
    if (n1 !== 0) solver.stampElement(solver.allocElement(n1 - 1, b), 1);
    if (n2 !== 0) solver.stampElement(solver.allocElement(n2 - 1, b), -1);
    // L_s KVL incidence (C sub-matrix).
    if (n1 !== 0) solver.stampElement(solver.allocElement(b, n1 - 1), 1);
    if (n2 !== 0) solver.stampElement(solver.allocElement(b, n2 - 1), -1);

    if (!isTransient && !isDcOp) return;

    const iNow = voltages[b];
    const vA = nA > 0 ? voltages[nA - 1] : 0;
    const vBv = nB > 0 ? voltages[nB - 1] : 0;
    const vN2 = n2 > 0 ? voltages[n2 - 1] : 0;
    const vCs = vN2 - vBv;
    const vC0 = vA - vBv;

    if (isTransient) {
      // L_s flux update.
      if (initMode === "initPred") {
        this.s0[base + SLOT_PHI_L] = this.s1[base + SLOT_PHI_L];
      } else {
        this.s0[base + SLOT_PHI_L] = this.L_s * iNow;
        if (initMode === "initTran") {
          this.s1[base + SLOT_PHI_L] = this.s0[base + SLOT_PHI_L];
        }
      }
      // C_s charge update.
      if (initMode === "initPred") {
        this.s0[base + SLOT_Q_CS] = this.s1[base + SLOT_Q_CS];
      } else {
        this.s0[base + SLOT_Q_CS] = this.C_s * vCs;
        if (initMode === "initTran") {
          this.s1[base + SLOT_Q_CS] = this.s0[base + SLOT_Q_CS];
        }
      }
      // C_0 charge update.
      if (initMode === "initPred") {
        this.s0[base + SLOT_Q_C0] = this.s1[base + SLOT_Q_C0];
      } else {
        this.s0[base + SLOT_Q_C0] = this.C_0 * vC0;
        if (initMode === "initTran") {
          this.s1[base + SLOT_Q_C0] = this.s0[base + SLOT_Q_C0];
        }
      }

      // NIintegrate for L_s flux.
      const phiL_0 = this.s0[base + SLOT_PHI_L];
      const phiL_1 = this.s1[base + SLOT_PHI_L];
      let ccapL: number;
      if (ctx.order >= 2 && ag.length > 2) {
        ccapL = ag[0] * phiL_0 + ag[1] * phiL_1 + ag[2] * this.s2[base + SLOT_PHI_L];
      } else {
        ccapL = ag[0] * phiL_0 + ag[1] * phiL_1;
      }
      this.s0[base + SLOT_CCAP_L] = ccapL;
      const geqL = ag[0] * this.L_s;
      const ceqL = ccapL - ag[0] * phiL_0;
      if (initMode === "initTran") {
        this.s1[base + SLOT_CCAP_L] = ccapL;
      }

      // NIintegrate for C_s charge.
      const qCs_0 = this.s0[base + SLOT_Q_CS];
      const qCs_1 = this.s1[base + SLOT_Q_CS];
      let ccapCs: number;
      if (ctx.order >= 2 && ag.length > 2) {
        ccapCs = ag[0] * qCs_0 + ag[1] * qCs_1 + ag[2] * this.s2[base + SLOT_Q_CS];
      } else {
        ccapCs = ag[0] * qCs_0 + ag[1] * qCs_1;
      }
      this.s0[base + SLOT_CCAP_CS] = ccapCs;
      const geqCs = ag[0] * this.C_s;
      const ceqCs = ccapCs - ag[0] * qCs_0;
      if (initMode === "initTran") {
        this.s1[base + SLOT_CCAP_CS] = ccapCs;
      }

      // NIintegrate for C_0 charge.
      const qC0_0 = this.s0[base + SLOT_Q_C0];
      const qC0_1 = this.s1[base + SLOT_Q_C0];
      let ccapC0: number;
      if (ctx.order >= 2 && ag.length > 2) {
        ccapC0 = ag[0] * qC0_0 + ag[1] * qC0_1 + ag[2] * this.s2[base + SLOT_Q_C0];
      } else {
        ccapC0 = ag[0] * qC0_0 + ag[1] * qC0_1;
      }
      this.s0[base + SLOT_CCAP_C0] = ccapC0;
      const geqC0 = ag[0] * this.C_0;
      const ceqC0 = ccapC0 - ag[0] * qC0_0;
      if (initMode === "initTran") {
        this.s1[base + SLOT_CCAP_C0] = ccapC0;
      }

      // L_s companion stamp on branch row.
      solver.stampElement(solver.allocElement(b, b), -geqL);
      solver.stampRHS(b, ceqL);

      // C_s companion stamp (n2 ↔ nB).
      stampG(solver, n2, n2, geqCs);
      stampG(solver, n2, nB, -geqCs);
      stampG(solver, nB, n2, -geqCs);
      stampG(solver, nB, nB, geqCs);
      if (n2 !== 0) solver.stampRHS(n2 - 1, -ceqCs);
      if (nB !== 0) solver.stampRHS(nB - 1, ceqCs);

      // C_0 companion stamp (nA ↔ nB).
      stampG(solver, nA, nA, geqC0);
      stampG(solver, nA, nB, -geqC0);
      stampG(solver, nB, nA, -geqC0);
      stampG(solver, nB, nB, geqC0);
      if (nA !== 0) solver.stampRHS(nA - 1, -ceqC0);
      if (nB !== 0) solver.stampRHS(nB - 1, ceqC0);

      // Cache.
      this.s0[base + SLOT_GEQ_L]  = geqL;
      this.s0[base + SLOT_IEQ_L]  = ceqL;
      this.s0[base + SLOT_I_L]    = iNow;
      this.s0[base + SLOT_GEQ_CS] = geqCs;
      this.s0[base + SLOT_IEQ_CS] = ceqCs;
      this.s0[base + SLOT_V_CS]   = vCs;
      this.s0[base + SLOT_GEQ_C0] = geqC0;
      this.s0[base + SLOT_IEQ_C0] = ceqC0;
      this.s0[base + SLOT_V_C0]   = vC0;
    } else {
      // DC-OP: just store, no reactive stamps.
      this.s0[base + SLOT_PHI_L] = this.L_s * iNow;
      this.s0[base + SLOT_Q_CS]  = this.C_s * vCs;
      this.s0[base + SLOT_Q_C0]  = this.C_0 * vC0;
      this.s0[base + SLOT_I_L]   = iNow;
      this.s0[base + SLOT_V_CS]  = vCs;
      this.s0[base + SLOT_V_C0]  = vC0;
      this.s0[base + SLOT_GEQ_L]  = 0;
      this.s0[base + SLOT_IEQ_L]  = 0;
      this.s0[base + SLOT_GEQ_CS] = 0;
      this.s0[base + SLOT_IEQ_CS] = 0;
      this.s0[base + SLOT_GEQ_C0] = 0;
      this.s0[base + SLOT_IEQ_C0] = 0;
    }
  }

  getPinCurrents(voltages: Float64Array): number[] {
    const nA = this.pinNodeIds[0];
    const nB = this.pinNodeIds[1];
    const n1 = this.pinNodeIds[2];

    // Current through the series R_s (from pin A into the motional arm):
    // I_Rs = G_s * (V_A - V_n1). By KCL at n1 this equals the L_s branch current.
    const vA = nA > 0 ? voltages[nA - 1] : 0;
    const vN1 = n1 > 0 ? voltages[n1 - 1] : 0;
    const iMotional = this.G_s * (vA - vN1);

    // C_0 shunt current flowing into pin A: I = geqC0 * (vA - vB) + ieqC0
    const vB = nB > 0 ? voltages[nB - 1] : 0;
    const geqC0 = this.s0[this.base + SLOT_GEQ_C0];
    const ieqC0 = this.s0[this.base + SLOT_IEQ_C0];
    const iShunt = geqC0 * (vA - vB) + ieqC0;

    // Total current into pin A = motional arm current + shunt current
    const I = iMotional + iShunt;
    return [I, -I];
  }

  getLteTimestep(
    dt: number,
    deltaOld: readonly number[],
    order: number,
    method: IntegrationMethod,
    lteParams: import("../../solver/analog/ckt-terr.js").LteParams,
  ): number {
    // L_s (flux-based): use stored ccap from s0 and s1
    const phi0 = this.s0[this.base + SLOT_PHI_L];
    const phi1 = this.s1[this.base + SLOT_PHI_L];
    const phi2 = this.s2[this.base + SLOT_PHI_L];
    const phi3 = this.s3[this.base + SLOT_PHI_L];
    const ccap0L = this.s0[this.base + SLOT_CCAP_L];
    const ccap1L = this.s1[this.base + SLOT_CCAP_L];
    const dtL = cktTerr(dt, deltaOld, order, method, phi0, phi1, phi2, phi3, ccap0L, ccap1L, lteParams);

    // C_s (charge-based): use stored ccap from s0 and s1
    const qCs0 = this.s0[this.base + SLOT_Q_CS];
    const qCs1 = this.s1[this.base + SLOT_Q_CS];
    const qCs2 = this.s2[this.base + SLOT_Q_CS];
    const qCs3 = this.s3[this.base + SLOT_Q_CS];
    const ccap0Cs = this.s0[this.base + SLOT_CCAP_CS];
    const ccap1Cs = this.s1[this.base + SLOT_CCAP_CS];
    const dtCs = cktTerr(dt, deltaOld, order, method, qCs0, qCs1, qCs2, qCs3, ccap0Cs, ccap1Cs, lteParams);

    // C_0 (charge-based): use stored ccap from s0 and s1
    const qC00 = this.s0[this.base + SLOT_Q_C0];
    const qC01 = this.s1[this.base + SLOT_Q_C0];
    const qC02 = this.s2[this.base + SLOT_Q_C0];
    const qC03 = this.s3[this.base + SLOT_Q_C0];
    const ccap0C0 = this.s0[this.base + SLOT_CCAP_C0];
    const ccap1C0 = this.s1[this.base + SLOT_CCAP_C0];
    const dtC0 = cktTerr(dt, deltaOld, order, method, qC00, qC01, qC02, qC03, ccap0C0, ccap1C0, lteParams);

    return Math.min(dtL, dtCs, dtC0);
  }
}

// ---------------------------------------------------------------------------
// analogFactory
// ---------------------------------------------------------------------------

function buildCrystalElementFromParams(
  pinNodes: ReadonlyMap<string, number>,
  internalNodeIds: readonly number[],
  branchIdx: number,
  p: { frequency: number; qualityFactor: number; motionalCapacitance: number; shuntCapacitance: number },
): AnalogElementCore {
  const Ls = crystalMotionalInductance(p.frequency, p.motionalCapacitance);
  const Rs = crystalSeriesResistance(p.frequency, Ls, p.qualityFactor);

  const el = new AnalogCrystalElement(
    [pinNodes.get("A")!, pinNodes.get("B")!, internalNodeIds[0], internalNodeIds[1]],
    branchIdx,
    Rs,
    Ls,
    p.motionalCapacitance,
    p.shuntCapacitance,
  );

  (el as AnalogElementCore).setParam = function(key: string, value: number): void {
    if (key in p) {
      (p as Record<string, number>)[key] = value;
      const newLs = crystalMotionalInductance(p.frequency, p.motionalCapacitance);
      const newRs = crystalSeriesResistance(p.frequency, newLs, p.qualityFactor);
      el.updateDerivedParams(newRs, newLs, p.motionalCapacitance, p.shuntCapacitance);
    }
  };
  return el;
}

export function createCrystalElement(
  pinNodes: ReadonlyMap<string, number>,
  internalNodeIds: readonly number[],
  branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const p = {
    frequency:           props.getModelParam<number>("frequency"),
    qualityFactor:       props.getModelParam<number>("qualityFactor"),
    motionalCapacitance: props.getModelParam<number>("motionalCapacitance"),
    shuntCapacitance:    props.getModelParam<number>("shuntCapacitance"),
  };
  return buildCrystalElementFromParams(pinNodes, internalNodeIds, branchIdx, p);
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const CRYSTAL_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "motionalCapacitance",
    type: PropertyType.FLOAT,
    label: "Motional Capacitance C_s (F)",
    unit: "F",
    defaultValue: 12.5e-15,
    min: 1e-18,
    description: "Series motional capacitance in farads",
  },
  {
    key: "shuntCapacitance",
    type: PropertyType.FLOAT,
    label: "Shunt Capacitance C_0 (F)",
    unit: "F",
    defaultValue: 3e-12,
    min: 1e-18,
    description: "Parallel electrode capacitance in farads",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown below the component",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const CRYSTAL_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "frequency",
    propertyKey: "frequency",
    modelParam: true,
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "qualityFactor",
    propertyKey: "qualityFactor",
    modelParam: true,
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "motionalCapacitance",
    propertyKey: "motionalCapacitance",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "shuntCapacitance",
    propertyKey: "shuntCapacitance",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// CrystalDefinition
// ---------------------------------------------------------------------------

function crystalCircuitFactory(props: PropertyBag): CrystalCircuitElement {
  return new CrystalCircuitElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const CrystalDefinition: ComponentDefinition = {
  name: "QuartzCrystal",
  typeId: -1,
  factory: crystalCircuitFactory,
  pinLayout: buildCrystalPinDeclarations(),
  propertyDefs: CRYSTAL_PROPERTY_DEFS,
  attributeMap: CRYSTAL_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Quartz crystal — Butterworth-Van Dyke equivalent circuit model.\n" +
    "Series RLC motional arm in parallel with shunt electrode capacitance.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createCrystalElement,
      paramDefs: CRYSTAL_PARAM_DEFS,
      params: CRYSTAL_DEFAULTS,
      branchCount: 1,
    },
  },
  defaultModel: "behavioral",
};
