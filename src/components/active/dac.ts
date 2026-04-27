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

  const maxCode = Math.pow(2, bits);

  // Node IDs from pinNodes map
  const nVref = pinNodes.get("VREF") ?? 0;
  const nOut  = pinNodes.get("OUT")  ?? 0;
  const nGnd  = pinNodes.get("GND")  ?? 0;

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

  // VREF loading pin model
  const vrefModel = new DigitalInputPinModel(inputSpec, true);
  if (nVref > 0) vrefModel.init(nVref, 0);

  // VCVS sub-element cached handles (vcvsset.c:53-58):
  //   ctrl+(nVref), ctrl-(nGnd), out+(nOut), out-(nGnd)
  //   branch row allocated by setup() via ctx.makeCur
  let _vcvsBranch = -1;
  let _hVCVSPosIbr  = -1;  // (nOut,   branch) — VCVSposIbrptr
  let _hVCVSNegIbr  = -1;  // (nGnd,   branch) — VCVSnegIbrptr  (skip if nGnd=0)
  let _hVCVSIbrPos  = -1;  // (branch, nOut)   — VCVSibrPosptr
  let _hVCVSIbrNeg  = -1;  // (branch, nGnd)   — VCVSibrNegptr  (skip if nGnd=0)
  let _hVCVSIbrContPos = -1; // (branch, nVref) — VCVSibrContPosptr
  let _hVCVSIbrContNeg = -1; // (branch, nGnd)  — VCVSibrContNegptr  (skip if nGnd=0)

  const childElements: readonly AnalogCapacitorElement[] = collectPinModelChildren([
    ...inputModels,
    vrefModel,
  ]);
  const stateSize = childElements.reduce((s, c) => s + c.stateSize, 0);

  return {
    branchIndex: -1,
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VCVS,
    isNonlinear: true,
    get isReactive(): boolean { return childElements.length > 0; },
    _stateBase: -1,
    _pinNodes: new Map(pinNodes),

    setup(ctx: SetupContext): void {
      // Allocate VCVS branch row (vcvsset.c:41-44 guard pattern)
      if (_vcvsBranch === -1) {
        _vcvsBranch = ctx.makeCur("DAC_vcvs1", "branch");
      }
      this.branchIndex = _vcvsBranch;

      // VCVS TSTALLOC sequence (vcvsset.c:53-58):
      //   ctrl+(nVref), ctrl-(nGnd), out+(nOut), out-(nGnd)
      // Per A6.6 ground-node guard policy for composite sub-elements that may
      // receive node 0 from parent's pinNodeIds reassignment.
      if (nOut > 0) {
        _hVCVSPosIbr = ctx.solver.allocElement(nOut,        _vcvsBranch);  // (1) VCVSposIbrptr
      }
      if (nGnd > 0) {
        _hVCVSNegIbr = ctx.solver.allocElement(nGnd,        _vcvsBranch);  // (2) VCVSnegIbrptr
      }
      if (nOut > 0) {
        _hVCVSIbrPos = ctx.solver.allocElement(_vcvsBranch, nOut);          // (3) VCVSibrPosptr
      }
      if (nGnd > 0) {
        _hVCVSIbrNeg = ctx.solver.allocElement(_vcvsBranch, nGnd);          // (4) VCVSibrNegptr
      }
      if (nVref > 0) {
        _hVCVSIbrContPos = ctx.solver.allocElement(_vcvsBranch, nVref);     // (5) VCVSibrContPosptr
      }
      if (nGnd > 0) {
        _hVCVSIbrContNeg = ctx.solver.allocElement(_vcvsBranch, nGnd);      // (6) VCVSibrContNegptr
      }

      // Digital input pin models — each allocates their own handle entries
      for (let i = 0; i < bits; i++) {
        const nD = nDigitalBits[i];
        if (nD > 0) inputModels[i].setup(ctx);
      }
      if (nVref > 0) vrefModel.setup(ctx);

      // Forward to CAP children of pin models (transient capacitance)
      for (const child of childElements) {
        child.setup(ctx);
      }
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
      // Child cap elements have their stateBaseOffset set during setup() via
      // ctx.allocStates(). Just wire them to the pool — do not override offsets.
      for (const child of childElements) {
        child.initState(_pool);
      }
    },

    load(ctx: LoadContext): void {
      const voltages = ctx.rhsOld;
      const nGndV = nGnd > 0 ? voltages[nGnd] : 0;

      // Decode digital inputs using threshold comparison
      let code = 0;
      for (let i = 0; i < bits; i++) {
        const nD = nDigitalBits[i];
        if (nD > 0) {
          const vD = voltages[nD];
          if (vD >= p.vIH) code |= (1 << i);
        }
      }

      // Compute VCVS gain = code / 2^N (unipolar) or (2*code/2^N - 1) (bipolar)
      const gain = bipolar
        ? (2 * code / maxCode - 1)
        : code / maxCode;

      // Stamp VCVS branch equation using cached handles (vcvsset.c:53-58):
      // Branch equation: V_out+ - V_out- - gain*(V_ctrl+ - V_ctrl-) = 0
      // V_out+ = nOut,  V_out- = nGnd,  V_ctrl+ = nVref,  V_ctrl- = nGnd
      const solver = ctx.solver;

      // B sub-matrix (incidence: output port KCL rows)
      if (_hVCVSPosIbr !== -1) solver.stampElement(_hVCVSPosIbr,  1);  // B[nOut, branch]
      if (_hVCVSNegIbr !== -1) solver.stampElement(_hVCVSNegIbr, -1);  // B[nGnd, branch]

      // C sub-matrix (output branch constraint equation)
      if (_hVCVSIbrPos !== -1) solver.stampElement(_hVCVSIbrPos,   1); // C[branch, nOut]
      if (_hVCVSIbrNeg !== -1) solver.stampElement(_hVCVSIbrNeg,  -1); // C[branch, nGnd]

      // Control port Jacobian (gain terms)
      if (_hVCVSIbrContPos !== -1) solver.stampElement(_hVCVSIbrContPos, -gain); // C[branch, nVref]
      if (_hVCVSIbrContNeg !== -1) solver.stampElement(_hVCVSIbrContNeg,  gain); // C[branch, nGnd]

      // RHS: linearized NR constant = f(Vctrl0) - f'*Vctrl0 = 0 for linear VCVS
      // For a linear VCVS: f(Vctrl) = gain*Vctrl, f'=gain, so RHS term = 0
      // No RHS stamp needed for linear VCVS (value - derivative * ctrlValue = 0)

      // Forward to input pin models (resistive loading stamps)
      for (let i = 0; i < bits; i++) {
        const nD = nDigitalBits[i];
        if (nD > 0) inputModels[i].load(ctx);
      }
      if (nVref > 0) vrefModel.load(ctx);

      // CAP children
      for (const child of childElements) { child.load(ctx); }

      void nGndV; // used only for clarity; nGnd is used directly in stamps
    },

    accept(_ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {},

    getPinCurrents(rhs: Float64Array): number[] {
      const currents: number[] = [];

      const rIn = p.rIn;
      for (let i = 0; i < bits; i++) {
        const v = nDigitalBits[i] > 0 ? rhs[nDigitalBits[i]] : 0;
        currents.push(nDigitalBits[i] > 0 ? v / rIn : 0);
      }

      currents.push(0); // VREF

      // OUT: branch current is at branch row index
      const iOut = _vcvsBranch > 0 ? rhs[_vcvsBranch] : 0;
      currents.push(iOut);

      currents.push(0); // GND

      return currents;
    },

    setParam(key: string, value: number): void {
      if (key in p) {
        p[key] = value;
        // Forward input threshold/impedance changes to all pin models
        if (key === "vIH" || key === "vIL" || key === "rIn" || key === "cIn") {
          for (const m of inputModels) m.setParam(key, value);
          vrefModel.setParam(key, value);
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
        createDACElement(pinNodes, props, false),
      paramDefs: DAC_PARAM_DEFS,
      params: DAC_DEFAULTS,
      mayCreateInternalNodes: false,
    },
    "bipolar": {
      kind: "inline",
      factory: (pinNodes, props, _getTime) =>
        createDACElement(pinNodes, props, true),
      paramDefs: DAC_PARAM_DEFS,
      params: DAC_DEFAULTS,
      mayCreateInternalNodes: false,
    },
  },
  defaultModel: "unipolar",
};
