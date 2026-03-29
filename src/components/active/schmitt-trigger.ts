/**
 * Schmitt Trigger components — Inverting and Non-Inverting.
 *
 * Output switches between V_OH and V_OL based on input voltage relative to
 * two thresholds: V_TH (upper, triggers on rising input) and V_TL (lower,
 * triggers on falling input). The hysteresis band V_TH - V_TL prevents
 * spurious switching on noisy inputs.
 *
 * Hysteresis state machine:
 *   If _outputHigh && V_in < V_TL  → switch to low
 *   If !_outputHigh && V_in > V_TH → switch to high
 *   Otherwise                       → hold current state
 *
 * Non-inverting: output HIGH when _outputHigh.
 * Inverting:     output HIGH when !_outputHigh (sense is flipped).
 *
 * Output modelled via DigitalOutputPinModel (Norton equivalent with C_out
 * companion). Input modelled via DigitalInputPinModel (loading + C_in
 * companion). Both use a built-in ResolvedPinElectrical derived from
 * component properties.
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
import type { AnalogElement, AnalogElementCore, IntegrationMethod } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { DigitalOutputPinModel, DigitalInputPinModel } from "../../solver/analog/digital-pin-model.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";

// ---------------------------------------------------------------------------
// buildPinElectrical — construct ResolvedPinElectrical from component props
// ---------------------------------------------------------------------------

/**
 * Build a ResolvedPinElectrical from component properties.
 *
 * Fields not covered by the Schmitt trigger's own properties use sensible
 * CMOS 3.3V defaults (rIn=10MΩ, cIn=5pF, cOut=5pF, rHiZ=10MΩ).
 */
function buildOutputSpec(props: PropertyBag): ResolvedPinElectrical {
  return {
    rOut:  Math.max(props.getOrDefault<number>("rOut", 50), 1e-9),
    cOut:  5e-12,
    rIn:   1e7,
    cIn:   5e-12,
    vOH:   props.getOrDefault<number>("vOH", 3.3),
    vOL:   props.getOrDefault<number>("vOL", 0.0),
    vIH:   props.getOrDefault<number>("vTH", 2.0),
    vIL:   props.getOrDefault<number>("vTL", 1.0),
    rHiZ:  1e7,
  };
}

function buildInputSpec(props: PropertyBag): ResolvedPinElectrical {
  return {
    rOut:  50,
    cOut:  5e-12,
    rIn:   1e7,
    cIn:   5e-12,
    vOH:   props.getOrDefault<number>("vOH", 3.3),
    vOL:   props.getOrDefault<number>("vOL", 0.0),
    vIH:   props.getOrDefault<number>("vTH", 2.0),
    vIL:   props.getOrDefault<number>("vTL", 1.0),
    rHiZ:  1e7,
  };
}

// ---------------------------------------------------------------------------
// createSchmittTriggerElement — AnalogElement factory
// ---------------------------------------------------------------------------

/**
 * Create the MNA element for a Schmitt trigger.
 *
 * @param pinNodes  - map of pin label → MNA node ID (1-based)
 * @param props     - Component properties
 * @param inverting - true → inverting (output opposes input sense)
 */
function createSchmittTriggerElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  inverting: boolean,
): AnalogElementCore {
  const vTH = props.getOrDefault<number>("vTH", 2.0);
  const vTL = props.getOrDefault<number>("vTL", 1.0);
  const vOH = props.getOrDefault<number>("vOH", 3.3);
  const vOL = props.getOrDefault<number>("vOL", 0.0);

  const nIn  = pinNodes.get("in")!;  // input node (1-based, 0=ground)
  const nOut = pinNodes.get("out")!; // output node (1-based, 0=ground)

  const outputSpec = buildOutputSpec(props);
  const inputSpec  = buildInputSpec(props);

  const outModel = new DigitalOutputPinModel(outputSpec);
  const inModel  = new DigitalInputPinModel(inputSpec);

  // DigitalOutputPinModel.init / DigitalInputPinModel.init expect 1-based MNA node IDs
  if (nOut > 0) outModel.init(nOut, -1);
  if (nIn  > 0) inModel.init(nIn, 0);

  // Initial state: output low
  let _outputHigh = false;
  outModel.setLogicLevel(inverting ? _outputHigh : _outputHigh);

  function readNode(voltages: Float64Array, n: number): number {
    return n > 0 ? voltages[n - 1] : 0;
  }

  function updateOutputLevel(): void {
    // Non-inverting: output HIGH when _outputHigh
    // Inverting: output HIGH when !_outputHigh
    const driveHigh = inverting ? !_outputHigh : _outputHigh;
    outModel.setLogicLevel(driveHigh);
  }

  // Initialise output model to vOL
  updateOutputLevel();

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: true,

    stamp(solver: SparseSolver): void {
      // Linear loading: input resistance + output drive (Norton equivalent)
      if (nIn > 0)  inModel.stamp(solver);
      if (nOut > 0) outModel.stamp(solver);
    },

    stampNonlinear(solver: SparseSolver): void {
      // Re-stamp the output Norton equivalent with the current target voltage.
      // The output level was already updated in updateOperatingPoint.
      if (nOut > 0) outModel.stamp(solver);
    },

    updateOperatingPoint(voltages: Float64Array): void {
      const vIn = readNode(voltages, nIn);

      // Apply hysteresis state machine
      if (_outputHigh && vIn < vTL) {
        _outputHigh = false;
        updateOutputLevel();
      } else if (!_outputHigh && vIn > vTH) {
        _outputHigh = true;
        updateOutputLevel();
      }
      // Otherwise hold state — hysteresis
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // Input pin: conductance 1/rIn from nIn to ground → I_in = V_in / rIn
      const vIn = readNode(voltages, nIn);
      const iIn = nIn > 0 ? vIn / outputSpec.rIn : 0;

      // Output pin: Norton equivalent — I_out = (V_out - V_target) / rOut
      // Positive = current flowing into element (element is sinking current)
      const vOut = readNode(voltages, nOut);
      const targetVoltage = outModel.currentVoltage;
      const iOut = nOut > 0 ? (vOut - targetVoltage) / outputSpec.rOut : 0;

      // pinLayout order: in, out
      // Sum is nonzero — difference is implicit supply current (expected for behavioral model)
      return [iIn, iOut];
    },

    stampCompanion(
      solver: SparseSolver,
      dt: number,
      method: IntegrationMethod,
      voltages: Float64Array,
    ): void {
      if (nOut > 0) {
        const vOut = readNode(voltages, nOut);
        outModel.stampCompanion(solver, dt, method);
        outModel.updateCompanion(dt, method, vOut);
      }
      if (nIn > 0) {
        const vIn = readNode(voltages, nIn);
        inModel.stampCompanion(solver, dt, method);
        inModel.updateCompanion(dt, method, vIn);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

function buildSchmittPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "in",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// CircuitElement classes
// ---------------------------------------------------------------------------

export class SchmittInvertingElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("SchmittInverting", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildSchmittPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y - 1, width: 4, height: 2 };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    // All coordinates derived from Falstad reference (px / 16 = grid units):
    // Total span 64px = 4gu. Triangle: left x=1, tip x=2.6875, height ±1.
    // Bubble: cx=2.875, r≈0.18375. Lead2 starts at 3.125.
    // Hysteresis symbol (grid units): step from 1.25 to 1.8125 to 1.4375 to 2.0
    const PX = 1 / 16;

    const triLeft  = 1.0;               // 16px
    const triTip   = 43 * PX;           // 2.6875 gu
    const triH     = 1.0;               // ±1 gu
    const bubCx    = 46 * PX;           // 2.875 gu
    const bubR     = 2.94 * PX;         // ~0.18375 gu
    const lead2x   = 50 * PX;           // 3.125 gu

    const vIn  = signals?.getPinVoltage("in");
    const vOut = signals?.getPinVoltage("out");

    ctx.save();
    ctx.setLineWidth(1);

    // Input lead: 0 → triLeft
    drawColoredLead(ctx, signals, vIn, 0, 0, triLeft, 0);

    // Output lead: lead2x → 4
    drawColoredLead(ctx, signals, vOut, lead2x, 0, 4, 0);

    // Body — triangle as open polyline (matching Falstad reference, NOT closed)
    ctx.setColor("COMPONENT");
    // Falstad polyline: (16,-16)→(16,16)→(43,0) — only 2 segments, no closing edge
    ctx.drawLine(triLeft, -triH, triLeft, triH);
    ctx.drawLine(triLeft,  triH, triTip,  0);
    // Bubble (inverter circle) — drawn as arc to match Falstad rasterization
    ctx.drawArc(bubCx, 0, bubR, 0, 2 * Math.PI);

    // Hysteresis symbol — matches Falstad polyline exactly:
    // (20,-3),(29,-3),(29,3),(32,3),(23,3),(23,-3) in px → /16 for gu
    const hx1 = 20 * PX;  // 1.25
    const hx2 = 29 * PX;  // 1.8125
    const hx3 = 32 * PX;  // 2.0
    const hx4 = 23 * PX;  // 1.4375
    const hy  =  3 * PX;  // 0.1875
    ctx.drawLine(hx1, -hy, hx2, -hy);  // top horizontal
    ctx.drawLine(hx2, -hy, hx2,  hy);  // right vertical
    ctx.drawLine(hx2,  hy, hx3,  hy);  // bottom-right horizontal
    ctx.drawLine(hx3,  hy, hx4,  hy);  // bottom connecting segment
    ctx.drawLine(hx4,  hy, hx4, -hy);  // left vertical

    ctx.restore();
  }
}

export class SchmittNonInvertingElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("SchmittNonInverting", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildSchmittPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y - 1, width: 4, height: 2 };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    // All coordinates derived from Falstad reference (px / 16 = grid units):
    // Total span 64px = 4gu. No bubble (non-inverting). Lead2 starts at 45px.
    const PX = 1 / 16;

    const triLeft  = 1.0;               // 16px
    const triTip   = 43 * PX;           // 2.6875 gu
    const triH     = 1.0;               // ±1 gu
    const lead2x   = 45 * PX;           // 2.8125 gu

    const vIn  = signals?.getPinVoltage("in");
    const vOut = signals?.getPinVoltage("out");

    ctx.save();
    ctx.setLineWidth(1);

    // Input lead: 0 → triLeft
    drawColoredLead(ctx, signals, vIn, 0, 0, triLeft, 0);

    // Output lead: lead2x → 4
    drawColoredLead(ctx, signals, vOut, lead2x, 0, 4, 0);

    // Body — triangle as open polyline (matching Falstad reference, NOT closed)
    ctx.setColor("COMPONENT");
    // Falstad polyline: (16,-16)→(16,16)→(43,0) — only 2 segments, no closing edge
    ctx.drawLine(triLeft, -triH, triLeft, triH);
    ctx.drawLine(triLeft,  triH, triTip,  0);

    // Hysteresis symbol — matches Falstad polyline exactly:
    // (20,-3),(29,-3),(29,3),(32,3),(23,3),(23,-3) in px → /16 for gu
    const hx1 = 20 * PX;  // 1.25
    const hx2 = 29 * PX;  // 1.8125
    const hx3 = 32 * PX;  // 2.0
    const hx4 = 23 * PX;  // 1.4375
    const hy  =  3 * PX;  // 0.1875
    ctx.drawLine(hx1, -hy, hx2, -hy);  // top horizontal
    ctx.drawLine(hx2, -hy, hx2,  hy);  // right vertical
    ctx.drawLine(hx2,  hy, hx3,  hy);  // bottom-right horizontal
    ctx.drawLine(hx3,  hy, hx4,  hy);  // bottom connecting segment
    ctx.drawLine(hx4,  hy, hx4, -hy);  // left vertical

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const SCHMITT_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "vTH",
    type: PropertyType.INT,
    label: "Upper threshold V_TH (V)",
    defaultValue: 2.0,
    description: "Rising input threshold. Output switches when V_in rises above this. Default 2.0 V.",
  },
  {
    key: "vTL",
    type: PropertyType.INT,
    label: "Lower threshold V_TL (V)",
    defaultValue: 1.0,
    description: "Falling input threshold. Output switches when V_in falls below this. Default 1.0 V.",
  },
  {
    key: "vOH",
    type: PropertyType.INT,
    label: "Output high voltage V_OH (V)",
    defaultValue: 3.3,
    description: "Output voltage in high state. Default 3.3 V.",
  },
  {
    key: "vOL",
    type: PropertyType.INT,
    label: "Output low voltage V_OL (V)",
    defaultValue: 0.0,
    description: "Output voltage in low state. Default 0 V.",
  },
  {
    key: "rOut",
    type: PropertyType.INT,
    label: "Output impedance (Ω)",
    defaultValue: 50,
    min: 1e-9,
    description: "Output resistance. Default 50 Ω.",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional display label.",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

const SCHMITT_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "vTH",   propertyKey: "vTH",   convert: (v) => parseFloat(v) },
  { xmlName: "vTL",   propertyKey: "vTL",   convert: (v) => parseFloat(v) },
  { xmlName: "vOH",   propertyKey: "vOH",   convert: (v) => parseFloat(v) },
  { xmlName: "vOL",   propertyKey: "vOL",   convert: (v) => parseFloat(v) },
  { xmlName: "rOut",  propertyKey: "rOut",  convert: (v) => parseFloat(v) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// ComponentDefinitions
// ---------------------------------------------------------------------------

export const SchmittInvertingDefinition: ComponentDefinition = {
  name: "SchmittInverting",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildSchmittPinDeclarations(),
  propertyDefs: SCHMITT_PROPERTY_DEFS,
  attributeMap: SCHMITT_ATTRIBUTE_MAPPINGS,

  helpText:
    "Schmitt Trigger (Inverting) — two-terminal analog component with hysteresis. " +
    "V_TH and V_TL define the upper and lower switching thresholds.",

  factory(props: PropertyBag): SchmittInvertingElement {
    return new SchmittInvertingElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {
    mnaModels: {
      behavioral: {
      factory(
        pinNodes: ReadonlyMap<string, number>,
        _internalNodeIds: readonly number[],
        _branchIdx: number,
        props: PropertyBag,
      ): AnalogElementCore {
        return createSchmittTriggerElement(pinNodes, props, true);
      },
    },
    },
  },
  defaultModel: "behavioral",
};

export const SchmittNonInvertingDefinition: ComponentDefinition = {
  name: "SchmittNonInverting",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildSchmittPinDeclarations(),
  propertyDefs: SCHMITT_PROPERTY_DEFS,
  attributeMap: SCHMITT_ATTRIBUTE_MAPPINGS,

  helpText:
    "Schmitt Trigger (Non-Inverting) — two-terminal analog component with hysteresis. " +
    "Output tracks input sense; V_TH and V_TL define the upper and lower switching thresholds.",

  factory(props: PropertyBag): SchmittNonInvertingElement {
    return new SchmittNonInvertingElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {
    mnaModels: {
      behavioral: {
      factory(
        pinNodes: ReadonlyMap<string, number>,
        _internalNodeIds: readonly number[],
        _branchIdx: number,
        props: PropertyBag,
      ): AnalogElementCore {
        return createSchmittTriggerElement(pinNodes, props, false);
      },
    },
    },
  },
  defaultModel: "behavioral",
};
