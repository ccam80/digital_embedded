/**
 * Behavioral analog factories for remaining digital components.
 *
 * Provides analogFactory functions for:
 *   - Driver (tri-state buffer)
 *   - DriverInvSel (inverting tri-state buffer)
 *   - Splitter / BusSplitter (pass-through per bit)
 *   - SevenSeg / SevenSegHex (7 parallel LED diode models)
 *   - Relay / RelayDT (coil inductor + variable resistance contact)
 *   - Switch / SwitchDT (variable resistance)
 *   - ButtonLED (switch + LED diode)
 *
 * LED diode parameters and the LED analog model are imported from the LED
 * component which already defines createLedAnalogElement. The relay coil
 * uses a companion-model inductor plus DC winding resistance. Contacts are
 * modeled as a variable resistance updated at each accepted timestep.
 */

import type { SparseSolver } from "./sparse-solver.js";
import type { AnalogElementCore, PoolBackedAnalogElementCore, LoadContext, StatePoolRef, IntegrationMethod } from "./element.js";
import { NGSPICE_LOAD_ORDER } from "./element.js";
import type { LteParams } from "./ckt-terr.js";
import type { PropertyBag } from "../../core/properties.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";
import type { SetupContext } from "./setup-context.js";
import {
  collectPinModelChildren,
  delegatePinSetParam,
  DigitalInputPinModel,
  DigitalOutputPinModel,
  readMnaVoltage,
} from "./digital-pin-model.js";
import { defineStateSchema } from "./state-schema.js";
import type { StateSchema } from "./state-schema.js";
import type { AnalogCapacitorElement } from "../../components/passives/capacitor.js";
import { AnalogInductorElement, INDUCTOR_DEFAULTS } from "../../components/passives/inductor.js";

const REMAINING_COMPOSITE_SCHEMA: StateSchema = defineStateSchema("BehavioralRemainingComposite", []);

// ---------------------------------------------------------------------------
// Shared electrical fallback spec
// ---------------------------------------------------------------------------

const CMOS_3V3_FALLBACK: ResolvedPinElectrical = {
  rOut: 50,
  cOut: 5e-12,
  rIn: 1e7,
  cIn: 5e-12,
  vOH: 3.3,
  vOL: 0.0,
  vIH: 2.0,
  vIL: 0.8,
  rHiZ: 1e7,
};

function getPinSpec(
  props: PropertyBag,
  label: string,
): ResolvedPinElectrical {
  const pinSpecs = props.has("_pinElectrical")
    ? (props.get("_pinElectrical") as unknown as Record<string, ResolvedPinElectrical>)
    : undefined;
  return pinSpecs?.[label] ?? CMOS_3V3_FALLBACK;
}

function getPinLoadingFlag(props: PropertyBag, label: string, defaultValue: boolean): boolean {
  if (!props.has("_pinLoading")) return defaultValue;
  const pinLoading = props.get("_pinLoading") as unknown as Record<string, boolean>;
  return pinLoading[label] ?? defaultValue;
}

// ---------------------------------------------------------------------------
// Helper: stamp a conductance between two MNA nodes (ground = node 0 not stamped)
// ---------------------------------------------------------------------------

function stampG(
  solver: SparseSolver,
  nA: number,
  nB: number,
  g: number,
): void {
  if (nA > 0) solver.stampElement(solver.allocElement(nA, nA), g);
  if (nB > 0) solver.stampElement(solver.allocElement(nB, nB), g);
  if (nA > 0 && nB > 0) {
    solver.stampElement(solver.allocElement(nA, nB), -g);
    solver.stampElement(solver.allocElement(nB, nA), -g);
  }
}

function stampRHS(rhs: Float64Array, n: number, val: number): void {
  if (n > 0) rhs[n] += val;
}

// ---------------------------------------------------------------------------
// Driver analog factory - tri-state buffer
//
// Pin labels (matching buildDriverPinDeclarations):
//   "in"  = data input
//   "sel" = enable
//   "out" = output
//
// When sel > vIH: output = input logic level via DigitalOutputPinModel (driven)
// When sel < vIL: output in Hi-Z mode (R_HiZ to ground)
// ---------------------------------------------------------------------------

class DriverAnalogElement implements PoolBackedAnalogElementCore {
  readonly branchIndex = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.VCVS;
  readonly isNonlinear = true;
  readonly poolBacked = true as const;
  readonly stateSchema = REMAINING_COMPOSITE_SCHEMA;

  _stateBase: number = -1;
  _pinNodes: Map<string, number>;

  readonly _inputPins: readonly DigitalInputPinModel[];
  readonly _outputPins: readonly DigitalOutputPinModel[];
  readonly _subElements: readonly AnalogElementCore[] = [];
  readonly _childElements: readonly AnalogCapacitorElement[];

  private readonly inputPin: DigitalInputPinModel;
  private readonly selPin: DigitalInputPinModel;
  private readonly outputPin: DigitalOutputPinModel;
  private readonly nodeIn: number;
  private readonly nodeSel: number;
  private readonly nodeOut: number;
  private readonly pinModelsByLabel: Map<string, DigitalInputPinModel | DigitalOutputPinModel>;

  readonly stateSize: number;
  stateBaseOffset = -1;
  s0 = new Float64Array(0);
  s1 = new Float64Array(0);
  s2 = new Float64Array(0);
  s3 = new Float64Array(0);
  s4 = new Float64Array(0);
  s5 = new Float64Array(0);
  s6 = new Float64Array(0);
  s7 = new Float64Array(0);

  private latchedIn = false;
  private latchedSel = false;

  constructor(
    pinNodes: ReadonlyMap<string, number>,
    props: PropertyBag,
  ) {
    this._pinNodes = new Map(pinNodes);
    this.nodeIn = pinNodes.get("in") ?? 0;
    this.nodeSel = pinNodes.get("sel") ?? 0;
    this.nodeOut = pinNodes.get("out") ?? 0;

    const inSpec = getPinSpec(props, "in");
    const selSpec = getPinSpec(props, "sel");
    const outSpec = getPinSpec(props, "out");

    this.inputPin = new DigitalInputPinModel(inSpec, getPinLoadingFlag(props, "in", true));
    this.inputPin.init(this.nodeIn, 0);

    this.selPin = new DigitalInputPinModel(selSpec, getPinLoadingFlag(props, "sel", true));
    this.selPin.init(this.nodeSel, 0);

    this.outputPin = new DigitalOutputPinModel(outSpec, getPinLoadingFlag(props, "out", false), "direct");
    this.outputPin.init(this.nodeOut, -1);
    this.outputPin.setHighZ(true);

    this.pinModelsByLabel = new Map<string, DigitalInputPinModel | DigitalOutputPinModel>([
      ["in", this.inputPin],
      ["sel", this.selPin],
      ["out", this.outputPin],
    ]);

    this._inputPins = [this.inputPin, this.selPin];
    this._outputPins = [this.outputPin];
    this._childElements = collectPinModelChildren([this.inputPin, this.selPin, this.outputPin]);
    this.stateSize = this._childElements.reduce((s, c) => s + c.stateSize, 0);
  }

  get isReactive(): boolean { return this._childElements.length > 0; }

  setup(ctx: SetupContext): void {
    this.inputPin.setup(ctx);
    this.selPin.setup(ctx);
    this.outputPin.setup(ctx);
    for (const child of this._childElements) child.setup(ctx);
  }

  initState(pool: StatePoolRef): void {
    let offset = this.stateBaseOffset;
    for (const child of this._childElements) {
      child.stateBaseOffset = offset;
      child.initState(pool);
      offset += child.stateSize;
    }
  }

  load(ctx: LoadContext): void {
    const v = ctx.rhsOld;

    this.inputPin.load(ctx);
    this.selPin.load(ctx);

    const vIn = readMnaVoltage(this.nodeIn, v);
    const vSel = readMnaVoltage(this.nodeSel, v);

    const inLevel = this.inputPin.readLogicLevel(vIn);
    if (inLevel !== undefined) this.latchedIn = inLevel;

    const selLevel = this.selPin.readLogicLevel(vSel);
    if (selLevel !== undefined) this.latchedSel = selLevel;

    this.outputPin.setHighZ(!this.latchedSel);
    this.outputPin.setLogicLevel(this.latchedIn);
    this.outputPin.load(ctx);

    for (const child of this._childElements) { child.load(ctx); }
  }

  accept(_ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {}

  getPinCurrents(rhs: Float64Array): number[] {
    const vIn = readMnaVoltage(this.nodeIn, rhs);
    const iIn = vIn / this.inputPin.rIn;

    const vSel = readMnaVoltage(this.nodeSel, rhs);
    const iSel = vSel / this.selPin.rIn;

    const vOut = readMnaVoltage(this.nodeOut, rhs);
    const iOut = this.outputPin.isHiZ
      ? vOut / this.outputPin.rHiZ
      : (vOut - this.outputPin.currentVoltage) / this.outputPin.rOut;

    return [iIn, iSel, iOut];
  }

  setParam(key: string, value: number): void { delegatePinSetParam(this.pinModelsByLabel, key, value); }
}

export function createDriverAnalogElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime?: () => number,
): PoolBackedAnalogElementCore {
  return new DriverAnalogElement(pinNodes, props);
}

// ---------------------------------------------------------------------------
// DriverInvSel analog factory - inverting tri-state (active-low enable)
//
// Same as Driver but enable logic is inverted: sel=0 â†' driven, sel=1 â†' Hi-Z
// Pin labels: "in", "sel", "out" (matching buildDriverPinDeclarations)
// ---------------------------------------------------------------------------

class DriverInvAnalogElement implements PoolBackedAnalogElementCore {
  readonly branchIndex = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.VCVS;
  readonly isNonlinear = true;
  readonly poolBacked = true as const;
  readonly stateSchema = REMAINING_COMPOSITE_SCHEMA;

  _stateBase: number = -1;
  _pinNodes: Map<string, number>;

  readonly _inputPins: readonly DigitalInputPinModel[];
  readonly _outputPins: readonly DigitalOutputPinModel[];
  readonly _subElements: readonly AnalogElementCore[] = [];
  readonly _childElements: readonly AnalogCapacitorElement[];

  private readonly inputPin: DigitalInputPinModel;
  private readonly selPin: DigitalInputPinModel;
  private readonly outputPin: DigitalOutputPinModel;
  private readonly nodeIn: number;
  private readonly nodeSel: number;
  private readonly nodeOut: number;
  private readonly pinModelsByLabel: Map<string, DigitalInputPinModel | DigitalOutputPinModel>;

  readonly stateSize: number;
  stateBaseOffset = -1;
  s0 = new Float64Array(0);
  s1 = new Float64Array(0);
  s2 = new Float64Array(0);
  s3 = new Float64Array(0);
  s4 = new Float64Array(0);
  s5 = new Float64Array(0);
  s6 = new Float64Array(0);
  s7 = new Float64Array(0);

  private latchedIn = false;
  private latchedSel = false;

  constructor(
    pinNodes: ReadonlyMap<string, number>,
    props: PropertyBag,
  ) {
    this._pinNodes = new Map(pinNodes);
    this.nodeIn = pinNodes.get("in") ?? 0;
    this.nodeSel = pinNodes.get("sel") ?? 0;
    this.nodeOut = pinNodes.get("out") ?? 0;

    const inSpec = getPinSpec(props, "in");
    const selSpec = getPinSpec(props, "sel");
    const outSpec = getPinSpec(props, "out");

    this.inputPin = new DigitalInputPinModel(inSpec, getPinLoadingFlag(props, "in", true));
    this.inputPin.init(this.nodeIn, 0);

    this.selPin = new DigitalInputPinModel(selSpec, getPinLoadingFlag(props, "sel", true));
    this.selPin.init(this.nodeSel, 0);

    this.outputPin = new DigitalOutputPinModel(outSpec, getPinLoadingFlag(props, "out", false), "direct");
    this.outputPin.init(this.nodeOut, -1);
    this.outputPin.setHighZ(false);

    this.pinModelsByLabel = new Map<string, DigitalInputPinModel | DigitalOutputPinModel>([
      ["in", this.inputPin],
      ["sel", this.selPin],
      ["out", this.outputPin],
    ]);

    this._inputPins = [this.inputPin, this.selPin];
    this._outputPins = [this.outputPin];
    this._childElements = collectPinModelChildren([this.inputPin, this.selPin, this.outputPin]);
    this.stateSize = this._childElements.reduce((s, c) => s + c.stateSize, 0);
  }

  get isReactive(): boolean { return this._childElements.length > 0; }

  setup(ctx: SetupContext): void {
    this.inputPin.setup(ctx);
    this.selPin.setup(ctx);
    this.outputPin.setup(ctx);
    for (const child of this._childElements) child.setup(ctx);
  }

  initState(pool: StatePoolRef): void {
    let offset = this.stateBaseOffset;
    for (const child of this._childElements) {
      child.stateBaseOffset = offset;
      child.initState(pool);
      offset += child.stateSize;
    }
  }

  load(ctx: LoadContext): void {
    const v = ctx.rhsOld;

    this.inputPin.load(ctx);
    this.selPin.load(ctx);

    const vIn = readMnaVoltage(this.nodeIn, v);
    const vSel = readMnaVoltage(this.nodeSel, v);

    const inLevel = this.inputPin.readLogicLevel(vIn);
    if (inLevel !== undefined) this.latchedIn = inLevel;

    const selLevel = this.selPin.readLogicLevel(vSel);
    if (selLevel !== undefined) this.latchedSel = selLevel;

    this.outputPin.setHighZ(this.latchedSel);
    this.outputPin.setLogicLevel(this.latchedIn);
    this.outputPin.load(ctx);

    for (const child of this._childElements) { child.load(ctx); }
  }

  accept(_ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {}

  getPinCurrents(rhs: Float64Array): number[] {
    const vIn = readMnaVoltage(this.nodeIn, rhs);
    const iIn = vIn / this.inputPin.rIn;

    const vSel = readMnaVoltage(this.nodeSel, rhs);
    const iSel = vSel / this.selPin.rIn;

    const vOut = readMnaVoltage(this.nodeOut, rhs);
    const iOut = this.outputPin.isHiZ
      ? vOut / this.outputPin.rHiZ
      : (vOut - this.outputPin.currentVoltage) / this.outputPin.rOut;

    return [iIn, iSel, iOut];
  }

  setParam(key: string, value: number): void { delegatePinSetParam(this.pinModelsByLabel, key, value); }
}

export function createDriverInvAnalogElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime?: () => number,
): PoolBackedAnalogElementCore {
  return new DriverInvAnalogElement(pinNodes, props);
}

// ---------------------------------------------------------------------------
// Splitter analog factory - pass-through per bit
//
// Pin labels are dynamic bit-range names from buildSplitterPinDeclarations
// (e.g. "0", "4-7", "0,1"). Inputs come first in pinLayout order, outputs after.
// The _inputCount/_outputCount props indicate how many of each there are.
//
// Each input voltage is threshold-detected and its level is driven on the
// corresponding output. For mismatched port counts the min(N, M) pairs are
// connected and remaining ports are driven LOW.
// ---------------------------------------------------------------------------

class SplitterAnalogElement implements PoolBackedAnalogElementCore {
  readonly branchIndex = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.VCVS;
  readonly isNonlinear = true;
  readonly poolBacked = true as const;
  readonly stateSchema = REMAINING_COMPOSITE_SCHEMA;

  _stateBase: number = -1;
  _pinNodes: Map<string, number>;

  readonly _inputPins: readonly DigitalInputPinModel[];
  readonly _outputPins: readonly DigitalOutputPinModel[];
  readonly _subElements: readonly AnalogElementCore[] = [];
  readonly _childElements: readonly AnalogCapacitorElement[];

  private readonly inputPins: DigitalInputPinModel[];
  private readonly outputPins: DigitalOutputPinModel[];
  private readonly latchedLevels: boolean[];
  private readonly numIn: number;
  private readonly numOut: number;

  readonly stateSize: number;
  stateBaseOffset = -1;
  s0 = new Float64Array(0);
  s1 = new Float64Array(0);
  s2 = new Float64Array(0);
  s3 = new Float64Array(0);
  s4 = new Float64Array(0);
  s5 = new Float64Array(0);
  s6 = new Float64Array(0);
  s7 = new Float64Array(0);

  constructor(
    pinNodes: ReadonlyMap<string, number>,
    props: PropertyBag,
  ) {
    this._pinNodes = new Map(pinNodes);
    this.numIn = props.has("_inputCount") ? (props.get("_inputCount") as number) : 1;
    this.numOut = props.has("_outputCount") ? (props.get("_outputCount") as number) : 1;

    const allNodeIds = Array.from(pinNodes.values());
    const allLabels = Array.from(pinNodes.keys());

    this.inputPins = [];
    this.outputPins = [];

    for (let i = 0; i < this.numIn; i++) {
      const label = allLabels[i] ?? `in${i}`;
      const spec = getPinSpec(props, label);
      const pin = new DigitalInputPinModel(spec, getPinLoadingFlag(props, label, true));
      pin.init(allNodeIds[i] ?? 0, 0);
      this.inputPins.push(pin);
    }

    this.latchedLevels = new Array(this.numIn).fill(false);

    for (let i = 0; i < this.numOut; i++) {
      const label = allLabels[this.numIn + i] ?? `out${i}`;
      const spec = getPinSpec(props, label);
      const pin = new DigitalOutputPinModel(spec, getPinLoadingFlag(props, label, false), "direct");
      pin.init(allNodeIds[this.numIn + i] ?? 0, -1);
      pin.setLogicLevel(false);
      this.outputPins.push(pin);
    }

    this._inputPins = this.inputPins;
    this._outputPins = this.outputPins;
    this._childElements = collectPinModelChildren([...this.inputPins, ...this.outputPins]);
    this.stateSize = this._childElements.reduce((s, c) => s + c.stateSize, 0);
  }

  get isReactive(): boolean { return this._childElements.length > 0; }

  setup(ctx: SetupContext): void {
    for (const pin of this.inputPins) pin.setup(ctx);
    for (const pin of this.outputPins) pin.setup(ctx);
    for (const child of this._childElements) child.setup(ctx);
  }

  initState(_pool: StatePoolRef): void {
    let offset = this.stateBaseOffset;
    for (const child of this._childElements) {
      child.stateBaseOffset = offset;
      child.initState(_pool);
      offset += child.stateSize;
    }
  }

  load(ctx: LoadContext): void {
    const v = ctx.rhsOld;

    for (const p of this.inputPins) p.load(ctx);

    for (let i = 0; i < this.numIn; i++) {
      const nodeId = this.inputPins[i].nodeId;
      const voltage = readMnaVoltage(nodeId, v);
      const level = this.inputPins[i].readLogicLevel(voltage);
      if (level !== undefined) this.latchedLevels[i] = level;
    }
    for (let i = 0; i < this.numOut; i++) {
      this.outputPins[i].setLogicLevel(this.latchedLevels[i] ?? false);
      this.outputPins[i].load(ctx);
    }

    for (const child of this._childElements) { child.load(ctx); }
  }

  accept(_ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {}

  getPinCurrents(rhs: Float64Array): number[] {
    const result: number[] = [];
    for (const p of this.inputPins) {
      result.push(readMnaVoltage(p.nodeId, rhs) / p.rIn);
    }
    for (const p of this.outputPins) {
      const v = readMnaVoltage(p.nodeId, rhs);
      result.push((v - p.currentVoltage) / p.rOut);
    }
    return result;
  }

  setParam(_key: string, _value: number): void {}
}

export function createSplitterAnalogElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime?: () => number,
): PoolBackedAnalogElementCore {
  return new SplitterAnalogElement(pinNodes, props);
}

// ---------------------------------------------------------------------------
// SevenSeg analog factory - 7 parallel LED diode models (segments a-g + dp)
//
// Each of the 8 segment inputs (a, b, c, d, e, f, g, dp) drives an independent
// LED diode model. nodeIds order matches pin declaration order (a, b, c, d, e, f, g, dp).
// Each segment diode is modeled as a simplified forward-biased diode
// (piecewise linear: R_on=50Î when forward-biased, R_off=10MÎ otherwise).
//
// For the analog model, each segment pin is treated as a DigitalInputPinModel
// (reading from the driving circuit) with an LED-style diode load. The cathode
// of each segment is implicitly at ground (common cathode configuration).
// ---------------------------------------------------------------------------

/** Piecewise-linear LED diode: Vf  2.0V, R_on = 50Î, R_off = 10MÎ */
const LED_VF = 2.0;
const LED_RON = 50;
const LED_ROFF = 1e7;
const LED_GMIN = 1e-12;

type SegmentDiodeElement = AnalogElementCore & {
  /** Unified load entry point - stamps linearized diode equations. */
  load(ctx: LoadContext): void;
  /** NR-iteration convergence test. */
  checkConvergence(ctx: LoadContext): boolean;
  /** Current flowing into the anode pin at the accepted operating point.
   *  `rhs` is the augmented MNA solution vector (node voltages + branch currents). */
  anodeCurrent(rhs: Float64Array): number;
};

function createSegmentDiodeElement(
  nodeAnode: number,
  nodeCathode: number,
): SegmentDiodeElement {
  let geq = LED_GMIN;
  let ieq = 0;
  let _vdStored = 0;
  let _idStored = 0;

  let _hAA = -1;
  let _hCC = -1;
  let _hAC = -1;
  let _hCA = -1;

  return {
    branchIndex: -1,
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VCVS,
    isNonlinear: true,
    isReactive: false,
    _stateBase: -1,
    _pinNodes: new Map<string, number>(),

    setup(ctx: SetupContext): void {
      const s = ctx.solver;
      if (nodeAnode > 0) {
        _hAA = s.allocElement(nodeAnode, nodeAnode);
      } else {
        _hAA = -1;
      }
      if (nodeCathode > 0) {
        _hCC = s.allocElement(nodeCathode, nodeCathode);
      } else {
        _hCC = -1;
      }
      if (nodeAnode > 0 && nodeCathode > 0) {
        _hAC = s.allocElement(nodeAnode, nodeCathode);
        _hCA = s.allocElement(nodeCathode, nodeAnode);
      } else {
        _hAC = -1;
        _hCA = -1;
      }
    },

    load(ctx: LoadContext): void {
      const s = ctx.solver;
      const rhsOld = ctx.rhsOld;
      const va = rhsOld[nodeAnode];
      const vc = rhsOld[nodeCathode];
      const vd = va - vc;
      if (vd > LED_VF) {
        geq = 1 / LED_RON + LED_GMIN;
        ieq = geq * LED_VF - LED_GMIN * vd;
      } else {
        geq = 1 / LED_ROFF + LED_GMIN;
        ieq = 0;
      }
      _vdStored = vd;
      _idStored = geq * vd + ieq;

      if (_hAA >= 0) s.stampElement(_hAA, geq);
      if (_hCC >= 0) s.stampElement(_hCC, geq);
      if (_hAC >= 0) s.stampElement(_hAC, -geq);
      if (_hCA >= 0) s.stampElement(_hCA, -geq);

      stampRHS(ctx.rhs, nodeAnode, -ieq);
      if (nodeCathode > 0) stampRHS(ctx.rhs, nodeCathode, ieq);
    },

    checkConvergence(ctx: LoadContext): boolean {
      const rhsOld = ctx.rhsOld;
      const va = rhsOld[nodeAnode];
      const vc = rhsOld[nodeCathode];
      const vdRaw = va - vc;

      const delvd = vdRaw - _vdStored;
      const cdhat = _idStored + geq * delvd;
      const tol = ctx.reltol * Math.max(Math.abs(cdhat), Math.abs(_idStored)) + ctx.iabstol;
      return Math.abs(cdhat - _idStored) <= tol;
    },

    anodeCurrent(rhs: Float64Array): number {
      const va = rhs[nodeAnode];
      const vc = rhs[nodeCathode];
      return geq * (va - vc) - ieq;
    },

    getPinCurrents(rhs: Float64Array): number[] {
      const va = rhs[nodeAnode];
      const vc = rhs[nodeCathode];
      const I = geq * (va - vc) - ieq;
      return [I, -I];
    },

    setParam(_key: string, _value: number): void {},
  };
}

class SevenSegAnalogElement implements AnalogElementCore {
  readonly branchIndex = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.VCVS;
  readonly isNonlinear = true;
  readonly isReactive = false;

  _stateBase: number = -1;
  _pinNodes: Map<string, number>;

  readonly _inputPins: readonly DigitalInputPinModel[] = [];
  readonly _outputPins: readonly DigitalOutputPinModel[] = [];
  readonly _subElements: readonly SegmentDiodeElement[];
  readonly _childElements: readonly AnalogCapacitorElement[] = [];

  private readonly segDiodes: readonly SegmentDiodeElement[];

  constructor(pinNodes: ReadonlyMap<string, number>) {
    this._pinNodes = new Map(pinNodes);
    const segLabels = ["a", "b", "c", "d", "e", "f", "g", "dp"] as const;
    const segNodes = segLabels.map((lbl) => pinNodes.get(lbl)!);
    this.segDiodes = segNodes.map((n) => createSegmentDiodeElement(n, 0));
    this._subElements = this.segDiodes;
  }

  setup(ctx: SetupContext): void {
    for (const d of this.segDiodes) d.setup(ctx);
  }

  load(ctx: LoadContext): void {
    for (const d of this.segDiodes) d.load(ctx);
  }

  checkConvergence(ctx: LoadContext): boolean {
    return this.segDiodes.every((d) => d.checkConvergence(ctx));
  }

  getPinCurrents(rhs: Float64Array): number[] {
    return this.segDiodes.map((d) => d.anodeCurrent(rhs));
  }

  setParam(_key: string, _value: number): void {}
}

export function createSevenSegAnalogElement(
  pinNodes: ReadonlyMap<string, number>,
  _props: PropertyBag,
  _getTime?: () => number,
): AnalogElementCore {
  return new SevenSegAnalogElement(pinNodes);
}

// ---------------------------------------------------------------------------
// Relay analog factory - coil inductor + contact variable resistance
//
// Coil: series inductance L (default 100mH) + DC resistance R_coil (default 100Î)
//   modeled as companion-model inductor in series with resistor
// Contact: variable resistance between A1 and B1
//   R_on = 0.01Î (closed), R_off = 10MÎ (open)
//   Threshold: coil current > I_pull (default 20mA) â†' contact closes
//
// Pin nodeIds order (SPST, 1 pole):
//   nodeIds[0] = in1 (coil terminal 1)
//   nodeIds[1] = in2 (coil terminal 2)
//   nodeIds[2] = branchIdx row (coil branch - uses MNA branch variable)
//   Remaining: contact A1, B1 pins
//
// For simplicity the coil is modeled as R_coil only (no inductance transient)
// in DC operating point; stampCompanion adds the inductor companion model.
// ---------------------------------------------------------------------------

const RELAY_R_ON = 0.01;
const RELAY_R_OFF = 1e7;
const RELAY_R_COIL_DEFAULT = 100;
const RELAY_L_DEFAULT = 0.1; // 100mH
const RELAY_I_PULL_DEFAULT = 20e-3; // 20mA

class RelayAnalogElement implements PoolBackedAnalogElementCore {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.VCVS;
  readonly isNonlinear = true;
  readonly isReactive = true;
  readonly poolBacked = true as const;

  _stateBase: number = -1;
  _pinNodes: Map<string, number>;

  readonly _inputPins: readonly DigitalInputPinModel[] = [];
  readonly _outputPins: readonly DigitalOutputPinModel[] = [];
  readonly _subElements: readonly AnalogInductorElement[];
  readonly _childElements: readonly AnalogCapacitorElement[] = [];

  readonly branchIndex: number;
  readonly stateSchema: StateSchema;
  readonly stateSize: number;
  stateBaseOffset = -1;
  s0 = new Float64Array(0);
  s1 = new Float64Array(0);
  s2 = new Float64Array(0);
  s3 = new Float64Array(0);
  s4 = new Float64Array(0);
  s5 = new Float64Array(0);
  s6 = new Float64Array(0);
  s7 = new Float64Array(0);

  private readonly nodeCoil1: number;
  private readonly nodeCoil2: number;
  private readonly nodeContactA: number;
  private readonly nodeContactB: number;
  private readonly rCoil: number;
  private readonly iPull: number;
  private readonly normallyClosed: boolean;
  private readonly coilInductor: AnalogInductorElement;
  private contactClosed: boolean;

  private _hC1C1 = -1;
  private _hC2C2 = -1;
  private _hC1C2 = -1;
  private _hC2C1 = -1;
  private _hCAA = -1;
  private _hCBB = -1;
  private _hCAB = -1;
  private _hCBA = -1;

  constructor(
    pinNodes: ReadonlyMap<string, number>,
    branchIdx: number,
    props: PropertyBag,
  ) {
    this._pinNodes = new Map(pinNodes);
    this.nodeCoil1 = pinNodes.get("in1")!;
    this.nodeCoil2 = pinNodes.get("in2")!;
    this.nodeContactA = pinNodes.get("A1")!;
    this.nodeContactB = pinNodes.get("B1")!;

    this.rCoil = props.has("coilResistance") ? (props.get("coilResistance") as number) : RELAY_R_COIL_DEFAULT;
    const L = props.has("inductance") ? (props.get("inductance") as number) : RELAY_L_DEFAULT;
    this.iPull = props.has("iPull") ? (props.get("iPull") as number) : RELAY_I_PULL_DEFAULT;
    this.normallyClosed = props.has("normallyClosed") ? (props.get("normallyClosed") as boolean) : false;

    this.coilInductor = new AnalogInductorElement(
      branchIdx,
      L,
      INDUCTOR_DEFAULTS["IC"]!,
      INDUCTOR_DEFAULTS["TC1"]!,
      INDUCTOR_DEFAULTS["TC2"]!,
      INDUCTOR_DEFAULTS["TNOM"]!,
      INDUCTOR_DEFAULTS["SCALE"]!,
      INDUCTOR_DEFAULTS["M"]!,
    );
    this.coilInductor.pinNodeIds = [this.nodeCoil1, this.nodeCoil2];

    this.branchIndex = branchIdx;
    this.stateSchema = this.coilInductor.stateSchema;
    this.stateSize = this.coilInductor.stateSize;
    this.contactClosed = this.normallyClosed;
    this._subElements = [this.coilInductor];
  }

  private contactG(): number {
    return this.contactClosed ? 1 / RELAY_R_ON : 1 / RELAY_R_OFF;
  }

  setup(ctx: SetupContext): void {
    this._hC1C1 = ctx.solver.allocElement(this.nodeCoil1, this.nodeCoil1);
    this._hC2C2 = ctx.solver.allocElement(this.nodeCoil2, this.nodeCoil2);
    this._hC1C2 = ctx.solver.allocElement(this.nodeCoil1, this.nodeCoil2);
    this._hC2C1 = ctx.solver.allocElement(this.nodeCoil2, this.nodeCoil1);
    this._hCAA  = ctx.solver.allocElement(this.nodeContactA, this.nodeContactA);
    this._hCBB  = ctx.solver.allocElement(this.nodeContactB, this.nodeContactB);
    this._hCAB  = ctx.solver.allocElement(this.nodeContactA, this.nodeContactB);
    this._hCBA  = ctx.solver.allocElement(this.nodeContactB, this.nodeContactA);
    this.coilInductor.setup(ctx);
  }

  initState(pool: StatePoolRef): void {
    this.coilInductor.stateBaseOffset = this.stateBaseOffset;
    this.coilInductor.initState(pool);
  }

  getChildElements(): readonly AnalogInductorElement[] {
    return [this.coilInductor];
  }

  load(ctx: LoadContext): void {
    const s = ctx.solver;
    const gCoil = 1 / this.rCoil;
    s.stampElement(this._hC1C1, gCoil);
    s.stampElement(this._hC2C2, gCoil);
    s.stampElement(this._hC1C2, -gCoil);
    s.stampElement(this._hC2C1, -gCoil);
    const gContact = this.contactG();
    s.stampElement(this._hCAA, gContact);
    s.stampElement(this._hCBB, gContact);
    s.stampElement(this._hCAB, -gContact);
    s.stampElement(this._hCBA, -gContact);
    this.coilInductor.load(ctx);
  }

  accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
    const branchIdx = this.branchIndex;
    const iCoil = branchIdx >= 0 ? ctx.rhs[branchIdx] : 0;
    const energised = Math.abs(iCoil) > this.iPull;
    this.contactClosed = this.normallyClosed ? !energised : energised;
  }

  getLteTimestep(
    dt: number,
    deltaOld: readonly number[],
    order: number,
    method: IntegrationMethod,
    lteParams: LteParams,
  ): number {
    return this.coilInductor.getLteTimestep(dt, deltaOld, order, method, lteParams);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const branchIdx = this.branchIndex;
    const iCoil = branchIdx >= 0 ? rhs[branchIdx] : 0;
    const vA = rhs[this.nodeContactA];
    const vB = rhs[this.nodeContactB];
    const iContact = this.contactG() * (vA - vB);
    return [iCoil, -iCoil, iContact, -iContact];
  }

  setParam(key: string, value: number): void { this.coilInductor.setParam(key, value); }
}

export function createRelayAnalogElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime?: () => number,
): PoolBackedAnalogElementCore & { getChildElements(): readonly AnalogInductorElement[] } {
  return new RelayAnalogElement(pinNodes, -1, props);
}

// ---------------------------------------------------------------------------
// RelayDT analog factory - same as Relay but with DPDT contact configuration
//
// Pin nodeIds order (SPDT, 1 pole):
//   nodeIds[0] = in1 (coil)
//   nodeIds[1] = in2 (coil)
//   nodeIds[2] = A1 (common contact)
//   nodeIds[3] = B1 (throw - NO, connects when energised)
//   nodeIds[4] = C1 (rest - NC, connects when de-energised)
// ---------------------------------------------------------------------------

class RelayDTAnalogElement implements PoolBackedAnalogElementCore {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.VCVS;
  readonly isNonlinear = true;
  readonly isReactive = true;
  readonly poolBacked = true as const;

  _stateBase: number = -1;
  _pinNodes: Map<string, number>;

  readonly _inputPins: readonly DigitalInputPinModel[] = [];
  readonly _outputPins: readonly DigitalOutputPinModel[] = [];
  readonly _subElements: readonly AnalogInductorElement[];
  readonly _childElements: readonly AnalogCapacitorElement[] = [];

  readonly branchIndex: number;
  readonly stateSchema: StateSchema;
  readonly stateSize: number;
  stateBaseOffset = -1;
  s0 = new Float64Array(0);
  s1 = new Float64Array(0);
  s2 = new Float64Array(0);
  s3 = new Float64Array(0);
  s4 = new Float64Array(0);
  s5 = new Float64Array(0);
  s6 = new Float64Array(0);
  s7 = new Float64Array(0);

  private readonly nodeCoil1: number;
  private readonly nodeCoil2: number;
  private readonly nodeCommon: number;
  private readonly nodeThrow: number;
  private readonly nodeRest: number;
  private readonly rCoil: number;
  private readonly iPull: number;
  private readonly coilInductor: AnalogInductorElement;
  private energised = false;

  private _hC1C1 = -1;
  private _hC2C2 = -1;
  private _hC1C2 = -1;
  private _hC2C1 = -1;
  private _hCOMCOM_T = -1;
  private _hTHRTHR = -1;
  private _hCOMTHR = -1;
  private _hTHRCOM = -1;
  private _hCOMCOM_R = -1;
  private _hRSTRST = -1;
  private _hCOMRST = -1;
  private _hRSTCOM = -1;

  constructor(
    pinNodes: ReadonlyMap<string, number>,
    branchIdx: number,
    props: PropertyBag,
  ) {
    this._pinNodes = new Map(pinNodes);
    this.nodeCoil1 = pinNodes.get("in1")!;
    this.nodeCoil2 = pinNodes.get("in2")!;
    this.nodeCommon = pinNodes.get("A1")!;
    this.nodeThrow = pinNodes.get("B1")!;
    this.nodeRest = pinNodes.get("C1")!;

    this.rCoil = props.has("coilResistance") ? (props.get("coilResistance") as number) : RELAY_R_COIL_DEFAULT;
    const L = props.has("inductance") ? (props.get("inductance") as number) : RELAY_L_DEFAULT;
    this.iPull = props.has("iPull") ? (props.get("iPull") as number) : RELAY_I_PULL_DEFAULT;

    this.coilInductor = new AnalogInductorElement(
      branchIdx,
      L,
      INDUCTOR_DEFAULTS["IC"]!,
      INDUCTOR_DEFAULTS["TC1"]!,
      INDUCTOR_DEFAULTS["TC2"]!,
      INDUCTOR_DEFAULTS["TNOM"]!,
      INDUCTOR_DEFAULTS["SCALE"]!,
      INDUCTOR_DEFAULTS["M"]!,
    );
    this.coilInductor.pinNodeIds = [this.nodeCoil1, this.nodeCoil2];

    this.branchIndex = branchIdx;
    this.stateSchema = this.coilInductor.stateSchema;
    this.stateSize = this.coilInductor.stateSize;
    this._subElements = [this.coilInductor];
  }

  private gThrow(): number { return this.energised ? 1 / RELAY_R_ON : 1 / RELAY_R_OFF; }
  private gRest(): number { return this.energised ? 1 / RELAY_R_OFF : 1 / RELAY_R_ON; }

  setup(ctx: SetupContext): void {
    this._hC1C1    = ctx.solver.allocElement(this.nodeCoil1,  this.nodeCoil1);
    this._hC2C2    = ctx.solver.allocElement(this.nodeCoil2,  this.nodeCoil2);
    this._hC1C2    = ctx.solver.allocElement(this.nodeCoil1,  this.nodeCoil2);
    this._hC2C1    = ctx.solver.allocElement(this.nodeCoil2,  this.nodeCoil1);
    this._hCOMCOM_T = ctx.solver.allocElement(this.nodeCommon, this.nodeCommon);
    this._hTHRTHR  = ctx.solver.allocElement(this.nodeThrow,  this.nodeThrow);
    this._hCOMTHR  = ctx.solver.allocElement(this.nodeCommon, this.nodeThrow);
    this._hTHRCOM  = ctx.solver.allocElement(this.nodeThrow,  this.nodeCommon);
    this._hCOMCOM_R = ctx.solver.allocElement(this.nodeCommon, this.nodeCommon);
    this._hRSTRST  = ctx.solver.allocElement(this.nodeRest,   this.nodeRest);
    this._hCOMRST  = ctx.solver.allocElement(this.nodeCommon, this.nodeRest);
    this._hRSTCOM  = ctx.solver.allocElement(this.nodeRest,   this.nodeCommon);
    this.coilInductor.setup(ctx);
  }

  initState(pool: StatePoolRef): void {
    this.coilInductor.stateBaseOffset = this.stateBaseOffset;
    this.coilInductor.initState(pool);
  }

  getChildElements(): readonly AnalogInductorElement[] {
    return [this.coilInductor];
  }

  load(ctx: LoadContext): void {
    const s = ctx.solver;
    const gCoil = 1 / this.rCoil;
    s.stampElement(this._hC1C1, gCoil);
    s.stampElement(this._hC2C2, gCoil);
    s.stampElement(this._hC1C2, -gCoil);
    s.stampElement(this._hC2C1, -gCoil);
    const gT = this.gThrow();
    s.stampElement(this._hCOMCOM_T, gT);
    s.stampElement(this._hTHRTHR, gT);
    s.stampElement(this._hCOMTHR, -gT);
    s.stampElement(this._hTHRCOM, -gT);
    const gR = this.gRest();
    s.stampElement(this._hCOMCOM_R, gR);
    s.stampElement(this._hRSTRST, gR);
    s.stampElement(this._hCOMRST, -gR);
    s.stampElement(this._hRSTCOM, -gR);
    this.coilInductor.load(ctx);
  }

  accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
    const branchIdx = this.branchIndex;
    const iCoil = branchIdx >= 0 ? ctx.rhs[branchIdx] : 0;
    this.energised = Math.abs(iCoil) > this.iPull;
  }

  getLteTimestep(
    dt: number,
    deltaOld: readonly number[],
    order: number,
    method: IntegrationMethod,
    lteParams: LteParams,
  ): number {
    return this.coilInductor.getLteTimestep(dt, deltaOld, order, method, lteParams);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const branchIdx = this.branchIndex;
    const iCoil = branchIdx >= 0 ? rhs[branchIdx] : 0;
    const vCom = rhs[this.nodeCommon];
    const vThr = rhs[this.nodeThrow];
    const vRst = rhs[this.nodeRest];
    const iThrow = this.gThrow() * (vCom - vThr);
    const iRest = this.gRest() * (vCom - vRst);
    return [iCoil, -iCoil, iThrow + iRest, -iThrow, -iRest];
  }

  setParam(key: string, value: number): void { this.coilInductor.setParam(key, value); }
}

export function createRelayDTAnalogElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime?: () => number,
): PoolBackedAnalogElementCore & { getChildElements(): readonly AnalogInductorElement[] } {
  return new RelayDTAnalogElement(pinNodes, -1, props);
}

// ---------------------------------------------------------------------------
// ButtonLED analog factory - switch (variable resistance) + LED diode
//
// Pin nodeIds order (matches buildButtonLEDPinDeclarations):
//   nodeIds[0] = out (button output - digital output pin)
//   nodeIds[1] = in  (LED input - LED anode, cathode at ground)
//
// The button output is driven by a DigitalOutputPinModel (logic HIGH or LOW).
// The LED input is a forward-biased diode from nodeIds[1] to ground.
// ---------------------------------------------------------------------------

class ButtonLEDAnalogElement implements AnalogElementCore {
  readonly branchIndex = -1;
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.VCVS;
  readonly isNonlinear = true;
  readonly isReactive = false;

  _stateBase: number = -1;
  _pinNodes: Map<string, number>;

  readonly _inputPins: readonly DigitalInputPinModel[] = [];
  readonly _outputPins: readonly DigitalOutputPinModel[];
  readonly _subElements: readonly SegmentDiodeElement[];
  readonly _childElements: readonly AnalogCapacitorElement[] = [];

  private readonly outputPin: DigitalOutputPinModel;
  private readonly ledDiode: SegmentDiodeElement;
  private readonly nodeOut: number;
  private readonly pinModelsByLabel: Map<string, DigitalInputPinModel | DigitalOutputPinModel>;

  constructor(
    pinNodes: ReadonlyMap<string, number>,
    props: PropertyBag,
  ) {
    this._pinNodes = new Map(pinNodes);
    this.nodeOut = pinNodes.get("out")!;
    const nodeLedIn = pinNodes.get("in")!;

    const outSpec = getPinSpec(props, "out");
    this.outputPin = new DigitalOutputPinModel(outSpec, getPinLoadingFlag(props, "out", false), "direct");
    this.outputPin.init(this.nodeOut, -1);
    this.outputPin.setLogicLevel(false);

    this.ledDiode = createSegmentDiodeElement(nodeLedIn, 0);

    this.pinModelsByLabel = new Map<string, DigitalInputPinModel | DigitalOutputPinModel>([
      ["out", this.outputPin],
    ]);

    this._outputPins = [this.outputPin];
    this._subElements = [this.ledDiode];
  }

  setup(ctx: SetupContext): void {
    this.outputPin.setup(ctx);
    this.ledDiode.setup(ctx);
  }

  load(ctx: LoadContext): void {
    this.outputPin.load(ctx);
    this.ledDiode.load(ctx);
  }

  checkConvergence(ctx: LoadContext): boolean {
    return this.ledDiode.checkConvergence(ctx);
  }

  getPinCurrents(rhs: Float64Array): number[] {
    const vOut = readMnaVoltage(this.nodeOut, rhs);
    const iOut = this.outputPin.isHiZ
      ? vOut / this.outputPin.rHiZ
      : (vOut - this.outputPin.currentVoltage) / this.outputPin.rOut;
    const iLed = this.ledDiode.anodeCurrent(rhs);
    return [iOut, iLed];
  }

  setParam(key: string, value: number): void { delegatePinSetParam(this.pinModelsByLabel, key, value); }
}

export function createButtonLEDAnalogElement(
  pinNodes: ReadonlyMap<string, number>,
  props: PropertyBag,
  _getTime?: () => number,
): AnalogElementCore {
  return new ButtonLEDAnalogElement(pinNodes, props);
}
