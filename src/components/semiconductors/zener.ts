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
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  noOpAnalogExecuteFn,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElement } from "../../analog/element.js";
import type { SparseSolver } from "../../analog/sparse-solver.js";
import { pnjlim } from "../../analog/newton-raphson.js";
import { DIODE_DEFAULTS } from "../../analog/model-defaults.js";

// ---------------------------------------------------------------------------
// Physical constants
// ---------------------------------------------------------------------------

/** Thermal voltage at 300 K (kT/q in volts). */
const VT = 0.02585;

/** Minimum conductance for numerical stability (GMIN). */
const GMIN = 1e-12;

// ---------------------------------------------------------------------------
// Stamp helpers — node 0 is ground (skipped)
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
// createZenerElement — AnalogElement factory
// ---------------------------------------------------------------------------

export function createZenerElement(
  nodeIds: number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElement {
  const nodeAnode = nodeIds[0];
  const nodeCathode = nodeIds[1];

  // Resolve model parameters from _modelParams (injected by compiler) or defaults
  const modelParams =
    (props as Record<string, unknown>)["_modelParams"] as Record<string, number> | undefined;
  const mp = modelParams ?? DIODE_DEFAULTS;

  const IS = mp["IS"] ?? DIODE_DEFAULTS["IS"];
  const N = mp["N"] ?? DIODE_DEFAULTS["N"];
  const BV = mp["BV"] ?? DIODE_DEFAULTS["BV"];
  const IBV = mp["IBV"] ?? DIODE_DEFAULTS["IBV"];

  const nVt = N * VT;
  const vcrit = nVt * Math.log(nVt / (IS * Math.SQRT2));

  // NR linearization state
  let vd = 0;
  let geq = GMIN;
  let ieq = 0;

  return {
    nodeIndices: [nodeAnode, nodeCathode],
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
        geq = (IS * expVal) / nVt + GMIN;
        ieq = id - geq * vd;
      } else {
        // Reverse breakdown region: Id = -IBV * exp(-(Vd + BV) / (N*Vt))
        // IBV is the reference current at the breakdown voltage BV.
        const bdExpArg = Math.min(-(vd + BV) / nVt, 700);
        const bdExpVal = Math.exp(bdExpArg);
        const id = -IBV * bdExpVal;
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
    super("AnalogZener", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildZenerPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 0.6,
      width: 4,
      height: 1.2,
    };
  }

  draw(ctx: RenderContext): void {
    const label = this._properties.getOrDefault<string>("label", "");

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Lead lines
    ctx.drawLine(0, 0, 1.5, 0);
    ctx.drawLine(2.5, 0, 4, 0);

    // Triangle body pointing right
    ctx.drawPolygon([
      { x: 1.5, y: -0.5 },
      { x: 1.5, y: 0.5 },
      { x: 2.5, y: 0 },
    ], true);

    // Zener cathode bar with bent ends (Z-shape)
    ctx.drawLine(2.5, -0.5, 2.5, 0.5);
    // Bent ends characteristic of zener symbol
    ctx.drawLine(2.5, -0.5, 2.8, -0.7);
    ctx.drawLine(2.5, 0.5, 2.2, 0.7);

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.7 });
      ctx.drawText(label, 2, -0.85, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "Zener Diode — Shockley diode with reverse breakdown at BV.\n" +
      "Forward: Id = IS * (exp(Vd/(N*Vt)) - 1)\n" +
      "Reverse breakdown (Vd < -BV): Id = -IS * exp(-(Vd+BV)/(N*Vt))"
    );
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
    },
    {
      direction: PinDirection.OUTPUT,
      label: "K",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
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
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown above the component",
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
  name: "AnalogZener",
  typeId: -1,
  engineType: "analog",
  factory: zenerCircuitFactory,
  executeFn: noOpAnalogExecuteFn,
  pinLayout: buildZenerPinDeclarations(),
  propertyDefs: ZENER_PROPERTY_DEFS,
  attributeMap: ZENER_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SEMICONDUCTORS,
  helpText:
    "Zener Diode — Shockley diode with reverse breakdown at BV.\n" +
    "Forward: Id = IS * (exp(Vd/(N*Vt)) - 1)\n" +
    "Reverse breakdown (Vd < -BV): Id = -IS * exp(-(Vd+BV)/(N*Vt))",
  analogDeviceType: "D",
  analogFactory: createZenerElement,
};
