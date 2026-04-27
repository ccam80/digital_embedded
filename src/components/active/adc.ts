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
 *   code = clamp(floor((V_in - V_gnd) / (V_ref - V_gnd) Ã— 2^N), 0, 2^N - 1)
 *
 * In 'unipolar' mode: code = floor(V_in / V_ref Ã— 2^N) clamped to [0, 2^N-1]
 *   (V_gnd treated as 0).
 * In 'bipolar' mode: code = floor((V_in + V_ref/2) / V_ref Ã— 2^N)  midscale
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
import type { LoadContext, StatePoolRef, PoolBackedAnalogElementCore } from "../../solver/analog/element.js";
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
import type { AnalogCapacitorElement } from "../passives/capacitor.js";

const ADC_COMPOSITE_SCHEMA: StateSchema = defineStateSchema("ADCComposite", []);

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
    rIn:  { default: 1e7,  unit: "Î", description: "Analog input impedance" },
    cIn:  { default: 5e-12, unit: "F", description: "Analog input capacitance" },
    rOut: { default: 50,   unit: "Î", description: "Digital output impedance" },
    rHiZ: { default: 1e7,  unit: "Î", description: "Hi-Z output impedance" },
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
// ADCElement  CircuitElement implementation
// ---------------------------------------------------------------------------

export class ADCElement extends AbstractCircuitElement {
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
// createADCElement  AnalogElement factory
// ---------------------------------------------------------------------------

/**
 * Create the MNA analog element for an N-bit ADC.
 *
 * Pin nodes (from pinLayout order):
 *   pinNodes.get("VIN")  = analog input (DigitalInputPinModel for loading)
 *   pinNodes.get("CLK")  = clock input (DigitalInputPinModel for loading)
 *   pinNodes.get("VREF") = reference voltage (read directly)
 *   pinNodes.get("GND")  = ground reference (read directly)
 *   pinNodes.get("EOC")  = end-of-conversion output (DigitalOutputPinModel)
 *   pinNodes.get("D0").."D(N-1)" = digital output bits, DigitalOutputPinModel
 *
 * Note: node IDs are 1-based; 0 = MNA ground.
 */
function createADCElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  bipolar: boolean,
  sar: boolean,
): PoolBackedAnalogElementCore & { readonly latchedCode: number; readonly eocActive: boolean } {
  const bits = Math.max(1, Math.min(32, props.getOrDefault<number>("bits", 8)));
  const p: Record<string, number> = {
    vIH:  props.getModelParam<number>("vIH"),
    vIL:  props.getModelParam<number>("vIL"),
    vOH:  props.getModelParam<number>("vOH"),
    vOL:  props.getModelParam<number>("vOL"),
    rIn:  props.getModelParam<number>("rIn"),
    cIn:  props.getModelParam<number>("cIn"),
    rOut: props.getModelParam<number>("rOut"),
    rHiZ: props.getModelParam<number>("rHiZ"),
  };

  const maxCode = (1 << bits) - 1;

  const nVin  = pinNodes.get("VIN")  ?? 0;
  const nClk  = pinNodes.get("CLK")  ?? 0;
  const nVref = pinNodes.get("VREF") ?? 0;
  const nGnd  = pinNodes.get("GND")  ?? 0;
  const nEoc  = pinNodes.get("EOC")  ?? 0;

  const nDigital: number[] = [];
  for (let i = 0; i < bits; i++) {
    nDigital.push(pinNodes.get(`D${i}`) ?? 0);
  }

  // Build pin models from current params
  const inputSpec = buildInputPinSpec(p);
  const outputSpec = buildOutputPinSpec(p);
  const vinPin = new DigitalInputPinModel(inputSpec, true);
  const clkPin = new DigitalInputPinModel(inputSpec, true);
  const eocPin = new DigitalOutputPinModel(outputSpec);
  const digitalPins: DigitalOutputPinModel[] = nDigital.map(
    () => new DigitalOutputPinModel(outputSpec),
  );

  // Initialise pin node IDs  init() takes 1-based MNA node IDs
  if (nVin > 0) vinPin.init(nVin, -1);
  if (nClk > 0) clkPin.init(nClk, -1);
  if (nEoc > 0) eocPin.init(nEoc, -1);
  for (let i = 0; i < bits; i++) {
    const n = nDigital[i];
    if (n > 0) digitalPins[i].init(n, -1);
  }

  // Clock edge detection state
  let prevClkVoltage = 0;

  // SAR conversion state: clock cycles remaining until EOC asserts
  let sarCyclesRemaining = 0;
  let eocActive = false;

  // Latched output code
  let latchedCode = 0;

  function readVoltage(rhs: Float64Array, nodeId: number): number {
    return rhs[nodeId];
  }

  function setOutputCode(code: number): void {
    latchedCode = code;
    for (let i = 0; i < bits; i++) {
      digitalPins[i].setLogicLevel((code >>> i & 1) === 1);
    }
  }

  function computeCode(rhs: Float64Array): number {
    const vIn = readVoltage(rhs, nVin);
    const vRef = readVoltage(rhs, nVref);
    const vGnd = readVoltage(rhs, nGnd);

    const span = vRef - vGnd;
    if (span <= 0) return 0;

    let normalised: number;
    if (bipolar) {
      normalised = (vIn - vGnd + span / 2) / span;
    } else {
      normalised = (vIn - vGnd) / span;
    }

    return Math.min(maxCode, Math.max(0, Math.floor(normalised * (1 << bits))));
  }

  const allPins = [vinPin, clkPin, eocPin, ...digitalPins];
  const childElements: readonly AnalogCapacitorElement[] = collectPinModelChildren(allPins);
  const stateSize = childElements.reduce((s, c) => s + c.stateSize, 0);

  return {
    branchIndex: -1,
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VCVS,
    isNonlinear: true,
    get isReactive(): boolean { return childElements.length > 0; },
    _stateBase: -1,
    _pinNodes: new Map(pinNodes),

    setup(_ctx: SetupContext): void {
      throw new Error(`PB-ADC not yet migrated`);
    },

    poolBacked: true as const,
    stateSchema: ADC_COMPOSITE_SCHEMA,
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
      // Input loading  VIN and CLK pins
      if (nVin > 0) vinPin.load(ctx);
      if (nClk > 0) clkPin.load(ctx);

      // Output Norton equivalents  EOC and data bits
      if (nEoc > 0) eocPin.load(ctx);
      for (let i = 0; i < bits; i++) {
        if (nDigital[i] > 0) digitalPins[i].load(ctx);
      }

      for (const child of childElements) { child.load(ctx); }
    },

    accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
      const voltages = ctx.rhs;
      const clkVoltage = readVoltage(voltages, nClk);
      const risingEdge = prevClkVoltage < p.vIH && clkVoltage >= p.vIH;
      prevClkVoltage = clkVoltage;

      if (risingEdge) {
        if (!sar) {
          const code = computeCode(voltages);
          setOutputCode(code);
          eocActive = true;
          eocPin.setLogicLevel(true);
        } else {
          if (sarCyclesRemaining === 0) {
            sarCyclesRemaining = bits;
            eocActive = false;
            eocPin.setLogicLevel(false);
          } else {
            sarCyclesRemaining--;
            if (sarCyclesRemaining === 0) {
              const code = computeCode(voltages);
              setOutputCode(code);
              eocActive = true;
              eocPin.setLogicLevel(true);
            }
          }
        }
      }
    },

    getPinCurrents(rhs: Float64Array): number[] {
      const rIn = p.rIn;
      const rOut = p.rOut;

      const iVin = nVin > 0 ? readVoltage(rhs, nVin) / rIn : 0;
      const iClk = nClk > 0 ? readVoltage(rhs, nClk) / rIn : 0;

      const vEoc = readVoltage(rhs, nEoc);
      const iEoc = nEoc > 0 ? (vEoc - eocPin.currentVoltage) / rOut : 0;

      const currents: number[] = [iVin, iClk, 0, 0, iEoc];
      for (let i = 0; i < bits; i++) {
        const n = nDigital[i];
        const vD = readVoltage(rhs, n);
        currents.push(n > 0 ? (vD - digitalPins[i].currentVoltage) / rOut : 0);
      }

      return currents;
    },

    /** Read back the current latched output code (for testing). */
    get latchedCode(): number {
      return latchedCode;
    },

    /** True when EOC output is asserted. */
    get eocActive(): boolean {
      return eocActive;
    },

    setParam(key: string, value: number): void {
      if (key in p) {
        p[key] = value;
        // Forward input params to input pin models
        if (key === "vIH" || key === "vIL" || key === "rIn" || key === "cIn") {
          vinPin.setParam(key, value);
          clkPin.setParam(key, value);
        }
        // Forward output params to output pin models
        if (key === "vOH" || key === "vOL" || key === "rOut" || key === "rHiZ") {
          eocPin.setParam(key, value);
          for (const dp of digitalPins) dp.setParam(key, value);
        }
      }
    },
  };
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
        createADCElement(pinNodes, props, false, false),
      paramDefs: ADC_PARAM_DEFS,
      params: ADC_DEFAULTS,
    },
    "unipolar-sar": {
      kind: "inline",
      factory: (pinNodes, props, _getTime) =>
        createADCElement(pinNodes, props, false, true),
      paramDefs: ADC_PARAM_DEFS,
      params: ADC_DEFAULTS,
    },
    "bipolar-instant": {
      kind: "inline",
      factory: (pinNodes, props, _getTime) =>
        createADCElement(pinNodes, props, true, false),
      paramDefs: ADC_PARAM_DEFS,
      params: ADC_DEFAULTS,
    },
    "bipolar-sar": {
      kind: "inline",
      factory: (pinNodes, props, _getTime) =>
        createADCElement(pinNodes, props, true, true),
      paramDefs: ADC_PARAM_DEFS,
      params: ADC_DEFAULTS,
    },
  },
  defaultModel: "unipolar-instant",
};
