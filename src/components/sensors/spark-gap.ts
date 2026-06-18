/**
 * Spark Gap - voltage-triggered latched switch with hysteresis.
 *
 * Discrete two-state latch modelled on ngspice's SW device
 * (ref/ngspice/src/spicelib/devices/sw/swload.c):
 *   - Blocking state:    G = 1/rOff until |V| > vBreakdown (fire)
 *   - Conducting state:  G = 1/rOn  until |I| < iHold (extinguish)
 *   - Hysteresis: once fired, the latch holds conducting until the implicit
 *     holding current |I| = |V|·G drops below iHold.
 *
 * Self-controlled adaptation of swload.c: SW is externally controlled (fires on
 * another branch's V); the spark gap fires on its OWN |V| > vBreakdown and
 * extinguishes on its OWN |I| < iHold. Both thresholds fold into the swload.c
 * MODEINITFLOAT latch shape (latchState), keyed off the prior-iterate terminal
 * voltage from rhsOld.
 *
 * Per-iteration stamp is the constant conductance of the latched state
 * (swload.c:135-145), LINEAR, so each latched state converges in one iteration.
 * The latch settles within the step via the CKTnoncon++ re-iteration
 * (swload.c:94-97): load() records whether the latch flipped this pass in the
 * FLIPPED slot, and checkConvergence() returns false (forcing another NR
 * iteration) until the latch stops moving.
 *
 * MNA topology:
 *   pinNodes["pos"] = n_pos
 *   pinNodes["neg"] = n_neg
 *   branchIndex    = -1
 *
 * State-vector vintages (state-pool.ts:112-119 rotateStateVectors rotates only
 * at accepted-step boundaries): state0 carries the prior NR *iterate's* latch
 * (CKTstate0, swload.c:34), state1 carries the prior accepted *step's* latch
 * (CKTstate1).
 */

import { PoolBackedAnalogElement } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import type { DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import {
  defineStateSchema,
  type StateSchema,
} from "../../solver/analog/state-schema.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type StandaloneComponentDefinition,
} from "../../core/registry.js";
import { defineModelParams } from "../../core/model-params.js";
import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_RESISTANCE = 1e-12;

// ---------------------------------------------------------------------------
// State-pool schema
// ---------------------------------------------------------------------------

export const SPARK_GAP_SCHEMA = defineStateSchema("SparkGapElement", [
  { name: "CONDUCTING", doc: "Latch state: 1 = conducting, 0 = blocking (swload.c CKTstate0[SWswitchstate])" },
  { name: "FLIPPED",    doc: "1 if the latch flipped this NR pass; drives checkConvergence (swload.c:94 CKTnoncon++)" },
]) satisfies StateSchema;

const SLOT_CONDUCTING = 0;
const SLOT_FLIPPED    = 1;

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: SPARK_GAP_PARAM_DEFS, defaults: SPARK_GAP_DEFAULTS } = defineModelParams({
  primary: {
    vBreakdown: { default: 1000, unit: "V",   description: "Voltage at which the spark gap fires" },
    rOn:        { default: 5,    unit: "Ohm", description: "Resistance when gap is conducting" },
  },
  secondary: {
    rOff:  { default: 1e10, unit: "Ohm", description: "Resistance when gap is blocking" },
    iHold: { default: 0.01, unit: "A",   description: "Minimum current to sustain conduction" },
  },
});

// ---------------------------------------------------------------------------
// Latch state transition
// ---------------------------------------------------------------------------

/**
 * Discrete latch transition (swload.c:66-97 MODEINITFLOAT), self-controlled.
 *
 * Returns the new latch state (0 or 1) from the prior-iterate state and the
 * prior-iterate terminal voltage:
 *   - fire (return 1) when |V| > vBreakdown        (swload.c:70-71 upper threshold)
 *   - else, when conducting, extinguish (return 0) when the implicit holding
 *     current |I| = |V|·gLatched < iHold           (swload.c:72-73 lower threshold)
 *   - else hold the prior state                    (swload.c:75 hold old_current_state)
 *
 * gLatched is the constant conductance the prior-iterate state stamps
 * (1/rOn when conducting, 1/rOff when blocking), used as the self-consistent
 * current estimate.
 */
function latchState(
  conductingOld: number,
  absV: number,
  vBreakdown: number,
  iHold: number,
  gLatched: number,
): number {
  if (absV > vBreakdown) return 1;
  const absI = absV * gLatched;
  if (conductingOld && absI < iHold) return 0;
  return conductingOld;
}

// ---------------------------------------------------------------------------
// SparkGapElement - MNA implementation
// ---------------------------------------------------------------------------

export class SparkGapElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.RES;
  readonly deviceFamily: DeviceFamily = "RES";
  readonly stateSchema = SPARK_GAP_SCHEMA;
  readonly stateSize = SPARK_GAP_SCHEMA.size;

  private _hPP: number = -1; // (posNode, posNode) - swsetup.c:59
  private _hPN: number = -1; // (posNode, negNode) - swsetup.c:60
  private _hNP: number = -1; // (negNode, posNode) - swsetup.c:61
  private _hNN: number = -1; // (negNode, negNode) - swsetup.c:62

  private _vBreakdown: number;
  private _rOn: number;
  private _rOff: number;
  private _iHold: number;

  /**
   * @param pinNodes    - pin-name → node-index map (stored by reference)
   * @param vBreakdown  - Breakdown voltage in volts
   * @param rOn         - On-state resistance in ohms
   * @param rOff        - Off-state resistance in ohms
   * @param iHold       - Holding current in amps; below this the gap extinguishes
   */
  constructor(
    pinNodes: ReadonlyMap<string, number>,
    vBreakdown: number,
    rOn: number,
    rOff: number,
    iHold: number,
  ) {
    super(pinNodes);
    this._vBreakdown = Math.max(vBreakdown, 1e-6);
    this._rOn = Math.max(rOn, MIN_RESISTANCE);
    this._rOff = Math.max(rOff, 1);
    this._iHold = Math.max(iHold, 1e-12);
  }

  setup(ctx: SetupContext): void {
    if (this._stateBase === -1) {
      this._stateBase = ctx.allocStates(this.stateSize);
    }

    const solver = ctx.solver;
    const posNode = this.pinNodes.get("pos")!; // SWposNode
    const negNode = this.pinNodes.get("neg")!; // SWnegNode

    // TSTALLOC sequence: swsetup.c:59-62, line-for-line
    this._hPP = solver.allocElement(posNode, posNode); // :59 (SWposNode, SWposNode)
    this._hPN = solver.allocElement(posNode, negNode); // :60 (SWposNode, SWnegNode)
    this._hNP = solver.allocElement(negNode, posNode); // :61 (SWnegNode, SWposNode)
    this._hNN = solver.allocElement(negNode, negNode); // :62 (SWnegNode, SWnegNode)
  }

  setParam(key: string, value: number): void {
    if (key === "vBreakdown") this._vBreakdown = Math.max(value, 1e-6);
    else if (key === "rOn") this._rOn = Math.max(value, MIN_RESISTANCE);
    else if (key === "rOff") this._rOff = Math.max(value, 1);
    else if (key === "iHold") this._iHold = Math.max(value, 1e-12);
  }

  /**
   * Constant conductance of a latched state (swload.c:135-145):
   *   1/rOn when conducting, 1/rOff when blocking.
   */
  private conductanceForState(conducting: number): number {
    return 1 / Math.max(conducting ? this._rOn : this._rOff, MIN_RESISTANCE);
  }

  load(ctx: LoadContext): void {
    const base = this._stateBase;
    const s0 = this._pool.states[0];

    // Prior NR iterate's latch (swload.c:34 old_current_state = CKTstate0). Within
    // a step's NR loop, state0 carries the previous iterate's latch; at the first
    // iteration state0 has just been rotated to equal the prior accepted step.
    const conductingOld = s0[base + SLOT_CONDUCTING];

    const nPos = this.pinNodes.get("pos")!;
    const nNeg = this.pinNodes.get("neg")!;
    // swload.c:37-39: control quantity from CKTrhsOld (prior NR iterate), not CKTrhs.
    const voltages = ctx.rhsOld;
    const absV = Math.abs(voltages[nPos] - voltages[nNeg]);

    // Constant conductance the prior-iterate state stamps, used as the
    // self-consistent current estimate in the latch's extinction test.
    const gLatched = this.conductanceForState(conductingOld);

    const conductingNew = latchState(conductingOld, absV, this._vBreakdown, this._iHold, gLatched);

    // Stamp the constant conductance of the new latched state (swload.c:135-145,
    // two-valued and LINEAR per iteration).
    const G = this.conductanceForState(conductingNew);
    ctx.solver.stampElement(this._hPP,  G);
    ctx.solver.stampElement(this._hPN, -G);
    ctx.solver.stampElement(this._hNP, -G);
    ctx.solver.stampElement(this._hNN,  G);

    // Write the new latch (swload.c:132 CKTstate0) and record whether it flipped
    // this pass (swload.c:94), so checkConvergence forces a re-iterate on a flip.
    s0[base + SLOT_CONDUCTING] = conductingNew;
    s0[base + SLOT_FLIPPED] = conductingNew !== conductingOld ? 1 : 0;
  }

  /**
   * swload.c:94-97 CKTnoncon++: while the latch is still flipping, the step has
   * not converged. Returns true (converged) only once the latch holds.
   */
  checkConvergence(_ctx: LoadContext): boolean {
    return this._pool.states[0][this._stateBase + SLOT_FLIPPED] === 0;
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const nPos = this.pinNodes.get("pos")!;
    const nNeg = this.pinNodes.get("neg")!;
    const vPos = rhs[nPos];
    const vNeg = rhs[nNeg];
    const s1 = this._pool.states[1];
    const base = this._stateBase;
    const conducting = s1[base + SLOT_CONDUCTING];
    const G = this.conductanceForState(conducting);
    const I = G * (vPos - vNeg);
    return [I, -I];
  }
}

// ---------------------------------------------------------------------------
// analogFactory
// ---------------------------------------------------------------------------

export function createSparkGapElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): SparkGapElement {
  const p: Record<string, number> = {
    vBreakdown: props.getModelParam<number>("vBreakdown"),
    rOn:        props.getModelParam<number>("rOn"),
    rOff:       props.getOrDefault<number>("rOff",       SPARK_GAP_DEFAULTS.rOff),
    iHold:      props.getOrDefault<number>("iHold",      SPARK_GAP_DEFAULTS.iHold),
  };
  const el = new SparkGapElement(pinNodes, p.vBreakdown, p.rOn, p.rOff, p.iHold);
  return el;
}

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

function buildSparkGapPinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "pos",
      defaultBitWidth: 1,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "neg",
      defaultBitWidth: 1,
      position: { x: 4, y: 0 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// SparkGapCircuitElement - editor/visual layer
// ---------------------------------------------------------------------------

export class SparkGapCircuitElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("SparkGap", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildSparkGapPinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 0.5,
      width: 4.0,
      height: 1.0,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vPos = signals?.getPinVoltage("pos");
    const vNeg = signals?.getPinVoltage("neg");

    ctx.save();
    ctx.setLineWidth(1);

    // Electrode arrows - body, stays COMPONENT
    ctx.setColor("COMPONENT");
    ctx.drawPolygon(
      [
        { x: 1.75, y: 0 },
        { x: 1.25, y: -0.5 },
        { x: 1.25, y: 0.5 },
      ],
      true,
    );
    ctx.drawPolygon(
      [
        { x: 2.25, y: 0 },
        { x: 2.75, y: 0.5 },
        { x: 2.75, y: -0.5 },
      ],
      true,
    );

    // pos lead
    drawColoredLead(ctx, signals, vPos, 0, 0, 1.25, 0);

    // neg lead
    drawColoredLead(ctx, signals, vNeg, 2.75, 0, 4, 0);

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const SPARK_GAP_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "rOff",
    type: PropertyType.FLOAT,
    label: "Off Resistance (Ohm)",
    defaultValue: 1e10,
    min: 1,
    description: "Resistance when gap is blocking",
  },
  {
    key: "iHold",
    type: PropertyType.FLOAT,
    label: "Holding Current (A)",
    defaultValue: 0.01,
    min: 1e-12,
    description: "Minimum current to sustain conduction; gap extinguishes below this",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional component label",
  },
];

// ---------------------------------------------------------------------------
// Attribute mappings
// ---------------------------------------------------------------------------

export const SPARK_GAP_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "vBreakdown", propertyKey: "vBreakdown", modelParam: true, convert: (v) => parseFloat(v) },
  { xmlName: "rOn", propertyKey: "rOn", modelParam: true, convert: (v) => parseFloat(v) },
  { xmlName: "rOff", propertyKey: "rOff", convert: (v) => parseFloat(v) },
  { xmlName: "iHold", propertyKey: "iHold", convert: (v) => parseFloat(v) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

// ---------------------------------------------------------------------------
// SparkGapDefinition
// ---------------------------------------------------------------------------

function sparkGapCircuitFactory(props: PropertyBag): SparkGapCircuitElement {
  return new SparkGapCircuitElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const SparkGapDefinition: StandaloneComponentDefinition = {
  name: "SparkGap",
  typeId: -1,
  pairedSpiceEquivalent: false,
  factory: sparkGapCircuitFactory,
  pinLayout: buildSparkGapPinDeclarations(),
  voltageProbes: [{ name: "V", pos: "pos", neg: "neg" }],
  propertyDefs: SPARK_GAP_PROPERTY_DEFS,
  attributeMap: SPARK_GAP_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.PASSIVES,
  helpText:
    "Spark Gap - voltage-triggered switch with hysteresis. " +
    "Fires at breakdown voltage; stays on until current drops below holding threshold.",
  modelRegistry: {
    behavioral: {
      kind: "inline",
      factory: createSparkGapElement,
      paramDefs: SPARK_GAP_PARAM_DEFS,
      params: SPARK_GAP_DEFAULTS,
    },
  },
  models: {},
  defaultModel: "behavioral",
};
