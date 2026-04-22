/**
 * 555 Timer IC — F4b composite analog model.
 *
 * Textbook internal schematic (NE555 / LM555 datasheet):
 *
 *   VCC
 *    │
 *   [R=5kΩ]  ← upper divider arm
 *    │
 *    ├──────── CTRL pin (2/3 VCC when CTRL floating)
 *    │         └─ Comparator 1 in- (threshold reference)
 *   [R=5kΩ]  ← middle divider arm
 *    │
 *    ├──────── nLower (internal, 1/3 VCC)
 *    │         └─ Comparator 2 in+ (trigger reference)
 *   [R=5kΩ]  ← lower divider arm
 *    │
 *   GND
 *
 *   Comparator 1 (threshold): in+ = THR,   in- = CTRL  → RESET when THR > CTRL
 *   Comparator 2 (trigger):   in+ = nLower, in- = TRIG → SET   when TRIG < nLower
 *
 *   RS flip-flop (dominant RESET):
 *     RESET=1, SET=0  → Q=0
 *     RESET=0, SET=1  → Q=1
 *     RESET=0, SET=0  → hold
 *     RESET=1, SET=1  → Q=0 (RESET dominates per NE555 spec)
 *
 *   Active-low RESET pin: RST < GND+0.7V overrides flip-flop → forces Q=0
 *
 *   Q=1 (SET):   OUTPUT = VCC − vDrop (high), DISCHARGE = Hi-Z
 *   Q=0 (RESET): OUTPUT ≈ GND + 0.1V (low),  DISCHARGE = rDischarge to GND
 *
 * Sub-component delegation (F4b composition — per W1.8c spec, matching W1.8a
 * inline-stamp pattern established by optocoupler.ts):
 *
 *   R-divider:      Three 5kΩ resistor stamps (cite: ngspice resload.c —
 *                   primitive resistor conductance stamp G = 1/R at four matrix
 *                   positions). Lower tap node (1/3 VCC) is an internal MNA node
 *                   allocated via getInternalNodeCount = () => 1.
 *
 *   Comparator 1/2: Open-collector comparator physics stamped inline (F4c
 *                   behavioral — acceptable per W1.8c spec note: "555's
 *                   composition is F4b via composition shape; internal comparators
 *                   remain F4c behavioral"). Hysteresis state tracked per-comparator.
 *
 *   RS flip-flop:   Behavioral digital state (_flipflopQ) advanced in accept()
 *                   after each accepted timestep. No analog RS-FF primitive exists
 *                   in digiTS; building from cross-coupled gates would require
 *                   digital-layer infrastructure outside timer-555.ts scope
 *                   (escalation condition per W1.8c §Hard rules).
 *
 *   Discharge BJT:  NPN CE saturation path modelled as switched resistor between
 *                   DIS and GND (cite: bjtload.c::BJTload CE stamp — simplified
 *                   saturation regime: V_CE → 0 when fully saturated, modelled
 *                   as R_sat = rDischarge to GND; off-state = R_hiZ to GND for
 *                   numerical stability). Full Gummel-Poon BJTload requires pool
 *                   state (PoolBackedAnalogElementCore); inline switched-resistor
 *                   matches the textbook switching behavior at the 555's external
 *                   DIS terminal without requiring the 555 composite to be
 *                   pool-backed.
 *
 *   Output stage:   DigitalOutputPinModel — Norton equivalent driving OUT toward
 *                   V_OH or V_OL through R_out.
 *
 * MNA stamps (per load() call):
 *   R-divider:  3×stampG (5kΩ each) across VCC→CTRL, CTRL→nLower, nLower→GND
 *   Comp1 out:  open-collector G_eff from nComp1Out to GND (internal node or no
 *               output node — comparator state fed to RS FF only via accept())
 *   Comp2 out:  same
 *   Discharge:  stampG rDischarge (Q=0) or rHiZ (Q=1) between DIS and GND
 *   Output:     DigitalOutputPinModel.load(ctx) on nOut
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
import type { AnalogElementCore, LoadContext } from "../../solver/analog/element.js";
import { defineModelParams } from "../../core/model-params.js";
import { stampG, stampRHS } from "../../solver/analog/stamp-helpers.js";
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
// Internal constants
// ---------------------------------------------------------------------------

/** Three equal divider arms (5kΩ each) from VCC to GND — textbook NE555. */
const R_DIV = 5000;   // Ω — cite: NE555 datasheet; resload.c primitive resistor

/** Output drive resistance (Norton equivalent, internal). */
const R_OUT = 10;     // Ω

/**
 * Discharge BJT off-state impedance.
 * Cite: bjtload.c — NPN off-state: I_C ≈ 0 when V_BE < V_th; modelled here as
 * R_hiZ = 1 MΩ for numerical stability (prevents floating DIS node).
 */
const R_HIZ = 1e6;   // Ω

/**
 * Open-collector comparator off-state impedance (when output inactive).
 * Cite: comparator.ts F4c behavioral — R_OFF = 1 GΩ.
 */
const G_COMP_OFF = 1e-9;  // S (= 1/1GΩ)

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
// createTimer555Element — AnalogElement factory (F4b composite)
// ---------------------------------------------------------------------------

/**
 * F4b composite 555 timer MNA element.
 *
 * Composition (sub-element delegation, inline stamp pattern per W1.8a):
 *
 *   1. R-divider (three 5kΩ arms, cite: resload.c primitive conductance stamp):
 *        VCC → CTRL (nCtrl): 5kΩ — upper arm
 *        CTRL (nCtrl) → nLower: 5kΩ — middle arm (nLower = internal node, 1/3 VCC)
 *        nLower → GND: 5kΩ — lower arm
 *
 *   2. Comparator 1 — threshold (F4c behavioral, cite: comparator.ts):
 *        in+ = THR, in- = CTRL
 *        Active (sinking) when THR > CTRL → asserts RESET to RS flip-flop
 *        Open-collector: G_sat = 1/rSat to GND when active; G_off otherwise.
 *        Output node: nComp1Out (internal). Stamp between nComp1Out and GND.
 *
 *   3. Comparator 2 — trigger (F4c behavioral, cite: comparator.ts):
 *        in+ = nLower (1/3 VCC), in- = TRIG
 *        Active (sinking) when TRIG < nLower → asserts SET to RS flip-flop
 *        Open-collector: same stamp shape as comparator 1.
 *        Output node: nComp2Out (internal). Stamp between nComp2Out and GND.
 *
 *   4. RS flip-flop (behavioral digital state):
 *        No analog RS-FF primitive in digiTS. Built from cross-coupled gates
 *        would require digital-layer infrastructure — escalation per spec.
 *        Implemented as _flipflopQ boolean advanced in accept() after each
 *        accepted timestep from comparator output node voltages.
 *
 *   5. Discharge NPN transistor (cite: bjtload.c::BJTload CE saturation path):
 *        Q=0 (RESET): DIS → GND via rDischarge (saturated, V_CE ≈ 0)
 *        Q=1 (SET):   DIS → GND via R_HIZ (off-state leakage)
 *        Full Gummel-Poon BJTload (createBjtElement) requires PoolBackedAnalogElementCore;
 *        inline switched-resistor captures the 555's external DIS-terminal behavior
 *        at the composition boundary without making the 555 composite pool-backed.
 *
 *   6. Output stage (DigitalOutputPinModel):
 *        Norton equivalent: G_out on OUT diagonal, V_target·G_out on RHS.
 *        V_OH = VCC − vDrop (Q=1), V_OL = GND + 0.1V (Q=0).
 *
 * Internal nodes required (allocated via getInternalNodeCount = () => 3):
 *   internalNodeIds[0] = nLower      (R-divider lower tap, 1/3 VCC)
 *   internalNodeIds[1] = nComp1Out   (threshold comparator open-collector output)
 *   internalNodeIds[2] = nComp2Out   (trigger comparator open-collector output)
 *
 * Public param surface preserved:
 *   vDrop      — maps to output stage V_OH = VCC − vDrop
 *   rDischarge — maps to discharge BJT saturation resistance
 */
function createTimer555Element(
  pinNodes: ReadonlyMap<string, number>,
  internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const p: Record<string, number> = {
    vDrop:      props.getModelParam<number>("vDrop"),
    rDischarge: props.getModelParam<number>("rDischarge"),
  };

  const nDis  = pinNodes.get("DIS")!;
  const nTrig = pinNodes.get("TRIG")!;
  const nThr  = pinNodes.get("THR")!;
  const nVcc  = pinNodes.get("VCC")!;
  const nCtrl = pinNodes.get("CTRL")!;
  const nOut  = pinNodes.get("OUT")!;
  const nRst  = pinNodes.get("RST")!;
  const nGnd  = pinNodes.get("GND")!;

  // Internal nodes (allocated by compiler via getInternalNodeCount):
  //   [0] = nLower     — R-divider lower tap (1/3 VCC)
  //   [1] = nComp1Out  — threshold comparator open-collector output
  //   [2] = nComp2Out  — trigger comparator open-collector output
  const nLower    = internalNodeIds[0] ?? 0;
  const nComp1Out = internalNodeIds[1] ?? 0;
  const nComp2Out = internalNodeIds[2] ?? 0;

  // -------------------------------------------------------------------------
  // RS flip-flop state (_flipflopQ):
  //   true  = SET  → output HIGH, discharge transistor OFF
  //   false = RESET → output LOW,  discharge transistor ON
  // Advanced in accept() once per accepted timestep. Held constant during NR.
  // -------------------------------------------------------------------------
  let _flipflopQ = false;

  // -------------------------------------------------------------------------
  // Comparator hysteresis state (F4c behavioral — comparator.ts pattern):
  //   Comparator 1: active (sinking) when THR > CTRL → asserts RESET
  //   Comparator 2: active (sinking) when TRIG < nLower → asserts SET
  // -------------------------------------------------------------------------
  let _comp1Active = false;  // threshold comparator active state
  let _comp2Active = false;  // trigger comparator active state

  // R_sat for open-collector comparator output (cite: comparator.ts, rSat=50Ω default)
  const R_COMP_SAT = 50;    // Ω
  const G_COMP_SAT = 1 / R_COMP_SAT;

  // Pull-up resistor on comparator open-collector outputs so the output node
  // has a defined voltage for the RS flip-flop to read in accept().
  // 10kΩ pull-up from VCC to comp-out nodes (internal).
  const R_PULL_UP = 10000;  // Ω
  const G_PULL_UP = 1 / R_PULL_UP;

  // -------------------------------------------------------------------------
  // Output pin model
  // -------------------------------------------------------------------------
  const _outputPin = new DigitalOutputPinModel({
    rOut:  R_OUT,
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

  function updateOutputPinLevels(voltages: Float64Array): void {
    const vVccVal = readNode(voltages, nVcc);
    const vGndVal = readNode(voltages, nGnd);
    _outputPin.setParam("vOH", vVccVal - p.vDrop);
    _outputPin.setParam("vOL", vGndVal + 0.1);
  }

  /**
   * Advance comparator states and RS flip-flop after an accepted timestep.
   * Called ONLY from accept() — never during NR iteration.
   * Holding flip-flop state constant within a timestep lets NR converge;
   * transitions happen exactly once per accepted step.
   */
  function advanceFlipflop(voltages: Float64Array): void {
    const vGnd  = readNode(voltages, nGnd);
    const vRstV = readNode(voltages, nRst);

    // Active-low RESET pin: RST < GND + 0.7V → force Q=0 (overrides all)
    if ((vRstV - vGnd) < 0.7) {
      _comp1Active = false;
      _comp2Active = false;
      _flipflopQ = false;
      return;
    }

    const vThr   = readNode(voltages, nThr);
    const vTrig  = readNode(voltages, nTrig);
    const vCtrlV = readNode(voltages, nCtrl);
    const vLower = readNode(voltages, nLower);

    // Comparator 1 (threshold): F4c open-collector behavioral.
    // in+ = THR, in- = CTRL. Active when (THR − CTRL) > 0 (no hysteresis).
    // Asserts RESET when active.
    const vDiff1 = (vThr - vGnd) - (vCtrlV - vGnd);  // V_THR - V_CTRL
    if (_comp1Active) {
      if (vDiff1 < 0) _comp1Active = false;
    } else {
      if (vDiff1 > 0) _comp1Active = true;
    }
    const comp1Reset = _comp1Active;

    // Comparator 2 (trigger): F4c open-collector behavioral.
    // in+ = nLower (1/3 VCC), in- = TRIG. Active when (nLower − TRIG) > 0.
    // Asserts SET when active.
    // If nLower is 0 (no internal node allocated), fall back to CTRL/2 estimate.
    const vLowerEff = nLower > 0 ? vLower : vCtrlV * 0.5;
    const vDiff2 = (vLowerEff - vGnd) - (vTrig - vGnd);  // V_LOWER - V_TRIG
    if (_comp2Active) {
      if (vDiff2 < 0) _comp2Active = false;
    } else {
      if (vDiff2 > 0) _comp2Active = true;
    }
    const comp2Set = _comp2Active;

    // RS flip-flop: RESET dominates (NE555 spec).
    if (comp1Reset) {
      _flipflopQ = false;
    } else if (comp2Set) {
      _flipflopQ = true;
    }
    // else: hold
  }

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,

    load(ctx: LoadContext): void {
      const solver = ctx.solver;
      const voltages = ctx.voltages;

      // ------------------------------------------------------------------
      // Update output pin levels from current rail voltages (before stamp).
      // ------------------------------------------------------------------
      updateOutputPinLevels(voltages);

      // ------------------------------------------------------------------
      // Sub-component 1: R-divider (three 5kΩ arms)
      // Cite: resload.c — primitive resistor conductance stamp G=1/R.
      //   Upper arm:  VCC → CTRL (nCtrl)   — sets CTRL = 2/3 VCC when floating
      //   Middle arm: CTRL (nCtrl) → nLower — nLower = 1/3 VCC when floating
      //   Lower arm:  nLower → GND
      // ------------------------------------------------------------------
      const G_DIV = 1 / R_DIV;
      // Upper arm: VCC → CTRL
      stampG(solver, nVcc,  nVcc,  G_DIV);
      stampG(solver, nVcc,  nCtrl, -G_DIV);
      stampG(solver, nCtrl, nVcc,  -G_DIV);
      stampG(solver, nCtrl, nCtrl, G_DIV);
      // Middle arm: CTRL → nLower
      stampG(solver, nCtrl,  nCtrl,  G_DIV);
      stampG(solver, nCtrl,  nLower, -G_DIV);
      stampG(solver, nLower, nCtrl,  -G_DIV);
      stampG(solver, nLower, nLower, G_DIV);
      // Lower arm: nLower → GND
      stampG(solver, nLower, nLower, G_DIV);
      stampG(solver, nLower, nGnd,  -G_DIV);
      stampG(solver, nGnd,   nLower, -G_DIV);
      stampG(solver, nGnd,   nGnd,  G_DIV);

      // ------------------------------------------------------------------
      // Sub-component 2: Comparator 1 — threshold (F4c behavioral)
      // Cite: comparator.ts createOpenCollectorComparatorElement.
      //   in+ = THR, in- = CTRL. Output: nComp1Out (open-collector to GND).
      //   Pull-up: VCC → nComp1Out via R_PULL_UP (so node has a defined voltage).
      //   Active (comp1Reset=true): G_sat from nComp1Out to GND.
      //   Inactive:                 G_off from nComp1Out to GND.
      // ------------------------------------------------------------------
      const gComp1 = _comp1Active ? G_COMP_SAT : G_COMP_OFF;
      // Pull-up from VCC to nComp1Out
      stampG(solver, nVcc,     nVcc,     G_PULL_UP);
      stampG(solver, nVcc,     nComp1Out, -G_PULL_UP);
      stampG(solver, nComp1Out, nVcc,    -G_PULL_UP);
      stampG(solver, nComp1Out, nComp1Out, G_PULL_UP);
      // Open-collector output to GND
      stampG(solver, nComp1Out, nComp1Out, gComp1);
      stampG(solver, nComp1Out, nGnd,    -gComp1);
      stampG(solver, nGnd,     nComp1Out, -gComp1);
      stampG(solver, nGnd,     nGnd,     gComp1);

      // ------------------------------------------------------------------
      // Sub-component 3: Comparator 2 — trigger (F4c behavioral)
      // Cite: comparator.ts createOpenCollectorComparatorElement.
      //   in+ = nLower (1/3 VCC), in- = TRIG. Output: nComp2Out.
      //   Pull-up: VCC → nComp2Out via R_PULL_UP.
      //   Active (comp2Set=true): G_sat from nComp2Out to GND.
      //   Inactive:               G_off from nComp2Out to GND.
      // ------------------------------------------------------------------
      const gComp2 = _comp2Active ? G_COMP_SAT : G_COMP_OFF;
      // Pull-up from VCC to nComp2Out
      stampG(solver, nVcc,     nVcc,     G_PULL_UP);
      stampG(solver, nVcc,     nComp2Out, -G_PULL_UP);
      stampG(solver, nComp2Out, nVcc,    -G_PULL_UP);
      stampG(solver, nComp2Out, nComp2Out, G_PULL_UP);
      // Open-collector output to GND
      stampG(solver, nComp2Out, nComp2Out, gComp2);
      stampG(solver, nComp2Out, nGnd,    -gComp2);
      stampG(solver, nGnd,     nComp2Out, -gComp2);
      stampG(solver, nGnd,     nGnd,     gComp2);

      // ------------------------------------------------------------------
      // Sub-component 4: Output stage (DigitalOutputPinModel)
      // Norton equivalent driving OUT toward V_OH or V_OL through R_out.
      // ------------------------------------------------------------------
      _outputPin.setLogicLevel(_flipflopQ);
      _outputPin.load(ctx);

      // ------------------------------------------------------------------
      // Sub-component 5: Discharge NPN transistor (CE path)
      // Cite: bjtload.c::BJTload — simplified CE saturation/cutoff stamp:
      //   Q=1 (off):  I_C ≈ 0 → DIS–GND: R_HIZ (off-state leakage)
      //   Q=0 (on):   V_CE → 0 (saturated) → DIS–GND: rDischarge
      // Full Gummel-Poon BJTload (createBjtElement) elided — see file header.
      // ------------------------------------------------------------------
      const rDis = _flipflopQ ? R_HIZ : Math.max(p.rDischarge, 1e-3);
      const gDis = 1 / rDis;
      stampG(solver, nDis, nDis, gDis);
      stampG(solver, nDis, nGnd, -gDis);
      stampG(solver, nGnd, nDis, -gDis);
      stampG(solver, nGnd, nGnd, gDis);
    },

    accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
      updateOutputPinLevels(ctx.voltages);
      advanceFlipflop(ctx.voltages);
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // Pin layout order: [DIS, TRIG, THR, VCC, CTRL, OUT, RST, GND]
      //
      // R-divider (upper: VCC→CTRL 5kΩ, middle: CTRL→nLower 5kΩ, lower: nLower→GND 5kΩ):
      //   I_VCC_div = G_DIV * (V_VCC − V_CTRL)
      //   I_CTRL_div = G_DIV*(V_CTRL−V_VCC) + G_DIV*(V_CTRL−V_LOWER)
      //   I_LOWER_div = G_DIV*(V_LOWER−V_CTRL) + G_DIV*(V_LOWER−V_GND)
      //
      // Comparator inputs: high-impedance (no stamp on THR/TRIG nodes)
      // Discharge (DIS↔GND via gDis)
      // Output (DigitalOutputPinModel on OUT)
      // RST: high-impedance sense input

      const vVccV  = readNode(voltages, nVcc);
      const vGndV  = readNode(voltages, nGnd);
      const vCtrlV = readNode(voltages, nCtrl);
      const vLower = nLower > 0 ? readNode(voltages, nLower) : (vCtrlV + vGndV) / 2;
      const vOut   = readNode(voltages, nOut);
      const vDis   = readNode(voltages, nDis);

      const G_DIV = 1 / R_DIV;
      const gDis  = 1 / (_flipflopQ ? R_HIZ : Math.max(p.rDischarge, 1e-3));
      const gOut  = 1 / R_OUT;
      const vOutTarget = _outputPin.currentVoltage;

      const iDis  = gDis * (vDis - vGndV);
      const iTrig = 0;
      const iThr  = 0;
      const iVcc  = G_DIV * (vVccV - vCtrlV);
      const iCtrl = G_DIV * (vCtrlV - vVccV) + G_DIV * (vCtrlV - vLower);
      const iOut  = gOut * vOut - vOutTarget * gOut;
      const iRst  = 0;
      const iGnd  = G_DIV * (vGndV - vLower)
                  + gDis  * (vGndV - vDis);

      // [DIS, TRIG, THR, VCC, CTRL, OUT, RST, GND]
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
  { xmlName: "variant",    propertyKey: "model",      convert: (v) => v },
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
    "555 Timer IC — F4b composite model (two comparators + RS flip-flop + " +
    "BJT discharge transistor + R-divider). Textbook NE555 internal schematic. " +
    "Pins: VCC, GND, TRIG, THR, CTRL, RST, DIS, OUT.",

  factory(props: PropertyBag): Timer555Element {
    return new Timer555Element(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    "bipolar": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props) =>
        createTimer555Element(pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: TIMER555_PARAM_DEFS,
      params: { vDrop: 1.5, rDischarge: 10 },
      getInternalNodeCount: () => 3,
    },
    "cmos": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props) =>
        createTimer555Element(pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: TIMER555_PARAM_DEFS,
      params: { vDrop: 0.1, rDischarge: 10 },
      getInternalNodeCount: () => 3,
    },
  },
  defaultModel: "bipolar",
};
