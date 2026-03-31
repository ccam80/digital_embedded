/**
 * 555 Timer IC — behavioral analog model.
 *
 * The 555 contains two comparators, an SR flip-flop, a discharge transistor,
 * and an output stage. This behavioral model captures external IC behavior
 * with correct threshold voltages and output drive.
 *
 * Internal structure:
 *   - Voltage divider: 3×5kΩ from VCC to GND.
 *     The upper tap (2/3 VCC) connects to the CTRL pin.
 *     The lower tap (1/3 VCC) is the trigger reference (= CTRL/2).
 *   - Comparator 1 (threshold): V_THR > V_CTRL → reset flip-flop (Q=0)
 *   - Comparator 2 (trigger):   V_TRIG < V_CTRL/2 → set flip-flop (Q=1)
 *   - RESET pin (active low, < 0.7V above GND): overrides flip-flop, forces Q=0
 *   - Q=1 (SET):   OUTPUT = VCC − vDrop (high), DISCHARGE = Hi-Z (transistor OFF)
 *   - Q=0 (RESET): OUTPUT ≈ GND+0.1V (low),    DISCHARGE = rDischarge to GND
 *
 * MNA model:
 *   stamp()         — internal voltage divider resistors (topology-constant)
 *   stampNonlinear()— output and discharge Norton equivalents (state-dependent)
 *   updateOperatingPoint() — evaluate comparators, update flip-flop state
 *   updateState()   — re-evaluate at accepted timestep for state consistency
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
import type { AnalogElementCore } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";
import { defineModelParams } from "../../core/model-params.js";
import { DigitalOutputPinModel } from "../../solver/analog/digital-pin-model.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: TIMER555_PARAM_DEFS, defaults: TIMER555_DEFAULTS } = defineModelParams({
  primary: {
    vDrop:      { default: 1.5, unit: "V", description: "Voltage drop from VCC for high output state" },
    rDischarge: { default: 10,  unit: "Ω", description: "Saturation resistance of the discharge transistor" },
  },
});

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

// Pin index → nodeIds[i] mapping:
//   0: DIS      1: TRIG     2: THR      3: VCC
//   4: CTRL     5: OUT      6: RST      7: GND

function buildTimer555PinDeclarations(): PinDeclaration[] {
  // Compact IC layout: body (1,0)→(5,6), VCC top-center, GND bottom-center,
  // 3 left pins and 3 right pins evenly spaced at y=1,3,5.
  return [
    {
      direction: PinDirection.INPUT,
      label: "DIS",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "TRIG",
      defaultBitWidth: 1,
      position: { x: 0, y: 3 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "THR",
      defaultBitWidth: 1,
      position: { x: 0, y: 5 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "VCC",
      defaultBitWidth: 1,
      position: { x: 3, y: -1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "CTRL",
      defaultBitWidth: 1,
      position: { x: 6, y: 5 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "OUT",
      defaultBitWidth: 1,
      position: { x: 6, y: 3 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "RST",
      defaultBitWidth: 1,
      position: { x: 6, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "GND",
      defaultBitWidth: 1,
      position: { x: 3, y: 7 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// Timer555Element — CircuitElement implementation
// ---------------------------------------------------------------------------

export class Timer555Element extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Timer555", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildTimer555PinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 1,
      width: 6,
      height: 8,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vVcc  = signals?.getPinVoltage("VCC");
    const vGnd  = signals?.getPinVoltage("GND");
    const vTrig = signals?.getPinVoltage("TRIG");
    const vThr  = signals?.getPinVoltage("THR");
    const vCtrl = signals?.getPinVoltage("CTRL");
    const vRst  = signals?.getPinVoltage("RST");
    const vDis  = signals?.getPinVoltage("DIS");
    const vOut  = signals?.getPinVoltage("OUT");

    ctx.save();
    ctx.setLineWidth(1);

    // IC body rectangle: (1,0) to (5,6), width=4, height=6
    ctx.setColor("COMPONENT");
    ctx.drawRect(1, 0, 4, 6, false);

    // Left-side leads: pin tip (0,y) → body edge (1,y)
    drawColoredLead(ctx, signals, vDis,  0, 1, 1, 1);
    drawColoredLead(ctx, signals, vTrig, 0, 3, 1, 3);
    drawColoredLead(ctx, signals, vThr,  0, 5, 1, 5);

    // Right-side leads: pin tip (6,y) → body edge (5,y)
    drawColoredLead(ctx, signals, vRst,  6, 1, 5, 1);
    drawColoredLead(ctx, signals, vOut,  6, 3, 5, 3);
    drawColoredLead(ctx, signals, vCtrl, 6, 5, 5, 5);

    // VCC lead (north): pin tip (3,-1) → body edge (3,0)
    drawColoredLead(ctx, signals, vVcc, 3, -1, 3, 0);

    // GND lead (south): pin tip (3,7) → body edge (3,6)
    drawColoredLead(ctx, signals, vGnd, 3, 7, 3, 6);

    // Component name centered between top and middle pin rows
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.8 });
    ctx.drawText("555", 3, 2, { horizontal: "center", vertical: "middle" });

    // Pin labels inside IC body
    ctx.setFont({ family: "sans-serif", size: 0.65 });
    ctx.drawText("DIS",  1.2, 1, { horizontal: "left", vertical: "middle" });
    ctx.drawText("TRIG", 1.2, 3, { horizontal: "left", vertical: "middle" });
    ctx.drawText("THR",  1.2, 5, { horizontal: "left", vertical: "middle" });
    ctx.drawText("RST",  4.8, 1, { horizontal: "right", vertical: "middle" });
    ctx.drawText("OUT",  4.8, 3, { horizontal: "right", vertical: "middle" });
    ctx.drawText("CTRL", 4.8, 5, { horizontal: "right", vertical: "middle" });
    ctx.drawText("VCC",  3, 0.4, { horizontal: "center", vertical: "top" });
    ctx.drawText("GND",  3, 5.6, { horizontal: "center", vertical: "top" });

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// createTimer555Element — AnalogElement factory
// ---------------------------------------------------------------------------

/**
 * Create the MNA analog element for a 555 timer.
 *
 * Internal voltage divider (stamped in stamp()):
 *   VCC → CTRL: 5kΩ   (upper divider arm)
 *   CTRL → GND: 10kΩ  (two 5kΩ in series, combined; no tapped midpoint node needed)
 * Result: CTRL = VCC × 10/15 = 2/3 VCC when CTRL pin is floating.
 * External drive on CTRL overrides this.
 *
 * Output (stampNonlinear): Norton equivalent between OUT and GND.
 * Discharge (stampNonlinear): R_sat or R_hiZ between DIS and GND.
 */
function createTimer555Element(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const p: Record<string, number> = {
    vDrop:      props.getModelParam<number>("vDrop"),
    rDischarge: props.getModelParam<number>("rDischarge"),
  };
  const rOut        = 10;     // output drive resistance (Ω)
  const rHiZ        = 1e6;    // discharge transistor off-state resistance (Ω)
  const rDiv1       = 5000;   // VCC→CTRL divider arm (Ω)
  const rDiv2       = 10000;  // CTRL→GND divider arm (2×5kΩ combined, Ω)

  const nDis  = pinNodes.get("DIS")!;
  const nTrig = pinNodes.get("TRIG")!;
  const nThr  = pinNodes.get("THR")!;
  const nVcc  = pinNodes.get("VCC")!;
  const nCtrl = pinNodes.get("CTRL")!;
  const nOut  = pinNodes.get("OUT")!;
  const nRst  = pinNodes.get("RST")!;
  const nGnd  = pinNodes.get("GND")!;

  // SR flip-flop output: true=SET(high output), false=RESET(low output)
  let _flipflopQ = false;

  const _outputPin = new DigitalOutputPinModel({
    rOut,
    cOut:  0,
    rIn:   1e7,
    cIn:   0,
    vOH:   3.5,
    vOL:   0.1,
    vIH:   2.0,
    vIL:   0.8,
    rHiZ:  1e7,
  });
  _outputPin.init(nOut, -1);

  function readNode(voltages: Float64Array, n: number): number {
    return n > 0 ? voltages[n - 1] : 0;
  }

  function stampResistor(solver: SparseSolver, nA: number, nB: number, R: number): void {
    const G = 1 / R;
    if (nA > 0) solver.stamp(nA - 1, nA - 1, G);
    if (nB > 0) solver.stamp(nB - 1, nB - 1, G);
    if (nA > 0 && nB > 0) {
      solver.stamp(nA - 1, nB - 1, -G);
      solver.stamp(nB - 1, nA - 1, -G);
    }
  }

  function updateOutputPinLevels(voltages: Float64Array): void {
    const vVcc = readNode(voltages, nVcc);
    const vGnd = readNode(voltages, nGnd);
    _outputPin.setParam("vOH", vVcc - p.vDrop);
    _outputPin.setParam("vOL", vGnd + 0.1);
  }

  function advanceFlipflop(voltages: Float64Array): void {
    // Evaluate comparators and advance flip-flop state.
    // Called ONLY after an accepted timestep (in updateState), not during NR
    // iteration. Holding flip-flop state constant within a timestep allows the
    // NR solver to converge; state transitions happen once per timestep.
    const vGnd  = readNode(voltages, nGnd);
    const vTrig = readNode(voltages, nTrig);
    const vThr  = readNode(voltages, nThr);
    const vCtrl = readNode(voltages, nCtrl);
    const vRst  = readNode(voltages, nRst);

    // Active-low RESET: RST < GND+0.7V → force Q=0
    if ((vRst - vGnd) < 0.7) {
      _flipflopQ = false;
      return;
    }

    const vThresholdRef = vCtrl;       // upper comparator reference (= 2/3 VCC via divider)
    const vTriggerRef   = vCtrl * 0.5; // lower comparator reference (= 1/3 VCC)

    // Comparator 1: THR > threshold_ref → reset (Q=0)
    const comp1Reset = (vThr - vGnd) > (vThresholdRef - vGnd);
    // Comparator 2: TRIG < trigger_ref → set (Q=1)
    const comp2Set   = (vTrig - vGnd) < (vTriggerRef - vGnd);

    // SR flip-flop: RESET dominates
    if (comp1Reset) {
      _flipflopQ = false;
    } else if (comp2Set) {
      _flipflopQ = true;
    }
    // else: hold current state
  }

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,

    stamp(solver: SparseSolver): void {
      // Internal voltage divider: VCC→CTRL (5kΩ), CTRL→GND (10kΩ)
      stampResistor(solver, nVcc, nCtrl, rDiv1);
      stampResistor(solver, nCtrl, nGnd, rDiv2);
    },

    stampNonlinear(solver: SparseSolver): void {
      // Output stage: conductance + current source driving OUT toward vOH or vOL
      _outputPin.setLogicLevel(_flipflopQ);
      _outputPin.stampOutput(solver);

      // Discharge transistor: R_sat to GND when Q=0, Hi-Z when Q=1
      if (_flipflopQ) {
        stampResistor(solver, nDis, nGnd, rHiZ);
      } else {
        stampResistor(solver, nDis, nGnd, Math.max(p.rDischarge, 1e-3));
      }
    },

    updateOperatingPoint(voltages: Float64Array): void {
      // Update output pin voltage levels for stampNonlinear but do NOT advance
      // flip-flop. Keeping flip-flop state constant within each NR solve lets
      // the solver converge to the linearized operating point. State transitions
      // only occur in updateState() after each accepted timestep.
      updateOutputPinLevels(voltages);
    },

    updateState(_dt: number, voltages: Float64Array): void {
      // Called once per accepted timestep: now safe to advance state.
      updateOutputPinLevels(voltages);
      advanceFlipflop(voltages);
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // Pin layout order: [DIS, TRIG, THR, VCC, CTRL, OUT, RST, GND]
      // (indices 0–7 matching buildTimer555PinDeclarations())
      //
      // Convention: positive = current flowing INTO the element at that pin.
      //
      // Stamped constitutive equations (read from stamp() / stampNonlinear()):
      //   Voltage divider:  rDiv1 between VCC↔CTRL, rDiv2 between CTRL↔GND
      //   Output:           DigitalOutputPinModel stamps G_out on nOut diagonal,
      //                     vTarget*G_out on RHS at nOut (reference = MNA node 0)
      //   Discharge:        conductance r_dis between DIS↔GND (rDischarge when Q=0, rHiZ when Q=1)
      //
      // TRIG, THR, RST are pure voltage sense inputs — no current is stamped at these pins.
      //
      // KCL: sum of all 8 pin currents = 0 (VCC and GND carry the balance).

      const vVcc  = readNode(voltages, nVcc);
      const vGnd  = readNode(voltages, nGnd);
      const vCtrl = readNode(voltages, nCtrl);
      const vOut  = readNode(voltages, nOut);
      const vDis  = readNode(voltages, nDis);

      const gDiv1 = 1 / rDiv1;
      const gDiv2 = 1 / rDiv2;
      const gOut  = 1 / rOut;
      const rDis  = _flipflopQ ? rHiZ : Math.max(p.rDischarge, 1e-3);
      const gDis  = 1 / rDis;

      // Output target voltage (absolute, stamped by DigitalOutputPinModel)
      const vOutTarget = _outputPin.currentVoltage;

      // Current into element at each pin.
      // For a resistor A↔B: I_into_element_at_A = G*(V_A - V_B)
      // For DigitalOutputPinModel: stamps G_out on OUT diagonal and vTarget*G_out on RHS.
      //   The element supplies vTarget*G_out current INTO OUT from MNA node 0.
      //   → current into element at OUT = G_out*(V_out - 0) - vTarget*G_out
      //   → GND carries the return: absorbed into GND pin current via KCL balance.

      const iDis  = gDis * (vDis  - vGnd);
      const iTrig = 0;
      const iThr  = 0;
      const iVcc  = gDiv1 * (vVcc  - vCtrl);
      const iCtrl = gDiv1 * (vCtrl - vVcc) + gDiv2 * (vCtrl - vGnd);
      const iOut  = gOut  * vOut - vOutTarget * gOut;
      const iRst  = 0;
      const iGnd  = gDiv2 * (vGnd  - vCtrl)
                  + gDis  * (vGnd  - vDis);

      // Return in pinLayout order: [DIS, TRIG, THR, VCC, CTRL, OUT, RST, GND]
      return [iDis, iTrig, iThr, iVcc, iCtrl, iOut, iRst, iGnd];
    },

    setParam(key: string, value: number): void {
      if (key in p) p[key] = value;
    },
  };
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const TIMER555_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "variant",
    type: PropertyType.STRING,
    label: "Variant",
    defaultValue: "bipolar",
    description: "IC variant: 'bipolar' (NE555, vDrop≈1.5V) or 'cmos' (TLC555, vDrop≈0.1V).",
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

const TIMER555_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "vDrop",      propertyKey: "vDrop",      convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "rDischarge", propertyKey: "rDischarge", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "variant",    propertyKey: "variant",    convert: (v) => v },
  { xmlName: "Label",      propertyKey: "label",      convert: (v) => v },
];

// ---------------------------------------------------------------------------
// Timer555Definition
// ---------------------------------------------------------------------------

export const Timer555Definition: ComponentDefinition = {
  name: "Timer555",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildTimer555PinDeclarations(),
  propertyDefs: TIMER555_PROPERTY_DEFS,
  attributeMap: TIMER555_ATTRIBUTE_MAPPINGS,

  helpText:
    "555 Timer IC — behavioral analog model with two comparators, SR flip-flop, " +
    "discharge transistor, and output stage. Pins: VCC, GND, TRIG, THR, CTRL, RST, DIS, OUT.",

  factory(props: PropertyBag): Timer555Element {
    return new Timer555Element(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props) =>
        createTimer555Element(pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: TIMER555_PARAM_DEFS,
      params: TIMER555_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
