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
import type { PinVoltageAccess } from "../../editor/pin-voltage-access.js";
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
import type { AnalogElement, AnalogElementCore, IntegrationMethod } from "../../analog/element.js";
import type { SparseSolver } from "../../analog/sparse-solver.js";
import {
  capacitorConductance,
  capacitorHistoryCurrent,
  inductorConductance,
  inductorHistoryCurrent,
} from "../../analog/integration.js";

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
    },
    {
      direction: PinDirection.OUTPUT,
      label: "B",
      defaultBitWidth: 1,
      position: { x: 2, y: 0 },
      isNegatable: false,
      isClockCapable: false,
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
    const freq = this._properties.getOrDefault<number>("frequency", 32768);
    const label = this._properties.getOrDefault<string>("label", "");

    ctx.save();
    ctx.setLineWidth(1);

    const vA = signals?.getPinVoltage("A");
    const vB = signals?.getPinVoltage("B");
    const hasVoltage = vA !== undefined && vB !== undefined;

    // Left lead + plate — colored by pin A voltage
    if (hasVoltage && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vA));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(0, 0, 0.6, 0);
    ctx.drawLine(0.6, -0.4, 0.6, 0.4);

    // Right lead + plate — colored by pin B voltage
    if (hasVoltage && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vB));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(1.4, 0, 2, 0);
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
    const displayLabel = label.length > 0 ? label : formatSI(freq, "Hz");
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText(displayLabel, 1, 0.65, { horizontal: "center", vertical: "top" });

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Quartz crystal — Butterworth-Van Dyke equivalent circuit model.\n" +
      "Series RLC motional arm in parallel with shunt electrode capacitance."
    );
  }
}

// ---------------------------------------------------------------------------
// Stamp helpers
// ---------------------------------------------------------------------------

function stampG(solver: SparseSolver, row: number, col: number, val: number): void {
  if (row !== 0 && col !== 0) {
    solver.stamp(row - 1, col - 1, val);
  }
}

function stampRHS(solver: SparseSolver, row: number, val: number): void {
  if (row !== 0) {
    solver.stampRHS(row - 1, val);
  }
}

// ---------------------------------------------------------------------------
// AnalogCrystalElement — MNA implementation
// ---------------------------------------------------------------------------

export class AnalogCrystalElement implements AnalogElement {
  readonly pinNodeIds: readonly number[];
  readonly branchIndex: number;
  readonly isNonlinear: boolean = false;
  readonly isReactive: boolean = true;

  // Series resistance
  private readonly G_s: number;

  // Motional inductance (L_s) companion model
  private readonly L_s: number;
  private geqL: number = 0;
  private ieqL: number = 0;
  private iPrevL: number = 0;
  private vPrevL: number = 0;

  // Motional capacitance (C_s) companion model
  private readonly C_s: number;
  private geqCs: number = 0;
  private ieqCs: number = 0;
  private vPrevCs: number = 0;

  // Shunt electrode capacitance (C_0) companion model
  private readonly C_0: number;
  private geqC0: number = 0;
  private ieqC0: number = 0;
  private vPrevC0: number = 0;

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
    this.branchIndex = branchIndex;
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
    solver.stamp(b, b, -this.geqL);
    solver.stampRHS(b, this.ieqL);

    // C_s: companion model between n2 and n_B (with corrected RHS sign convention)
    stampG(solver, n2, n2, this.geqCs);
    stampG(solver, n2, nB, -this.geqCs);
    stampG(solver, nB, n2, -this.geqCs);
    stampG(solver, nB, nB, this.geqCs);
    stampRHS(solver, n2, -this.ieqCs);
    stampRHS(solver, nB, this.ieqCs);

    // C_0: shunt capacitance between n_A and n_B (with corrected RHS sign convention)
    stampG(solver, nA, nA, this.geqC0);
    stampG(solver, nA, nB, -this.geqC0);
    stampG(solver, nB, nA, -this.geqC0);
    stampG(solver, nB, nB, this.geqC0);
    stampRHS(solver, nA, -this.ieqC0);
    stampRHS(solver, nB, this.ieqC0);
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
    const iShunt = this.geqC0 * (vA - vB) + this.ieqC0;

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
    this.geqL = inductorConductance(this.L_s, dt, method);
    this.ieqL = inductorHistoryCurrent(this.L_s, dt, method, iNowL, this.iPrevL, vNowL);
    this.iPrevL = iNowL;
    this.vPrevL = vNowL;

    // C_s companion model — voltage across n2 and n_B
    const vCs_now = vN2 - (nB > 0 ? voltages[nB - 1] : 0);
    const iNowCs = this.geqCs * vCs_now + this.ieqCs;
    this.geqCs = capacitorConductance(this.C_s, dt, method);
    this.ieqCs = capacitorHistoryCurrent(this.C_s, dt, method, vCs_now, this.vPrevCs, iNowCs);
    this.vPrevCs = vCs_now;

    // C_0 companion model — voltage across n_A and n_B
    const vA = nA > 0 ? voltages[nA - 1] : 0;
    const vB = nB > 0 ? voltages[nB - 1] : 0;
    const vC0_now = vA - vB;
    const iNowC0 = this.geqC0 * vC0_now + this.ieqC0;
    this.geqC0 = capacitorConductance(this.C_0, dt, method);
    this.ieqC0 = capacitorHistoryCurrent(this.C_0, dt, method, vC0_now, this.vPrevC0, iNowC0);
    this.vPrevC0 = vC0_now;
  }
}

// ---------------------------------------------------------------------------
// analogFactory
// ---------------------------------------------------------------------------

export function createCrystalElement(
  pinNodes: ReadonlyMap<string, number>,
  internalNodeIds: readonly number[],
  branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const freq = props.getOrDefault<number>("frequency", 32768);
  const Q = props.getOrDefault<number>("qualityFactor", 50000);
  const Cs = props.getOrDefault<number>("motionalCapacitance", 12.5e-15);
  const C0 = props.getOrDefault<number>("shuntCapacitance", 3e-12);

  const Ls = crystalMotionalInductance(freq, Cs);
  const Rs = crystalSeriesResistance(freq, Ls, Q);

  // nodeIds = [n_A, n_B, n1_internal, n2_internal]
  return new AnalogCrystalElement(
    [pinNodes.get("A")!, pinNodes.get("B")!, internalNodeIds[0], internalNodeIds[1]],
    branchIdx,
    Rs,
    Ls,
    Cs,
    C0,
  );
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const CRYSTAL_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "frequency",
    type: PropertyType.FLOAT,
    label: "Frequency (Hz)",
    unit: "Hz",
    defaultValue: 32768,
    min: 1,
    description: "Series resonant frequency in hertz",
  },
  {
    key: "qualityFactor",
    type: PropertyType.FLOAT,
    label: "Quality Factor (Q)",
    defaultValue: 50000,
    min: 1,
    description: "Quality factor controlling resonance bandwidth",
  },
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
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "qualityFactor",
    propertyKey: "qualityFactor",
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
  models: {
    analog: {
      factory: createCrystalElement,
      requiresBranchRow: true,
      getInternalNodeCount: () => 2,
    },
  },
};
