/**
 * BehavioralOutputDriver- behaviourally-driven voltage source.
 *
 * Reads a logic level from a sibling leaf's pool slot (resolved at expansion
 * time via the `inputLogic` siblingState ref param), maps it to vOH or vOL,
 * and stamps the result at a branch row using the standard VSRC pattern.
 *
 * Per Composite I7 (phase-composite-architecture.md), J-171
 * (contracts_group_11.md). The literal contract pseudocode references APIs
 * that don't exist in the current codebase (`core/analog-types.js`, `kind:
 * "factory"`, `ctx.allocStamp`, `ctx.statePool`); this implementation follows
 * the contract's INTENT against the real APIs, matching the canonical shape
 * of `d-flipflop-driver.ts` (Template A) for state schema / lifecycle and
 * the canonical shape of `transmission-segment-l.ts` (Template C) for the
 * VSRC branch + matrix stamps.
 *
 * Multi-bit support per A1: an optional `bitIndex` param (default 0) selects
 * which bit of the input slot value to drive. For single-bit drivers the
 * sibling writes 0.0 or 1.0 to the slot and bitIndex defaults to 0, which
 * gives `Math.floor(level) & 1` = the original 0/1 reading. For multi-bit
 * drivers (counter, register, seven-seg) the sibling writes a packed integer
 * and each consuming pin sub-element supplies its own `bitIndex: K` so it
 * extracts bit K via `(Math.floor(level) >>> bitIndex) & 1`. Width capped at
 * 32 bits (matches engine convention; >>> coerces to Uint32).
 */

import {
  defineStateSchema,
  applyInitialValues,
  type StateSchema,
} from "./state-schema.js";
import { NGSPICE_LOAD_ORDER } from "./ngspice-load-order.js";
import type { AnalogElement, PoolBackedAnalogElement } from "./element.js";
import type { StatePoolRef } from "./state-pool.js";
import type { SetupContext } from "./setup-context.js";
import type { LoadContext } from "./load-context.js";
import { stampRHS } from "./stamp-helpers.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";
import { PropertyBag, type PoolSlotRef } from "../../core/properties.js";
import type { ComponentDefinition, ParamDef } from "../../core/registry.js";

// ---------------------------------------------------------------------------
// State schema
// ---------------------------------------------------------------------------

const SCHEMA: StateSchema = defineStateSchema("BehavioralOutputDriver", [
  {
    name: "DRIVE_V",
    doc: "Driven branch voltage this step (vOH or vOL post bit-extraction). Bottom-of-load write; no semantic role beyond diagnostic readout.",
    init: { kind: "zero" },
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
  { key: "bitIndex", default: 0 },
  // `inputLogic` is a siblingState ref (object) injected by the compiler at
  // expansion time. Not declared here as a ParamDef because ParamDef.default
  // is `number`; the object value is read from props.get() at construct time.
];

const BEHAVIORAL_OUTPUT_DRIVER_DEFAULTS: Record<string, number> = {
  vOH: 5,
  vOL: 0,
  bitIndex: 0,
};

// ---------------------------------------------------------------------------
// BehavioralOutputDriverElement
// ---------------------------------------------------------------------------

export class BehavioralOutputDriverElement implements PoolBackedAnalogElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.BEHAVIORAL;
  readonly poolBacked = true as const;
  readonly stateSchema = SCHEMA;
  readonly stateSize = SCHEMA.size;

  label = "";
  _pinNodes: Map<string, number>;
  _stateBase = -1;
  branchIndex = -1;

  private readonly _vOH: number;
  private readonly _vOL: number;
  private readonly _bitIndex: number;
  private readonly _inputLogicRef: PoolSlotRef;
  private _pool!: StatePoolRef;

  // VSRC stamp handles (vsrcsetup.c shape: pos/br, neg/br, br/pos, br/neg).
  private _hPosBr = -1;
  private _hNegBr = -1;
  private _hBrPos = -1;
  private _hBrNeg = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    this._pinNodes = new Map(pinNodes);
    this._vOH = props.hasModelParam("vOH") ? props.getModelParam<number>("vOH") : BEHAVIORAL_OUTPUT_DRIVER_DEFAULTS["vOH"]!;
    this._vOL = props.hasModelParam("vOL") ? props.getModelParam<number>("vOL") : BEHAVIORAL_OUTPUT_DRIVER_DEFAULTS["vOL"]!;
    this._bitIndex = props.hasModelParam("bitIndex") ? props.getModelParam<number>("bitIndex") : BEHAVIORAL_OUTPUT_DRIVER_DEFAULTS["bitIndex"]!;
    // `inputLogic` is a PoolSlotRef object (not a number) — read via the
    // plain-prop accessor. The compiler's siblingState resolver writes it
    // via PropertyBag.set, not replaceModelParams.
    this._inputLogicRef = props.get<PoolSlotRef>("inputLogic");
  }

  setup(ctx: SetupContext): void {
    const solver = ctx.solver;
    const posNode = this._pinNodes.get("pos")!;
    const negNode = this._pinNodes.get("neg")!;

    this._stateBase = ctx.allocStates(this.stateSize);

    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this.label, "branch");
    }
    const b = this.branchIndex;

    // VSRC TSTALLOC sequence (vsrcsetup.c).
    this._hPosBr = solver.allocElement(posNode, b);
    this._hNegBr = solver.allocElement(negNode, b);
    this._hBrPos = solver.allocElement(b, posNode);
    this._hBrNeg = solver.allocElement(b, negNode);
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
    applyInitialValues(SCHEMA, pool, this._stateBase, {});
  }

  setParam(_key: string, _value: number): void {
    // No hot-loadable params- vOH/vOL/bitIndex are construction-time. If
    // runtime ramping is needed in future, expose them here per
    // feedback_hot_loadable_params.
  }

  load(ctx: LoadContext): void {
    const solver = ctx.solver;
    const b = this.branchIndex;
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];

    // Read sibling driver's slot (prior step- s1 per StatePool migration shape).
    const siblingBase = this._inputLogicRef.element._stateBase;
    const inputLevel = s1[siblingBase + this._inputLogicRef.slotIdx];

    // Bit-extraction. For single-bit drivers (sibling writes 0.0 or 1.0),
    // bitIndex defaults to 0 so this collapses to `Math.floor(level) & 1`,
    // preserving the original 0/1 semantic. For multi-bit drivers (sibling
    // writes packed integer), bitIndex selects the consuming pin's bit.
    const bit = (Math.floor(inputLevel) >>> this._bitIndex) & 1;
    const target = bit ? this._vOH : this._vOL;

    // VSRC stamp- 4 unconditional unit-incidence stamps + RHS at branch.
    solver.stampElement(this._hPosBr, 1);
    solver.stampElement(this._hNegBr, -1);
    solver.stampElement(this._hBrPos, 1);
    solver.stampElement(this._hBrNeg, -1);
    stampRHS(ctx.rhs, b, target);

    // Bottom-of-load history write per feedback_no_accept_history_capture.
    s0[this._stateBase + SLOT_DRIVE_V] = target;
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const I = rhs[this.branchIndex];
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
      branchCount: 1,
      factory: (pinNodes: ReadonlyMap<string, number>, props: PropertyBag, _getTime: () => number): AnalogElement =>
        new BehavioralOutputDriverElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
