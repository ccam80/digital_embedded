/**
 * FGNFET — N-channel floating-gate MOSFET.
 *
 * Behaves like NFET (G=1 → conducting) except when the floating gate is
 * "programmed" (blown=true). A programmed FGNFET is permanently non-conducting
 * regardless of the gate input — it acts as a one-time programmable fuse-like
 * element used in PLD/ROM arrays.
 *
 * Pins:
 *   Input:         G  (gate, 1-bit)
 *   Bidirectional: D (drain), S (source)
 *
 * internalStateCount: 1 (closedFlag, read by bus resolver)
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
  type AnalogFactory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";
import type { AnalogElementCore } from "../../core/analog-types.js";
import { NGSPICE_LOAD_ORDER } from "../../core/analog-types.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { LoadContext } from "../../solver/analog/load-context.js";
import type { FETLayout } from "./nfet.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

// Java FETShapeN: Gate at (0,SIZE*2)=(0,2), Drain at (SIZE,0)=(1,0), Source at (SIZE,SIZE*2)=(1,2)
const COMP_WIDTH = 1;
const COMP_HEIGHT = 2;

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

const FGNFET_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "G",
    defaultBitWidth: 1,
    position: { x: 0, y: 2 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "D",
    defaultBitWidth: 1,
    position: { x: 1, y: 0 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "S",
    defaultBitWidth: 1,
    position: { x: 1, y: 2 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
];

// ---------------------------------------------------------------------------
// FGNFETElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class FGNFETElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("FGNFET", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(FGNFET_PIN_DECLARATIONS, []);
  }

  getBoundingBox(): Rect {
    // Drawn geometry: oxide bar at x=0.05 (min), gate lead to x=1.15 (max).
    // Arrow tip at x=0.75, base at x=1.0. Drain/source leads at x=1.
    // Height: y=0 to y=2.
    return { x: this.position.x + 0.05, y: this.position.y, width: 1.1, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    const blown = this._properties.getOrDefault<boolean>("blown", false);

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Drain lead: (1,0) → (0.55,0) → (0.55,0.25)
    ctx.drawLine(1, 0, 0.55, 0);
    ctx.drawLine(0.55, 0, 0.55, 0.25);

    // Source lead: (1,2) → (0.55,2) → (0.55,1.75)
    ctx.drawLine(1, 2, 0.55, 2);
    ctx.drawLine(0.55, 2, 0.55, 1.75);

    // Channel gap line: (0.55,0.75) to (0.55,1.25)
    ctx.drawLine(0.55, 0.75, 0.55, 1.25);

    // Gate oxide bar: vertical line at x=0.05 from y=0 to y=2
    ctx.drawLine(0.05, 0, 0.05, 2);

    // Floating gate bar (THIN): (0.3,1.8) to (0.3,0.2)
    ctx.setLineWidth(0.5);
    ctx.drawLine(0.3, 1.8, 0.3, 0.2);

    // Gate lead (THIN): (0.9,1) to (1.15,1) — extends to x=1.15 per Java fixture
    ctx.drawLine(0.9, 1, 1.15, 1);

    // N-channel arrow (THIN_FILLED): tip at (0.75,1), base at (1,0.9)→(1,1.1)
    ctx.drawPolygon([
      { x: 0.75, y: 1 },
      { x: 1, y: 0.9 },
      { x: 1, y: 1.1 },
    ], true);
    ctx.setLineWidth(1);

    // Blown indicator: X mark
    if (blown) {
      ctx.setColor("WIRE_ERROR");
      ctx.drawLine(0.5, 0.5, 1.0, 1.0);
      ctx.drawLine(1.0, 0.5, 0.5, 1.0);
    }

    const label = this._visibleLabel();
    if (label.length > 0) {
      ctx.setColor("TEXT");
      ctx.setFont({ family: "sans-serif", size: 0.8 });
      ctx.drawText(label, COMP_WIDTH / 2, -0.4, { horizontal: "center", vertical: "bottom" });
    }

    ctx.restore();
  }

  get blown(): boolean {
    return this._properties.getOrDefault<boolean>("blown", false);
  }
}

// ---------------------------------------------------------------------------
// executeFGNFET — flat simulation function
//
// G=1 and not blown → closed=1; else closed=0
// The blown flag is baked into propertyDefs; not available here directly.
// The engine reads blown from component properties during compilation and
// writes it to state[stBase + 1]. We read it from there.
//
// State layout: [closedFlag=0, blownFlag=1]
// ---------------------------------------------------------------------------

export function executeFGNFET(index: number, state: Uint32Array, highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = (layout as FETLayout).stateOffset(index);

  const gate = state[wt[inBase]!]! & 1;
  const blown = state[stBase + 1]! & 1;
  const closed = blown ? 0 : gate;
  state[stBase] = closed;

  const classification = layout.getSwitchClassification?.(index) ?? 1;
  if (classification !== 2) {
    const drainNet = wt[outBase]!;
    const sourceNet = wt[outBase + 1]!;
    if (closed) {
      state[sourceNet] = state[drainNet]!;
      highZs[sourceNet] = 0;
    } else {
      highZs[sourceNet] = 0xffffffff;
    }
  }
}

// ---------------------------------------------------------------------------
// Attribute mappings and property definitions
// ---------------------------------------------------------------------------

export const FGNFET_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "blown", propertyKey: "blown", convert: (v) => v === "true" },
];

const FGNFET_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "bitWidth",
    type: PropertyType.BIT_WIDTH,
    label: "Bits",
    defaultValue: 1,
    min: 1,
    max: 32,
    description: "Bit width of the switched signal",
    structural: true,
  },
  {
    key: "blown",
    type: PropertyType.BOOLEAN,
    label: "Blown",
    defaultValue: false,
    description: "When true, floating gate is programmed — FET is permanently non-conducting",
  },
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label",
  },
];

// ---------------------------------------------------------------------------
// FGNFETCapSubElement — CAP sub-element for floating-gate coupling
//
// Port of capsetup.c:114-117. Positive terminal wired to the floating-gate
// internal node; negative terminal wired to ground (0).
// ---------------------------------------------------------------------------

class FGNFETCapSubElement implements AnalogElementCore {
  readonly branchIndex: number = -1;
  readonly ngspiceLoadOrder: number = NGSPICE_LOAD_ORDER.CAP;
  readonly isNonlinear: boolean = false;
  readonly isReactive: boolean = true;
  _stateBase: number = -1;
  _pinNodes: Map<string, number>;

  // Matrix handles allocated during setup() — capsetup.c:114-117
  _hPP: number = -1;
  _hNN: number = -1;
  _hPN: number = -1;
  _hNP: number = -1;

  constructor(pinNodes: Map<string, number>) {
    this._pinNodes = pinNodes;
  }

  setup(ctx: SetupContext): void {
    const posNode = this._pinNodes.get("pos")!;
    const negNode = this._pinNodes.get("neg")!;
    this._stateBase = ctx.allocStates(2);
    // capsetup.c:114-117 — 4 TSTALLOC entries
    this._hPP = ctx.solver.allocElement(posNode, posNode);
    this._hNN = ctx.solver.allocElement(negNode, negNode);
    this._hPN = ctx.solver.allocElement(posNode, negNode);
    this._hNP = ctx.solver.allocElement(negNode, posNode);
  }

  load(_ctx: LoadContext): void {
    // CAP load deferred to the migrated AnalogCapacitorElement path.
    // The FGNFET composite delegates to this sub-element's load() for
    // floating-gate capacitance stamping; real stamping occurs through
    // the cached handles above once the full PB-CAP migration lands.
  }

  setParam(_key: string, _value: number): void {}

  getPinCurrents(_rhs: Float64Array): number[] {
    return [0, 0];
  }
}

// ---------------------------------------------------------------------------
// FGNFETMosSubElement — MOS sub-element for the floating-gate NMOS channel
//
// Port of mos1set.c:186-207. Gate wired to the floating-gate internal node;
// drain/source wired to the composite D/S pins; bulk tied to source.
// For the 3-terminal digital FGNFET: RD=0, RS=0 so dNodePrime=dNode and
// sNodePrime=sNode (the conditional CKTmkVolt at mos1set.c:134-178 is skipped).
// ---------------------------------------------------------------------------

class FGNFETMosSubElement implements AnalogElementCore {
  readonly branchIndex: number = -1;
  readonly ngspiceLoadOrder: number = NGSPICE_LOAD_ORDER.MOS;
  readonly isNonlinear: boolean = true;
  readonly isReactive: boolean = false;
  _stateBase: number = -1;
  _pinNodes: Map<string, number>;

  // Matrix handles allocated during setup() — mos1set.c:186-207 (22 entries)
  _hDd: number = -1;
  _hGg: number = -1;
  _hSs: number = -1;
  _hBb: number = -1;
  _hDPdp: number = -1;
  _hSPsp: number = -1;
  _hDdp: number = -1;
  _hGb: number = -1;
  _hGdp: number = -1;
  _hGsp: number = -1;
  _hSsp: number = -1;
  _hBdp: number = -1;
  _hBsp: number = -1;
  _hDPsp: number = -1;
  _hDPd: number = -1;
  _hBg: number = -1;
  _hDPg: number = -1;
  _hSPg: number = -1;
  _hSPs: number = -1;
  _hDPb: number = -1;
  _hSPb: number = -1;
  _hSPdp: number = -1;

  constructor(pinNodes: Map<string, number>) {
    this._pinNodes = pinNodes;
  }

  setup(ctx: SetupContext): void {
    const fgNode    = this._pinNodes.get("G")!;
    const drainNode = this._pinNodes.get("D")!;
    const sourceNode = this._pinNodes.get("S")!;
    // bulk = source (3-terminal: no separate bulk pin)
    // dNodePrime = dNode, sNodePrime = sNode (RD=0, RS=0)

    // MOS1numStates = 17 state slots (mos1defs.h:269-291: MOS1vbd..MOS1cqbs)
    // plus 11 DC-OP scalars (cd, cbd, cbs, gbd, gbs, gm, gds, gmbs, mode, von, vdsat) = 28 total
    this._stateBase = ctx.allocStates(28);

    // mos1set.c:186-207 — 22 TSTALLOC entries, in order
    this._hDd   = ctx.solver.allocElement(drainNode,  drainNode);
    this._hGg   = ctx.solver.allocElement(fgNode,     fgNode);
    this._hSs   = ctx.solver.allocElement(sourceNode, sourceNode);
    this._hBb   = ctx.solver.allocElement(sourceNode, sourceNode);
    this._hDPdp = ctx.solver.allocElement(drainNode,  drainNode);
    this._hSPsp = ctx.solver.allocElement(sourceNode, sourceNode);
    this._hDdp  = ctx.solver.allocElement(drainNode,  drainNode);
    this._hGb   = ctx.solver.allocElement(fgNode,     sourceNode);
    this._hGdp  = ctx.solver.allocElement(fgNode,     drainNode);
    this._hGsp  = ctx.solver.allocElement(fgNode,     sourceNode);
    this._hSsp  = ctx.solver.allocElement(sourceNode, sourceNode);
    this._hBdp  = ctx.solver.allocElement(sourceNode, drainNode);
    this._hBsp  = ctx.solver.allocElement(sourceNode, sourceNode);
    this._hDPsp = ctx.solver.allocElement(drainNode,  sourceNode);
    this._hDPd  = ctx.solver.allocElement(drainNode,  drainNode);
    this._hBg   = ctx.solver.allocElement(sourceNode, fgNode);
    this._hDPg  = ctx.solver.allocElement(drainNode,  fgNode);
    this._hSPg  = ctx.solver.allocElement(sourceNode, fgNode);
    this._hSPs  = ctx.solver.allocElement(sourceNode, sourceNode);
    this._hDPb  = ctx.solver.allocElement(drainNode,  sourceNode);
    this._hSPb  = ctx.solver.allocElement(sourceNode, sourceNode);
    this._hSPdp = ctx.solver.allocElement(sourceNode, drainNode);
  }

  load(_ctx: LoadContext): void {
    // MOS load deferred to the migrated MosfetAnalogElement path.
    // The FGNFET composite delegates to this sub-element's load() for
    // NMOS channel stamping; real stamping occurs through the cached handles
    // above once the full PB-NMOS migration lands.
  }

  setParam(_key: string, _value: number): void {}

  getPinCurrents(_rhs: Float64Array): number[] {
    return [0, 0, 0];
  }
}

// ---------------------------------------------------------------------------
// FGNFETAnalogElement — MNA composite for floating-gate NMOS (MOS + CAP)
//
// FGNFET is a composite: a MOS sub-element (gate wired to floating-gate node)
// and a CAP sub-element (floating-gate node to ground). The floating-gate node
// is allocated via ctx.makeVolt(label, "fg") in setup().
//
// This class carries no ngspiceNodeMap — composites leave that to sub-elements.
// ngspiceLoadOrder = MOS (35): the higher of MOS and CAP, so the composite
// bucket sorts after capacitors in cktLoad order.
// ---------------------------------------------------------------------------

export class FGNFETAnalogElement implements AnalogElementCore {
  readonly branchIndex: number = -1;
  readonly ngspiceLoadOrder: number = NGSPICE_LOAD_ORDER.MOS;
  readonly isNonlinear: boolean = true;
  readonly isReactive: boolean = true;
  _stateBase: number = -1;
  _pinNodes: Map<string, number>;
  _fgNode: number = -1;

  readonly _cap: FGNFETCapSubElement;
  readonly _mos: FGNFETMosSubElement;

  constructor(pinNodes: ReadonlyMap<string, number>) {
    this._pinNodes = new Map(pinNodes);
    const drainNode = this._pinNodes.get("D")!;
    const sourceNode = this._pinNodes.get("S")!;

    // Sub-element pin maps use placeholder 0 for the floating-gate node;
    // setup() overwrites with the allocated fgNode before calling sub.setup().
    const capPinNodes = new Map<string, number>([
      ["pos", 0],
      ["neg", 0],
    ]);
    const mosPinNodes = new Map<string, number>([
      ["G", 0],
      ["D", drainNode],
      ["S", sourceNode],
    ]);

    this._cap = new FGNFETCapSubElement(capPinNodes);
    this._mos = new FGNFETMosSubElement(mosPinNodes);
  }

  setup(ctx: SetupContext): void {
    // Allocate the floating-gate internal node first.
    // MOS gate and CAP positive terminal both reference this node.
    this._fgNode = ctx.makeVolt(this.label ?? "FGNFET", "fg");

    // Patch fgNode into sub-element pin maps before calling their setup().
    this._cap._pinNodes.set("pos", this._fgNode);
    this._cap._pinNodes.set("neg", 0);
    this._mos._pinNodes.set("G", this._fgNode);

    // Sort sub-elements by ngspiceLoadOrder; ascending order = ngspice cktLoad order.
    // CAP (17) loads before MOS (35), so CAP's state slots and handles come first.
    for (const sub of [this._cap, this._mos].sort((a, b) => a.ngspiceLoadOrder - b.ngspiceLoadOrder)) {
      sub.setup(ctx);
    }
  }

  load(ctx: LoadContext): void {
    this._cap.load(ctx);
    this._mos.load(ctx);
  }

  setParam(_key: string, _value: number): void {}

  getPinCurrents(_rhs: Float64Array): number[] {
    return [0, 0, 0];
  }
}

const fgnfetAnalogFactory: AnalogFactory = (
  pinNodes: ReadonlyMap<string, number>,
  _props: PropertyBag,
  _getTime: () => number,
): AnalogElementCore => new FGNFETAnalogElement(pinNodes);

function fgnfetFactory(props: PropertyBag): FGNFETElement {
  return new FGNFETElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const FGNFETDefinition: ComponentDefinition = {
  name: "FGNFET",
  typeId: -1,
  factory: fgnfetFactory,
  pinLayout: FGNFET_PIN_DECLARATIONS,
  propertyDefs: FGNFET_PROPERTY_DEFS,
  attributeMap: FGNFET_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText: "FGNFET — N-channel floating-gate MOSFET. Programmed (blown) gate permanently disables conduction.",
  models: {
    digital: {
      executeFn: executeFGNFET,
      inputSchema: ["G"],
      outputSchema: ["D", "S"],
      stateSlotCount: 2,
      switchPins: [1, 2],
      defaultDelay: 0,
    },
  },
  modelRegistry: {
    "spice-l1": {
      kind: "inline",
      factory: fgnfetAnalogFactory,
      paramDefs: [],
      params: {},
      mayCreateInternalNodes: true,
    },
  },
};
