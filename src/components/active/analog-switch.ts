/**
 * Analog Switch components â€” SPST and SPDT.
 *
 * SPST (Single-Pole Single-Throw) â€” direct port of ngspice SW (VSWITCH) primitive.
 *   Reference: ref/ngspice/src/spicelib/devices/sw/swload.c (SWload)
 *              ref/ngspice/src/spicelib/devices/sw/swdefs.h  (SWmodel, SWinstance)
 *
 *   Control voltage evaluated as: v_ctrl = V(ctrl) - V(0)
 *     (ngspice: CKTrhsOld[SWposCntrlNode] - CKTrhsOld[SWnegCntrlNode]; digiTS ctrl
 *      is single-ended so negCntrlNode = 0 = ground. swload.c:43-44.)
 *
 *   State machine (two state slots, SW_NUM_STATES=2, swdefs.h:56):
 *     states[0][base+0]: current_state (0=REALLY_OFF, 1=REALLY_ON, 2=HYST_OFF, 3=HYST_ON)
 *     states[0][base+1]: v_ctrl saved at load time (swload.c:141)
 *
 *   Conductance stamp (swload.c:143-152):
 *     If current_state == REALLY_ON or HYST_ON: g_now = 1/Ron  (SWonConduct, swdefs.h:72)
 *     Else:                                      g_now = 1/Roff (SWoffConduct, swdefs.h:73)
 *     Stamped as four-entry conductance between nIn and nOut.
 *
 * SPDT (Single-Pole Double-Throw) â€” digiTS extension beyond ngspice SW primitive.
 *   // digiTS extension beyond ngspice SW primitive â€” see F4b-composite discussion
 *   ngspice has no dual-throw voltage-controlled switch primitive. SPDT is modelled
 *   as two complementary SPST SW instances sharing a control voltage:
 *   COM-NO path uses the same threshold logic as SPST;
 *   COM-NC path uses inverted polarity (on when ctrl < threshold, i.e. v_ctrl negated).
 *   Each path carries its own state slot pair (4 state slots total).
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
import type { LoadContext, StatePoolRef, PoolBackedAnalogElementCore } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/element.js";
import { defineModelParams } from "../../core/model-params.js";
import {
  defineStateSchema,
  applyInitialValues,
  type StateSchema,
} from "../../solver/analog/state-schema.js";
import {
  MODEINITFIX,
  MODEINITJCT,
  MODEINITSMSIG,
  MODEINITFLOAT,
  MODEINITTRAN,
  MODEINITPRED,
} from "../../solver/analog/ckt-mode.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// swdefs.h: SWonResistance, SWoffResistance, SWvThreshold, SWvHysteresis
// ---------------------------------------------------------------------------

export const { paramDefs: ANALOG_SWITCH_PARAM_DEFS, defaults: ANALOG_SWITCH_DEFAULTS } = defineModelParams({
  primary: {
    rOn:          { default: 1,    unit: "Î©",  description: "On-state resistance (SWonResistance, swdefs.h:68)" },
    rOff:         { default: 1e9,  unit: "Î©",  description: "Off-state resistance (SWoffResistance, swdefs.h:69)" },
    vThreshold:   { default: 1.65, unit: "V",  description: "Switching threshold voltage (SWvThreshold, swdefs.h:70)" },
    vHysteresis:  { default: 0,    unit: "V",  description: "Switching hysteresis voltage (SWvHysteresis, swdefs.h:71)" },
  },
});

// ---------------------------------------------------------------------------
// State-pool schema â€” SW_NUM_STATES = 2 (swdefs.h:56)
// ---------------------------------------------------------------------------

// State sentinel values matching swload.c:28-29
const REALLY_OFF = 0;
const REALLY_ON  = 1;
const HYST_OFF   = 2;
const HYST_ON    = 3;

// Slot indices within a 2-slot SW path (swload.c:140-141)
const SLOT_STATE  = 0;
const SLOT_V_CTRL = 1;

/**
 * State schema for one SW path (SPST or one path of SPDT).
 * SW_NUM_STATES = 2 (swdefs.h:56).
 */
export const SW_SCHEMA: StateSchema = defineStateSchema("SWElement", [
  { name: "CURRENT_STATE", doc: "Switch state sentinel: REALLY_OFF=0, REALLY_ON=1, HYST_OFF=2, HYST_ON=3 (swload.c:28-29)", init: { kind: "constant", value: REALLY_OFF } },
  { name: "V_CTRL",        doc: "Control voltage saved at load time (swload.c:141)",                                            init: { kind: "zero" } },
]);

/**
 * State schema for the SPDT element (two complementary SW paths = 4 slots).
 * // digiTS extension beyond ngspice SW primitive â€” see F4b-composite discussion
 */
export const SPDT_SCHEMA: StateSchema = defineStateSchema("SWElementSPDT", [
  { name: "NO_CURRENT_STATE", doc: "COM-NO path switch state (swload.c:28-29 sentinel)", init: { kind: "constant", value: REALLY_OFF } },
  { name: "NO_V_CTRL",        doc: "COM-NO path saved control voltage (swload.c:141)",    init: { kind: "zero" } },
  { name: "NC_CURRENT_STATE", doc: "COM-NC path switch state (inverted polarity) â€” digiTS extension beyond ngspice SW primitive", init: { kind: "constant", value: REALLY_ON } },
  { name: "NC_V_CTRL",        doc: "COM-NC path saved control voltage (inverted) â€” digiTS extension beyond ngspice SW primitive", init: { kind: "zero" } },
]);

// ---------------------------------------------------------------------------
// Core SW stamp function â€” maps to SWload body (swload.c:40-152)
// ---------------------------------------------------------------------------

/**
 * Evaluate switch state and stamp conductance for one SW path.
 *
 * Implements SWload:
 *   - swload.c:40-41: read old_current_state (states[0]) and previous_state (states[1])
 *   - swload.c:43-44: compute v_ctrl from positive/negative control nodes
 *   - swload.c:48-133: state machine per cktMode
 *   - swload.c:140-141: write states[0][SWstate], states[0][SWstate+1]
 *   - swload.c:143-152: select g_now, stamp four conductance matrix entries
 *
 * @param ctx          LoadContext for this NR iteration
 * @param pool         StatePoolRef for this element
 * @param base         Slot base offset into pool.states[N]
 * @param nPos         Positive signal node (1-based; 0 = ground)
 * @param nNeg         Negative signal node (1-based; 0 = ground)
 * @param nCtrl        Positive control node (1-based; 0 = ground)
 * @param gOn          On-state conductance = 1/Ron  (SWonConduct, swdefs.h:72)
 * @param gOff         Off-state conductance = 1/Roff (SWoffConduct, swdefs.h:73)
 * @param vThreshold   Switching threshold voltage (SWvThreshold, swdefs.h:70)
 * @param vHysteresis  Switching hysteresis magnitude (SWvHysteresis, swdefs.h:71)
 * @param zeroStateGiven Initial-condition flag (SWzero_stateGiven, swdefs.h:44):
 *   true = device starts ON; false = device starts OFF.
 * @param invertCtrl   When true, negate v_ctrl before threshold comparison.
 *   // digiTS extension beyond ngspice SW primitive â€” see F4b-composite discussion
 *   Used for the COM-NC path of SPDT to give complementary switching.
 */
function swLoad(
  ctx: LoadContext,
  pool: StatePoolRef,
  base: number,
  nPos: number,
  nNeg: number,
  nCtrl: number,
  gOn: number,
  gOff: number,
  vThreshold: number,
  vHysteresis: number,
  zeroStateGiven: boolean,
  invertCtrl: boolean,
): void {
  // swload.c:40-41 â€” read old_current_state from states[0] and previous_state from states[1]
  // Pool arrays read at call time; never cached as member variables (A4 pattern).
  const s0 = pool.states[0];
  const s1 = pool.states[1];

  const old_current_state: number = s0[base + SLOT_STATE];
  const previous_state: number    = s1 !== undefined ? s1[base + SLOT_STATE] : REALLY_OFF;

  // swload.c:43-44 â€” control voltage between positive and negative control nodes
  // digiTS: ctrl is single-ended (negCntrlNode = 0 = ground):
  //   v_ctrl = voltages[nCtrl] - 0
  // invertCtrl for SPDT COM-NC path:
  // // digiTS extension beyond ngspice SW primitive â€” see F4b-composite discussion
  const voltages = ctx.rhsOld;
  let v_ctrl = voltages[nCtrl];
  if (invertCtrl) v_ctrl = -v_ctrl;

  // swload.c:48-133 â€” mode-dispatched state machine
  let current_state: number;
  const cktMode = ctx.cktMode;

  if (cktMode & (MODEINITFIX | MODEINITJCT)) {
    // swload.c:48-65: cold-start initial condition
    if (zeroStateGiven) {
      // switch specified "on" (SWzero_stateGiven = true, swdefs.h:44)
      if ((vHysteresis >= 0) && (v_ctrl > (vThreshold + vHysteresis)))
        current_state = REALLY_ON;
      else if ((vHysteresis < 0) && (v_ctrl > (vThreshold - vHysteresis)))
        current_state = REALLY_ON;
      else
        current_state = HYST_ON;
    } else {
      // switch specified "off" (default, SWzero_stateGiven = false)
      if ((vHysteresis >= 0) && (v_ctrl < (vThreshold - vHysteresis)))
        current_state = REALLY_OFF;
      else if ((vHysteresis < 0) && (v_ctrl < (vThreshold + vHysteresis)))
        current_state = REALLY_OFF;
      else
        current_state = HYST_OFF;
    }

  } else if (cktMode & MODEINITSMSIG) {
    // swload.c:67-69: AC small-signal â€” freeze at previous accepted state
    current_state = previous_state;

  } else if (cktMode & MODEINITFLOAT) {
    // swload.c:71-105: normal NR iteration â€” hysteresis comparator
    if (vHysteresis > 0) {
      // swload.c:74-80: positive hysteresis
      if (v_ctrl > (vThreshold + vHysteresis)) {
        current_state = REALLY_ON;
      } else if (v_ctrl < (vThreshold - vHysteresis)) {
        current_state = REALLY_OFF;
      } else {
        // in hysteresis band â€” hold old_current_state (swload.c:80)
        current_state = old_current_state;
      }
    } else {
      // swload.c:82-100: negative hysteresis case
      if (v_ctrl > (vThreshold - vHysteresis)) {
        current_state = REALLY_ON;
      } else if (v_ctrl < (vThreshold + vHysteresis)) {
        current_state = REALLY_OFF;
      } else {
        // in hysteresis region â€” propagate from previous state (swload.c:89-99)
        if ((previous_state === HYST_OFF) || (previous_state === HYST_ON)) {
          current_state = previous_state;
        } else if (previous_state === REALLY_ON) {
          current_state = HYST_OFF;
        } else if (previous_state === REALLY_OFF) {
          current_state = HYST_ON;
        } else {
          current_state = HYST_OFF; // unreachable in normal flow
        }
      }
    }

    // swload.c:102-105: increment CKTnoncon if state changed (forces one more iteration)
    if (current_state !== old_current_state) {
      ctx.noncon.value++;
    }

  } else if (cktMode & (MODEINITTRAN | MODEINITPRED)) {
    // swload.c:108-133: transient predictor / first-transient step
    if (vHysteresis > 0) {
      // swload.c:110-116: positive hysteresis
      if (v_ctrl > (vThreshold + vHysteresis))
        current_state = REALLY_ON;
      else if (v_ctrl < (vThreshold - vHysteresis))
        current_state = REALLY_OFF;
      else
        current_state = previous_state;
    } else {
      // swload.c:117-132: negative hysteresis
      if (v_ctrl > (vThreshold - vHysteresis))
        current_state = REALLY_ON;
      else if (v_ctrl < (vThreshold + vHysteresis))
        current_state = REALLY_OFF;
      else {
        current_state = 0;
        if ((previous_state === HYST_ON) || (previous_state === HYST_OFF)) {
          current_state = previous_state;
        } else if (previous_state === REALLY_ON) {
          current_state = REALLY_OFF;
        } else if (previous_state === REALLY_OFF) {
          current_state = REALLY_ON;
        }
      }
    }

  } else {
    // Unrecognised cktMode â€” hold existing state
    current_state = old_current_state;
  }

  // swload.c:140-141: write back current_state and v_ctrl to states[0]
  s0[base + SLOT_STATE]  = current_state;
  s0[base + SLOT_V_CTRL] = v_ctrl;

  // swload.c:143-152: select conductance and stamp four-entry MNA matrix entries
  // SWonConduct = 1/Ron; SWoffConduct = 1/Roff (swdefs.h:72-73)
  const g_now = ((current_state === REALLY_ON) || (current_state === HYST_ON))
    ? gOn
    : gOff;

  const solver = ctx.solver;
  if (nPos > 0) {
    solver.stampElement(solver.allocElement(nPos, nPos), g_now);   // swload.c:149 SWposPosptr
  }
  if (nNeg > 0) {
    solver.stampElement(solver.allocElement(nNeg, nNeg), g_now);   // swload.c:152 SWnegNegptr
  }
  if (nPos > 0 && nNeg > 0) {
    solver.stampElement(solver.allocElement(nPos, nNeg), -g_now);  // swload.c:150 SWposNegptr
    solver.stampElement(solver.allocElement(nNeg, nPos), -g_now);  // swload.c:151 SWnegPosptr
  }
}

// ---------------------------------------------------------------------------
// createSwitchSPSTElement â€” AnalogElement factory (SPST)
// Direct port of ngspice SW (VSWITCH) primitive. swload.c, swdefs.h.
// ---------------------------------------------------------------------------

function createSwitchSPSTElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
): PoolBackedAnalogElementCore {
  const nIn   = pinNodes.get("in")!;   // positive signal node (SWposNode, swdefs.h:28)
  const nOut  = pinNodes.get("out")!;  // negative signal node (SWnegNode, swdefs.h:29)
  const nCtrl = pinNodes.get("ctrl")!; // positive control node (SWposCntrlNode, swdefs.h:30)

  // p holds mutable params for hot-loadable setParam()
  const p: Record<string, number> = {
    rOn:         props.getModelParam<number>("rOn"),
    rOff:        props.getModelParam<number>("rOff"),
    vThreshold:  props.getModelParam<number>("vThreshold"),
    vHysteresis: props.getModelParam<number>("vHysteresis"),
  };

  // Pool binding â€” reference held after initState(); individual state arrays
  // read via pool.states[N] at call time. Mirrors ngspice CKTstate0/1 pointer
  // access (cktload.c never caches state pointers on devices).
  let pool: StatePoolRef;
  let base: number; // = stateBaseOffset, set by initState()

  return {
    branchIndex: -1,
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.SW,
    isNonlinear: true,
    isReactive: false,
    poolBacked: true as const,
    stateSize: SW_SCHEMA.size,   // 2 (SW_NUM_STATES, swdefs.h:56)
    stateSchema: SW_SCHEMA,
    stateBaseOffset: -1,         // set by compiler (compiler.ts:1388)
    s0: new Float64Array(0), s1: new Float64Array(0), s2: new Float64Array(0), s3: new Float64Array(0),
    s4: new Float64Array(0), s5: new Float64Array(0), s6: new Float64Array(0), s7: new Float64Array(0),

    initState(poolRef: StatePoolRef): void {
      pool = poolRef;
      base = this.stateBaseOffset;
      applyInitialValues(SW_SCHEMA, pool, base, p);
    },

    load(ctx: LoadContext): void {
      const rOnNow  = Math.max(p.rOn, 1e-3);
      const rOffNow = Math.max(p.rOff, rOnNow * 2);
      swLoad(
        ctx, pool, base,
        nIn, nOut, nCtrl,
        1 / rOnNow,           // SWonConduct = 1/Ron, swdefs.h:72
        1 / rOffNow,          // SWoffConduct = 1/Roff, swdefs.h:73
        p.vThreshold,         // SWvThreshold, swdefs.h:70
        p.vHysteresis,        // SWvHysteresis, swdefs.h:71
        false,                // SWzero_stateGiven = false (default: starts OFF), swdefs.h:44
        false,                // invertCtrl = false (SPST: direct control)
      );
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // Pin layout order: in, out, ctrl.
      // Conductance g_now stamped between nIn and nOut; ctrl has no stamp.
      const current_state = pool.states[0][base + SLOT_STATE];
      const rOnNow  = Math.max(p.rOn, 1e-3);
      const rOffNow = Math.max(p.rOff, rOnNow * 2);
      const g_now = ((current_state === REALLY_ON) || (current_state === HYST_ON))
        ? 1 / rOnNow
        : 1 / rOffNow;
      const vIn  = voltages[nIn];
      const vOut = voltages[nOut];
      const iThrough = g_now * (vIn - vOut);
      return [iThrough, -iThrough, 0];
    },

    setParam(key: string, value: number): void {
      if (key in p) p[key] = value;
    },
  };
}

// ---------------------------------------------------------------------------
// createSwitchSPDTElement â€” AnalogElement factory (SPDT)
// digiTS extension beyond ngspice SW primitive â€” see F4b-composite discussion.
// Two complementary SW paths sharing one control voltage:
//   COM-NO path: normal polarity (closes when v_ctrl > vThreshold)
//   COM-NC path: inverted polarity (closes when v_ctrl < vThreshold)
// State layout (4 slots total):
//   [base+0]: NO_CURRENT_STATE, [base+1]: NO_V_CTRL  â€” COM-NO path
//   [base+2]: NC_CURRENT_STATE, [base+3]: NC_V_CTRL  â€” COM-NC path
// ---------------------------------------------------------------------------

function createSwitchSPDTElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
): PoolBackedAnalogElementCore {
  const nCom  = pinNodes.get("com")!;  // common terminal
  const nNO   = pinNodes.get("no")!;   // normally-open terminal
  const nNC   = pinNodes.get("nc")!;   // normally-closed terminal
  const nCtrl = pinNodes.get("ctrl")!; // control terminal

  const p: Record<string, number> = {
    rOn:         props.getModelParam<number>("rOn"),
    rOff:        props.getModelParam<number>("rOff"),
    vThreshold:  props.getModelParam<number>("vThreshold"),
    vHysteresis: props.getModelParam<number>("vHysteresis"),
  };

  let pool: StatePoolRef;
  let base: number;

  return {
    branchIndex: -1,
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.SW,
    isNonlinear: true,
    isReactive: false,
    poolBacked: true as const,
    stateSize: SPDT_SCHEMA.size,   // 4 (two SW paths Ã— 2 slots each)
    stateSchema: SPDT_SCHEMA,
    stateBaseOffset: -1,
    s0: new Float64Array(0),
    s1: new Float64Array(0),
    s2: new Float64Array(0),
    s3: new Float64Array(0),
    s4: new Float64Array(0),
    s5: new Float64Array(0),
    s6: new Float64Array(0),
    s7: new Float64Array(0),

    initState(poolRef: StatePoolRef): void {
      pool = poolRef;
      base = this.stateBaseOffset;
      this.s0 = poolRef.state0; this.s1 = poolRef.state1; this.s2 = poolRef.state2; this.s3 = poolRef.state3;
      this.s4 = poolRef.state4; this.s5 = poolRef.state5; this.s6 = poolRef.state6; this.s7 = poolRef.state7;
      applyInitialValues(SPDT_SCHEMA, pool, base, p);
    },

    load(ctx: LoadContext): void {
      const rOnNow  = Math.max(p.rOn, 1e-3);
      const rOffNow = Math.max(p.rOff, rOnNow * 2);
      const gOn  = 1 / rOnNow;   // SWonConduct, swdefs.h:72
      const gOff = 1 / rOffNow;  // SWoffConduct, swdefs.h:73

      // COM-NO path: normal polarity SW (swload.c semantics, slots base+0..base+1)
      swLoad(
        ctx, pool, base,
        nCom, nNO, nCtrl, gOn, gOff,
        p.vThreshold, p.vHysteresis,
        false,  // SWzero_stateGiven=false: NO path starts OFF (normally open)
        false,  // invertCtrl=false: normal polarity
      );

      // COM-NC path: inverted polarity SW (slots base+2..base+3)
      // // digiTS extension beyond ngspice SW primitive â€” see F4b-composite discussion
      swLoad(
        ctx, pool, base + 2,
        nCom, nNC, nCtrl, gOn, gOff,
        p.vThreshold, p.vHysteresis,
        true,   // SWzero_stateGiven=true: NC path starts ON (normally closed)
        true,   // invertCtrl=true: complementary polarity
      );
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // Pin layout order: com, no, nc, ctrl.
      const s0_now = pool.states[0];
      const rOnNow  = Math.max(p.rOn, 1e-3);
      const rOffNow = Math.max(p.rOff, rOnNow * 2);
      const stateNO = s0_now[base + 0];
      const stateNC = s0_now[base + 2];
      const gNO = ((stateNO === REALLY_ON) || (stateNO === HYST_ON)) ? 1 / rOnNow : 1 / rOffNow;
      const gNC = ((stateNC === REALLY_ON) || (stateNC === HYST_ON)) ? 1 / rOnNow : 1 / rOffNow;
      const vCom = voltages[nCom];
      const vNo  = voltages[nNO];
      const vNc  = voltages[nNC];
      const iNO  = gNO * (vCom - vNo);
      const iNC  = gNC * (vCom - vNc);
      return [iNO + iNC, -iNO, -iNC, 0];
    },

    setParam(key: string, value: number): void {
      if (key in p) p[key] = value;
    },
  };
}

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

function buildSPSTPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "in",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "out",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "ctrl",
      defaultBitWidth: 1,
      position: { x: 2, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

function buildSPDTPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "com",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "no",
      defaultBitWidth: 1,
      position: { x: 4, y: -1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "nc",
      defaultBitWidth: 1,
      position: { x: 4, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "ctrl",
      defaultBitWidth: 1,
      position: { x: 2, y: -1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// CircuitElement classes
// ---------------------------------------------------------------------------

export class SwitchSPSTElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("SwitchSPST", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildSPSTPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 4, height: 1 };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vIn   = signals?.getPinVoltage("in");
    const vOut  = signals?.getPinVoltage("out");
    const vCtrl = signals?.getPinVoltage("ctrl");

    ctx.save();
    ctx.setLineWidth(1);

    // Blade â€” body, stays COMPONENT
    ctx.setColor("COMPONENT");
    ctx.drawLine(1, 0, 3, 0);

    // in lead
    drawColoredLead(ctx, signals, vIn, 0, 0, 1, 0);

    // out lead
    drawColoredLead(ctx, signals, vOut, 3, 0, 4, 0);

    // ctrl lead
    drawColoredLead(ctx, signals, vCtrl, 2, 1, 2, 0.5);

    ctx.restore();
  }
}

export class SwitchSPDTElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("SwitchSPDT", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildSPDTPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y - 1, width: 4, height: 2 };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vCom  = signals?.getPinVoltage("com");
    const vNo   = signals?.getPinVoltage("no");
    const vNc   = signals?.getPinVoltage("nc");

    ctx.save();
    ctx.setLineWidth(1);

    // Blade â€” body, stays COMPONENT
    ctx.setColor("COMPONENT");
    ctx.drawLine(1, 0, 3, -1);

    // COM lead
    drawColoredLead(ctx, signals, vCom, 0, 0, 1, 0);

    // NO lead
    drawColoredLead(ctx, signals, vNo, 3, -1, 4, -1);

    // NC lead
    drawColoredLead(ctx, signals, vNc, 3, 1, 4, 1);

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Property definitions (shared)
// ---------------------------------------------------------------------------

const ANALOG_SWITCH_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional display label.",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings (shared)
// ---------------------------------------------------------------------------

const ANALOG_SWITCH_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "rOn",         propertyKey: "rOn",         convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "rOff",        propertyKey: "rOff",        convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "vThreshold",  propertyKey: "vThreshold",  convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "vHysteresis", propertyKey: "vHysteresis", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Label",       propertyKey: "label",       convert: (v) => v },
];

// ---------------------------------------------------------------------------
// ComponentDefinitions
// ---------------------------------------------------------------------------

export const SwitchSPSTDefinition: ComponentDefinition = {
  name: "SwitchSPST",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildSPSTPinDeclarations(),
  propertyDefs: ANALOG_SWITCH_PROPERTY_DEFS,
  attributeMap: ANALOG_SWITCH_ATTRIBUTE_MAPPINGS,

  helpText:
    "Analog Switch (SPST) â€” three-terminal (ctrl, in, out). " +
    "Direct port of ngspice SW (VSWITCH) primitive (swload.c, swdefs.h). " +
    "Hard-switching with optional hysteresis; no tanh transition.",

  factory(props: PropertyBag): SwitchSPSTElement {
    return new SwitchSPSTElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: (pinNodes, _internalNodeIds, _branchIdx, props) =>
        createSwitchSPSTElement(pinNodes, props),
      paramDefs: ANALOG_SWITCH_PARAM_DEFS,
      params: ANALOG_SWITCH_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};

export const SwitchSPDTDefinition: ComponentDefinition = {
  name: "SwitchSPDT",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildSPDTPinDeclarations(),
  propertyDefs: ANALOG_SWITCH_PROPERTY_DEFS,
  attributeMap: ANALOG_SWITCH_ATTRIBUTE_MAPPINGS,

  helpText:
    "Analog Switch (SPDT) â€” four-terminal (ctrl, com, no, nc). " +
    "digiTS extension beyond ngspice SW primitive â€” see F4b-composite discussion. " +
    "COM-NO closes and COM-NC opens as control voltage rises through threshold.",

  factory(props: PropertyBag): SwitchSPDTElement {
    return new SwitchSPDTElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: (pinNodes, _internalNodeIds, _branchIdx, props) =>
        createSwitchSPDTElement(pinNodes, props),
      paramDefs: ANALOG_SWITCH_PARAM_DEFS,
      params: ANALOG_SWITCH_DEFAULTS,
    },
  },
  defaultModel: "behavioral",
};
