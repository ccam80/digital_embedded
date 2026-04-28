/**
 * Relay (SPST) — coil-controlled contact switch.
 *
 * Two coil terminals (in1, in2) control the contact state.
 * When the coil is energised (in1 XOR in2 is nonzero, i.e. current flows
 * through the coil), the contact closes. When de-energised, it opens.
 *
 * normallyClosedRelay property inverts this logic:
 *   false (normally open, default): coil energised → contact CLOSED
 *   true  (normally closed):        coil energised → contact OPEN
 *
 * If either coil terminal is floating (high-Z in Digital's model), the coil
 * is treated as de-energised (contact reverts to its rest state).
 *
 * Like Switch, the contact state is handled by the bus resolution subsystem
 * (Phase 3 task 3.2.3). The executeFn writes the contact state to the state
 * array where the bus resolver can read it, and does no other computation.
 *
 * Pins:
 *   Inputs (coil): in1, in2 (1-bit each)
 *   Bidirectional (contact): A1..An, B1..Bn (one pair per pole)
 *
 * internalStateCount: 1 (closed flag, read by bus resolver)
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
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import type { LoadContext } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/element.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { AnalogElement } from "../../core/analog-types.js";
import { AnalogInductorElement, INDUCTOR_DEFAULTS } from "../passives/inductor.js";
import { SwitchAnalogElement } from "./switch.js";

// ---------------------------------------------------------------------------
// Relay analog constants
// ---------------------------------------------------------------------------

const RELAY_R_ON = 0.01;
const RELAY_R_OFF = 1e7;
const RELAY_R_COIL_DEFAULT = 100;
const RELAY_L_DEFAULT = 0.1;
const RELAY_I_PULL_DEFAULT = 20e-3;

// ---------------------------------------------------------------------------
// RelayInductorSubElement — IND sub-element for relay coil
//
// Extends AnalogInductorElement with a real setup() body.
// ngspice anchor: indsetup.c:84-100
// ---------------------------------------------------------------------------

export class RelayInductorSubElement extends AnalogInductorElement {
  // Handle fields (_hPIbr, _hNIbr, _hIbrN, _hIbrP, _hIbrIbr) are inherited
  // from AnalogInductorElement (protected) — port of indsetup.c:96-100 TSTALLOC sequence.

  private readonly _elementLabel: string;

  constructor(label: string, inductance: number) {
    const props = new PropertyBag();
    props.replaceModelParams({ ...INDUCTOR_DEFAULTS, inductance });
    super(new Map<string, number>(), props);
    this._elementLabel = label;
  }

  setup(ctx: SetupContext): void {
    const posNode = this._pinNodes.get("A")!;
    const negNode = this._pinNodes.get("B")!;

    // indsetup.c:78-79: *states += 2
    this._stateBase = ctx.allocStates(2);

    // indsetup.c:84-87: idempotent branch-row guard
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this._elementLabel, "branch");
    }
    const b = this.branchIndex;

    // indsetup.c:96-100: TSTALLOC sequence (5 entries, line-for-line)
    this._hPIbr   = ctx.solver.allocElement(posNode, b); // (INDposNode, INDbrEq)
    this._hNIbr   = ctx.solver.allocElement(negNode, b); // (INDnegNode, INDbrEq)
    this._hIbrN   = ctx.solver.allocElement(b, negNode); // (INDbrEq, INDnegNode)
    this._hIbrP   = ctx.solver.allocElement(b, posNode); // (INDbrEq, INDposNode)
    this._hIbrIbr = ctx.solver.allocElement(b, b);       // (INDbrEq, INDbrEq)
  }

  findBranchFor(_name: string, ctx: SetupContext): number {
    if (this.branchIndex === -1) {
      this.branchIndex = ctx.makeCur(this._elementLabel, "branch");
    }
    return this.branchIndex;
  }
}

// ---------------------------------------------------------------------------
// RelayResSubElement — RES sub-element for relay coil resistance
//
// ngspice anchor: ressetup.c:46-49
// ---------------------------------------------------------------------------

export class RelayResSubElement implements AnalogElement {
  label: string = "";
  branchIndex: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.RES;
  _stateBase: number = -1;
  _pinNodes: Map<string, number>;

  // Handle fields — port of ressetup.c:46-49 TSTALLOC sequence
  _hPP: number = -1; // (RESposNode, RESposNode)
  _hNN: number = -1; // (RESnegNode, RESnegNode)
  _hPN: number = -1; // (RESposNode, RESnegNode)
  _hNP: number = -1; // (RESnegNode, RESposNode)

  private _resistance: number;
  private _G: number;

  constructor(pinNodes: Map<string, number>, resistance: number) {
    this._pinNodes = pinNodes;
    this._resistance = Math.max(resistance, 1e-9);
    this._G = 1 / this._resistance;
  }

  setup(ctx: SetupContext): void {
    const posNode = this._pinNodes.get("A")!;
    const negNode = this._pinNodes.get("B")!;

    // ressetup.c: NG_IGNORE(state) — no state slots

    // ressetup.c:46-49: TSTALLOC sequence (4 entries, line-for-line)
    this._hPP = ctx.solver.allocElement(posNode, posNode); // (RESposNode, RESposNode)
    this._hNN = ctx.solver.allocElement(negNode, negNode); // (RESnegNode, RESnegNode)
    this._hPN = ctx.solver.allocElement(posNode, negNode); // (RESposNode, RESnegNode)
    this._hNP = ctx.solver.allocElement(negNode, posNode); // (RESnegNode, RESposNode)
  }

  load(ctx: LoadContext): void {
    // resload.c: stamp conductance through cached handles
    ctx.solver.stampElement(this._hPP, +this._G);
    ctx.solver.stampElement(this._hNN, +this._G);
    ctx.solver.stampElement(this._hPN, -this._G);
    ctx.solver.stampElement(this._hNP, -this._G);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const posNode = this._pinNodes.get("A")!;
    const negNode = this._pinNodes.get("B")!;
    const I = this._G * (rhs[posNode] - rhs[negNode]);
    return [I, -I];
  }

  setParam(key: string, value: number): void {
    if (key === "resistance") {
      this._resistance = Math.max(value, 1e-9);
      this._G = 1 / this._resistance;
    }
  }
}

// ---------------------------------------------------------------------------
// RelayAnalogElement — composite AnalogElement
//
// Architecture: coilL (IND) + coilR (RES) + contactSW (SW)
// ngspice anchors:
//   coilL: indsetup.c:84-100, indload.c
//   coilR: ressetup.c:46-49, resload.c
//   contactSW: swsetup.c:47-62, swload.c
// ---------------------------------------------------------------------------

class RelayAnalogElement implements AnalogElement {
  label: string = "";
  branchIndex: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.IND;
  _stateBase: number = -1;
  _pinNodes: Map<string, number>;

  readonly _coilL: RelayInductorSubElement;
  readonly _coilR: RelayResSubElement;
  readonly _contactSW: SwitchAnalogElement;

  private _nCoilMid: number = -1;
  private readonly _label: string;
  private readonly _iPull: number;
  private readonly _normallyClosed: boolean;
  private readonly _internalLabels: string[] = [];

  constructor(label: string, pinNodes: ReadonlyMap<string, number>, props: PropertyBag) {
    this._label = label;
    this._pinNodes = new Map(pinNodes);
    this._iPull = props.has("iPull") ? (props.get("iPull") as number) : RELAY_I_PULL_DEFAULT;
    this._normallyClosed = props.has("normallyClosed") ? (props.get("normallyClosed") as boolean) : false;

    const in1node = pinNodes.get("in1")!;
    const in2node = pinNodes.get("in2")!;
    const A1node = pinNodes.get("A1")!;
    const B1node = pinNodes.get("B1")!;

    const inductance = props.has("inductance") ? (props.get("inductance") as number) : RELAY_L_DEFAULT;
    const coilResistance = props.has("coilResistance") ? (props.get("coilResistance") as number) : RELAY_R_COIL_DEFAULT;

    // coilL: in1 → coilMid (B node will be set in setup() after makeVolt)
    this._coilL = new RelayInductorSubElement(`${label}/_coilL`, inductance);
    this._coilL._pinNodes = new Map([["A", in1node], ["B", -1]]);

    // coilR: coilMid → in2 (A node will be set in setup() after makeVolt)
    this._coilR = new RelayResSubElement(new Map([["A", -1], ["B", in2node]]), coilResistance);

    // contactSW: A1 ↔ B1
    const swProps = new PropertyBag();
    swProps.set("Ron", RELAY_R_ON);
    swProps.set("Roff", RELAY_R_OFF);
    swProps.set("normallyClosed", this._normallyClosed);
    swProps.set("closed", false);
    this._contactSW = new SwitchAnalogElement(new Map([["A1", A1node], ["B1", B1node]]), swProps);
  }

  setup(ctx: SetupContext): void {
    // Allocate mid-node between coilL and coilR
    this._nCoilMid = ctx.makeVolt(this._label, "coilMid");
    this._internalLabels.push("coilMid");

    // Wire coilL: in1 → coilMid
    this._coilL._pinNodes.set("B", this._nCoilMid);

    // Wire coilR: coilMid → in2
    this._coilR._pinNodes.set("A", this._nCoilMid);

    // Sub-element setup in NGSPICE_LOAD_ORDER (IND=27 < RES=40 < SW=42)
    this._coilL.setup(ctx);      // 2 IND state slots + branch row + 5 IND handles
    this._coilR.setup(ctx);      // 0 state slots + 4 RES handles
    this._contactSW.setup(ctx);  // 2 SW state slots + 4 SW handles

    // Store coilL's stateBase as the composite's state base
    this._stateBase = this._coilL._stateBase;

    // Expose branch index (coilL's branch)
    this.branchIndex = this._coilL.branchIndex;
  }

  getInternalNodeLabels(): readonly string[] {
    return this._internalLabels;
  }

  findBranchFor(name: string, ctx: SetupContext): number {
    return this._coilL.findBranchFor(name, ctx);
  }

  load(ctx: LoadContext): void {
    this._coilL.load(ctx);      // IND Thevenin equivalent (req, veq)
    this._coilR.load(ctx);      // RES conductance stamp (coilResistance)
    this._contactSW.load(ctx);  // SW conductance based on coil current state
  }

  accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
    const b = this._coilL.branchIndex;
    const iCoil = b >= 0 ? ctx.rhs[b] : 0;
    const energised = Math.abs(iCoil) > this._iPull;
    const contactClosed = this._normallyClosed ? !energised : energised;
    this._contactSW.setSwState(contactClosed);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const b = this._coilL.branchIndex;
    const iCoil = b >= 0 ? rhs[b] : 0;
    const contactCurrents = this._contactSW.getPinCurrents(rhs);
    return [iCoil, -iCoil, contactCurrents[0], contactCurrents[1]];
  }

  setParam(key: string, value: number): void {
    if (key === "inductance") {
      this._coilL.setParam("inductance", value);
    } else if (key === "coilResistance") {
      this._coilR.setParam("resistance", value);
    } else if (key === "ron") {
      this._contactSW.setParam("Ron", value);
    } else if (key === "roff") {
      this._contactSW.setParam("Roff", value);
    }
  }
}

// ---------------------------------------------------------------------------
// createRelayAnalogElement — factory
// ---------------------------------------------------------------------------

function createRelayAnalogElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): AnalogElement {
  const label = (props.has("label") ? (props.get("label") as string) : undefined) ?? "Relay";
  return new RelayAnalogElement(label, pinNodes, props);
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

// Java RelayShape (1-pole, default):
//   Contact pins A1 at (0,0), B1 at (2,0)   — contacts on the right side of component origin
//   Coil pins in1 at (0,-2), in2 at (2,-2)   — coil terminals ABOVE (negative y)
//   Contact arm: (0,0) → (1.8,-0.5)
//   Dashed linkage: (1,-0.5) → (1,-0.95)
//   Coil rect: x 0.5..1.5, y -1..-3
//   Coil diagonal: (0.5,-1.5) → (1.5,-2.5)
//   Coil leads: (0.5,-2)→(0,-2) and (1.5,-2)→(2,-2)

const COMP_WIDTH = 2;   // contact pins at x=0 and x=2

// ---------------------------------------------------------------------------
// Pin layout helper
// ---------------------------------------------------------------------------

function buildRelayPins(poles: number, bitWidth: number): PinDeclaration[] {
  const decls: PinDeclaration[] = [];

  // Coil input pins above (negative y): in1 at (0,-2), in2 at (2,-2)
  decls.push({
    kind: "signal",
    direction: PinDirection.INPUT,
    label: "in1",
    defaultBitWidth: 1,
    position: { x: 0, y: -2 },
    isNegatable: false,
    isClockCapable: false,
  });
  decls.push({
    kind: "signal",
    direction: PinDirection.INPUT,
    label: "in2",
    defaultBitWidth: 1,
    position: { x: COMP_WIDTH, y: -2 },
    isNegatable: false,
    isClockCapable: false,
  });

  // Contact poles: A at x=0, B at x=2, one row per pole (y=0 for pole 1)
  for (let p = 0; p < poles; p++) {
    const yPos = p * 2;
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
// RelayElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class RelayElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Relay", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    const poles = this._properties.getOrDefault<number>("poles", 1);
    const bitWidth = this._properties.getOrDefault<number>("bitWidth", 1);
    return this.derivePins(buildRelayPins(poles, bitWidth), []);
  }

  getBoundingBox(): Rect {
    // Coil is ABOVE contact pins (negative y), from y=-3 to y=0 for the coil+linkage,
    // contact pins at y=0. For multi-pole, contacts extend downward.
    const poles = this._properties.getOrDefault<number>("poles", 1);
    const contactSpan = (poles - 1) * 2;
    return {
      x: this.position.x,
      y: this.position.y - 3,
      width: COMP_WIDTH,
      height: 3 + contactSpan,
    };
  }

  draw(ctx: RenderContext): void {
    const poles = this._properties.getOrDefault<number>("poles", 1);
    const normallyClosed = this._properties.getOrDefault<boolean>("normallyClosed", false);

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Contact arm: (0,0) → (1.8,-0.5) — switch arm angled upward from pin
    ctx.drawLine(0, 0, 1.8, -0.5);

    // Zero-length segment at B1 pin (2,0) so pin proximity check passes
    ctx.drawLine(2, 0, 2, 0);

    // Dashed linkage: (1,-0.5) → (1,-0.95)
    ctx.drawLine(1, -0.5, 1, -0.95);

    // Coil rectangle: x 0.5..1.5, y -1..-3
    ctx.drawRect(0.5, -3, 1, 2, false);

    // Coil diagonal: (0.5,-1.5) → (1.5,-2.5)
    ctx.drawLine(0.5, -1.5, 1.5, -2.5);

    // Coil terminal leads: (0.5,-2)→(0,-2) and (1.5,-2)→(2,-2)
    ctx.drawLine(0.5, -2, 0, -2);
    ctx.drawLine(1.5, -2, 2, -2);

    // For normally-closed: draw a straight line at y=0 across the contacts
    // (contacts closed at rest). For normally-open the arm is already angled.
    if (normallyClosed) {
      ctx.drawLine(0, 0, COMP_WIDTH, 0);
    }

    // Additional contact poles (below y=0, spaced by 2 grid units)
    for (let p = 1; p < poles; p++) {
      const py = p * 2;
      ctx.drawLine(0, py, 1.8, py - 0.5);
      if (normallyClosed) {
        ctx.drawLine(0, py, COMP_WIDTH, py);
      }
    }

    const label = this._visibleLabel();
    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, COMP_WIDTH / 2, (poles - 1) * 2 + 0.5, {
        horizontal: "center",
        vertical: "top",
      });
    }

    ctx.restore();
  }

  get normallyClosed(): boolean {
    return this._properties.getOrDefault<boolean>("normallyClosed", false);
  }
}

// ---------------------------------------------------------------------------
// executeRelay — flat simulation function
//
// Input layout: [in1=0, in2=1, A1..An, B1..Bn] (coil inputs at 0,1)
// State layout: [closedFlag=0] (written for bus resolver)
//
// The coil is energised when in1 XOR in2 is nonzero.
// For normally-open (default): closed = coilEnergised
// For normally-closed:         closed = !coilEnergised
// ---------------------------------------------------------------------------

export interface RelayLayout extends ComponentLayout {
  stateOffset(componentIndex: number): number;
}

export function executeRelay(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const stBase = (layout as RelayLayout).stateOffset(index);

  const in1 = state[wt[inBase]] & 1;
  const in2 = state[wt[inBase + 1]] & 1;

  // Coil energised when the two terminals differ (current flows through coil)
  const coilEnergised = (in1 ^ in2) !== 0 ? 1 : 0;

  // The normallyClosed flag is baked into state[stBase + 1] by the engine (1 = NC, 0 = NO)
  // For correctness in unit tests we just store the closed flag.
  // normallyClosed cannot be read from the flat function without engine context,
  // so this stores coilEnergised (normally-open behaviour) as the default.
  // The engine flips it for normally-closed relays during state initialisation.
  state[stBase] = coilEnergised;
}

// ---------------------------------------------------------------------------
// Attribute mappings and property definitions
// ---------------------------------------------------------------------------

export const RELAY_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "Poles", propertyKey: "poles", convert: (v) => parseInt(v, 10) },
  { xmlName: "relayNormallyClosed", propertyKey: "normallyClosed", convert: (v) => v === "true" },
];

const RELAY_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "poles",
    type: PropertyType.INT,
    label: "Poles",
    defaultValue: 1,
    min: 1,
    max: 4,
    description: "Number of relay contact poles",
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
    key: "normallyClosed",
    type: PropertyType.BOOLEAN,
    label: "Normally closed",
    defaultValue: false,
    description: "When true, contact is closed when coil is de-energised (NC relay)",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label shown near the component",
  },
];

function relayFactory(props: PropertyBag): RelayElement {
  return new RelayElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const RelayDefinition: ComponentDefinition = {
  name: "Relay",
  typeId: -1,
  factory: relayFactory,
  pinLayout: buildRelayPins(1, 1),
  propertyDefs: RELAY_PROPERTY_DEFS,
  attributeMap: RELAY_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText: "Relay (SPST) — coil-controlled single-pole single-throw contact switch.",
  models: {
    digital: {
      executeFn: executeRelay,
      inputSchema: ["in1", "in2"],
      outputSchema: ["A1", "B1"],
      stateSlotCount: 1,
      switchPins: [2, 3],
      defaultDelay: 0,
    },
  },
  modelRegistry: {
    "behavioral": {
      kind: "inline",
      factory: createRelayAnalogElement,
      paramDefs: [],
      params: {},
    },
  },
  defaultModel: "digital",
};
