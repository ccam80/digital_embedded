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

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import { PoolBackedAnalogElement, type AnalogElement } from "../../solver/analog/element.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import {
  MODEINITJCT,
  MODEINITFIX,
  MODEINITFLOAT,
  MODEINITSMSIG,
  MODEINITTRAN,
  MODEINITPRED,
} from "../../solver/analog/ckt-mode.js";
import { NGSPICE_LOAD_ORDER, type DeviceFamily } from "../../solver/analog/ngspice-load-order.js";
import {
  defineStateSchema,
  type StateSchema,
} from "../../solver/analog/state-schema.js";
import { PinDirection, type PinDeclaration, type Pin, type Rotation } from "../../core/pin.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type StandaloneComponentDefinition,
} from "../../core/registry.js";

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
  // cswdefs.h:61 CSWswitchstate (CSWstate+0), written at cswload.c:129. The
  // closed/open conductance flag is NOT stored: ngspice keeps no such state
  // (cswload.c:136-138 computes the conductance transiently), and digiTS's
  // normallyClosed inversion has no ngspice counterpart — so the flag is
  // recomputed on demand from this 4-state via isClosed().
  { name: "CSW_STATE", doc: "ngspice CSW 4-state (REALLY_OFF/REALLY_ON/HYST_OFF/HYST_ON)" },
]) satisfies StateSchema;

const SLOT_CSW_STATE = 0;

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
  /** CSWzero_stateGiven — true when the netlist specifies `closed: 1` (maps to
   *  the ngspice W-device `ON` keyword). Selects the HYST_ON cold-start branch
   *  at MODEINITJCT/MODEINITFIX, mirroring cswload.c:49-56. */
  private readonly _closedInitial: boolean;
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
    this._closedInitial  = readBoolean(props, "closed", false);
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

    // ref: cswload.c:33-146 (CSWload). Mapping ngspice -> here:
    // cswload.c variable           | here
    // ---------------------------- | -----
    // CSWcontBranch                | _ctrlBranchIndex
    // i_ctrl  = CKTrhsOld[..]       | i_ctrl  (ctx.rhsOld[_ctrlBranchIndex])
    // CSWiThreshold                | iThreshold  ((pullInI + dropOutI) / 2)
    // CSWiHysteresis               | iHysteresis ((pullInI - dropOutI) / 2)
    // previous_state = CKTstate1[]  | previous_state (s1[base + SLOT_CSW_STATE])
    // old_current_state= CKTstate0[]| old_current_state (s0[base + SLOT_CSW_STATE])
    // current_state = CKTstate0[]   | current_state (written to s0[base + SLOT_CSW_STATE])
    // CSWzero_stateGiven           | _closedInitial
    // CSWonConduct                 | 1 / Ron
    // CSWoffConduct                | 1 / Roff
    const i_ctrl = ctx.rhsOld[this._ctrlBranchIndex];
    const iThreshold  = (this._pullInI + this._dropOutI) / 2;
    const iHysteresis = (this._pullInI - this._dropOutI) / 2;
    // cswload.c:34 — previous_state = CKTstate1[CSWswitchstate] (last accepted
    // timepoint's state). cswload.c:33 — old_current_state = CKTstate0[..], the
    // state the prior NR iteration of this load() wrote, read before overwrite.
    const previous_state     = s1[base + SLOT_CSW_STATE];
    const old_current_state  = s0[base + SLOT_CSW_STATE];

    // cswload.c:23-24 — current_state initialised to -1; the implicit
    // fall-through (no mode arm matches) leaves it at this sentinel.
    let current_state = -1;

    // cswload.c:37-127 — mode-dispatched state machine.
    const cktMode = ctx.cktMode;
    if (cktMode & (MODEINITFIX | MODEINITJCT)) {
      // cswload.c:39-56 — cold start; ignore prior NR state.
      if (this._closedInitial) {
        // cswload.c:41-48 — switch specified "on".
        if (iHysteresis >= 0 && i_ctrl > iThreshold + iHysteresis)
          current_state = REALLY_ON;
        else if (iHysteresis < 0 && i_ctrl > iThreshold - iHysteresis)
          current_state = REALLY_ON;
        else
          current_state = HYST_ON;
      } else {
        // cswload.c:50-55
        if (iHysteresis >= 0 && i_ctrl < iThreshold - iHysteresis)
          current_state = REALLY_OFF;
        else if (iHysteresis < 0 && i_ctrl < iThreshold + iHysteresis)
          current_state = REALLY_OFF;
        else
          current_state = HYST_OFF;
      }
    } else if (cktMode & MODEINITSMSIG) {
      // cswload.c:58-60 — small-signal: hold the previous accepted state.
      current_state = previous_state;
    } else if (cktMode & MODEINITFLOAT) {
      // cswload.c:62-96 — INITTRAN/INITPRED already ran; decide from state.
      if (iHysteresis > 0) {
        if (i_ctrl > iThreshold + iHysteresis)
          current_state = REALLY_ON;
        else if (i_ctrl < iThreshold - iHysteresis)
          current_state = REALLY_OFF;
        else
          // cswload.c:71 — hold previous_state (CSW differs from SW here).
          current_state = previous_state;
      } else {
        // cswload.c:73-90 — negative hysteresis.
        if (i_ctrl > iThreshold - iHysteresis)
          current_state = REALLY_ON;
        else if (i_ctrl < iThreshold + iHysteresis)
          current_state = REALLY_OFF;
        else {
          // cswload.c:82-89 — in hysteresis band: hold if already hysteretic,
          // otherwise drop into the matching hysteresis state.
          if (previous_state === HYST_OFF || previous_state === HYST_ON)
            current_state = previous_state;
          else if (previous_state === REALLY_ON)
            current_state = HYST_OFF;
          else if (previous_state === REALLY_OFF)
            current_state = HYST_ON;
          else
            // cswload.c:89 — internalerror("bad value for previous region in
            // swload"): an unreachable fatal diagnostic. previous_state is one
            // of the four enumerated states, so this arm cannot run; if it did,
            // ngspice logs a fatal internal error and leaves current_state at
            // its -1 init. No current_state assignment here.
            throw new Error("bad value for previous region in swload");
        }
      }
      // cswload.c:93-96 — if the freshly decided state differs from the state
      // the prior NR iteration committed, force one more iteration so the
      // operating point settles after the flip. Only the FLOAT arm bumps noncon.
      if (current_state !== old_current_state) {
        ctx.noncon.value++;
      }
    } else if (cktMode & (MODEINITTRAN | MODEINITPRED)) {
      // cswload.c:98-127 — same threshold logic as FLOAT but never bumps noncon.
      if (iHysteresis > 0) {
        if (i_ctrl > iThreshold + iHysteresis)
          current_state = REALLY_ON;
        else if (i_ctrl < iThreshold - iHysteresis)
          current_state = REALLY_OFF;
        else
          current_state = previous_state;
      } else {
        // cswload.c:107-125 — negative hysteresis.
        if (i_ctrl > iThreshold - iHysteresis)
          current_state = REALLY_ON;
        else if (i_ctrl < iThreshold + iHysteresis)
          current_state = REALLY_OFF;
        else {
          // cswload.c:114-124 — band hold; CSW maps non-hysteretic prior states
          // into HYST_OFF/HYST_ON (differs from SW, which maps to REALLY_*).
          if (previous_state === HYST_OFF || previous_state === HYST_ON)
            current_state = previous_state;
          else if (previous_state === REALLY_ON)
            current_state = HYST_OFF;
          else if (previous_state === REALLY_OFF)
            current_state = HYST_ON;
          else
            // cswload.c:124 — internalerror("bad value for previous region in
            // cswload"): an unreachable fatal diagnostic, mirroring the FLOAT
            // arm. previous_state is one of the four enumerated states, so this
            // arm cannot run; ngspice logs a fatal internal error and leaves
            // current_state at its -1 init. No current_state assignment here.
            throw new Error("bad value for previous region in cswload");
        }
      }
    }
    // cswload.c:23-24,39-127 — there is no else arm: when no mode flag matches,
    // current_state stays at its -1 sentinel init and is written through as-is,
    // selecting offConduct at the g_now step (REALLY_ON/HYST_ON both fail).

    // cswload.c:129 — CKTstate0[CSWswitchstate] = current_state.
    s0[base + SLOT_CSW_STATE] = current_state;

    // cswload.c:136-138 — g_now = (REALLY_ON || HYST_ON) ? onConduct : offConduct.
    // The normallyClosed inversion has NO ngspice CSW counterpart (cswload.c has
    // no such param); it is a digiTS relay-contact feature used by RelayDT's
    // normally-closed contact (relay-dt.ts contactNC) to invert the energised
    // mapping while reusing the CSW state machine.
    const energised = current_state === REALLY_ON || current_state === HYST_ON;
    const closed = this._normallyClosed ? !energised : energised;

    const g_now = closed ? 1 / this._ron : 1 / this._roff;
    ctx.solver.stampElement(this._hPP, +g_now);   // cswload.c:143 CSWposPosPtr
    ctx.solver.stampElement(this._hPN, -g_now);   // cswload.c:144 CSWposNegPtr
    ctx.solver.stampElement(this._hNP, -g_now);   // cswload.c:145 CSWnegPosPtr
    ctx.solver.stampElement(this._hNN, +g_now);   // cswload.c:146 CSWnegNegPtr
  }

  /**
   * Whether the contact is conducting at the last accepted timepoint. Recomputed
   * from the committed 4-state CSW_STATE (s1) rather than stored: ngspice keeps
   * no closed/open flag (cswload.c:136-138 derives the conductance transiently),
   * and the relay-contact normallyClosed inversion has no ngspice counterpart.
   */
  isClosed(): boolean {
    const state = this._pool.states[1][this._stateBase + SLOT_CSW_STATE];
    const energised = state === REALLY_ON || state === HYST_ON;
    return this._normallyClosed ? !energised : energised;
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const posNode = this.pinNodes.get("A1")!;
    const negNode = this.pinNodes.get("B1")!;
    const vA = rhs[posNode];
    const vB = rhs[negNode];
    const on = this._pool !== undefined && this.isClosed();
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
// CurrentControlledSwitchElement — CircuitElement
//
// Two-terminal switch (A1, B1). The controlling current is the branch current
// of an independent V-source named by the `ctrlBranch` property, resolved at
// setup() via ctx.findBranch — exactly the ngspice W-card `<vcontrol>` field
// (csw.c:14 CSW_CONTROL "Name of controlling source"; cswsetup.c:47
// CKTfndBranch). This mirrors CCVS/CCVS's senseSourceLabel wiring.
// ---------------------------------------------------------------------------

export class CurrentControlledSwitchElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("CurrentControlledSwitch", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(CSW_PIN_LAYOUT, []);
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 2, height: 1 };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vA = signals?.getPinVoltage("A1");
    const vB = signals?.getPinVoltage("B1");

    ctx.save();
    ctx.setLineWidth(1);

    // Blade body, stays COMPONENT.
    ctx.setColor("COMPONENT");
    ctx.drawLine(0.5, 0, 1.5, 0);

    // A1 / B1 leads.
    drawColoredLead(ctx, signals, vA, 0, 0, 0.5, 0);
    drawColoredLead(ctx, signals, vB, 1.5, 0, 2, 0);

    const label = this._visibleLabel();
    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, 1, 1, { horizontal: "center", vertical: "top" });
    }

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const CSW_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "ctrlBranch",
    type: PropertyType.STRING,
    label: "Controlling source",
    defaultValue: "",
    description:
      "Label of the independent V-source whose branch current controls the " +
      "switch (ngspice W-card <vcontrol>, csw.c:14). Required — the element " +
      "throws if empty.",
  },
  {
    key: "normallyClosed",
    type: PropertyType.BOOLEAN,
    label: "Normally Closed",
    defaultValue: false,
    description: "When true, the contact is closed at rest and opens as control current rises.",
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

const CSW_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "ctrlBranch",     propertyKey: "ctrlBranch",     convert: (v) => v },
  { xmlName: "normallyClosed", propertyKey: "normallyClosed", convert: (v) => v === "true" },
  { xmlName: "pullInI",        propertyKey: "pullInI",        convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "dropOutI",       propertyKey: "dropOutI",       convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Ron",            propertyKey: "Ron",            convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Roff",           propertyKey: "Roff",           convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "Label",          propertyKey: "label",          convert: (v) => v },
];

// ---------------------------------------------------------------------------
// CurrentControlledSwitchDefinition
//
// Placeable standalone device. The active MNA model is `default` (the CSW W
// element). The controlling V-source is named via the `ctrlBranch` property,
// read by CurrentControlledSwitchAnalogElement's constructor and resolved at
// setup() via ctx.findBranch.
// ---------------------------------------------------------------------------

export const CurrentControlledSwitchDefinition: StandaloneComponentDefinition = {
  name: "CurrentControlledSwitch",
  typeId: -1,
  category: ComponentCategory.SWITCHING,

  pinLayout: CSW_PIN_LAYOUT,
  propertyDefs: CSW_PROPERTY_DEFS,
  attributeMap: CSW_ATTRIBUTE_MAPPINGS,

  helpText:
    "Current-Controlled Switch (ngspice CSW / W element) — two-terminal " +
    "(A1, B1). Closes when the branch current of the named controlling " +
    "V-source (ctrlBranch) exceeds the pull-in threshold, with pull-in / " +
    "drop-out hysteresis.",

  factory(props: PropertyBag): CurrentControlledSwitchElement {
    return new CurrentControlledSwitchElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
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
