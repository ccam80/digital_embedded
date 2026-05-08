/**
 * Tests for behavioral analog factories for combinational digital components:
 * multiplexer, demultiplexer, and decoder.
 *
 * All tests use selectorBits=1 (single `sel` pin, two inputs/outputs). The
 * multi-bit `sel` bus (selectorBits>1) is a digital-path feature; the analog
 * behavioral model receives one node per physical pin at the component boundary.
 * selectorBits=1 is sufficient to exercise all behavioral paths (sel=0 routes
 * in_0/out_0, sel=1 routes in_1/out_1).
 *
 * Output voltages are read from the load resistor's positive terminal (e.g.
 * "rLoad:pos", "r0:pos") because the node-label map uses the first pin that
 * connects to each node; the resistor pins are that first connection in the
 * build order used below.
 *
 * Inputs are driven by `DcVoltageSource` instances; outputs are loaded by
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
   * 2:1 mux (selectorBits=1, bitWidth=1).
   *
   * Selector bit is driven by an ideal DC voltage source at 0V or 3.3V on the
   * single `sel` pin. Each data input is driven by an ideal DC voltage source.
   * The mux output has a 10 kohm load to ground. The mux runs as the analog
   * `behavioral` model (analog factory).
   *
   * Output voltage is read from "rLoad:pos" (the shared net between the mux
   * output sub-element and the load resistor).
   */
  function buildMux2to1(selVal: number, inputVoltages: [number, number]) {
    return (registry: ComponentRegistry): Circuit => {
      const facade = new DefaultSimulatorFacade(registry);
      const vSel = selVal === 1 ? VDD : GND;
      return facade.build({
        components: [
          { id: "vsSel", type: "DcVoltageSource", props: { label: "vsSel", voltage: vSel } },
          { id: "vsIn0", type: "DcVoltageSource", props: { label: "vsIn0", voltage: inputVoltages[0] } },
          { id: "vsIn1", type: "DcVoltageSource", props: { label: "vsIn1", voltage: inputVoltages[1] } },
          { id: "mux",   type: "Multiplexer",     props: { label: "mux", model: "behavioral", selectorBits: 1 } },
          { id: "rLoad", type: "Resistor",         props: { label: "rLoad", resistance: LOAD_R } },
          { id: "gnd",   type: "Ground" },
        ],
        connections: [
          ["vsSel:pos",  "mux:sel"],
          ["vsIn0:pos",  "mux:in_0"],
          ["vsIn1:pos",  "mux:in_1"],
          ["mux:out",    "rLoad:pos"],
          ["rLoad:neg",  "gnd:out"],
          ["vsSel:neg",  "gnd:out"],
          ["vsIn0:neg",  "gnd:out"],
          ["vsIn1:neg",  "gnd:out"],
        ],
      });
    };
  }

  it("selects_correct_input", async () => {
    // selector = 1, data: in_0=LOW, in_1=HIGH
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: buildMux2to1(1, [GND, VDD]),
      analysis: "dcop",
    });
    const stepEnd = session.getStepEnd(0);
    const vOut = stepEnd.nodes["rLoad:pos"].ours!;
    expect(vOut).toBeGreaterThan(V_IH);
  });

  it("selects_low_input", async () => {
    // selector = 1, data: in_0=HIGH, in_1=LOW
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: buildMux2to1(1, [VDD, GND]),
      analysis: "dcop",
    });
    const stepEnd = session.getStepEnd(0);
    const vOut = stepEnd.nodes["rLoad:pos"].ours!;
    expect(vOut).toBeLessThan(V_IL);
  });

  it("all_selector_values_route_correctly", async () => {
    // For each selVal (0 and 1), only input at selVal is HIGH; output must be HIGH.
    for (let selVal = 0; selVal < 2; selVal++) {
      const inputVoltages: [number, number] = [GND, GND];
      inputVoltages[selVal] = VDD;
      const session = await ComparisonSession.createSelfCompare({
        buildCircuit: buildMux2to1(selVal, inputVoltages),
        analysis: "dcop",
      });
      const stepEnd = session.getStepEnd(0);
      const vOut = stepEnd.nodes["rLoad:pos"].ours!;
      expect(vOut).toBeGreaterThan(V_IH);
    }
  });
});

// ---------------------------------------------------------------------------
// Demux tests
// ---------------------------------------------------------------------------

describe("Demux", () => {
  /**
   * 1:2 demux (selectorBits=1, bitWidth=1).
   *
   * Each output node is loaded with 10 kohm to ground. The selected
   * output reaches V_OH; the other stays at V_OL.
   *
   * Output voltages are read from "r0:pos" and "r1:pos" (load resistors).
   */
  function buildDemux1to2(selVal: number, inputLevel: number) {
    return (registry: ComponentRegistry): Circuit => {
      const facade = new DefaultSimulatorFacade(registry);
      const vSel = selVal === 1 ? VDD : GND;
      return facade.build({
        components: [
          { id: "vsSel", type: "DcVoltageSource", props: { label: "vsSel", voltage: vSel } },
          { id: "vsIn",  type: "DcVoltageSource", props: { label: "vsIn",  voltage: inputLevel } },
          { id: "demux", type: "Demultiplexer",   props: { label: "demux", model: "behavioral", selectorBits: 1 } },
          { id: "r0",    type: "Resistor",         props: { label: "r0", resistance: LOAD_R } },
          { id: "r1",    type: "Resistor",         props: { label: "r1", resistance: LOAD_R } },
          { id: "gnd",   type: "Ground" },
        ],
        connections: [
          ["vsSel:pos",   "demux:sel"],
          ["vsIn:pos",    "demux:in"],
          ["demux:out_0", "r0:pos"],
          ["demux:out_1", "r1:pos"],
          ["r0:neg",      "gnd:out"],
          ["r1:neg",      "gnd:out"],
          ["vsSel:neg",   "gnd:out"],
          ["vsIn:neg",    "gnd:out"],
        ],
      });
    };
  }

  it("routes_to_correct_output", async () => {
    // selector = 1, input = HIGH; only out_1 should be HIGH.
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: buildDemux1to2(1, VDD),
      analysis: "dcop",
    });
    const stepEnd = session.getStepEnd(0);
    // Node labels are compound: first pin on the net / second pin on the net.
    expect(stepEnd.nodes["r0:pos/demux:out_0"].ours!).toBeLessThan(V_IL);
    expect(stepEnd.nodes["r1:pos/demux:out_1"].ours!).toBeGreaterThan(V_IH);
  });

  it("all_outputs_low_when_input_low", async () => {
    // selector = 0, input = LOW; all outputs LOW.
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: buildDemux1to2(0, GND),
      analysis: "dcop",
    });
    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.nodes["r0:pos/demux:out_0"].ours!).toBeLessThan(V_IL);
    expect(stepEnd.nodes["r1:pos/demux:out_1"].ours!).toBeLessThan(V_IL);
  });

  it("routes_each_selector_value", async () => {
    for (let selVal = 0; selVal < 2; selVal++) {
      const session = await ComparisonSession.createSelfCompare({
        buildCircuit: buildDemux1to2(selVal, VDD),
        analysis: "dcop",
      });
      const stepEnd = session.getStepEnd(0);
      const vOut0 = stepEnd.nodes["r0:pos/demux:out_0"].ours!;
      const vOut1 = stepEnd.nodes["r1:pos/demux:out_1"].ours!;
      if (selVal === 0) {
        expect(vOut0).toBeGreaterThan(V_IH);
        expect(vOut1).toBeLessThan(V_IL);
      } else {
        expect(vOut0).toBeLessThan(V_IL);
        expect(vOut1).toBeGreaterThan(V_IH);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Decoder tests
// ---------------------------------------------------------------------------

describe("Decoder", () => {
  /**
   * 1-bit decoder (selectorBits=1, 2 one-hot outputs).
   *
   * Output voltages are read from "r0:pos" and "r1:pos" (load resistors).
   */
  function buildDecoder1bit(selVal: number) {
    return (registry: ComponentRegistry): Circuit => {
      const facade = new DefaultSimulatorFacade(registry);
      const vSel = selVal === 1 ? VDD : GND;
      return facade.build({
        components: [
          { id: "vsSel",   type: "DcVoltageSource", props: { label: "vsSel",   voltage: vSel } },
          { id: "decoder", type: "Decoder",          props: { label: "decoder", model: "behavioral", selectorBits: 1 } },
          { id: "r0",      type: "Resistor",          props: { label: "r0", resistance: LOAD_R } },
          { id: "r1",      type: "Resistor",          props: { label: "r1", resistance: LOAD_R } },
          { id: "gnd",     type: "Ground" },
        ],
        connections: [
          ["vsSel:pos",     "decoder:sel"],
          ["decoder:out_0", "r0:pos"],
          ["decoder:out_1", "r1:pos"],
          ["r0:neg",        "gnd:out"],
          ["r1:neg",        "gnd:out"],
          ["vsSel:neg",     "gnd:out"],
        ],
      });
    };
  }

  it("one_hot_output", async () => {
    // 1-bit decoder, input=1; only out_1 = V_OH.
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: buildDecoder1bit(1),
      analysis: "dcop",
    });
    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.nodes["r0:pos"].ours!).toBeLessThan(V_IL);
    expect(stepEnd.nodes["r1:pos"].ours!).toBeGreaterThan(V_IH);
  });

  it("all_selector_values_produce_one_hot", async () => {
    for (let selVal = 0; selVal < 2; selVal++) {
      const session = await ComparisonSession.createSelfCompare({
        buildCircuit: buildDecoder1bit(selVal),
        analysis: "dcop",
      });
      const stepEnd = session.getStepEnd(0);
      const vOut0 = stepEnd.nodes["r0:pos"].ours!;
      const vOut1 = stepEnd.nodes["r1:pos"].ours!;
      if (selVal === 0) {
        expect(vOut0).toBeGreaterThan(V_IH);
        expect(vOut1).toBeLessThan(V_IL);
      } else {
        expect(vOut0).toBeLessThan(V_IL);
        expect(vOut1).toBeGreaterThan(V_IH);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Registration tests- model presence on registered definitions
//
// The behavioral model for mux/demux/decoder uses kind:"netlist" (a function-
// form netlist builder), not kind:"inline". The contract test asserts that the
// behavioral model entry exists and its netlist builder is a function.
// ---------------------------------------------------------------------------


describe("Registration", () => {
  it("mux_has_behavioral_netlist_model", () => {
    expect(MuxDefinition.models?.digital).not.toBeUndefined();
    const entry = MuxDefinition.modelRegistry?.behavioral;
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe("netlist");
    expect(typeof (entry as { kind: "netlist"; netlist: unknown }).netlist).toBe("function");
  });

  it("demux_has_behavioral_netlist_model", () => {
    expect(DemuxDefinition.models?.digital).not.toBeUndefined();
    const entry = DemuxDefinition.modelRegistry?.behavioral;
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe("netlist");
    expect(typeof (entry as { kind: "netlist"; netlist: unknown }).netlist).toBe("function");
  });

  it("decoder_has_behavioral_netlist_model", () => {
    expect(DecoderDefinition.models?.digital).not.toBeUndefined();
    const entry = DecoderDefinition.modelRegistry?.behavioral;
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe("netlist");
    expect(typeof (entry as { kind: "netlist"; netlist: unknown }).netlist).toBe("function");
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
    //
    // Node labels: the node-label map uses "elLabel:pinLabel" from the first
    // element pin that connects to each net. The sel net is read at
    // "rsrcSel:neg" and the in_0 net at "rsrcIn0:neg" (the series resistors'
    // negative terminals share the net with the mux input pins).
    const buildCircuit = (registry: ComponentRegistry): Circuit => {
      const facade = new DefaultSimulatorFacade(registry);
      const c = facade.build({
        components: [
          { id: "vsSel",   type: "DcVoltageSource", props: { label: "vsSel",   voltage: 5 } },
          { id: "vsIn0",   type: "DcVoltageSource", props: { label: "vsIn0",   voltage: 5 } },
          { id: "vsIn1",   type: "DcVoltageSource", props: { label: "vsIn1",   voltage: 0 } },
          { id: "rsrcSel", type: "Resistor",        props: { label: "rsrcSel", resistance: 10_000 } },
          { id: "rsrcIn0", type: "Resistor",        props: { label: "rsrcIn0", resistance: 10_000 } },
          { id: "mux",     type: "Multiplexer",     props: { label: "mux", model: "behavioral", selectorBits: 1 } },
          { id: "rLoad",   type: "Resistor",        props: { label: "rLoad", resistance: LOAD_R } },
          { id: "gnd",     type: "Ground" },
        ],
        connections: [
          ["vsSel:pos",   "rsrcSel:pos"],
          ["rsrcSel:neg", "mux:sel"],
          ["vsIn0:pos",   "rsrcIn0:pos"],
          ["rsrcIn0:neg", "mux:in_0"],
          ["vsIn1:pos",   "mux:in_1"],
          ["mux:out",     "rLoad:pos"],
          ["rLoad:neg",   "gnd:out"],
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
    // Read at rsrcSel:neg (series resistor negative terminal = sel net node).
    const vSel = stepEnd.nodes["rsrcSel:neg"].ours!;
    expect(vSel).toBeCloseTo(4.5454545454545454, 9);

    // in_0 net is ideal: full 5.0V (no input loading)
    // Read at rsrcIn0:neg (series resistor negative terminal = in_0 net node).
    const vIn0 = stepEnd.nodes["rsrcIn0:neg"].ours!;
    expect(vIn0).toBeCloseTo(5.0, 9);
  });
});
