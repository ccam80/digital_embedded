/**
 * CurrentControlledSwitchAnalogElement — ngspice CSW (W element).
 *
 * Internal-only element placed by composite netlists (Relay, etc.). Distinct
 * from `Switch` (SW, ord=42, voltage-controlled): CSW lives at CSW=21 in
 * `ref/ngspice/src/spicelib/devices/dev.c`'s `static_devices[]`, so its
 * `setup()` runs before IND (27). Setup calls `ctx.findBranch(ctrlSourceLabel)`,
 * which triggers the V-source's `findBranchFor` lazy allocation — the V-source's
 * branch row gets allocated at CSW's load-order slot, not at VSRC's (48). This
 * is the structural reason matrix row order matches ngspice for CSW-coupled
 * circuits.
 *
 * Load is a line-for-line port of `cswload.c:107-136`.
 */

import { PropertyBag } from "../../core/properties.js";
import { PoolBackedAnalogElement, type AnalogElement } from "../../solver/analog/element.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { MODEINITJCT, MODEINITFIX } from "../../solver/analog/ckt-mode.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import {
  defineStateSchema,
  type StateSchema,
} from "../../solver/analog/state-schema.js";
import { PinDirection, type PinDeclaration } from "../../core/pin.js";
import type { ComponentDefinition } from "../../core/registry.js";

// ---------------------------------------------------------------------------
// Pin layout (matches Switch contact pins A1, B1)
// ---------------------------------------------------------------------------

const CSW_PIN_LAYOUT: PinDeclaration[] = [
  { kind: "signal", direction: PinDirection.BIDIRECTIONAL, label: "A1", defaultBitWidth: 1, position: { x: 0, y: 0 }, isNegatable: false, isClockCapable: false },
  { kind: "signal", direction: PinDirection.BIDIRECTIONAL, label: "B1", defaultBitWidth: 1, position: { x: 2, y: 0 }, isNegatable: false, isClockCapable: false },
];

// ---------------------------------------------------------------------------
// State-pool schema
// ---------------------------------------------------------------------------

export const CSW_SCHEMA = defineStateSchema("CurrentControlledSwitch", [
  { name: "CLOSED",    doc: "Derived conductance flag (1=Ron, 0=Roff)" },
  { name: "CSW_STATE", doc: "ngspice CSW 4-state (REALLY_OFF/REALLY_ON/HYST_OFF/HYST_ON)" },
]) satisfies StateSchema;

const SLOT_CLOSED    = 0;
const SLOT_CSW_STATE = 1;

// ngspice CSW state constants — cswload.c:28-30.
const REALLY_OFF = 0;
const REALLY_ON  = 1;
const HYST_OFF   = 2;
const HYST_ON    = 3;

// ---------------------------------------------------------------------------
// Param helpers
// ---------------------------------------------------------------------------

function readNumber(props: PropertyBag, key: string, fallback: number): number {
  if (props.hasModelParam(key)) return props.getModelParam<number>(key);
  return props.getOrDefault<number>(key, fallback);
}

function readBoolean(props: PropertyBag, key: string, fallback: boolean): boolean {
  if (props.hasModelParam(key)) {
    const v = props.getModelParam<number | boolean>(key);
    return typeof v === "number" ? v !== 0 : !!v;
  }
  return props.getOrDefault<boolean>(key, fallback);
}

// ---------------------------------------------------------------------------
// CurrentControlledSwitchAnalogElement
// ---------------------------------------------------------------------------

export class CurrentControlledSwitchAnalogElement extends PoolBackedAnalogElement {
  readonly ngspiceLoadOrder: number = NGSPICE_LOAD_ORDER.CSW;
  readonly deviceFamily: DeviceFamily = "CSW";

  readonly stateSchema = CSW_SCHEMA;
  readonly stateSize = CSW_SCHEMA.size;

  private _ron: number;
  private _roff: number;
  private readonly _normallyClosed: boolean;
  private _pullInI: number;
  private _dropOutI: number;

  /** Flattened label of the controlling V-source, resolved by the compiler
   *  from the netlist `{ kind: "ref", name }` param. */
  private readonly _ctrlBranchLabel: string;
  /** 1-based MNA branch row resolved by ctx.findBranch at setup() time. */
  private _ctrlBranchIndex: number = -1;

  // TSTALLOC handles — cswsetup.c:59-62 line-for-line
  private _hPP: number = -1;
  private _hPN: number = -1;
  private _hNP: number = -1;
  private _hNN: number = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._ron  = Math.max(readNumber(props, "Ron",  1),    1e-12);
    this._roff = Math.max(readNumber(props, "Roff", 1e9),  1e-12);
    this._normallyClosed = readBoolean(props, "normallyClosed", false);
    this._pullInI  = readNumber(props, "pullInI",  0.05);
    this._dropOutI = readNumber(props, "dropOutI", 0.02);
    this._ctrlBranchLabel = props.has("ctrlBranch") ? props.get<string>("ctrlBranch") : "";
    if (this._ctrlBranchLabel === "") {
      throw new Error(
        "CurrentControlledSwitchAnalogElement: requires ctrlBranch param " +
        "(resolved sibling V-source label). Use Switch for voltage-controlled mode.",
      );
    }
  }

  setup(ctx: SetupContext): void {
    const posNode = this.pinNodes.get("A1")!;
    const negNode = this.pinNodes.get("B1")!;

    if (this._stateBase === -1) {
      this._stateBase = ctx.allocStates(this.stateSize);
    }

    // cswsetup.c:48 — CKTfndBranch resolves controlling V-source. Lazy-
    // allocates the source's branch row via its findBranchFor hook (mirroring
    // VSRCfindBr). This is the call that places the V-source's branch row at
    // CSW's load-order slot (21), before IND (27).
    this._ctrlBranchIndex = ctx.findBranch(this._ctrlBranchLabel);
    if (this._ctrlBranchIndex === 0) {
      throw new Error(
        `CurrentControlledSwitchAnalogElement: ctx.findBranch("${this._ctrlBranchLabel}") ` +
          `returned 0; the controlling element must declare branchCount: 1.`,
      );
    }

    // cswsetup.c:59-62 — TSTALLOC sequence.
    this._hPP = ctx.solver.allocElement(posNode, posNode);
    this._hPN = ctx.solver.allocElement(posNode, negNode);
    this._hNP = ctx.solver.allocElement(negNode, posNode);
    this._hNN = ctx.solver.allocElement(negNode, negNode);
  }

  load(ctx: LoadContext): void {
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;

    // ref: cswload.c:107-136.
    // cswload.c variable      | here
    // ----------------------- | -----
    // CSWcontBranch           | _ctrlBranchIndex
    // i_ctrl                  | i  (ctx.rhsOld[_ctrlBranchIndex])
    // CSWiThreshold           | (pullInI + dropOutI) / 2
    // CSWiHysteresis          | (pullInI - dropOutI) / 2
    // CSWstate (CKTstate1[])  | s1[base + SLOT_CSW_STATE]
    // CSWstate (CKTstate0[])  | s0[base + SLOT_CSW_STATE]
    // CSWonConduct            | 1 / Ron
    // CSWoffConduct           | 1 / Roff
    const i  = ctx.rhsOld[this._ctrlBranchIndex];
    const iT = (this._pullInI + this._dropOutI) / 2;
    const iH = (this._pullInI - this._dropOutI) / 2;
    const prevState = s1[base + SLOT_CSW_STATE];
    let newState: number;

    if (ctx.cktMode & (MODEINITJCT | MODEINITFIX)) {
      // cswload.c:47-64 — cold-start: ignore previous state.
      if (this._normallyClosed) {
        // cswload.c:49-56
        const onThresh = iH >= 0 ? iT + iH : iT - iH;
        newState = (i > onThresh) ? REALLY_ON : HYST_ON;
      } else {
        // cswload.c:57-63
        const offThresh = iH >= 0 ? iT - iH : iT + iH;
        newState = (i < offThresh) ? REALLY_OFF : HYST_OFF;
      }
    } else if (iH > 0) {
      // cswload.c:73-80 / 109-116 — normal hysteresis band.
      if (i > iT + iH) {
        newState = REALLY_ON;
      } else if (i < iT - iH) {
        newState = REALLY_OFF;
      } else {
        newState = prevState;
      }
    } else {
      // cswload.c:81-99 / 117-135 — inverted / zero hysteresis.
      if (i > iT - iH) {
        newState = REALLY_ON;
      } else if (i < iT + iH) {
        newState = REALLY_OFF;
      } else {
        if (prevState === HYST_OFF || prevState === HYST_ON) {
          newState = prevState;
        } else if (prevState === REALLY_ON) {
          newState = HYST_OFF;
        } else {
          newState = HYST_ON;
        }
      }
    }

    s0[base + SLOT_CSW_STATE] = newState;

    const energised = newState === REALLY_ON || newState === HYST_ON;
    const closedRaw = this._normallyClosed ? !energised : energised;
    s0[base + SLOT_CLOSED] = closedRaw ? 1 : 0;

    const on = s0[base + SLOT_CLOSED] >= 0.5;
    const G = on ? 1 / this._ron : 1 / this._roff;
    ctx.solver.stampElement(this._hPP, +G);
    ctx.solver.stampElement(this._hPN, -G);
    ctx.solver.stampElement(this._hNP, -G);
    ctx.solver.stampElement(this._hNN, +G);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const posNode = this.pinNodes.get("A1")!;
    const negNode = this.pinNodes.get("B1")!;
    const vA = rhs[posNode];
    const vB = rhs[negNode];
    const on = this._pool !== undefined &&
      this._pool.states[1][this._stateBase + SLOT_CLOSED] >= 0.5;
    const G = on ? 1 / this._ron : 1 / this._roff;
    const I = G * (vA - vB);
    return [I, -I];
  }

  setParam(key: string, value: unknown): void {
    if (key === "pullInI" && typeof value === "number") {
      this._pullInI = value;
    } else if (key === "dropOutI" && typeof value === "number") {
      this._dropOutI = value;
    } else if (key === "Ron" && typeof value === "number") {
      this._ron = Math.max(value, 1e-12);
    } else if (key === "Roff" && typeof value === "number") {
      this._roff = Math.max(value, 1e-12);
    }
  }
}

// ---------------------------------------------------------------------------
// CurrentControlledSwitchDefinition (internal-only)
// ---------------------------------------------------------------------------

export const CurrentControlledSwitchDefinition: ComponentDefinition = {
  name: "CurrentControlledSwitch",
  typeId: -1,
  internalOnly: true,
  pinLayout: CSW_PIN_LAYOUT,
  modelRegistry: {
    default: {
      kind: "inline",
      paramDefs: [
        { key: "pullInI",  default: 0.05 },
        { key: "dropOutI", default: 0.02 },
        { key: "Ron",      default: 1 },
        { key: "Roff",     default: 1e9 },
      ],
      params: {
        pullInI: 0.05,
        dropOutI: 0.02,
        Ron: 1,
        Roff: 1e9,
      },
      factory: (
        pinNodes: ReadonlyMap<string, number>,
        props: PropertyBag,
        _getTime: () => number,
      ): AnalogElement => new CurrentControlledSwitchAnalogElement(pinNodes, props),
    },
  },
  defaultModel: "default",
};
