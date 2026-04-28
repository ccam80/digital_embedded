/**
 * Quartz crystal analog component  Butterworth-Van Dyke (BVD) equivalent circuit.
 *
 * The BVD model represents the mechanical resonance of a quartz crystal as a
 * series RLC branch (motional arm) in parallel with a shunt electrode capacitance:
 *
 *   Series (motional) arm: R_s  L_s  C_s  (between terminal A and B)
 *   Shunt arm:             C_0               (directly across A and B)
 *
 * This produces two resonant frequencies:
 *   Series resonance:   f_s = 1 / (2π √(L_s · C_s))
 *   Parallel resonance: f_p  f_s · √(1 + C_s / C_0)   (slightly above f_s)
 *
 * MNA topology (1-based node indices, 0 = ground):
 *   _pinNodes.get("A")  = n_A      external terminal A
 *   _pinNodes.get("B")  = n_B      external terminal B
 *   n1                             junction between R_s and L_s (internal)
 *   n2                             junction between L_s and C_s (internal)
 *   branchIndex                    branch current row for L_s
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
import type { PoolBackedAnalogElement } from "../../core/analog-types.js";
import { NGSPICE_LOAD_ORDER } from "../../core/analog-types.js";
import type { IntegrationMethod, LoadContext } from "../../solver/analog/element.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { MODETRAN, MODETRANOP, MODEINITPRED, MODEINITTRAN } from "../../solver/analog/ckt-mode.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
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

// Slot layout  15 slots total (3 reactive stores × 4 slots each + 3 CCAP slots).
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

// Slot indices  must match the layout above.
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
// CrystalCircuitElement  AbstractCircuitElement (editor/visual layer)
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

    // Left lead + plate  colored by pin A voltage
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vA, 0, 0, 0.6, 0);
    ctx.drawLine(0.6, -0.4, 0.6, 0.4);

    // Right lead + plate  colored by pin B voltage
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vB, 1.4, 0, 2, 0);
    ctx.drawLine(1.4, -0.4, 1.4, 0.4);

    // Rectangular crystal body between the plates  gradient
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
// AnalogCrystalElement  MNA implementation
// ---------------------------------------------------------------------------

export class AnalogCrystalElement implements PoolBackedAnalogElement {
  label: string = "";
  _pinNodes: Map<string, number> = new Map();
  _stateBase: number = -1;
  branchIndex: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.CAP;
  readonly poolBacked = true as const;
  readonly stateSchema = CRYSTAL_SCHEMA;
  readonly stateSize = CRYSTAL_SCHEMA.size;

  // Series resistance
  private G_s: number;

  // Physical params for companion model recomputation
  private L_s: number;
  private C_s: number;
  private C_0: number;

  // Pool reference  set by initState(); state arrays accessed via pool.states[N] at call time.
  private _pool!: StatePoolRef;

  // Internal nodes — populated in setup()
  private _n1Node: number = -1;
  private _n2Node: number = -1;

  // Rs handles
  private _hRs_PP: number = -1;  private _hRs_NN: number = -1;
  private _hRs_PN: number = -1;  private _hRs_NP: number = -1;
  // Ls handles
  private _hLs_PIbr:   number = -1;  private _hLs_NIbr:   number = -1;
  private _hLs_IbrN:   number = -1;  private _hLs_IbrP:   number = -1;
  private _hLs_IbrIbr: number = -1;
  // Cs handles
  private _hCs_PP: number = -1;  private _hCs_NN: number = -1;
  private _hCs_PN: number = -1;  private _hCs_NP: number = -1;
  // C0 handles
  private _hC0_PP: number = -1;  private _hC0_NN: number = -1;
  private _hC0_PN: number = -1;  private _hC0_NP: number = -1;

  // Internal-node label tracking for getInternalNodeLabels()
  private readonly _internalLabels: string[] = [];

  /**
   * @param pinNodes - ReadonlyMap with "A" and "B" external terminals
   * @param Rs          - Series (motional) resistance in ohms
   * @param Ls          - Motional inductance in henries
   * @param Cs          - Motional capacitance in farads
   * @param C0          - Shunt electrode capacitance in farads
   */
  constructor(
    pinNodes: ReadonlyMap<string, number>,
    Rs: number,
    Ls: number,
    Cs: number,
    C0: number,
  ) {
    this._pinNodes = new Map(pinNodes);
    this.G_s = 1 / Math.max(Rs, 1e-12);
    this.L_s = Ls;
    this.C_s = Cs;
    this.C_0 = C0;
  }

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const aNode = this._pinNodes.get("A")!;  // external terminal A
    const bNode = this._pinNodes.get("B")!;  // external terminal B

    // Allocate 15 state slots as a monolithic block (CRYSTAL_SCHEMA).
    this._stateBase = ctx.allocStates(15);

    // Allocate internal nodes — n1 (Rs↔Ls junction), n2 (Ls↔Cs junction).
    const n1Node = ctx.makeVolt(this.label, "n1");
    this._internalLabels.push("n1");
    const n2Node = ctx.makeVolt(this.label, "n2");
    this._internalLabels.push("n2");
    this._n1Node = n1Node;
    this._n2Node = n2Node;

    // Allocate Ls branch row — indsetup.c:84-88 idempotent guard.
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this.label, "Ls_branch");
    }
    const b = this.branchIndex;

    // Rs — ressetup.c:46-49 (aNode=pos, n1Node=neg)
    this._hRs_PP = solver.allocElement(aNode, aNode);
    this._hRs_NN = solver.allocElement(n1Node, n1Node);
    this._hRs_PN = solver.allocElement(aNode, n1Node);
    this._hRs_NP = solver.allocElement(n1Node, aNode);

    // Ls — indsetup.c:96-100 (n1Node=pos, n2Node=neg, b=branch)
    if (n1Node !== 0) this._hLs_PIbr = solver.allocElement(n1Node, b);
    if (n2Node !== 0) this._hLs_NIbr = solver.allocElement(n2Node, b);
    if (n2Node !== 0) this._hLs_IbrN = solver.allocElement(b, n2Node);
    if (n1Node !== 0) this._hLs_IbrP = solver.allocElement(b, n1Node);
    this._hLs_IbrIbr = solver.allocElement(b, b);

    // Cs — capsetup.c:114-117 (n2Node=pos, bNode=neg)
    if (n2Node !== 0) this._hCs_PP = solver.allocElement(n2Node, n2Node);
    if (bNode !== 0)  this._hCs_NN = solver.allocElement(bNode, bNode);
    if (n2Node !== 0 && bNode !== 0) this._hCs_PN = solver.allocElement(n2Node, bNode);
    if (bNode !== 0 && n2Node !== 0) this._hCs_NP = solver.allocElement(bNode, n2Node);

    // C0 — capsetup.c:114-117 (aNode=pos, bNode=neg)
    if (aNode !== 0) this._hC0_PP = solver.allocElement(aNode, aNode);
    if (bNode !== 0) this._hC0_NN = solver.allocElement(bNode, bNode);
    if (aNode !== 0 && bNode !== 0) this._hC0_PN = solver.allocElement(aNode, bNode);
    if (bNode !== 0 && aNode !== 0) this._hC0_NP = solver.allocElement(bNode, aNode);
  }

  findBranchFor(_name: string, ctx: SetupContext): number {
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this.label, "Ls_branch");
    }
    return this.branchIndex;
  }

  getInternalNodeLabels(): readonly string[] {
    return this._internalLabels;
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
    applyInitialValues(CRYSTAL_SCHEMA, pool, this._stateBase, {});
  }

  updateDerivedParams(Rs: number, Ls: number, Cs: number, C0: number): void {
    this.G_s = 1 / Math.max(Rs, 1e-12);
    this.L_s = Ls;
    this.C_s = Cs;
    this.C_0 = C0;
  }

  /**
   * Unified load()  BVD crystal model.
   *
   * Stamps in one pass:
   *   - R_s series conductance (nA ↔ n1, topology-constant).
   *   - L_s branch incidence + NIintegrate companion (n1 ↔ n2).
   *   - C_s series capacitor companion (n2 ↔ nB) via inline NIintegrate.
   *   - C_0 shunt capacitor companion (nA ↔ nB) via inline NIintegrate.
   * All three reactive components use ctx.ag[] coefficients directly.
   */
  load(ctx: LoadContext): void {
    const { solver, rhsOld: voltages, ag } = ctx;
    const mode = ctx.cktMode;
    const nA = this._pinNodes.get("A")!;
    const nB = this._pinNodes.get("B")!;
    const n1 = this._n1Node;
    const n2 = this._n2Node;
    const b = this.branchIndex;
    const base = this._stateBase;

    // R_s conductance (nA ↔ n1) — via cached handles.
    solver.stampElement(this._hRs_PP, this.G_s);
    solver.stampElement(this._hRs_PN, -this.G_s);
    solver.stampElement(this._hRs_NP, -this.G_s);
    solver.stampElement(this._hRs_NN, this.G_s);

    // L_s branch incidence (B sub-matrix) — via cached handles.
    if (n1 !== 0) solver.stampElement(this._hLs_PIbr, 1);
    if (n2 !== 0) solver.stampElement(this._hLs_NIbr, -1);
    // L_s KVL incidence (C sub-matrix) — via cached handles.
    if (n2 !== 0) solver.stampElement(this._hLs_IbrN, -1);
    if (n1 !== 0) solver.stampElement(this._hLs_IbrP, 1);

    if (!(mode & (MODETRAN | MODETRANOP))) return;

    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];

    const iNow = voltages[b];
    const vA = voltages[nA];
    const vBv = voltages[nB];
    const vN2 = voltages[n2];
    const vCs = vN2 - vBv;
    const vC0 = vA - vBv;

    if (mode & MODETRAN) {
      // L_s flux update.
      if (mode & MODEINITPRED) {
        s0[base + SLOT_PHI_L] = s1[base + SLOT_PHI_L];
      } else {
        s0[base + SLOT_PHI_L] = this.L_s * iNow;
        if (mode & MODEINITTRAN) {
          s1[base + SLOT_PHI_L] = s0[base + SLOT_PHI_L];
        }
      }
      // C_s charge update.
      if (mode & MODEINITPRED) {
        s0[base + SLOT_Q_CS] = s1[base + SLOT_Q_CS];
      } else {
        s0[base + SLOT_Q_CS] = this.C_s * vCs;
        if (mode & MODEINITTRAN) {
          s1[base + SLOT_Q_CS] = s0[base + SLOT_Q_CS];
        }
      }
      // C_0 charge update.
      if (mode & MODEINITPRED) {
        s0[base + SLOT_Q_C0] = s1[base + SLOT_Q_C0];
      } else {
        s0[base + SLOT_Q_C0] = this.C_0 * vC0;
        if (mode & MODEINITTRAN) {
          s1[base + SLOT_Q_C0] = s0[base + SLOT_Q_C0];
        }
      }

      // NIintegrate for L_s flux.
      const phiL_0 = s0[base + SLOT_PHI_L];
      const phiL_1 = s1[base + SLOT_PHI_L];
      let ccapL: number;
      if (ctx.order >= 2 && ag.length > 2) {
        ccapL = ag[0] * phiL_0 + ag[1] * phiL_1 + ag[2] * s2[base + SLOT_PHI_L];
      } else {
        ccapL = ag[0] * phiL_0 + ag[1] * phiL_1;
      }
      s0[base + SLOT_CCAP_L] = ccapL;
      const geqL = ag[0] * this.L_s;
      const ceqL = ccapL - ag[0] * phiL_0;
      if (mode & MODEINITTRAN) {
        s1[base + SLOT_CCAP_L] = ccapL;
      }

      // NIintegrate for C_s charge.
      const qCs_0 = s0[base + SLOT_Q_CS];
      const qCs_1 = s1[base + SLOT_Q_CS];
      let ccapCs: number;
      if (ctx.order >= 2 && ag.length > 2) {
        ccapCs = ag[0] * qCs_0 + ag[1] * qCs_1 + ag[2] * s2[base + SLOT_Q_CS];
      } else {
        ccapCs = ag[0] * qCs_0 + ag[1] * qCs_1;
      }
      s0[base + SLOT_CCAP_CS] = ccapCs;
      const geqCs = ag[0] * this.C_s;
      const ceqCs = ccapCs - ag[0] * qCs_0;
      if (mode & MODEINITTRAN) {
        s1[base + SLOT_CCAP_CS] = ccapCs;
      }

      // NIintegrate for C_0 charge.
      const qC0_0 = s0[base + SLOT_Q_C0];
      const qC0_1 = s1[base + SLOT_Q_C0];
      let ccapC0: number;
      if (ctx.order >= 2 && ag.length > 2) {
        ccapC0 = ag[0] * qC0_0 + ag[1] * qC0_1 + ag[2] * s2[base + SLOT_Q_C0];
      } else {
        ccapC0 = ag[0] * qC0_0 + ag[1] * qC0_1;
      }
      s0[base + SLOT_CCAP_C0] = ccapC0;
      const geqC0 = ag[0] * this.C_0;
      const ceqC0 = ccapC0 - ag[0] * qC0_0;
      if (mode & MODEINITTRAN) {
        s1[base + SLOT_CCAP_C0] = ccapC0;
      }

      // L_s companion stamp on branch row — via cached handle.
      solver.stampElement(this._hLs_IbrIbr, -geqL);
      stampRHS(ctx.rhs, b, ceqL);

      // C_s companion stamp (n2 ↔ nB) — via cached handles.
      if (n2 !== 0) solver.stampElement(this._hCs_PP, geqCs);
      if (nB !== 0) solver.stampElement(this._hCs_NN, geqCs);
      if (n2 !== 0 && nB !== 0) solver.stampElement(this._hCs_PN, -geqCs);
      if (nB !== 0 && n2 !== 0) solver.stampElement(this._hCs_NP, -geqCs);
      if (n2 !== 0) stampRHS(ctx.rhs, n2, -ceqCs);
      if (nB !== 0) stampRHS(ctx.rhs, nB, ceqCs);

      // C_0 companion stamp (nA ↔ nB) — via cached handles.
      if (nA !== 0) solver.stampElement(this._hC0_PP, geqC0);
      if (nB !== 0) solver.stampElement(this._hC0_NN, geqC0);
      if (nA !== 0 && nB !== 0) solver.stampElement(this._hC0_PN, -geqC0);
      if (nB !== 0 && nA !== 0) solver.stampElement(this._hC0_NP, -geqC0);
      if (nA !== 0) stampRHS(ctx.rhs, nA, -ceqC0);
      if (nB !== 0) stampRHS(ctx.rhs, nB, ceqC0);

      // Cache.
      s0[base + SLOT_GEQ_L]  = geqL;
      s0[base + SLOT_IEQ_L]  = ceqL;
      s0[base + SLOT_I_L]    = iNow;
      s0[base + SLOT_GEQ_CS] = geqCs;
      s0[base + SLOT_IEQ_CS] = ceqCs;
      s0[base + SLOT_V_CS]   = vCs;
      s0[base + SLOT_GEQ_C0] = geqC0;
      s0[base + SLOT_IEQ_C0] = ceqC0;
      s0[base + SLOT_V_C0]   = vC0;
    } else {
      // DC-OP: just store, no reactive stamps.
      s0[base + SLOT_PHI_L] = this.L_s * iNow;
      s0[base + SLOT_Q_CS]  = this.C_s * vCs;
      s0[base + SLOT_Q_C0]  = this.C_0 * vC0;
      s0[base + SLOT_I_L]   = iNow;
      s0[base + SLOT_V_CS]  = vCs;
      s0[base + SLOT_V_C0]  = vC0;
      s0[base + SLOT_GEQ_L]  = 0;
      s0[base + SLOT_IEQ_L]  = 0;
      s0[base + SLOT_GEQ_CS] = 0;
      s0[base + SLOT_IEQ_CS] = 0;
      s0[base + SLOT_GEQ_C0] = 0;
      s0[base + SLOT_IEQ_C0] = 0;
    }
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const nA = this._pinNodes.get("A")!;
    const nB = this._pinNodes.get("B")!;
    const n1 = this._n1Node;

    // Current through the series R_s (from pin A into the motional arm):
    // I_Rs = G_s * (V_A - V_n1). By KCL at n1 this equals the L_s branch current.
    const vA = rhs[nA];
    const vN1 = rhs[n1];
    const iMotional = this.G_s * (vA - vN1);

    // C_0 shunt current flowing into pin A: I = geqC0 * (vA - vB) + ieqC0
    const vB = rhs[nB];
    const s0 = this._pool.states[0];
    const base = this._stateBase;
    const geqC0 = s0[base + SLOT_GEQ_C0];
    const ieqC0 = s0[base + SLOT_IEQ_C0];
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
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];
    const s3 = this._pool.states[3];
    const base = this._stateBase;

    // L_s (flux-based): use stored ccap from s0 and s1
    const phi0 = s0[base + SLOT_PHI_L];
    const phi1 = s1[base + SLOT_PHI_L];
    const phi2 = s2[base + SLOT_PHI_L];
    const phi3 = s3[base + SLOT_PHI_L];
    const ccap0L = s0[base + SLOT_CCAP_L];
    const ccap1L = s1[base + SLOT_CCAP_L];
    const dtL = cktTerr(dt, deltaOld, order, method, phi0, phi1, phi2, phi3, ccap0L, ccap1L, lteParams);

    // C_s (charge-based): use stored ccap from s0 and s1
    const qCs0 = s0[base + SLOT_Q_CS];
    const qCs1 = s1[base + SLOT_Q_CS];
    const qCs2 = s2[base + SLOT_Q_CS];
    const qCs3 = s3[base + SLOT_Q_CS];
    const ccap0Cs = s0[base + SLOT_CCAP_CS];
    const ccap1Cs = s1[base + SLOT_CCAP_CS];
    const dtCs = cktTerr(dt, deltaOld, order, method, qCs0, qCs1, qCs2, qCs3, ccap0Cs, ccap1Cs, lteParams);

    // C_0 (charge-based): use stored ccap from s0 and s1
    const qC00 = s0[base + SLOT_Q_C0];
    const qC01 = s1[base + SLOT_Q_C0];
    const qC02 = s2[base + SLOT_Q_C0];
    const qC03 = s3[base + SLOT_Q_C0];
    const ccap0C0 = s0[base + SLOT_CCAP_C0];
    const ccap1C0 = s1[base + SLOT_CCAP_C0];
    const dtC0 = cktTerr(dt, deltaOld, order, method, qC00, qC01, qC02, qC03, ccap0C0, ccap1C0, lteParams);

    return Math.min(dtL, dtCs, dtC0);
  }

  setParam(_key: string, _value: number): void {}
}

// ---------------------------------------------------------------------------
// analogFactory
// ---------------------------------------------------------------------------

function buildCrystalElementFromParams(
  pinNodes: ReadonlyMap<string, number>,
  p: { frequency: number; qualityFactor: number; motionalCapacitance: number; shuntCapacitance: number },
): AnalogCrystalElement {
  const Ls = crystalMotionalInductance(p.frequency, p.motionalCapacitance);
  const Rs = crystalSeriesResistance(p.frequency, Ls, p.qualityFactor);

  const el = new AnalogCrystalElement(
    pinNodes,
    Rs,
    Ls,
    p.motionalCapacitance,
    p.shuntCapacitance,
  );

  el.setParam = function(key: string, value: number): void {
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
  props: PropertyBag,
  _getTime: () => number,
): AnalogCrystalElement {
  const p = {
    frequency:           props.getModelParam<number>("frequency"),
    qualityFactor:       props.getModelParam<number>("qualityFactor"),
    motionalCapacitance: props.getModelParam<number>("motionalCapacitance"),
    shuntCapacitance:    props.getModelParam<number>("shuntCapacitance"),
  };
  return buildCrystalElementFromParams(pinNodes, p);
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
    "Quartz crystal  Butterworth-Van Dyke equivalent circuit model.\n" +
    "Series RLC motional arm in parallel with shunt electrode capacitance.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createCrystalElement,
      paramDefs: CRYSTAL_PARAM_DEFS,
      params: CRYSTAL_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
