/**
 * DAC  N-bit Digital-to-Analog Converter.
 *
 * Converts an N-bit digital input code to an analog output voltage.
 * Digital inputs are read via DigitalInputPinModel threshold detection.
 *
 * Architecture: composite decomposing into 1× VCVS sub-element (output drive)
 * + N× DigitalInputPinModel (D0..D{N-1}) + 1× DigitalInputPinModel (VREF loading).
 * VCVS gain = code / 2^N (unipolar) is updated each load() from decoded inputs.
 *
 *   V_out = V_ref · code / 2^N          (unipolar)
 *   V_out = V_ref · (2·code/2^N - 1)   (bipolar, symmetric about 0)
 *
 * VCVS sub-element pin assignments:
 *   ctrl+ = VREF,  ctrl- = GND,  out+ = OUT,  out- = GND
 * The VCVS gain encodes code/2^N; output voltage = gain * (V_VREF - V_GND).
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
import type { LoadContext } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/element.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { collectPinModelChildren, DigitalInputPinModel } from "../../solver/analog/digital-pin-model.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";
import { defineModelParams } from "../../core/model-params.js";
import { defineStateSchema } from "../../solver/analog/state-schema.js";
import type { StateSchema } from "../../solver/analog/state-schema.js";
import type { AnalogElement } from "../../core/analog-types.js";
import { CompositeElement } from "../../solver/analog/composite-element.js";
import type { AnalogCapacitorElement } from "../passives/capacitor.js";

const DAC_COMPOSITE_SCHEMA: StateSchema = defineStateSchema("DACComposite", []);

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: DAC_PARAM_DEFS, defaults: DAC_DEFAULTS } = defineModelParams({
  primary: {
    vIH: { default: 2.0, unit: "V", description: "Input HIGH threshold voltage" },
    vIL: { default: 0.8, unit: "V", description: "Input LOW threshold voltage" },
    rOut: { default: 100, unit: "Ω", description: "Output impedance" },
  },
  secondary: {
    rIn: { default: 1e7, unit: "Ω", description: "Digital input impedance" },
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
// DACAnalogElement  CompositeElement class
// ---------------------------------------------------------------------------

class DACAnalogElement extends CompositeElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.VCVS;
  readonly stateSchema = DAC_COMPOSITE_SCHEMA;

  private readonly _bits: number;
  private readonly _bipolar: boolean;
  private readonly _p: Record<string, number>;

  private readonly _nVref: number;
  private readonly _nOut: number;
  private readonly _nGnd: number;
  private readonly _nDigitalBits: number[];

  private readonly _inputModels: DigitalInputPinModel[];
  private readonly _vrefModel: DigitalInputPinModel;
  private readonly _childElements: readonly AnalogCapacitorElement[];

  // VCVS branch row and TSTALLOC handles (allocated in setup())
  private _vcvsBranch = -1;
  private _hVCVSPosIbr  = -1;
  private _hVCVSNegIbr  = -1;
  private _hVCVSIbrPos  = -1;
  private _hVCVSIbrNeg  = -1;
  private _hVCVSIbrContPos = -1;
  private _hVCVSIbrContNeg = -1;

  constructor(
    pinNodes: ReadonlyMap<string, number>,
    props: PropertyBag,
    bipolar: boolean,
  ) {
    super();
    this._pinNodes = new Map(pinNodes);

    this._bits = Math.max(1, Math.min(32, props.getOrDefault<number>("bits", 8)));
    this._bipolar = bipolar;
    this._p = {
      vIH:  props.getModelParam<number>("vIH"),
      vIL:  props.getModelParam<number>("vIL"),
      rOut: props.getModelParam<number>("rOut"),
      rIn:  props.getModelParam<number>("rIn"),
      cIn:  props.getModelParam<number>("cIn"),
    };

    this._nVref = pinNodes.get("VREF") ?? 0;
    this._nOut  = pinNodes.get("OUT")  ?? 0;
    this._nGnd  = pinNodes.get("GND")  ?? 0;

    this._nDigitalBits = [];
    for (let i = 0; i < this._bits; i++) {
      this._nDigitalBits.push(pinNodes.get(`D${i}`) ?? 0);
    }

    const inputSpec = buildInputPinSpec(this._p);
    this._inputModels = [];
    for (let i = 0; i < this._bits; i++) {
      const model = new DigitalInputPinModel(inputSpec, true);
      const nD = this._nDigitalBits[i];
      if (nD > 0) {
        model.init(nD, 0);
      }
      this._inputModels.push(model);
    }

    this._vrefModel = new DigitalInputPinModel(inputSpec, true);
    if (this._nVref > 0) this._vrefModel.init(this._nVref, 0);

    this._childElements = collectPinModelChildren([
      ...this._inputModels,
      this._vrefModel,
    ]);
  }

  protected getSubElements(): readonly AnalogElement[] {
    return [
      ...this._inputModels,
      this._vrefModel,
      ...this._childElements,
    ] as unknown as readonly AnalogElement[];
  }

  override setup(ctx: SetupContext): void {
    // Establish _stateBase (DAC_COMPOSITE_SCHEMA has 0 slots; allocStates(0)
    // returns the current offset without advancing, giving children a valid base).
    this._stateBase = ctx.allocStates(0);

    // Allocate VCVS branch row (vcvsset.c:41-44 guard pattern)
    if (this._vcvsBranch === -1) {
      this._vcvsBranch = ctx.makeCur("DAC_vcvs1", "branch");
    }
    this.branchIndex = this._vcvsBranch;

    // VCVS TSTALLOC sequence (vcvsset.c:53-58):
    //   ctrl+(nVref), ctrl-(nGnd), out+(nOut), out-(nGnd)
    if (this._nOut > 0) {
      this._hVCVSPosIbr = ctx.solver.allocElement(this._nOut, this._vcvsBranch);
    }
    if (this._nGnd > 0) {
      this._hVCVSNegIbr = ctx.solver.allocElement(this._nGnd, this._vcvsBranch);
    }
    if (this._nOut > 0) {
      this._hVCVSIbrPos = ctx.solver.allocElement(this._vcvsBranch, this._nOut);
    }
    if (this._nGnd > 0) {
      this._hVCVSIbrNeg = ctx.solver.allocElement(this._vcvsBranch, this._nGnd);
    }
    if (this._nVref > 0) {
      this._hVCVSIbrContPos = ctx.solver.allocElement(this._vcvsBranch, this._nVref);
    }
    if (this._nGnd > 0) {
      this._hVCVSIbrContNeg = ctx.solver.allocElement(this._vcvsBranch, this._nGnd);
    }

    // Forward child setup via base class
    super.setup(ctx);
  }

  override load(ctx: LoadContext): void {
    const voltages = ctx.rhsOld;

    // Decode digital inputs using threshold comparison
    let code = 0;
    for (let i = 0; i < this._bits; i++) {
      const nD = this._nDigitalBits[i];
      if (nD > 0) {
        const vD = voltages[nD];
        if (vD >= this._p.vIH) code |= (1 << i);
      }
    }

    const maxCode = Math.pow(2, this._bits);
    const gain = this._bipolar
      ? (2 * code / maxCode - 1)
      : code / maxCode;

    const solver = ctx.solver;

    // B sub-matrix (incidence: output port KCL rows)
    if (this._hVCVSPosIbr !== -1) solver.stampElement(this._hVCVSPosIbr,  1);
    if (this._hVCVSNegIbr !== -1) solver.stampElement(this._hVCVSNegIbr, -1);

    // C sub-matrix (output branch constraint equation)
    if (this._hVCVSIbrPos !== -1) solver.stampElement(this._hVCVSIbrPos,   1);
    if (this._hVCVSIbrNeg !== -1) solver.stampElement(this._hVCVSIbrNeg,  -1);

    // Control port Jacobian (gain terms)
    if (this._hVCVSIbrContPos !== -1) solver.stampElement(this._hVCVSIbrContPos, -gain);
    if (this._hVCVSIbrContNeg !== -1) solver.stampElement(this._hVCVSIbrContNeg,  gain);

    // Forward child loads via base class
    super.load(ctx);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const currents: number[] = [];

    const rIn = this._p.rIn;
    for (let i = 0; i < this._bits; i++) {
      const v = this._nDigitalBits[i] > 0 ? rhs[this._nDigitalBits[i]] : 0;
      currents.push(this._nDigitalBits[i] > 0 ? v / rIn : 0);
    }

    currents.push(0); // VREF

    // OUT: branch current is at branch row index
    const iOut = this._vcvsBranch > 0 ? rhs[this._vcvsBranch] : 0;
    currents.push(iOut);

    currents.push(0); // GND

    return currents;
  }

  setParam(key: string, value: number): void {
    if (key in this._p) {
      this._p[key] = value;
      if (key === "vIH" || key === "vIL" || key === "rIn" || key === "cIn") {
        for (const m of this._inputModels) m.setParam(key, value);
        this._vrefModel.setParam(key, value);
      }
    }
  }
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
    description: "Settling time to final value after code change. Default 1 µs.",
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
        new DACAnalogElement(pinNodes, props, false),
      paramDefs: DAC_PARAM_DEFS,
      params: DAC_DEFAULTS,
    },
    "bipolar": {
      kind: "inline",
      factory: (pinNodes, props, _getTime) =>
        new DACAnalogElement(pinNodes, props, true),
      paramDefs: DAC_PARAM_DEFS,
      params: DAC_DEFAULTS,
    },
  },
  defaultModel: "unipolar",
};
