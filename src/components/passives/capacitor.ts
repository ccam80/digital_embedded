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
import type { AnalogElementCore, ReactiveAnalogElementCore, IntegrationMethod, LoadContext } from "../../solver/analog/element.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import { niIntegrate } from "../../solver/analog/ni-integrate.js";
import {
  MODETRAN, MODEAC, MODETRANOP, MODEDC,
  MODEINITJCT, MODEINITTRAN, MODEINITPRED, MODEUIC,
} from "../../solver/analog/ckt-mode.js";
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
  secondary: {
    IC:   { default: 0.0,    unit: "V",    description: "Initial condition voltage for UIC" },
    TC1:  { default: 0,                    description: "Linear temperature coefficient" },
    TC2:  { default: 0,                    description: "Quadratic temperature coefficient" },
    TNOM: { default: 300.15, unit: "K",    description: "Nominal temperature for TC coefficients" },
    SCALE: { default: 1,                   description: "Instance scale factor" },
    M:    { default: 1,                    description: "Parallel multiplicity" },
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

  private _nominalC: number;
  private C: number;
  private _IC: number;
  private _TC1: number;
  private _TC2: number;
  private _TNOM: number;
  private _SCALE: number;
  private _M: number;
  private _pool!: StatePoolRef;
  s0!: Float64Array;
  s1!: Float64Array;
  s2!: Float64Array;
  s3!: Float64Array;
  s4!: Float64Array;
  s5!: Float64Array;
  s6!: Float64Array;
  s7!: Float64Array;
  private base!: number;

  // Cached matrix-entry handles (allocated lazily on first load()).
  private _hAA: number = -1;
  private _hBB: number = -1;
  private _hAB: number = -1;
  private _hBA: number = -1;
  private _handlesInit: boolean = false;

  constructor(capacitance: number, IC: number, TC1: number, TC2: number, TNOM: number, SCALE: number, M: number) {
    this._nominalC = capacitance;
    this._IC = IC;
    this._TC1 = TC1;
    this._TC2 = TC2;
    this._TNOM = TNOM;
    this._SCALE = SCALE;
    this._M = M;
    this.C = this._computeEffectiveC();
  }

  private _computeEffectiveC(): number {
    const T = this._pool?.temperature ?? 300.15;
    const dT = T - this._TNOM;
    const factor = 1 + this._TC1 * dT + this._TC2 * dT * dT;
    return this._nominalC * factor * this._SCALE * this._M;
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
    this.s0 = pool.states[0];
    this.s1 = pool.states[1];
    this.s2 = pool.states[2];
    this.s3 = pool.states[3];
    this.s4 = pool.states[4];
    this.s5 = pool.states[5];
    this.s6 = pool.states[6];
    this.s7 = pool.states[7];
    this.base = this.stateBaseOffset;
    applyInitialValues(CAPACITOR_SCHEMA, pool, this.base, {});
  }

  setParam(key: string, value: number): void {
    if (key === "capacitance") {
      this._nominalC = value;
      this.C = this._computeEffectiveC();
    } else if (key === "IC") {
      this._IC = value;
    } else if (key === "TC1") {
      this._TC1 = value;
      this.C = this._computeEffectiveC();
    } else if (key === "TC2") {
      this._TC2 = value;
      this.C = this._computeEffectiveC();
    } else if (key === "TNOM") {
      this._TNOM = value;
      this.C = this._computeEffectiveC();
    } else if (key === "SCALE") {
      this._SCALE = value;
      this.C = this._computeEffectiveC();
    } else if (key === "M") {
      this._M = value;
      this.C = this._computeEffectiveC();
    }
  }

  /**
   * Unified load() — ngspice capload.c CAPload.
   *
   * Reads terminal voltage, computes charge Q = C*V, NIintegrates inline using
   * ctx.ag[], and stamps the companion model (geq conductance + ceq current
   * source). Matches the Appendix D2 reference pattern.
   */
  load(ctx: LoadContext): void {
    const { solver, voltages, ag, cktMode: mode } = ctx;
    const n0 = this.pinNodeIds[0];
    const n1 = this.pinNodeIds[1];
    const C = this.C;

    // ngspice capload.c:30 — participate only in MODETRAN | MODEAC | MODETRANOP.
    if (!(mode & (MODETRAN | MODEAC | MODETRANOP))) return;

    // capload.c:32-36 — IC gate.
    const cond1 =
      ((mode & MODEDC) && (mode & MODEINITJCT)) ||
      ((mode & MODEUIC) && (mode & MODEINITTRAN));

    // Read terminal voltage (capload.c:49-51).
    let vcap: number;
    if (cond1) {
      vcap = this._IC;
    } else {
      const v0 = n0 > 0 ? voltages[n0 - 1] : 0;
      const v1 = n1 > 0 ? voltages[n1 - 1] : 0;
      vcap = v0 - v1;
    }

    if (mode & (MODETRAN | MODEAC)) {
      // #ifndef PREDICTOR (capload.c:53-65).
      if (mode & MODEINITPRED) {
        // Copy state1 charge to state0 (capload.c:55-56).
        this.s0[this.base + SLOT_Q] = this.s1[this.base + SLOT_Q];
      } else {
        // Compute charge Q = C * V (capload.c:58).
        this.s0[this.base + SLOT_Q] = C * vcap;
        if (mode & MODEINITTRAN) {
          // Seed state1 from state0 (capload.c:60-62).
          this.s1[this.base + SLOT_Q] = this.s0[this.base + SLOT_Q];
        }
      }

      // NIintegrate via shared helper (capload.c:67-68, niinteg.c:17-80).
      const q0 = this.s0[this.base + SLOT_Q];
      const q1 = this.s1[this.base + SLOT_Q];
      const q2 = this.s2[this.base + SLOT_Q];
      const q3 = this.s3[this.base + SLOT_Q];
      const ccapPrev = this.s1[this.base + SLOT_CCAP];
      const { ccap, ceq, geq } = niIntegrate(
        ctx.method,
        ctx.order,
        C,
        ag,
        q0, q1,
        [q2, q3, 0, 0, 0],
        ccapPrev,
      );
      this.s0[this.base + SLOT_CCAP] = ccap;

      // Seed state1 companion current on first tran step (capload.c:70-72).
      if (mode & MODEINITTRAN) {
        this.s1[this.base + SLOT_CCAP] = this.s0[this.base + SLOT_CCAP];
      }

      // Cache companion state for diagnostic readout / getPinCurrents.
      this.s0[this.base + SLOT_GEQ] = geq;
      this.s0[this.base + SLOT_IEQ] = ceq;
      this.s0[this.base + SLOT_V] = vcap;

      // Allocate matrix handles once (ngspice spGetElement pattern).
      if (!this._handlesInit) {
        if (n0 !== 0) this._hAA = solver.allocElement(n0 - 1, n0 - 1);
        if (n1 !== 0) this._hBB = solver.allocElement(n1 - 1, n1 - 1);
        if (n0 !== 0 && n1 !== 0) {
          this._hAB = solver.allocElement(n0 - 1, n1 - 1);
          this._hBA = solver.allocElement(n1 - 1, n0 - 1);
        }
        this._handlesInit = true;
      }

      // Stamp companion model (capload.c:74-79).
      if (n0 !== 0) solver.stampElement(this._hAA, geq);
      if (n1 !== 0) solver.stampElement(this._hBB, geq);
      if (n0 !== 0 && n1 !== 0) {
        solver.stampElement(this._hAB, -geq);
        solver.stampElement(this._hBA, -geq);
      }
      if (n0 !== 0) solver.stampRHS(n0 - 1, -ceq);
      if (n1 !== 0) solver.stampRHS(n1 - 1, ceq);
    } else {
      // DC operating point: just store charge, no matrix stamp (capload.c:84).
      this.s0[this.base + SLOT_Q] = C * vcap;
      this.s0[this.base + SLOT_V] = vcap;
      this.s0[this.base + SLOT_GEQ] = 0;
      this.s0[this.base + SLOT_IEQ] = 0;
    }
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
  const C     = props.getModelParam<number>("capacitance");
  const IC    = props.hasModelParam("IC")    ? props.getModelParam<number>("IC")    : CAPACITOR_DEFAULTS["IC"]!;
  const TC1   = props.hasModelParam("TC1")   ? props.getModelParam<number>("TC1")   : CAPACITOR_DEFAULTS["TC1"]!;
  const TC2   = props.hasModelParam("TC2")   ? props.getModelParam<number>("TC2")   : CAPACITOR_DEFAULTS["TC2"]!;
  const TNOM  = props.hasModelParam("TNOM")  ? props.getModelParam<number>("TNOM")  : CAPACITOR_DEFAULTS["TNOM"]!;
  const SCALE = props.hasModelParam("SCALE") ? props.getModelParam<number>("SCALE") : CAPACITOR_DEFAULTS["SCALE"]!;
  const M     = props.hasModelParam("M")     ? props.getModelParam<number>("M")     : CAPACITOR_DEFAULTS["M"]!;
  return new AnalogCapacitorElement(C, IC, TC1, TC2, TNOM, SCALE, M);
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
