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
import type { AnalogElementCore, PoolBackedAnalogElementCore, LoadContext, StatePoolRef } from "./element.js";
import { NGSPICE_LOAD_ORDER } from "./element.js";
import type { PropertyBag } from "../../core/properties.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";
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
// Driver analog factory â€” tri-state buffer
//
// Pin labels (matching buildDriverPinDeclarations):
//   "in"  = data input
//   "sel" = enable
//   "out" = output
//
// When sel > vIH: output = input logic level via DigitalOutputPinModel (driven)
// When sel < vIL: output in Hi-Z mode (R_HiZ to ground)
// ---------------------------------------------------------------------------

export function createDriverAnalogElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): PoolBackedAnalogElementCore {
  const nodeIn = pinNodes.get("in") ?? 0;
  const nodeSel = pinNodes.get("sel") ?? 0;
  const nodeOut = pinNodes.get("out") ?? 0;

  const inSpec = getPinSpec(props, "in");
  const selSpec = getPinSpec(props, "sel");
  const outSpec = getPinSpec(props, "out");

  const inputPin = new DigitalInputPinModel(inSpec, getPinLoadingFlag(props, "in", true));
  inputPin.init(nodeIn, 0);

  const selPin = new DigitalInputPinModel(selSpec, getPinLoadingFlag(props, "sel", true));
  selPin.init(nodeSel, 0);

  const outputPin = new DigitalOutputPinModel(outSpec, getPinLoadingFlag(props, "out", false), "direct");
  outputPin.init(nodeOut, -1);
  outputPin.setHighZ(true); // default Hi-Z until sel is known

  let latchedIn = false;
  let latchedSel = false;

  const pinModelsByLabel = new Map<string, DigitalInputPinModel | DigitalOutputPinModel>([
    ["in", inputPin],
    ["sel", selPin],
    ["out", outputPin],
  ]);

  const childElements: readonly AnalogCapacitorElement[] = collectPinModelChildren([inputPin, selPin, outputPin]);
  const stateSize = childElements.reduce((s, c) => s + c.stateSize, 0);

  return {
    branchIndex: -1,
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VCVS,
    isNonlinear: true,
    get isReactive(): boolean { return childElements.length > 0; },

    poolBacked: true as const,
    stateSchema: REMAINING_COMPOSITE_SCHEMA,
    stateSize,
    stateBaseOffset: -1,
    s0: new Float64Array(0),
    s1: new Float64Array(0),
    s2: new Float64Array(0),
    s3: new Float64Array(0),
    s4: new Float64Array(0),
    s5: new Float64Array(0),
    s6: new Float64Array(0),
    s7: new Float64Array(0),

    initState(pool: StatePoolRef): void {
      let offset = this.stateBaseOffset;
      for (const child of childElements) {
        child.stateBaseOffset = offset;
        child.initState(pool);
        offset += child.stateSize;
      }
    },

    load(ctx: LoadContext): void {
      const v = ctx.rhsOld;

      inputPin.load(ctx);
      selPin.load(ctx);

      const vIn = readMnaVoltage(nodeIn, v);
      const vSel = readMnaVoltage(nodeSel, v);

      const inLevel = inputPin.readLogicLevel(vIn);
      if (inLevel !== undefined) latchedIn = inLevel;

      const selLevel = selPin.readLogicLevel(vSel);
      if (selLevel !== undefined) latchedSel = selLevel;

      outputPin.setHighZ(!latchedSel);
      outputPin.setLogicLevel(latchedIn);
      outputPin.load(ctx);

      for (const child of childElements) { child.load(ctx); }
    },

    accept(_ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {},

    getPinCurrents(voltages: Float64Array): number[] {
      // Pin layout order: in (input), sel (enable input), out (output)
      // Input pins: I = V_node / rIn
      // Output pin: I = (V_node - V_target) / rOut  (Hi-Z: V_node / rHiZ)
      const vIn = readMnaVoltage(nodeIn, voltages);
      const iIn = vIn / inputPin.rIn;

      const vSel = readMnaVoltage(nodeSel, voltages);
      const iSel = vSel / selPin.rIn;

      const vOut = readMnaVoltage(nodeOut, voltages);
      const iOut = outputPin.isHiZ
        ? vOut / outputPin.rHiZ
        : (vOut - outputPin.currentVoltage) / outputPin.rOut;

      return [iIn, iSel, iOut];
    },

    setParam(key: string, value: number) { delegatePinSetParam(pinModelsByLabel, key, value); },
  };
}

// ---------------------------------------------------------------------------
// DriverInvSel analog factory â€” inverting tri-state (active-low enable)
//
// Same as Driver but enable logic is inverted: sel=0 â†’ driven, sel=1 â†’ Hi-Z
// Pin labels: "in", "sel", "out" (matching buildDriverPinDeclarations)
// ---------------------------------------------------------------------------

export function createDriverInvAnalogElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): PoolBackedAnalogElementCore {
  const nodeIn = pinNodes.get("in") ?? 0;
  const nodeSel = pinNodes.get("sel") ?? 0;
  const nodeOut = pinNodes.get("out") ?? 0;

  const inSpec = getPinSpec(props, "in");
  const selSpec = getPinSpec(props, "sel");
  const outSpec = getPinSpec(props, "out");

  const inputPin = new DigitalInputPinModel(inSpec, getPinLoadingFlag(props, "in", true));
  inputPin.init(nodeIn, 0);

  const selPin = new DigitalInputPinModel(selSpec, getPinLoadingFlag(props, "sel", true));
  selPin.init(nodeSel, 0);

  const outputPin = new DigitalOutputPinModel(outSpec, getPinLoadingFlag(props, "out", false), "direct");
  outputPin.init(nodeOut, -1);
  outputPin.setHighZ(false); // active-low: sel=0 â†’ driven

  let latchedIn = false;
  let latchedSel = false;

  const pinModelsByLabel = new Map<string, DigitalInputPinModel | DigitalOutputPinModel>([
    ["in", inputPin],
    ["sel", selPin],
    ["out", outputPin],
  ]);

  const childElements: readonly AnalogCapacitorElement[] = collectPinModelChildren([inputPin, selPin, outputPin]);
  const stateSize = childElements.reduce((s, c) => s + c.stateSize, 0);

  return {
    branchIndex: -1,
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VCVS,
    isNonlinear: true,
    get isReactive(): boolean { return childElements.length > 0; },

    poolBacked: true as const,
    stateSchema: REMAINING_COMPOSITE_SCHEMA,
    stateSize,
    stateBaseOffset: -1,
    s0: new Float64Array(0),
    s1: new Float64Array(0),
    s2: new Float64Array(0),
    s3: new Float64Array(0),
    s4: new Float64Array(0),
    s5: new Float64Array(0),
    s6: new Float64Array(0),
    s7: new Float64Array(0),

    initState(pool: StatePoolRef): void {
      let offset = this.stateBaseOffset;
      for (const child of childElements) {
        child.stateBaseOffset = offset;
        child.initState(pool);
        offset += child.stateSize;
      }
    },

    load(ctx: LoadContext): void {
      const v = ctx.rhsOld;

      inputPin.load(ctx);
      selPin.load(ctx);

      const vIn = readMnaVoltage(nodeIn, v);
      const vSel = readMnaVoltage(nodeSel, v);

      const inLevel = inputPin.readLogicLevel(vIn);
      if (inLevel !== undefined) latchedIn = inLevel;

      const selLevel = selPin.readLogicLevel(vSel);
      if (selLevel !== undefined) latchedSel = selLevel;

      // Active-low: hiZ when sel is HIGH
      outputPin.setHighZ(latchedSel);
      outputPin.setLogicLevel(latchedIn);
      outputPin.load(ctx);

      for (const child of childElements) { child.load(ctx); }
    },

    accept(_ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {},

    getPinCurrents(voltages: Float64Array): number[] {
      // Pin layout order: in (input), sel (enable input), out (output)
      // Input pins: I = V_node / rIn
      // Output pin: I = (V_node - V_target) / rOut  (Hi-Z: V_node / rHiZ)
      const vIn = readMnaVoltage(nodeIn, voltages);
      const iIn = vIn / inputPin.rIn;

      const vSel = readMnaVoltage(nodeSel, voltages);
      const iSel = vSel / selPin.rIn;

      const vOut = readMnaVoltage(nodeOut, voltages);
      const iOut = outputPin.isHiZ
        ? vOut / outputPin.rHiZ
        : (vOut - outputPin.currentVoltage) / outputPin.rOut;

      return [iIn, iSel, iOut];
    },

    setParam(key: string, value: number) { delegatePinSetParam(pinModelsByLabel, key, value); },
  };
}

// ---------------------------------------------------------------------------
// Splitter analog factory â€” pass-through per bit
//
// Pin labels are dynamic bit-range names from buildSplitterPinDeclarations
// (e.g. "0", "4-7", "0,1"). Inputs come first in pinLayout order, outputs after.
// The _inputCount/_outputCount props indicate how many of each there are.
//
// Each input voltage is threshold-detected and its level is driven on the
// corresponding output. For mismatched port counts the min(N, M) pairs are
// connected and remaining ports are driven LOW.
// ---------------------------------------------------------------------------

export function createSplitterAnalogElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): PoolBackedAnalogElementCore {
  const numIn = props.has("_inputCount")
    ? (props.get("_inputCount") as number)
    : 1;
  const numOut = props.has("_outputCount")
    ? (props.get("_outputCount") as number)
    : 1;

  // Pin labels are ordered in pinLayout order: inputs first, outputs after.
  // Extract node IDs in that order from pinNodes.
  const allNodeIds = Array.from(pinNodes.values());
  const allLabels = Array.from(pinNodes.keys());

  const inputPins: DigitalInputPinModel[] = [];
  const outputPins: DigitalOutputPinModel[] = [];

  for (let i = 0; i < numIn; i++) {
    const label = allLabels[i] ?? `in${i}`;
    const spec = getPinSpec(props, label);
    const pin = new DigitalInputPinModel(spec, getPinLoadingFlag(props, label, true));
    pin.init(allNodeIds[i] ?? 0, 0);
    inputPins.push(pin);
  }

  const latchedLevels: boolean[] = new Array(numIn).fill(false);

  for (let i = 0; i < numOut; i++) {
    const label = allLabels[numIn + i] ?? `out${i}`;
    const spec = getPinSpec(props, label);
    const pin = new DigitalOutputPinModel(spec, getPinLoadingFlag(props, label, false), "direct");
    pin.init(allNodeIds[numIn + i] ?? 0, -1);
    pin.setLogicLevel(false);
    outputPins.push(pin);
  }

  const childElements: readonly AnalogCapacitorElement[] = collectPinModelChildren([...inputPins, ...outputPins]);
  const stateSize = childElements.reduce((s, c) => s + c.stateSize, 0);

  return {
    branchIndex: -1,
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VCVS,
    isNonlinear: true,
    get isReactive(): boolean { return childElements.length > 0; },

    poolBacked: true as const,
    stateSchema: REMAINING_COMPOSITE_SCHEMA,
    stateSize,
    stateBaseOffset: -1,
    s0: new Float64Array(0),
    s1: new Float64Array(0),
    s2: new Float64Array(0),
    s3: new Float64Array(0),
    s4: new Float64Array(0),
    s5: new Float64Array(0),
    s6: new Float64Array(0),
    s7: new Float64Array(0),

    initState(_pool: StatePoolRef): void {
      let offset = this.stateBaseOffset;
      for (const child of childElements) {
        child.stateBaseOffset = offset;
        child.initState(_pool);
        offset += child.stateSize;
      }
    },

    load(ctx: LoadContext): void {
      const v = ctx.rhsOld;

      for (const p of inputPins) p.load(ctx);

      for (let i = 0; i < numIn; i++) {
        const nodeId = inputPins[i].nodeId;
        const voltage = readMnaVoltage(nodeId, v);
        const level = inputPins[i].readLogicLevel(voltage);
        if (level !== undefined) latchedLevels[i] = level;
      }
      for (let i = 0; i < numOut; i++) {
        outputPins[i].setLogicLevel(latchedLevels[i] ?? false);
        outputPins[i].load(ctx);
      }

      for (const child of childElements) { child.load(ctx); }
    },

    accept(_ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {},

    getPinCurrents(voltages: Float64Array): number[] {
      // pinLayout order: inputs first, outputs after
      const result: number[] = [];
      for (const p of inputPins) {
        result.push(readMnaVoltage(p.nodeId, voltages) / p.rIn);
      }
      for (const p of outputPins) {
        const v = readMnaVoltage(p.nodeId, voltages);
        result.push((v - p.currentVoltage) / p.rOut);
      }
      return result;
    },

    setParam(_key: string, _value: number) {},
  };
}

// ---------------------------------------------------------------------------
// SevenSeg analog factory â€” 7 parallel LED diode models (segments aâ€“g + dp)
//
// Each of the 8 segment inputs (a, b, c, d, e, f, g, dp) drives an independent
// LED diode model. nodeIds order matches pin declaration order (a, b, c, d, e, f, g, dp).
// Each segment diode is modeled as a simplified forward-biased diode
// (piecewise linear: R_on=50Î© when forward-biased, R_off=10MÎ© otherwise).
//
// For the analog model, each segment pin is treated as a DigitalInputPinModel
// (reading from the driving circuit) with an LED-style diode load. The cathode
// of each segment is implicitly at ground (common cathode configuration).
// ---------------------------------------------------------------------------

/** Piecewise-linear LED diode: Vf â‰ˆ 2.0V, R_on = 50Î©, R_off = 10MÎ© */
const LED_VF = 2.0;
const LED_RON = 50;
const LED_ROFF = 1e7;
const LED_GMIN = 1e-12;

type SegmentDiodeElement = AnalogElementCore & {
  /** Unified load entry point â€” stamps linearized diode equations. */
  load(ctx: LoadContext): void;
  /** NR-iteration convergence test. */
  checkConvergence(ctx: LoadContext): boolean;
  /** Current flowing into the anode pin at the accepted operating point. */
  anodeCurrent(voltages: Float64Array): number;
};

function createSegmentDiodeElement(
  nodeAnode: number,
  nodeCathode: number,
): SegmentDiodeElement {
  let geq = LED_GMIN;
  let ieq = 0;
  let _vdStored = 0;
  let _idStored = 0;

  return {
    branchIndex: -1,
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VCVS,
    isNonlinear: true,
    isReactive: false,

    load(ctx: LoadContext): void {
      const s = ctx.solver;
      const voltages = ctx.rhsOld;
      const va = voltages[nodeAnode];
      const vc = voltages[nodeCathode];
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

      stampG(s, nodeAnode, nodeCathode, geq);
      stampRHS(ctx.rhs, nodeAnode, -ieq);
      if (nodeCathode > 0) stampRHS(ctx.rhs, nodeCathode, ieq);
    },

    checkConvergence(ctx: LoadContext): boolean {
      const voltages = ctx.rhsOld;
      const va = voltages[nodeAnode];
      const vc = voltages[nodeCathode];
      const vdRaw = va - vc;

      const delvd = vdRaw - _vdStored;
      const cdhat = _idStored + geq * delvd;
      const tol = ctx.reltol * Math.max(Math.abs(cdhat), Math.abs(_idStored)) + ctx.iabstol;
      return Math.abs(cdhat - _idStored) <= tol;
    },

    anodeCurrent(voltages: Float64Array): number {
      // Current flowing into anode = geq*(Va - Vc) - ieq
      const va = voltages[nodeAnode];
      const vc = voltages[nodeCathode];
      return geq * (va - vc) - ieq;
    },

    getPinCurrents(voltages: Float64Array): number[] {
      const va = voltages[nodeAnode];
      const vc = voltages[nodeCathode];
      const I = geq * (va - vc) - ieq;
      return [I, -I];
    },

    setParam(_key: string, _value: number): void {},
  };
}

export function createSevenSegAnalogElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  _props: PropertyBag,
): AnalogElementCore {
  // 8 segment nodes: a, b, c, d, e, f, g, dp
  // Each segment is a diode from the pin node to ground (node 0)
  const segLabels = ["a", "b", "c", "d", "e", "f", "g", "dp"] as const;
  const segNodes = segLabels.map((lbl) => pinNodes.get(lbl)!);
  const segDiodes = segNodes.map((n) =>
    createSegmentDiodeElement(n, 0),
  );

  return {
    branchIndex: -1,
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VCVS,
    isNonlinear: true,
    isReactive: false,

    load(ctx: LoadContext): void {
      for (const d of segDiodes) d.load(ctx);
    },

    checkConvergence(ctx: LoadContext): boolean {
      return segDiodes.every((d) => d.checkConvergence(ctx));
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // pinLayout order: a, b, c, d, e, f, g, dp
      // Each segment pin: current into anode = geq*(Va - Vc) - ieq (Vc = ground = 0)
      return segDiodes.map((d) => d.anodeCurrent(voltages));
    },

    setParam(_key: string, _value: number) {},
  };
}

// ---------------------------------------------------------------------------
// Relay analog factory â€” coil inductor + contact variable resistance
//
// Coil: series inductance L (default 100mH) + DC resistance R_coil (default 100Î©)
//   modeled as companion-model inductor in series with resistor
// Contact: variable resistance between A1 and B1
//   R_on = 0.01Î© (closed), R_off = 10MÎ© (open)
//   Threshold: coil current > I_pull (default 20mA) â†’ contact closes
//
// Pin nodeIds order (SPST, 1 pole):
//   nodeIds[0] = in1 (coil terminal 1)
//   nodeIds[1] = in2 (coil terminal 2)
//   nodeIds[2] = branchIdx row (coil branch â€” uses MNA branch variable)
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

export function createRelayAnalogElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  branchIdx: number,
  props: PropertyBag,
): PoolBackedAnalogElementCore & { getChildElements(): readonly AnalogInductorElement[] } {
  // Composite-child pattern â€” delegates coil integration to a standard
  // AnalogInductorElement child, following the DigitalPinModel â†’
  // AnalogCapacitorElement precedent landed in Phase 0 Wave 0.2.3
  // (src/solver/analog/digital-pin-model.ts).
  const nodeCoil1 = pinNodes.get("in1")!; // coil terminal 1
  const nodeCoil2 = pinNodes.get("in2")!; // coil terminal 2
  const nodeContactA = pinNodes.get("A1")!; // contact A
  const nodeContactB = pinNodes.get("B1")!; // contact B

  const rCoil = props.has("coilResistance")
    ? (props.get("coilResistance") as number)
    : RELAY_R_COIL_DEFAULT;
  const L = props.has("inductance")
    ? (props.get("inductance") as number)
    : RELAY_L_DEFAULT;
  const iPull = props.has("iPull")
    ? (props.get("iPull") as number)
    : RELAY_I_PULL_DEFAULT;
  const normallyClosed = props.has("normallyClosed")
    ? (props.get("normallyClosed") as boolean)
    : false;

  // Child inductor element owns coil branch row, state pool slots, and load()
  // integration. The relay's own load() stamps only the contact conductances.
  const coilInductor = new AnalogInductorElement(
    branchIdx,
    L,
    INDUCTOR_DEFAULTS["IC"]!,
    INDUCTOR_DEFAULTS["TC1"]!,
    INDUCTOR_DEFAULTS["TC2"]!,
    INDUCTOR_DEFAULTS["TNOM"]!,
    INDUCTOR_DEFAULTS["SCALE"]!,
    INDUCTOR_DEFAULTS["M"]!,
  );
  coilInductor.pinNodeIds = [nodeCoil1, nodeCoil2];

  // Contact state
  let contactClosed = normallyClosed;

  function contactG(): number {
    return contactClosed ? 1 / RELAY_R_ON : 1 / RELAY_R_OFF;
  }

  return {
    branchIndex: branchIdx,
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VCVS,
    isNonlinear: true,
    isReactive: true,

    poolBacked: true as const,
    stateSchema: REMAINING_COMPOSITE_SCHEMA,
    stateSize: coilInductor.stateSize,
    stateBaseOffset: -1,
    s0: new Float64Array(0),
    s1: new Float64Array(0),
    s2: new Float64Array(0),
    s3: new Float64Array(0),
    s4: new Float64Array(0),
    s5: new Float64Array(0),
    s6: new Float64Array(0),
    s7: new Float64Array(0),

    initState(pool: StatePoolRef): void {
      coilInductor.stateBaseOffset = this.stateBaseOffset;
      coilInductor.initState(pool);
    },

    getChildElements(): readonly AnalogInductorElement[] {
      return [coilInductor];
    },

    load(ctx: LoadContext): void {
      const s = ctx.solver;
      // Coil DC resistance stamps between coil1 and coil2
      stampG(s, nodeCoil1, nodeCoil2, 1 / rCoil);
      // Contact variable resistance (current contact state)
      stampG(s, nodeContactA, nodeContactB, contactG());
      // Coil inductor stamping is handled entirely by the child element
      coilInductor.load(ctx);
    },

    accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
      // Read accepted coil current from the child inductor's branch row.
      // branchIdx is the 1-based MNA row (matches AnalogInductorElement convention).
      const iCoil = branchIdx >= 0 ? ctx.rhs[branchIdx] : 0;
      const energised = Math.abs(iCoil) > iPull;
      contactClosed = normallyClosed ? !energised : energised;
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // Pin layout order: in1, in2, A1, B1 (Relay poles=1).
      // Coil branch current from child inductor's branch row (1-based MNA row).
      const iCoil = branchIdx >= 0 ? voltages[branchIdx] : 0;
      const vA = voltages[nodeContactA];
      const vB = voltages[nodeContactB];
      const iContact = contactG() * (vA - vB);
      return [iCoil, -iCoil, iContact, -iContact];
    },

    setParam(key: string, value: number) { coilInductor.setParam(key, value); },
  };
}

// ---------------------------------------------------------------------------
// RelayDT analog factory â€” same as Relay but with DPDT contact configuration
//
// Pin nodeIds order (SPDT, 1 pole):
//   nodeIds[0] = in1 (coil)
//   nodeIds[1] = in2 (coil)
//   nodeIds[2] = A1 (common contact)
//   nodeIds[3] = B1 (throw â€” NO, connects when energised)
//   nodeIds[4] = C1 (rest â€” NC, connects when de-energised)
// ---------------------------------------------------------------------------

export function createRelayDTAnalogElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  branchIdx: number,
  props: PropertyBag,
): PoolBackedAnalogElementCore & { getChildElements(): readonly AnalogInductorElement[] } {
  // Composite-child pattern â€” delegates coil integration to a standard
  // AnalogInductorElement child, following the DigitalPinModel â†’
  // AnalogCapacitorElement precedent landed in Phase 0 Wave 0.2.3
  // (src/solver/analog/digital-pin-model.ts).
  const nodeCoil1 = pinNodes.get("in1")!; // coil terminal 1
  const nodeCoil2 = pinNodes.get("in2")!; // coil terminal 2
  const nodeCommon = pinNodes.get("A1")!;  // common (A1)
  const nodeThrow = pinNodes.get("B1")!;   // normally open (B1)
  const nodeRest = pinNodes.get("C1")!;    // normally closed (C1)

  const rCoil = props.has("coilResistance")
    ? (props.get("coilResistance") as number)
    : RELAY_R_COIL_DEFAULT;
  const L = props.has("inductance")
    ? (props.get("inductance") as number)
    : RELAY_L_DEFAULT;
  const iPull = props.has("iPull")
    ? (props.get("iPull") as number)
    : RELAY_I_PULL_DEFAULT;

  // Child inductor element owns coil branch row, state pool slots, and load()
  // integration. The relay's own load() stamps only the contact conductances.
  const coilInductor = new AnalogInductorElement(
    branchIdx,
    L,
    INDUCTOR_DEFAULTS["IC"]!,
    INDUCTOR_DEFAULTS["TC1"]!,
    INDUCTOR_DEFAULTS["TC2"]!,
    INDUCTOR_DEFAULTS["TNOM"]!,
    INDUCTOR_DEFAULTS["SCALE"]!,
    INDUCTOR_DEFAULTS["M"]!,
  );
  coilInductor.pinNodeIds = [nodeCoil1, nodeCoil2];

  // Initial state: de-energised â†’ A-C connected (rest), A-B open (throw)
  let energised = false;

  function gThrow(): number { return energised ? 1 / RELAY_R_ON : 1 / RELAY_R_OFF; }
  function gRest(): number { return energised ? 1 / RELAY_R_OFF : 1 / RELAY_R_ON; }

  return {
    branchIndex: branchIdx,
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VCVS,
    isNonlinear: true,
    isReactive: true,

    poolBacked: true as const,
    stateSchema: REMAINING_COMPOSITE_SCHEMA,
    stateSize: coilInductor.stateSize,
    stateBaseOffset: -1,
    s0: new Float64Array(0),
    s1: new Float64Array(0),
    s2: new Float64Array(0),
    s3: new Float64Array(0),
    s4: new Float64Array(0),
    s5: new Float64Array(0),
    s6: new Float64Array(0),
    s7: new Float64Array(0),

    initState(pool: StatePoolRef): void {
      coilInductor.stateBaseOffset = this.stateBaseOffset;
      coilInductor.initState(pool);
    },

    getChildElements(): readonly AnalogInductorElement[] {
      return [coilInductor];
    },

    load(ctx: LoadContext): void {
      const s = ctx.solver;
      stampG(s, nodeCoil1, nodeCoil2, 1 / rCoil);
      stampG(s, nodeCommon, nodeThrow, gThrow());
      stampG(s, nodeCommon, nodeRest, gRest());
      // Coil inductor stamping is handled entirely by the child element
      coilInductor.load(ctx);
    },

    accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
      // Read accepted coil current from the child inductor's branch row.
      // branchIdx is the 1-based MNA row (matches AnalogInductorElement convention).
      const iCoil = branchIdx >= 0 ? ctx.rhs[branchIdx] : 0;
      energised = Math.abs(iCoil) > iPull;
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // Pin layout order: in1, in2, A1 (common), B1 (throw), C1 (rest).
      // Coil branch current from child inductor's branch row (1-based MNA row).
      const iCoil = branchIdx >= 0 ? voltages[branchIdx] : 0;
      const vCom = voltages[nodeCommon];
      const vThr = voltages[nodeThrow];
      const vRst = voltages[nodeRest];
      const iThrow = gThrow() * (vCom - vThr);
      const iRest = gRest() * (vCom - vRst);
      return [iCoil, -iCoil, iThrow + iRest, -iThrow, -iRest];
    },

    setParam(key: string, value: number) { coilInductor.setParam(key, value); },
  };
}

// ---------------------------------------------------------------------------
// ButtonLED analog factory â€” switch (variable resistance) + LED diode
//
// Pin nodeIds order (matches buildButtonLEDPinDeclarations):
//   nodeIds[0] = out (button output â€” digital output pin)
//   nodeIds[1] = in  (LED input â€” LED anode, cathode at ground)
//
// The button output is driven by a DigitalOutputPinModel (logic HIGH or LOW).
// The LED input is a forward-biased diode from nodeIds[1] to ground.
// ---------------------------------------------------------------------------

export function createButtonLEDAnalogElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
  const nodeOut = pinNodes.get("out")!;  // button output
  const nodeLedIn = pinNodes.get("in")!; // LED anode

  const outSpec = getPinSpec(props, "out");
  const outputPin = new DigitalOutputPinModel(outSpec, getPinLoadingFlag(props, "out", false), "direct");
  outputPin.init(nodeOut, -1);
  outputPin.setLogicLevel(false); // default low

  const ledDiode = createSegmentDiodeElement(nodeLedIn, 0);

  const pinModelsByLabel = new Map<string, DigitalInputPinModel | DigitalOutputPinModel>([
    ["out", outputPin],
  ]);

  return {
    branchIndex: -1,
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.VCVS,
    isNonlinear: true,
    isReactive: false,

    load(ctx: LoadContext): void {
      outputPin.load(ctx);
      ledDiode.load(ctx);
    },

    checkConvergence(ctx: LoadContext): boolean {
      return ledDiode.checkConvergence(ctx);
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // Pin layout order: out (button output), in (LED anode).
      // out: DigitalOutputPinModel current into element
      // in:  LED diode anode current into element
      const vOut = readMnaVoltage(nodeOut, voltages);
      const iOut = outputPin.isHiZ
        ? vOut / outputPin.rHiZ
        : (vOut - outputPin.currentVoltage) / outputPin.rOut;
      const iLed = ledDiode.anodeCurrent(voltages);
      return [iOut, iLed];
    },

    setParam(key: string, value: number) { delegatePinSetParam(pinModelsByLabel, key, value); },
  };
}
