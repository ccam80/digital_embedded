/**
 * Tests for behavioral analog factories for combinational digital components:
 * multiplexer, demultiplexer, and decoder.
 *
 * Migration shape M1- per Test 1.28 contract (Entry 1- combinational
 * pin-loading test). Every test acquires its engine via
 * `ComparisonSession.createSelfCompare({ buildCircuit, analysis })`. Inputs
 * are driven by `DcVoltageSource` instances; outputs are loaded by
 * `Resistor` to ground. Pin loading is configured exclusively via
 * `circuit.metadata.digitalPinLoadingOverrides` (Decision #10). Pin-loading
 * assertions assert observable voltage sag (Decision #11).
 *
 * The behavioural Mux / Demux / Decoder analog factories are exercised by
 * setting `model: "behavioral"` on the component spec.
 */

import { describe, it, expect } from "vitest";
import { ComparisonSession } from "./harness/comparison-session.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { ComponentRegistry } from "../../../core/registry.js";
import type { Circuit } from "../../../core/circuit.js";
import type { AnalogFactory } from "../../../core/registry.js";
import { PropertyBag } from "../../../core/properties.js";
import {
  makeBehavioralMuxAnalogFactory,
  makeBehavioralDemuxAnalogFactory,
  makeBehavioralDecoderAnalogFactory,
} from "../behavioral-combinational.js";
import { MuxDefinition } from "../../../components/wiring/mux.js";
import { DemuxDefinition } from "../../../components/wiring/demux.js";
import { DecoderDefinition } from "../../../components/wiring/decoder.js";

// ---------------------------------------------------------------------------
// Threshold constants
// ---------------------------------------------------------------------------

// Default CMOS_3V3 family thresholds- match the registered pin-electrical
// defaults used by the behavioural mux/demux/decoder factories.
const VDD = 3.3;
const GND = 0.0;
const V_IH = 2.0;
const V_IL = 0.8;
const LOAD_R = 10_000; // 10 kohm output load

// ---------------------------------------------------------------------------
// Mux tests
// ---------------------------------------------------------------------------

describe("Mux", () => {
  /**
   * 4:1 mux (selectorBits=2, bitWidth=1).
   *
   * Selector bits are driven by ideal DC voltage sources at 0V or 3.3V.
   * Each data input is driven by an ideal DC voltage source. The mux output
   * has a 10 kohm load to ground. The mux runs as the analog `behavioral`
   * model (analog factory).
   */
  function buildMux4to1(selVal: number, inputVoltages: number[]) {
    return (registry: ComponentRegistry): Circuit => {
      const facade = new DefaultSimulatorFacade(registry);
      const vSel0 = ((selVal >> 0) & 1) === 1 ? VDD : GND;
      const vSel1 = ((selVal >> 1) & 1) === 1 ? VDD : GND;
      return facade.build({
        components: [
          { id: "vsSel0", type: "DcVoltageSource", props: { label: "vsSel0", voltage: vSel0 } },
          { id: "vsSel1", type: "DcVoltageSource", props: { label: "vsSel1", voltage: vSel1 } },
          { id: "vsIn0",  type: "DcVoltageSource", props: { label: "vsIn0",  voltage: inputVoltages[0] } },
          { id: "vsIn1",  type: "DcVoltageSource", props: { label: "vsIn1",  voltage: inputVoltages[1] } },
          { id: "vsIn2",  type: "DcVoltageSource", props: { label: "vsIn2",  voltage: inputVoltages[2] } },
          { id: "vsIn3",  type: "DcVoltageSource", props: { label: "vsIn3",  voltage: inputVoltages[3] } },
          { id: "mux",    type: "Multiplexer",    props: { label: "mux", model: "behavioral", selectorBits: 2 } },
          { id: "rLoad",  type: "Resistor",        props: { label: "rLoad", resistance: LOAD_R } },
          { id: "gnd",    type: "Ground" },
        ],
        connections: [
          ["vsSel0:pos", "mux:sel"],
          ["vsSel1:pos", "mux:sel_1"],
          ["vsIn0:pos",  "mux:in_0"],
          ["vsIn1:pos",  "mux:in_1"],
          ["vsIn2:pos",  "mux:in_2"],
          ["vsIn3:pos",  "mux:in_3"],
          ["mux:out",    "rLoad:A"],
          ["rLoad:B",    "gnd:out"],
          ["vsSel0:neg", "gnd:out"],
          ["vsSel1:neg", "gnd:out"],
          ["vsIn0:neg",  "gnd:out"],
          ["vsIn1:neg",  "gnd:out"],
          ["vsIn2:neg",  "gnd:out"],
          ["vsIn3:neg",  "gnd:out"],
        ],
      });
    };
  }

  it("selects_correct_input", async () => {
    // selector = 2, data: in_0=LOW, in_1=LOW, in_2=HIGH, in_3=LOW
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: buildMux4to1(2, [GND, GND, VDD, GND]),
      analysis: "dcop",
    });
    const stepEnd = session.getStepEnd(0);
    const vOut = stepEnd.nodes["mux:out"].ours!;
    expect(vOut).toBeGreaterThan(V_IH);
  });

  it("selects_low_input", async () => {
    // selector = 1, data: in_0=HIGH, in_1=LOW, in_2=HIGH, in_3=HIGH
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: buildMux4to1(1, [VDD, GND, VDD, VDD]),
      analysis: "dcop",
    });
    const stepEnd = session.getStepEnd(0);
    const vOut = stepEnd.nodes["mux:out"].ours!;
    expect(vOut).toBeLessThan(V_IL);
  });

  it("all_selector_values_route_correctly", async () => {
    // For each selVal, only input at selVal is HIGH; output must be HIGH.
    for (let selVal = 0; selVal < 4; selVal++) {
      const inputVoltages = [GND, GND, GND, GND];
      inputVoltages[selVal] = VDD;
      const session = await ComparisonSession.createSelfCompare({
        buildCircuit: buildMux4to1(selVal, inputVoltages),
        analysis: "dcop",
      });
      const stepEnd = session.getStepEnd(0);
      const vOut = stepEnd.nodes["mux:out"].ours!;
      expect(vOut).toBeGreaterThan(V_IH);
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
   * Each output node is loaded with 10 kohm to ground. The selected
   * output reaches V_OH; the others stay at V_OL.
   */
  function buildDemux1to4(selVal: number, inputLevel: number) {
    return (registry: ComponentRegistry): Circuit => {
      const facade = new DefaultSimulatorFacade(registry);
      const vSel0 = ((selVal >> 0) & 1) === 1 ? VDD : GND;
      const vSel1 = ((selVal >> 1) & 1) === 1 ? VDD : GND;
      return facade.build({
        components: [
          { id: "vsSel0", type: "DcVoltageSource", props: { label: "vsSel0", voltage: vSel0 } },
          { id: "vsSel1", type: "DcVoltageSource", props: { label: "vsSel1", voltage: vSel1 } },
          { id: "vsIn",   type: "DcVoltageSource", props: { label: "vsIn",   voltage: inputLevel } },
          { id: "demux",  type: "Demultiplexer",   props: { label: "demux", model: "behavioral", selectorBits: 2 } },
          { id: "r0",     type: "Resistor",         props: { label: "r0", resistance: LOAD_R } },
          { id: "r1",     type: "Resistor",         props: { label: "r1", resistance: LOAD_R } },
          { id: "r2",     type: "Resistor",         props: { label: "r2", resistance: LOAD_R } },
          { id: "r3",     type: "Resistor",         props: { label: "r3", resistance: LOAD_R } },
          { id: "gnd",    type: "Ground" },
        ],
        connections: [
          ["vsSel0:pos", "demux:sel"],
          ["vsSel1:pos", "demux:sel_1"],
          ["vsIn:pos",   "demux:in"],
          ["demux:out_0", "r0:A"],
          ["demux:out_1", "r1:A"],
          ["demux:out_2", "r2:A"],
          ["demux:out_3", "r3:A"],
          ["r0:B", "gnd:out"],
          ["r1:B", "gnd:out"],
          ["r2:B", "gnd:out"],
          ["r3:B", "gnd:out"],
          ["vsSel0:neg", "gnd:out"],
          ["vsSel1:neg", "gnd:out"],
          ["vsIn:neg",   "gnd:out"],
        ],
      });
    };
  }

  it("routes_to_correct_output", async () => {
    // selector = 3, input = HIGH; only out_3 should be HIGH.
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: buildDemux1to4(3, VDD),
      analysis: "dcop",
    });
    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.nodes["demux:out_0"].ours!).toBeLessThan(V_IL);
    expect(stepEnd.nodes["demux:out_1"].ours!).toBeLessThan(V_IL);
    expect(stepEnd.nodes["demux:out_2"].ours!).toBeLessThan(V_IL);
    expect(stepEnd.nodes["demux:out_3"].ours!).toBeGreaterThan(V_IH);
  });

  it("all_outputs_low_when_input_low", async () => {
    // selector = 2, input = LOW; all outputs LOW.
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: buildDemux1to4(2, GND),
      analysis: "dcop",
    });
    const stepEnd = session.getStepEnd(0);
    for (let i = 0; i < 4; i++) {
      expect(stepEnd.nodes[`demux:out_${i}`].ours!).toBeLessThan(V_IL);
    }
  });

  it("routes_each_selector_value", async () => {
    for (let selVal = 0; selVal < 4; selVal++) {
      const session = await ComparisonSession.createSelfCompare({
        buildCircuit: buildDemux1to4(selVal, VDD),
        analysis: "dcop",
      });
      const stepEnd = session.getStepEnd(0);
      for (let i = 0; i < 4; i++) {
        const vOut = stepEnd.nodes[`demux:out_${i}`].ours!;
        if (i === selVal) {
          expect(vOut).toBeGreaterThan(V_IH);
        } else {
          expect(vOut).toBeLessThan(V_IL);
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
   */
  function buildDecoder2bit(selVal: number) {
    return (registry: ComponentRegistry): Circuit => {
      const facade = new DefaultSimulatorFacade(registry);
      const vSel0 = ((selVal >> 0) & 1) === 1 ? VDD : GND;
      const vSel1 = ((selVal >> 1) & 1) === 1 ? VDD : GND;
      return facade.build({
        components: [
          { id: "vsSel0", type: "DcVoltageSource", props: { label: "vsSel0", voltage: vSel0 } },
          { id: "vsSel1", type: "DcVoltageSource", props: { label: "vsSel1", voltage: vSel1 } },
          { id: "decoder", type: "Decoder", props: { label: "decoder", model: "behavioral", selectorBits: 2 } },
          { id: "r0", type: "Resistor", props: { label: "r0", resistance: LOAD_R } },
          { id: "r1", type: "Resistor", props: { label: "r1", resistance: LOAD_R } },
          { id: "r2", type: "Resistor", props: { label: "r2", resistance: LOAD_R } },
          { id: "r3", type: "Resistor", props: { label: "r3", resistance: LOAD_R } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vsSel0:pos", "decoder:sel"],
          ["vsSel1:pos", "decoder:sel_1"],
          ["decoder:out_0", "r0:A"],
          ["decoder:out_1", "r1:A"],
          ["decoder:out_2", "r2:A"],
          ["decoder:out_3", "r3:A"],
          ["r0:B", "gnd:out"],
          ["r1:B", "gnd:out"],
          ["r2:B", "gnd:out"],
          ["r3:B", "gnd:out"],
          ["vsSel0:neg", "gnd:out"],
          ["vsSel1:neg", "gnd:out"],
        ],
      });
    };
  }

  it("one_hot_output", async () => {
    // 2-bit decoder, input=01 (selVal=1); only out_1 = V_OH.
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: buildDecoder2bit(1),
      analysis: "dcop",
    });
    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.nodes["decoder:out_0"].ours!).toBeLessThan(V_IL);
    expect(stepEnd.nodes["decoder:out_1"].ours!).toBeGreaterThan(V_IH);
    expect(stepEnd.nodes["decoder:out_2"].ours!).toBeLessThan(V_IL);
    expect(stepEnd.nodes["decoder:out_3"].ours!).toBeLessThan(V_IL);
  });

  it("all_selector_values_produce_one_hot", async () => {
    for (let selVal = 0; selVal < 4; selVal++) {
      const session = await ComparisonSession.createSelfCompare({
        buildCircuit: buildDecoder2bit(selVal),
        analysis: "dcop",
      });
      const stepEnd = session.getStepEnd(0);
      for (let i = 0; i < 4; i++) {
        const vOut = stepEnd.nodes[`decoder:out_${i}`].ours!;
        if (i === selVal) {
          expect(vOut).toBeGreaterThan(V_IH);
        } else {
          expect(vOut).toBeLessThan(V_IL);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Registration tests- factory presence and shape on registered definitions
// ---------------------------------------------------------------------------

describe("Registration", () => {
  it("mux_has_analog_factory", () => {
    expect(MuxDefinition.models?.digital).not.toBeUndefined();
    expect(typeof (MuxDefinition.modelRegistry?.behavioral as { kind: "inline"; factory: AnalogFactory } | undefined)?.factory).toBe("function");
  });

  it("demux_has_analog_factory", () => {
    expect(DemuxDefinition.models?.digital).not.toBeUndefined();
    expect(typeof (DemuxDefinition.modelRegistry?.behavioral as { kind: "inline"; factory: AnalogFactory } | undefined)?.factory).toBe("function");
  });

  it("decoder_has_analog_factory", () => {
    expect(DecoderDefinition.models?.digital).not.toBeUndefined();
    expect(typeof (DecoderDefinition.modelRegistry?.behavioral as { kind: "inline"; factory: AnalogFactory } | undefined)?.factory).toBe("function");
  });

  it("factory_produces_element_with_pin_nodes", () => {
    const props = new PropertyBag([]);
    // 2:1 mux (selectorBits=1): pins "sel", "in_0", "in_1", "out".
    const factory = makeBehavioralMuxAnalogFactory(1);
    const element = factory(new Map([["sel", 1], ["in_0", 2], ["in_1", 3], ["out", 4]]), props, () => 0);
    expect(element._pinNodes.size).toBe(4);
  });

  it("demux_factory_produces_element_with_pin_nodes", () => {
    const props = new PropertyBag([]);
    // 1:2 demux (selectorBits=1): pins "sel", "out_0", "out_1", "in".
    const factory = makeBehavioralDemuxAnalogFactory(1);
    const element = factory(new Map([["sel", 1], ["out_0", 2], ["out_1", 3], ["in", 4]]), props, () => 0);
    expect(element._pinNodes.size).toBe(4);
  });

  it("decoder_factory_produces_element_with_pin_nodes", () => {
    const props = new PropertyBag([]);
    // 1-bit decoder (selectorBits=1): pins "sel", "out_0", "out_1".
    const factory = makeBehavioralDecoderAnalogFactory(1);
    const element = factory(new Map([["sel", 1], ["out_0", 2], ["out_1", 3]]), props, () => 0);
    expect(element._pinNodes.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Task 6.4.3- combinational_pin_loading_propagates
//
// Pin loading is configured via `circuit.metadata.digitalPinLoadingOverrides`
// keyed by net (Decision #10). The assertion is observable voltage sag (UC-5):
// a non-ideal source drives a net through a 10 kohm series resistor; with
// `rIn = 100 kohm` on a loaded pin, `vNet = 5 * 100k/(10k + 100k) = 4.5454V`.
// An unloaded pin sees `vNet = 5.0V` exactly.
// ---------------------------------------------------------------------------

describe("Task 6.4.3- combinational pin loading propagates", () => {
  it("combinational_pin_loading_propagates", async () => {
    // 2:1 mux (selectorBits=1) driven by:
    //   - "sel" via 5V source through 10 kohm (loaded -> sag to 4.5454V)
    //   - "in_0" via 5V source through 10 kohm (ideal -> stays at 5.0V)
    // The mux uses the `behavioral` analog model, which honours the
    // pin-loading overrides resolved at compile time.
    //
    // Pin "rIn" defaults to 100 kohm in the CMOS_3V3 family; sag formula:
    //   vNet = 5 * 100k / (10k + 100k) = 4.545454545454...V
    const buildCircuit = (registry: ComponentRegistry): Circuit => {
      const facade = new DefaultSimulatorFacade(registry);
      const c = facade.build({
        components: [
          { id: "vsSel",  type: "DcVoltageSource", props: { label: "vsSel",  voltage: 5 } },
          { id: "vsIn0",  type: "DcVoltageSource", props: { label: "vsIn0",  voltage: 5 } },
          { id: "vsIn1",  type: "DcVoltageSource", props: { label: "vsIn1",  voltage: 0 } },
          { id: "rsrcSel", type: "Resistor",       props: { label: "rsrcSel", resistance: 10_000 } },
          { id: "rsrcIn0", type: "Resistor",       props: { label: "rsrcIn0", resistance: 10_000 } },
          { id: "mux",    type: "Multiplexer",    props: { label: "mux", model: "behavioral", selectorBits: 1 } },
          { id: "rLoad",  type: "Resistor",        props: { label: "rLoad", resistance: LOAD_R } },
          { id: "gnd",    type: "Ground" },
        ],
        connections: [
          ["vsSel:pos",   "rsrcSel:A"],
          ["rsrcSel:B",   "mux:sel"],
          ["vsIn0:pos",   "rsrcIn0:A"],
          ["rsrcIn0:B",   "mux:in_0"],
          ["vsIn1:pos",   "mux:in_1"],
          ["mux:out",     "rLoad:A"],
          ["rLoad:B",     "gnd:out"],
          ["vsSel:neg",   "gnd:out"],
          ["vsIn0:neg",   "gnd:out"],
          ["vsIn1:neg",   "gnd:out"],
        ],
      });
      // Override pin-loading per net (Decision #10):
      //   sel net (anchored on mux:sel) -> loaded
      //   in_0 net (anchored on mux:in_0) -> ideal
      c.metadata.digitalPinLoadingOverrides = [
        { anchor: { type: "pin", instanceId: "mux", pinLabel: "sel" }, loading: "loaded" },
        { anchor: { type: "pin", instanceId: "mux", pinLabel: "in_0" }, loading: "ideal" },
      ];
      return c;
    };

    const session = await ComparisonSession.createSelfCompare({
      buildCircuit,
      analysis: "dcop",
    });
    const stepEnd = session.getStepEnd(0);

    // sel net is loaded: voltage divider 5 * 100k / (10k+100k) = 4.5454...V
    const vSel = stepEnd.nodes["mux:sel"].ours!;
    expect(vSel).toBeCloseTo(4.5454545454545454, 9);

    // in_0 net is ideal: full 5.0V (no input loading)
    const vIn0 = stepEnd.nodes["mux:in_0"].ours!;
    expect(vIn0).toBeCloseTo(5.0, 9);
  });
});
