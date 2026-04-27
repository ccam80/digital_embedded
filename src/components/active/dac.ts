/**
 * DAC  N-bit Digital-to-Analog Converter.
 *
 * Converts an N-bit digital input code to an analog output voltage.
 * Digital inputs are read via DigitalInputPinModel threshold detection.
 * The analog output is modelled as a Norton equivalent (voltage source
 * with output resistance R_out):
 *
 *   V_out = V_ref Â· code / 2^N          (unipolar)
 *   V_out = V_ref Â· (2Â·code/2^N - 1)   (bipolar, symmetric about 0)
 *
 * Output Norton stamp:
 *   G_out = 1/R_out   diagonal at nOut
 *   I_out = V_out Â· G_out  RHS at nOut
 *
 * Pin order (nodeIds):
 *   [D0, D1, ..., D(N-1), VREF, OUT, GND]
 *
 * Indices in nodeIds array:
 *   0 .. N-1     digital input pins D0..D(N-1)
 *   N            VREF
 *   N+1          OUT
 *   N+2          GND
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
  type ComponentDefinition,
} from "../../core/registry.js";
import type { LoadContext, StatePoolRef, PoolBackedAnalogElementCore } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/element.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { stampRHS } from "../../solver/analog/stamp-helpers.js";
import { collectPinModelChildren, DigitalInputPinModel } from "../../solver/analog/digital-pin-model.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";
import { defineModelParams } from "../../core/model-params.js";
import { defineStateSchema } from "../../solver/analog/state-schema.js";
import type { StateSchema } from "../../solver/analog/state-schema.js";
import type { AnalogCapacitorElement } from "../passives/capacitor.js";

const DAC_COMPOSITE_SCHEMA: StateSchema = defineStateSchema("DACComposite", []);

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: DAC_PARAM_DEFS, defaults: DAC_DEFAULTS } = defineModelParams({
  primary: {
    vIH: { default: 2.0, unit: "V", description: "Input HIGH threshold voltage" },
    vIL: { default: 0.8, unit: "V", description: "Input LOW threshold voltage" },
    rOut: { default: 100, unit: "Î", description: "Output impedance" },
  },
  secondary: {
    rIn: { default: 1e7, unit: "Î", description: "Digital input impedance" },
    cIn: { default: 5e-12, unit: "F", description: "Digital input capacitance" },
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
    // (leads drawn as simple lines in COMPONENT color  no voltage coloring for digital inputs)
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
// Default pin electrical spec for digital inputs
// ---------------------------------------------------------------------------

/** Build the input pin spec from model params.
 *  Thresholds (vIH/vIL) and impedances (rIn/cIn) come from model params
 *  so they are hot-loadable. Output-side fields are zeroed  unused by
 *  DigitalInputPinModel.
 */
function buildInputPinSpec(p: Record<string, number>): ResolvedPinElectrical {
  return {
    rOut:  0,
    cOut:  0,
    rIn:   p.rIn,
    cIn:   p.cIn,
    vOH:   0,
    vOL:   0,
    vIH:   p.vIH,
    vIL:   p.vIL,
    rHiZ:  0,
  };
}

// ---------------------------------------------------------------------------
// createDACElement  AnalogElement factory
// ---------------------------------------------------------------------------

/**
 * Create the MNA element for an N-bit DAC.
 *
 * Pin nodes (from pinLayout order):
 *   pinNodes.get("D0").."D(N-1)"  digital input pins
 *   pinNodes.get("VREF")          VREF node (1-based)
 *   pinNodes.get("OUT")           OUT node (1-based)
 *   pinNodes.get("GND")           GND node (may be 0 if tied to MNA ground)
 */
function createDACElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  bipolar: boolean,
): PoolBackedAnalogElementCore {
  const bits   = Math.max(1, Math.min(32, props.getOrDefault<number>("bits", 8)));
  const p: Record<string, number> = {
    vIH:  props.getModelParam<number>("vIH"),
    vIL:  props.getModelParam<number>("vIL"),
    rOut: props.getModelParam<number>("rOut"),
    rIn:  props.getModelParam<number>("rIn"),
    cIn:  props.getModelParam<number>("cIn"),
  };
  const G_out  = 1 / Math.max(p.rOut, 1e-9);

  const maxCode = Math.pow(2, bits);

  // Node IDs from pinNodes map
  const nVref = pinNodes.get("VREF") ?? 0; // VREF node (1-based)
  const nOut  = pinNodes.get("OUT")  ?? 0; // OUT node (1-based)
  // GND node  not directly stamped (MNA ground handled implicitly)

  // DigitalInputPinModel instances  one per bit
  const inputSpec = buildInputPinSpec(p);
  const inputModels: DigitalInputPinModel[] = [];
  // Collect digital bit node IDs in order D0..D(N-1)
  const nDigitalBits: number[] = [];
  for (let i = 0; i < bits; i++) {
    nDigitalBits.push(pinNodes.get(`D${i}`) ?? 0);
  }
  for (let i = 0; i < bits; i++) {
    const model = new DigitalInputPinModel(inputSpec, true);
    const nD = nDigitalBits[i];
    if (nD > 0) {
      model.init(nD, 0);
    }
    inputModels.push(model);
  }

  // Current output voltage (updated each load() pass)
  let _vOut = 0;

  function readNode(rhs: Float64Array, n: number): number {
    return rhs[n];
  }

  function computeOutputVoltage(rhs: Float64Array): number {
    const vRefNow = readNode(rhs, nVref);

    // Build digital code from input pin threshold detection
    let code = 0;
    for (let i = 0; i < bits; i++) {
      const nD = nDigitalBits[i];
      const vD = readNode(rhs, nD);
      const logic = inputModels[i].readLogicLevel(vD);
      // Treat undefined (indeterminate) as LOW for DAC conversion
      const bit = logic === true ? 1 : 0;
      code |= (bit << i);
    }

    if (bipolar) {
      return vRefNow * (2 * code / maxCode - 1);
    } else {
      return vRefNow * code / maxCode;
    }
  }

  const childElements: readonly AnalogCapacitorElement[] = collectPinModelChildren(inputModels);
  const stateSize = childElements.reduce((s, c) => s + c.stateSize, 0);

  return {
    branchIndex: -1,
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VCVS,
    isNonlinear: true,
    get isReactive(): boolean { return childElements.length > 0; },
    _stateBase: -1,
    _pinNodes: new Map(pinNodes),

    setup(_ctx: SetupContext): void {
      throw new Error(`PB-DAC not yet migrated`);
    },

    poolBacked: true as const,
    stateSchema: DAC_COMPOSITE_SCHEMA,
    stateSize,
    stateBaseOffset: -1,
    s0: new Float64Array(0),
    s1: new Float64Array(0),
    s2: new Float64Array(0),
    s3: new Float64Array(0),
    s4: new Float64Array(0),
    s5: new Float64Array(0),
    s6: new Float64Array(0),
    s7: new Float64Array(0),

    initState(_pool: StatePoolRef): void {
      this.s0 = _pool.state0; this.s1 = _pool.state1; this.s2 = _pool.state2; this.s3 = _pool.state3;
      this.s4 = _pool.state4; this.s5 = _pool.state5; this.s6 = _pool.state6; this.s7 = _pool.state7;
      let offset = this.stateBaseOffset;
      for (const child of childElements) {
        child.stateBaseOffset = offset;
        child.initState(_pool);
        offset += child.stateSize;
      }
    },

    load(ctx: LoadContext): void {
      const solver = ctx.solver;
      const voltages = ctx.rhsOld;

      _vOut = computeOutputVoltage(voltages);

      // Stamp G_out from OUT to GND (Norton output resistance)
      if (nOut > 0) {
        solver.stampElement(solver.allocElement(nOut, nOut), G_out);
        // Norton current source: I = V_out Â· G_out injected at OUT node
        stampRHS(ctx.rhs,nOut, _vOut * G_out);
      }
      // Stamp input loading for each digital input pin
      for (let i = 0; i < bits; i++) {
        if (nDigitalBits[i] > 0) {
          inputModels[i].load(ctx);
        }
      }

      for (const child of childElements) { child.load(ctx); }
    },

    accept(_ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {},

    getPinCurrents(rhs: Float64Array): number[] {
      const currents: number[] = [];

      const rIn = p.rIn;
      for (let i = 0; i < bits; i++) {
        const v = readNode(rhs, nDigitalBits[i]);
        currents.push(nDigitalBits[i] > 0 ? v / rIn : 0);
      }

      currents.push(0); // VREF

      const vOut = readNode(rhs, nOut);
      currents.push(nOut > 0 ? (vOut - _vOut) * G_out : 0);

      currents.push(0); // GND

      return currents;
    },

    setParam(key: string, value: number): void {
      if (key in p) {
        p[key] = value;
        // Forward input threshold/impedance changes to all pin models
        if (key === "vIH" || key === "vIL" || key === "rIn" || key === "cIn") {
          for (const m of inputModels) m.setParam(key, value);
        }
      }
    },
  };
}

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

export const DACDefinition: ComponentDefinition = {
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
    "unipolar": {
      kind: "inline",
      factory: (pinNodes, props, _getTime) =>
        createDACElement(pinNodes, props, false),
      paramDefs: DAC_PARAM_DEFS,
      params: DAC_DEFAULTS,
    },
    "bipolar": {
      kind: "inline",
      factory: (pinNodes, props, _getTime) =>
        createDACElement(pinNodes, props, true),
      paramDefs: DAC_PARAM_DEFS,
      params: DAC_DEFAULTS,
    },
  },
  defaultModel: "unipolar",
};
