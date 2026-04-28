/**
 * Tests for behavioral analog factories for combinational digital components:
 * multiplexer (BehavioralMuxElement), demultiplexer (BehavioralDemuxElement),
 * and decoder (BehavioralDecoderElement).
 *
 * Node convention (matching behavioral-gate.test.ts):
 *   - DigitalInputPinModel / DigitalOutputPinModel use 1-based MNA node IDs.
 *     Node 0 = ground (ngspice TrashCan/sentinel); real nodes start at 1.
 *   - makeVoltageSource / makeResistor use 1-based circuit node IDs.
 *   - result.voltages is 1-based: result.voltages[N] = voltage at circuit node N.
 *
 * Pattern per test: input nodes driven by ideal voltage sources, output nodes
 * loaded with 10kΩ to ground. Newton-Raphson converges; output voltages are
 * compared to vIH / vIL thresholds.
 */

import { describe, it, expect } from "vitest";
import { makeSimpleCtx, initElement, makeLoadCtx } from "./test-helpers.js";
import { newtonRaphson } from "../newton-raphson.js";
import {
  BehavioralMuxElement,
  BehavioralDemuxElement,
  BehavioralDecoderElement,
  makeBehavioralMuxAnalogFactory,
  makeBehavioralDemuxAnalogFactory,
  makeBehavioralDecoderAnalogFactory,
} from "../behavioral-combinational.js";
import {
  DigitalInputPinModel,
  DigitalOutputPinModel,
} from "../digital-pin-model.js";
import type { ResolvedPinElectrical } from "../../../core/pin-electrical.js";
import type { AnalogFactory } from "../../../core/registry.js";
import { PropertyBag } from "../../../core/properties.js";
import type { AnalogElement } from "../element.js";
import type { LoadContext } from "../load-context.js";
import { MODETRAN, MODEINITFLOAT } from "../ckt-mode.js";
import { MuxDefinition } from "../../../components/wiring/mux.js";
import { DemuxDefinition } from "../../../components/wiring/demux.js";
import { DecoderDefinition } from "../../../components/wiring/decoder.js";
import { makeDcVoltageSource, DC_VOLTAGE_SOURCE_DEFAULTS } from "../../../components/sources/dc-voltage-source.js";
import { ResistorDefinition } from "../../../components/passives/resistor.js";

// ---------------------------------------------------------------------------
// Shared test constants
// ---------------------------------------------------------------------------

const CMOS_3V3: ResolvedPinElectrical = {
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

const VDD = 3.3;
const GND = 0.0;
const LOAD_R = 10_000;
const NR_OPTS = { maxIterations: 50, reltol: 1e-3, abstol: 1e-6, iabstol: 1e-12 };

// ---------------------------------------------------------------------------
// Local element builders
// ---------------------------------------------------------------------------

/**
 * Build a DC voltage source element.
 * posNode / negNode are 1-based MNA node IDs (0 = ground sentinel).
 */
function makeVoltageSource(posNode: number, negNode: number, voltage: number): AnalogElement {
  const props = new PropertyBag();
  props.replaceModelParams({ ...DC_VOLTAGE_SOURCE_DEFAULTS, voltage });
  return makeDcVoltageSource(new Map([["pos", posNode], ["neg", negNode]]), props, () => 0);
}

/**
 * Build a resistor element using the production ResistorDefinition factory.
 * nodeA / nodeB are 1-based MNA node IDs.
 */
function makeResistor(nodeA: number, nodeB: number, resistance: number): AnalogElement {
  const pinNodes = new Map([["A", nodeA], ["B", nodeB]]);
  const props = new PropertyBag();
  props.replaceModelParams({ resistance });
  const factory = (ResistorDefinition.modelRegistry!["behavioral"] as { factory: (p: ReadonlyMap<string, number>, pr: PropertyBag, g: () => number) => AnalogElement }).factory;
  return factory(pinNodes, props, () => 0);
}

// ---------------------------------------------------------------------------
// Solve helper
// ---------------------------------------------------------------------------

function solve(elements: AnalogElement[], matrixSize: number, nodeCount: number) {
  const ctx = makeSimpleCtx({ elements, matrixSize, nodeCount, params: NR_OPTS });
  newtonRaphson(ctx);
  return ctx.nrResult;
}

// ---------------------------------------------------------------------------
// Mux tests
// ---------------------------------------------------------------------------

describe("Mux", () => {
  /**
   * 4:1 mux (selectorBits=2, bitWidth=1).
   *
   * Solver index → circuit node mapping (0-based):
   *   0 = sel bit 0  (circuit node 1)
   *   1 = sel bit 1  (circuit node 2)
   *   2 = in_0       (circuit node 3)
   *   3 = in_1       (circuit node 4)
   *   4 = in_2       (circuit node 5)
   *   5 = in_3       (circuit node 6)
   *   6 = out        (circuit node 7)
   *   7..12 = branch rows for 6 voltage sources
   *
   * matrixSize = 7 nodes + 6 branch rows = 13
   */
  function buildMux4to1(selVal: number, inputVoltages: number[]) {
    const vSel0 = ((selVal >> 0) & 1) === 1 ? VDD : GND;
    const vSel1 = ((selVal >> 1) & 1) === 1 ? VDD : GND;

    // Selector pin models — MNA node IDs 1 and 2 (1-based)
    const selPin0 = new DigitalInputPinModel(CMOS_3V3, true);
    selPin0.init(1, 0);
    const selPin1 = new DigitalInputPinModel(CMOS_3V3, true);
    selPin1.init(2, 0);

    // Data input pin models — MNA node IDs 3..6 (1-based)
    const dataPins: DigitalInputPinModel[][] = [];
    for (let i = 0; i < 4; i++) {
      const pin = new DigitalInputPinModel(CMOS_3V3, true);
      pin.init(3 + i, 0);
      dataPins.push([pin]);
    }

    // Output pin model — MNA node ID 7 (1-based)
    const outPin = new DigitalOutputPinModel(CMOS_3V3);
    outPin.init(7, -1);

    const mux = new BehavioralMuxElement([selPin0, selPin1], dataPins, [outPin], 4, 1, new Map());
    mux._pinNodes = new Map([["sel", 1], ["sel_1", 2], ["in_0", 3], ["in_1", 4], ["in_2", 5], ["in_3", 6], ["out", 7]]);

    // Voltage sources — 1-based circuit nodes
    const vsSel0 = makeVoltageSource(1, 0, vSel0);
    const vsSel1 = makeVoltageSource(2, 0, vSel1);
    const vsIn0  = makeVoltageSource(3, 0, inputVoltages[0]);
    const vsIn1  = makeVoltageSource(4, 0, inputVoltages[1]);
    const vsIn2  = makeVoltageSource(5, 0, inputVoltages[2]);
    const vsIn3  = makeVoltageSource(6, 0, inputVoltages[3]);
    const rLoad  = makeResistor(7, 0, LOAD_R);

    const elements: AnalogElement[] = [vsSel0, vsSel1, vsIn0, vsIn1, vsIn2, vsIn3, rLoad, mux];
    return { elements, matrixSize: 13, nodeCount: 7 };
  }

  it("selects_correct_input", () => {
    // selector = 2, data: in_0=LOW, in_1=LOW, in_2=HIGH, in_3=LOW
    const { elements, matrixSize, nodeCount } = buildMux4to1(2, [GND, GND, VDD, GND]);
    const result = solve(elements, matrixSize, nodeCount);

    expect(result.converged).toBe(true);
    // out at circuit node 7 (result.voltages[7] in 1-based layout)
    expect(result.voltages[7]).toBeGreaterThan(CMOS_3V3.vIH);
  });

  it("selects_low_input", () => {
    // selector = 1, data: in_0=HIGH, in_1=LOW, in_2=HIGH, in_3=HIGH
    const { elements, matrixSize, nodeCount } = buildMux4to1(1, [VDD, GND, VDD, VDD]);
    const result = solve(elements, matrixSize, nodeCount);

    expect(result.converged).toBe(true);
    expect(result.voltages[7]).toBeLessThan(CMOS_3V3.vIL);
  });

  it("all_selector_values_route_correctly", () => {
    // For each selVal, only input at selVal is HIGH — output must be HIGH
    for (let selVal = 0; selVal < 4; selVal++) {
      const inputVoltages = [GND, GND, GND, GND];
      inputVoltages[selVal] = VDD;
      const { elements, matrixSize, nodeCount } = buildMux4to1(selVal, inputVoltages);
      const result = solve(elements, matrixSize, nodeCount);

      expect(result.converged).toBe(true);
      expect(result.voltages[7]).toBeGreaterThan(CMOS_3V3.vIH);
    }
  });
});

// ---------------------------------------------------------------------------
// Demux tests
// ---------------------------------------------------------------------------

describe("Demux", () => {
  /**
   * 1:4 demux (selectorBits=2, bitWidth=1).
   *
   * Per buildDemuxPinDeclarations order: sel, out_0, out_1, out_2, out_3, in
   *
   * Solver index mapping:
   *   0 = sel bit 0  (circuit node 1)
   *   1 = sel bit 1  (circuit node 2)
   *   2 = out_0      (circuit node 3)
   *   3 = out_1      (circuit node 4)
   *   4 = out_2      (circuit node 5)
   *   5 = out_3      (circuit node 6)
   *   6 = in         (circuit node 7)
   *   7..9 = branch rows for 3 voltage sources
   *
   * matrixSize = 7 nodes + 3 branch rows = 10
   */
  function buildDemux1to4(selVal: number, inputLevel: number) {
    const vSel0 = ((selVal >> 0) & 1) === 1 ? VDD : GND;
    const vSel1 = ((selVal >> 1) & 1) === 1 ? VDD : GND;

    const selPin0 = new DigitalInputPinModel(CMOS_3V3, true);
    selPin0.init(1, 0);
    const selPin1 = new DigitalInputPinModel(CMOS_3V3, true);
    selPin1.init(2, 0);

    const outPins: DigitalOutputPinModel[] = [];
    for (let i = 0; i < 4; i++) {
      const pin = new DigitalOutputPinModel(CMOS_3V3);
      pin.init(3 + i, -1);
      outPins.push(pin);
    }

    const inPin = new DigitalInputPinModel(CMOS_3V3, true);
    inPin.init(7, 0);

    const demux = new BehavioralDemuxElement([selPin0, selPin1], inPin, outPins, 4, new Map());
    demux._pinNodes = new Map([["sel", 1], ["sel_1", 2], ["out_0", 3], ["out_1", 4], ["out_2", 5], ["out_3", 6], ["in", 7]]);

    const vsSel0 = makeVoltageSource(1, 0, vSel0);
    const vsSel1 = makeVoltageSource(2, 0, vSel1);
    const vsIn   = makeVoltageSource(7, 0, inputLevel);

    const loads: AnalogElement[] = [];
    for (let i = 0; i < 4; i++) {
      loads.push(makeResistor(3 + i, 0, LOAD_R));
    }

    const elements: AnalogElement[] = [vsSel0, vsSel1, vsIn, ...loads, demux];
    return { elements, matrixSize: 10, nodeCount: 7 };
  }

  it("routes_to_correct_output", () => {
    // selector = 3, input = HIGH → only out_3 should be HIGH
    const { elements, matrixSize, nodeCount } = buildDemux1to4(3, VDD);
    const result = solve(elements, matrixSize, nodeCount);

    expect(result.converged).toBe(true);
    // out_0..out_3 = circuit nodes 3..6 → voltages[3..6] (1-based)
    expect(result.voltages[3]).toBeLessThan(CMOS_3V3.vIL);   // out_0 LOW
    expect(result.voltages[4]).toBeLessThan(CMOS_3V3.vIL);   // out_1 LOW
    expect(result.voltages[5]).toBeLessThan(CMOS_3V3.vIL);   // out_2 LOW
    expect(result.voltages[6]).toBeGreaterThan(CMOS_3V3.vIH); // out_3 HIGH
  });

  it("all_outputs_low_when_input_low", () => {
    // selector = 2, input = LOW → all outputs LOW
    const { elements, matrixSize, nodeCount } = buildDemux1to4(2, GND);
    const result = solve(elements, matrixSize, nodeCount);

    expect(result.converged).toBe(true);
    for (let i = 0; i < 4; i++) {
      expect(result.voltages[3 + i]).toBeLessThan(CMOS_3V3.vIL); // nodes 3..6 (1-based)
    }
  });

  it("routes_each_selector_value", () => {
    for (let selVal = 0; selVal < 4; selVal++) {
      const { elements, matrixSize, nodeCount } = buildDemux1to4(selVal, VDD);
      const result = solve(elements, matrixSize, nodeCount);

      expect(result.converged).toBe(true);
      for (let i = 0; i < 4; i++) {
        const vOut = result.voltages[3 + i]; // nodes 3..6 (1-based)
        if (i === selVal) {
          expect(vOut).toBeGreaterThan(CMOS_3V3.vIH);
        } else {
          expect(vOut).toBeLessThan(CMOS_3V3.vIL);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Decoder tests
// ---------------------------------------------------------------------------

describe("Decoder", () => {
  /**
   * 2-bit decoder (selectorBits=2, 4 one-hot outputs).
   *
   * Per buildDecoderPinDeclarations: sel (2-bit), out_0, out_1, out_2, out_3
   *
   * Circuit node mapping (1-based, slot 0 = ground sentinel):
   *   node 1 = sel bit 0    → voltages[1]
   *   node 2 = sel bit 1    → voltages[2]
   *   node 3 = out_0        → voltages[3]
   *   node 4 = out_1        → voltages[4]
   *   node 5 = out_2        → voltages[5]
   *   node 6 = out_3        → voltages[6]
   *   branch rows 7..8 for 2 voltage sources (matrixSize = 8)
   */
  function buildDecoder2bit(selVal: number) {
    const vSel0 = ((selVal >> 0) & 1) === 1 ? VDD : GND;
    const vSel1 = ((selVal >> 1) & 1) === 1 ? VDD : GND;

    const selPin0 = new DigitalInputPinModel(CMOS_3V3, true);
    selPin0.init(1, 0);
    const selPin1 = new DigitalInputPinModel(CMOS_3V3, true);
    selPin1.init(2, 0);

    const outPins: DigitalOutputPinModel[] = [];
    for (let i = 0; i < 4; i++) {
      const pin = new DigitalOutputPinModel(CMOS_3V3);
      pin.init(3 + i, -1);
      outPins.push(pin);
    }

    const decoder = new BehavioralDecoderElement([selPin0, selPin1], outPins, 4, new Map());
    decoder._pinNodes = new Map([["sel", 1], ["sel_1", 2], ["out_0", 3], ["out_1", 4], ["out_2", 5], ["out_3", 6]]);

    const vsSel0 = makeVoltageSource(1, 0, vSel0);
    const vsSel1 = makeVoltageSource(2, 0, vSel1);

    const loads: AnalogElement[] = [];
    for (let i = 0; i < 4; i++) {
      loads.push(makeResistor(3 + i, 0, LOAD_R));
    }

    const elements: AnalogElement[] = [vsSel0, vsSel1, ...loads, decoder];
    return { elements, matrixSize: 8, nodeCount: 6 };
  }

  it("one_hot_output", () => {
    // 2-bit decoder, input=01 (selVal=1) → out_1 = V_OH, all others = V_OL
    const { elements, matrixSize, nodeCount } = buildDecoder2bit(1);
    const result = solve(elements, matrixSize, nodeCount);

    expect(result.converged).toBe(true);
    expect(result.voltages[3]).toBeLessThan(CMOS_3V3.vIL);   // out_0 LOW  (node 3)
    expect(result.voltages[4]).toBeGreaterThan(CMOS_3V3.vIH); // out_1 HIGH (node 4)
    expect(result.voltages[5]).toBeLessThan(CMOS_3V3.vIL);   // out_2 LOW  (node 5)
    expect(result.voltages[6]).toBeLessThan(CMOS_3V3.vIL);   // out_3 LOW  (node 6)
  });

  it("all_selector_values_produce_one_hot", () => {
    for (let selVal = 0; selVal < 4; selVal++) {
      const { elements, matrixSize, nodeCount } = buildDecoder2bit(selVal);
      const result = solve(elements, matrixSize, nodeCount);

      expect(result.converged).toBe(true);
      for (let i = 0; i < 4; i++) {
        const vOut = result.voltages[3 + i]; // nodes 3..6 (1-based)
        if (i === selVal) {
          expect(vOut).toBeGreaterThan(CMOS_3V3.vIH);
        } else {
          expect(vOut).toBeLessThan(CMOS_3V3.vIL);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Registration tests
// ---------------------------------------------------------------------------

describe("Registration", () => {
  it("mux_has_analog_factory", () => {
    expect(MuxDefinition.models?.digital).not.toBeUndefined();
    expect(typeof (MuxDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBe("function");
  });

  it("demux_has_analog_factory", () => {
    expect(DemuxDefinition.models?.digital).not.toBeUndefined();
    expect(typeof (DemuxDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBe("function");
  });

  it("decoder_has_analog_factory", () => {
    expect(DecoderDefinition.models?.digital).not.toBeUndefined();
    expect(typeof (DecoderDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBe("function");
  });

  it("factory_produces_element_with_pin_nodes", () => {
    const props = new PropertyBag([]);
    // 2:1 mux (selectorBits=1): pins "sel", "in_0", "in_1", "out"
    const factory = makeBehavioralMuxAnalogFactory(1);
    const element = factory(new Map([["sel", 1], ["in_0", 2], ["in_1", 3], ["out", 4]]), props, () => 0);
    expect(element._pinNodes.size).toBe(4);
  });

  it("demux_factory_produces_element_with_pin_nodes", () => {
    const props = new PropertyBag([]);
    // 1:2 demux (selectorBits=1): pins "sel", "out_0", "out_1", "in"
    const factory = makeBehavioralDemuxAnalogFactory(1);
    const element = factory(new Map([["sel", 1], ["out_0", 2], ["out_1", 3], ["in", 4]]), props, () => 0);
    expect(element._pinNodes.size).toBe(4);
  });

  it("decoder_factory_produces_element_with_pin_nodes", () => {
    const props = new PropertyBag([]);
    // 1-bit decoder (selectorBits=1): pins "sel", "out_0", "out_1"
    const factory = makeBehavioralDecoderAnalogFactory(1);
    const element = factory(new Map([["sel", 1], ["out_0", 2], ["out_1", 3]]), props, () => 0);
    expect(element._pinNodes.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Task 6.4.3 — combinational_pin_loading_propagates
// ---------------------------------------------------------------------------

describe("Task 6.4.3 — combinational pin loading propagates", () => {
  it("combinational_pin_loading_propagates", () => {
    // 2:1 mux (selectorBits=1): sel=1, in_0=2, in_1=3, out=4.
    // Set _pinLoading so that "sel" is loaded=true and "in_0" is loaded=false.
    // Verify via allocElement spy: sel (MNA node 1 → nodeIdx 0) should produce
    // an allocElement call at (0,0); in_0 (MNA node 2 → nodeIdx 1) should not.
    const pinLoading: Record<string, boolean> = {
      "sel": true,
      "in_0": false,
      "in_1": false,
      "out": false,
    };
    const props = new PropertyBag([]);
    props.set("_pinLoading", pinLoading as unknown as import("../../../core/properties.js").PropertyValue);

    const factory = makeBehavioralMuxAnalogFactory(1);
    const element = factory(new Map([["sel", 1], ["in_0", 2], ["in_1", 3], ["out", 4]]), props, () => 0);
    initElement(element);

    const allocCalls: Array<[number, number]> = [];
    const solver = {
      allocElement(r: number, c: number) { allocCalls.push([r, c]); return allocCalls.length - 1; },
      stampElement(_h: number, _v: number) {},
    };

    const ctx: LoadContext = makeLoadCtx({
      solver: solver as any,
      cktMode: MODETRAN | MODEINITFLOAT,
      dt: 0,
      method: "trapezoidal" as const,
      order: 1,
    });

    element.load(ctx);

    // sel (nodeIdx=0) should appear in allocCalls (loaded=true → stamps 1/rIn)
    const selDiag = allocCalls.some(([r, c]) => r === 0 && c === 0);
    // in_0 (nodeIdx=1) should NOT appear (loaded=false → no-op)
    const in0Diag = allocCalls.some(([r, c]) => r === 1 && c === 1);

    expect(selDiag).toBe(true);
    expect(in0Diag).toBe(false);
  });
});
