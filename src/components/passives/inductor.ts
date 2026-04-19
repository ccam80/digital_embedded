/**
 * Inductor analog component.
 *
 * Reactive two-terminal element that requires a branch variable (extra MNA row)
 * to track branch current. Uses companion model (equivalent conductance + history
 * current source) recomputed at each timestep with one of three integration methods:
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
import { defineModelParams } from "../../core/model-params.js";
import type { StatePoolRef } from "../../core/analog-types.js";
import { defineStateSchema, applyInitialValues } from "../../solver/analog/state-schema.js";
import type { StateSchema } from "../../solver/analog/state-schema.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: INDUCTOR_PARAM_DEFS, defaults: INDUCTOR_DEFAULTS } = defineModelParams({
  primary: {
    inductance: { default: 1e-3, unit: "H", description: "Inductance in henries", min: 1e-12 },
  },
  secondary: {
    IC:   { default: NaN,    unit: "A",    description: "Initial condition current for UIC" },
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

function buildInductorPinDeclarations(): PinDeclaration[] {
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
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// InductorElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class InductorElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Inductor", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildInductorPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    const r = 2 / (2 * 3); // segLen / (2 * loopCt) = 1/3
    // Add tiny epsilon to height: sin(PI) ≈ 1.22e-16, not exactly 0,
    // so arc endpoint y is ~4e-17 above 0; bbox must cover that.
    return {
      x: this.position.x,
      y: this.position.y - r,
      width: 4,
      height: r + 1e-10,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const inductance = this._properties.getModelParam<number>("inductance");
    const label = this._visibleLabel();

    ctx.save();
    ctx.setLineWidth(1);

    const vA = signals?.getPinVoltage("A");
    const vB = signals?.getPinVoltage("B");
    const hasVoltage = vA !== undefined && vB !== undefined;

    // Left lead — colored by pin A voltage
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vA, 0, 0, 1, 0);

    // Right lead — colored by pin B voltage
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vB, 3, 0, 4, 0);

    // Coil body: 3 semicircular arcs from PI to 2*PI — gradient from vA to vB
    const loopCt = 3;
    const segLen = 2;
    const r = segLen / (2 * loopCt); // arc radius = 1/3 grid unit
    if (hasVoltage && ctx.setLinearGradient) {
      ctx.setLinearGradient(1, 0, 3, 0, [
        { offset: 0, color: signals!.voltageColor(vA) },
        { offset: 1, color: signals!.voltageColor(vB) },
      ]);
    } else {
      ctx.setColor("COMPONENT");
    }
    for (let loop = 0; loop < loopCt; loop++) {
      const cx = 1 + (segLen * (loop + 0.5)) / loopCt;
      ctx.drawArc(cx, 0, r, Math.PI, 2 * Math.PI);
    }

    // Value label above body (matching Falstad reference: pixel (27,-10) = grid (1.6875,-0.625))
    const displayLabel = label.length > 0 ? label : (this._shouldShowValue() ? formatSI(inductance, "H") : "");
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.7 });
    ctx.drawText(displayLabel, 1.6875, -0.625, { horizontal: "center", vertical: "bottom" });

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// AnalogInductorElement — MNA implementation
// ---------------------------------------------------------------------------

// Slot layout — 5 slots total. Previous values are read from s1/s2/s3
// at the same offsets (pointer-rotation history).
const INDUCTOR_SCHEMA: StateSchema = defineStateSchema("AnalogInductorElement", [
  { name: "GEQ",  doc: "Companion conductance",          init: { kind: "zero" } },
  { name: "IEQ",  doc: "Companion history current",      init: { kind: "zero" } },
  { name: "I",    doc: "Branch current this step",       init: { kind: "zero" } },
  { name: "PHI",  doc: "Flux phi=L*i this step",         init: { kind: "zero" } },
  { name: "CCAP", doc: "Companion current (NIintegrate)", init: { kind: "zero" } },
  { name: "VOLT", doc: "Terminal voltage this step",     init: { kind: "zero" } },
]);

// Slot indices within the state pool
const SLOT_GEQ  = 0;
const SLOT_IEQ  = 1;
const SLOT_I    = 2;
const SLOT_PHI  = 3;
const SLOT_CCAP = 4;
const SLOT_VOLT = 5;

export class AnalogInductorElement implements ReactiveAnalogElementCore {
  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
  readonly branchIndex: number;
  readonly isNonlinear = false;
  readonly isReactive = true;
  readonly poolBacked = true as const;
  readonly stateSchema = INDUCTOR_SCHEMA;
  readonly stateSize = INDUCTOR_SCHEMA.size;
  stateBaseOffset = -1;

  private _nominalL: number;
  private L: number;
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

  constructor(branchIdx: number, inductance: number, IC: number, TC1: number, TC2: number, TNOM: number, SCALE: number, M: number) {
    this.branchIndex = branchIdx;
    this._nominalL = inductance;
    this._IC = IC;
    this._TC1 = TC1;
    this._TC2 = TC2;
    this._TNOM = TNOM;
    this._SCALE = SCALE;
    this._M = M;
    this.L = this._computeEffectiveL();
  }

  private _computeEffectiveL(): number {
    const T = this._pool?.temperature ?? 300.15;
    const dT = T - this._TNOM;
    const factor = 1 + this._TC1 * dT + this._TC2 * dT * dT;
    return this._nominalL * factor * this._SCALE / this._M;
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
    applyInitialValues(INDUCTOR_SCHEMA, pool, this.base, {});
  }

  setParam(key: string, value: number): void {
    if (key === "inductance") {
      this._nominalL = value;
      this.L = this._computeEffectiveL();
    } else if (key === "IC") {
      this._IC = value;
    } else if (key === "TC1") {
      this._TC1 = value;
      this.L = this._computeEffectiveL();
    } else if (key === "TC2") {
      this._TC2 = value;
      this.L = this._computeEffectiveL();
    } else if (key === "TNOM") {
      this._TNOM = value;
      this.L = this._computeEffectiveL();
    } else if (key === "SCALE") {
      this._SCALE = value;
      this.L = this._computeEffectiveL();
    } else if (key === "M") {
      this._M = value;
      this.L = this._computeEffectiveL();
    }
  }

  /**
   * Unified load() — ngspice indload.c INDload (lines 35-124).
   *
   * Matches the ngspice structure literally: one stamp sequence for all modes.
   * In DC (MODEDC) we set req=veq=0 (indload.c:88-90); in TRAN we compute them
   * via niIntegrate. The five stamps (±1 incidence, -req branch diagonal, +veq
   * RHS) then run unconditionally (indload.c:119-123). Matrix pattern is
   * mode-invariant; the sparse handle table keeps the structural nonzero.
   *
   * Flux update is guarded by !(MODEDC|MODEINITPRED) (indload.c:43).
   */
  load(ctx: LoadContext): void {
    const { solver, voltages, initMode, isDcOp, isTransient, ag } = ctx;
    const n0 = this.pinNodeIds[0];
    const n1 = this.pinNodeIds[1];
    const b = this.branchIndex;
    const L = this.L;
    const base = this.base;

    // Initial condition gate (dual of capload.c:32-36; indload.c:44-46 uic path).
    const cond1 = (isDcOp && initMode === "initJct") ||
                  (ctx.uic && initMode === "initTran" && !isNaN(this._IC));

    let iNow: number;
    if (cond1) {
      iNow = this._IC;
    } else {
      iNow = voltages[b];
    }

    const n0v = n0 > 0 ? voltages[n0 - 1] : 0;
    const n1v = n1 > 0 ? voltages[n1 - 1] : 0;

    // Flux-state update — guarded by !(MODEDC|MODEINITPRED) per indload.c:43.
    // DC (including DCOP) skips flux update entirely; in initPred we copy
    // state1→state0 (indload.c:94-96); otherwise state0 = L*i (indload.c:47-50).
    if (!isDcOp && initMode !== "initPred") {
      this.s0[base + SLOT_PHI] = L * iNow;
      if (initMode === "initTran") {
        this.s1[base + SLOT_PHI] = this.s0[base + SLOT_PHI];
      }
    } else if (initMode === "initPred") {
      this.s0[base + SLOT_PHI] = this.s1[base + SLOT_PHI];
    }

    // Compute req, veq — DC case writes zero (indload.c:88-90), TRAN calls
    // NIintegrate (indload.c:91-109) for trapezoidal/gear integration.
    let req = 0;
    let veq = 0;
    let ccap = 0;
    if (isTransient) {
      const phi0 = this.s0[base + SLOT_PHI];
      const phi1 = this.s1[base + SLOT_PHI];
      const phi2 = this.s2[base + SLOT_PHI];
      const phi3 = this.s3[base + SLOT_PHI];
      const ccapPrev = this.s1[base + SLOT_CCAP];
      const ni = niIntegrate(
        ctx.method,
        ctx.order,
        L,
        ag,
        phi0, phi1,
        [phi2, phi3, 0, 0, 0],
        ccapPrev,
      );
      ccap = ni.ccap;
      veq = ni.ceq;
      req = ni.geq;
      this.s0[base + SLOT_CCAP] = ccap;
      if (initMode === "initTran") {
        this.s1[base + SLOT_CCAP] = ccap;
      }
    }

    // Diagnostic cache (mode-invariant bookkeeping).
    this.s0[base + SLOT_GEQ]  = req;
    this.s0[base + SLOT_IEQ]  = veq;
    this.s0[base + SLOT_I]    = iNow;
    this.s0[base + SLOT_VOLT] = n0v - n1v;

    // Unconditional stamp sequence — matches indload.c:119-123 exactly.
    // B sub-matrix: I_branch flows into n0, out of n1 (INDposIbrptr/INDnegIbrptr).
    if (n0 !== 0) solver.stampElement(solver.allocElement(n0 - 1, b), 1);
    if (n1 !== 0) solver.stampElement(solver.allocElement(n1 - 1, b), -1);
    // C sub-matrix: KVL incidence (INDibrPosptr/INDibrNegptr).
    if (n0 !== 0) solver.stampElement(solver.allocElement(b, n0 - 1), 1);
    if (n1 !== 0) solver.stampElement(solver.allocElement(b, n1 - 1), -1);
    // Branch diagonal (-req) and RHS (+veq) — stamped even if req=veq=0 at DC.
    // allocElement is idempotent via handle table → structural nonzero preserved.
    solver.stampElement(solver.allocElement(b, b), -req);
    solver.stampRHS(b, veq);
  }

  getPinCurrents(voltages: Float64Array): number[] {
    const I = voltages[this.branchIndex];
    return [I, -I];
  }

  getLteTimestep(
    dt: number,
    deltaOld: readonly number[],
    order: number,
    method: IntegrationMethod,
    lteParams: import("../../solver/analog/ckt-terr.js").LteParams,
  ): number {
    const phi0 = this.s0[this.base + SLOT_PHI];
    const phi1 = this.s1[this.base + SLOT_PHI];
    const phi2 = this.s2[this.base + SLOT_PHI];
    const phi3 = this.s3[this.base + SLOT_PHI];
    const ccap0 = this.s0[this.base + SLOT_CCAP];
    const ccap1 = this.s1[this.base + SLOT_CCAP];
    return cktTerr(dt, deltaOld, order, method, phi0, phi1, phi2, phi3, ccap0, ccap1, lteParams);
  }
}

function createInductorElement(
  _pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const L     = props.getModelParam<number>("inductance");
  const IC    = props.hasModelParam("IC")    ? props.getModelParam<number>("IC")    : INDUCTOR_DEFAULTS["IC"]!;
  const TC1   = props.hasModelParam("TC1")   ? props.getModelParam<number>("TC1")   : INDUCTOR_DEFAULTS["TC1"]!;
  const TC2   = props.hasModelParam("TC2")   ? props.getModelParam<number>("TC2")   : INDUCTOR_DEFAULTS["TC2"]!;
  const TNOM  = props.hasModelParam("TNOM")  ? props.getModelParam<number>("TNOM")  : INDUCTOR_DEFAULTS["TNOM"]!;
  const SCALE = props.hasModelParam("SCALE") ? props.getModelParam<number>("SCALE") : INDUCTOR_DEFAULTS["SCALE"]!;
  const M     = props.hasModelParam("M")     ? props.getModelParam<number>("M")     : INDUCTOR_DEFAULTS["M"]!;
  return new AnalogInductorElement(branchIdx, L, IC, TC1, TC2, TNOM, SCALE, M);
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const INDUCTOR_PROPERTY_DEFS: PropertyDefinition[] = [
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

export const INDUCTOR_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "inductance",
    propertyKey: "inductance",
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
// InductorDefinition
// ---------------------------------------------------------------------------

function inductorCircuitFactory(props: PropertyBag): InductorElement {
  return new InductorElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const InductorDefinition: ComponentDefinition = {
  name: "Inductor",
  typeId: -1,
  factory: inductorCircuitFactory,
  pinLayout: buildInductorPinDeclarations(),
  propertyDefs: INDUCTOR_PROPERTY_DEFS,
  attributeMap: INDUCTOR_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Inductor — reactive element with companion model and branch current.\n" +
    "Stamps equivalent conductance, history current, and branch incidence entries.",
  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createInductorElement,
      paramDefs: INDUCTOR_PARAM_DEFS,
      params: INDUCTOR_DEFAULTS,
      branchCount: 1,
    },
  },
  defaultModel: "behavioral",
};
