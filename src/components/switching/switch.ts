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
import type { AnalogElement } from "../../solver/analog/element.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/ngspice-load-order.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import {
  defineStateSchema,
  type StateSchema,
} from "../../solver/analog/state-schema.js";
import type { StatePoolRef } from "../../solver/analog/state-pool.js";

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

export class SwitchAnalogElement implements SpstAnalogElement {
  label: string = "";
  branchIndex: number = -1;
  readonly ngspiceLoadOrder: number = NGSPICE_LOAD_ORDER.SW;
  _stateBase: number = -1;
  _pinNodes: Map<string, number>;

  readonly poolBacked = true as const;
  readonly stateSchema = SWITCH_SCHEMA;
  readonly stateSize = 1;

  private readonly _ron: number;
  private readonly _roff: number;
  private readonly _normallyClosed: boolean;
  private _pool!: StatePoolRef;

  // Voltage-controlled state. _pendingCtrlVoltage stores the latest value passed
  // to setCtrlVoltage(); _useCtrlVoltage gates load() consumption (true while
  // setCtrlVoltage is the active driver, cleared by setClosed / setSwState which
  // override). Mirrors ngspice swload.c which reads SWcontVoltage from CKTrhsOld
  // every NR iteration; digiTS exposes the same live-update semantics through
  // this hook when an external driver supplies the control voltage explicitly.
  // Default thresholds mirror ngspice SW model defaults: SWonThreshold = 0V,
  // SWoffThreshold = 0V (no hysteresis). Hysteresis can be added later as model
  // params if needed.
  private _pendingCtrlVoltage: number = 0;
  private _useCtrlVoltage: boolean = false;
  private _forcedState: boolean | null = null;
  private _pendingClosed: boolean | null = null;

  // Matrix handles allocated in setup()- port of swsetup.c:59-62 TSTALLOC sequence
  private _hPP: number = -1;
  private _hPN: number = -1;
  private _hNP: number = -1;
  private _hNN: number = -1;

  constructor(pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    this._pinNodes = new Map(pinNodes);
    this._ron = Math.max(props.getOrDefault<number>("Ron", 1), 1e-12);
    this._roff = Math.max(props.getOrDefault<number>("Roff", 1e9), 1e-12);
    this._normallyClosed = props.getOrDefault<boolean>("normallyClosed", false);
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
  }

  setup(ctx: SetupContext): void {
    const posNode = this._pinNodes.get("A1")!;
    const negNode = this._pinNodes.get("B1")!;

    // Port of swsetup.c:47-48- state slot allocation
    this._stateBase = ctx.allocStates(1);  // SWITCH_SCHEMA: 1 slot (CLOSED)

    // Port of swsetup.c:59-62- TSTALLOC sequence (line-for-line)
    this._hPP = ctx.solver.allocElement(posNode, posNode); // SWposNode, SWposNode
    this._hPN = ctx.solver.allocElement(posNode, negNode); // SWposNode, SWnegNode
    this._hNP = ctx.solver.allocElement(negNode, posNode); // SWnegNode, SWposNode
    this._hNN = ctx.solver.allocElement(negNode, negNode); // SWnegNode, SWnegNode
  }

  load(ctx: LoadContext): void {
    const s1 = ctx.state1;
    const s0 = ctx.state0;
    const base = this._stateBase;

    // Apply pending state writes before reading s1.
    if (this._pendingClosed !== null) {
      s0[base + SLOT_CLOSED] = this._pendingClosed ? 1 : 0;
      this._pendingClosed = null;
    }

    // Hot-patch consumption: when setCtrlVoltage() is the active driver, derive
    // the switch state from _pendingCtrlVoltage every NR iteration. Mirrors
    // ngspice swload.c which evaluates SWcontVoltage live each iteration. With
    // ngspice default thresholds (SWonThreshold = SWoffThreshold = 0V) and no
    // hysteresis, the switch is closed for v > 0 and open for v <= 0 (inverted
    // when normallyClosed).
    if (this._useCtrlVoltage) {
      const v = this._pendingCtrlVoltage;
      const closeFromVoltage = this._normallyClosed ? v <= 0 : v > 0;
      s0[base + SLOT_CLOSED] = closeFromVoltage ? 1 : 0;
    }

    // Read s1[CLOSED] to pick Ron vs Roff. The switch's stamp is stable across
    // the NR loop because s1 doesn't change within a step.
    const on = this._forcedState !== null ? this._forcedState : s1[base + SLOT_CLOSED] >= 0.5;
    this._forcedState = null;

    // Bottom-of-load history write.
    s0[base + SLOT_CLOSED] = on ? 1 : 0;

    const G = on ? 1 / this._ron : 1 / this._roff;

    // Port of swload.c:149-152- stamp through cached handles
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
    const posNode = this._pinNodes.get("A1")!;
    const negNode = this._pinNodes.get("B1")!;
    const vA = rhs[posNode];
    const vB = rhs[negNode];
    const s1 = this._pool.states[1];
    const on = s1[this._stateBase + SLOT_CLOSED] >= 0.5;
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
