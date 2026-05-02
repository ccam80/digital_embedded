/**
 * ADC  N-bit Analog-to-Digital Converter.
 *
 * Behavioral SAR (successive-approximation register) or instant-conversion
 * model. On each rising clock edge the ADC samples the analog input voltage
 * and produces an N-bit unsigned binary output code.
 *
 * Pin layout (ports):
 *   VIN    analog input
 *   CLK    clock input
 *   VREF   reference voltage input
 *   GND    ground reference
 *   EOC    end-of-conversion output
 *   D0..D(N-1)  digital output bits, LSB first
 *
 * Conversion:
 *   code = clamp(floor((V_in - V_gnd) / (V_ref - V_gnd) Ã— 2^N), 0, 2^N - 1)
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type StandaloneComponentDefinition,
} from "../../core/registry.js";
import { defineModelParams } from "../../core/model-params.js";
import type { MnaSubcircuitNetlist, SubcircuitElement } from "../../core/mna-subcircuit-netlist.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: ADC_PARAM_DEFS, defaults: ADC_DEFAULTS } = defineModelParams({
  primary: {
    vIH: { default: 2.0, unit: "V", description: "Input HIGH threshold voltage (CLK edge detection)" },
    vIL: { default: 0.8, unit: "V", description: "Input LOW threshold voltage" },
    vOH: { default: 3.3, unit: "V", description: "Digital output HIGH voltage" },
    vOL: { default: 0.0, unit: "V", description: "Digital output LOW voltage" },
  },
  secondary: {
    rIn:  { default: 1e7,  unit: "Î©", description: "Analog input impedance" },
    cIn:  { default: 5e-12, unit: "F", description: "Analog input capacitance" },
    rOut: { default: 50,   unit: "Î©", description: "Digital output impedance" },
    rHiZ: { default: 1e7,  unit: "Î©", description: "Hi-Z output impedance" },
  },
});

// ---------------------------------------------------------------------------
// buildADCPinDeclarations
// ---------------------------------------------------------------------------

function buildADCPinDeclarations(bits: number): PinDeclaration[] {
  // Layout: right side has EOC + D0..D(N-1) at y=0..N (N+1 pins).
  // Left side has VIN, CLK, VREF centered vertically against right side.
  // GND at bottom center. Body: (1,-1) to (5, N+1), width=4.
  const rightCount = bits + 1; // EOC + D0..D(N-1)
  const mid = Math.floor((rightCount - 1) / 2);

  const pins: PinDeclaration[] = [
    {
      direction: PinDirection.INPUT,
      label: "VIN",
      defaultBitWidth: 1,
      position: { x: 0, y: mid - 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "CLK",
      defaultBitWidth: 1,
      position: { x: 0, y: mid },
      isNegatable: false,
      isClockCapable: true,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "VREF",
      defaultBitWidth: 1,
      position: { x: 0, y: mid + 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "EOC",
      defaultBitWidth: 1,
      position: { x: 6, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];

  for (let i = 0; i < bits; i++) {
    pins.push({
      direction: PinDirection.OUTPUT,
      label: `D${i}`,
      defaultBitWidth: 1,
      position: { x: 6, y: i + 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    });
  }

  // GND  bottom center
  pins.push({
    direction: PinDirection.INPUT,
    label: "GND",
    defaultBitWidth: 1,
    position: { x: 3, y: rightCount + 1 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  });

  return pins;
}

// ---------------------------------------------------------------------------
// buildAdcNetlist  function-form MnaSubcircuitNetlist builder
// ---------------------------------------------------------------------------

/**
 * Function-form netlist builder for the ADC.
 *
 * Port order: VIN(0), CLK(1), VREF(2), GND(3), EOC(4), D0(5)..D(N-1)(4+N).
 *
 * Sub-elements:
 *   drv      - ADCDriver (driver leaf: reads VIN/CLK/VREF/GND, writes N+1 output slots)
 *   eocPin   - DigitalOutputPinLoaded for EOC
 *   dPin0..N - DigitalOutputPinLoaded for D0..D(N-1)
 */
export const buildAdcNetlist = (params: PropertyBag): MnaSubcircuitNetlist => {
  const N = params.getModelParam<number>("bits");

  // Port order: VIN, CLK, VREF, GND, EOC, D0..D(N-1)
  const ports = ["VIN", "CLK", "VREF", "GND", "EOC"];
  for (let i = 0; i < N; i++) ports.push(`D${i}`);

  const elements: SubcircuitElement[] = [];
  const netlist: number[][] = [];

  // ADCDriver reads VIN(0), CLK(1), VREF(2), GND(3) and drives EOC + D0..D(N-1).
  // Pin order for driver: VIN, CLK, VREF, GND, EOC, D0..D(N-1).
  const drvPins = [0, 1, 2, 3, 4];
  for (let i = 0; i < N; i++) drvPins.push(5 + i);
  elements.push({
    typeId: "ADCDriver",
    modelRef: "default",
    subElementName: "drv",
    params: {
      bits: N,
      bipolar: params.getModelParam<boolean>("bipolar") ? 1 : 0,
      sar: params.getModelParam<boolean>("sar") ? 1 : 0,
      vIH: params.getModelParam<number>("vIH"),
      vIL: params.getModelParam<number>("vIL"),
    },
  });
  netlist.push(drvPins);

  // EOC digital output pin (port index 4, gnd = port index 3)
  elements.push({
    typeId: "DigitalOutputPinLoaded",
    modelRef: "default",
    subElementName: "eocPin",
    params: {
      rOut: "rOut",
      rHiZ: "rHiZ",
      vOH: "vOH",
      vOL: "vOL",
      inputLogic: { kind: "siblingState", subElementName: "drv", slotName: "OUTPUT_EOC" },
    },
  } as SubcircuitElement & { subElementName: string });
  netlist.push([4 /* EOC */, 3 /* GND */]);

  // D0..D(N-1) digital output pins
  for (let i = 0; i < N; i++) {
    elements.push({
      typeId: "DigitalOutputPinLoaded",
      modelRef: "default",
      subElementName: `dPin${i}`,
      params: {
        rOut: "rOut",
        rHiZ: "rHiZ",
        vOH: "vOH",
        vOL: "vOL",
        inputLogic: { kind: "siblingState", subElementName: "drv", slotName: `OUTPUT_D${i}` },
      },
    } as SubcircuitElement & { subElementName: string });
    netlist.push([5 + i /* D_i */, 3 /* GND */]);
  }

  return { ports, elements, internalNetCount: 0, netlist };
};

// ---------------------------------------------------------------------------
// ADCElement  CircuitElement implementation
// ---------------------------------------------------------------------------

class ADCElement extends AbstractCircuitElement {
  private readonly _bits: number;

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("ADC", instanceId, position, rotation, mirror, props);
    this._bits = Math.max(1, Math.min(32, props.getOrDefault<number>("bits", 8)));
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildADCPinDeclarations(this._bits), []);
  }

  getBoundingBox(): Rect {
    const rightCount = this._bits + 1; // EOC + D0..D(N-1)
    return {
      x: this.position.x,
      y: this.position.y - 1,
      width: 6,
      height: rightCount + 2,
    };
  }

  draw(ctx: RenderContext, _signals?: PinVoltageAccess): void {
    const label = this._visibleLabel();
    const bits = this._bits;
    const rightCount = bits + 1; // EOC + D0..D(N-1)
    const mid = Math.floor((rightCount - 1) / 2);

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Body rectangle: (1, -1) to (5, rightCount), width=4
    ctx.drawRect(1, -1, 4, rightCount + 1, false);

    // Left-side leads: VIN, CLK, VREF centered at mid-1, mid, mid+1
    ctx.drawLine(0, mid - 1, 1, mid - 1);
    ctx.drawLine(0, mid, 1, mid);
    ctx.drawLine(0, mid + 1, 1, mid + 1);

    // Right-side leads: EOC at y=0, D0..D(N-1) at y=1..N
    for (let i = 0; i < rightCount; i++) {
      ctx.drawLine(5, i, 6, i);
    }

    // GND lead (south): pin tip (3, rightCount+1)  body edge (3, rightCount)
    ctx.drawLine(3, rightCount + 1, 3, rightCount);

    // Component name centered
    ctx.setFont({ family: "sans-serif", size: 0.8 });
    ctx.drawText("ADC", 3, (rightCount - 1) / 2, { horizontal: "center", vertical: "middle" });

    // Pin labels
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.55 });
    ctx.drawText("VIN",  1.15, mid - 1, { horizontal: "left", vertical: "middle" });
    ctx.drawText("CLK",  1.15, mid, { horizontal: "left", vertical: "middle" });
    ctx.drawText("VREF", 1.15, mid + 1, { horizontal: "left", vertical: "middle" });
    ctx.drawText("EOC",  4.85, 0, { horizontal: "right", vertical: "middle" });
    for (let i = 0; i < bits; i++) {
      ctx.drawText(`D${i}`, 4.85, i + 1, { horizontal: "right", vertical: "middle" });
    }
    ctx.drawText("GND", 3, rightCount - 0.5, { horizontal: "center", vertical: "bottom" });

    if (label.length > 0) {
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, 3, -1.5, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const ADC_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bits",
    type: PropertyType.INT,
    label: "Resolution (bits)",
    defaultValue: 8,
    min: 1,
    max: 32,
    description: "Number of output bits N. Output codes span [0, 2^N - 1].",
    structural: true,
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

const ADC_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits",           propertyKey: "bits",           convert: (v) => parseInt(v, 10) },
  { xmlName: "VIH",            propertyKey: "vIH",            convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "VIL",            propertyKey: "vIL",            convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "VOH",            propertyKey: "vOH",            convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "VOL",            propertyKey: "vOL",            convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "RIn",            propertyKey: "rIn",            convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "CIn",            propertyKey: "cIn",            convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "ROut",           propertyKey: "rOut",           convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "RHiZ",           propertyKey: "rHiZ",           convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Label",          propertyKey: "label",          convert: (v) => v },
];

// ---------------------------------------------------------------------------
// ADCDefinition
// ---------------------------------------------------------------------------

export const ADCDefinition: StandaloneComponentDefinition = {
  name: "ADC",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildADCPinDeclarations(8),
  propertyDefs: ADC_PROPERTY_DEFS,
  attributeMap: ADC_ATTRIBUTE_MAPPINGS,

  helpText:
    "N-bit ADC  analog-to-digital converter. Samples V_in on rising CLK edge " +
    "and produces an N-bit unsigned binary code. EOC pin asserts when conversion completes.",

  factory(props: PropertyBag): ADCElement {
    return new ADCElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    default: { kind: "netlist", netlist: buildAdcNetlist, paramDefs: ADC_PARAM_DEFS, params: ADC_DEFAULTS },
  },
  defaultModel: "default",
};
