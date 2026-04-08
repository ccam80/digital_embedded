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
import type { AnalogElementCore, ReactiveAnalogElementCore, IntegrationMethod } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { stampG, stampRHS } from "../../solver/analog/stamp-helpers.js";
import { integrateCapacitor } from "../../solver/analog/integration.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import { defineModelParams } from "../../core/model-params.js";
import type { StatePoolRef } from "../../core/analog-types.js";
import {
  defineStateSchema,
  applyInitialValues,
  type StateSchema,
} from "../../solver/analog/state-schema.js";

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

// Slot layout — 5 slots total. Previous values are read from s1/s2/s3
// at the same offsets (pointer-rotation history).
const CAPACITOR_SCHEMA: StateSchema = defineStateSchema("AnalogCapacitorElement", [
  { name: "GEQ",  doc: "Companion conductance",       init: { kind: "zero" } },
  { name: "IEQ",  doc: "Companion history current",   init: { kind: "zero" } },
  { name: "V",    doc: "Terminal voltage this step",  init: { kind: "zero" } },
  { name: "Q",    doc: "Charge Q=C*V this step",      init: { kind: "zero" } },
  { name: "CCAP", doc: "Companion current (NIintegrate)", init: { kind: "zero" } },
]);

const SLOT_GEQ  = 0;
const SLOT_IEQ  = 1;
const SLOT_V    = 2;
const SLOT_Q    = 3;
const SLOT_CCAP = 4;

export class AnalogCapacitorElement implements ReactiveAnalogElementCore {
  pinNodeIds!: readonly number[];
  readonly branchIndex = -1;
  readonly isNonlinear = false;
  readonly isReactive = true;
  readonly poolBacked = true as const;
  readonly stateSchema = CAPACITOR_SCHEMA;
  readonly stateSize = CAPACITOR_SCHEMA.size;
  stateBaseOffset = -1;

  private C: number;
  s0!: Float64Array;
  s1!: Float64Array;
  s2!: Float64Array;
  s3!: Float64Array;
  private base!: number;

  constructor(capacitance: number) {
    this.C = capacitance;
  }

  initState(pool: StatePoolRef): void {
    this.s0 = pool.states[0];
    this.s1 = pool.states[1];
    this.s2 = pool.states[2];
    this.s3 = pool.states[3];
    this.base = this.stateBaseOffset;
    applyInitialValues(CAPACITOR_SCHEMA, pool, this.base, {});
  }

  setParam(key: string, value: number): void {
    if (key === "capacitance") {
      this.C = value;
    }
  }

  stamp(_solver: SparseSolver): void {
    // No topology-constant entries for a capacitor.
    // All companion model entries are stamped in stampReactiveCompanion().
  }

  stampReactiveCompanion(solver: SparseSolver): void {
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

  stampCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array, order: number, deltaOld: readonly number[]): void {
    const n0 = this.pinNodeIds[0];
    const n1 = this.pinNodeIds[1];
    const v0 = n0 > 0 ? voltages[n0 - 1] : 0;
    const v1 = n1 > 0 ? voltages[n1 - 1] : 0;
    const vNow = v0 - v1;

    // q0 is the charge at the current (pre-solve) voltage, used as the new-step charge.
    // q1/q2 come from the post-solve charge written by updateChargeFlux in previous steps.
    const q0 = this.C * vNow;
    const q1 = this.s1[this.base + SLOT_Q];
    const q2 = this.s2[this.base + SLOT_Q];
    const ccapPrev = this.s1[this.base + SLOT_CCAP];
    const h1 = deltaOld.length > 1 ? deltaOld[1] : dt;
    const h2 = deltaOld.length > 2 ? deltaOld[2] : h1;
    const { geq, ceq, ccap } = integrateCapacitor(this.C, vNow, q0, q1, q2, dt, h1, h2, order, method, ccapPrev);
    this.s0[this.base + SLOT_GEQ]  = geq;
    this.s0[this.base + SLOT_IEQ]  = ceq;
    this.s0[this.base + SLOT_V]    = vNow;
    this.s0[this.base + SLOT_CCAP] = ccap;
    // SLOT_Q is written by updateChargeFlux after the Newton-Raphson solve converges.
  }

  updateChargeFlux(voltages: Float64Array, dt: number, method: IntegrationMethod, order: number, deltaOld: readonly number[]): void {
    const n0 = this.pinNodeIds[0];
    const n1 = this.pinNodeIds[1];
    const v0 = n0 > 0 ? voltages[n0 - 1] : 0;
    const v1 = n1 > 0 ? voltages[n1 - 1] : 0;
    const vNow = v0 - v1;
    this.s0[this.base + SLOT_Q] = this.C * vNow;

    // Recompute ccap from converged charge so the next step's trapezoidal
    // recursion starts from the correct companion current (fixes stale SLOT_CCAP).
    if (dt > 0) {
      const q0 = this.s0[this.base + SLOT_Q];
      const q1 = this.s1[this.base + SLOT_Q];
      const q2 = this.s2[this.base + SLOT_Q];
      const ccapPrev = this.s1[this.base + SLOT_CCAP];
      const h1 = deltaOld.length > 1 ? deltaOld[1] : dt;
      const h2 = deltaOld.length > 2 ? deltaOld[2] : h1;
      const { ccap } = integrateCapacitor(this.C, vNow, q0, q1, q2, dt, h1, h2, order, method, ccapPrev);
      this.s0[this.base + SLOT_CCAP] = ccap;
    }
  }

  getLteTimestep(
    dt: number,
    deltaOld: readonly number[],
    order: number,
    method: IntegrationMethod,
    lteParams: import("../../solver/analog/ckt-terr.js").LteParams,
  ): number {
    const q0 = this.s0[this.base + SLOT_Q];
    const q1 = this.s1[this.base + SLOT_Q];
    const q2 = this.s2[this.base + SLOT_Q];
    const q3 = this.s3[this.base + SLOT_Q];
    const ccap0 = this.s0[this.base + SLOT_CCAP];
    const ccap1 = this.s1[this.base + SLOT_CCAP];
    return cktTerr(dt, deltaOld, order, method, q0, q1, q2, q3, ccap0, ccap1, lteParams);
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
