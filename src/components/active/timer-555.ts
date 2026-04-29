/**
 * 555 Timer IC composite analog model.
 *
 * Textbook internal schematic (NE555 / LM555 datasheet):
 *
 *   VCC
 *    |
 *   [R=5kΩ]  ← upper divider arm
 *    |
 *    • CTRL pin (2/3 VCC when CTRL floating)
 *    |         └→ Comparator 1 in- (threshold reference)
 *   [R=5kΩ]  ← middle divider arm
 *    |
 *    • nLower (internal, 1/3 VCC)
 *    |         └→ Comparator 2 in- (trigger reference)
 *   [R=5kΩ]  ← lower divider arm
 *    |
 *   GND
 *
 *   Comparator 1 (threshold): in+ = THR,    in- = CTRL    RESET when THR > CTRL
 *   Comparator 2 (trigger):   in+ = nLower, in- = TRIG    SET   when TRIG < nLower
 *
 *   RS flip-flop (dominant RESET):
 *     RESET=1, SET=0   Q=0
 *     RESET=0, SET=1   Q=1
 *     RESET=0, SET=0   hold
 *     RESET=1, SET=1   Q=0 (RESET dominates per NE555 spec)
 *
 *   Active-low RESET pin: RST < GND+0.7V overrides flip-flop → forces Q=0
 *
 *   Q=1 (SET):   OUTPUT = VCC − vDrop (high), DISCHARGE = Hi-Z
 *   Q=0 (RESET): OUTPUT ≈ GND + 0.1V (low),  DISCHARGE = transistor ON
 *
 * Architecture (composite per PB-TIMER555 spec):
 *
 *   Sub-elements (in NGSPICE_LOAD_ORDER ascending):
 *     rDiv1, rDiv2, rDiv3 — RES sub-elements (NGSPICE_LOAD_ORDER.RES)
 *     comp1, comp2        — VCVS sub-elements, high-gain 1e6 (NGSPICE_LOAD_ORDER.VCVS)
 *     bjtDis              — BJT NPN sub-element (NGSPICE_LOAD_ORDER.BJT)
 *     outModel            — DigitalOutputPinModel (behavioral)
 *
 *   Internal nodes (4, allocated in setup()):
 *     nLower         — R-divider lower tap (1/3 VCC)
 *     nComp1Out      — threshold comparator output node
 *     nComp2Out      — trigger comparator output node
 *     nDisBase       — discharge BJT base node (driven by RS-FF glue)
 *
 *   State:
 *     1 slot for SR latch (0.0 = Q reset, 1.0 = Q set)
 *     BJT sub-element: 24 slots (bjtsetup.c:366-367)
 *     comp1/comp2: pool-backed via createOpenCollectorComparatorElement
 *     outModel CAP children: own state slots
 *
 * Pins (pinLayout order): [DIS, TRIG, THR, VCC, CTRL, OUT, RST, GND]
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { PinVoltageAccess } from "../../core/pin-voltage-access.js";
import { drawColoredLead } from "../draw-helpers.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
} from "../../core/registry.js";
import type { LoadContext, PoolBackedAnalogElement } from "../../solver/analog/element.js";
import { NGSPICE_LOAD_ORDER } from "../../solver/analog/element.js";
import type { SetupContext } from "../../solver/analog/setup-context.js";
import { defineModelParams } from "../../core/model-params.js";
import {
  DigitalOutputPinModel,
  collectPinModelChildren,
} from "../../solver/analog/digital-pin-model.js";
import type { AnalogElement, StatePoolRef } from "../../core/analog-types.js";
import type { AnalogCapacitorElement } from "../passives/capacitor.js";

// Sub-element: discharge BJT — bjtsetup.c:347-465 (NPN Gummel-Poon)
import {
  createBjtElement,
  BJT_NPN_DEFAULTS,
} from "../semiconductors/bjt.js";

// Sub-element: comparators as VCVS (vcvsset.c:53-58, high-gain 1e6)
import { VCVSAnalogElement } from "./vcvs.js";
import { parseExpression } from "../../solver/analog/expression.js";
import { differentiate, simplify } from "../../solver/analog/expression-differentiate.js";

// ---------------------------------------------------------------------------
// Model parameter declarations
// ---------------------------------------------------------------------------

export const { paramDefs: TIMER555_PARAM_DEFS, defaults: TIMER555_DEFAULTS } = defineModelParams({
  primary: {
    vDrop:      { default: 1.5, unit: "V", description: "Voltage drop from VCC for high output state" },
    rDischarge: { default: 10,  unit: "Ω", description: "Saturation resistance of the discharge transistor" },
  },
});

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Three equal divider arms (5kΩ each) from VCC to GND — textbook NE555. */
const R_DIV = 5000;

/** Output drive resistance (Norton equivalent, internal). */
const R_OUT = 10;

/** High-gain VCVS comparator gain (1e6). */
const COMP_GAIN = 1e6;

// ---------------------------------------------------------------------------
// Helpers to build VCVS expression for high-gain comparators
// ---------------------------------------------------------------------------

function makeVcvsComparatorExpression(): { expr: ReturnType<typeof parseExpression>; deriv: ReturnType<typeof parseExpression> } {
  const raw = parseExpression(`${COMP_GAIN} * V(ctrl)`);
  const d = simplify(differentiate(raw, "V(ctrl)"));
  return { expr: raw, deriv: d };
}

// ---------------------------------------------------------------------------
// Minimal RES sub-element — ressetup.c:46-49 TSTALLOC pattern
//
// Used as the three R-divider arms inside the Timer555 composite.
// Cannot import ResistorAnalogElement (not exported from resistor.ts);
// implement the same 4-entry TSTALLOC and stampG pattern here.
// ---------------------------------------------------------------------------

class Timer555ResElement implements AnalogElement {
  label: string = "";
  branchIndex: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.RES;
  _stateBase: number = -1;
  _pinNodes: Map<string, number> = new Map();

  private _G: number;

  // TSTALLOC handles — 4 entries per ressetup.c:46-49
  private _hPP: number = -1;
  private _hNN: number = -1;
  private _hPN: number = -1;
  private _hNP: number = -1;

  constructor(resistance: number) {
    this._G = 1 / resistance;
  }

  setup(ctx: SetupContext): void {
    const nA = this._pinNodes.get("A")!;
    const nB = this._pinNodes.get("B")!;
    // ressetup.c:46-49 — 4 TSTALLOC entries: PP, NN, PN, NP
    this._hPP = ctx.solver.allocElement(nA, nA);  // ressetup.c:46 — (RESposNode, RESposNode)
    this._hNN = ctx.solver.allocElement(nB, nB);  // ressetup.c:47 — (RESnegNode, RESnegNode)
    this._hPN = ctx.solver.allocElement(nA, nB);  // ressetup.c:48 — (RESposNode, RESnegNode)
    this._hNP = ctx.solver.allocElement(nB, nA);  // ressetup.c:49 — (RESnegNode, RESposNode)
  }

  setParam(key: string, value: number): void {
    if (key === "resistance") {
      this._G = 1 / Math.max(value, 1e-9);
    }
  }

  load(ctx: LoadContext): void {
    ctx.solver.stampElement(this._hPP,  this._G);
    ctx.solver.stampElement(this._hNN,  this._G);
    ctx.solver.stampElement(this._hPN, -this._G);
    ctx.solver.stampElement(this._hNP, -this._G);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const nA = this._pinNodes.get("A")!;
    const nB = this._pinNodes.get("B")!;
    const I = this._G * ((rhs[nA] ?? 0) - (rhs[nB] ?? 0));
    return [I, -I];
  }
}

// ---------------------------------------------------------------------------
// Pin declarations
// ---------------------------------------------------------------------------

// Pin index → nodeIds[i] mapping:
//   0: DIS      1: TRIG     2: THR      3: VCC
//   4: CTRL     5: OUT      6: RST      7: GND

function buildTimer555PinDeclarations(): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "DIS",
      defaultBitWidth: 1,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "TRIG",
      defaultBitWidth: 1,
      position: { x: 0, y: 3 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "THR",
      defaultBitWidth: 1,
      position: { x: 0, y: 5 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "VCC",
      defaultBitWidth: 1,
      position: { x: 3, y: -1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "CTRL",
      defaultBitWidth: 1,
      position: { x: 6, y: 5 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.OUTPUT,
      label: "OUT",
      defaultBitWidth: 1,
      position: { x: 6, y: 3 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "RST",
      defaultBitWidth: 1,
      position: { x: 6, y: 1 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
    {
      direction: PinDirection.INPUT,
      label: "GND",
      defaultBitWidth: 1,
      position: { x: 3, y: 7 },
      isNegatable: false,
      isClockCapable: false,
      kind: "signal",
    },
  ];
}

// ---------------------------------------------------------------------------
// Timer555Element — CircuitElement implementation
// ---------------------------------------------------------------------------

export class Timer555Element extends AbstractCircuitElement {
  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("Timer555", instanceId, position, rotation, mirror, props);
  }

  getPins(): readonly Pin[] {
    return this.derivePins(buildTimer555PinDeclarations(), []);
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y - 1,
      width: 6,
      height: 8,
    };
  }

  draw(ctx: RenderContext, signals?: PinVoltageAccess): void {
    const vVcc  = signals?.getPinVoltage("VCC");
    const vGnd  = signals?.getPinVoltage("GND");
    const vTrig = signals?.getPinVoltage("TRIG");
    const vThr  = signals?.getPinVoltage("THR");
    const vCtrl = signals?.getPinVoltage("CTRL");
    const vRst  = signals?.getPinVoltage("RST");
    const vDis  = signals?.getPinVoltage("DIS");
    const vOut  = signals?.getPinVoltage("OUT");

    ctx.save();
    ctx.setLineWidth(1);

    // IC body rectangle: (1,0) to (5,6), width=4, height=6
    ctx.setColor("COMPONENT");
    ctx.drawRect(1, 0, 4, 6, false);

    // Left-side leads: pin tip (0,y) → body edge (1,y)
    drawColoredLead(ctx, signals, vDis,  0, 1, 1, 1);
    drawColoredLead(ctx, signals, vTrig, 0, 3, 1, 3);
    drawColoredLead(ctx, signals, vThr,  0, 5, 1, 5);

    // Right-side leads: pin tip (6,y) → body edge (5,y)
    drawColoredLead(ctx, signals, vRst,  6, 1, 5, 1);
    drawColoredLead(ctx, signals, vOut,  6, 3, 5, 3);
    drawColoredLead(ctx, signals, vCtrl, 6, 5, 5, 5);

    // VCC lead (north): pin tip (3,-1) → body edge (3,0)
    drawColoredLead(ctx, signals, vVcc, 3, -1, 3, 0);

    // GND lead (south): pin tip (3,7) → body edge (3,6)
    drawColoredLead(ctx, signals, vGnd, 3, 7, 3, 6);

    // Component name centered between top and middle pin rows
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.8 });
    ctx.drawText("555", 3, 2, { horizontal: "center", vertical: "middle" });

    // Pin labels inside IC body
    ctx.setFont({ family: "sans-serif", size: 0.65 });
    ctx.drawText("DIS",  1.2, 1, { horizontal: "left", vertical: "middle" });
    ctx.drawText("TRIG", 1.2, 3, { horizontal: "left", vertical: "middle" });
    ctx.drawText("THR",  1.2, 5, { horizontal: "left", vertical: "middle" });
    ctx.drawText("RST",  4.8, 1, { horizontal: "right", vertical: "middle" });
    ctx.drawText("OUT",  4.8, 3, { horizontal: "right", vertical: "middle" });
    ctx.drawText("CTRL", 4.8, 5, { horizontal: "right", vertical: "middle" });
    ctx.drawText("VCC",  3, 0.4, { horizontal: "center", vertical: "top" });
    ctx.drawText("GND",  3, 5.6, { horizontal: "center", vertical: "top" });

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// PropertyBag builder for BJT sub-element
// ---------------------------------------------------------------------------

function makeBjtProps(): PropertyBag {
  const bag = new PropertyBag(new Map<string, number>().entries());
  bag.replaceModelParams({ ...BJT_NPN_DEFAULTS });
  return bag;
}

// ---------------------------------------------------------------------------
// Timer555CompositeElement — pool-backed composite AnalogElement
//
// Implements the PB-TIMER555 spec: setup() + load() per spec contract.
// ---------------------------------------------------------------------------

interface Timer555Props {
  vDrop: number;
  rDischarge: number;
}

class Timer555CompositeElement implements PoolBackedAnalogElement {
  branchIndex: number = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.VCVS;
  _stateBase: number = -1;
  readonly _pinNodes: Map<string, number>;

  // Pool-backed fields
  readonly poolBacked: true = true;
  readonly stateSchema = { size: 0, name: "Timer555Composite", slots: [] } as any;
  get stateSize(): number {
    return 1 + // SR latch slot
      this._bjtDis.stateSize +
      (this._comp1 as unknown as PoolBackedAnalogElement).stateSize +
      (this._comp2 as unknown as PoolBackedAnalogElement).stateSize +
      this._childElements.reduce((s, c) => s + c.stateSize, 0);
  }

  // Sub-elements (constructed at factory time, pin nodes assigned in setup())
  readonly _rDiv1: Timer555ResElement;
  readonly _rDiv2: Timer555ResElement;
  readonly _rDiv3: Timer555ResElement;
  readonly _comp1: VCVSAnalogElement;
  readonly _comp2: VCVSAnalogElement;
  // BJT is recreated in setup() once nDisBase internal node is known.
  // Stored mutable so setup() can replace the factory placeholder.
  _bjtDis: PoolBackedAnalogElement;
  readonly _bjtProps: PropertyBag;
  readonly _outModel: DigitalOutputPinModel;
  readonly _childElements: AnalogCapacitorElement[];

  // Composite-owned handles (allocated in setup(), after sub-element setups)
  private _hDisBaseDisBase: number = -1;

  // Internal node indices (assigned in setup())
  private _nLower: number = -1;
  private _nComp1Out: number = -1;
  private _nComp2Out: number = -1;
  private _nDisBase: number = -1;

  // SR latch state slot base
  private _stateBase_latch: number = -1;

  // Props
  private readonly _p: Timer555Props;

  constructor(opts: {
    rDiv1: Timer555ResElement;
    rDiv2: Timer555ResElement;
    rDiv3: Timer555ResElement;
    comp1: VCVSAnalogElement;
    comp2: VCVSAnalogElement;
    bjtDis: PoolBackedAnalogElement;
    bjtProps: PropertyBag;
    outModel: DigitalOutputPinModel;
    childElements: AnalogCapacitorElement[];
    pinNodes: ReadonlyMap<string, number>;
    props: Timer555Props;
  }) {
    this._rDiv1 = opts.rDiv1;
    this._rDiv2 = opts.rDiv2;
    this._rDiv3 = opts.rDiv3;
    this._comp1 = opts.comp1;
    this._comp2 = opts.comp2;
    this._bjtDis = opts.bjtDis;
    this._bjtProps = opts.bjtProps;
    this._outModel = opts.outModel;
    this._childElements = opts.childElements;
    this._pinNodes = new Map(opts.pinNodes);
    this._p = { ...opts.props };
  }

  // Internal node labels recorded during setup() for getInternalNodeLabels()
  private _internalLabels: string[] = [];

  getInternalNodeLabels(): readonly string[] {
    return this._internalLabels;
  }

  // ---------------------------------------------------------------------------
  // setup() — allocate internal nodes, states, TSTALLOC entries
  //
  // Sub-element ordering per A6.4 (NGSPICE_LOAD_ORDER ascending):
  //   1. RES (rDiv1, rDiv2, rDiv3) — NGSPICE_LOAD_ORDER.RES = 40
  //   2. VCVS (comp1, comp2) — NGSPICE_LOAD_ORDER.VCVS = 47
  //   3. BJT (bjtDis) — NGSPICE_LOAD_ORDER.BJT = 2
  //      (BJT ordinal < RES/VCVS; but composite's own internal ordering
  //       follows the spec's explicit ordering: RES → VCVS → BJT → behavioral)
  //   4. Behavioral (outModel, CAP children)
  //   5. Composite-owned glue handle (last)
  // ---------------------------------------------------------------------------
  setup(ctx: SetupContext): void {
    const nVcc  = this._pinNodes.get("VCC")!;
    const nCtrl = this._pinNodes.get("CTRL")!;
    const nGnd  = this._pinNodes.get("GND")!;
    const nThr  = this._pinNodes.get("THR")!;
    const nTrig = this._pinNodes.get("TRIG")!;
    const nDis  = this._pinNodes.get("DIS")!;
    const nOut  = this._pinNodes.get("OUT")!;

    // Allocate internal nodes; record labels for getInternalNodeLabels()
    this._internalLabels = [];
    this._nLower    = ctx.makeVolt(this.label || "timer555", "nLower");
    this._internalLabels.push("nLower");
    this._nComp1Out = ctx.makeVolt(this.label || "timer555", "nComp1Out");
    this._internalLabels.push("nComp1Out");
    this._nComp2Out = ctx.makeVolt(this.label || "timer555", "nComp2Out");
    this._internalLabels.push("nComp2Out");
    this._nDisBase  = ctx.makeVolt(this.label || "timer555", "nDisBase");
    this._internalLabels.push("nDisBase");

    // Composite SR latch state (1 slot)
    this._stateBase_latch = ctx.allocStates(1);
    this._stateBase = this._stateBase_latch;

    // R-divider resistors (RES TSTALLOC: 4 entries each, ressetup.c:46-49)
    this._rDiv1._pinNodes = new Map([["A", nVcc], ["B", nCtrl]]);
    this._rDiv1.setup(ctx);

    this._rDiv2._pinNodes = new Map([["A", nCtrl], ["B", this._nLower]]);
    this._rDiv2.setup(ctx);

    this._rDiv3._pinNodes = new Map([["A", this._nLower], ["B", nGnd]]);
    this._rDiv3.setup(ctx);

    // Threshold comparator VCVS (vcvsset.c:53-58, 1 branch + 6 TSTALLOC)
    // comp1: in+ = THR, in- = CTRL, out+ = nComp1Out, out- = GND
    this._comp1._pinNodes = new Map([
      ["ctrl+", nThr],
      ["ctrl-", nCtrl],
      ["out+",  this._nComp1Out],
      ["out-",  nGnd],
    ]);
    this._comp1.setup(ctx);

    // Trigger comparator VCVS (vcvsset.c:53-58, 1 branch + 6 TSTALLOC)
    // comp2: in+ = nLower, in- = TRIG, out+ = nComp2Out, out- = GND
    this._comp2._pinNodes = new Map([
      ["ctrl+", this._nLower],
      ["ctrl-", nTrig],
      ["out+",  this._nComp2Out],
      ["out-",  nGnd],
    ]);
    this._comp2.setup(ctx);

    // Discharge BJT NPN (bjtsetup.c:347-465, 24 states, 23 TSTALLOC)
    // Assign pin nodes now that nDisBase internal node is known, then set up.
    (this._bjtDis as any)._pinNodes = new Map([["B", this._nDisBase], ["C", nDis], ["E", nGnd]]);
    this._bjtDis.setup(ctx);

    // Output pin model (behavioral, DigitalOutputPinModel)
    if (nOut > 0) { this._outModel.setup(ctx); }

    // CAP children of outModel
    for (const child of this._childElements) { child.setup(ctx); }

    // RS-FF glue handle: composite-owned allocation comes AFTER all sub-element
    // setups, since it wires pre-existing nodes rather than introducing new
    // sub-element structure. (PB-TIMER555 spec §"setup() body")
    this._hDisBaseDisBase = ctx.solver.allocElement(this._nDisBase, this._nDisBase);
  }

  // ---------------------------------------------------------------------------
  // initState() — partition state pool across sub-elements
  // ---------------------------------------------------------------------------
  initState(poolRef: StatePoolRef): void {
    // BJT occupies the block starting after the latch slot
    const bjtBase = this._stateBase_latch + 1;
    this._bjtDis._stateBase = bjtBase;
    this._bjtDis.initState(poolRef);

    // Comparators follow — each is poolBacked with its own stateSize
    let offset = bjtBase + this._bjtDis.stateSize;

    const comp1 = this._comp1 as unknown as PoolBackedAnalogElement;
    if (typeof comp1.stateSize === "number") {
      comp1._stateBase = offset;
      comp1.initState(poolRef);
      offset += comp1.stateSize;
    }

    const comp2 = this._comp2 as unknown as PoolBackedAnalogElement;
    if (typeof comp2.stateSize === "number") {
      comp2._stateBase = offset;
      comp2.initState(poolRef);
      offset += comp2.stateSize;
    }

    // Capacitor children from the output pin model
    for (const child of this._childElements) {
      child._stateBase = offset;
      child.initState(poolRef);
      offset += child.stateSize;
    }
  }

  // ---------------------------------------------------------------------------
  // load() — composite forwards with RS latch coupling (PB-TIMER555 spec)
  // ---------------------------------------------------------------------------
  load(ctx: LoadContext): void {
    // ngspice DEVload-local register promotion of CKTstate0/CKTstate1
    // (cktdefs.h:82-85). The getters resolve through pool.states[i] live;
    // hoist once per load() entry to fold the property load out of the
    // per-element-access path.
    const s0 = ctx.state0;
    const s1 = ctx.state1;

    // R-divider stamps (resload.c pattern — G stamped at 4 entries)
    this._rDiv1.load(ctx);
    this._rDiv2.load(ctx);
    this._rDiv3.load(ctx);

    // Comparator stamps (VCVS load — vcvsload.c pattern)
    this._comp1.load(ctx);
    this._comp2.load(ctx);

    // RS-FF glue: read comparator outputs from rhsOld, compute latch state
    const nComp1Out = this._nComp1Out;
    const nComp2Out = this._nComp2Out;
    const nRst  = this._pinNodes.get("RST")!;
    const nGnd  = this._pinNodes.get("GND")!;
    const nVcc  = this._pinNodes.get("VCC")!;

    const vComp1Out = ctx.rhsOld[nComp1Out];
    const vComp2Out = ctx.rhsOld[nComp2Out];
    const vRst      = nRst > 0 ? ctx.rhsOld[nRst] : 5;
    const vGnd      = nGnd > 0 ? ctx.rhsOld[nGnd] : 0;

    // Active-low RST: if RST < GND + 0.7V → force Q=0
    const rstActive = vRst < vGnd + 0.7;
    // Read latch state from state1 (previous accepted) so Q is stable across
    // all NR iterations within a single step. Writing to state0 only; state1
    // holds the last-accepted value and is only updated at step-acceptance via
    // rotateStateVectors(). Without this, the latch writes to state0 on iter N
    // and reads it back on iter N+1, creating intra-NR feedback that causes
    // the latch to toggle each NR iteration and prevents convergence.
    let q = s1[this._stateBase_latch] >= 0.5;

    const resetSignal = vComp1Out > 0.5 || rstActive;
    const setSignal   = vComp2Out > 0.5 && !resetSignal;

    if (resetSignal) q = false;
    else if (setSignal) q = true;

    s0[this._stateBase_latch] = q ? 1.0 : 0.0;

    // Drive discharge BJT base: Q=0 → BJT ON (saturated); Q=1 → BJT OFF
    const bjtBaseV = q ? 0.0 : 5.0;
    const G_base = 1.0 / 100.0;
    ctx.solver.stampElement(this._hDisBaseDisBase, G_base);
    ctx.rhs[this._nDisBase] += bjtBaseV * G_base;

    // Discharge BJT stamp (bjtload.c)
    this._bjtDis.load(ctx);

    // Output stage: Q=1 → OUT = VCC - vDrop; Q=0 → OUT ≈ GND + 0.1V
    const vVcc = nVcc > 0 ? ctx.rhsOld[nVcc] : 5;
    const vOut = q ? vVcc - this._p.vDrop : vGnd + 0.1;
    this._outModel.setParam("vOH", vOut);
    this._outModel.setLogicLevel(q);
    this._outModel.load(ctx);

    // CAP children
    for (const child of this._childElements) { child.load(ctx); }
  }

  accept(ctx: LoadContext, simTime: number, addBreakpoint: (t: number) => void): void {
    // Forward accept() to sub-elements for responseTime/reactive integration
    (this._bjtDis as any).accept?.(ctx, simTime, addBreakpoint);
    (this._comp1 as any).accept?.(ctx, simTime, addBreakpoint);
    (this._comp2 as any).accept?.(ctx, simTime, addBreakpoint);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const nVcc  = this._pinNodes.get("VCC")!;
    const nGnd  = this._pinNodes.get("GND")!;
    const nCtrl = this._pinNodes.get("CTRL")!;
    const nDis  = this._pinNodes.get("DIS")!;

    const vVccV  = rhs[nVcc]  ?? 0;
    const vGndV  = rhs[nGnd]  ?? 0;
    const vCtrlV = rhs[nCtrl] ?? 0;
    const vLower = this._nLower > 0 ? (rhs[this._nLower] ?? 0) : (vCtrlV + vGndV) / 2;
    const vDis   = rhs[nDis]  ?? 0;

    const G_DIV = 1 / R_DIV;
    const gOut  = 1 / R_OUT;
    const vOutTarget = this._outModel.currentVoltage;
    const vOutNode = rhs[this._pinNodes.get("OUT")! ] ?? 0;

    const iVcc  = G_DIV * (vVccV - vCtrlV);
    const iCtrl = G_DIV * (vCtrlV - vVccV) + G_DIV * (vCtrlV - vLower);
    const iOut  = gOut * vOutNode - vOutTarget * gOut;

    return [
      G_DIV * (vDis - vGndV),  // DIS — discharge current (BJT CE path)
      0,                        // TRIG
      0,                        // THR
      iVcc,                     // VCC (into divider upper arm)
      iCtrl,                    // CTRL
      iOut,                     // OUT
      0,                        // RST
      -(iVcc + iOut),           // GND — satisfies KCL at composite boundary
    ];
  }

  setParam(key: string, value: number): void {
    if (key === "vDrop" || key === "rDischarge") {
      (this._p as any)[key] = value;
    }
  }

  label: string = "";
}

// ---------------------------------------------------------------------------
// createTimer555Element — factory (3-param signature per A6.3)
// ---------------------------------------------------------------------------

function createTimer555Element(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime: () => number,
): PoolBackedAnalogElement {
  const p: Timer555Props = {
    vDrop:      props.getModelParam<number>("vDrop"),
    rDischarge: props.getModelParam<number>("rDischarge"),
  };

  const nOutNode = pinNodes.get("OUT")!;

  // R-divider sub-elements (pin nodes assigned in setup())
  const rDiv1 = new Timer555ResElement(R_DIV);
  const rDiv2 = new Timer555ResElement(R_DIV);
  const rDiv3 = new Timer555ResElement(R_DIV);

  // Comparator VCVS sub-elements (high-gain 1e6, pins assigned in setup())
  const { expr, deriv } = makeVcvsComparatorExpression();
  const comp1 = new VCVSAnalogElement(expr, deriv, "V(ctrl)", "voltage");
  const comp2 = new VCVSAnalogElement(expr, deriv, "V(ctrl)", "voltage");

  // Discharge BJT NPN sub-element (pin nodes assigned in setup())
  const bjtProps = makeBjtProps();
  const bjtDis = createBjtElement(
    new Map([["B", 0], ["C", 0], ["E", 0]]),
    bjtProps,
    _getTime,
  ) as PoolBackedAnalogElement;

  // Output pin model
  const outModel = new DigitalOutputPinModel({
    rOut:  R_OUT,
    cOut:  0,
    rIn:   1e7,
    cIn:   0,
    vOH:   3.5,
    vOL:   0.1,
    vIH:   2.0,
    vIL:   0.8,
    rHiZ:  1e7,
  });
  if (nOutNode > 0) { outModel.init(nOutNode, -1); }

  const childElements: AnalogCapacitorElement[] = collectPinModelChildren([outModel]);

  const composite = new Timer555CompositeElement({
    rDiv1, rDiv2, rDiv3, comp1, comp2,
    bjtDis,
    bjtProps,
    outModel,
    childElements,
    pinNodes,
    props: p,
  });

  return composite;
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const TIMER555_PROPERTY_DEFS: PropertyDefinition[] = [
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

const TIMER555_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "vDrop",      propertyKey: "vDrop",      convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "rDischarge", propertyKey: "rDischarge", convert: (v) => parseFloat(v), modelParam: true },
  { xmlName: "variant",    propertyKey: "model",      convert: (v) => v },
  { xmlName: "Label",      propertyKey: "label",      convert: (v) => v },
];

// ---------------------------------------------------------------------------
// Timer555Definition
// ---------------------------------------------------------------------------

export const Timer555Definition: ComponentDefinition = {
  name: "Timer555",
  typeId: -1,
  category: ComponentCategory.ACTIVE,

  pinLayout: buildTimer555PinDeclarations(),
  propertyDefs: TIMER555_PROPERTY_DEFS,
  attributeMap: TIMER555_ATTRIBUTE_MAPPINGS,

  helpText:
    "555 Timer IC composite model (three R-divider arms + two VCVS comparators + " +
    "BJT discharge transistor + SR latch + output driver). Textbook NE555 internal schematic. " +
    "Pins: VCC, GND, TRIG, THR, CTRL, RST, DIS, OUT.",

  factory(props: PropertyBag): Timer555Element {
    return new Timer555Element(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
  },

  models: {},
  modelRegistry: {
    "bipolar": {
      kind: "inline",
      factory: createTimer555Element,
      paramDefs: TIMER555_PARAM_DEFS,
      params: { vDrop: 1.5, rDischarge: 10 },
    },
    "cmos": {
      kind: "inline",
      factory: createTimer555Element,
      paramDefs: TIMER555_PARAM_DEFS,
      params: { vDrop: 0.1, rDischarge: 10 },
    },
  },
  defaultModel: "bipolar",
};
