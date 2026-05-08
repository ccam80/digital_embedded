import { describe, it, expect } from "vitest";
import { buildFixture } from "./fixtures/build-fixture.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { ComponentRegistry } from "../../../core/registry.js";
import type { Circuit } from "../../../core/circuit.js";

// ---------------------------------------------------------------------------
// Threshold and topology constants matching the registered behavioural
// model defaults: vIH=2.0, vIL=0.8, vOH=5.0, vOL=0.0, rOut=100.
// VDD=3.3 keeps the digital input above vIH; GND drives below vIL.
// ---------------------------------------------------------------------------

const VDD = 3.3;
const GND = 0.0;
const V_IH = 2.0;
const V_IL = 0.8;
const LOAD_R = 10_000;

// Closed-form driver-output voltage at DCOP for a Norton-style behavioural
// output pin: vOut = vOH * RLOAD / (rOut + RLOAD) for a HIGH output;
// vOut = vOL for a LOW output. With defaults vOH=5, rOut=100, RLOAD=10k:
//   vHigh = 5 * 10000 / 10100 = 4.9504950495049505
//   vLow  = 0
const V_HIGH_DEFAULT = (5.0 * LOAD_R) / (100 + LOAD_R);
const V_LOW_DEFAULT = 0.0;

// ---------------------------------------------------------------------------
// Mux build helpers (selectorBits=1 → 2:1 mux, single sel pin, two inputs).
// ---------------------------------------------------------------------------

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
        { id: "rLoad", type: "Resistor",        props: { label: "rLoad", resistance: LOAD_R } },
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

// ---------------------------------------------------------------------------
// Demux build helpers (selectorBits=1 → 1:2 demux).
// Output nets share their first-pin label; the compiler may emit either a
// single "rN:pos" key or a compound "rN:pos/demux:out_N" key. Both are
// resolved through circuit.labelToNodeId; the helper below tries both.
// ---------------------------------------------------------------------------

function buildDemux1to2(selVal: number, inputLevel: number) {
  return (registry: ComponentRegistry): Circuit => {
    const facade = new DefaultSimulatorFacade(registry);
    const vSel = selVal === 1 ? VDD : GND;
    return facade.build({
      components: [
        { id: "vsSel", type: "DcVoltageSource", props: { label: "vsSel", voltage: vSel } },
        { id: "vsIn",  type: "DcVoltageSource", props: { label: "vsIn",  voltage: inputLevel } },
        { id: "demux", type: "Demultiplexer",   props: { label: "demux", model: "behavioral", selectorBits: 1 } },
        { id: "r0",    type: "Resistor",        props: { label: "r0", resistance: LOAD_R } },
        { id: "r1",    type: "Resistor",        props: { label: "r1", resistance: LOAD_R } },
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

// ---------------------------------------------------------------------------
// Decoder build helpers (selectorBits=1 → two one-hot outputs).
// ---------------------------------------------------------------------------

function buildDecoder1bit(selVal: number) {
  return (registry: ComponentRegistry): Circuit => {
    const facade = new DefaultSimulatorFacade(registry);
    const vSel = selVal === 1 ? VDD : GND;
    return facade.build({
      components: [
        { id: "vsSel",   type: "DcVoltageSource", props: { label: "vsSel",   voltage: vSel } },
        { id: "decoder", type: "Decoder",         props: { label: "decoder", model: "behavioral", selectorBits: 1 } },
        { id: "r0",      type: "Resistor",        props: { label: "r0", resistance: LOAD_R } },
        { id: "r1",      type: "Resistor",        props: { label: "r1", resistance: LOAD_R } },
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

// ---------------------------------------------------------------------------
// Helper: resolve a node voltage by trying a list of candidate label keys
// against circuit.labelToNodeId. The compiler may aggregate multiple pins
// onto one node and pick any one as the canonical key; tests query through
// engine.getNodeVoltage on the resolved nodeId.
// ---------------------------------------------------------------------------

function getNodeV(
  fix: ReturnType<typeof buildFixture>,
  candidates: string[],
): number {
  for (const label of candidates) {
    const nodeId = fix.circuit.labelToNodeId.get(label);
    if (nodeId !== undefined) return fix.engine.getNodeVoltage(nodeId);
  }
  throw new Error(
    `labelToNodeId has no entry for any of: ${candidates.join(", ")}. ` +
    `Available keys: ${[...fix.circuit.labelToNodeId.keys()].join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// Cat 1 — Initialization (T1)
// After warm-start the analog driver leaf has produced a settled output node
// voltage that matches the closed-form Norton divider for the selected input.
// One it() per component (the three behavioural factories produce distinct
// netlist topologies via buildMuxNetlist / buildDemuxNetlist /
// buildDecoderNetlist).
// ---------------------------------------------------------------------------

describe("Multiplexer behavioural model — initialization (T1)", () => {
  it("warm_start_routes_selected_high_input_to_output", () => {
    const fix = buildFixture({ build: buildMux2to1(1, [GND, VDD]) });
    // Selected input (in_1) is HIGH at VDD; driver emits vOH through rOut.
    const vOut = getNodeV(fix, ["mux:out", "rLoad:pos"]);
    expect(vOut).toBeCloseTo(V_HIGH_DEFAULT, 6);
  });
});

describe("Demultiplexer behavioural model — initialization (T1)", () => {
  it("warm_start_routes_input_to_selected_output_only", () => {
    const fix = buildFixture({ build: buildDemux1to2(1, VDD) });
    // sel=1, in=HIGH: out_1 receives HIGH; out_0 stays at vOL=0.
    const vOut1 = getNodeV(fix, ["demux:out_1", "r1:pos", "r1:pos/demux:out_1"]);
    const vOut0 = getNodeV(fix, ["demux:out_0", "r0:pos", "r0:pos/demux:out_0"]);
    expect(vOut1).toBeCloseTo(V_HIGH_DEFAULT, 6);
    expect(vOut0).toBeCloseTo(V_LOW_DEFAULT, 6);
  });
});

describe("Decoder behavioural model — initialization (T1)", () => {
  it("warm_start_drives_one_hot_output_for_selector", () => {
    const fix = buildFixture({ build: buildDecoder1bit(1) });
    // sel=1: out_1 = HIGH (decoded), out_0 = LOW.
    const vOut1 = getNodeV(fix, ["decoder:out_1", "r1:pos"]);
    const vOut0 = getNodeV(fix, ["decoder:out_0", "r0:pos"]);
    expect(vOut1).toBeCloseTo(V_HIGH_DEFAULT, 6);
    expect(vOut0).toBeCloseTo(V_LOW_DEFAULT, 6);
  });
});

// ---------------------------------------------------------------------------
// Cat 2 — DC operating point (T1, analytical closed-form)
// Norton-driver divider: vOut = vOH * RLOAD / (rOut + RLOAD) for HIGH;
// vOut = vOL for LOW. Default rOut=100, vOH=5.0, vOL=0; RLOAD=10kΩ.
// ---------------------------------------------------------------------------

describe("Multiplexer behavioural model — DCOP (T1)", () => {
  it("dcop_selects_correct_input_high", () => {
    const fix = buildFixture({ build: buildMux2to1(1, [GND, VDD]) });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result?.converged).toBe(true);
    const vOut = getNodeV(fix, ["mux:out", "rLoad:pos"]);
    expect(vOut).toBeCloseTo(V_HIGH_DEFAULT, 6);
  });

  it("dcop_selects_correct_input_low", () => {
    const fix = buildFixture({ build: buildMux2to1(1, [VDD, GND]) });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result?.converged).toBe(true);
    const vOut = getNodeV(fix, ["mux:out", "rLoad:pos"]);
    expect(vOut).toBeCloseTo(V_LOW_DEFAULT, 6);
  });

  it("dcop_routes_each_selector_value", () => {
    for (let selVal = 0; selVal < 2; selVal++) {
      const inputVoltages: [number, number] = [GND, GND];
      inputVoltages[selVal] = VDD;
      const fix = buildFixture({ build: buildMux2to1(selVal, inputVoltages) });
      const result = fix.coordinator.dcOperatingPoint();
      expect(result?.converged).toBe(true);
      const vOut = getNodeV(fix, ["mux:out", "rLoad:pos"]);
      expect(vOut).toBeCloseTo(V_HIGH_DEFAULT, 6);
    }
  });
});

describe("Demultiplexer behavioural model — DCOP (T1)", () => {
  it("dcop_selected_output_high_others_low", () => {
    const fix = buildFixture({ build: buildDemux1to2(1, VDD) });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result?.converged).toBe(true);
    const vOut0 = getNodeV(fix, ["demux:out_0", "r0:pos", "r0:pos/demux:out_0"]);
    const vOut1 = getNodeV(fix, ["demux:out_1", "r1:pos", "r1:pos/demux:out_1"]);
    expect(vOut1).toBeCloseTo(V_HIGH_DEFAULT, 6);
    expect(vOut0).toBeCloseTo(V_LOW_DEFAULT, 6);
  });

  it("dcop_all_outputs_low_when_input_low", () => {
    const fix = buildFixture({ build: buildDemux1to2(0, GND) });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result?.converged).toBe(true);
    const vOut0 = getNodeV(fix, ["demux:out_0", "r0:pos", "r0:pos/demux:out_0"]);
    const vOut1 = getNodeV(fix, ["demux:out_1", "r1:pos", "r1:pos/demux:out_1"]);
    expect(vOut0).toBeCloseTo(V_LOW_DEFAULT, 6);
    expect(vOut1).toBeCloseTo(V_LOW_DEFAULT, 6);
  });

  it("dcop_routes_each_selector_value", () => {
    for (let selVal = 0; selVal < 2; selVal++) {
      const fix = buildFixture({ build: buildDemux1to2(selVal, VDD) });
      const result = fix.coordinator.dcOperatingPoint();
      expect(result?.converged).toBe(true);
      const vOut0 = getNodeV(fix, ["demux:out_0", "r0:pos", "r0:pos/demux:out_0"]);
      const vOut1 = getNodeV(fix, ["demux:out_1", "r1:pos", "r1:pos/demux:out_1"]);
      if (selVal === 0) {
        expect(vOut0).toBeCloseTo(V_HIGH_DEFAULT, 6);
        expect(vOut1).toBeCloseTo(V_LOW_DEFAULT, 6);
      } else {
        expect(vOut0).toBeCloseTo(V_LOW_DEFAULT, 6);
        expect(vOut1).toBeCloseTo(V_HIGH_DEFAULT, 6);
      }
    }
  });
});

describe("Decoder behavioural model — DCOP (T1)", () => {
  it("dcop_one_hot_output_for_high_selector", () => {
    const fix = buildFixture({ build: buildDecoder1bit(1) });
    const result = fix.coordinator.dcOperatingPoint();
    expect(result?.converged).toBe(true);
    const vOut0 = getNodeV(fix, ["decoder:out_0", "r0:pos"]);
    const vOut1 = getNodeV(fix, ["decoder:out_1", "r1:pos"]);
    expect(vOut0).toBeCloseTo(V_LOW_DEFAULT, 6);
    expect(vOut1).toBeCloseTo(V_HIGH_DEFAULT, 6);
  });

  it("dcop_routes_each_selector_value", () => {
    for (let selVal = 0; selVal < 2; selVal++) {
      const fix = buildFixture({ build: buildDecoder1bit(selVal) });
      const result = fix.coordinator.dcOperatingPoint();
      expect(result?.converged).toBe(true);
      const vOut0 = getNodeV(fix, ["decoder:out_0", "r0:pos"]);
      const vOut1 = getNodeV(fix, ["decoder:out_1", "r1:pos"]);
      if (selVal === 0) {
        expect(vOut0).toBeCloseTo(V_HIGH_DEFAULT, 6);
        expect(vOut1).toBeCloseTo(V_LOW_DEFAULT, 6);
      } else {
        expect(vOut0).toBeCloseTo(V_LOW_DEFAULT, 6);
        expect(vOut1).toBeCloseTo(V_HIGH_DEFAULT, 6);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Cat 4 — Parameter hot-load (T1)
//
// Behavioural model parameters per Mux/Demux/Decoder modelRegistry:
//   selectorBits (structural — set at build time, not hot-loadable post-compile)
//   loaded, vIH, vIL, rOut, cOut, vOH, vOL
//
// One it() per primary observable group plus a TEMP-equivalent recompute
// path: Cat 4 of this file covers vOH (output drive level — primary scaling
// param), rOut (output drive resistance — divider denominator), and
// vIH (input threshold — discriminates digital input regions). Other params
// (cOut/vOL/vIL/loaded) follow identical recompute paths and the
// representative-per-group rule applies.
//
// loaded is the structural-seed analogue (1/0 selects loaded vs unloaded
// pin variants in the netlist) and is consumed at compile() — covered by
// the build-time variant comparison it() below.
// ---------------------------------------------------------------------------

describe("Multiplexer behavioural model — parameter hot-load (T1)", () => {
  it("hotload_vOH_changes_output_high_voltage", () => {
    // Selected input HIGH; vOH defaults to 5.0V, vOut_default ≈ 4.9505V.
    // Raise vOH to 6.0V; new closed-form vOut = 6 * 10000/10100 = 5.94059...V.
    const fix = buildFixture({ build: buildMux2to1(1, [GND, VDD]) });
    const before = getNodeV(fix, ["mux:out", "rLoad:pos"]);
    const muxEl = fix.coordinator.compiled.allCircuitElements.find(
      e => e.getProperties().getOrDefault<string>("label", "") === "mux",
    );
    expect(muxEl).toBeDefined();
    fix.coordinator.setComponentProperty(muxEl!, "vOH", 6.0);
    fix.coordinator.step();
    const after = getNodeV(fix, ["mux:out", "rLoad:pos"]);
    const expectedAfter = (6.0 * LOAD_R) / (100 + LOAD_R);
    expect(after).not.toBeCloseTo(before, 3);
    expect(after).toBeCloseTo(expectedAfter, 4);
  });

  it("hotload_rOut_changes_output_divider_voltage", () => {
    // Selected input HIGH; default rOut=100 → vOut ≈ 4.9505V.
    // Raise rOut to 1000 → vOut = 5 * 10000/11000 = 4.5454545...V.
    const fix = buildFixture({ build: buildMux2to1(1, [GND, VDD]) });
    const before = getNodeV(fix, ["mux:out", "rLoad:pos"]);
    const muxEl = fix.coordinator.compiled.allCircuitElements.find(
      e => e.getProperties().getOrDefault<string>("label", "") === "mux",
    );
    expect(muxEl).toBeDefined();
    fix.coordinator.setComponentProperty(muxEl!, "rOut", 1000);
    fix.coordinator.step();
    const after = getNodeV(fix, ["mux:out", "rLoad:pos"]);
    const expectedAfter = (5.0 * LOAD_R) / (1000 + LOAD_R);
    expect(after).not.toBeCloseTo(before, 3);
    expect(after).toBeCloseTo(expectedAfter, 4);
  });

  it("hotload_vIH_shifts_digital_input_threshold", () => {
    // Drive sel at 2.5V (above default vIH=2.0 → sel=1, picks in_1).
    // Build with sel = 2.5V via direct DcVoltageSource override.
    const buildAt = (vSel: number) => (registry: ComponentRegistry): Circuit => {
      const facade = new DefaultSimulatorFacade(registry);
      return facade.build({
        components: [
          { id: "vsSel", type: "DcVoltageSource", props: { label: "vsSel", voltage: vSel } },
          { id: "vsIn0", type: "DcVoltageSource", props: { label: "vsIn0", voltage: GND } },
          { id: "vsIn1", type: "DcVoltageSource", props: { label: "vsIn1", voltage: VDD } },
          { id: "mux",   type: "Multiplexer",     props: { label: "mux", model: "behavioral", selectorBits: 1 } },
          { id: "rLoad", type: "Resistor",        props: { label: "rLoad", resistance: LOAD_R } },
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
    // sel=2.5V is above default vIH=2.0 → sel decoded as 1 → mux selects in_1=HIGH.
    const fix = buildFixture({ build: buildAt(2.5) });
    const before = getNodeV(fix, ["mux:out", "rLoad:pos"]);
    expect(before).toBeCloseTo(V_HIGH_DEFAULT, 4);
    // Raise vIH above 2.5V: sel=2.5 now falls into the indeterminate band /
    // discriminates as LOW depending on the threshold contract; the
    // documented post-change observable is that the routed input changes.
    const muxEl = fix.coordinator.compiled.allCircuitElements.find(
      e => e.getProperties().getOrDefault<string>("label", "") === "mux",
    );
    expect(muxEl).toBeDefined();
    fix.coordinator.setComponentProperty(muxEl!, "vIH", 3.0);
    fix.coordinator.setComponentProperty(muxEl!, "vIL", 2.7);
    fix.coordinator.step();
    const after = getNodeV(fix, ["mux:out", "rLoad:pos"]);
    // Documented contract: sel = 2.5V is now below vIL=2.7 → sel=0 → mux
    // routes in_0 (GND) → vOut = vOL = 0V. The change must be observable.
    expect(after).not.toBeCloseTo(before, 3);
    expect(after).toBeCloseTo(V_LOW_DEFAULT, 4);
  });

  it("hotload_loaded_structural_property_seeds_pin_subelements", () => {
    // `loaded` is consumed at compile() to select DigitalInputPinLoaded /
    // Unloaded variants in the netlist. Build the same circuit twice with
    // explicit loaded=1 and loaded=0 model params; the two compiled
    // topologies must produce observably different DCOP node voltages
    // when an external series-resistor exercises the input-pin's rIn.
    //
    // Loaded variant: rIn ≈ 100kΩ; with 10kΩ series resistor on sel,
    //   vSelNode = 5V * 100k / 110k ≈ 4.5454V (sag below 5V).
    // Unloaded variant: rIn → ∞; vSelNode ≈ 5V (no sag).
    function buildWithSelSeries(loaded: number) {
      return (registry: ComponentRegistry): Circuit => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vsSel",   type: "DcVoltageSource", props: { label: "vsSel",   voltage: 5 } },
            { id: "vsIn0",   type: "DcVoltageSource", props: { label: "vsIn0",   voltage: 5 } },
            { id: "vsIn1",   type: "DcVoltageSource", props: { label: "vsIn1",   voltage: 0 } },
            { id: "rsrcSel", type: "Resistor",        props: { label: "rsrcSel", resistance: 10_000 } },
            { id: "mux",     type: "Multiplexer",     props: { label: "mux", model: "behavioral", selectorBits: 1, loaded } },
            { id: "rLoad",   type: "Resistor",        props: { label: "rLoad", resistance: LOAD_R } },
            { id: "gnd",     type: "Ground" },
          ],
          connections: [
            ["vsSel:pos",   "rsrcSel:pos"],
            ["rsrcSel:neg", "mux:sel"],
            ["vsIn0:pos",   "mux:in_0"],
            ["vsIn1:pos",   "mux:in_1"],
            ["mux:out",     "rLoad:pos"],
            ["rLoad:neg",   "gnd:out"],
            ["vsSel:neg",   "gnd:out"],
            ["vsIn0:neg",   "gnd:out"],
            ["vsIn1:neg",   "gnd:out"],
          ],
        });
      };
    }
    const fixLoaded = buildFixture({ build: buildWithSelSeries(1) });
    const fixUnloaded = buildFixture({ build: buildWithSelSeries(0) });
    const vSelLoaded = getNodeV(fixLoaded, ["mux:sel", "rsrcSel:neg"]);
    const vSelUnloaded = getNodeV(fixUnloaded, ["mux:sel", "rsrcSel:neg"]);
    // Loaded variant sags toward (5 * 100k / 110k) ≈ 4.5454V; unloaded
    // variant stays close to the source 5V.
    expect(vSelLoaded).toBeLessThan(vSelUnloaded);
    expect(vSelUnloaded).toBeGreaterThan(4.9);
    expect(vSelLoaded).toBeLessThan(4.7);
  });
});

describe("Demultiplexer behavioural model — parameter hot-load (T1)", () => {
  it("hotload_vOH_changes_selected_output_voltage", () => {
    const fix = buildFixture({ build: buildDemux1to2(1, VDD) });
    const before = getNodeV(fix, ["demux:out_1", "r1:pos", "r1:pos/demux:out_1"]);
    const demuxEl = fix.coordinator.compiled.allCircuitElements.find(
      e => e.getProperties().getOrDefault<string>("label", "") === "demux",
    );
    expect(demuxEl).toBeDefined();
    fix.coordinator.setComponentProperty(demuxEl!, "vOH", 6.0);
    fix.coordinator.step();
    const after = getNodeV(fix, ["demux:out_1", "r1:pos", "r1:pos/demux:out_1"]);
    const expectedAfter = (6.0 * LOAD_R) / (100 + LOAD_R);
    expect(after).not.toBeCloseTo(before, 3);
    expect(after).toBeCloseTo(expectedAfter, 4);
  });

  it("hotload_rOut_changes_selected_output_divider", () => {
    const fix = buildFixture({ build: buildDemux1to2(1, VDD) });
    const before = getNodeV(fix, ["demux:out_1", "r1:pos", "r1:pos/demux:out_1"]);
    const demuxEl = fix.coordinator.compiled.allCircuitElements.find(
      e => e.getProperties().getOrDefault<string>("label", "") === "demux",
    );
    expect(demuxEl).toBeDefined();
    fix.coordinator.setComponentProperty(demuxEl!, "rOut", 1000);
    fix.coordinator.step();
    const after = getNodeV(fix, ["demux:out_1", "r1:pos", "r1:pos/demux:out_1"]);
    const expectedAfter = (5.0 * LOAD_R) / (1000 + LOAD_R);
    expect(after).not.toBeCloseTo(before, 3);
    expect(after).toBeCloseTo(expectedAfter, 4);
  });
});

describe("Decoder behavioural model — parameter hot-load (T1)", () => {
  it("hotload_vOH_changes_active_output_voltage", () => {
    const fix = buildFixture({ build: buildDecoder1bit(1) });
    const before = getNodeV(fix, ["decoder:out_1", "r1:pos"]);
    const decoderEl = fix.coordinator.compiled.allCircuitElements.find(
      e => e.getProperties().getOrDefault<string>("label", "") === "decoder",
    );
    expect(decoderEl).toBeDefined();
    fix.coordinator.setComponentProperty(decoderEl!, "vOH", 6.0);
    fix.coordinator.step();
    const after = getNodeV(fix, ["decoder:out_1", "r1:pos"]);
    const expectedAfter = (6.0 * LOAD_R) / (100 + LOAD_R);
    expect(after).not.toBeCloseTo(before, 3);
    expect(after).toBeCloseTo(expectedAfter, 4);
  });

  it("hotload_rOut_changes_active_output_divider", () => {
    const fix = buildFixture({ build: buildDecoder1bit(1) });
    const before = getNodeV(fix, ["decoder:out_1", "r1:pos"]);
    const decoderEl = fix.coordinator.compiled.allCircuitElements.find(
      e => e.getProperties().getOrDefault<string>("label", "") === "decoder",
    );
    expect(decoderEl).toBeDefined();
    fix.coordinator.setComponentProperty(decoderEl!, "rOut", 1000);
    fix.coordinator.step();
    const after = getNodeV(fix, ["decoder:out_1", "r1:pos"]);
    const expectedAfter = (5.0 * LOAD_R) / (1000 + LOAD_R);
    expect(after).not.toBeCloseTo(before, 3);
    expect(after).toBeCloseTo(expectedAfter, 4);
  });
});

// ---------------------------------------------------------------------------
// Cat 9 — Bridge / digital interaction (T1)
// Each component declares digital pins (sel, in_*, out_*); the behavioural
// model produces an analog response to digital-source inputs. Cat 9 mechanic:
// digital input voltage causes the documented analog response on the output.
// ---------------------------------------------------------------------------

describe("Multiplexer behavioural model — digital-to-analog bridge (T1)", () => {
  it("digital_high_selector_routes_high_input_to_analog_out", () => {
    const fix = buildFixture({ build: buildMux2to1(1, [GND, VDD]) });
    const vOut = getNodeV(fix, ["mux:out", "rLoad:pos"]);
    expect(vOut).toBeGreaterThan(V_IH);
  });

  it("digital_low_selector_routes_low_input_to_analog_out", () => {
    const fix = buildFixture({ build: buildMux2to1(0, [GND, VDD]) });
    const vOut = getNodeV(fix, ["mux:out", "rLoad:pos"]);
    expect(vOut).toBeLessThan(V_IL);
  });
});

describe("Demultiplexer behavioural model — digital-to-analog bridge (T1)", () => {
  it("digital_input_drives_selected_analog_output", () => {
    const fix = buildFixture({ build: buildDemux1to2(1, VDD) });
    const vOut1 = getNodeV(fix, ["demux:out_1", "r1:pos", "r1:pos/demux:out_1"]);
    const vOut0 = getNodeV(fix, ["demux:out_0", "r0:pos", "r0:pos/demux:out_0"]);
    expect(vOut1).toBeGreaterThan(V_IH);
    expect(vOut0).toBeLessThan(V_IL);
  });
});

describe("Decoder behavioural model — digital-to-analog bridge (T1)", () => {
  it("digital_selector_decodes_to_analog_one_hot_outputs", () => {
    const fix = buildFixture({ build: buildDecoder1bit(1) });
    const vOut0 = getNodeV(fix, ["decoder:out_0", "r0:pos"]);
    const vOut1 = getNodeV(fix, ["decoder:out_1", "r1:pos"]);
    expect(vOut0).toBeLessThan(V_IL);
    expect(vOut1).toBeGreaterThan(V_IH);
  });
});

// ---------------------------------------------------------------------------
// Cat 11 — Multi-output digital observability (T1)
// Demux and Decoder both declare outputSchema with > 1 output. Each output
// must be independently observable on the same simulator step for a given
// input combination.
// (Mux has only one output → Cat 11 does not apply.)
// ---------------------------------------------------------------------------

describe("Demultiplexer behavioural model — multi-output observability (T1)", () => {
  it("each_output_pin_independently_reflects_documented_value_sel0", () => {
    // sel=0, in=HIGH: out_0 = HIGH, out_1 = LOW.
    const fix = buildFixture({ build: buildDemux1to2(0, VDD) });
    const vOut0 = getNodeV(fix, ["demux:out_0", "r0:pos", "r0:pos/demux:out_0"]);
    const vOut1 = getNodeV(fix, ["demux:out_1", "r1:pos", "r1:pos/demux:out_1"]);
    expect(vOut0).toBeCloseTo(V_HIGH_DEFAULT, 6);
    expect(vOut1).toBeCloseTo(V_LOW_DEFAULT, 6);
  });

  it("each_output_pin_independently_reflects_documented_value_sel1", () => {
    // sel=1, in=HIGH: out_0 = LOW, out_1 = HIGH.
    const fix = buildFixture({ build: buildDemux1to2(1, VDD) });
    const vOut0 = getNodeV(fix, ["demux:out_0", "r0:pos", "r0:pos/demux:out_0"]);
    const vOut1 = getNodeV(fix, ["demux:out_1", "r1:pos", "r1:pos/demux:out_1"]);
    expect(vOut0).toBeCloseTo(V_LOW_DEFAULT, 6);
    expect(vOut1).toBeCloseTo(V_HIGH_DEFAULT, 6);
  });
});

describe("Decoder behavioural model — multi-output observability (T1)", () => {
  it("each_output_pin_independently_reflects_documented_one_hot_sel0", () => {
    const fix = buildFixture({ build: buildDecoder1bit(0) });
    const vOut0 = getNodeV(fix, ["decoder:out_0", "r0:pos"]);
    const vOut1 = getNodeV(fix, ["decoder:out_1", "r1:pos"]);
    expect(vOut0).toBeCloseTo(V_HIGH_DEFAULT, 6);
    expect(vOut1).toBeCloseTo(V_LOW_DEFAULT, 6);
  });

  it("each_output_pin_independently_reflects_documented_one_hot_sel1", () => {
    const fix = buildFixture({ build: buildDecoder1bit(1) });
    const vOut0 = getNodeV(fix, ["decoder:out_0", "r0:pos"]);
    const vOut1 = getNodeV(fix, ["decoder:out_1", "r1:pos"]);
    expect(vOut0).toBeCloseTo(V_LOW_DEFAULT, 6);
    expect(vOut1).toBeCloseTo(V_HIGH_DEFAULT, 6);
  });
});

// ---------------------------------------------------------------------------
// Pin-loading propagation (folded into Cat 4 loaded-structural-seed family)
// The original file's combinational_pin_loading_propagates it() asserted that
// a loaded sel pin produces a documented voltage divider through rIn=100kΩ.
// Authored as a circuit-driven Cat 4 sibling because the observable is a
// node voltage produced by the loaded netlist variant.
// ---------------------------------------------------------------------------

describe("Multiplexer behavioural model — pin-loading propagation (T1)", () => {
  it("loaded_sel_pin_sags_through_external_series_resistor", () => {
    // Uses the same loaded vs. unloaded contrast as the Cat 4 build-time
    // structural seed it() above, but asserts the closed-form sag value
    // for the loaded variant when rIn defaults to 100kΩ.
    //   vSel = 5 * 100k / (10k + 100k) = 4.5454545454545454V
    const buildAt = (registry: ComponentRegistry): Circuit => {
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
      // Apply pin-loading override per Decision #10: sel loaded, in_0 ideal.
      c.metadata.digitalPinLoadingOverrides = [
        { anchor: { type: "pin", instanceId: "mux", pinLabel: "sel" }, loading: "loaded" },
        { anchor: { type: "pin", instanceId: "mux", pinLabel: "in_0" }, loading: "ideal" },
      ];
      return c;
    };
    const fix = buildFixture({ build: buildAt });
    const vSel = getNodeV(fix, ["mux:sel", "rsrcSel:neg"]);
    const vIn0 = getNodeV(fix, ["mux:in_0", "rsrcIn0:neg"]);
    expect(vSel).toBeCloseTo(4.5454545454545454, 6);
    expect(vIn0).toBeCloseTo(5.0, 6);
  });
});

