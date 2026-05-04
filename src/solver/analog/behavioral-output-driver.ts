/**
 * BehavioralOutputDriver- Norton-equivalent behaviourally-driven source.
 *
 * Reads a logic level from a sibling leaf's pool slot (resolved at expansion
 * time via the `inputLogic` siblingState ref param), maps it to vOH or vOL,
 * and stamps a Norton-equivalent (current source in parallel with the
 * output conductance) at its (pos, neg) pins. The Norton form absorbs the
 * output resistance into this leaf so the conductance value can be switched
 * between active (1/rOut) and high-Z isolated (1e-9 S = 1 GΩ) without
 * touching a separate Resistor sub-element.
 *
 * Tri-state plumbing: the optional `enableLogic` siblingState ref points
 * at a sibling slot containing the enable bit (>= 0.5 → enabled, < 0.5 →
 * high-Z). When the ref is absent the driver is permanently enabled (the
 * case for every non-tri-state-capable consumer- gates, flipflops, mux,
 * etc.). When present and the slot reads disabled, the conductance stamp
 * drops to 1e-9 S and the current injection drops to zero, so the pin
 * effectively disconnects from the external net and other drivers on the
 * shared net dominate.
 *
 * Multi-bit support per A1: an optional `bitIndex` param (default 0)
 * selects which bit of the input slot value to drive. For single-bit
 * drivers the sibling writes 0.0 or 1.0 to the slot and bitIndex defaults
 * to 0, which gives `Math.floor(level) & 1` = the original 0/1 reading.
 * For multi-bit drivers (counter, register, seven-seg) the sibling writes
 * a packed integer and each consuming pin sub-element supplies its own
 * `bitIndex: K` so it extracts bit K via `(Math.floor(level) >>> bitIndex)
 * & 1`. Width capped at 32 bits (matches engine convention; >>> coerces to
 * Uint32).
 *
 * Per Composite I7 (phase-composite-architecture.md), J-171
 * (contracts_group_11.md). Replaces the prior Thévenin VSRC + separate
 * Resistor child with a single Norton stamp; mathematically equivalent at
 * the external port (Thévenin/Norton equivalence preserves I/V at every
 * operating point) but eliminates the internal driveNode and branch row,
 * and lets the driver own the conductance value for tri-state switching.
 */

import {
  defineStateSchema,
  type StateSchema,
} from "./state-schema.js";
import { NGSPICE_LOAD_ORDER } from "./ngspice-load-order.js";
import { AbstractPoolBackedAnalogElement, type AnalogElement } from "./element.js";
import type { SetupContext } from "./setup-context.js";
import type { LoadContext } from "./load-context.js";
import { stampRHS } from "./stamp-helpers.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";
import { PropertyBag, type PoolSlotRef } from "../../core/properties.js";
import type { ComponentDefinition, ParamDef } from "../../core/registry.js";

// ---------------------------------------------------------------------------
// Tri-state isolated conductance- 1 GΩ per the architectural decision.
// Picked to be small enough that it never measurably perturbs a real driver
// elsewhere on the shared net (real driver rOut is 100 Ω → ratio 1e7) but
// large enough to keep the MNA matrix non-singular when every driver on a
// net is disabled (a true float would leave the node unconstrained).
// ---------------------------------------------------------------------------

const HIGH_Z_CONDUCTANCE = 1e-9;

// ---------------------------------------------------------------------------
// State schema
// ---------------------------------------------------------------------------

const SCHEMA: StateSchema = defineStateSchema("BehavioralOutputDriver", [
  {
    name: "DRIVE_V",
    doc: "Driven Norton-source target voltage this step (vOH or vOL post bit-extraction; 0 when disabled). Bottom-of-load write; diagnostic readout only.",
  },
]);

const SLOT_DRIVE_V = SCHEMA.indexOf.get("DRIVE_V")!;

// ---------------------------------------------------------------------------
// Pin layout
// ---------------------------------------------------------------------------

const BEHAVIORAL_OUTPUT_DRIVER_PIN_LAYOUT: PinDeclaration[] = [
  { direction: PinDirection.OUTPUT, label: "pos", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
  { direction: PinDirection.INPUT,  label: "neg", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false, kind: "signal" },
];

// ---------------------------------------------------------------------------
// Param defs
// ---------------------------------------------------------------------------

const BEHAVIORAL_OUTPUT_DRIVER_PARAM_DEFS: ParamDef[] = [
  { key: "vOH",      default: 5 },
  { key: "vOL",      default: 0 },
  { key: "rOut",     default: 100 },
  { key: "bitIndex", default: 0 },
  // `inputLogic` and (optional) `enableLogic` are siblingState refs (objects)
  // injected by the compiler at expansion time. Not declared here as ParamDefs
  // because ParamDef.default is `number`; the object values are read from
  // props.get() at construct time.
];

const BEHAVIORAL_OUTPUT_DRIVER_DEFAULTS: Record<string, number> = {
  vOH: 5,
  vOL: 0,
  rOut: 100,
  bitIndex: 0,
};

// ---------------------------------------------------------------------------
// BehavioralOutputDriverElement
// ---------------------------------------------------------------------------

export class BehavioralOutputDriverElement extends AbstractPoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  private readonly _vOH: number;
  private readonly _vOL: number;
  private readonly _rOut: number;
  private readonly _bitIndex: number;
  private readonly _inputLogicRef: PoolSlotRef;
  private readonly _enableLogicRef: PoolSlotRef | null;

  // Norton conductance stamp handles- 2x2 conductance matrix at (pos, neg).
  // Same incidence pattern as a 2-terminal resistor (relay-resistor.ts shape).
  private _hPP = -1; // (pos, pos)
  private _hNN = -1; // (neg, neg)
  private _hPN = -1; // (pos, neg)
  private _hNP = -1; // (neg, pos)

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._vOH      = props.hasModelParam("vOH")      ? props.getModelParam<number>("vOH")      : BEHAVIORAL_OUTPUT_DRIVER_DEFAULTS["vOH"]!;
    this._vOL      = props.hasModelParam("vOL")      ? props.getModelParam<number>("vOL")      : BEHAVIORAL_OUTPUT_DRIVER_DEFAULTS["vOL"]!;
    this._rOut     = props.hasModelParam("rOut")     ? props.getModelParam<number>("rOut")     : BEHAVIORAL_OUTPUT_DRIVER_DEFAULTS["rOut"]!;
    this._bitIndex = props.hasModelParam("bitIndex") ? props.getModelParam<number>("bitIndex") : BEHAVIORAL_OUTPUT_DRIVER_DEFAULTS["bitIndex"]!;
    // `inputLogic` is a PoolSlotRef object (not a number). Read via the
    // plain-prop accessor- the compiler's siblingState resolver writes it
    // via PropertyBag.set, not replaceModelParams.
    this._inputLogicRef = props.get<PoolSlotRef>("inputLogic");
    // `enableLogic` is optional: present iff the parent composite wires a
    // tri-state enable slot via siblingState. Absent for non-tri-state
    // consumers (gates, flipflops, mux, counter, register, etc.).
    this._enableLogicRef = props.has("enableLogic") ? props.get<PoolSlotRef>("enableLogic") : null;
  }

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const posNode = this._pinNodes.get("pos")!;
    const negNode = this._pinNodes.get("neg")!;

    this._stateBase = ctx.allocStates(this.stateSize);

    // Norton stamp- 4 conductance entries (no branch row needed).
    this._hPP = solver.allocElement(posNode, posNode);
    this._hNN = solver.allocElement(negNode, negNode);
    this._hPN = solver.allocElement(posNode, negNode);
    this._hNP = solver.allocElement(negNode, posNode);
  }

  setParam(_key: string, _value: number): void {
    // No hot-loadable params- vOH/vOL/rOut/bitIndex are construction-time.
    // Hot-load support per feedback_hot_loadable_params can be added if a
    // use case surfaces.
  }

  load(ctx: LoadContext): void {
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const posNode = this._pinNodes.get("pos")!;
    const negNode = this._pinNodes.get("neg")!;

    // Read sibling driver's input slot (prior step- s1 per StatePool migration shape).
    const inBase = this._inputLogicRef.element._stateBase;
    const inputLevel = s1[inBase + this._inputLogicRef.slotIdx];

    // Bit-extraction. For single-bit drivers (sibling writes 0.0 or 1.0),
    // bitIndex defaults to 0 so this collapses to `Math.floor(level) & 1`,
    // preserving the original 0/1 semantic. For multi-bit drivers (sibling
    // writes packed integer), bitIndex selects the consuming pin's bit.
    const bit = (Math.floor(inputLevel) >>> this._bitIndex) & 1;
    const target = bit ? this._vOH : this._vOL;

    // Tri-state evaluation. When `enableLogic` is wired and the sibling slot
    // reads disabled, the Norton stamp collapses to a 1 GΩ shunt with zero
    // current injection- the pin effectively disconnects from the external
    // net so other drivers on the shared net take over. When `enableLogic`
    // is absent (the common case), driver is permanently enabled.
    let enabled = true;
    if (this._enableLogicRef !== null) {
      const enBase = this._enableLogicRef.element._stateBase;
      const enLevel = s1[enBase + this._enableLogicRef.slotIdx];
      enabled = enLevel >= 0.5;
    }

    const G = enabled ? 1 / this._rOut : HIGH_Z_CONDUCTANCE;
    const I = enabled ? G * target     : 0;

    // 2x2 conductance stamp (resistor incidence pattern).
    const solver = ctx.solver;
    solver.stampElement(this._hPP, +G);
    solver.stampElement(this._hNN, +G);
    solver.stampElement(this._hPN, -G);
    solver.stampElement(this._hNP, -G);

    // Norton current injection at (pos, neg)- equivalent of vTarget behind rOut.
    if (I !== 0) {
      stampRHS(ctx.rhs, posNode, +I);
      stampRHS(ctx.rhs, negNode, -I);
    }

    // Bottom-of-load history write per feedback_no_accept_history_capture.
    s0[this._stateBase + SLOT_DRIVE_V] = enabled ? target : 0;
  }

  getPinCurrents(rhs: Float64Array): number[] {
    // Norton-equivalent current at the external port: I_pos = G * (vTarget - (vPos - vNeg)).
    // This is the actual current flowing OUT of the pos pin into the external net,
    // computed from the post-solve node voltages.
    const posNode = this._pinNodes.get("pos")!;
    const negNode = this._pinNodes.get("neg")!;
    const s1 = this._pool.states[1];
    const target = s1[this._stateBase + SLOT_DRIVE_V];
    let G = 1 / this._rOut;
    if (this._enableLogicRef !== null) {
      const enBase = this._enableLogicRef.element._stateBase;
      const enLevel = s1[enBase + this._enableLogicRef.slotIdx];
      if (enLevel < 0.5) G = HIGH_Z_CONDUCTANCE;
    }
    const I = G * (target - (rhs[posNode] - rhs[negNode]));
    return [I, -I];
  }
}

// ---------------------------------------------------------------------------
// ComponentDefinition
// ---------------------------------------------------------------------------

export const BehavioralOutputDriverDefinition: ComponentDefinition = {
  name: "BehavioralOutputDriver",
  typeId: -1,
  internalOnly: true,
  pinLayout: BEHAVIORAL_OUTPUT_DRIVER_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: BEHAVIORAL_OUTPUT_DRIVER_PARAM_DEFS,
      params: BEHAVIORAL_OUTPUT_DRIVER_DEFAULTS,
      branchCount: 0,
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number): AnalogElement =>
        new BehavioralOutputDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
