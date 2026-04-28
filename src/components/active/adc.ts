/**
 * ADC  N-bit Analog-to-Digital Converter.
 *
 * Behavioral SAR (successive-approximation register) or instant-conversion
 * model. On each rising clock edge the ADC samples the analog input voltage
 * and produces an N-bit unsigned binary output code.
 *
 * Pin layout (in pin-declaration order, which determines nodeIds index):
 *   0  VIN    analog input (DigitalInputPinModel for loading only)
 *   1  CLK    clock input (DigitalInputPinModel for loading)
 *   2  VREF   reference voltage input (passive  read directly from MNA)
 *   3  GND    ground reference (passive  read directly from MNA)
 *   4  EOC    end-of-conversion output (DigitalOutputPinModel)
 *   5..5+N-1 D0..D(N-1)  digital output bits, LSB first
 *
 * Conversion:
 *   code = clamp(floor((V_in - V_gnd) / (V_ref - V_gnd) × 2^N), 0, 2^N - 1)
 *
 * In 'unipolar' mode: code = floor(V_in / V_ref × 2^N) clamped to [0, 2^N-1]
 *   (V_gnd treated as 0).
 * In 'bipolar' mode: code = floor((V_in + V_ref/2) / V_ref × 2^N)  midscale
 *   offset binary: V_in=0 gives code = 2^(N-1).
 *
 * Clock-edge detection:
 *   Rising edge: prev CLK voltage < vIH, current CLK voltage >= vIH.
 *   Comparison uses threshold vIH = 2.0V (standard CMOS 3.3V logic family).
 *   Edge detection happens in accept() (once per accepted timestep,
 *   never mid-NR), guaranteeing output only latches on real clock edges.
 *
 * EOC:
 *   EOC goes HIGH immediately after conversion completes.
 *   In 'instant' mode: EOC pulses HIGH on the same timestep as conversion.
 *   In 'sar' mode: EOC pulses HIGH N clock cycles after conversion starts.
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
import { defineModelParams } from "../../core/model-params.js";
import type { LoadContext } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/element.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import {
  collectPinModelChildren,
  DigitalInputPinModel,
  DigitalOutputPinModel,
} from "../../solver/analog/digital-pin-model.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";
import { defineStateSchema } from "../../solver/analog/state-schema.js";
import type { StateSchema } from "../../solver/analog/state-schema.js";
import type { AnalogElement, PoolBackedAnalogElement, StatePoolRef } from "../../core/analog-types.js";
import { CompositeElement } from "../../solver/analog/composite-element.js";
import type { AnalogCapacitorElement } from "../passives/capacitor.js";

const ADC_COMPOSITE_SCHEMA: StateSchema = defineStateSchema("ADCComposite", [
  { name: "PREV_CLK",    doc: "Previous clock voltage for rising-edge detection", init: { kind: "zero" } },
  { name: "OUTPUT_CODE", doc: "Last conversion code as Float64",                  init: { kind: "zero" } },
]);

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
    rIn:  { default: 1e7,  unit: "Ω", description: "Analog input impedance" },
    cIn:  { default: 5e-12, unit: "F", description: "Analog input capacitance" },
    rOut: { default: 50,   unit: "Ω", description: "Digital output impedance" },
    rHiZ: { default: 1e7,  unit: "Ω", description: "Hi-Z output impedance" },
  },
});

// ---------------------------------------------------------------------------
// Pin electrical specs
// ---------------------------------------------------------------------------

/** Build input pin spec from model params. Output-side fields zeroed (unused). */
function buildInputPinSpec(p: Record<string, number>): ResolvedPinElectrical {
  return {
    rOut: 0, cOut: 0,
    rIn: p.rIn, cIn: p.cIn,
    vOH: 0, vOL: 0,
    vIH: p.vIH, vIL: p.vIL,
    rHiZ: 0,
  };
}

/** Build output pin spec from model params. Input-side fields zeroed (unused). */
function buildOutputPinSpec(p: Record<string, number>): ResolvedPinElectrical {
  return {
    rOut: p.rOut, cOut: 0,
    rIn: 0, cIn: 0,
    vOH: p.vOH, vOL: p.vOL,
    vIH: 0, vIL: 0,
    rHiZ: p.rHiZ,
  };
}

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
// ADCAnalogElement  CompositeElement (analog element, exported for test inspection)
// ---------------------------------------------------------------------------

/**
 * The analog simulation element for the ADC. Exported as `ADCAnalogElement` so that
 * tests can inspect observable state (`latchedCode`, `eocActive`, `accept`).
 * The circuit-element (AbstractCircuitElement) subclass is `ADCElement`.
 */
export class ADCAnalogElement extends CompositeElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.VCVS;
  readonly stateSchema = ADC_COMPOSITE_SCHEMA;

  private readonly _bits: number;
  private readonly _bipolar: boolean;
  private readonly _sar: boolean;
  private readonly _p: Record<string, number>;

  private readonly _nVin: number;
  private readonly _nClk: number;
  private readonly _nVref: number;
  private readonly _nGnd: number;
  private readonly _nEoc: number;
  private readonly _nDigital: number[];

  private readonly _vinPin: DigitalInputPinModel;
  private readonly _clkPin: DigitalInputPinModel;
  private readonly _eocPin: DigitalOutputPinModel;
  private readonly _digitalPins: DigitalOutputPinModel[];
  private readonly _childElements: readonly AnalogCapacitorElement[];

  private _latchedCode: number = 0;
  private _eocActive: boolean = false;
  private _prevClkVoltage: number = 0;
  private _sarCyclesRemaining: number = 0;

  get latchedCode(): number { return this._latchedCode; }
  get eocActive(): boolean { return this._eocActive; }

  constructor(
    pinNodes: ReadonlyMap<string, number>,
    props: PropertyBag,
    bipolar: boolean,
    sar: boolean,
  ) {
    super();
    this._pinNodes = new Map(pinNodes);

    this._bits = Math.max(1, Math.min(32, props.getOrDefault<number>("bits", 8)));
    this._bipolar = bipolar;
    this._sar = sar;
    this._p = {
      vIH:  props.getModelParam<number>("vIH"),
      vIL:  props.getModelParam<number>("vIL"),
      vOH:  props.getModelParam<number>("vOH"),
      vOL:  props.getModelParam<number>("vOL"),
      rIn:  props.getModelParam<number>("rIn"),
      cIn:  props.getModelParam<number>("cIn"),
      rOut: props.getModelParam<number>("rOut"),
      rHiZ: props.getModelParam<number>("rHiZ"),
    };

    this._nVin  = pinNodes.get("VIN")  ?? 0;
    this._nClk  = pinNodes.get("CLK")  ?? 0;
    this._nVref = pinNodes.get("VREF") ?? 0;
    this._nGnd  = pinNodes.get("GND")  ?? 0;
    this._nEoc  = pinNodes.get("EOC")  ?? 0;

    this._nDigital = [];
    for (let i = 0; i < this._bits; i++) {
      this._nDigital.push(pinNodes.get(`D${i}`) ?? 0);
    }

    const inputSpec = buildInputPinSpec(this._p);
    const outputSpec = buildOutputPinSpec(this._p);
    this._vinPin = new DigitalInputPinModel(inputSpec, true);
    this._clkPin = new DigitalInputPinModel(inputSpec, true);
    this._eocPin = new DigitalOutputPinModel(outputSpec);
    this._digitalPins = this._nDigital.map(() => new DigitalOutputPinModel(outputSpec));

    if (this._nVin > 0) this._vinPin.init(this._nVin, -1);
    if (this._nClk > 0) this._clkPin.init(this._nClk, -1);
    if (this._nEoc > 0) this._eocPin.init(this._nEoc, -1);
    for (let i = 0; i < this._bits; i++) {
      const n = this._nDigital[i];
      if (n > 0) this._digitalPins[i].init(n, -1);
    }

    this._childElements = collectPinModelChildren([
      this._vinPin, this._clkPin, this._eocPin, ...this._digitalPins,
    ]);
  }

  protected getSubElements(): readonly AnalogElement[] {
    return [
      this._vinPin,
      this._clkPin,
      this._eocPin,
      ...this._digitalPins,
      ...this._childElements,
    ] as unknown as readonly AnalogElement[];
  }

  override setup(ctx: SetupContext): void {
    // Composite-level state: PREV_CLK (slot 0) + OUTPUT_CODE (slot 1).
    // Allocate before forwarding so children's allocStates() calls follow.
    this._stateBase = ctx.allocStates(2);
    super.setup(ctx);
  }

  accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
    const voltages = ctx.rhs;
    const clkVoltage = voltages[this._nClk];
    const risingEdge = this._prevClkVoltage < this._p.vIH && clkVoltage >= this._p.vIH;
    this._prevClkVoltage = clkVoltage;

    if (risingEdge) {
      if (!this._sar) {
        const code = this._computeCode(voltages);
        this._setOutputCode(code);
        this._eocActive = true;
        this._eocPin.setLogicLevel(true);
      } else {
        if (this._sarCyclesRemaining === 0) {
          this._sarCyclesRemaining = this._bits;
          this._eocActive = false;
          this._eocPin.setLogicLevel(false);
        } else {
          this._sarCyclesRemaining--;
          if (this._sarCyclesRemaining === 0) {
            const code = this._computeCode(voltages);
            this._setOutputCode(code);
            this._eocActive = true;
            this._eocPin.setLogicLevel(true);
          }
        }
      }
    }
  }

  override initState(pool: StatePoolRef): void {
    // Composite-level slots (PREV_CLK, OUTPUT_CODE) are at this._stateBase + 0/1.
    // Pool-backed children (capacitor companions) follow immediately after.
    let cumulative = this._stateBase + 2;
    for (const c of this.getSubElements()) {
      const pb = c as Partial<PoolBackedAnalogElement> & { _stateBase?: number };
      if (pb.poolBacked && typeof pb.initState === "function") {
        pb._stateBase = cumulative;
        pb.initState(pool);
        cumulative += pb.stateSize ?? 0;
      }
    }
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const rIn = this._p.rIn;
    const rOut = this._p.rOut;

    const iVin = this._nVin > 0 ? rhs[this._nVin] / rIn : 0;
    const iClk = this._nClk > 0 ? rhs[this._nClk] / rIn : 0;

    const vEoc = rhs[this._nEoc];
    const iEoc = this._nEoc > 0 ? (vEoc - this._eocPin.currentVoltage) / rOut : 0;

    const currents: number[] = [iVin, iClk, 0, 0, iEoc];
    for (let i = 0; i < this._bits; i++) {
      const n = this._nDigital[i];
      const vD = rhs[n];
      currents.push(n > 0 ? (vD - this._digitalPins[i].currentVoltage) / rOut : 0);
    }

    return currents;
  }

  setParam(key: string, value: number): void {
    if (key in this._p) {
      this._p[key] = value;
      if (key === "vIH" || key === "vIL" || key === "rIn" || key === "cIn") {
        this._vinPin.setParam(key, value);
        this._clkPin.setParam(key, value);
      }
      if (key === "vOH" || key === "vOL" || key === "rOut" || key === "rHiZ") {
        this._eocPin.setParam(key, value);
        for (const dp of this._digitalPins) dp.setParam(key, value);
      }
    }
  }

  private _computeCode(rhs: Float64Array): number {
    const vIn  = rhs[this._nVin];
    const vRef = rhs[this._nVref];
    const vGnd = rhs[this._nGnd];
    const maxCode = (1 << this._bits) - 1;

    const span = vRef - vGnd;
    if (span <= 0) return 0;

    let normalised: number;
    if (this._bipolar) {
      normalised = (vIn - vGnd + span / 2) / span;
    } else {
      normalised = (vIn - vGnd) / span;
    }

    return Math.min(maxCode, Math.max(0, Math.floor(normalised * (1 << this._bits))));
  }

  private _setOutputCode(code: number): void {
    this._latchedCode = code;
    for (let i = 0; i < this._bits; i++) {
      this._digitalPins[i].setLogicLevel((code >>> i & 1) === 1);
    }
  }
}

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

export const ADCDefinition: ComponentDefinition = {
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
    "unipolar-instant": {
      kind: "inline",
      factory: (pinNodes, props, _getTime) =>
        new ADCAnalogElement(pinNodes, props, false, false),
      paramDefs: ADC_PARAM_DEFS,
      params: ADC_DEFAULTS,
    },
    "unipolar-sar": {
      kind: "inline",
      factory: (pinNodes, props, _getTime) =>
        new ADCAnalogElement(pinNodes, props, false, true),
      paramDefs: ADC_PARAM_DEFS,
      params: ADC_DEFAULTS,
    },
    "bipolar-instant": {
      kind: "inline",
      factory: (pinNodes, props, _getTime) =>
        new ADCAnalogElement(pinNodes, props, true, false),
      paramDefs: ADC_PARAM_DEFS,
      params: ADC_DEFAULTS,
    },
    "bipolar-sar": {
      kind: "inline",
      factory: (pinNodes, props, _getTime) =>
        new ADCAnalogElement(pinNodes, props, true, true),
      paramDefs: ADC_PARAM_DEFS,
      params: ADC_DEFAULTS,
    },
  },
  defaultModel: "unipolar-instant",
};
