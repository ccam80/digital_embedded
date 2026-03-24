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
import type { PinVoltageAccess } from "../../editor/pin-voltage-access.js";
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
import type { AnalogElement, IntegrationMethod } from "../../analog/element.js";
import type { SparseSolver } from "../../analog/sparse-solver.js";
import { DigitalOutputPinModel, DigitalInputPinModel } from "../../analog/digital-pin-model.js";
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
 * @param nodeIds  - [nIn (1-based), nOut (1-based)]
 * @param props    - Component properties
 * @param inverting - true → inverting (output opposes input sense)
 */
function createSchmittTriggerElement(
  nodeIds: number[],
  props: PropertyBag,
  inverting: boolean,
): AnalogElement {
  const vTH = props.getOrDefault<number>("vTH", 2.0);
  const vTL = props.getOrDefault<number>("vTL", 1.0);
  const vOH = props.getOrDefault<number>("vOH", 3.3);
  const vOL = props.getOrDefault<number>("vOL", 0.0);

  const nIn  = nodeIds[0]; // input node (1-based, 0=ground)
  const nOut = nodeIds[1]; // output node (1-based, 0=ground)

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
    nodeIndices: [nIn, nOut],
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
    },
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
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
    const PX = 1 / 16;
    const dn = 4, ww = 1, hs = 1;
    const lead1x   = 4 * (0.5 - ww / dn);
    const tipX     = 4 * (0.5 + (ww - 5 * PX) / dn);
    const pcircleX = 4 * (0.5 + (ww - 2 * PX) / dn);
    const lead2x   = 4 * (0.5 + (ww + 2 * PX) / dn);
    const bubbleR  = 3 * PX;

    const vIn  = signals?.getPinVoltage("in");
    const vOut = signals?.getPinVoltage("out");

    ctx.save();
    ctx.setLineWidth(1);

    // Input lead
    if (vIn !== undefined && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vIn));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(0, 0, lead1x, 0);

    // Output lead
    if (vOut !== undefined && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vOut));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(lead2x, 0, 4, 0);

    // Body — triangle, bubble, hysteresis symbol stay COMPONENT
    ctx.setColor("COMPONENT");
    ctx.drawPolygon([{ x: lead1x, y: -hs }, { x: tipX, y: 0 }, { x: lead1x, y: hs }], false);
    ctx.drawCircle(pcircleX, 0, bubbleR, false);

    const cx = (lead1x + tipX) / 2;
    const hw = (tipX - lead1x) * 0.4;
    const hh = hs * 0.3;
    ctx.drawLine(cx - hw,  hh, cx - hw, -hh);
    ctx.drawLine(cx - hw, -hh, cx,      -hh);
    ctx.drawLine(cx,      -hh, cx,       hh);
    ctx.drawLine(cx,       hh, cx + hw,  hh);

    ctx.restore();
  }

  getHelpText(): string {
    return "Schmitt Trigger (Inverting) — output goes LOW when input rises above V_TH, " +
      "HIGH when input falls below V_TL. Hysteresis band prevents oscillation on noisy inputs.";
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
    const PX = 1 / 16;
    const dn = 4, ww = 1, hs = 1;
    const lead1x = 4 * (0.5 - ww / dn);
    const tipX   = 4 * (0.5 + (ww - 5 * PX) / dn);
    const lead2x  = 4 * (0.5 + (ww - 3 * PX) / dn);

    const vIn  = signals?.getPinVoltage("in");
    const vOut = signals?.getPinVoltage("out");

    ctx.save();
    ctx.setLineWidth(1);

    // Input lead
    if (vIn !== undefined && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vIn));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(0, 0, lead1x, 0);

    // Output lead
    if (vOut !== undefined && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vOut));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(lead2x, 0, 4, 0);

    // Body — triangle and hysteresis symbol stay COMPONENT
    ctx.setColor("COMPONENT");
    ctx.drawPolygon([{ x: lead1x, y: -hs }, { x: tipX, y: 0 }, { x: lead1x, y: hs }], false);

    const cx = (lead1x + tipX) / 2;
    const hw = (tipX - lead1x) * 0.4;
    const hh = hs * 0.3;
    ctx.drawLine(cx - hw, hh,   cx - hw, -hh);
    ctx.drawLine(cx - hw, -hh,  cx,      -hh);
    ctx.drawLine(cx,      -hh,  cx,       hh);
    ctx.drawLine(cx,       hh,  cx + hw,  hh);

    ctx.restore();
  }

  getHelpText(): string {
    return "Schmitt Trigger (Non-Inverting) — output goes HIGH when input rises above V_TH, " +
      "LOW when input falls below V_TL. Hysteresis band prevents oscillation on noisy inputs.";
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
  engineType: "analog",
  category: ComponentCategory.ACTIVE,
  executeFn: noOpAnalogExecuteFn,

  pinLayout: buildSchmittPinDeclarations(),
  propertyDefs: SCHMITT_PROPERTY_DEFS,
  attributeMap: SCHMITT_ATTRIBUTE_MAPPINGS,

  helpText:
    "Schmitt Trigger (Inverting) — two-terminal analog component with hysteresis. " +
    "V_TH and V_TL define the upper and lower switching thresholds.",

  factory(props: PropertyBag): SchmittInvertingElement {
    return new SchmittInvertingElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  analogFactory(
    nodeIds: number[],
    _branchIdx: number,
    props: PropertyBag,
  ): AnalogElement {
    return createSchmittTriggerElement(nodeIds, props, true);
  },
};

export const SchmittNonInvertingDefinition: ComponentDefinition = {
  name: "SchmittNonInverting",
  typeId: -1,
  engineType: "analog",
  category: ComponentCategory.ACTIVE,
  executeFn: noOpAnalogExecuteFn,

  pinLayout: buildSchmittPinDeclarations(),
  propertyDefs: SCHMITT_PROPERTY_DEFS,
  attributeMap: SCHMITT_ATTRIBUTE_MAPPINGS,

  helpText:
    "Schmitt Trigger (Non-Inverting) — two-terminal analog component with hysteresis. " +
    "Output tracks input sense; V_TH and V_TL define the upper and lower switching thresholds.",

  factory(props: PropertyBag): SchmittNonInvertingElement {
    return new SchmittNonInvertingElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  analogFactory(
    nodeIds: number[],
    _branchIdx: number,
    props: PropertyBag,
  ): AnalogElement {
    return createSchmittTriggerElement(nodeIds, props, false);
  },
};
