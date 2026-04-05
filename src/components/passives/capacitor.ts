/**
 * Capacitor analog component.
 *
 * Reactive two-terminal element modelled using companion model (equivalent
 * conductance + history current source). Implements updateCompanion() to
 * recompute geq and ieq at each timestep using one of three integration methods:
 * BDF-1, trapezoidal, or BDF-2.
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
  type ComponentDefinition,
} from "../../core/registry.js";
import { formatSI } from "../../editor/si-format.js";
import type { AnalogElementCore, IntegrationMethod } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { stampG, stampRHS } from "../../solver/analog/stamp-helpers.js";
import {
  capacitorConductance,
  capacitorHistoryCurrent,
} from "../../solver/analog/integration.js";
import { defineModelParams } from "../../core/model-params.js";
import type { StatePoolRef } from "../../core/analog-types.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: CAPACITOR_PARAM_DEFS, defaults: CAPACITOR_DEFAULTS } = defineModelParams({
  primary: {
    capacitance: { default: 1e-6, unit: "F", description: "Capacitance in farads", min: 1e-15 },
  },
});

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildCapacitorPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "pos",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "neg",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// CapacitorElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class CapacitorElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Capacitor", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildCapacitorPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 0.75,
      width: 4,
      height: 1.5,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const capacitance = this._properties.getModelParam<number>("capacitance");
    const label = this._visibleLabel();

    ctx.save();
    ctx.setLineWidth(1);

    const vA = signals?.getPinVoltage("pos");
    const vB = signals?.getPinVoltage("neg");
    const hasVoltage = vA !== undefined && vB !== undefined;

    // Left lead + plate — colored by pin A voltage
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vA, 0, 0, 1.75, 0);
    ctx.drawLine(1.75, -0.75, 1.75, 0.75);

    // Right lead + plate — colored by pin B voltage
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vB, 2.25, 0, 4, 0);
    ctx.drawLine(2.25, -0.75, 2.25, 0.75);

    // Value label below body
    const displayLabel = label.length > 0 ? label : (this._shouldShowValue() ? formatSI(capacitance, "F") : "");
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText(displayLabel, 2, 1, { horizontal: "center", vertical: "top" });

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// AnalogCapacitorElement — MNA implementation
// ---------------------------------------------------------------------------


// Slot indices within the state pool.
//
// 6-slot layout:
//   0: GEQ          — Norton companion conductance
//   1: IEQ          — Norton companion history current
//   2: V_PREV       — terminal voltage at last accepted step (n-1), used by companion history
//   3: I_PREV       — capacitor current at step n-1, used by LTE
//   4: I_PREV_PREV  — capacitor current at step n-2, used by LTE
//   5: V_PREV_PREV  — terminal voltage at step n-2, used by LTE toleranceReference
const SLOT_GEQ = 0;
const SLOT_IEQ = 1;
const SLOT_V_PREV = 2;
const SLOT_I_PREV = 3;
const SLOT_I_PREV_PREV = 4;
const SLOT_V_PREV_PREV = 5;

class AnalogCapacitorElement implements AnalogElementCore {
  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
  readonly branchIndex: number = -1;
  readonly isNonlinear: boolean = false;
  readonly isReactive: boolean = true;
  readonly stateSize: number = 6;
  stateBaseOffset: number = -1;

  private C: number;
  private s0!: Float64Array;
  private base!: number;

  constructor(capacitance: number) {
    this.C = capacitance;
  }

  initState(pool: StatePoolRef): void {
    this.s0 = pool.state0;
    this.base = this.stateBaseOffset;
  }

  setParam(key: string, value: number): void {
    if (key === "capacitance") {
      this.C = value;
    }
  }

  stamp(solver: SparseSolver): void {
    const n0 = this.pinNodeIds[0];
    const n1 = this.pinNodeIds[1];
    const geq = this.s0[this.base + SLOT_GEQ];
    const ieq = this.s0[this.base + SLOT_IEQ];

    stampG(solver, n0, n0, geq);
    stampG(solver, n0, n1, -geq);
    stampG(solver, n1, n0, -geq);
    stampG(solver, n1, n1, geq);

    stampRHS(solver, n0, -ieq);
    stampRHS(solver, n1, ieq);
  }

  getPinCurrents(voltages: Float64Array): number[] {
    const n0 = this.pinNodeIds[0];
    const n1 = this.pinNodeIds[1];
    const v0 = n0 > 0 ? voltages[n0 - 1] : 0;
    const v1 = n1 > 0 ? voltages[n1 - 1] : 0;
    const geq = this.s0[this.base + SLOT_GEQ];
    const ieq = this.s0[this.base + SLOT_IEQ];
    const I = geq * (v0 - v1) + ieq;
    return [I, -I];
  }

  stampCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
    const n0 = this.pinNodeIds[0];
    const n1 = this.pinNodeIds[1];
    const v0 = n0 > 0 ? voltages[n0 - 1] : 0;
    const v1 = n1 > 0 ? voltages[n1 - 1] : 0;
    const vNow = v0 - v1;
    const geq = this.s0[this.base + SLOT_GEQ];
    const ieq = this.s0[this.base + SLOT_IEQ];
    const vPrev = this.s0[this.base + SLOT_V_PREV];
    // Full Norton current at the previous accepted step: i = geq * v + ieq.
    // On the first call geq=0 and ieq=0, so iNow=0 (DC steady state).
    const iNow = geq * vNow + ieq;

    this.s0[this.base + SLOT_GEQ] = capacitorConductance(this.C, dt, method);
    this.s0[this.base + SLOT_IEQ] = capacitorHistoryCurrent(this.C, dt, method, vNow, vPrev, iNow);
    // Shift LTE history: both voltage and current pairs are updated together
    // so getLteEstimate always sees a consistent pair of samples.
    // Voltage shift: V_PREV → V_PREV_PREV, vNow → V_PREV
    this.s0[this.base + SLOT_V_PREV_PREV] = vPrev;
    this.s0[this.base + SLOT_V_PREV] = vNow;
    // Current shift: I_PREV → I_PREV_PREV, iNow → I_PREV
    // iNow is the capacitor current at the boundary between the previous and
    // current step, computed above from the previous step's companion
    // coefficients. getLteEstimate compares these two to produce an error
    // estimate that scales linearly with dt.
    this.s0[this.base + SLOT_I_PREV_PREV] = this.s0[this.base + SLOT_I_PREV];
    this.s0[this.base + SLOT_I_PREV] = iNow;
  }

  getLteEstimate(dt: number): { truncationError: number; toleranceReference: number } {
    // LTE estimate for trapezoidal integration of a capacitor.
    //
    // For trap, local truncation error is O(dt³ · v‴). Using i = C · dv/dt,
    // v‴ = (1/C) · d²i/dt², so LTE_Q ~ (dt³/12) · d²i/dt². Approximating
    // d²i/dt² by the first-difference of stored currents at the previous
    // two step boundaries collapses to:
    //   LTE_Q ≈ (dt/12) · |Δi|,  Δi = i(n-1) - i(n-2)
    // which scales linearly with dt. The estimate is retrospective by one
    // step and returns zero for the first two calls (before two current
    // samples exist), which is safe because a capacitor at DC has no
    // history to truncate.
    //
    // `toleranceReference` is the "natural" stored quantity — the capacitor
    // charge Q = C · v_prev. The engine composes the rejection threshold
    // with ngspice's relative tolerance formula
    //   local_tol = trtol · (reltol · |Q| + chargeTol)
    // which keeps the per-step tolerance proportional to the charge the
    // capacitor is actually carrying, instead of the pathologically-tight
    // absolute `chargeTol = 1e-14 C` that makes sense only when `|Q|` is
    // near zero.
    if (dt <= 0) return { truncationError: 0, toleranceReference: 0 };
    const iPrev = this.s0[this.base + SLOT_I_PREV];
    const iPrevPrev = this.s0[this.base + SLOT_I_PREV_PREV];
    const vPrev = this.s0[this.base + SLOT_V_PREV];
    const vPrevPrev = this.s0[this.base + SLOT_V_PREV_PREV];
    const deltaI = Math.abs(iPrev - iPrevPrev);
    return {
      truncationError: (dt / 12) * deltaI,
      toleranceReference: this.C * Math.max(Math.abs(vPrev), Math.abs(vPrevPrev)),
    };
  }
}

function createCapacitorElement(
  _pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const C = props.getModelParam<number>("capacitance");
  return new AnalogCapacitorElement(C);
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const CAPACITOR_PROPERTY_DEFS: PropertyDefinition[] = [
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

export const CAPACITOR_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "capacitance",
    propertyKey: "capacitance",
    convert: (v) => parseFloat(v),
    modelParam: true,
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// CapacitorDefinition
// ---------------------------------------------------------------------------

function capacitorCircuitFactory(props: PropertyBag): CapacitorElement {
  return new CapacitorElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const CapacitorDefinition: ComponentDefinition = {
  name: "Capacitor",
  typeId: -1,
  factory: capacitorCircuitFactory,
  pinLayout: buildCapacitorPinDeclarations(),
  propertyDefs: CAPACITOR_PROPERTY_DEFS,
  attributeMap: CAPACITOR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Capacitor — reactive element with companion model.\n" +
    "Stamps equivalent conductance and history current source at each timestep.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createCapacitorElement,
      paramDefs: CAPACITOR_PARAM_DEFS,
      params: CAPACITOR_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
