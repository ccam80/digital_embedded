/**
 * Inductor analog component.
 *
 * Reactive two-terminal element that requires a branch variable (extra MNA row)
 * to track branch current. Uses companion model (equivalent conductance + history
 * current source) recomputed at each timestep with one of three integration methods:
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
  type ComponentDefinition,
} from "../../core/registry.js";
import { formatSI } from "../../editor/si-format.js";
import type { AnalogElementCore, ReactiveAnalogElementCore, IntegrationMethod, LoadContext } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/element.js";
import { cktTerr } from "../../solver/analog/ckt-terr.js";
import { niIntegrate } from "../../solver/analog/ni-integrate.js";
import {
  MODEDC, MODEINITTRAN, MODEINITPRED, MODEUIC,
} from "../../solver/analog/ckt-mode.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
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
// InductorElement â€” CircuitElement implementation
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
    // Add tiny epsilon to height: sin(PI) â‰ˆ 1.22e-16, not exactly 0,
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

    // Left lead â€” colored by pin A voltage
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vA, 0, 0, 1, 0);

    // Right lead â€” colored by pin B voltage
    drawColoredLead(ctx, hasVoltage ? signals : undefined, vB, 3, 0, 4, 0);

    // Coil body: 3 semicircular arcs from PI to 2*PI â€” gradient from vA to vB
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
// AnalogInductorElement â€” MNA implementation
// ---------------------------------------------------------------------------

// State schema â€” exact ngspice INDinstance layout (inddefs.h:68-69).
// Two slots only:
//   INDflux = INDstate+0  â€” flux Î¦ = LÂ·i (the qcap fed to NIintegrate)
//   INDvolt = INDstate+1  â€” NIintegrate companion-current cache. Despite the
//                            "INDvolt" name in ngspice, niinteg.c:15
//                            (`#define ccap qcap+1`) makes this slot the
//                            ccap recursion buffer for trap order 2.
// No GEQ/IEQ/I/VOLT-as-node-voltage slots exist in ngspice â€” req/veq are
// indload.c locals; branch current comes from CKTrhsOld[INDbrEq], not state.
const INDUCTOR_SCHEMA: StateSchema = defineStateSchema("AnalogInductorElement", [
  { name: "PHI",  doc: "Flux Î¦ = LÂ·i â€” ngspice INDflux (INDstate+0)", init: { kind: "zero" } },
  { name: "CCAP", doc: "NIintegrate companion current â€” ngspice INDvolt (INDstate+1) per niinteg.c:15 `#define ccap qcap+1`", init: { kind: "zero" } },
]);

const SLOT_PHI  = 0;  // ngspice INDflux = INDstate+0
const SLOT_CCAP = 1;  // ngspice INDvolt = INDstate+1 (= NIintegrate ccap)

export class AnalogInductorElement implements ReactiveAnalogElementCore {
  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
  readonly branchIndex: number;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.IND;
  readonly isNonlinear = false;
  readonly isReactive = true;
  readonly poolBacked = true as const;
  readonly stateSchema = INDUCTOR_SCHEMA;
  readonly stateSize = INDUCTOR_SCHEMA.size;
  stateBaseOffset = -1;
  s0: Float64Array = new Float64Array(0);
  s1: Float64Array = new Float64Array(0);
  s2: Float64Array = new Float64Array(0);
  s3: Float64Array = new Float64Array(0);
  s4: Float64Array = new Float64Array(0);
  s5: Float64Array = new Float64Array(0);
  s6: Float64Array = new Float64Array(0);
  s7: Float64Array = new Float64Array(0);

  private _nominalL: number;
  private L: number;
  private _IC: number;
  private _TC1: number;
  private _TC2: number;
  private _TNOM: number;
  private _SCALE: number;
  private _M: number;
  private _pool!: StatePoolRef;

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
    applyInitialValues(INDUCTOR_SCHEMA, pool, this.stateBaseOffset, {});
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
   * load() â€” exact 1:1 port of ngspice indload.c INDload (lines 35-124).
   *
   * Structural mirror (no extra slots, no extra helpers, no DC-OP-only branch
   * outside ngspice's MODEDC arm):
   *   indload.c:43-51   â€” flux-from-current update, gated on !(MODEDC|MODEINITPRED)
   *   indload.c:88-110  â€” req/veq: DC â‡’ 0, else mutually-exclusive
   *                        MODEINITPRED (s0=s1 PHI) / MODEINITTRAN (s1=s0 PHI),
   *                        then NIintegrate(geq, ceq, L, INDflux). niinteg.c:15
   *                        `#define ccap qcap+1` â‡’ NIintegrate writes
   *                        state0[INDflux+1] = state0[INDvolt] = s0[SLOT_CCAP]
   *                        and reads state1[INDvolt] = s1[SLOT_CCAP] for the
   *                        TRAP order-2 recursion buffer.
   *   indload.c:112     â€” *(CKTrhs + INDbrEq) += veq
   *   indload.c:114-117 â€” *(CKTstate1 + INDvolt) = *(CKTstate0 + INDvolt)
   *                        on MODEINITTRAN (= s1[CCAP] = s0[CCAP]; seeds the
   *                        TRAP-order-2 recursion buffer for the next step).
   *   indload.c:119-123 â€” unconditional 5-stamp sequence: Â±1 incidence,
   *                        -req branch diagonal.
   *
   * `m` (parallel multiplicity) and SCALE / TC1 / TC2 / TNOM are folded into
   * `this.L` by `_computeEffectiveL()`, so `L` here corresponds to ngspice's
   * `here->INDinduct/m` after temperature scaling.
   */
  load(ctx: LoadContext): void {
    const { solver, rhsOld, ag, cktMode: mode } = ctx;
    const n0 = this.pinNodeIds[0];
    const n1 = this.pinNodeIds[1];
    const b = this.branchIndex;
    const L = this.L;
    const base = this.stateBaseOffset;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];
    const s3 = this._pool.states[3];

    // indload.c:43-51 â€” flux-from-current update.
    if (!(mode & (MODEDC | MODEINITPRED))) {
      if ((mode & MODEUIC) && (mode & MODEINITTRAN) && !isNaN(this._IC)) {
        // indload.c:44-46: UIC seed.
        s0[base + SLOT_PHI] = L * this._IC;
      } else {
        // indload.c:48-50: flux from prior NR iterate branch current
        // (CKTrhsOld + INDbrEq).
        s0[base + SLOT_PHI] = L * rhsOld[b];
      }
    }

    // indload.c:88-110 â€” req/veq.
    let req = 0;
    let veq = 0;
    if (mode & MODEDC) {
      // indload.c:88-90.
      req = 0;
      veq = 0;
    } else {
      // indload.c:93-104 (#ifndef PREDICTOR): mutually-exclusive flux copies.
      if (mode & MODEINITPRED) {
        // indload.c:94-96: predictor â€” s0[INDflux] = s1[INDflux].
        s0[base + SLOT_PHI] = s1[base + SLOT_PHI];
      } else if (mode & MODEINITTRAN) {
        // indload.c:99-102: transient init â€” s1[INDflux] = s0[INDflux]
        // BEFORE NIintegrate so the order-2 history is seeded.
        s1[base + SLOT_PHI] = s0[base + SLOT_PHI];
      }
      // indload.c:106-109: NIintegrate(ckt, &geq, &ceq, L, INDflux).
      // niinteg.c writes state0[INDvolt] = state0[ccap] = s0[SLOT_CCAP].
      const phi0 = s0[base + SLOT_PHI];
      const phi1 = s1[base + SLOT_PHI];
      const phi2 = s2[base + SLOT_PHI];
      const phi3 = s3[base + SLOT_PHI];
      const ccapPrev = s1[base + SLOT_CCAP];
      const ni = niIntegrate(
        ctx.method,
        ctx.order,
        L,
        ag,
        phi0, phi1,
        [phi2, phi3, 0, 0, 0],
        ccapPrev,
      );
      req = ni.geq;
      veq = ni.ceq;
      s0[base + SLOT_CCAP] = ni.ccap;
    }

    // indload.c:114-117: state0[INDvolt] â†’ state1[INDvolt] on MODEINITTRAN
    // (= s0[CCAP] â†’ s1[CCAP]; seeds the trap-order-2 recursion buffer).
    if (mode & MODEINITTRAN) {
      s1[base + SLOT_CCAP] = s0[base + SLOT_CCAP];
    }

    // indload.c:119-123: unconditional 5-stamp sequence.
    // INDposIbrptr / INDnegIbrptr (B sub-matrix: Â±1 at (n, b)).
    if (n0 !== 0) solver.stampElement(solver.allocElement(n0, b), 1);
    if (n1 !== 0) solver.stampElement(solver.allocElement(n1, b), -1);
    // INDibrPosptr / INDibrNegptr (C sub-matrix: Â±1 at (b, n) â€” KVL incidence).
    if (n0 !== 0) solver.stampElement(solver.allocElement(b, n0), 1);
    if (n1 !== 0) solver.stampElement(solver.allocElement(b, n1), -1);
    // INDibrIbrptr (-req branch diagonal). Stamped even at DC where req=0 so
    // the structural nonzero is preserved across the handle table.
    solver.stampElement(solver.allocElement(b, b), -req);
    // indload.c:112: *(CKTrhs + INDbrEq) += veq.
    stampRHS(ctx.rhs,b, veq);
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
    const base = this.stateBaseOffset;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const s2 = this._pool.states[2];
    const s3 = this._pool.states[3];
    const phi0 = s0[base + SLOT_PHI];
    const phi1 = s1[base + SLOT_PHI];
    const phi2 = s2[base + SLOT_PHI];
    const phi3 = s3[base + SLOT_PHI];
    const ccap0 = s0[base + SLOT_CCAP];
    const ccap1 = s1[base + SLOT_CCAP];
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
    "Inductor â€” reactive element with companion model and branch current.\n" +
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
