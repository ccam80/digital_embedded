/**
 * FGPFET — P-channel floating-gate MOSFET.
 *
 * Behaves like PFET (G=0 → conducting) except when the floating gate is
 * "programmed" (blown=true). A programmed FGPFET is permanently non-conducting
 * regardless of gate input.
 *
 * Pins:
 *   Input:         G  (gate, 1-bit)
 *   Bidirectional: S (source), D (drain)
 *
 * internalStateCount: 2 (closedFlag=0, blownFlag=1)
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
import type { FETLayout } from "./nfet.js";
import type { AnalogElementCore } from "../../core/analog-types.js";
import { NGSPICE_LOAD_ORDER } from "../../core/analog-types.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import type { LoadContext } from "../../solver/analog/load-context.js";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

// Java FETShapeP: Gate at (0,0), Source at (SIZE,0)=(1,0), Drain at (SIZE,SIZE*2)=(1,2)
const COMP_WIDTH = 1;
const COMP_HEIGHT = 2;

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

const FGPFET_PIN_DECLARATIONS: PinDeclaration[] = [
  {
    direction: PinDirection.INPUT,
    label: "G",
    defaultBitWidth: 1,
    position: { x: 0, y: 0 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "S",
    defaultBitWidth: 1,
    position: { x: 1, y: 0 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
  {
    direction: PinDirection.BIDIRECTIONAL,
    label: "D",
    defaultBitWidth: 1,
    position: { x: 1, y: 2 },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  },
];

// ---------------------------------------------------------------------------
// FGPFETElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class FGPFETElement extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("FGPFET", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(FGPFET_PIN_DECLARATIONS, []);
  }

  getBoundingBox(): Rect {
    // Drawn geometry: oxide bar at x=0.05 (min x), arrow tip at x=1.1 (max x).
    // Drain/source leads reach x=1. Height: y=0 to y=2.
    return { x: this.position.x + 0.05, y: this.position.y, width: 1.05, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    // Java FGPFETShape fixture coordinates (grid units):
    // Drain path (open):    (1,0) -> (0.55,0) -> (0.55,0.25)
    // Source path (open):   (1,2) -> (0.55,2) -> (0.55,1.75)
    // Channel gap:          (0.55,0.75) to (0.55,1.25)  NORMAL
    // Gate oxide bar:       (0.05,0)    to (0.05,2)      NORMAL
    // Floating gate (THIN): (0.3,1.8)   to (0.3,0.2)
    // Gate lead (THIN):     (0.55,1)    to (0.85,1)
    // Arrow (THIN_FILLED):  (1.1,1) -> (0.85,0.9) -> (0.85,1.1)  pointing LEFT
    const blown = this._properties.getOrDefault<boolean>("blown", false);

    ctx.save();
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);

    // Drain path (open L): use drawPath so rasterizer treats it as open polyline
    // matching Java fixture (closed=false).
    ctx.drawPath({ operations: [
      { op: "moveTo", x: 1, y: 0 },
      { op: "lineTo", x: 0.55, y: 0 },
      { op: "lineTo", x: 0.55, y: 0.25 },
    ] });
    // Source path (open L)
    ctx.drawPath({ operations: [
      { op: "moveTo", x: 1, y: 2 },
      { op: "lineTo", x: 0.55, y: 2 },
      { op: "lineTo", x: 0.55, y: 1.75 },
    ] });
    // Channel gap
    ctx.drawLine(0.55, 0.75, 0.55, 1.25);
    // Gate oxide bar
    ctx.drawLine(0.05, 0, 0.05, 2);

    // Floating gate bar
    ctx.drawLine(0.3, 1.8, 0.3, 0.2);
    // Gate lead: from channel to arrow
    ctx.drawLine(0.55, 1, 0.85, 1);
    // P-channel arrow: filled triangle pointing LEFT
    ctx.drawPolygon([{ x: 1.1, y: 1 }, { x: 0.85, y: 0.9 }, { x: 0.85, y: 1.1 }], true);

    // Blown indicator
    if (blown) {
      ctx.setColor("WIRE_ERROR");
      ctx.drawLine(0.2, 0.5, 0.7, 1.0);
      ctx.drawLine(0.7, 0.5, 0.2, 1.0);
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
// executeFGPFET — flat simulation function
//
// G=0 and not blown → closed=1; else closed=0
// State layout: [closedFlag=0, blownFlag=1]
// ---------------------------------------------------------------------------

export function executeFGPFET(index: number, state: Uint32Array, highZs: Uint32Array, layout: ComponentLayout): void {
  const wt = layout.wiringTable;
  const inBase = layout.inputOffset(index);
  const outBase = layout.outputOffset(index);
  const stBase = (layout as FETLayout).stateOffset(index);

  const gate = state[wt[inBase]!]! & 1;
  const blown = state[stBase + 1]! & 1;
  const closed = blown ? 0 : (gate ^ 1);
  state[stBase] = closed;

  const classification = layout.getSwitchClassification?.(index) ?? 1;
  if (classification !== 2) {
    const sourceNet = wt[outBase]!;
    const drainNet = wt[outBase + 1]!;
    if (closed) {
      state[drainNet] = state[sourceNet]!;
      highZs[drainNet] = 0;
    } else {
      highZs[drainNet] = 0xffffffff;
    }
  }
}

// ---------------------------------------------------------------------------
// Attribute mappings and property definitions
// ---------------------------------------------------------------------------

export const FGPFET_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
  { xmlName: "blown", propertyKey: "blown", convert: (v) => v === "true" },
];

const FGPFET_PROPERTY_DEFS: PropertyDefinition[] = [
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

function fgpfetFactory(props: PropertyBag): FGPFETElement {
  return new FGPFETElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

// ---------------------------------------------------------------------------
// FGPFETCapSubElement — CAP sub-element for floating-gate coupling
//
// Port of capsetup.c:114-117. Positive terminal wired to the floating-gate
// internal node; negative terminal wired to ground (0).
// Identical structure to FGNFET CAP sub-element.
// ---------------------------------------------------------------------------

class FGPFETCapSubElement implements AnalogElementCore {
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
    // The FGPFET composite delegates to this sub-element's load() for
    // floating-gate capacitance stamping; real stamping occurs through
    // the cached handles above once the full PB-CAP migration lands.
  }

  setParam(_key: string, _value: number): void {}

  getPinCurrents(_rhs: Float64Array): number[] {
    return [0, 0];
  }
}

// ---------------------------------------------------------------------------
// FGPFETMosSubElement — MOS sub-element for the floating-gate PMOS channel
//
// Port of mos1set.c:186-207. Gate wired to the floating-gate internal node;
// drain/source wired to the composite D/S pins; bulk tied to source.
// MOS1type = PMOS; TSTALLOC sequence is type-independent (mos1set.c:186-207
// is unconditional). Polarity sign applied only in load().
// For the 3-terminal digital FGPFET: RD=0, RS=0 so dNodePrime=dNode and
// sNodePrime=sNode (the conditional CKTmkVolt at mos1set.c:134-178 is skipped).
// ---------------------------------------------------------------------------

class FGPFETMosSubElement implements AnalogElementCore {
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
    const fgNode     = this._pinNodes.get("G")!;
    const drainNode  = this._pinNodes.get("D")!;
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
    // The FGPFET composite delegates to this sub-element's load() for
    // PMOS channel stamping (polarity=-1); real stamping occurs through
    // the cached handles above once the full PB-PMOS migration lands.
  }

  setParam(_key: string, _value: number): void {}

  getPinCurrents(_rhs: Float64Array): number[] {
    return [0, 0, 0];
  }
}

// ---------------------------------------------------------------------------
// FGPFETAnalogElement — MNA composite for floating-gate PMOS (MOS + CAP)
//
// FGPFET is a composite: a MOS sub-element (gate wired to floating-gate node,
// MOS1type=PMOS) and a CAP sub-element (floating-gate node to ground). The
// floating-gate node is allocated via ctx.makeVolt(label, "fg") in setup().
//
// This class carries no ngspiceNodeMap — composites leave that to sub-elements.
// ngspiceLoadOrder = MOS (35): the higher of MOS and CAP, so the composite
// bucket sorts after capacitors in cktLoad order.
// PFET polarity inversion (MOS1type=PMOS, polarity=-1) is applied in load() only.
// ---------------------------------------------------------------------------

export class FGPFETAnalogElement implements AnalogElementCore {
  readonly branchIndex: number = -1;
  readonly ngspiceLoadOrder: number = NGSPICE_LOAD_ORDER.MOS;
  readonly isNonlinear: boolean = true;
  readonly isReactive: boolean = true;
  _stateBase: number = -1;
  _pinNodes: Map<string, number>;
  _fgNode: number = -1;

  readonly _cap: FGPFETCapSubElement;
  readonly _mos: FGPFETMosSubElement;

  constructor(pinNodes: ReadonlyMap<string, number>) {
    this._pinNodes = new Map(pinNodes);
    const drainNode  = this._pinNodes.get("D")!;
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

    this._cap = new FGPFETCapSubElement(capPinNodes);
    this._mos = new FGPFETMosSubElement(mosPinNodes);
  }

  setup(ctx: SetupContext): void {
    // Allocate the floating-gate internal node first.
    this._fgNode = ctx.makeVolt(this.label ?? "FGPFET", "fg");

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

const fgpfetAnalogFactory: AnalogFactory = (
  pinNodes: ReadonlyMap<string, number>,
  _props: PropertyBag,
  _getTime: () => number,
): AnalogElementCore => new FGPFETAnalogElement(pinNodes);

export const FGPFETDefinition: ComponentDefinition = {
  name: "FGPFET",
  typeId: -1,
  factory: fgpfetFactory,
  pinLayout: FGPFET_PIN_DECLARATIONS,
  propertyDefs: FGPFET_PROPERTY_DEFS,
  attributeMap: FGPFET_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.SWITCHING,
  helpText: "FGPFET — P-channel floating-gate MOSFET. Programmed (blown) gate permanently disables conduction.",
  models: {
    digital: {
      executeFn: executeFGPFET,
      inputSchema: ["G"],
      outputSchema: ["S", "D"],
      stateSlotCount: 2,
      switchPins: [1, 2],
      defaultDelay: 0,
    },
  },
  modelRegistry: {
    "spice-l1": {
      kind: "inline",
      factory: fgpfetAnalogFactory,
      paramDefs: [],
      params: {},
      mayCreateInternalNodes: true,
    },
  },
};
