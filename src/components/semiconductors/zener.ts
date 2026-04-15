/**
 * Zener diode analog component — Shockley equation with reverse breakdown.
 *
 * Extends the standard diode with a reverse breakdown region:
 *   When Vd < -BV: Id = -IS * exp(-(Vd + BV) / (N*Vt))
 *
 * The breakdown region produces a sharply increasing reverse current at
 * Vd = -BV, modeling the Zener/avalanche effect.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, LABEL_PROPERTY_DEF } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { PoolBackedAnalogElementCore } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { stampG, stampRHS } from "../../solver/analog/stamp-helpers.js";
import { pnjlim } from "../../solver/analog/newton-raphson.js";
import type { LimitingEvent } from "../../solver/analog/newton-raphson.js";
import { defineModelParams } from "../../core/model-params.js";
import { VT } from "../../core/constants.js";
import { createDiodeElement, getDiodeInternalNodeCount, getDiodeInternalNodeLabels } from "./diode.js";
import type { StatePoolRef } from "../../core/analog-types.js";
import { defineStateSchema, applyInitialValues } from "../../solver/analog/state-schema.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

// VT (thermal voltage) imported from ../../core/constants.js

/** Minimum conductance for numerical stability (GMIN). */
const GMIN = 1e-12;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: ZENER_PARAM_DEFS, defaults: ZENER_PARAM_DEFAULTS } = defineModelParams({
  primary: {
    IS:  { default: 1e-14, unit: "A", description: "Saturation current" },
    N:   { default: 1,                description: "Emission coefficient" },
    BV:  { default: 5.1,  unit: "V", description: "Reverse breakdown voltage" },
    NBV: { default: NaN,              description: "Breakdown emission coefficient (defaults to N)" },
  },
});

// Full SPICE L1 zener param declarations (diode superset with BV as primary)
export const { paramDefs: ZENER_SPICE_L1_PARAM_DEFS, defaults: ZENER_SPICE_L1_DEFAULTS } = defineModelParams({
  primary: {
    BV:  { default: 5.1,      unit: "V", description: "Reverse breakdown voltage" },
    IS:  { default: 1e-14,    unit: "A", description: "Saturation current" },
    N:   { default: 1,                   description: "Emission coefficient" },
  },
  secondary: {
    RS:  { default: 0,        unit: "Ω",  description: "Ohmic (series) resistance" },
    CJO: { default: 0,        unit: "F",  description: "Zero-bias junction capacitance" },
    VJ:  { default: 1,        unit: "V",  description: "Junction built-in potential" },
    M:   { default: 0.5,                  description: "Grading coefficient" },
    TT:  { default: 0,        unit: "s",  description: "Transit time" },
    FC:  { default: 0.5,                  description: "Forward-bias capacitance coefficient" },
    IBV: { default: 1e-3,     unit: "A",  description: "Reverse breakdown current" },
    EG:  { default: 1.11,     unit: "eV", description: "Activation energy" },
    XTI: { default: 3,                    description: "Saturation current temperature exponent" },
    KF:  { default: 0,                    description: "Flicker noise coefficient" },
    AF:  { default: 1,                    description: "Flicker noise exponent" },
  },
});

// ---------------------------------------------------------------------------
// State schema declaration
// ---------------------------------------------------------------------------

const ZENER_STATE_SCHEMA = defineStateSchema("ZenerElement", [
  { name: "VD", doc: "Diode junction voltage (V)", init: { kind: "zero" } },
  { name: "GEQ", doc: "Linearized junction conductance (S)", init: { kind: "constant", value: 1e-12 } },
  { name: "IEQ", doc: "Linearized current source (A)", init: { kind: "zero" } },
  { name: "ID", doc: "Diode current (A)", init: { kind: "zero" } },
]);

// ---------------------------------------------------------------------------
// createZenerElement — AnalogElement factory
// ---------------------------------------------------------------------------

export function createZenerElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): PoolBackedAnalogElementCore {
  const nodeAnode = pinNodes.get("A")!;
  const nodeCathode = pinNodes.get("K")!;

  const params: Record<string, number> = { ...ZENER_PARAM_DEFAULTS };
  for (const key of props.getModelParamKeys()) {
    params[key] = props.getModelParam<number>(key);
  }
  // NBV defaults to N when not explicitly given (diosetup.c:93-95)
  if (isNaN(params.NBV)) params.NBV = params.N;

  // State pool slot indices
  const SLOT_VD = 0, SLOT_GEQ = 1, SLOT_IEQ = 2, SLOT_ID = 3;

  // Pool binding — set by initState
  let s0: Float64Array;
  let s1: Float64Array;
  let s2: Float64Array;
  let s3: Float64Array;
  let base: number;
  let pool: StatePoolRef;

  // Ephemeral per-iteration pnjlim limiting flag (ngspice icheck, DIOload sets CKTnoncon++)
  let pnjlimLimited = false;

  // One-shot cold-start seed from dcopInitJct. Non-null only between
  // primeJunctions() and the next updateOperatingPoint() call.
  let primedVd: number | null = null;

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,
    poolBacked: true as const,
    stateSize: 4,
    stateSchema: ZENER_STATE_SCHEMA,
    stateBaseOffset: -1,
    s0: new Float64Array(0),
    s1: new Float64Array(0),
    s2: new Float64Array(0),
    s3: new Float64Array(0),

    initState(poolRef: StatePoolRef): void {
      pool = poolRef;
      s0 = pool.state0;
      s1 = pool.state1;
      s2 = pool.state2;
      s3 = pool.state3;
      this.s0 = s0; this.s1 = s1; this.s2 = s2; this.s3 = s3;
      base = this.stateBaseOffset;
      applyInitialValues(ZENER_STATE_SCHEMA, pool, base, {});
    },

    refreshSubElementRefs(newS0: Float64Array, newS1: Float64Array, newS2: Float64Array, newS3: Float64Array): void {
      s0 = newS0;
      s1 = newS1;
      s2 = newS2;
      s3 = newS3;
    },

    stamp(_solver: SparseSolver): void {
      // No linear topology-constant contributions.
    },

    stampNonlinear(solver: SparseSolver): void {
      const geq = s0[base + SLOT_GEQ];
      const ieq = s0[base + SLOT_IEQ];
      stampG(solver, nodeAnode, nodeAnode, geq);
      stampG(solver, nodeAnode, nodeCathode, -geq);
      stampG(solver, nodeCathode, nodeAnode, -geq);
      stampG(solver, nodeCathode, nodeCathode, geq);
      stampRHS(solver, nodeAnode, -ieq);
      stampRHS(solver, nodeCathode, ieq);
    },

    updateOperatingPoint(voltages: Readonly<Float64Array>, limitingCollector?: LimitingEvent[] | null): void {
      let vdRaw: number;
      if (primedVd !== null) {
        vdRaw = primedVd;
        primedVd = null;
      } else {
        const va = nodeAnode > 0 ? voltages[nodeAnode - 1] : 0;
        const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
        vdRaw = va - vc;
      }

      // Recompute derived values from mutable params
      const nVt = params.N * VT;
      const vcrit = nVt * Math.log(nVt / (params.IS * Math.SQRT2));
      const nbvVt = params.NBV * VT;

      const vdOld = s0[base + SLOT_VD];
      let vdLimited: number;

      if (pool.initMode === "initJct") {
        // dioload.c:130-136: MODEINITJCT sets vd directly — no pnjlim
        vdLimited = vdRaw;
        pnjlimLimited = false;
      } else if (vdRaw < Math.min(0, -params.BV + 10 * nbvVt)) {
        // Breakdown region: apply pnjlim in reflected domain (dioload.c:180-191)
        const vdtemp = -(vdRaw + params.BV);
        const vdtempOld = -(vdOld + params.BV);
        const reflResult = pnjlim(vdtemp, vdtempOld, nbvVt, vcrit);
        pnjlimLimited = reflResult.limited;
        vdLimited = -(reflResult.value + params.BV);
      } else {
        // Forward/normal reverse: standard pnjlim
        const vdResult = pnjlim(vdRaw, vdOld, nVt, vcrit);
        vdLimited = vdResult.value;
        pnjlimLimited = vdResult.limited;
      }

      if (limitingCollector) {
        limitingCollector.push({
          elementIndex: (this as any).elementIndex ?? -1,
          label: (this as any).label ?? "",
          junction: "AK",
          limitType: "pnjlim",
          vBefore: vdRaw,
          vAfter: vdLimited,
          wasLimited: pnjlimLimited,
        });
      }

      s0[base + SLOT_VD] = vdLimited;

      if (vdLimited >= -params.BV) {
        // Forward region and normal reverse region: standard Shockley
        const expArg = Math.min(vdLimited / nVt, 700);
        const expVal = Math.exp(expArg);
        const id = params.IS * (expVal - 1);
        s0[base + SLOT_ID] = id;
        s0[base + SLOT_GEQ] = (params.IS * expVal) / nVt + GMIN;
        s0[base + SLOT_IEQ] = id - s0[base + SLOT_GEQ] * vdLimited;
      } else {
        // Reverse breakdown region: Id = -IS * exp(-(Vd + BV) / (NBV*Vt))
        const bdExpArg = Math.min(-(vdLimited + params.BV) / nbvVt, 700);
        const bdExpVal = Math.exp(bdExpArg);
        const id = -params.IS * bdExpVal;
        s0[base + SLOT_ID] = id;
        s0[base + SLOT_GEQ] = (params.IS * bdExpVal) / nbvVt + GMIN;
        s0[base + SLOT_IEQ] = id - s0[base + SLOT_GEQ] * vdLimited;
      }
    },

    checkConvergence(voltages: Float64Array, _prevVoltages: Float64Array, reltol: number, abstol: number): boolean {
      // ngspice icheck gate: if voltage was limited in updateOperatingPoint,
      // declare non-convergence immediately (DIOload sets CKTnoncon++)
      if (pnjlimLimited) return false;

      const va = nodeAnode > 0 ? voltages[nodeAnode - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vdRaw = va - vc;

      // ngspice DIOconvTest: current-prediction convergence
      const delvd = vdRaw - s0[base + SLOT_VD];
      const id = s0[base + SLOT_ID];
      const gd = s0[base + SLOT_GEQ];
      const cdhat = id + gd * delvd;
      const tol = reltol * Math.max(Math.abs(cdhat), Math.abs(id)) + abstol;
      return Math.abs(cdhat - id) <= tol;
    },

    getPinCurrents(_voltages: Float64Array): number[] {
      // pinLayout order: [A (anode), K (cathode)]
      // Positive = current flowing INTO element at that pin.
      const id = s0[base + SLOT_ID];
      return [id, -id];
    },

    primeJunctions(): void {
      // dioload.c:135-136: MODEINITJCT sets vd = tVcrit
      const nVt = params.N * VT;
      const vcrit = nVt * Math.log(nVt / (params.IS * Math.SQRT2));
      primedVd = vcrit;
    },

    setParam(key: string, value: number): void {
      if (key in params) params[key] = value;
    },
  };
}

// ---------------------------------------------------------------------------
// ZenerElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class ZenerElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("ZenerDiode", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildZenerPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 0.6875,
      width: 4,
      height: 1.375,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const label = this._visibleLabel();

    const vA = signals?.getPinVoltage("A");
    const vK = signals?.getPinVoltage("K");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Geometry matching Falstad drawZenerDiode reference
    // p1={x:0,y:0}, p2={x:4,y:0}, bodyLen=1, hs=0.5
    const PX = 1 / 16;
    const hs = 8 * PX; // 0.5

    // lead1/lead2 from calcLeads with bodyLen=1
    const lead1 = { x: 1.5, y: 0 };
    const lead2 = { x: 2.5, y: 0 };

    // Anode lead
    drawColoredLead(ctx, signals, vA, 0, 0, lead1.x, lead1.y);

    // Cathode lead
    drawColoredLead(ctx, signals, vK, lead2.x, lead2.y, 4, 0);

    // Body (triangle, cathode bar, wings) stays COMPONENT color
    ctx.setColor("COMPONENT");

    // Filled diode triangle: lead1 → lead2 tip
    ctx.drawPolygon([
      { x: lead1.x, y: -hs },
      { x: lead1.x, y: hs },
      { x: lead2.x, y: 0 },
    ], true);

    // Cathode bar: cath0/cath1 are perpendicular to lead1→lead2 at lead2
    // direction is along y axis (perpendicular to horizontal wire)
    const cath0 = { x: lead2.x, y: -hs };
    const cath1 = { x: lead2.x, y: hs };
    ctx.drawLine(cath0.x, cath0.y, cath1.x, cath1.y);

    // Zener wings: bent ends at fraction -0.2 and 1.2 along cath0→cath1
    // interpPointSingle(a,b,f,g): point at fraction f along a→b, offset g perpendicular (along x for vertical bar)
    // Perpendicular to cath0→cath1 (which is vertical) is horizontal
    // Wing tips at ±11/16 = ±0.6875 grid units (from Falstad pixel coords ±11 at 16px/unit)
    const wing0 = {
      x: cath0.x - hs,
      y: -11 / 16,
    };
    const wing1 = {
      x: cath1.x + hs,
      y: 11 / 16,
    };
    ctx.drawLine(cath0.x, cath0.y, wing0.x, wing0.y);
    ctx.drawLine(cath1.x, cath1.y, wing1.x, wing1.y);

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(label, 2, -(hs + 0.25), { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

}

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

function buildZenerPinDeclarations(): PinDeclaration[] {
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
      label: "K",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const ZENER_PROPERTY_DEFS: PropertyDefinition[] = [
  LABEL_PROPERTY_DEF,
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const ZENER_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "model",
    propertyKey: "model",
    convert: (v) => v,
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
];

// ---------------------------------------------------------------------------
// ZenerDiodeDefinition
// ---------------------------------------------------------------------------

function zenerCircuitFactory(props: PropertyBag): ZenerElement {
  return new ZenerElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const ZenerDiodeDefinition: ComponentDefinition = {
  name: "ZenerDiode",
  typeId: -1,
  factory: zenerCircuitFactory,
  pinLayout: buildZenerPinDeclarations(),
  propertyDefs: ZENER_PROPERTY_DEFS,
  attributeMap: ZENER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "Zener Diode — Shockley diode with reverse breakdown at BV.\n" +
    "Forward: Id = IS * (exp(Vd/(N*Vt)) - 1)\n" +
    "Reverse breakdown (Vd < -BV): Id = -IS * exp(-(Vd+BV)/(N*Vt))",
  models: {},
  modelRegistry: {
    "spice": {
      kind: "inline",
      factory: createDiodeElement,
      paramDefs: ZENER_SPICE_L1_PARAM_DEFS,
      params: ZENER_SPICE_L1_DEFAULTS,
      getInternalNodeCount: getDiodeInternalNodeCount,
      getInternalNodeLabels: getDiodeInternalNodeLabels,
    },
    "simplified": {
      kind: "inline",
      factory: createZenerElement,
      paramDefs: ZENER_PARAM_DEFS,
      params: ZENER_PARAM_DEFAULTS,
    },
  },
  defaultModel: "spice",
};
