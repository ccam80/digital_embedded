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
import type { AnalogElement, IntegrationMethod } from "./element.js";
import type { PropertyBag } from "../core/properties.js";
import type { ResolvedPinElectrical } from "../core/pin-electrical.js";
import {
  DigitalInputPinModel,
  DigitalOutputPinModel,
  readMnaVoltage,
} from "./digital-pin-model.js";
import {
  capacitorConductance,
  capacitorHistoryCurrent,
} from "./integration.js";

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

// ---------------------------------------------------------------------------
// Helper: stamp a conductance between two MNA nodes (ground = node 0 not stamped)
// ---------------------------------------------------------------------------

function stampG(
  solver: SparseSolver,
  nA: number,
  nB: number,
  g: number,
): void {
  if (nA > 0) solver.stamp(nA - 1, nA - 1, g);
  if (nB > 0) solver.stamp(nB - 1, nB - 1, g);
  if (nA > 0 && nB > 0) {
    solver.stamp(nA - 1, nB - 1, -g);
    solver.stamp(nB - 1, nA - 1, -g);
  }
}

function stampRHS(solver: SparseSolver, n: number, val: number): void {
  if (n > 0) solver.stampRHS(n - 1, val);
}

// ---------------------------------------------------------------------------
// Driver analog factory — tri-state buffer
//
// Pins (nodeIds order matches PinDeclaration order):
//   nodeIds[0] = in (data input)
//   nodeIds[1] = sel (enable)
//   nodeIds[2] = out (output)
//
// When sel > vIH: output = input logic level via DigitalOutputPinModel (driven)
// When sel < vIL: output in Hi-Z mode (R_HiZ to ground)
// ---------------------------------------------------------------------------

export function createDriverAnalogElement(
  nodeIds: number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElement {
  const nodeIn = nodeIds[0];
  const nodeSel = nodeIds[1];
  const nodeOut = nodeIds[2];

  const inSpec = getPinSpec(props, "in");
  const selSpec = getPinSpec(props, "sel");
  const outSpec = getPinSpec(props, "out");

  const inputPin = new DigitalInputPinModel(inSpec);
  inputPin.init(nodeIn, 0);

  const selPin = new DigitalInputPinModel(selSpec);
  selPin.init(nodeSel, 0);

  const outputPin = new DigitalOutputPinModel(outSpec);
  outputPin.init(nodeOut, -1);
  outputPin.setHighZ(true); // default Hi-Z until sel is known

  let cachedVoltages = new Float64Array(0);
  let latchedIn = false;
  let latchedSel = false;
  let solver: SparseSolver | null = null;

  return {
    nodeIndices: [nodeIn, nodeSel, nodeOut],
    branchIndex: -1,
    isNonlinear: true,
    isReactive: true,

    stamp(s: SparseSolver): void {
      solver = s;
      inputPin.stamp(s);
      selPin.stamp(s);
    },

    stampNonlinear(s: SparseSolver): void {
      solver = s;
      const v = cachedVoltages;
      const vIn = readMnaVoltage(nodeIn, v);
      const vSel = readMnaVoltage(nodeSel, v);

      const inLevel = inputPin.readLogicLevel(vIn);
      if (inLevel !== undefined) latchedIn = inLevel;

      const selLevel = selPin.readLogicLevel(vSel);
      if (selLevel !== undefined) latchedSel = selLevel;

      outputPin.setHighZ(!latchedSel);
      outputPin.setLogicLevel(latchedIn);
      outputPin.stamp(s);
    },

    updateOperatingPoint(voltages: Float64Array): void {
      if (cachedVoltages.length !== voltages.length) {
        cachedVoltages = new Float64Array(voltages.length);
      }
      cachedVoltages.set(voltages);
    },

    stampCompanion(dt: number, method: IntegrationMethod, _voltages: Float64Array): void {
      if (solver === null) return;
      inputPin.stampCompanion(solver, dt, method);
      selPin.stampCompanion(solver, dt, method);
      outputPin.stampCompanion(solver, dt, method);
    },

    updateCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
      inputPin.updateCompanion(dt, method, readMnaVoltage(nodeIn, voltages));
      selPin.updateCompanion(dt, method, readMnaVoltage(nodeSel, voltages));
      outputPin.updateCompanion(dt, method, readMnaVoltage(nodeOut, voltages));
    },
  };
}

// ---------------------------------------------------------------------------
// DriverInvSel analog factory — inverting tri-state (active-low enable)
//
// Same as Driver but enable logic is inverted: sel=0 → driven, sel=1 → Hi-Z
// ---------------------------------------------------------------------------

export function createDriverInvAnalogElement(
  nodeIds: number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElement {
  const nodeIn = nodeIds[0];
  const nodeSel = nodeIds[1];
  const nodeOut = nodeIds[2];

  const inSpec = getPinSpec(props, "in");
  const selSpec = getPinSpec(props, "sel");
  const outSpec = getPinSpec(props, "out");

  const inputPin = new DigitalInputPinModel(inSpec);
  inputPin.init(nodeIn, 0);

  const selPin = new DigitalInputPinModel(selSpec);
  selPin.init(nodeSel, 0);

  const outputPin = new DigitalOutputPinModel(outSpec);
  outputPin.init(nodeOut, -1);
  outputPin.setHighZ(false); // active-low: sel=0 → driven

  let cachedVoltages = new Float64Array(0);
  let latchedIn = false;
  let latchedSel = false;
  let solver: SparseSolver | null = null;

  return {
    nodeIndices: [nodeIn, nodeSel, nodeOut],
    branchIndex: -1,
    isNonlinear: true,
    isReactive: true,

    stamp(s: SparseSolver): void {
      solver = s;
      inputPin.stamp(s);
      selPin.stamp(s);
    },

    stampNonlinear(s: SparseSolver): void {
      solver = s;
      const v = cachedVoltages;
      const vIn = readMnaVoltage(nodeIn, v);
      const vSel = readMnaVoltage(nodeSel, v);

      const inLevel = inputPin.readLogicLevel(vIn);
      if (inLevel !== undefined) latchedIn = inLevel;

      const selLevel = selPin.readLogicLevel(vSel);
      if (selLevel !== undefined) latchedSel = selLevel;

      // Active-low: hiZ when sel is HIGH
      outputPin.setHighZ(latchedSel);
      outputPin.setLogicLevel(latchedIn);
      outputPin.stamp(s);
    },

    updateOperatingPoint(voltages: Float64Array): void {
      if (cachedVoltages.length !== voltages.length) {
        cachedVoltages = new Float64Array(voltages.length);
      }
      cachedVoltages.set(voltages);
    },

    stampCompanion(dt: number, method: IntegrationMethod, _voltages: Float64Array): void {
      if (solver === null) return;
      inputPin.stampCompanion(solver, dt, method);
      selPin.stampCompanion(solver, dt, method);
      outputPin.stampCompanion(solver, dt, method);
    },

    updateCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
      inputPin.updateCompanion(dt, method, readMnaVoltage(nodeIn, voltages));
      selPin.updateCompanion(dt, method, readMnaVoltage(nodeSel, voltages));
      outputPin.updateCompanion(dt, method, readMnaVoltage(nodeOut, voltages));
    },
  };
}

// ---------------------------------------------------------------------------
// Splitter analog factory — pass-through per bit
//
// Each input bit has an independent DigitalInputPinModel → DigitalOutputPinModel
// pair. nodeIds order follows PinDeclaration order: inputs first, outputs after.
//
// For a splitter with N input ports and M output ports:
//   nodeIds[0..N-1]     = input nodes
//   nodeIds[N..N+M-1]   = output nodes
//
// Each input voltage is threshold-detected and its level is driven on the
// corresponding output. For mismatched port counts the min(N, M) pairs are
// connected and remaining ports are driven LOW.
// ---------------------------------------------------------------------------

export function createSplitterAnalogElement(
  nodeIds: number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElement {
  const inputCountProp = props.has("_inputCount")
    ? (props.get("_inputCount") as number)
    : 1;
  const outputCountProp = props.has("_outputCount")
    ? (props.get("_outputCount") as number)
    : 1;

  const numIn = inputCountProp;
  const numOut = outputCountProp;
  const totalPins = numIn + numOut;
  const actualNodeIds = nodeIds.slice(0, totalPins);

  const inputPins: DigitalInputPinModel[] = [];
  const outputPins: DigitalOutputPinModel[] = [];

  for (let i = 0; i < numIn; i++) {
    const spec = getPinSpec(props, `in${i}`);
    const pin = new DigitalInputPinModel(spec);
    pin.init(actualNodeIds[i] ?? 0, 0);
    inputPins.push(pin);
  }

  const latchedLevels: boolean[] = new Array(numIn).fill(false);

  for (let i = 0; i < numOut; i++) {
    const spec = getPinSpec(props, `out${i}`);
    const pin = new DigitalOutputPinModel(spec);
    pin.init(actualNodeIds[numIn + i] ?? 0, -1);
    pin.setLogicLevel(false);
    outputPins.push(pin);
  }

  let cachedVoltages = new Float64Array(0);
  let solver: SparseSolver | null = null;

  return {
    nodeIndices: actualNodeIds,
    branchIndex: -1,
    isNonlinear: true,
    isReactive: true,

    stamp(s: SparseSolver): void {
      solver = s;
      for (const p of inputPins) p.stamp(s);
    },

    stampNonlinear(s: SparseSolver): void {
      solver = s;
      const v = cachedVoltages;
      for (let i = 0; i < numIn; i++) {
        const nodeId = inputPins[i].nodeId;
        const voltage = readMnaVoltage(nodeId, v);
        const level = inputPins[i].readLogicLevel(voltage);
        if (level !== undefined) latchedLevels[i] = level;
      }
      for (let i = 0; i < numOut; i++) {
        outputPins[i].setLogicLevel(latchedLevels[i] ?? false);
        outputPins[i].stamp(s);
      }
    },

    updateOperatingPoint(voltages: Float64Array): void {
      if (cachedVoltages.length !== voltages.length) {
        cachedVoltages = new Float64Array(voltages.length);
      }
      cachedVoltages.set(voltages);
    },

    stampCompanion(dt: number, method: IntegrationMethod, _voltages: Float64Array): void {
      if (solver === null) return;
      for (const p of inputPins) p.stampCompanion(solver, dt, method);
      for (const p of outputPins) p.stampCompanion(solver, dt, method);
    },

    updateCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
      for (const p of inputPins) {
        p.updateCompanion(dt, method, readMnaVoltage(p.nodeId, voltages));
      }
      for (const p of outputPins) {
        p.updateCompanion(dt, method, readMnaVoltage(p.nodeId, voltages));
      }
    },
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

function createSegmentDiodeElement(
  nodeAnode: number,
  nodeCathode: number,
): AnalogElement {
  let geq = LED_GMIN;
  let ieq = 0;

  return {
    nodeIndices: [nodeAnode, nodeCathode],
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,

    stamp(_s: SparseSolver): void {
      // No linear topology contributions for nonlinear diode
    },

    stampNonlinear(s: SparseSolver): void {
      stampG(s, nodeAnode, nodeCathode, geq);
      stampRHS(s, nodeAnode, -ieq);
      if (nodeCathode > 0) stampRHS(s, nodeCathode, ieq);
    },

    updateOperatingPoint(voltages: Float64Array): void {
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
    },

    checkConvergence(voltages: Float64Array, prevVoltages: Float64Array): boolean {
      const va = nodeAnode > 0 ? voltages[nodeAnode - 1] : 0;
      const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
      const vaPrev = nodeAnode > 0 ? prevVoltages[nodeAnode - 1] : 0;
      const vcPrev = nodeCathode > 0 ? prevVoltages[nodeCathode - 1] : 0;
      return Math.abs((va - vc) - (vaPrev - vcPrev)) <= 0.05;
    },
  };
}

export function createSevenSegAnalogElement(
  nodeIds: number[],
  _branchIdx: number,
  _props: PropertyBag,
): AnalogElement {
  // 8 segment nodes: a=0, b=1, c=2, d=3, e=4, f=5, g=6, dp=7
  // Each segment is a diode from nodeIds[i] to ground (node 0)
  const segDiodes = nodeIds.slice(0, 8).map((n) =>
    createSegmentDiodeElement(n, 0),
  );

  return {
    nodeIndices: nodeIds.slice(0, 8),
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,

    stamp(s: SparseSolver): void {
      for (const d of segDiodes) d.stamp(s);
    },

    stampNonlinear(s: SparseSolver): void {
      for (const d of segDiodes) d.stampNonlinear!(s);
    },

    updateOperatingPoint(voltages: Float64Array): void {
      for (const d of segDiodes) d.updateOperatingPoint!(voltages);
    },

    checkConvergence(voltages: Float64Array, prevVoltages: Float64Array): boolean {
      return segDiodes.every((d) => d.checkConvergence!(voltages, prevVoltages));
    },
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
  nodeIds: number[],
  branchIdx: number,
  props: PropertyBag,
): AnalogElement {
  const nodeCoil1 = nodeIds[0]; // in1
  const nodeCoil2 = nodeIds[1]; // in2
  const nodeContactA = nodeIds[2]; // A1
  const nodeContactB = nodeIds[3]; // B1

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

  // Stored solver reference for stampCompanion (set during stamp/stampNonlinear)
  let cachedSolver: SparseSolver | null = null;

  // Current contact conductance
  function contactG(): number {
    return contactClosed ? 1 / RELAY_R_ON : 1 / RELAY_R_OFF;
  }

  const allNodes = [nodeCoil1, nodeCoil2, nodeContactA, nodeContactB];
  const branchRow = branchIdx; // MNA row for inductor branch current

  return {
    nodeIndices: allNodes,
    branchIndex: branchRow,
    isNonlinear: true,
    isReactive: true,

    stamp(s: SparseSolver): void {
      cachedSolver = s;
      // Coil DC resistance stamps between coil1 and coil2
      stampG(s, nodeCoil1, nodeCoil2, 1 / rCoil);
      // Contact variable resistance (linear stamp uses current contact state)
      stampG(s, nodeContactA, nodeContactB, contactG());
    },

    stampNonlinear(s: SparseSolver): void {
      cachedSolver = s;
      // Re-stamp contact conductance (may have changed in updateState)
      stampG(s, nodeContactA, nodeContactB, contactG());
    },

    updateOperatingPoint(_voltages: Float64Array): void {
      // No nonlinear operating-point update needed for coil resistance
    },

    stampCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
      if (L <= 0 || dt <= 0 || cachedSolver === null) return;
      const s = cachedSolver;
      // Companion model: G_eq = dt/(2L) for trapezoidal, dt/L for BDF-1
      const factor = method === "bdf1" ? 1 : (method === "bdf2" ? 2 / 3 : 0.5);
      geqL = (dt * factor) / L;
      // History current from previous timestep
      const vCoil1 = nodeCoil1 > 0 ? voltages[nodeCoil1 - 1] : 0;
      const vCoil2 = nodeCoil2 > 0 ? voltages[nodeCoil2 - 1] : 0;
      const vL = vCoil1 - vCoil2;
      if (method === "trapezoidal") {
        ieqL = iL + geqL * vL;
      } else {
        ieqL = iL;
      }
      // Stamp inductor companion: parallel conductance + current source between coil nodes
      stampG(s, nodeCoil1, nodeCoil2, geqL);
      // History current source: into node coil1, out of node coil2
      stampRHS(s, nodeCoil1, ieqL);
      if (nodeCoil2 > 0) stampRHS(s, nodeCoil2, -ieqL);
    },

    updateState(dt: number, voltages: Float64Array): void {
      // Update inductor current from accepted solution
      if (L > 0 && dt > 0) {
        const vCoil1 = nodeCoil1 > 0 ? voltages[nodeCoil1 - 1] : 0;
        const vCoil2 = nodeCoil2 > 0 ? voltages[nodeCoil2 - 1] : 0;
        const vL = vCoil1 - vCoil2;
        const factor = 0.5; // trapezoidal default
        iL = ieqL + geqL * vL + factor * (dt / L) * vL;
      }
      // Update contact state based on coil current magnitude
      const coilCurrentMag = Math.abs(iL);
      const energised = coilCurrentMag > iPull;
      contactClosed = normallyClosed ? !energised : energised;
    },
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
  nodeIds: number[],
  branchIdx: number,
  props: PropertyBag,
): AnalogElement {
  const nodeCoil1 = nodeIds[0];
  const nodeCoil2 = nodeIds[1];
  const nodeCommon = nodeIds[2]; // A1
  const nodeThrow = nodeIds[3];  // B1 (normally open)
  const nodeRest = nodeIds[4];   // C1 (normally closed)

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

  // Stored solver reference for stampCompanion (set during stamp/stampNonlinear)
  let cachedSolverDT: SparseSolver | null = null;

  function gThrow(): number { return energised ? 1 / RELAY_R_ON : 1 / RELAY_R_OFF; }
  function gRest(): number { return energised ? 1 / RELAY_R_OFF : 1 / RELAY_R_ON; }

  return {
    nodeIndices: [nodeCoil1, nodeCoil2, nodeCommon, nodeThrow, nodeRest],
    branchIndex: branchIdx,
    isNonlinear: true,
    isReactive: true,

    stamp(s: SparseSolver): void {
      cachedSolverDT = s;
      stampG(s, nodeCoil1, nodeCoil2, 1 / rCoil);
      stampG(s, nodeCommon, nodeThrow, gThrow());
      stampG(s, nodeCommon, nodeRest, gRest());
    },

    stampNonlinear(s: SparseSolver): void {
      cachedSolverDT = s;
      stampG(s, nodeCommon, nodeThrow, gThrow());
      stampG(s, nodeCommon, nodeRest, gRest());
    },

    updateOperatingPoint(_voltages: Float64Array): void {},

    stampCompanion(dt: number, method: IntegrationMethod, voltages: Float64Array): void {
      if (L <= 0 || dt <= 0 || cachedSolverDT === null) return;
      const s = cachedSolverDT;
      const factor = method === "bdf1" ? 1 : (method === "bdf2" ? 2 / 3 : 0.5);
      geqL = (dt * factor) / L;
      const vCoil1 = nodeCoil1 > 0 ? voltages[nodeCoil1 - 1] : 0;
      const vCoil2 = nodeCoil2 > 0 ? voltages[nodeCoil2 - 1] : 0;
      const vL = vCoil1 - vCoil2;
      ieqL = method === "trapezoidal" ? iL + geqL * vL : iL;
      stampG(s, nodeCoil1, nodeCoil2, geqL);
      stampRHS(s, nodeCoil1, ieqL);
      if (nodeCoil2 > 0) stampRHS(s, nodeCoil2, -ieqL);
    },

    updateState(dt: number, voltages: Float64Array): void {
      if (L > 0 && dt > 0) {
        const vCoil1 = nodeCoil1 > 0 ? voltages[nodeCoil1 - 1] : 0;
        const vCoil2 = nodeCoil2 > 0 ? voltages[nodeCoil2 - 1] : 0;
        const vL = vCoil1 - vCoil2;
        iL = ieqL + geqL * vL + 0.5 * (dt / L) * vL;
      }
      energised = Math.abs(iL) > iPull;
    },
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
  nodeIds: number[],
  _branchIdx: number,
  props: PropertyBag,
): AnalogElement {
  const nodeOut = nodeIds[0]; // button output
  const nodeLedIn = nodeIds[1]; // LED anode

  const outSpec = getPinSpec(props, "out");
  const outputPin = new DigitalOutputPinModel(outSpec);
  outputPin.init(nodeOut, -1);
  outputPin.setLogicLevel(false); // default low

  const ledDiode = createSegmentDiodeElement(nodeLedIn, 0);

  return {
    nodeIndices: [nodeOut, nodeLedIn],
    branchIndex: -1,
    isNonlinear: true,
    isReactive: false,

    stamp(s: SparseSolver): void {
      outputPin.stamp(s);
      ledDiode.stamp(s);
    },

    stampNonlinear(s: SparseSolver): void {
      outputPin.stamp(s);
      ledDiode.stampNonlinear!(s);
    },

    updateOperatingPoint(voltages: Float64Array): void {
      ledDiode.updateOperatingPoint!(voltages);
    },

    checkConvergence(voltages: Float64Array, prevVoltages: Float64Array): boolean {
      return ledDiode.checkConvergence!(voltages, prevVoltages);
    },
  };
}

