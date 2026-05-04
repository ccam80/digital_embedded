/**
 * DAC  N-bit Digital-to-Analog Converter.
 *
 * Converts an N-bit digital input code to an analog output voltage.
 * Digital inputs are read via DigitalInputPinLoaded sub-elements.
 *
 *   V_out = V_ref Â· code / 2^N          (unipolar)
 *   V_out = V_ref Â· (2Â·code/2^N - 1)   (bipolar, symmetric about 0)
 *
 * Pin order (ports):
 *   VREF, OUT, GND, D0..D(N-1)
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

export const { paramDefs: DAC_PARAM_DEFS, defaults: DAC_DEFAULTS } = defineModelParams({
  primary: {
    vIH: { default: 2.0, unit: "V", description: "Input HIGH threshold voltage" },
    vIL: { default: 0.8, unit: "V", description: "Input LOW threshold voltage" },
    rOut: { default: 1, unit: "Î©", description: "Output impedance" },
  },
  secondary: {
    rIn: { default: 1e7, unit: "Î©", description: "Digital input impedance" },
    cIn: { default: 5e-12, unit: "F", description: "Digital input capacitance" },
  },
  instance: {
    // Structural params: must be in paramDefs so the builder promotes them from
    // _map → _mparams, and the compiler's merger delivers them to buildDacNetlist
    // via getModelParam(). Defaults match structural property defaults.
    bits:    { default: 8, description: "Number of digital input bits (structural)" },
    bipolar: { default: 0, description: "0 = unipolar, 1 = bipolar (structural)" },
  },
});

// ---------------------------------------------------------------------------
// Pin declarations  variable N, built at factory time
// ---------------------------------------------------------------------------

/**
 * Build pin declarations for an N-bit DAC.
 *
 * Layout:
 *   D0..D(N-1)  digital inputs on the left side, stacked vertically
 *   VREF        voltage reference input
 *   OUT         analog output (right side)
 *   GND         ground reference
 */
function buildDACPinDeclarations(bits: number): PinDeclaration[] {
  // Layout: D pins on left at y=0..N-1, OUT right-center,
  // VREF top-center, GND bottom-center.
  // Body: (1, -1) to (5, N), width=4, height=N+1.
  const pins: PinDeclaration[] = [];

  // Digital input pins D0..D(N-1) on the left, evenly spaced
  for (let i = 0; i < bits; i++) {
    pins.push({
      kind: "signal",
      direction: PinDirection.INPUT,
      label: `D${i}`,
      defaultBitWidth: 1,
      position: { x: 0, y: i },
      isNegatable: false,
      isClockCapable: false,
    });
  }

  // VREF  top center
  pins.push({
    kind: "signal",
    direction: PinDirection.INPUT,
    label: "VREF",
    defaultBitWidth: 1,
    position: { x: 3, y: -2 },
    isNegatable: false,
    isClockCapable: false,
  });

  // OUT  right side, vertically centered
  pins.push({
    kind: "signal",
    direction: PinDirection.OUTPUT,
    label: "OUT",
    defaultBitWidth: 1,
    position: { x: 6, y: Math.floor((bits - 1) / 2) },
    isNegatable: false,
    isClockCapable: false,
  });

  // GND  bottom center
  pins.push({
    kind: "signal",
    direction: PinDirection.INPUT,
    label: "GND",
    defaultBitWidth: 1,
    position: { x: 3, y: bits + 1 },
    isNegatable: false,
    isClockCapable: false,
  });

  return pins;
}

// ---------------------------------------------------------------------------
// DACElement  CircuitElement implementation
// ---------------------------------------------------------------------------

export class DACElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("DAC", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const bits = this._properties.getOrDefault<number>("bits", 8);
    return this.derivePins(buildDACPinDeclarations(bits), []);
  }

  getBoundingBox(): Rect {
    const bits = this._properties.getOrDefault<number>("bits", 8);
    return {
      x: this.position.x,
      y: this.position.y - 2,
      width: 6,
      height: bits + 3,
    };
  }

  draw(ctx: RenderContext, _signals?: PinVoltageAccess): void {
    const bits = this._properties.getOrDefault<number>("bits", 8);
    const label = this._visibleLabel();
    const outY = Math.floor((bits - 1) / 2);

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Body rectangle: (1, -1) to (5, bits), width=4, height=bits+1
    ctx.drawRect(1, -1, 4, bits + 1, false);

    // Left-side leads: D0..D(N-1) pin tip (0,i)  body edge (1,i)
    for (let i = 0; i < bits; i++) {
      ctx.drawLine(0, i, 1, i);
    }

    // VREF lead (north): pin tip (3,-2)  body edge (3,-1)
    ctx.drawLine(3, -2, 3, -1);

    // OUT lead (east): pin tip (6,outY)  body edge (5,outY)
    ctx.drawLine(6, outY, 5, outY);

    // GND lead (south): pin tip (3,bits+1)  body edge (3,bits)
    ctx.drawLine(3, bits + 1, 3, bits);

    // Label "DAC" centered inside
    ctx.setFont({ family: "sans-serif", size: 0.8 });
    ctx.drawText("DAC", 3, (bits - 1) / 2, { horizontal: "center", vertical: "middle" });

    // Bit count label
    ctx.setFont({ family: "sans-serif", size: 0.6 });
    ctx.drawText(`${bits}-bit`, 3, (bits - 1) / 2 + 0.8, { horizontal: "center", vertical: "middle" });

    // Pin labels
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.55 });
    for (let i = 0; i < bits; i++) {
      ctx.drawText(`D${i}`, 1.15, i, { horizontal: "left", vertical: "middle" });
    }
    ctx.drawText("VREF", 3, -0.5, { horizontal: "center", vertical: "top" });
    ctx.drawText("OUT",  4.85, outY, { horizontal: "right", vertical: "middle" });
    ctx.drawText("GND",  3, bits - 0.5, { horizontal: "center", vertical: "bottom" });

    if (label.length > 0) {
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, 3, -1.5, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// buildDacNetlist  function-form MnaSubcircuitNetlist builder
// ---------------------------------------------------------------------------

export const buildDacNetlist = (params: PropertyBag): MnaSubcircuitNetlist => {
  const N = params.getOrDefault<number>("bits", 8);
  const ports = ["VREF", "OUT", "GND"];
  for (let i = 0; i < N; i++) ports.push(`D${i}`);

  const elements: SubcircuitElement[] = [];
  const netlist: number[][] = [];

  // VREF treated as an analog-driven reference input- DigitalInputPinLoaded
  // for the loading model only (R+C to GND); the actual voltage flows
  // through the loaded R back to whatever drives VREF externally.
  elements.push({ typeId: "DigitalInputPinLoaded", modelRef: "default", subElementName: "vrefPin",
                  params: { rIn: "rIn", cIn: "cIn" } } as SubcircuitElement & { subElementName: string });
  netlist.push([0 /* VREF */, 2 /* GND */]);

  // N digital data input pins
  for (let i = 0; i < N; i++) {
    elements.push({ typeId: "DigitalInputPinLoaded", modelRef: "default", subElementName: `dPin${i}`,
                    params: { rIn: "rIn", cIn: "cIn" } } as SubcircuitElement & { subElementName: string });
    netlist.push([3 + i /* D_i port */, 2 /* GND */]);
  }

  // DAC behavioural driver- branchCount:1, stamps target at OUT via VCVS shape.
  // Pin order: vref, out, gnd, d_0..d_{N-1}.
  const drvPins = [0, 1, 2];
  for (let i = 0; i < N; i++) drvPins.push(3 + i);
  elements.push({ typeId: "DACDriver", modelRef: "default", subElementName: "drv",
                  branchCount: 1,
                  params: { bits: N, bipolar: params.getModelParam<boolean>("bipolar") ? 1 : 0 } });
  netlist.push(drvPins);

  return { ports, elements, internalNetCount: 0, netlist };
};

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const DAC_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bits",
    type: PropertyType.INT,
    label: "Resolution (bits)",
    defaultValue: 8,
    min: 1,
    max: 32,
    description: "Number of digital input bits N. Output has 2^N levels. Default 8.",
    structural: true,
  },
  {
    key: "settlingTime",
    type: PropertyType.INT,
    label: "Settling time (s)",
    defaultValue: 1e-6,
    description: "Settling time to final value after code change. Default 1 Âµs.",
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

const DAC_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits",    propertyKey: "bits",        convert: (v) => parseInt(v, 10) },
  { xmlName: "VIH",     propertyKey: "vIH",         convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "VIL",     propertyKey: "vIL",         convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "ROut",    propertyKey: "rOut",        convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "RIn",     propertyKey: "rIn",         convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "CIn",     propertyKey: "cIn",         convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Label",   propertyKey: "label",       convert: (v) => v },
];

// ---------------------------------------------------------------------------
// DACDefinition
// ---------------------------------------------------------------------------

export const DACDefinition: StandaloneComponentDefinition = {
  name: "DAC",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildDACPinDeclarations(8),
  propertyDefs: DAC_PROPERTY_DEFS,
  attributeMap: DAC_ATTRIBUTE_MAPPINGS,

  helpText:
    "N-bit DAC  converts digital input code to analog output voltage. " +
    "Pins: D0..D(N-1) (digital inputs), VREF, OUT, GND.",

  factory(props: PropertyBag): DACElement {
    return new DACElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    default: { kind: "netlist", netlist: buildDacNetlist, paramDefs: DAC_PARAM_DEFS, params: DAC_DEFAULTS },
  },
  defaultModel: "default",
};
