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
import type { AnalogElementCore, LoadContext } from "./element.js";
import { MODETRAN } from "./ckt-mode.js";
import type { PropertyBag } from "../../core/properties.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";
import {
  delegatePinSetParam,
  DigitalInputPinModel,
  DigitalOutputPinModel,
  readMnaVoltage,
} from "./digital-pin-model.js";

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
  if (nA > 0) solver.stampElement(solver.allocElement(nA - 1, nA - 1), g);
  if (nB > 0) solver.stampElement(solver.allocElement(nB - 1, nB - 1), g);
  if (nA > 0 && nB > 0) {
    solver.stampElement(solver.allocElement(nA - 1, nB - 1), -g);
    solver.stampElement(solver.allocElement(nB - 1, nA - 1), -g);
  }
}

function stampRHS(solver: SparseSolver, n: number, val: number): void {
  if (n > 0) solver.stampRHS(n - 1, val);
}

// ---------------------------------------------------------------------------
// Driver analog factory — tri-state buffer
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
): AnalogElementCore {
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

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: true,

    load(ctx: LoadContext): void {
      const v = ctx.voltages;

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
    },

    accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
      const v = ctx.voltages;
      inputPin.accept(ctx, readMnaVoltage(nodeIn, v));
      selPin.accept(ctx, readMnaVoltage(nodeSel, v));
      outputPin.accept(ctx, readMnaVoltage(nodeOut, v));
    },

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
// DriverInvSel analog factory — inverting tri-state (active-low enable)
//
// Same as Driver but enable logic is inverted: sel=0 → driven, sel=1 → Hi-Z
// Pin labels: "in", "sel", "out" (matching buildDriverPinDeclarations)
// ---------------------------------------------------------------------------

export function createDriverInvAnalogElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
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
  outputPin.setHighZ(false); // active-low: sel=0 → driven

  let latchedIn = false;
  let latchedSel = false;

  const pinModelsByLabel = new Map<string, DigitalInputPinModel | DigitalOutputPinModel>([
    ["in", inputPin],
    ["sel", selPin],
    ["out", outputPin],
  ]);

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: true,

    load(ctx: LoadContext): void {
      const v = ctx.voltages;

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
    },

    accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
      const v = ctx.voltages;
      inputPin.accept(ctx, readMnaVoltage(nodeIn, v));
      selPin.accept(ctx, readMnaVoltage(nodeSel, v));
      outputPin.accept(ctx, readMnaVoltage(nodeOut, v));
    },

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
// Splitter analog factory — pass-through per bit
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
): AnalogElementCore {
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

  return {
    branchIndex: -1,
    isNonlinear: true,
    isReactive: true,

    load(ctx: LoadContext): void {
      const v = ctx.voltages;

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
    },

    accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
      const v = ctx.voltages;
      for (const p of inputPins) {
        p.accept(ctx, readMnaVoltage(p.nodeId, v));
      }
      for (const p of outputPins) {
        p.accept(ctx, readMnaVoltage(p.nodeId, v));
      }
    },

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
// SevenSeg analog factory — 7 parallel LED diode models (segments a–g + dp)
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

type SegmentDiodeElement = AnalogElementCore & {
  /** Unified load entry point — stamps linearized diode equations. */
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
    isNonlinear: true,
    isReactive: false,

    load(ctx: LoadContext): void {
      const s = ctx.solver;
      const voltages = ctx.voltages;
      const va = nodeAnode > 0 ? voltages[nodeAnode - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
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
      stampRHS(s, nodeAnode, -ieq);
      if (nodeCathode > 0) stampRHS(s, nodeCathode, ieq);
    },

    checkConvergence(ctx: LoadContext): boolean {
      const voltages = ctx.voltages;
      const va = nodeAnode > 0 ? voltages[nodeAnode - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vdRaw = va - vc;

      const delvd = vdRaw - _vdStored;
      const cdhat = _idStored + geq * delvd;
      const tol = ctx.reltol * Math.max(Math.abs(cdhat), Math.abs(_idStored)) + ctx.iabstol;
      return Math.abs(cdhat - _idStored) <= tol;
    },

    anodeCurrent(voltages: Float64Array): number {
      // Current flowing into anode = geq*(Va - Vc) - ieq
      const va = nodeAnode > 0 ? voltages[nodeAnode - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      return geq * (va - vc) - ieq;
    },

    getPinCurrents(voltages: Float64Array): number[] {
      const va = nodeAnode > 0 ? voltages[nodeAnode - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
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
// Relay analog factory — coil inductor + contact variable resistance
//
// Coil: series inductance L (default 100mH) + DC resistance R_coil (default 100Ω)
//   modeled as companion-model inductor in series with resistor
// Contact: variable resistance between A1 and B1
//   R_on = 0.01Ω (closed), R_off = 10MΩ (open)
//   Threshold: coil current > I_pull (default 20mA) → contact closes
//
// Pin nodeIds order (SPST, 1 pole):
//   nodeIds[0] = in1 (coil terminal 1)
//   nodeIds[1] = in2 (coil terminal 2)
//   nodeIds[2] = branchIdx row (coil branch — uses MNA branch variable)
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
): AnalogElementCore {
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

  // Inductor companion model state
  let iL = 0; // inductor current (through branch)
  let geqL = 0;
  let ieqL = 0;

  // Contact state
  let contactClosed = normallyClosed;

  // Current contact conductance
  function contactG(): number {
    return contactClosed ? 1 / RELAY_R_ON : 1 / RELAY_R_OFF;
  }

  const branchRow = branchIdx; // MNA row for inductor branch current

  return {
    branchIndex: branchRow,
    isNonlinear: true,
    isReactive: true,

    load(ctx: LoadContext): void {
      const s = ctx.solver;
      const voltages = ctx.voltages;

      // Coil DC resistance stamps between coil1 and coil2
      stampG(s, nodeCoil1, nodeCoil2, 1 / rCoil);
      // Contact variable resistance (current contact state)
      stampG(s, nodeContactA, nodeContactB, contactG());

      if ((ctx.cktMode & MODETRAN) !== 0 && ctx.dt > 0 && L > 0) {
        // Inductor companion model: G_eq = dt/(2L) for trapezoidal,
        // dt/L for BDF-1, 2/3 * dt/L for BDF-2
        const factor = ctx.method === "bdf1" ? 1 : (ctx.method === "bdf2" ? 2 / 3 : 0.5);
        geqL = (ctx.dt * factor) / L;
        const vCoil1 = nodeCoil1 > 0 ? voltages[nodeCoil1 - 1] : 0;
        const vCoil2 = nodeCoil2 > 0 ? voltages[nodeCoil2 - 1] : 0;
        const vL = vCoil1 - vCoil2;
        if (ctx.method === "trapezoidal") {
          ieqL = iL + geqL * vL;
        } else {
          ieqL = iL;
        }
        // Stamp inductor companion: parallel conductance + current source
        stampG(s, nodeCoil1, nodeCoil2, geqL);
        stampRHS(s, nodeCoil1, ieqL);
        if (nodeCoil2 > 0) stampRHS(s, nodeCoil2, -ieqL);
      }
    },

    accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
      const voltages = ctx.voltages;
      // Update inductor current from accepted solution
      if (L > 0 && ctx.dt > 0) {
        const vCoil1 = nodeCoil1 > 0 ? voltages[nodeCoil1 - 1] : 0;
        const vCoil2 = nodeCoil2 > 0 ? voltages[nodeCoil2 - 1] : 0;
        const vL = vCoil1 - vCoil2;
        const factor = 0.5; // trapezoidal default
        iL = ieqL + geqL * vL + factor * (ctx.dt / L) * vL;
      }
      // Update contact state based on coil current magnitude
      const coilCurrentMag = Math.abs(iL);
      const energised = coilCurrentMag > iPull;
      contactClosed = normallyClosed ? !energised : energised;
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // Pin layout order: in1, in2, A1, B1 (Relay poles=1).
      // Coil: 1/rCoil between coil1 and coil2.
      // Contact: contactG() between A1 and B1.
      const vCoil1 = nodeCoil1 > 0 ? voltages[nodeCoil1 - 1] : 0;
      const vCoil2 = nodeCoil2 > 0 ? voltages[nodeCoil2 - 1] : 0;
      const iCoil = (vCoil1 - vCoil2) / rCoil;
      const vA = nodeContactA > 0 ? voltages[nodeContactA - 1] : 0;
      const vB = nodeContactB > 0 ? voltages[nodeContactB - 1] : 0;
      const iContact = contactG() * (vA - vB);
      return [iCoil, -iCoil, iContact, -iContact];
    },

    setParam(_key: string, _value: number) {},
  };
}

// ---------------------------------------------------------------------------
// RelayDT analog factory — same as Relay but with DPDT contact configuration
//
// Pin nodeIds order (SPDT, 1 pole):
//   nodeIds[0] = in1 (coil)
//   nodeIds[1] = in2 (coil)
//   nodeIds[2] = A1 (common contact)
//   nodeIds[3] = B1 (throw — NO, connects when energised)
//   nodeIds[4] = C1 (rest — NC, connects when de-energised)
// ---------------------------------------------------------------------------

export function createRelayDTAnalogElement(
  pinNodes: ReadonlyMap<string, number>,
  _internalNodeIds: readonly number[],
  branchIdx: number,
  props: PropertyBag,
): AnalogElementCore {
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

  let iL = 0;
  let geqL = 0;
  let ieqL = 0;

  // Initial state: de-energised → A-C connected (rest), A-B open (throw)
  let energised = false;

  function gThrow(): number { return energised ? 1 / RELAY_R_ON : 1 / RELAY_R_OFF; }
  function gRest(): number { return energised ? 1 / RELAY_R_OFF : 1 / RELAY_R_ON; }

  return {
    branchIndex: branchIdx,
    isNonlinear: true,
    isReactive: true,

    load(ctx: LoadContext): void {
      const s = ctx.solver;
      const voltages = ctx.voltages;

      stampG(s, nodeCoil1, nodeCoil2, 1 / rCoil);
      stampG(s, nodeCommon, nodeThrow, gThrow());
      stampG(s, nodeCommon, nodeRest, gRest());

      if ((ctx.cktMode & MODETRAN) !== 0 && ctx.dt > 0 && L > 0) {
        const factor = ctx.method === "bdf1" ? 1 : (ctx.method === "bdf2" ? 2 / 3 : 0.5);
        geqL = (ctx.dt * factor) / L;
        const vCoil1 = nodeCoil1 > 0 ? voltages[nodeCoil1 - 1] : 0;
        const vCoil2 = nodeCoil2 > 0 ? voltages[nodeCoil2 - 1] : 0;
        const vL = vCoil1 - vCoil2;
        ieqL = ctx.method === "trapezoidal" ? iL + geqL * vL : iL;
        stampG(s, nodeCoil1, nodeCoil2, geqL);
        stampRHS(s, nodeCoil1, ieqL);
        if (nodeCoil2 > 0) stampRHS(s, nodeCoil2, -ieqL);
      }
    },

    accept(ctx: LoadContext, _simTime: number, _addBreakpoint: (t: number) => void): void {
      const voltages = ctx.voltages;
      if (L > 0 && ctx.dt > 0) {
        const vCoil1 = nodeCoil1 > 0 ? voltages[nodeCoil1 - 1] : 0;
        const vCoil2 = nodeCoil2 > 0 ? voltages[nodeCoil2 - 1] : 0;
        const vL = vCoil1 - vCoil2;
        iL = ieqL + geqL * vL + 0.5 * (ctx.dt / L) * vL;
      }
      energised = Math.abs(iL) > iPull;
    },

    getPinCurrents(voltages: Float64Array): number[] {
      // Pin layout order: in1, in2, A1 (common), B1 (throw), C1 (rest).
      // Coil: 1/rCoil between in1 and in2.
      // Contacts: gThrow() between common/throw, gRest() between common/rest.
      const vCoil1 = nodeCoil1 > 0 ? voltages[nodeCoil1 - 1] : 0;
      const vCoil2 = nodeCoil2 > 0 ? voltages[nodeCoil2 - 1] : 0;
      const iCoil = (vCoil1 - vCoil2) / rCoil;
      const vCom = nodeCommon > 0 ? voltages[nodeCommon - 1] : 0;
      const vThr = nodeThrow > 0 ? voltages[nodeThrow - 1] : 0;
      const vRst = nodeRest > 0 ? voltages[nodeRest - 1] : 0;
      const iThrow = gThrow() * (vCom - vThr);
      const iRest = gRest() * (vCom - vRst);
      return [iCoil, -iCoil, iThrow + iRest, -iThrow, -iRest];
    },

    setParam(_key: string, _value: number) {},
  };
}

// ---------------------------------------------------------------------------
// ButtonLED analog factory — switch (variable resistance) + LED diode
//
// Pin nodeIds order (matches buildButtonLEDPinDeclarations):
//   nodeIds[0] = out (button output — digital output pin)
//   nodeIds[1] = in  (LED input — LED anode, cathode at ground)
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
