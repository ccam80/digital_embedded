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
import { PropertyBag, PropertyType, LABEL_PROPERTY_DEF } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElementCore } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { stampG, stampRHS } from "../../solver/analog/stamp-helpers.js";
import { pnjlim } from "../../solver/analog/newton-raphson.js";
import { ZENER_DEFAULTS } from "../../solver/analog/model-defaults.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

/** Thermal voltage at 300 K (kT/q in volts). */
const VT = 0.02585;

/** Minimum conductance for numerical stability (GMIN). */
const GMIN = 1e-12;


// ---------------------------------------------------------------------------
// createZenerElement — AnalogElement factory
// ---------------------------------------------------------------------------

export function createZenerElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const nodeAnode = pinNodes.get("A")!;
  const nodeCathode = pinNodes.get("K")!;

  // Resolve model parameters from _modelParams (injected by compiler with ZENER_DEFAULTS base)
  const mp =
    ((props as Record<string, unknown>)["_modelParams"] as Record<string, number>) ?? ZENER_DEFAULTS;

  const IS = mp["IS"];
  const N = mp["N"];
  const rawBV = mp["BV"];
  const BV = Number.isFinite(rawBV) ? rawBV : ZENER_DEFAULTS["BV"]; // keep BV guard
  const IBV = mp["IBV"];

  const nVt = N * VT;
  const vcrit = nVt * Math.log(nVt / (IS * Math.SQRT2));

  // NR linearization state
  let vd = 0;
  let geq = GMIN;
  let ieq = 0;
  let _id = 0; // cached junction current for getPinCurrents

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,

    stamp(_solver: SparseSolver): void {
      // No linear topology-constant contributions.
    },

    stampNonlinear(solver: SparseSolver): void {
      stampG(solver, nodeAnode, nodeAnode, geq);
      stampG(solver, nodeAnode, nodeCathode, -geq);
      stampG(solver, nodeCathode, nodeAnode, -geq);
      stampG(solver, nodeCathode, nodeCathode, geq);
      stampRHS(solver, nodeAnode, -ieq);
      stampRHS(solver, nodeCathode, ieq);
    },

    updateOperatingPoint(voltages: Float64Array): void {
      const va = nodeAnode > 0 ? voltages[nodeAnode - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vdRaw = va - vc;

      // Apply pnjlim to prevent exponential runaway in forward region
      const vdLimited = pnjlim(vdRaw, vd, nVt, vcrit);

      if (nodeAnode > 0) {
        voltages[nodeAnode - 1] = vc + vdLimited;
      }

      vd = vdLimited;

      // Compute diode current and linearized conductance
      if (vd >= -BV) {
        // Forward region and normal reverse region: standard Shockley
        const expArg = Math.min(vd / nVt, 700);
        const expVal = Math.exp(expArg);
        const id = IS * (expVal - 1);
        _id = id;
        geq = (IS * expVal) / nVt + GMIN;
        ieq = id - geq * vd;
      } else {
        // Reverse breakdown region: Id = -IBV * exp(-(Vd + BV) / (N*Vt))
        // IBV is the reference current at the breakdown voltage BV.
        const bdExpArg = Math.min(-(vd + BV) / nVt, 700);
        const bdExpVal = Math.exp(bdExpArg);
        const id = -IBV * bdExpVal;
        _id = id;
        // geq = |dId/dVd| = IBV * exp(-(Vd+BV)/nVt) / nVt
        geq = (IBV * bdExpVal) / nVt + GMIN;
        ieq = id - geq * vd;
      }
    },

    checkConvergence(voltages: Float64Array, prevVoltages: Float64Array): boolean {
      const va = nodeAnode > 0 ? voltages[nodeAnode - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vdNew = va - vc;

      const vaPrev = nodeAnode > 0 ? prevVoltages[nodeAnode - 1] : 0;
      const vcPrev = nodeCathode > 0 ? prevVoltages[nodeCathode - 1] : 0;
      const vdPrevVal = vaPrev - vcPrev;

      return Math.abs(vdNew - vdPrevVal) <= 2 * nVt;
    },

    getPinCurrents(_voltages: Float64Array): number[] {
      // pinLayout order: [A (anode), K (cathode)]
      // Positive = current flowing INTO element at that pin.
      return [_id, -_id];
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
  {
    key: "model",
    type: PropertyType.STRING,
    label: "Model",
    defaultValue: "",
    description: "SPICE model name (blank = use built-in defaults)",
  },
  LABEL_PROPERTY_DEF,
  {
    key: "_spiceModelOverrides",
    type: PropertyType.STRING,
    label: "SPICE Model Overrides",
    defaultValue: "",
    description: "JSON string of user-supplied SPICE parameter overrides",
    hidden: true,
  },
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
  models: {
    mnaModels: {
      behavioral: {
        factory: createZenerElement,
        deviceType: "D",
        defaultParams: ZENER_DEFAULTS,
      },
    },
  },
  defaultModel: "behavioral",
};
