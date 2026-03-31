/**
 * ADC — N-bit Analog-to-Digital Converter.
 *
 * Behavioral SAR (successive-approximation register) or instant-conversion
 * model. On each rising clock edge the ADC samples the analog input voltage
 * and produces an N-bit unsigned binary output code.
 *
 * Pin layout (in pin-declaration order, which determines nodeIds index):
 *   0  VIN   — analog input (DigitalInputPinModel for loading only)
 *   1  CLK   — clock input (DigitalInputPinModel for loading)
 *   2  VREF  — reference voltage input (passive — read directly from MNA)
 *   3  GND   — ground reference (passive — read directly from MNA)
 *   4  EOC   — end-of-conversion output (DigitalOutputPinModel)
 *   5..5+N-1 D0..D(N-1) — digital output bits, LSB first
 *
 * Conversion:
 *   code = clamp(floor((V_in - V_gnd) / (V_ref - V_gnd) × 2^N), 0, 2^N - 1)
 *
 * In 'unipolar' mode: code = floor(V_in / V_ref × 2^N) clamped to [0, 2^N-1]
 *   (V_gnd treated as 0).
 * In 'bipolar' mode: code = floor((V_in + V_ref/2) / V_ref × 2^N) — midscale
 *   offset binary: V_in=0 gives code = 2^(N-1).
 *
 * Clock-edge detection:
 *   Rising edge: prev CLK voltage < vIH, current CLK voltage >= vIH.
 *   Comparison uses threshold vIH = 2.0V (standard CMOS 3.3V logic family).
 *   Edge detection happens in updateState() (once per accepted timestep,
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
import type { AnalogElementCore, IntegrationMethod } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import {
  DigitalInputPinModel,
  DigitalOutputPinModel,
} from "../../solver/analog/digital-pin-model.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: ADC_PARAM_DEFS, defaults: ADC_DEFAULTS } = defineModelParams({
  primary: {
    vRef: { default: 5.0, unit: "V", description: "Full-scale reference voltage" },
  },
});

// ---------------------------------------------------------------------------
// Pin electrical specs
// ---------------------------------------------------------------------------

/** CMOS 3.3V-style electrical spec for input pins (loading only). */
const INPUT_PIN_SPEC: ResolvedPinElectrical = {
  rOut: 50,
  cOut: 5e-12,
  rIn: 1e7,
  cIn: 5e-12,
  vOH: 3.3,
  vOL: 0.0,
  vIH: 2.0,
  vIL: 0.8,
  rHiZ: 1e7,
};

/** CMOS 3.3V-style electrical spec for digital output pins. */
const OUTPUT_PIN_SPEC: ResolvedPinElectrical = {
  rOut: 50,
  cOut: 5e-12,
  rIn: 1e7,
  cIn: 5e-12,
  vOH: 3.3,
  vOL: 0.0,
  vIH: 2.0,
  vIL: 0.8,
  rHiZ: 1e7,
};

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

  // GND — bottom center
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
// ADCElement — CircuitElement implementation
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

    // GND lead (south): pin tip (3, rightCount+1) → body edge (3, rightCount)
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
// createADCElement — AnalogElement factory
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
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const bits = Math.max(1, Math.min(32, props.getOrDefault<number>("bits", 8)));
  const p: Record<string, number> = {
    vRef: props.getModelParam<number>("vRef"),
  };
  const mode = props.getOrDefault<string>("mode", "unipolar") as "unipolar" | "bipolar";
  const conversionType = props.getOrDefault<string>("conversionType", "instant") as
    | "instant"
    | "sar";

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

  // Build pin models
  const vinPin = new DigitalInputPinModel(INPUT_PIN_SPEC, true);
  const clkPin = new DigitalInputPinModel(INPUT_PIN_SPEC, true);
  const eocPin = new DigitalOutputPinModel(OUTPUT_PIN_SPEC);
  const digitalPins: DigitalOutputPinModel[] = nDigital.map(
    () => new DigitalOutputPinModel(OUTPUT_PIN_SPEC),
  );

  // Initialise pin node IDs — init() takes 1-based MNA node IDs
  if (nVin > 0) vinPin.init(nVin, -1);
  if (nClk > 0) clkPin.init(nClk, -1);
  if (nEoc > 0) eocPin.init(nEoc, -1);
  for (let i = 0; i < bits; i++) {
    const n = nDigital[i];
    if (n > 0) digitalPins[i].init(n, -1);
  }

  // Solver cached from stamp() for use in stampCompanion()
  let _solver: SparseSolver | null = null;

  // Clock edge detection state
  const VIH = INPUT_PIN_SPEC.vIH;
  let prevClkVoltage = 0;

  // SAR conversion state: clock cycles remaining until EOC asserts
  let sarCyclesRemaining = 0;
  let eocActive = false;

  // Latched output code
  let latchedCode = 0;

  function readVoltage(voltages: Float64Array, nodeId: number): number {
    return nodeId > 0 ? voltages[nodeId - 1] : 0;
  }

  function setOutputCode(code: number): void {
    latchedCode = code;
    for (let i = 0; i < bits; i++) {
      digitalPins[i].setLogicLevel((code >>> i & 1) === 1);
    }
  }

  function computeCode(voltages: Float64Array): number {
    const vIn = readVoltage(voltages, nVin);
    const vRef = nVref > 0 ? readVoltage(voltages, nVref) : p.vRef;
    const vGnd = readVoltage(voltages, nGnd);

    const span = vRef - vGnd;
    if (span <= 0) return 0;

    let normalised: number;
    if (mode === "bipolar") {
      normalised = (vIn - vGnd + span / 2) / span;
    } else {
      normalised = (vIn - vGnd) / span;
    }

    return Math.min(maxCode, Math.max(0, Math.floor(normalised * (1 << bits))));
  }

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: true,

    stamp(solver: SparseSolver): void {
      // Cache solver for use in stampCompanion (interface does not pass it there)
      _solver = solver;
      // Input loading — VIN and CLK pins
      if (nVin > 0) vinPin.stamp(solver);
      if (nClk > 0) clkPin.stamp(solver);

      // Output Norton equivalents — EOC and data bits
      if (nEoc > 0) eocPin.stampOutput(solver);
      for (let i = 0; i < bits; i++) {
        if (nDigital[i] > 0) digitalPins[i].stampOutput(solver);
      }
    },

    stampNonlinear(solver: SparseSolver): void {
      // Re-stamp output pins with current logic levels (Norton currents)
      if (nEoc > 0) eocPin.stampOutput(solver);
      for (let i = 0; i < bits; i++) {
        if (nDigital[i] > 0) digitalPins[i].stampOutput(solver);
      }
    },

    stampCompanion(dt: number, method: IntegrationMethod, _voltages: Float64Array): void {
      if (_solver === null) return;
      if (nVin > 0) vinPin.stampCompanion(_solver, dt, method);
      if (nClk > 0) clkPin.stampCompanion(_solver, dt, method);
      if (nEoc > 0) eocPin.stampCompanion(_solver, dt, method);
      for (let i = 0; i < bits; i++) {
        if (nDigital[i] > 0) digitalPins[i].stampCompanion(_solver, dt, method);
      }
    },

    updateOperatingPoint(voltages: Float64Array): void {
      // Cache voltages — stampNonlinear reads output pin states which were
      // set during updateCompanion (clock-edge detection). No re-evaluation
      // of the ADC conversion here — that only happens on accepted timesteps.
      void voltages;
    },

    getPinCurrents(voltages: Float64Array): number[] {
      const rIn = INPUT_PIN_SPEC.rIn;
      const rOut = OUTPUT_PIN_SPEC.rOut;

      // VIN: DigitalInputPinModel — loading conductance 1/rIn to ground
      const iVin = nVin > 0 ? readVoltage(voltages, nVin) / rIn : 0;

      // CLK: DigitalInputPinModel — loading conductance 1/rIn to ground
      const iClk = nClk > 0 ? readVoltage(voltages, nClk) / rIn : 0;

      // VREF: passive — no conductance stamped, behavioral approximation → 0
      // GND: passive — no conductance stamped, behavioral approximation → 0

      // EOC: DigitalOutputPinModel — I = (V_eoc - V_target) / rOut
      const vEoc = readVoltage(voltages, nEoc);
      const iEoc = nEoc > 0 ? (vEoc - eocPin.currentVoltage) / rOut : 0;

      // D0..D(N-1): DigitalOutputPinModel — I = (V_d - V_target) / rOut
      const currents: number[] = [iVin, iClk, 0, 0, iEoc];
      for (let i = 0; i < bits; i++) {
        const n = nDigital[i];
        const vD = readVoltage(voltages, n);
        currents.push(n > 0 ? (vD - digitalPins[i].currentVoltage) / rOut : 0);
      }

      // Sum is nonzero — residual is implicit supply current (expected for behavioral model)
      return currents;
    },

    updateState(dt: number, voltages: Float64Array): void {
      const clkVoltage = readVoltage(voltages, nClk);
      const risingEdge = prevClkVoltage < VIH && clkVoltage >= VIH;
      prevClkVoltage = clkVoltage;

      if (risingEdge) {
        if (conversionType === "instant") {
          const code = computeCode(voltages);
          setOutputCode(code);
          eocActive = true;
          eocPin.setLogicLevel(true);
        } else {
          // SAR: start conversion, N cycles to complete
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

      // Update companion model state for accepted timestep
      if (nVin > 0) vinPin.updateCompanion(dt, "trapezoidal", readVoltage(voltages, nVin));
      if (nClk > 0) clkPin.updateCompanion(dt, "trapezoidal", clkVoltage);
      if (nEoc > 0) eocPin.updateCompanion(dt, "trapezoidal", readVoltage(voltages, nEoc));
      for (let i = 0; i < bits; i++) {
        const n = nDigital[i];
        if (n > 0) digitalPins[i].updateCompanion(dt, "trapezoidal", readVoltage(voltages, n));
      }
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
      if (key in p) p[key] = value;
    },
  } as AnalogElementCore & { latchedCode: number; eocActive: boolean };
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
  },
  {
    key: "mode",
    type: PropertyType.STRING,
    label: "Conversion mode",
    defaultValue: "unipolar",
    description:
      "unipolar: input range [0, V_ref]; bipolar: input range [-V_ref/2, +V_ref/2].",
  },
  {
    key: "conversionType",
    type: PropertyType.STRING,
    label: "Conversion type",
    defaultValue: "instant",
    description:
      "instant: output updates on the same clock edge as sampling; " +
      "sar: output updates after N additional clock edges (SAR pipeline).",
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
  { xmlName: "VRef",           propertyKey: "vRef",           convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "mode",           propertyKey: "mode",           convert: (v) => v },
  { xmlName: "conversionType", propertyKey: "conversionType", convert: (v) => v },
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
    "N-bit ADC — analog-to-digital converter. Samples V_in on rising CLK edge " +
    "and produces an N-bit unsigned binary code. EOC pin asserts when conversion completes.",

  factory(props: PropertyBag): ADCElement {
    return new ADCElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props) =>
        createADCElement(pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: ADC_PARAM_DEFS,
      params: ADC_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
