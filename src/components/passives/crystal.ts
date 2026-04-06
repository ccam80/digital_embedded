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
import type { AnalogElement, AnalogElementCore, IntegrationMethod } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { stampG, stampRHS } from "../../solver/analog/stamp-helpers.js";
import {
  capacitorConductance,
  capacitorHistoryCurrent,
  inductorConductance,
  inductorHistoryCurrent,
} from "../../solver/analog/integration.js";
import { defineModelParams } from "../../core/model-params.js";
import type { StatePoolRef } from "../../core/analog-types.js";
import {
  defineStateSchema,
  applyInitialValues,
  CAP_COMPANION_SLOTS,
  L_COMPANION_SLOTS,
  suffixed,
  type StateSchema,
} from "../../solver/analog/state-schema.js";

// ---------------------------------------------------------------------------
// State-pool schema
// ---------------------------------------------------------------------------

const CRYSTAL_SCHEMA: StateSchema = defineStateSchema("AnalogCrystalElement", [
  ...suffixed(L_COMPANION_SLOTS, "_L"),
  ...suffixed(CAP_COMPANION_SLOTS, "_CS"),
  ...suffixed(CAP_COMPANION_SLOTS, "_C0"),
]);

// Slot indices — must match the layout above.
const SLOT_GEQ_L    = 0; // inductor companion conductance
const SLOT_IEQ_L    = 1; // inductor companion history current
const SLOT_I_PREV_L = 2; // inductor branch current at step n-1
const SLOT_GEQ_CS   = 3; // series-cap companion conductance
const SLOT_IEQ_CS   = 4; // series-cap companion history current
const SLOT_V_PREV_CS = 5; // series-cap terminal voltage at step n-1
const SLOT_GEQ_C0   = 6; // shunt-cap companion conductance
const SLOT_IEQ_C0   = 7; // shunt-cap companion history current
const SLOT_V_PREV_C0 = 8; // shunt-cap terminal voltage at step n-1

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

export class AnalogCrystalElement implements AnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly allNodeIds: readonly number[];
  readonly branchIndex: number;
  readonly isNonlinear = false;
  readonly isReactive = true;
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
  private s0!: Float64Array;
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
    this.s0 = pool.state0;
    this.base = this.stateBaseOffset;
    applyInitialValues(CRYSTAL_SCHEMA, pool, this.base, {});
  }

  updateDerivedParams(Rs: number, Ls: number, Cs: number, C0: number): void {
    this.G_s = 1 / Math.max(Rs, 1e-12);
    this.L_s = Ls;
    this.C_s = Cs;
    this.C_0 = C0;
  }

  stamp(solver: SparseSolver): void {
    const nA = this.pinNodeIds[0];
    const nB = this.pinNodeIds[1];
    const n1 = this.pinNodeIds[2];
    const n2 = this.pinNodeIds[3];
    const b = this.branchIndex;

    const geqL  = this.s0[this.base + SLOT_GEQ_L];
    const ieqL  = this.s0[this.base + SLOT_IEQ_L];
    const geqCs = this.s0[this.base + SLOT_GEQ_CS];
    const ieqCs = this.s0[this.base + SLOT_IEQ_CS];
    const geqC0 = this.s0[this.base + SLOT_GEQ_C0];
    const ieqC0 = this.s0[this.base + SLOT_IEQ_C0];

    // R_s: conductance between n_A and n1
    stampG(solver, nA, nA, this.G_s);
    stampG(solver, nA, n1, -this.G_s);
    stampG(solver, n1, nA, -this.G_s);
    stampG(solver, n1, n1, this.G_s);

    // L_s: B sub-matrix — branch current I_L flows into n1, out of n2 (KCL node rows)
    if (n1 !== 0) solver.stamp(n1 - 1, b, 1);
    if (n2 !== 0) solver.stamp(n2 - 1, b, -1);

    // L_s: C sub-matrix + companion conductance — branch equation row
    // V(n1) - V(n2) - geqL * I_branch = ieqL
    if (n1 !== 0) solver.stamp(b, n1 - 1, 1);
    if (n2 !== 0) solver.stamp(b, n2 - 1, -1);
    solver.stamp(b, b, -geqL);
    solver.stampRHS(b, ieqL);

    // C_s: companion model between n2 and n_B (with corrected RHS sign convention)
    stampG(solver, n2, n2, geqCs);
    stampG(solver, n2, nB, -geqCs);
    stampG(solver, nB, n2, -geqCs);
    stampG(solver, nB, nB, geqCs);
    stampRHS(solver, n2, -ieqCs);
    stampRHS(solver, nB, ieqCs);

    // C_0: shunt capacitance between n_A and n_B (with corrected RHS sign convention)
    stampG(solver, nA, nA, geqC0);
    stampG(solver, nA, nB, -geqC0);
    stampG(solver, nB, nA, -geqC0);
    stampG(solver, nB, nB, geqC0);
    stampRHS(solver, nA, -ieqC0);
    stampRHS(solver, nB, ieqC0);
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

  stampCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
    const nA = this.pinNodeIds[0];
    const nB = this.pinNodeIds[1];
    const n1 = this.pinNodeIds[2];
    const n2 = this.pinNodeIds[3];
    const b = this.branchIndex;

    // L_s companion model — uses branch current row
    const iNowL = voltages[b];
    const vN1 = n1 > 0 ? voltages[n1 - 1] : 0;
    const vN2 = n2 > 0 ? voltages[n2 - 1] : 0;
    const vNowL = vN1 - vN2;
    const iPrevL = this.s0[this.base + SLOT_I_PREV_L];
    this.s0[this.base + SLOT_GEQ_L]    = inductorConductance(this.L_s, dt, method);
    this.s0[this.base + SLOT_IEQ_L]    = inductorHistoryCurrent(this.L_s, dt, method, iNowL, iPrevL, vNowL);
    this.s0[this.base + SLOT_I_PREV_L] = iNowL;

    // C_s companion model — voltage across n2 and n_B
    const vCs_now = vN2 - (nB > 0 ? voltages[nB - 1] : 0);
    const geqCs   = this.s0[this.base + SLOT_GEQ_CS];
    const ieqCs   = this.s0[this.base + SLOT_IEQ_CS];
    const vPrevCs = this.s0[this.base + SLOT_V_PREV_CS];
    const iNowCs  = geqCs * vCs_now + ieqCs;
    this.s0[this.base + SLOT_GEQ_CS]   = capacitorConductance(this.C_s, dt, method);
    this.s0[this.base + SLOT_IEQ_CS]   = capacitorHistoryCurrent(this.C_s, dt, method, vCs_now, vPrevCs, iNowCs);
    this.s0[this.base + SLOT_V_PREV_CS] = vCs_now;

    // C_0 companion model — voltage across n_A and n_B
    const vA = nA > 0 ? voltages[nA - 1] : 0;
    const vB = nB > 0 ? voltages[nB - 1] : 0;
    const vC0_now = vA - vB;
    const geqC0   = this.s0[this.base + SLOT_GEQ_C0];
    const ieqC0   = this.s0[this.base + SLOT_IEQ_C0];
    const vPrevC0 = this.s0[this.base + SLOT_V_PREV_C0];
    const iNowC0  = geqC0 * vC0_now + ieqC0;
    this.s0[this.base + SLOT_GEQ_C0]   = capacitorConductance(this.C_0, dt, method);
    this.s0[this.base + SLOT_IEQ_C0]   = capacitorHistoryCurrent(this.C_0, dt, method, vC0_now, vPrevC0, iNowC0);
    this.s0[this.base + SLOT_V_PREV_C0] = vC0_now;
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
