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
import type { AnalogElementCore, LoadContext } from "../../solver/analog/element.js";
import { DigitalOutputPinModel, DigitalInputPinModel } from "../../solver/analog/digital-pin-model.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";
import { defineModelParams } from "../../core/model-params.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: SCHMITT_PARAM_DEFS, defaults: SCHMITT_DEFAULTS } = defineModelParams({
  primary: {
    vTH:  { default: 2.0, unit: "V", description: "Rising input threshold" },
    vTL:  { default: 1.0, unit: "V", description: "Falling input threshold" },
    vOH:  { default: 3.3, unit: "V", description: "Output high voltage" },
    vOL:  { default: 0.0, unit: "V", description: "Output low voltage" },
    rOut: { default: 50,  unit: "Ω", description: "Output impedance" },
  },
});

// ---------------------------------------------------------------------------
// buildPinElectrical — construct ResolvedPinElectrical from component props
// ---------------------------------------------------------------------------

/**
 * Build a ResolvedPinElectrical from the mutable params record.
 *
 * Fields not covered by the Schmitt trigger's own properties use sensible
 * CMOS 3.3V defaults (rIn=10MΩ, cIn=5pF, cOut=5pF, rHiZ=10MΩ).
 */
function buildOutputSpec(p: Record<string, number>): ResolvedPinElectrical {
  return {
    rOut:  Math.max(p.rOut, 1e-9),
    cOut:  5e-12,
    rIn:   1e7,
    cIn:   5e-12,
    vOH:   p.vOH,
    vOL:   p.vOL,
    vIH:   p.vTH,
    vIL:   p.vTL,
    rHiZ:  1e7,
  };
}

function buildInputSpec(p: Record<string, number>): ResolvedPinElectrical {
  return {
    rOut:  50,
    cOut:  5e-12,
    rIn:   1e7,
    cIn:   5e-12,
    vOH:   p.vOH,
    vOL:   p.vOL,
    vIH:   p.vTH,
    vIL:   p.vTL,
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
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
  inverting: boolean,
): AnalogElementCore {
  const p: Record<string, number> = {
    vTH:  props.getModelParam<number>("vTH"),
    vTL:  props.getModelParam<number>("vTL"),
    vOH:  props.getModelParam<number>("vOH"),
    vOL:  props.getModelParam<number>("vOL"),
    rOut: props.getModelParam<number>("rOut"),
  };

  const nIn  = pinNodes.get("in")!;  // input node (1-based, 0=ground)
  const nOut = pinNodes.get("out")!; // output node (1-based, 0=ground)

  const outputSpec = buildOutputSpec(p);
  const inputSpec  = buildInputSpec(p);

  const outModel = new DigitalOutputPinModel(outputSpec);
  const inModel  = new DigitalInputPinModel(inputSpec, true);

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

    load(ctx: LoadContext): void {
      const solver = ctx.solver;
      const voltages = ctx.voltages;
      const vIn = readNode(voltages, nIn);

      // Apply hysteresis state machine
      if (_outputHigh && vIn < p.vTL) {
        _outputHigh = false;
        updateOutputLevel();
      } else if (!_outputHigh && vIn > p.vTH) {
        _outputHigh = true;
        updateOutputLevel();
      }

      // Linear loading: input resistance + output drive (Norton equivalent)
      if (nIn > 0)  inModel.stamp(solver);
      if (nOut > 0) outModel.stampOutput(solver);

      // Transient: companion stamps for input/output capacitances.
      if (ctx.isTransient && ctx.dt > 0) {
        if (nOut > 0) outModel.stampCompanion(solver, ctx.dt, ctx.method);
        if (nIn > 0)  inModel.stampCompanion(solver, ctx.dt, ctx.method);
      }
    },

    accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
      // Post-acceptance companion state update for the pin models.
      if (ctx.dt <= 0) return;
      const voltages = ctx.voltages;
      if (nOut > 0) {
        outModel.updateCompanion(ctx.dt, ctx.method, readNode(voltages, nOut));
      }
      if (nIn > 0) {
        inModel.updateCompanion(ctx.dt, ctx.method, readNode(voltages, nIn));
      }
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // Input pin: conductance 1/rIn from nIn to ground → I_in = V_in / rIn
      const vIn = readNode(voltages, nIn);
      const iIn = nIn > 0 ? vIn / outputSpec.rIn : 0;

      // Output pin: Norton equivalent — I_out = (V_out - V_target) / rOut
      const vOut = readNode(voltages, nOut);
      const targetVoltage = outModel.currentVoltage;
      const iOut = nOut > 0 ? (vOut - targetVoltage) / outputSpec.rOut : 0;

      return [iIn, iOut];
    },

    setParam(key: string, value: number): void {
      if (key in p) p[key] = value;
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
  { xmlName: "vTH",   propertyKey: "vTH",   convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "vTL",   propertyKey: "vTL",   convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "vOH",   propertyKey: "vOH",   convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "vOL",   propertyKey: "vOL",   convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "rOut",  propertyKey: "rOut",  convert: (v) => parseFloat(v), modelParam: true },
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

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props) =>
        createSchmittTriggerElement(pinNodes, internalNodeIds, branchIdx, props, true),
      paramDefs: SCHMITT_PARAM_DEFS,
      params: SCHMITT_DEFAULTS,
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

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props) =>
        createSchmittTriggerElement(pinNodes, internalNodeIds, branchIdx, props, false),
      paramDefs: SCHMITT_PARAM_DEFS,
      params: SCHMITT_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
