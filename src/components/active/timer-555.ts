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
import type { PinVoltageAccess } from "../../editor/pin-voltage-access.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { AnalogElement, AnalogElementCore } from "../../solver/analog/element.js";
import type { SparseSolver } from "../../solver/analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

// Pin index → nodeIds[i] mapping:
//   0: DIS      1: TRIG     2: THR      3: VCC
//   4: CTRL     5: OUT      6: RST      7: GND

function buildTimer555PinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "DIS",
      defaultBitWidth: 1,
      position: { x: 0, y: 2 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "TRIG",
      defaultBitWidth: 1,
      position: { x: 0, y: 6 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "THR",
      defaultBitWidth: 1,
      position: { x: 0, y: 8 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "VCC",
      defaultBitWidth: 1,
      position: { x: 4, y: -2 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "CTRL",
      defaultBitWidth: 1,
      position: { x: 4, y: 10 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.OUTPUT,
      label: "OUT",
      defaultBitWidth: 1,
      position: { x: 8, y: 4 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "RST",
      defaultBitWidth: 1,
      position: { x: 8, y: 2 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "GND",
      defaultBitWidth: 1,
      position: { x: 6, y: 10 },
      isNegatable: false,
      isClockCapable: false,
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
      y: this.position.y - 2,
      width: 8,
      height: 12,
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

    // IC body rectangle: x=1, y=-1, width=6, height=10 (grid units)
    ctx.setColor("COMPONENT");
    ctx.drawRect(1, -1, 6, 10, false);

    // DIS lead (west): pin tip (0,2) → body edge (1,2)
    if (vDis !== undefined && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vDis));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(0, 2, 1, 2);

    // TRIG lead (west): pin tip (0,6) → body edge (1,6)
    if (vTrig !== undefined && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vTrig));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(0, 6, 1, 6);

    // THR lead (west): pin tip (0,8) → body edge (1,8)
    if (vThr !== undefined && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vThr));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(0, 8, 1, 8);

    // VCC lead (north): pin tip (4,-2) → body edge (4,-1)
    if (vVcc !== undefined && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vVcc));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(4, -2, 4, -1);

    // CTRL lead (south): pin tip (4,10) → body edge (4,9)
    if (vCtrl !== undefined && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vCtrl));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(4, 10, 4, 9);

    // OUT lead (east): pin tip (8,4) → body edge (7,4)
    if (vOut !== undefined && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vOut));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(8, 4, 7, 4);

    // RST lead (east): pin tip (8,2) → body edge (7,2)
    if (vRst !== undefined && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vRst));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(8, 2, 7, 2);

    // GND lead (south): pin tip (6,10) → body edge (6,9)
    if (vGnd !== undefined && ctx.setRawColor) {
      ctx.setRawColor(signals!.voltageColor(vGnd));
    } else {
      ctx.setColor("COMPONENT");
    }
    ctx.drawLine(6, 10, 6, 9);

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "555 Timer IC — behavioral model with two comparators, SR flip-flop, " +
      "discharge transistor, and output stage. Supports astable and monostable modes. " +
      "Pins: VCC, GND, TRIG, THR, CTRL, RST, DIS, OUT."
    );
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
  props: PropertyBag,
): AnalogElementCore {
  const vDrop      = props.getOrDefault<number>("vDrop", 1.5);
  const rDischarge  = Math.max(props.getOrDefault<number>("rDischarge", 10), 1e-3);
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
  // Cached output voltage levels, updated each operating point evaluation
  let _vOH = 3.5;
  let _vOL = 0.1;

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

  /**
   * Stamp a Norton equivalent voltage source between nPos and nNeg.
   * Drives (nPos − nNeg) toward vTarget with output resistance R.
   * The Norton current I = vTarget / R is injected into nPos (out of nNeg).
   */
  function stampNorton(
    solver: SparseSolver,
    nPos: number,
    nNeg: number,
    vTarget: number,
    R: number,
  ): void {
    const G = 1 / R;
    if (nPos > 0) solver.stamp(nPos - 1, nPos - 1, G);
    if (nNeg > 0) solver.stamp(nNeg - 1, nNeg - 1, G);
    if (nPos > 0 && nNeg > 0) {
      solver.stamp(nPos - 1, nNeg - 1, -G);
      solver.stamp(nNeg - 1, nPos - 1, -G);
    }
    const iNorton = vTarget * G;
    if (nPos > 0) solver.stampRHS(nPos - 1, iNorton);
    if (nNeg > 0) solver.stampRHS(nNeg - 1, -iNorton);
  }

  function updateVoltageCache(voltages: Float64Array): void {
    // Update cached output levels from current VCC/GND — no state change.
    // Called on every NR iteration to keep output levels accurate.
    const vVcc = readNode(voltages, nVcc);
    const vGnd = readNode(voltages, nGnd);
    _vOH = vVcc - vDrop;
    _vOL = vGnd + 0.1;
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
      // Output stage: Norton equivalent from OUT to GND
      const vOutTarget = _flipflopQ ? _vOH : _vOL;
      stampNorton(solver, nOut, nGnd, vOutTarget, rOut);

      // Discharge transistor: R_sat to GND when Q=0, Hi-Z when Q=1
      if (_flipflopQ) {
        stampResistor(solver, nDis, nGnd, rHiZ);
      } else {
        stampResistor(solver, nDis, nGnd, rDischarge);
      }
    },

    updateOperatingPoint(voltages: Float64Array): void {
      // Update voltage levels for stampNonlinear but do NOT advance flip-flop.
      // Keeping flip-flop state constant within each NR solve lets the solver
      // converge to the linearized operating point. State transitions only
      // occur in updateState() after each accepted timestep.
      updateVoltageCache(voltages);
    },

    updateState(_dt: number, voltages: Float64Array): void {
      // Called once per accepted timestep: now safe to advance state.
      updateVoltageCache(voltages);
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
      //   Output Norton:    conductance rOut between OUT↔GND, Norton current vOutTarget/rOut into OUT
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
      const rDis  = _flipflopQ ? rHiZ : rDischarge;
      const gDis  = 1 / rDis;

      // Output Norton target (matches stampNonlinear logic)
      const vOutTarget = _flipflopQ ? _vOH : _vOL;

      // Current into element at each pin from its stamped conductance(s).
      // For a resistor A↔B: I_into_element_at_A = G*(V_A - V_B)
      //                      I_into_element_at_B = G*(V_B - V_A)
      // For Norton at OUT↔GND: element injects iNorton=vTarget*gOut INTO OUT (sourcing).
      //   → current into element at OUT  = G_out*(V_out - V_gnd) - vTarget*G_out
      //   → current into element at GND (Norton contribution) = G_out*(V_gnd - V_out) + vTarget*G_out
      //     (the Norton source pulls vTarget*G_out OUT of the element at GND, so INTO element = +vTarget*G_out... wait: Norton injects into OUT from RHS; GND gets -iNorton on RHS, meaning element takes vTarget*G_out from GND node: INTO element at GND = -(−vTarget*G_out) = ... )
      //
      // Careful re GND Norton term:
      //   stampRHS(nPos-1, +iNorton) → element sources iNorton INTO the OUT node (element supplies this)
      //   stampRHS(nNeg-1, -iNorton) → element sinks iNorton FROM the GND node (element takes this)
      // So: current element draws FROM GND due to Norton = +iNorton = vTarget*G_out
      //     i.e. current INTO element at GND (Norton part) = +vTarget*G_out
      //     current INTO element at OUT (Norton part) = -iNorton = -vTarget*G_out
      //       (the element supplies current to OUT, so it receives negative current at OUT from circuit)
      //
      // Net INTO element at OUT  = G_out*(V_out - V_gnd) - vTarget*G_out
      // Net INTO element at GND  = G_div2*(V_gnd - V_ctrl) + G_dis*(V_gnd - V_dis)
      //                          + G_out*(V_gnd - V_out) + vTarget*G_out

      const iDis  = gDis * (vDis  - vGnd);
      const iTrig = 0;
      const iThr  = 0;
      const iVcc  = gDiv1 * (vVcc  - vCtrl);
      const iCtrl = gDiv1 * (vCtrl - vVcc) + gDiv2 * (vCtrl - vGnd);
      const iOut  = gOut  * (vOut  - vGnd)  - vOutTarget * gOut;
      const iRst  = 0;
      const iGnd  = gDiv2 * (vGnd  - vCtrl)
                  + gDis  * (vGnd  - vDis)
                  + gOut  * (vGnd  - vOut)  + vOutTarget * gOut;

      // Return in pinLayout order: [DIS, TRIG, THR, VCC, CTRL, OUT, RST, GND]
      return [iDis, iTrig, iThr, iVcc, iCtrl, iOut, iRst, iGnd];
    },
  };
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const TIMER555_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "vDrop",
    type: PropertyType.INT,
    label: "Output voltage drop (V)",
    defaultValue: 1.5,
    min: 0,
    description:
      "Voltage drop from VCC for high output state. " +
      "1.5V for bipolar NE555, 0.1V for CMOS TLC555. Default 1.5V.",
  },
  {
    key: "rDischarge",
    type: PropertyType.INT,
    label: "Discharge resistance (Ω)",
    defaultValue: 10,
    min: 1e-3,
    description:
      "Saturation resistance of the discharge transistor when active. Default 10Ω.",
  },
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
  { xmlName: "vDrop",      propertyKey: "vDrop",      convert: (v) => parseFloat(v) },
  { xmlName: "rDischarge", propertyKey: "rDischarge", convert: (v) => parseFloat(v) },
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

  models: {
    analog: {
      factory(
        pinNodes: ReadonlyMap<string, number>,
        _internalNodeIds: readonly number[],
        _branchIdx: number,
        props: PropertyBag,
      ): AnalogElementCore {
        return createTimer555Element(pinNodes, props);
      },
    },
  },
};
