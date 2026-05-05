/**
 * Switch component -- SPST switch with mechanical symbol rendering.
 *
 * Like PlainSwitch but with the standard mechanical switch symbol:
 * a diagonal line for open state, straight line for closed state,
 * plus a dashed lever and grip indicator.
 *
 * Additional property: switchActsAsInput -- when true and a label is set,
 * the switch can also be driven by an external digital signal (1=closed, 0=open).
 *
 * Pattern follows the And gate exemplar exactly.
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type StandaloneComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import { PoolBackedAnalogElement, type AnalogElement } from "../../solver/analog/element.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import {
  defineStateSchema,
  type StateSchema,
} from "../../solver/analog/state-schema.js";

// ---------------------------------------------------------------------------
// State-pool schema
// ---------------------------------------------------------------------------

export const SWITCH_SCHEMA = defineStateSchema("Switch", [
  { name: "CLOSED", doc: "Switch closed state (1=closed, 0=open)" },
]) satisfies StateSchema;

const SLOT_CLOSED = 0;

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/** Component width in grid units (SIZE*2 = 2 grid units). */
const COMP_WIDTH = 2;

/** Vertical spacing between poles in grid units (SIZE*2). */
const POLE_HEIGHT = 2;

function componentHeight(poles: number): number {
  return Math.max(poles * POLE_HEIGHT, 2);
}

// ---------------------------------------------------------------------------
// Pin layout helpers
// ---------------------------------------------------------------------------

function buildPinDeclarations(poles: number, bitWidth: number): PinDeclaration[] {
  const decls: PinDeclaration[] = [];
  for (let p = 0; p < poles; p++) {
    const yPos = p * POLE_HEIGHT;
    decls.push({
      kind: "signal",
      direction: PinDirection.BIDIRECTIONAL,
      label: `A${p + 1}`,
      defaultBitWidth: bitWidth,
      position: { x: 0, y: yPos },
      isNegatable: false,
      isClockCapable: false,
    });
    decls.push({
      kind: "signal",
      direction: PinDirection.BIDIRECTIONAL,
      label: `B${p + 1}`,
      defaultBitWidth: bitWidth,
      position: { x: COMP_WIDTH, y: yPos },
      isNegatable: false,
      isClockCapable: false,
    });
  }
  return decls;
}

// ---------------------------------------------------------------------------
// SwitchElement -- CircuitElement implementation
// ---------------------------------------------------------------------------

export class SwitchElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Switch", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const poles = this._properties.getOrDefault<number>("poles", 1);
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    return this.derivePins(buildPinDeclarations(poles, bitWidth), []);
  }

  getBoundingBox(): Rect {
    const poles = this._properties.getOrDefault<number>("poles", 1);
    const h = componentHeight(poles);
    // Dashed linkage and thin bar extend up to y=-1.25 above the origin.
    return {
      x: this.position.x,
      y: this.position.y - 1.25,
      width: COMP_WIDTH,
      height: h + 1.25,
    };
  }

  draw(ctx: RenderContext): void {
    const label = this._visibleLabel();

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Contact arm line: (0,0) to (1.8,-0.5) -- angled switch arm (open state)
    ctx.drawLine(0, 0, 1.8, -0.5);

    // Dashed linkage line: (1,-0.25) to (1,-1.25)
    ctx.setLineDash([0.2, 0.2]);
    ctx.drawLine(1, -0.25, 1, -1.25);
    ctx.setLineDash([]);

    // Thin bar: (0.5,-1.25) to (1.5,-1.25)
    ctx.setLineWidth(0.5);
    ctx.drawLine(0.5, -1.25, 1.5, -1.25);
    ctx.setLineWidth(1);

    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, COMP_WIDTH / 2, 2, { horizontal: "center", vertical: "top" });
    }

    ctx.restore();
  }

  isClosed(): boolean {
    return this._properties.getOrDefault<boolean>("closed", false);
  }

  switchActsAsInput(): boolean {
    return this._properties.getOrDefault<boolean>("switchActsAsInput", false);
  }
}

// ---------------------------------------------------------------------------
// executeSwitch -- flat simulation function
//
// Switches are handled by the bus resolution subsystem (Phase 3 task 3.2.3).
// The closed/open state is managed by the interactive engine layer.
// No computation needed in this executeFn.
// ---------------------------------------------------------------------------

export function executeSwitch(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const stBase = layout.stateOffset(index);
  const closed = layout.getProperty(index, "closed") ?? false;
  const normallyClosed = layout.getProperty(index, "normallyClosed") ?? false;
  // Effective state: NC inverts the meaning
  const effectivelyClosed = normallyClosed ? !closed : closed;
  state[stBase] = effectivelyClosed ? 1 : 0;
}

// ---------------------------------------------------------------------------
// SWITCH_ATTRIBUTE_MAPPINGS
// ---------------------------------------------------------------------------

export const SWITCH_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Bits",
    propertyKey: "bitWidth",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
  {
    xmlName: "Poles",
    propertyKey: "poles",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "closed",
    propertyKey: "closed",
    convert: (v) => v === "true",
  },
  {
    xmlName: "SwitchActsAsInput",
    propertyKey: "switchActsAsInput",
    convert: (v) => v === "true",
  },
  {
    xmlName: "Ron",
    propertyKey: "Ron",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "Roff",
    propertyKey: "Roff",
    convert: (v) => parseFloat(v),
  },
  {
    xmlName: "momentary",
    propertyKey: "momentary",
    convert: (v) => v === "true",
  },
  {
    xmlName: "normallyClosed",
    propertyKey: "normallyClosed",
    convert: (v) => v === "true",
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const SWITCH_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "poles",
    type: PropertyType.INT,
    label: "Poles",
    defaultValue: 1,
    min: 1,
    max: 4,
    description: "Number of switch poles",
  },
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of each switched signal",
    structural: true,
  },
  {
    key: "closed",
    type: PropertyType.BOOLEAN,
    label: "Closed",
    defaultValue: false,
    description: "Initial switch state (closed = connected)",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown near the component",
  },
  {
    key: "switchActsAsInput",
    type: PropertyType.BOOLEAN,
    label: "Acts as input",
    defaultValue: false,
    description: "When true, switch state can be driven by an external signal",
  },
  {
    key: "Ron",
    type: PropertyType.FLOAT,
    label: "Ron (ÃŽ)",
    defaultValue: 1,
    min: 1e-12,
    description: "On-state resistance in ohms (analog mode)",
  },
  {
    key: "Roff",
    type: PropertyType.FLOAT,
    label: "Roff (ÃŽ)",
    defaultValue: 1e9,
    min: 1,
    description: "Off-state resistance in ohms (analog mode)",
  },
  {
    key: "momentary",
    type: PropertyType.BOOLEAN,
    label: "Momentary",
    defaultValue: false,
    description: "When true, switch is only active while held (releases on mouseup)",
  },
  {
    key: "normallyClosed",
    type: PropertyType.BOOLEAN,
    label: "Normally Closed",
    defaultValue: false,
    description: "When true, switch is closed at rest",
  },
];

// ---------------------------------------------------------------------------
// Port of ngspice SW device:
//   setup: swsetup.c:47-62
//   load:  swload.c
// ---------------------------------------------------------------------------

export interface SpstAnalogElement extends AnalogElement {
  setClosed(closed: boolean): void;
  setCtrlVoltage(v: number): void;
  setSwState(on: boolean): void;
}

export class SwitchAnalogElement extends PoolBackedAnalogElement implements SpstAnalogElement {
  readonly ngspiceLoadOrder: number = NGSPICE_LOAD_ORDER.SW;

  readonly stateSchema = SWITCH_SCHEMA;
  readonly stateSize = SWITCH_SCHEMA.size;

  private readonly _ron: number;
  private readonly _roff: number;
  private readonly _normallyClosed: boolean;

  // Initial effective closed state from props — the boot constant per §4d
  // ngspice-faithful seeding contract (phase-component-model-correctness-job.md
  // §1.1.x rule 2). load() seeds s0[CLOSED] from this on the first iteration
  // and flips _seeded; thereafter the pool is the sole source of truth.
  private readonly _initClosed: boolean;

  // One-shot first-load seed sentinel. False until load() copies _initClosed
  // into s0[CLOSED]; never reset. Mirrors the analog-fuse `_intact` /
  // behavioral-driver `_firstSample` instance-field pattern.
  private _seeded: boolean = false;

  // Pending override staging — used when external drivers call setClosed /
  // setCtrlVoltage / setSwState before or between simulation steps.
  // Flushed in load() by writing immediately to both s0 and s1 so the
  // override takes effect in the current NR iteration without waiting for
  // step acceptance.  _useCtrlVoltage gates load() re-evaluation on each
  // NR iteration (voltage-controlled path, mirrors ngspice swload.c).
  private _pendingCtrlVoltage: number = 0;
  private _useCtrlVoltage: boolean = false;
  private _forcedState: boolean | null = null;
  private _pendingClosed: boolean | null = null;

  // Matrix handles allocated in setup() — port of swsetup.c:59-62 TSTALLOC sequence
  private _hPP: number = -1;
  private _hPN: number = -1;
  private _hNP: number = -1;
  private _hNN: number = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    super(pinNodes);
    this._ron = Math.max(props.getOrDefault<number>("Ron", 1), 1e-12);
    this._roff = Math.max(props.getOrDefault<number>("Roff", 1e9), 1e-12);
    this._normallyClosed = props.getOrDefault<boolean>("normallyClosed", false);
    // Compute initial effective closed state from props. NC inverts the
    // user-visible `closed` prop (NC + closed=false ⇒ effectively closed at rest).
    const userClosed = props.getOrDefault<boolean>("closed", false);
    this._initClosed = this._normallyClosed ? !userClosed : userClosed;
  }

  setup(ctx: SetupContext): void {
    const posNode = this.pinNodes.get("A1")!;
    const negNode = this.pinNodes.get("B1")!;

    // Port of swsetup.c:47-48 — state slot allocation (idempotent guard per
    // §1.1 canonical pattern).
    if (this._stateBase === -1) {
      this._stateBase = ctx.allocStates(this.stateSize);
    }

    // Port of swsetup.c:59-62 — TSTALLOC sequence (line-for-line)
    this._hPP = ctx.solver.allocElement(posNode, posNode); // SWposNode, SWposNode
    this._hPN = ctx.solver.allocElement(posNode, negNode); // SWposNode, SWnegNode
    this._hNP = ctx.solver.allocElement(negNode, posNode); // SWnegNode, SWposNode
    this._hNN = ctx.solver.allocElement(negNode, negNode); // SWnegNode, SWnegNode
  }

  load(ctx: LoadContext): void {
    const s0 = this._pool.states[0];
    const s1 = this._pool.states[1];
    const base = this._stateBase;

    // First-load boot-constant seed. The §4d ngspice-faithful seeding contract
    // (phase-component-model-correctness-job.md §1.1.x) places non-zero
    // startup values in instance fields and propagates them into s0 via the
    // bottom-of-load idiom, then into s1 via the engine's post-DCOP copy at
    // analog-engine.ts:1437. Switch is a discrete-state device with
    // cross-element coupling (RelayCoupling writes s0[CLOSED] each iter):
    // the NR-loop stamp must therefore read a value that is FROZEN across
    // the iter loop, which means s1. To make the boot constant visible to
    // the very first DCOP NR iter, we seed s1 alongside s0 — a per-element
    // analogue of the engine's bulk post-DCOP copy.
    if (!this._seeded) {
      const v = this._initClosed ? 1 : 0;
      s0[base + SLOT_CLOSED] = v;
      s1[base + SLOT_CLOSED] = v;
      this._seeded = true;
    }

    // Flush any pending external override. Write to BOTH s0 and s1 so the
    // override takes effect within the current NR iteration. Mirrors
    // memristor.ts setParam("initialState") hard-reset idiom.
    if (this._pendingClosed !== null) {
      const v = this._pendingClosed ? 1 : 0;
      s0[base + SLOT_CLOSED] = v;
      s1[base + SLOT_CLOSED] = v;
      this._pendingClosed = null;
    }

    // Voltage-controlled path: re-evaluate on every NR iteration.
    // Mirrors ngspice swload.c which reads SWcontVoltage from CKTrhsOld
    // each iteration. Write to both s0 and s1 for immediate effect.
    if (this._useCtrlVoltage) {
      const v = this._pendingCtrlVoltage;
      const closed = this._normallyClosed ? v <= 0 : v > 0;
      const val = closed ? 1 : 0;
      s0[base + SLOT_CLOSED] = val;
      s1[base + SLOT_CLOSED] = val;
    }

    // _forcedState is a one-shot override (setSwState). Clears after flush.
    if (this._forcedState !== null) {
      const val = this._forcedState ? 1 : 0;
      s0[base + SLOT_CLOSED] = val;
      s1[base + SLOT_CLOSED] = val;
      this._forcedState = null;
    }

    // Read s1 (frozen across the NR loop) for stamp stability — switch's
    // Ron/Roff conductance differ by ~10^9, so any mid-iter state flip would
    // break NR convergence. Sibling RelayCoupling writes s0[CLOSED] each
    // iter; those writes propagate into s1 either via the engine's post-DCOP
    // copy or via the per-step s0→s1 rotation on accept (port of swload.c).
    const on = s1[base + SLOT_CLOSED] >= 0.5;

    // Bottom-of-load history write (ngspice CKTstate0 idiom — swload.c).
    s0[base + SLOT_CLOSED] = on ? 1 : 0;

    const G = on ? 1 / this._ron : 1 / this._roff;

    // Port of swload.c:149-152 — stamp through cached handles
    ctx.solver.stampElement(this._hPP, +G);
    ctx.solver.stampElement(this._hPN, -G);
    ctx.solver.stampElement(this._hNP, -G);
    ctx.solver.stampElement(this._hNN, +G);
  }

  setClosed(closed: boolean): void {
    const effectivelyClosed = this._normallyClosed ? !closed : closed;
    this._pendingClosed = effectivelyClosed;
    this._useCtrlVoltage = false;  // boolean driver supersedes voltage driver
  }

  setCtrlVoltage(v: number): void {
    this._pendingCtrlVoltage = v;
    this._useCtrlVoltage = true;  // become the active driver until setClosed/setSwState
  }

  setSwState(on: boolean): void {
    this._forcedState = on;
    this._useCtrlVoltage = false;  // explicit override supersedes voltage driver
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const posNode = this.pinNodes.get("A1")!;
    const negNode = this.pinNodes.get("B1")!;
    const vA = rhs[posNode];
    const vB = rhs[negNode];
    // Pre-first-load probes have no pool history yet (s1 is still zero-init);
    // fall back to the boot constant. Post-first-load reads s1 (last-accepted).
    const on = this._seeded
      ? this._pool.states[1][this._stateBase + SLOT_CLOSED] >= 0.5
      : this._initClosed;
    const G = on ? 1 / this._ron : 1 / this._roff;
    const I = G * (vA - vB);
    return [I, -I];
  }

  setParam(key: string, value: unknown): void {
    if (key === "closed") {
      this.setClosed(!!value);
    }
  }
}

// ---------------------------------------------------------------------------
// SwitchDefinition
// ---------------------------------------------------------------------------

function switchFactory(props: PropertyBag): SwitchElement {
  return new SwitchElement(
    crypto.randomUUID(),
    { x: 0, y: 0 },
    0,
    false,
    props,
  );
}

export const SwitchDefinition: StandaloneComponentDefinition = {
  name: "Switch",
  typeId: -1,
  factory: switchFactory,
  pinLayout: buildPinDeclarations(1, 1),
  propertyDefs: SWITCH_PROPERTY_DEFS,
  attributeMap: SWITCH_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText:
    "Switch (SPST) -- a manually controlled single-pole single-throw switch.\n" +
    "When closed, terminals A and B are connected (bus nets merged).\n" +
    "When open, terminals are disconnected.\n" +
    "Click to toggle during simulation.",
  models: {
    digital: {
      executeFn: executeSwitch,
      inputSchema: [],
      outputSchema: ["A1", "B1"],
      stateSlotCount: 1,
      switchPins: [0, 1],
      defaultDelay: 0,
    },
  },
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: (pinNodes, props, _getTime) => new SwitchAnalogElement(pinNodes, props),
      paramDefs: [],
      params: {},
    },
  },
  defaultModel: "digital",
};
