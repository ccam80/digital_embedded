/**
 * Capacitor analog component.
 *
 * Reactive two-terminal element modelled using companion model (equivalent
 * conductance + history current source). Implements updateCompanion() to
 * recompute geq and ieq at each timestep using one of three integration methods:
 * trapezoidal or gear (orders 1..2).
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
  type StandaloneComponentDefinition,
} from "../../core/registry.js";
import { formatSI } from "../../editor/si-format.js";
import type { PoolBackedAnalogElement } from "../../solver/analog/element.js";
import type { IntegrationMethod } from "../../solver/analog/integration.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import { niIntegrate } from "../../solver/analog/ni-integrate.js";
import {
  MODETRAN, MODEAC, MODETRANOP, MODEDC,
  MODEINITJCT, MODEINITTRAN, MODEINITPRED, MODEUIC,
} from "../../solver/analog/ckt-mode.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
import { defineModelParams, kelvinToCelsius } from "../../core/model-params.js";
import type { StatePoolRef } from "../../solver/analog/state-pool.js";
import {
  defineStateSchema,
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
    TNOM: { default: 300.15, unit: "K",    description: "Nominal temperature for TC coefficients", spiceConverter: kelvinToCelsius },
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
// CapacitorElement  CircuitElement implementation
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

    // Left lead + plate  colored by pin A voltage
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vA, 0, 0, 1.75, 0);
    ctx.drawLine(1.75, -0.75, 1.75, 0.75);

    // Right lead + plate  colored by pin B voltage
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
// AnalogCapacitorElement  MNA implementation
// ---------------------------------------------------------------------------

// Slot layout  5 slots total. Previous values are read from s1/s2/s3
// at the same offsets (pointer-rotation history).
const CAPACITOR_SCHEMA: StateSchema = defineStateSchema("AnalogCapacitorElement", [
  { name: "GEQ",  doc: "Companion conductance" },
  { name: "IEQ",  doc: "Companion history current" },
  { name: "V",    doc: "Terminal voltage this step" },
  { name: "Q",    doc: "Charge Q=C*V this step" },
  { name: "CCAP", doc: "Companion current (NIintegrate)" },
]);

const SLOT_GEQ  = 0;
const SLOT_IEQ  = 1;
const SLOT_V    = 2;
const SLOT_Q    = 3;
const SLOT_CCAP = 4;

/**
 * This class is the runtime element produced by the registered
 * `Capacitor` `StandaloneComponentDefinition`'s factory - see
 * `createCapacitorElement` below. It is the canonical capacitor
 * stamp; do not introduce a parallel non-registered capacitor
 * class.
 */
export class AnalogCapacitorElement implements PoolBackedAnalogElement {
  branchIndex: number = -1;
  _stateBase: number = -1;
  _pinNodes: Map<string, number>;
  label: string = "";

  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.CAP;
  readonly poolBacked = true as const;
  readonly stateSchema = CAPACITOR_SCHEMA;
  readonly stateSize = CAPACITOR_SCHEMA.size;

  private _nominalC: number;
  private C: number;
  private _IC: number;
  private _TC1: number;
  private _TC2: number;
  private _TNOM: number;
  private _SCALE: number;
  private _M: number;
  private _pool!: StatePoolRef;

  // Cached matrix-entry handles- allocated in setup() per capsetup.c:114-117.
  private _hPP: number = -1;
  private _hNN: number = -1;
  private _hPN: number = -1;
  private _hNP: number = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    this._pinNodes = new Map(pinNodes);
    this._nominalC = props.hasModelParam("capacitance") ? props.getModelParam<number>("capacitance") : CAPACITOR_DEFAULTS["capacitance"]!;
    this._IC       = props.hasModelParam("IC")    ? props.getModelParam<number>("IC")    : CAPACITOR_DEFAULTS["IC"]!;
    this._TC1      = props.hasModelParam("TC1")   ? props.getModelParam<number>("TC1")   : CAPACITOR_DEFAULTS["TC1"]!;
    this._TC2      = props.hasModelParam("TC2")   ? props.getModelParam<number>("TC2")   : CAPACITOR_DEFAULTS["TC2"]!;
    this._TNOM     = props.hasModelParam("TNOM")  ? props.getModelParam<number>("TNOM")  : CAPACITOR_DEFAULTS["TNOM"]!;
    this._SCALE    = props.hasModelParam("SCALE") ? props.getModelParam<number>("SCALE") : CAPACITOR_DEFAULTS["SCALE"]!;
    this._M        = props.hasModelParam("M")     ? props.getModelParam<number>("M")     : CAPACITOR_DEFAULTS["M"]!;
    // capload.c:44  CAPm is applied at stamp time, not folded into CAPcapac.
    // C is raw per-instance capacitance (TC + SCALE applied); M kept separate.
    // _pool not yet set in constructor; temperature defaults to TNOM  dT = 0.
    const _dT0 = 300.15 - this._TNOM;
    this.C = this._nominalC * (1 + this._TC1 * _dT0 + this._TC2 * _dT0 * _dT0) * this._SCALE;
  }

  setup(ctx: import("../../solver/analog/setup-context.js").SetupContext): void {
    const posNode = this._pinNodes.get("pos")!;  // CAPposNode
    const negNode = this._pinNodes.get("neg")!;  // CAPnegNode

    // capsetup.c:102-103  *states += 2 (CAPqcap slot).
    // digiTS uses stateSize slots (GEQ, IEQ, V, Q, CCAP) to cover all
    // companion-model state; ngspice uses only 2 (q, ccap) because it
    // derives GEQ/IEQ/V on the fly from state. Allocate full stateSize so
    // the pool covers every field load() reads/writes.
    this._stateBase = ctx.allocStates(this.stateSize);

    // capsetup.c:114-117  TSTALLOC sequence, line-for-line, with ground guards.
    if (posNode !== 0) this._hPP = ctx.solver.allocElement(posNode, posNode);
    if (negNode !== 0) this._hNN = ctx.solver.allocElement(negNode, negNode);
    if (posNode !== 0 && negNode !== 0) {
      this._hPN = ctx.solver.allocElement(posNode, negNode);
      this._hNP = ctx.solver.allocElement(negNode, posNode);
    }
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
  }

  setParam(key: string, value: number): void {
    if (key === "capacitance") {
      this._nominalC = value;
      const dT = 300.15 - this._TNOM;
      this.C = this._nominalC * (1 + this._TC1 * dT + this._TC2 * dT * dT) * this._SCALE;
    } else if (key === "IC") {
      this._IC = value;
    } else if (key === "TC1") {
      this._TC1 = value;
      const dT = 300.15 - this._TNOM;
      this.C = this._nominalC * (1 + this._TC1 * dT + this._TC2 * dT * dT) * this._SCALE;
    } else if (key === "TC2") {
      this._TC2 = value;
      const dT = 300.15 - this._TNOM;
      this.C = this._nominalC * (1 + this._TC1 * dT + this._TC2 * dT * dT) * this._SCALE;
    } else if (key === "TNOM") {
      this._TNOM = value;
      const dT = 300.15 - this._TNOM;
      this.C = this._nominalC * (1 + this._TC1 * dT + this._TC2 * dT * dT) * this._SCALE;
    } else if (key === "SCALE") {
      this._SCALE = value;
      const dT = 300.15 - this._TNOM;
      this.C = this._nominalC * (1 + this._TC1 * dT + this._TC2 * dT * dT) * this._SCALE;
    } else if (key === "M") {
      // capload.c:44  M is applied at stamp time; C is not recomputed when M changes.
      this._M = value;
    }
  }

  /**
   * Unified load()  ngspice capload.c CAPload.
   *
   * Reads terminal voltage, computes charge Q = C*V, NIintegrates inline using
   * ctx.ag[], and stamps the companion model (geq conductance + ceq current
   * source). Matches the Appendix D2 reference pattern.
   */
  load(ctx: LoadContext): void {
    const { solver, rhsOld: voltages, ag, cktMode: mode } = ctx;
    const n0 = this._pinNodes.get("pos")!;
    const n1 = this._pinNodes.get("neg")!;
    const C = this.C;
    // capload.c:44  m = CAPm; applied at every stamp site, not folded into C.
    const m = this._M;
    const base = this._stateBase;
    // pool.states[N] accessed at call time  no cached Float64Array refs (A4).
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];
    const s3 = this._pool.states[3];

    // ngspice capload.c:30  participate only in MODETRAN | MODEAC | MODETRANOP.
    if (!(mode & (MODETRAN | MODEAC | MODETRANOP))) return;

    // capload.c:32-36  IC gate.
    const cond1 =
      ((mode & MODEDC) && (mode & MODEINITJCT)) ||
      ((mode & MODEUIC) && (mode & MODEINITTRAN));

    // Read terminal voltage (capload.c:49-51).
    let vcap: number;
    if (cond1) {
      vcap = this._IC;
    } else {
      const v0 = voltages[n0];
      const v1 = voltages[n1];
      vcap = v0 - v1;
    }

    if (mode & (MODETRAN | MODEAC)) {
      // #ifndef PREDICTOR (capload.c:53-65).
      if (mode & MODEINITPRED) {
        // Copy state1 charge to state0 (capload.c:55-56).
        s0[base + SLOT_Q] = s1[base + SLOT_Q];
      } else {
        // Compute charge Q = C * V (capload.c:58).
        s0[base + SLOT_Q] = C * vcap;
        if (mode & MODEINITTRAN) {
          // Seed state1 from state0 (capload.c:60-62).
          s1[base + SLOT_Q] = s0[base + SLOT_Q];
        }
      }

      // NIintegrate via shared helper (capload.c:67-68, niinteg.c:17-80).
      const q0 = s0[base + SLOT_Q];
      const q1 = s1[base + SLOT_Q];
      const q2 = s2[base + SLOT_Q];
      const q3 = s3[base + SLOT_Q];
      const ccapPrev = s1[base + SLOT_CCAP];
      const { ccap, ceq, geq } = niIntegrate(
        ctx.method,
        ctx.order,
        C,
        ag,
        q0, q1,
        [q2, q3, 0, 0, 0],
        ccapPrev,
      );
      s0[base + SLOT_CCAP] = ccap;

      // Seed state1 companion current on first tran step (capload.c:70-72).
      if (mode & MODEINITTRAN) {
        s1[base + SLOT_CCAP] = s0[base + SLOT_CCAP];
      }

      // Cache companion state for diagnostic readout / getPinCurrents.
      s0[base + SLOT_GEQ] = geq;
      s0[base + SLOT_IEQ] = ceq;
      s0[base + SLOT_V] = vcap;

      // Stamp companion model (capload.c:74-79  all entries scaled by m = CAPm).
      if (n0 !== 0) solver.stampElement(this._hPP, m * geq);
      if (n1 !== 0) solver.stampElement(this._hNN, m * geq);
      if (n0 !== 0 && n1 !== 0) {
        solver.stampElement(this._hPN, -m * geq);
        solver.stampElement(this._hNP, -m * geq);
      }
      if (n0 !== 0) stampRHS(ctx.rhs,n0, -m * ceq);
      if (n1 !== 0) stampRHS(ctx.rhs,n1, m * ceq);
    } else {
      // DC operating point: just store charge, no matrix stamp (capload.c:84).
      s0[base + SLOT_Q] = C * vcap;
      s0[base + SLOT_V] = vcap;
      s0[base + SLOT_GEQ] = 0;
      s0[base + SLOT_IEQ] = 0;
    }
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const n0 = this._pinNodes.get("pos")!;
    const n1 = this._pinNodes.get("neg")!;
    const v0 = rhs[n0];
    const v1 = rhs[n1];
    const s0 = this._pool.states[0];
    const base = this._stateBase;
    const geq = s0[base + SLOT_GEQ];
    const ieq = s0[base + SLOT_IEQ];
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
    const base = this._stateBase;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];
    const s3 = this._pool.states[3];
    const q0 = s0[base + SLOT_Q];
    const q1 = s1[base + SLOT_Q];
    const q2 = s2[base + SLOT_Q];
    const q3 = s3[base + SLOT_Q];
    const ccap0 = s0[base + SLOT_CCAP];
    const ccap1 = s1[base + SLOT_CCAP];
    return cktTerr(dt, deltaOld, order, method, q0, q1, q2, q3, ccap0, ccap1, lteParams);
  }
}

function createCapacitorElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): PoolBackedAnalogElement {
  return new AnalogCapacitorElement(pinNodes, props);
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

export const CapacitorDefinition: StandaloneComponentDefinition = {
  name: "Capacitor",
  typeId: -1,
  factory: capacitorCircuitFactory,
  pinLayout: buildCapacitorPinDeclarations(),
  propertyDefs: CAPACITOR_PROPERTY_DEFS,
  attributeMap: CAPACITOR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Capacitor  reactive element with companion model.\n" +
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
