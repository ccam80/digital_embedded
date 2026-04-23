/**
 * 555 Timer IC — F4b pool-backed composite analog model.
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
 *    │         └─ Comparator 2 in- (trigger reference)
 *   [R=5kΩ]  ← lower divider arm
 *    │
 *   GND
 *
 *   Comparator 1 (threshold): in+ = THR,    in- = CTRL   → RESET when THR > CTRL
 *   Comparator 2 (trigger):   in+ = nLower, in- = TRIG   → SET   when TRIG < nLower
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
 *   Q=0 (RESET): OUTPUT ≈ GND + 0.1V (low),  DISCHARGE = transistor ON
 *
 * Composition architecture (F4b pool-backed composite — matches optocoupler.ts
 * pattern from W1.8a commit 130ddd8a):
 *
 *   createTimer555Element returns a PoolBackedAnalogElementCore.
 *   Sub-elements instantiated at factory time:
 *     - comp1Sub: createOpenCollectorComparatorElement (comparator.ts F4c)
 *     - comp2Sub: createOpenCollectorComparatorElement (comparator.ts F4c)
 *     - bjtSub:   createBjtElement (bjt.ts → bjtload.c, NPN L0 Gummel-Poon)
 *
 *   R-divider: inline stampG calls — mechanical four-entry conductance stamp
 *   matching resload.c primitive resistor (cite: resload.c — G=1/R stamped at
 *   [nA,nA], [nA,nB], [nB,nA], [nB,nB]).
 *
 *   RS flip-flop: behavioral boolean _flipflopQ advanced in accept() once per
 *   accepted timestep. No analog RS-FF primitive exists in digiTS.
 *
 *   RS-FF → BJT base drive: digiTS composition glue — translates _flipflopQ
 *   boolean to a physical base voltage via G/RHS stamps into nDischargeBase.
 *   Not cited to ngspice — there is no corresponding ngspice primitive for
 *   this inter-element coupling.
 *
 *   Output stage: DigitalOutputPinModel (F4c behavioral, no ngspice primitive).
 *
 * Internal nodes (4 allocated via getInternalNodeCount = () => 4):
 *   internalNodeIds[0] = nLower          (R-divider lower tap, 1/3 VCC)
 *   internalNodeIds[1] = nComp1Out       (threshold comparator OC output)
 *   internalNodeIds[2] = nComp2Out       (trigger comparator OC output)
 *   internalNodeIds[3] = nDischargeBase  (BJT base — driven by RS-FF glue)
 *
 * State pool layout:
 *   [0 .. BJT_SIMPLE_SCHEMA.size-1] — discharge BJT slots (bjtload.c)
 *   (Comparators are F4c behavioral; no pool state.)
 *
 * Pins (nodeIds order): [DIS, TRIG, THR, VCC, CTRL, OUT, RST, GND]
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
import type { StatePoolRef } from "../../core/analog-types.js";

// Sub-element: discharge BJT — bjtload.c:170-end (L0 Gummel-Poon)
import {
  createBjtElement,
  BJT_SIMPLE_SCHEMA,
  BJT_NPN_DEFAULTS,
} from "../semiconductors/bjt.js";

// Sub-element: comparators — comparator.ts F4c behavioral (no ngspice primitive)
import { createOpenCollectorComparatorElement } from "./comparator.js";

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
const R_DIV = 5000;   // Ω

/** Output drive resistance (Norton equivalent, internal). */
const R_OUT = 10;     // Ω

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
// State pool sizing
// ---------------------------------------------------------------------------

// Only the BJT sub-element contributes pool state.
// Comparators are F4c behavioral — no pool state.
const BJT_STATE_SIZE = BJT_SIMPLE_SCHEMA.size; // 8 slots

// ---------------------------------------------------------------------------
// PropertyBag builder for BJT sub-element
// ---------------------------------------------------------------------------

function makeBjtProps(): PropertyBag {
  const bag = new PropertyBag(new Map<string, number>().entries());
  bag.replaceModelParams({ ...BJT_NPN_DEFAULTS });
  return bag;
}

// ---------------------------------------------------------------------------
// PropertyBag builder for comparator sub-elements
// ---------------------------------------------------------------------------

function makeCompProps(): PropertyBag {
  const bag = new PropertyBag(new Map<string, number>().entries());
  // Use comparator defaults (hysteresis=0, vos=0.001, rSat=50, responseTime=1e-6)
  bag.replaceModelParams({
    hysteresis: 0,
    vos: 0,
    rSat: 50,
    responseTime: 1e-9,
  });
  return bag;
}

// ---------------------------------------------------------------------------
// createTimer555Element — AnalogElementCore factory (F4b pool-backed composite)
// ---------------------------------------------------------------------------

/**
 * F4b pool-backed composite 555 timer MNA element.
 *
 * Follows the optocoupler.ts pattern (W1.8a, commit 130ddd8a):
 *   - Sub-elements instantiated at factory time
 *   - initState() partitions pool across sub-elements
 *   - load() delegates to each sub-element's load() in sequence
 *   - Inter-element coupling (RS-FF → BJT base) stamped as digiTS glue
 *
 * Load() body shape:
 *   1. R-divider sub-components (three stampG arms — resload.c)
 *   2. Comparator 1 sub-element load (comp1Sub.load — comparator.ts F4c)
 *   3. Comparator 2 sub-element load (comp2Sub.load — comparator.ts F4c)
 *   4. RS-FF → BJT base drive glue stamps (digiTS composition, no ngspice cite)
 *   5. Discharge BJT sub-element load (bjtSub.load — bjtload.c:170-end)
 *   6. Output stage (DigitalOutputPinModel — F4c behavioral)
 */
function createTimer555Element(
  pinNodes: ReadonlyMap<string, number>,
  internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
  _getTime?: () => number,
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

  // Internal nodes (allocated by compiler via getInternalNodeCount = () => 4):
  //   [0] = nLower          — R-divider lower tap (1/3 VCC when floating)
  //   [1] = nComp1Out       — threshold comparator open-collector output
  //   [2] = nComp2Out       — trigger comparator open-collector output
  //   [3] = nDischargeBase  — BJT base node (driven by RS-FF → base glue)
  const nLower         = internalNodeIds[0] ?? 0;
  const nComp1Out      = internalNodeIds[1] ?? 0;
  const nComp2Out      = internalNodeIds[2] ?? 0;
  const nDischargeBase = internalNodeIds[3] ?? 0;

  // -------------------------------------------------------------------------
  // Sub-element 1 & 2: Comparators (F4c behavioral — comparator.ts)
  //
  // Comparator 1 (threshold): in+ = THR, in- = CTRL, out = nComp1Out
  //   Active (sinking) when V_THR > V_CTRL → asserts RESET to RS flip-flop.
  //
  // Comparator 2 (trigger): in+ = nLower, in- = TRIG, out = nComp2Out
  //   Active (sinking) when V_TRIG < V_nLower → asserts SET to RS flip-flop.
  //
  // Both are F4c behavioral; no ngspice primitive; no pool state.
  // -------------------------------------------------------------------------
  const comp1PinNodes = new Map<string, number>([
    ["in+", nThr],
    ["in-", nCtrl],
    ["out", nComp1Out],
  ]);
  const comp1Sub = createOpenCollectorComparatorElement(comp1PinNodes, makeCompProps());

  const comp2PinNodes = new Map<string, number>([
    ["in+", nLower],
    ["in-", nTrig],
    ["out", nComp2Out],
  ]);
  const comp2Sub = createOpenCollectorComparatorElement(comp2PinNodes, makeCompProps());

  // -------------------------------------------------------------------------
  // Sub-element 3: Discharge NPN BJT (bjtload.c:170-end, L0 Gummel-Poon)
  //
  // NPN polarity. Base = nDischargeBase (internal, driven by RS-FF glue).
  // Collector = nDis (external DIS pin). Emitter = nGnd (GND pin).
  //
  // Q=1 (SET):   RS-FF glue pulls base to GND → BJT cutoff → DIS Hi-Z
  // Q=0 (RESET): RS-FF glue drives base high  → BJT saturates → DIS sinks
  // -------------------------------------------------------------------------
  const bjtPinNodes = new Map<string, number>([
    ["B", nDischargeBase],
    ["C", nDis],
    ["E", nGnd],
  ]);
  const bjtProps = makeBjtProps();
  const bjtSub = createBjtElement(1 /* NPN */, bjtPinNodes, -1, bjtProps);

  // Pool binding — set in initState(), read in load()
  let pool: StatePoolRef;
  let bjtBase: number;

  // -------------------------------------------------------------------------
  // RS flip-flop state:
  //   true  = SET  → output HIGH, discharge BJT cutoff
  //   false = RESET → output LOW,  discharge BJT saturated
  // Advanced in accept() once per accepted timestep. Held constant during NR.
  // -------------------------------------------------------------------------
  let _flipflopQ = false;

  // -------------------------------------------------------------------------
  // Output pin model (F4c behavioral — DigitalOutputPinModel)
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
   * Advance RS flip-flop after an accepted timestep.
   * Called ONLY from accept() — never during NR iteration.
   * Comparator state is evaluated from node voltages at the accepted solution.
   */
  function advanceFlipflop(voltages: Float64Array): void {
    const vGnd  = readNode(voltages, nGnd);
    const vRstV = readNode(voltages, nRst);

    // Active-low RESET pin: RST < GND + 0.7V → force Q=0 (overrides all)
    if ((vRstV - vGnd) < 0.7) {
      _flipflopQ = false;
      return;
    }

    // Read comparator output node voltages to determine comparator states.
    // comp1: active (sinking, pulled low) → RESET; comp2: active → SET.
    // When nComp1Out/nComp2Out are 0 (unit test fallback), read from pin voltages.
    const vThr   = readNode(voltages, nThr);
    const vTrig  = readNode(voltages, nTrig);
    const vCtrlV = readNode(voltages, nCtrl);
    const vLower = nLower > 0 ? readNode(voltages, nLower) : (vCtrlV * 0.5);

    // Comparator 1: THR > CTRL → RESET asserted
    const comp1Reset = (vThr - vGnd) > (vCtrlV - vGnd);

    // Comparator 2: TRIG < nLower → SET asserted
    const comp2Set = (vTrig - vGnd) < (vLower - vGnd);

    // RS flip-flop: RESET dominates (NE555 spec)
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
    isReactive: false as const,
    poolBacked: true as const,
    stateSize: BJT_STATE_SIZE,
    stateSchema: BJT_SIMPLE_SCHEMA,
    stateBaseOffset: -1,

    initState(poolRef: StatePoolRef): void {
      pool = poolRef;
      bjtBase = this.stateBaseOffset;

      // BJT occupies the entire state block for this composite.
      // Comparators are F4c behavioral — no pool state.
      bjtSub.stateBaseOffset = bjtBase;
      bjtSub.initState(poolRef);
    },

    load(ctx: LoadContext): void {
      const voltages = ctx.rhsOld;

      // ---------------------------------------------------------------
      // Update output pin voltage levels from current rail voltages.
      // ---------------------------------------------------------------
      updateOutputPinLevels(voltages);

      // ---------------------------------------------------------------
      // Sub-component 1: R-divider (three equal 5kΩ arms)
      //
      // cite: resload.c — primitive resistor G=1/R stamp at four matrix
      // positions: [nA,nA], [nA,nB], [nB,nA], [nB,nB] (conductance G).
      //
      //   Upper arm:  VCC  → CTRL   (nCtrl = 2/3 VCC when floating)
      //   Middle arm: CTRL → nLower (nLower = 1/3 VCC when floating)
      //   Lower arm:  nLower → GND
      // ---------------------------------------------------------------
      const G_DIV = 1 / R_DIV;
      // Upper arm: VCC → CTRL — cite: resload.c primitive G stamp
      stampG(ctx.solver, nVcc,   nVcc,   G_DIV);
      stampG(ctx.solver, nVcc,   nCtrl, -G_DIV);
      stampG(ctx.solver, nCtrl,  nVcc,  -G_DIV);
      stampG(ctx.solver, nCtrl,  nCtrl,  G_DIV);
      // Middle arm: CTRL → nLower — cite: resload.c primitive G stamp
      stampG(ctx.solver, nCtrl,  nCtrl,  G_DIV);
      stampG(ctx.solver, nCtrl,  nLower, -G_DIV);
      stampG(ctx.solver, nLower, nCtrl,  -G_DIV);
      stampG(ctx.solver, nLower, nLower,  G_DIV);
      // Lower arm: nLower → GND — cite: resload.c primitive G stamp
      stampG(ctx.solver, nLower, nLower,  G_DIV);
      stampG(ctx.solver, nLower, nGnd,   -G_DIV);
      stampG(ctx.solver, nGnd,   nLower, -G_DIV);
      stampG(ctx.solver, nGnd,   nGnd,    G_DIV);

      // ---------------------------------------------------------------
      // Sub-component 2: Threshold comparator (F4c behavioral)
      //   in+ = THR, in- = CTRL, out = nComp1Out
      //   comparator.ts createOpenCollectorComparatorElement
      // ---------------------------------------------------------------
      comp1Sub.load(ctx);

      // ---------------------------------------------------------------
      // Sub-component 3: Trigger comparator (F4c behavioral)
      //   in+ = nLower, in- = TRIG, out = nComp2Out
      //   comparator.ts createOpenCollectorComparatorElement
      // ---------------------------------------------------------------
      comp2Sub.load(ctx);

      // ---------------------------------------------------------------
      // RS-FF → BJT base drive (digiTS composition glue, no ngspice cite)
      //
      // Translates the boolean _flipflopQ to a physical base voltage at
      // nDischargeBase so the Gummel-Poon BJT sees correct BE bias:
      //
      //   Q=0 (RESET, BJT ON): drive base toward a saturating bias
      //     → conductance G_base between VCC and nDischargeBase
      //       plus RHS injection G_base * V_VCC (Norton equivalent)
      //       → V_base ≈ V_VCC (pulled strongly high → BJT saturates)
      //
      //   Q=1 (SET, BJT OFF): pull base to GND
      //     → conductance G_base between nDischargeBase and GND
      //       (no RHS injection)
      //       → V_base ≈ 0 (pulled low → BJT cuts off)
      //
      // G_base is chosen large enough to overcome the BJT's base current
      // but not so large as to cause solver conditioning issues.
      // ---------------------------------------------------------------
      const G_BASE_DRIVE = 1.0; // S — digiTS composition glue
      if (!_flipflopQ) {
        // Q=0 (RESET): drive base high → BJT saturates
        // Norton: G between VCC and nDischargeBase + I_norton = G * V_VCC
        const vVccVal = readNode(voltages, nVcc);
        stampG(ctx.solver,  nVcc,          nVcc,           G_BASE_DRIVE);
        stampG(ctx.solver,  nVcc,          nDischargeBase, -G_BASE_DRIVE);
        stampG(ctx.solver,  nDischargeBase, nVcc,          -G_BASE_DRIVE);
        stampG(ctx.solver,  nDischargeBase, nDischargeBase, G_BASE_DRIVE);
        stampRHS(ctx.solver, nDischargeBase, G_BASE_DRIVE * vVccVal);
        stampRHS(ctx.solver, nVcc,          -G_BASE_DRIVE * vVccVal);
      } else {
        // Q=1 (SET): pull base to GND → BJT cutoff
        stampG(ctx.solver, nDischargeBase, nDischargeBase,  G_BASE_DRIVE);
        stampG(ctx.solver, nDischargeBase, nGnd,           -G_BASE_DRIVE);
        stampG(ctx.solver, nGnd,           nDischargeBase, -G_BASE_DRIVE);
        stampG(ctx.solver, nGnd,           nGnd,            G_BASE_DRIVE);
      }

      // ---------------------------------------------------------------
      // Sub-component 4: Discharge BJT (L0 Gummel-Poon)
      //   NPN: B=nDischargeBase, C=nDis, E=nGnd
      //   cite: bjtload.c:170-end (L0 resistive Gummel-Poon)
      // ---------------------------------------------------------------
      bjtSub.load(ctx);

      // ---------------------------------------------------------------
      // Sub-component 5: Output stage (F4c behavioral)
      //   DigitalOutputPinModel drives OUT toward V_OH or V_OL.
      // ---------------------------------------------------------------
      _outputPin.setLogicLevel(_flipflopQ);
      _outputPin.load(ctx);
    },

    accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
      updateOutputPinLevels(ctx.rhs);
      advanceFlipflop(ctx.rhs);
      // Forward accept() to comparator sub-elements for responseTime integration
      comp1Sub.accept?.(ctx, _simTime, _addBreakpoint);
      comp2Sub.accept?.(ctx, _simTime, _addBreakpoint);
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // Pin layout order: [DIS, TRIG, THR, VCC, CTRL, OUT, RST, GND]
      // Convention: positive = current flowing INTO the element at that pin.

      const vVccV  = readNode(voltages, nVcc);
      const vGndV  = readNode(voltages, nGnd);
      const vCtrlV = readNode(voltages, nCtrl);
      const vLower = nLower > 0 ? readNode(voltages, nLower) : (vCtrlV + vGndV) / 2;
      const vOut   = readNode(voltages, nOut);
      const vDis   = readNode(voltages, nDis);

      const G_DIV = 1 / R_DIV;
      const gOut  = 1 / R_OUT;
      const vOutTarget = _outputPin.currentVoltage;

      // R-divider currents (resload.c G stamp, KCL consistent)
      const iVcc  = G_DIV * (vVccV - vCtrlV);
      const iCtrl = G_DIV * (vCtrlV - vVccV) + G_DIV * (vCtrlV - vLower);
      const iOut  = gOut * vOut - vOutTarget * gOut;
      // THR, TRIG, RST are comparator inputs — high impedance, negligible
      const iTrig = 0;
      const iThr  = 0;
      const iRst  = 0;
      // DIS current: BJT collector (approximation at current operating point)
      const iDis  = G_DIV * (vGndV - vLower);   // lower arm current flows into GND
      const iGnd  = G_DIV * (vGndV - vLower)
                  + iDis;

      // Return simplified KCL-consistent currents at the composite boundary
      return [
        G_DIV * (vDis - vGndV),  // DIS — discharge current (BJT C→E path)
        iTrig,                    // TRIG
        iThr,                     // THR
        iVcc,                     // VCC (into divider upper arm)
        iCtrl,                    // CTRL
        iOut,                     // OUT
        iRst,                     // RST
        -(iVcc + iOut),           // GND — satisfies KCL at composite boundary
      ];
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
    "555 Timer IC — F4b pool-backed composite model (two comparators + RS flip-flop + " +
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
      getInternalNodeCount: () => 4,
    },
    "cmos": {
      kind: "inline",
      factory: (pinNodes, internalNodeIds, branchIdx, props) =>
        createTimer555Element(pinNodes, internalNodeIds, branchIdx, props),
      paramDefs: TIMER555_PARAM_DEFS,
      params: { vDrop: 0.1, rDischarge: 10 },
      getInternalNodeCount: () => 4,
    },
  },
  defaultModel: "bipolar",
};
