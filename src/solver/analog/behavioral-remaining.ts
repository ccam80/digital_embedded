/**
 * Behavioral analog factories for remaining digital components.
 *
 * Provides analogFactory functions for:
 *   - Driver (tri-state buffer)
 *   - DriverInvSel (inverting tri-state buffer)
 *   - Splitter / BusSplitter (pass-through per bit)
 *   - SevenSeg / SevenSegHex (7 parallel LED diode models)
 *   - ButtonLED (switch + LED diode)
 */

import type { AnalogElement, PoolBackedAnalogElement } from "./element.js";
import { NGSPICE_LOAD_ORDER } from "./element.js";
import type { PropertyBag } from "../../core/properties.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";
import type { SetupContext } from "./setup-context.js";
import type { LoadContext } from "./load-context.js";
import {
  collectPinModelChildren,
  delegatePinSetParam,
  DigitalInputPinModel,
  DigitalOutputPinModel,
  readMnaVoltage,
} from "./digital-pin-model.js";
import { defineStateSchema } from "./state-schema.js";
import type { StateSchema } from "./state-schema.js";
import { CompositeElement } from "./composite-element.js";

const REMAINING_COMPOSITE_SCHEMA: StateSchema = defineStateSchema("BehavioralRemainingComposite", []);

function getPinSpec(
  props: PropertyBag,
  label: string,
): ResolvedPinElectrical {
  if (!props.has("_pinElectrical")) {
    throw new Error(`getPinSpec: _pinElectrical not set in props (pin "${label}")`);
  }
  const pinSpecs = props.get("_pinElectrical") as unknown as Record<string, ResolvedPinElectrical>;
  const spec = pinSpecs[label];
  if (spec === undefined) {
    throw new Error(`getPinSpec: no electrical spec for pin "${label}"`);
  }
  return spec;
}

function getPinLoadingFlag(props: PropertyBag, label: string, defaultValue: boolean): boolean {
  if (!props.has("_pinLoading")) return defaultValue;
  const pinLoading = props.get("_pinLoading") as unknown as Record<string, boolean>;
  return pinLoading[label] ?? defaultValue;
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

class DriverAnalogElement extends CompositeElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.VCVS;
  readonly stateSchema: StateSchema = REMAINING_COMPOSITE_SCHEMA;

  private readonly inputPin: DigitalInputPinModel;
  private readonly selPin: DigitalInputPinModel;
  private readonly outputPin: DigitalOutputPinModel;
  private readonly nodeIn: number;
  private readonly nodeSel: number;
  private readonly nodeOut: number;
  private readonly pinModelsByLabel: Map<string, DigitalInputPinModel | DigitalOutputPinModel>;
  private readonly _allSubElements: AnalogElement[];

  private latchedIn = false;
  private latchedSel = false;

  constructor(
    pinNodes: ReadonlyMap<string, number>,
    props: PropertyBag,
  ) {
    super();
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

    const childCaps = collectPinModelChildren([this.inputPin, this.selPin, this.outputPin]);
    this._allSubElements = [
      this.inputPin, this.selPin, this.outputPin,
      ...childCaps,
    ] as unknown as AnalogElement[];
  }

  protected getSubElements(): readonly AnalogElement[] {
    return this._allSubElements;
  }

  load(ctx: LoadContext): void {
    const v = ctx.rhsOld;

    const vIn = readMnaVoltage(this.nodeIn, v);
    const vSel = readMnaVoltage(this.nodeSel, v);

    const inLevel = this.inputPin.readLogicLevel(vIn);
    if (inLevel !== undefined) this.latchedIn = inLevel;

    const selLevel = this.selPin.readLogicLevel(vSel);
    if (selLevel !== undefined) this.latchedSel = selLevel;

    this.outputPin.setHighZ(!this.latchedSel);
    this.outputPin.setLogicLevel(this.latchedIn);

    super.load(ctx);
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
): PoolBackedAnalogElement {
  return new DriverAnalogElement(pinNodes, props);
}

// ---------------------------------------------------------------------------
// DriverInvSel analog factory - inverting tri-state (active-low enable)
//
// Same as Driver but enable logic is inverted: sel=0 → driven, sel=1 → Hi-Z
// Pin labels: "in", "sel", "out" (matching buildDriverPinDeclarations)
// ---------------------------------------------------------------------------

class DriverInvAnalogElement extends CompositeElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.VCVS;
  readonly stateSchema: StateSchema = REMAINING_COMPOSITE_SCHEMA;

  private readonly inputPin: DigitalInputPinModel;
  private readonly selPin: DigitalInputPinModel;
  private readonly outputPin: DigitalOutputPinModel;
  private readonly nodeIn: number;
  private readonly nodeSel: number;
  private readonly nodeOut: number;
  private readonly pinModelsByLabel: Map<string, DigitalInputPinModel | DigitalOutputPinModel>;
  private readonly _allSubElements: AnalogElement[];

  private latchedIn = false;
  private latchedSel = false;

  constructor(
    pinNodes: ReadonlyMap<string, number>,
    props: PropertyBag,
  ) {
    super();
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

    const childCaps = collectPinModelChildren([this.inputPin, this.selPin, this.outputPin]);
    this._allSubElements = [
      this.inputPin, this.selPin, this.outputPin,
      ...childCaps,
    ] as unknown as AnalogElement[];
  }

  protected getSubElements(): readonly AnalogElement[] {
    return this._allSubElements;
  }

  load(ctx: LoadContext): void {
    const v = ctx.rhsOld;

    const vIn = readMnaVoltage(this.nodeIn, v);
    const vSel = readMnaVoltage(this.nodeSel, v);

    const inLevel = this.inputPin.readLogicLevel(vIn);
    if (inLevel !== undefined) this.latchedIn = inLevel;

    const selLevel = this.selPin.readLogicLevel(vSel);
    if (selLevel !== undefined) this.latchedSel = selLevel;

    this.outputPin.setHighZ(this.latchedSel);
    this.outputPin.setLogicLevel(this.latchedIn);

    super.load(ctx);
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
): PoolBackedAnalogElement {
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

class SplitterAnalogElement extends CompositeElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.VCVS;
  readonly stateSchema: StateSchema = REMAINING_COMPOSITE_SCHEMA;

  private readonly inputPins: DigitalInputPinModel[];
  private readonly outputPins: DigitalOutputPinModel[];
  private readonly latchedLevels: boolean[];
  private readonly numIn: number;
  private readonly numOut: number;
  private readonly _allSubElements: AnalogElement[];

  constructor(
    pinNodes: ReadonlyMap<string, number>,
    props: PropertyBag,
  ) {
    super();
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

    const childCaps = collectPinModelChildren([...this.inputPins, ...this.outputPins]);
    this._allSubElements = [
      ...this.inputPins, ...this.outputPins,
      ...childCaps,
    ] as unknown as AnalogElement[];
  }

  protected getSubElements(): readonly AnalogElement[] {
    return this._allSubElements;
  }

  load(ctx: LoadContext): void {
    const v = ctx.rhsOld;

    for (let i = 0; i < this.numIn; i++) {
      const nodeId = this.inputPins[i].nodeId;
      const voltage = readMnaVoltage(nodeId, v);
      const level = this.inputPins[i].readLogicLevel(voltage);
      if (level !== undefined) this.latchedLevels[i] = level;
    }
    for (let i = 0; i < this.numOut; i++) {
      this.outputPins[i].setLogicLevel(this.latchedLevels[i] ?? false);
    }

    super.load(ctx);
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
): PoolBackedAnalogElement {
  return new SplitterAnalogElement(pinNodes, props);
}

// ---------------------------------------------------------------------------
// SevenSeg analog factory - 7 parallel LED diode models (segments a-g + dp)
//
// Each of the 8 segment inputs (a, b, c, d, e, f, g, dp) drives an independent
// LED diode model. nodeIds order matches pin declaration order (a, b, c, d, e, f, g, dp).
// Each segment diode is modeled as a simplified forward-biased diode
// (piecewise linear: R_on=50Ω when forward-biased, R_off=10MΩ otherwise).
//
// For the analog model, each segment pin is treated as a DigitalInputPinModel
// (reading from the driving circuit) with an LED-style diode load. The cathode
// of each segment is implicitly at ground (common cathode configuration).
// ---------------------------------------------------------------------------

/** Piecewise-linear LED diode: Vf ≈ 2.0V, R_on = 50Ω, R_off = 10MΩ */
const LED_VF = 2.0;
const LED_RON = 50;
const LED_ROFF = 1e7;
const LED_GMIN = 1e-12;

type SegmentDiodeElement = AnalogElement & {
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
    label: "",
    branchIndex: -1,
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VCVS,
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

class SevenSegAnalogElement extends CompositeElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.VCVS;
  readonly stateSchema: StateSchema = REMAINING_COMPOSITE_SCHEMA;

  private readonly segDiodes: readonly SegmentDiodeElement[];

  constructor(pinNodes: ReadonlyMap<string, number>) {
    super();
    this._pinNodes = new Map(pinNodes);
    const segLabels = ["a", "b", "c", "d", "e", "f", "g", "dp"] as const;
    const segNodes = segLabels.map((lbl) => pinNodes.get(lbl)!);
    this.segDiodes = segNodes.map((n) => createSegmentDiodeElement(n, 0));
  }

  protected getSubElements(): readonly AnalogElement[] {
    return this.segDiodes as unknown as AnalogElement[];
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
): PoolBackedAnalogElement {
  return new SevenSegAnalogElement(pinNodes);
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

class ButtonLEDAnalogElement extends CompositeElement {
  readonly ngspiceLoadOrder = NGSPICE_LOAD_ORDER.VCVS;
  readonly stateSchema: StateSchema = REMAINING_COMPOSITE_SCHEMA;

  private readonly outputPin: DigitalOutputPinModel;
  private readonly ledDiode: SegmentDiodeElement;
  private readonly nodeOut: number;
  private readonly pinModelsByLabel: Map<string, DigitalInputPinModel | DigitalOutputPinModel>;

  constructor(
    pinNodes: ReadonlyMap<string, number>,
    props: PropertyBag,
  ) {
    super();
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
  }

  protected getSubElements(): readonly AnalogElement[] {
    return [this.outputPin, this.ledDiode] as unknown as AnalogElement[];
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
): PoolBackedAnalogElement {
  return new ButtonLEDAnalogElement(pinNodes, props);
}
