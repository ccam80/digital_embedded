/**
 * Behavioral analog models for combinational digital components:
 * multiplexer, demultiplexer, and decoder.
 *
 * All three are purely combinational — they evaluate inside load() every NR
 * iteration. Selector bits are read via threshold detection, the appropriate
 * data routing is performed, and output pin Norton equivalents are re-stamped.
 *
 * Pin capacitance companion models are stamped inside load() via capacitor
 * children of the pin models.
 */

import type { LoadContext } from "./element.js";
import type { StatePoolRef } from "./element.js";
import type { PropertyBag } from "../../core/properties.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";
import {
  DigitalInputPinModel,
  DigitalOutputPinModel,
  readMnaVoltage,
  delegatePinSetParam,
  collectPinModelChildren,
} from "./digital-pin-model.js";
import type { AnalogCapacitorElement } from "../../components/passives/capacitor.js";
import type { AnalogElementFactory } from "./behavioral-gate.js";
import { defineStateSchema } from "./state-schema.js";
import type { StateSchema } from "./state-schema.js";

// Empty composite schema — children carry their own schemas.
const COMBINATIONAL_COMPOSITE_SCHEMA: StateSchema = defineStateSchema("BehavioralCombinationalComposite", []);

// ---------------------------------------------------------------------------
// Shared fallback electrical spec (CMOS 3.3 V defaults)
// ---------------------------------------------------------------------------

const FALLBACK_SPEC: ResolvedPinElectrical = {
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

// ---------------------------------------------------------------------------
// BehavioralMuxElement
// ---------------------------------------------------------------------------

/**
 * Analog behavioral model for a multiplexer.
 *
 * Pin layout (nodeIds order, matching buildMuxPinDeclarations):
 *   nodeIds[0]             = sel (selectorBits-wide input — read as integer)
 *   nodeIds[1..inputCount] = in_0 .. in_(N-1) (data inputs)
 *   nodeIds[inputCount+1]  = out (single output)
 *
 * For multi-bit data (bitWidth > 1), each nodeId represents one circuit node
 * corresponding to one bit of the bus. The selector picks which data-input
 * group to route to the output.
 *
 * Selector decoding: each selector bit has its own DigitalInputPinModel.
 * The sel pin nodeId is treated as the first node; additional selector bit
 * nodes follow immediately.
 */
export class BehavioralMuxElement {
  private readonly _selPins: DigitalInputPinModel[];
  private readonly _dataPins: DigitalInputPinModel[][];
  private readonly _outPins: DigitalOutputPinModel[];
  private readonly _bitWidth: number;
  private readonly _pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>;
  private readonly _childElements: AnalogCapacitorElement[];

  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
  readonly branchIndex: number = -1;
  readonly isNonlinear: true = true;
  label?: string;

  readonly poolBacked = true as const;
  readonly stateSchema: StateSchema = COMBINATIONAL_COMPOSITE_SCHEMA;
  stateSize: number;
  stateBaseOffset = -1;
  private _pool!: StatePoolRef;

  constructor(
    selPins: DigitalInputPinModel[],
    dataPins: DigitalInputPinModel[][],
    outPins: DigitalOutputPinModel[],
    _inputCount: number,
    bitWidth: number,
    pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>,
  ) {
    this._selPins = selPins;
    this._dataPins = dataPins;
    this._outPins = outPins;
    this._bitWidth = bitWidth;
    this._pinModelsByLabel = pinModelsByLabel;

    const allPins: (DigitalInputPinModel | DigitalOutputPinModel)[] = [
      ...selPins,
      ...dataPins.flat(),
      ...outPins,
    ];
    this._childElements = collectPinModelChildren(allPins);
    this.stateSize = this._childElements.reduce((s, c) => s + c.stateSize, 0);
  }

  get isReactive(): boolean {
    return this._childElements.length > 0;
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
    let offset = this.stateBaseOffset;
    for (const child of this._childElements) {
      child.stateBaseOffset = offset;
      child.initState(pool);
      offset += child.stateSize;
    }
  }

  checkConvergence(ctx: LoadContext): boolean {
    return this._childElements.every(c => !c.checkConvergence || c.checkConvergence(ctx));
  }

  load(ctx: LoadContext): void {
    const voltages = ctx.rhsOld;

    // Decode selector bits into an integer
    let sel = 0;
    for (let b = 0; b < this._selPins.length; b++) {
      const nodeId = this._selPins[b].nodeId;
      const voltage = readMnaVoltage(nodeId, voltages);
      const level = this._selPins[b].readLogicLevel(voltage);
      if (level !== undefined) {
        if (level) sel |= 1 << b;
        else sel &= ~(1 << b);
      }
    }

    const selectedGroup = this._dataPins[sel] ?? this._dataPins[0];

    // Delegate stamping to pin models for all input pins
    for (const p of this._selPins) p.load(ctx);
    for (const group of this._dataPins) {
      for (const p of group) p.load(ctx);
    }

    // Route selected data to outputs and stamp output Norton equivalents
    for (let bit = 0; bit < this._bitWidth; bit++) {
      const inputPin = selectedGroup[bit];
      const inputNodeId = inputPin.nodeId;
      const inputVoltage = readMnaVoltage(inputNodeId, voltages);
      const level = inputPin.readLogicLevel(inputVoltage);
      const outLevel = level ?? false;
      this._outPins[bit].setLogicLevel(outLevel);
      this._outPins[bit].load(ctx);
    }

    for (const child of this._childElements) {
      child.load(ctx);
    }
  }

  accept(_ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
    // No accept() work needed — capacitors handle their own state via load()
  }

  /**
   * Compute per-pin currents from the MNA solution vector.
   *
   * Order: selector pins, data input groups (flattened), output pins.
   * Input pins: I = V_node / rIn
   * Output pins: I = (V_node - V_target) / rOut
   * The sum is nonzero — the residual is the implicit supply current.
   */
  getPinCurrents(voltages: Float64Array): number[] {
    const result: number[] = [];
    for (const p of this._selPins) {
      const v = readMnaVoltage(p.nodeId, voltages);
      result.push(v / p.rIn);
    }
    for (const group of this._dataPins) {
      for (const p of group) {
        const v = readMnaVoltage(p.nodeId, voltages);
        result.push(v / p.rIn);
      }
    }
    for (const p of this._outPins) {
      const v = readMnaVoltage(p.nodeId, voltages);
      result.push((v - p.currentVoltage) / p.rOut);
    }
    return result;
  }

  setParam(key: string, value: number): void {
    delegatePinSetParam(this._pinModelsByLabel, key, value);
  }
}

// ---------------------------------------------------------------------------
// BehavioralDemuxElement
// ---------------------------------------------------------------------------

/**
 * Analog behavioral model for a demultiplexer.
 *
 * Pin layout (nodeIds order, matching buildDemuxPinDeclarations):
 *   nodeIds[0]                    = sel (selectorBits-wide)
 *   nodeIds[1..outputCount]       = out_0 .. out_(N-1) (outputs)
 *   nodeIds[outputCount+1]        = in (data input)
 *
 * The selected output receives the input signal level; all other outputs
 * are driven LOW (vOL).
 */
export class BehavioralDemuxElement {
  private readonly _selPins: DigitalInputPinModel[];
  private readonly _inPin: DigitalInputPinModel;
  private readonly _outPins: DigitalOutputPinModel[];
  private readonly _outputCount: number;
  private readonly _pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>;
  private readonly _childElements: AnalogCapacitorElement[];

  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
  readonly branchIndex: number = -1;
  readonly isNonlinear: true = true;
  label?: string;

  readonly poolBacked = true as const;
  readonly stateSchema: StateSchema = COMBINATIONAL_COMPOSITE_SCHEMA;
  stateSize: number;
  stateBaseOffset = -1;
  private _pool!: StatePoolRef;

  constructor(
    selPins: DigitalInputPinModel[],
    inPin: DigitalInputPinModel,
    outPins: DigitalOutputPinModel[],
    outputCount: number,
    pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>,
  ) {
    this._selPins = selPins;
    this._inPin = inPin;
    this._outPins = outPins;
    this._outputCount = outputCount;
    this._pinModelsByLabel = pinModelsByLabel;

    const allPins: (DigitalInputPinModel | DigitalOutputPinModel)[] = [
      ...selPins,
      inPin,
      ...outPins,
    ];
    this._childElements = collectPinModelChildren(allPins);
    this.stateSize = this._childElements.reduce((s, c) => s + c.stateSize, 0);
  }

  get isReactive(): boolean {
    return this._childElements.length > 0;
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
    let offset = this.stateBaseOffset;
    for (const child of this._childElements) {
      child.stateBaseOffset = offset;
      child.initState(pool);
      offset += child.stateSize;
    }
  }

  checkConvergence(ctx: LoadContext): boolean {
    return this._childElements.every(c => !c.checkConvergence || c.checkConvergence(ctx));
  }

  load(ctx: LoadContext): void {
    const voltages = ctx.rhsOld;

    // Decode selector
    let sel = 0;
    for (let b = 0; b < this._selPins.length; b++) {
      const nodeId = this._selPins[b].nodeId;
      const voltage = readMnaVoltage(nodeId, voltages);
      const level = this._selPins[b].readLogicLevel(voltage);
      if (level !== undefined) {
        if (level) sel |= 1 << b;
        else sel &= ~(1 << b);
      }
    }

    // Read input level
    const inNodeId = this._inPin.nodeId;
    const inVoltage = readMnaVoltage(inNodeId, voltages);
    const inLevel = this._inPin.readLogicLevel(inVoltage) ?? false;

    // Delegate stamping to pin models for inputs
    for (const p of this._selPins) p.load(ctx);
    this._inPin.load(ctx);

    // Route: selected output gets input level, all others get LOW
    for (let i = 0; i < this._outputCount; i++) {
      this._outPins[i].setLogicLevel(i === sel ? inLevel : false);
      this._outPins[i].load(ctx);
    }

    for (const child of this._childElements) {
      child.load(ctx);
    }
  }

  accept(_ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
    // No accept() work needed — capacitors handle their own state via load()
  }

  /**
   * Compute per-pin currents from the MNA solution vector.
   *
   * Order: selector pins, input pin, output pins.
   * Input pins (sel, in): I = V_node / rIn
   * Output pins: I = (V_node - V_target) / rOut
   * The sum is nonzero — the residual is the implicit supply current.
   */
  getPinCurrents(voltages: Float64Array): number[] {
    const result: number[] = [];
    for (const p of this._selPins) {
      const v = readMnaVoltage(p.nodeId, voltages);
      result.push(v / p.rIn);
    }
    const vIn = readMnaVoltage(this._inPin.nodeId, voltages);
    result.push(vIn / this._inPin.rIn);
    for (const p of this._outPins) {
      const v = readMnaVoltage(p.nodeId, voltages);
      result.push((v - p.currentVoltage) / p.rOut);
    }
    return result;
  }

  setParam(key: string, value: number): void {
    delegatePinSetParam(this._pinModelsByLabel, key, value);
  }
}

// ---------------------------------------------------------------------------
// BehavioralDecoderElement
// ---------------------------------------------------------------------------

/**
 * Analog behavioral model for a decoder.
 *
 * Pin layout (nodeIds order, matching buildDecoderPinDeclarations):
 *   nodeIds[0]               = sel (selectorBits-wide input)
 *   nodeIds[1..outputCount]  = out_0 .. out_(N-1)
 *
 * Exactly one output is driven HIGH (the one indexed by the selector value);
 * all others are driven LOW.
 */
export class BehavioralDecoderElement {
  private readonly _selPins: DigitalInputPinModel[];
  private readonly _outPins: DigitalOutputPinModel[];
  private readonly _outputCount: number;
  private readonly _pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>;
  private readonly _childElements: AnalogCapacitorElement[];

  pinNodeIds!: readonly number[];  // set by compiler via Object.assign after factory returns
  readonly branchIndex: number = -1;
  readonly isNonlinear: true = true;
  label?: string;

  readonly poolBacked = true as const;
  readonly stateSchema: StateSchema = COMBINATIONAL_COMPOSITE_SCHEMA;
  stateSize: number;
  stateBaseOffset = -1;
  private _pool!: StatePoolRef;

  constructor(
    selPins: DigitalInputPinModel[],
    outPins: DigitalOutputPinModel[],
    outputCount: number,
    pinModelsByLabel: ReadonlyMap<string, DigitalInputPinModel | DigitalOutputPinModel>,
  ) {
    this._selPins = selPins;
    this._outPins = outPins;
    this._outputCount = outputCount;
    this._pinModelsByLabel = pinModelsByLabel;

    const allPins: (DigitalInputPinModel | DigitalOutputPinModel)[] = [
      ...selPins,
      ...outPins,
    ];
    this._childElements = collectPinModelChildren(allPins);
    this.stateSize = this._childElements.reduce((s, c) => s + c.stateSize, 0);
  }

  get isReactive(): boolean {
    return this._childElements.length > 0;
  }

  initState(pool: StatePoolRef): void {
    this._pool = pool;
    let offset = this.stateBaseOffset;
    for (const child of this._childElements) {
      child.stateBaseOffset = offset;
      child.initState(pool);
      offset += child.stateSize;
    }
  }

  checkConvergence(ctx: LoadContext): boolean {
    return this._childElements.every(c => !c.checkConvergence || c.checkConvergence(ctx));
  }

  load(ctx: LoadContext): void {
    const voltages = ctx.rhsOld;

    // Decode selector
    let sel = 0;
    for (let b = 0; b < this._selPins.length; b++) {
      const nodeId = this._selPins[b].nodeId;
      const voltage = readMnaVoltage(nodeId, voltages);
      const level = this._selPins[b].readLogicLevel(voltage);
      if (level !== undefined) {
        if (level) sel |= 1 << b;
        else sel &= ~(1 << b);
      }
    }

    // Delegate stamping for selector-pin loading
    for (const p of this._selPins) p.load(ctx);

    // One-hot output: only the selected index is HIGH
    for (let i = 0; i < this._outputCount; i++) {
      this._outPins[i].setLogicLevel(i === sel);
      this._outPins[i].load(ctx);
    }

    for (const child of this._childElements) {
      child.load(ctx);
    }
  }

  accept(_ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
    // No accept() work needed — capacitors handle their own state via load()
  }

  /**
   * Per-pin currents in pinNodeIds (pinLayout) order:
   *   [sel, out_0, out_1, ..., out_(N-1)]
   *
   * sel is an input: I = V_node / rIn (current into element).
   * out_i are outputs: I = (V_node - V_target) / rOut (current into element).
   * Sum is nonzero because behavioral outputs have an implicit supply.
   */
  getPinCurrents(voltages: Float64Array): number[] {
    const result: number[] = [];
    // sel pin (input) — all selPins share the same node; use first
    const selPin = this._selPins[0];
    if (selPin !== undefined) {
      const vSel = readMnaVoltage(selPin.nodeId, voltages);
      result.push(vSel / selPin.rIn);
    }
    // output pins
    for (const p of this._outPins) {
      const vNode = readMnaVoltage(p.nodeId, voltages);
      result.push((vNode - p.currentVoltage) / p.rOut);
    }
    return result;
  }

  setParam(key: string, value: number): void {
    delegatePinSetParam(this._pinModelsByLabel, key, value);
  }
}

// ---------------------------------------------------------------------------
// Helper: resolve pin electrical spec from props
// ---------------------------------------------------------------------------

function resolveSpec(
  props: PropertyBag,
  pinLabel: string,
): ResolvedPinElectrical {
  const pinSpecs = props.has("_pinElectrical")
    ? (props.get("_pinElectrical") as unknown as Record<string, ResolvedPinElectrical>)
    : undefined;
  return pinSpecs?.[pinLabel] ?? FALLBACK_SPEC;
}

function resolveLoaded(props: PropertyBag, pinLabel: string, defaultLoaded: boolean): boolean {
  const pinLoading = props.has("_pinLoading")
    ? (props.get("_pinLoading") as unknown as Record<string, boolean>)
    : undefined;
  return pinLoading !== undefined ? (pinLoading[pinLabel] ?? defaultLoaded) : defaultLoaded;
}

// ---------------------------------------------------------------------------
// makeBehavioralMuxAnalogFactory
// ---------------------------------------------------------------------------

/**
 * Returns an analogFactory for a multiplexer with the given selectorBits.
 *
 * Pin layout matches buildMuxPinDeclarations:
 *   "sel"              = selector input (multi-bit bus — one MNA node)
 *   "in_0".."in_(N-1)" = data inputs (each multi-bit bus — one MNA node each)
 *   "out"              = output (multi-bit bus — one MNA node)
 *
 * All per-bit pin model arrays share the single bus node for their label.
 */
export function makeBehavioralMuxAnalogFactory(selectorBits: number): AnalogElementFactory {
  return (pinNodes, _internalNodeIds, _branchIdx, props, _getTime) => {
    const bitWidth = props.has("bitWidth") ? (props.get("bitWidth") as number) : 1;
    const inputCount = 1 << selectorBits;

    // All selector bit pins share the single "sel" bus node
    const selNodeId = pinNodes.get("sel") ?? 0;
    const selSpec = resolveSpec(props, "sel");
    const selLoaded = resolveLoaded(props, "sel", true);
    const selPins: DigitalInputPinModel[] = [];
    for (let b = 0; b < selectorBits; b++) {
      const pin = new DigitalInputPinModel(selSpec, selLoaded);
      pin.init(selNodeId, 0);
      selPins.push(pin);
    }

    // Each data input group shares its own "in_i" bus node
    const dataPins: DigitalInputPinModel[][] = [];
    for (let i = 0; i < inputCount; i++) {
      const inLabel = `in_${i}`;
      const inNodeId = pinNodes.get(inLabel) ?? 0;
      const spec = resolveSpec(props, inLabel);
      const loaded = resolveLoaded(props, inLabel, true);
      const group: DigitalInputPinModel[] = [];
      for (let bit = 0; bit < bitWidth; bit++) {
        const pin = new DigitalInputPinModel(spec, loaded);
        pin.init(inNodeId, 0);
        group.push(pin);
      }
      dataPins.push(group);
    }

    // All output bit pins share the single "out" bus node
    const outNodeId = pinNodes.get("out") ?? 0;
    const outSpec = resolveSpec(props, "out");
    const outLoaded = resolveLoaded(props, "out", false);
    const outPins: DigitalOutputPinModel[] = [];
    for (let bit = 0; bit < bitWidth; bit++) {
      const pin = new DigitalOutputPinModel(outSpec, outLoaded, "direct");
      pin.init(outNodeId, -1);
      outPins.push(pin);
    }

    const pinModelsByLabel = new Map<string, DigitalInputPinModel | DigitalOutputPinModel>();
    pinModelsByLabel.set("sel", selPins[0]);
    for (let i = 0; i < inputCount; i++) {
      pinModelsByLabel.set(`in_${i}`, dataPins[i][0]);
    }
    pinModelsByLabel.set("out", outPins[0]);

    return new BehavioralMuxElement(selPins, dataPins, outPins, inputCount, bitWidth, pinModelsByLabel);
  };
}

// ---------------------------------------------------------------------------
// makeBehavioralDemuxAnalogFactory
// ---------------------------------------------------------------------------

/**
 * Returns an analogFactory for a demultiplexer with the given selectorBits.
 *
 * Pin layout matches buildDemuxPinDeclarations:
 *   "sel"              = selector input (multi-bit bus — one MNA node)
 *   "out_0".."out_(N-1)" = outputs (each 1-bit — one MNA node each)
 *   "in"               = data input (multi-bit bus — one MNA node)
 *
 * All selector bit pins share the single "sel" bus node.
 */
export function makeBehavioralDemuxAnalogFactory(selectorBits: number): AnalogElementFactory {
  return (pinNodes, _internalNodeIds, _branchIdx, props, _getTime) => {
    const outputCount = 1 << selectorBits;

    // All selector bit pins share the single "sel" bus node
    const selNodeId = pinNodes.get("sel") ?? 0;
    const selSpec = resolveSpec(props, "sel");
    const selLoaded = resolveLoaded(props, "sel", true);
    const selPins: DigitalInputPinModel[] = [];
    for (let b = 0; b < selectorBits; b++) {
      const pin = new DigitalInputPinModel(selSpec, selLoaded);
      pin.init(selNodeId, 0);
      selPins.push(pin);
    }

    // Each output pin has its own "out_i" node (1-bit pins)
    const outPins: DigitalOutputPinModel[] = [];
    for (let i = 0; i < outputCount; i++) {
      const outLabel = `out_${i}`;
      const spec = resolveSpec(props, outLabel);
      const loaded = resolveLoaded(props, outLabel, false);
      const pin = new DigitalOutputPinModel(spec, loaded, "direct");
      pin.init(pinNodes.get(outLabel) ?? 0, -1);
      outPins.push(pin);
    }

    // Input pin
    const inSpec = resolveSpec(props, "in");
    const inLoaded = resolveLoaded(props, "in", true);
    const inPin = new DigitalInputPinModel(inSpec, inLoaded);
    inPin.init(pinNodes.get("in") ?? 0, 0);

    const pinModelsByLabel = new Map<string, DigitalInputPinModel | DigitalOutputPinModel>();
    pinModelsByLabel.set("sel", selPins[0]);
    pinModelsByLabel.set("in", inPin);
    for (let i = 0; i < outputCount; i++) {
      pinModelsByLabel.set(`out_${i}`, outPins[i]);
    }

    return new BehavioralDemuxElement(selPins, inPin, outPins, outputCount, pinModelsByLabel);
  };
}

// ---------------------------------------------------------------------------
// makeBehavioralDecoderAnalogFactory
// ---------------------------------------------------------------------------

/**
 * Returns an analogFactory for a decoder with the given selectorBits.
 *
 * Pin layout matches buildDecoderPinDeclarations:
 *   "sel"              = selector input (multi-bit bus — one MNA node)
 *   "out_0".."out_(N-1)" = outputs (each 1-bit — one MNA node each)
 *
 * All selector bit pins share the single "sel" bus node.
 * Decoder outputs are always 1-bit (no bitWidth property).
 */
export function makeBehavioralDecoderAnalogFactory(selectorBits: number): AnalogElementFactory {
  return (pinNodes, _internalNodeIds, _branchIdx, props, _getTime) => {
    const outputCount = 1 << selectorBits;

    // All selector bit pins share the single "sel" bus node
    const selNodeId = pinNodes.get("sel") ?? 0;
    const selSpec = resolveSpec(props, "sel");
    const selLoaded = resolveLoaded(props, "sel", true);
    const selPins: DigitalInputPinModel[] = [];
    for (let b = 0; b < selectorBits; b++) {
      const pin = new DigitalInputPinModel(selSpec, selLoaded);
      pin.init(selNodeId, 0);
      selPins.push(pin);
    }

    // Each output pin has its own "out_i" node (1-bit pins)
    const outPins: DigitalOutputPinModel[] = [];
    for (let i = 0; i < outputCount; i++) {
      const outLabel = `out_${i}`;
      const spec = resolveSpec(props, outLabel);
      const loaded = resolveLoaded(props, outLabel, false);
      const pin = new DigitalOutputPinModel(spec, loaded, "direct");
      pin.init(pinNodes.get(outLabel) ?? 0, -1);
      outPins.push(pin);
    }

    const pinModelsByLabel = new Map<string, DigitalInputPinModel | DigitalOutputPinModel>();
    pinModelsByLabel.set("sel", selPins[0]);
    for (let i = 0; i < outputCount; i++) {
      pinModelsByLabel.set(`out_${i}`, outPins[i]);
    }

    return new BehavioralDecoderElement(selPins, outPins, outputCount, pinModelsByLabel);
  };
}
