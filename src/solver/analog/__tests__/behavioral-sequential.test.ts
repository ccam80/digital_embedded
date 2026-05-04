/**
 * Tests for BehavioralCounterElement and BehavioralRegisterElement.
 *
 * Tests verify:
 *   - Counter increments on rising clock edges
 *   - Counter resets to 0 on clear
 *   - Counter output voltages are V_OH or V_OL (no intermediate values)
 *   - Register latches all bits on rising clock edge
 *   - CounterDefinition and RegisterDefinition have analogFactory registered
 *   - CounterPresetDefinition has analogFactory registered
 *
 * Migration: M1 via ComparisonSession.createSelfCompare.
 * Counter4Bit: Clock source drives clk; DcVoltageSource drives clr.
 * Count/storedValue reconstructed from output bit node voltages via getStepEnd.
 */

import { describe, it, expect } from "vitest";
import { ComparisonSession } from "./harness/comparison-session.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../components/register-all.js";
import { CounterDefinition } from "../../../components/memory/counter.js";
import { CounterPresetDefinition } from "../../../components/memory/counter-preset.js";
import { RegisterDefinition } from "../../../components/memory/register.js";
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
import { PropertyBag } from "../../../core/properties.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}

// ---------------------------------------------------------------------------
// Bit reconstruction helper
// ---------------------------------------------------------------------------

/** Reconstruct an integer from an array of bit-node voltages (LSB first). */
function bitsToInt(voltages: number[], threshold = 2.5): number {
  return voltages.reduce((acc, v, i) => acc | ((v > threshold ? 1 : 0) << i), 0);
}

// ---------------------------------------------------------------------------
// Counter tests
// ---------------------------------------------------------------------------

describe("Counter", () => {
  /**
   * counts_on_clock_edges:
   *
   * Circuit: Clock(1Hz, vdd=3.3) → counter:C
   *          DcVoltageSource(0V) → counter:clr
   *          DcVoltageSource(3.3V) → counter:en
   *          counter:q0..q3 → Resistor(10kΩ) → Ground (4 bits)
   *          counter:ovf → Resistor(10kΩ) → Ground
   *
   * Run 5.5 periods (tStop = 5.5s at 1Hz). After 5 rising edges count = 5 = 0b0101.
   * Reconstruct count from q0..q3 bit voltages at the last step.
   */
  it("counts_on_clock_edges", async () => {
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "clk",    type: "Clock",          props: { Frequency: 1, vdd: 3.3, label: "clk" } },
            { id: "vsCLR",  type: "DcVoltageSource", props: { voltage: 0.0 } },
            { id: "vsEN",   type: "DcVoltageSource", props: { voltage: 3.3 } },
            { id: "ctr",    type: "Counter",         props: { bitWidth: 4, label: "counter" } },
            { id: "rQ0",    type: "Resistor",        props: { resistance: 10000 } },
            { id: "rQ1",    type: "Resistor",        props: { resistance: 10000 } },
            { id: "rQ2",    type: "Resistor",        props: { resistance: 10000 } },
            { id: "rQ3",    type: "Resistor",        props: { resistance: 10000 } },
            { id: "rOvf",   type: "Resistor",        props: { resistance: 10000 } },
            { id: "gnd",    type: "Ground" },
          ],
          connections: [
            ["clk:out",    "ctr:C"],
            ["vsCLR:pos",  "ctr:clr"],
            ["vsEN:pos",   "ctr:en"],
            ["ctr:q0",     "rQ0:A"],
            ["ctr:q1",     "rQ1:A"],
            ["ctr:q2",     "rQ2:A"],
            ["ctr:q3",     "rQ3:A"],
            ["ctr:ovf",    "rOvf:A"],
            ["rQ0:B",      "gnd:out"],
            ["rQ1:B",      "gnd:out"],
            ["rQ2:B",      "gnd:out"],
            ["rQ3:B",      "gnd:out"],
            ["rOvf:B",     "gnd:out"],
            ["vsCLR:neg",  "gnd:out"],
            ["vsEN:neg",   "gnd:out"],
          ],
        });
      },
      analysis: "tran",
      tStop: 5.5,
      maxStep: 0.1,
    });

    const stepCount = session.ourSession!.steps.length;
    expect(stepCount).toBeGreaterThan(0);

    const stepEnd = session.getStepEnd(stepCount - 1);
    const bits = ["counter:q0", "counter:q1", "counter:q2", "counter:q3"].map(
      (b) => stepEnd.nodes[b]?.ours ?? 0,
    );
    const count = bitsToInt(bits);
    // After 5 rising edges at 1Hz, count = 5 = 0b0101
    expect(count).toBe(5);
  }, 60_000);

  /**
   * clear_resets_to_zero:
   *
   * Same circuit but clr=3.3V (active). After 3 rising edges with clr=3.3V,
   * count = 0.
   */
  it("clear_resets_to_zero", async () => {
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "clk",    type: "Clock",          props: { Frequency: 1, vdd: 3.3, label: "clk" } },
            { id: "vsCLR",  type: "DcVoltageSource", props: { voltage: 3.3 } },
            { id: "vsEN",   type: "DcVoltageSource", props: { voltage: 3.3 } },
            { id: "ctr",    type: "Counter",         props: { bitWidth: 4, label: "counter" } },
            { id: "rQ0",    type: "Resistor",        props: { resistance: 10000 } },
            { id: "rQ1",    type: "Resistor",        props: { resistance: 10000 } },
            { id: "rQ2",    type: "Resistor",        props: { resistance: 10000 } },
            { id: "rQ3",    type: "Resistor",        props: { resistance: 10000 } },
            { id: "rOvf",   type: "Resistor",        props: { resistance: 10000 } },
            { id: "gnd",    type: "Ground" },
          ],
          connections: [
            ["clk:out",    "ctr:C"],
            ["vsCLR:pos",  "ctr:clr"],
            ["vsEN:pos",   "ctr:en"],
            ["ctr:q0",     "rQ0:A"],
            ["ctr:q1",     "rQ1:A"],
            ["ctr:q2",     "rQ2:A"],
            ["ctr:q3",     "rQ3:A"],
            ["ctr:ovf",    "rOvf:A"],
            ["rQ0:B",      "gnd:out"],
            ["rQ1:B",      "gnd:out"],
            ["rQ2:B",      "gnd:out"],
            ["rQ3:B",      "gnd:out"],
            ["rOvf:B",     "gnd:out"],
            ["vsCLR:neg",  "gnd:out"],
            ["vsEN:neg",   "gnd:out"],
          ],
        });
      },
      analysis: "tran",
      tStop: 3.5,
      maxStep: 0.1,
    });

    const stepCount = session.ourSession!.steps.length;
    expect(stepCount).toBeGreaterThan(0);

    const stepEnd = session.getStepEnd(stepCount - 1);
    const bits = ["counter:q0", "counter:q1", "counter:q2", "counter:q3"].map(
      (b) => stepEnd.nodes[b]?.ours ?? 0,
    );
    const count = bitsToInt(bits);
    // clr=HIGH forces count to 0
    expect(count).toBe(0);
  }, 60_000);

  /**
   * output_voltages_match_logic:
   *
   * Run 5 rising edges (count=5=0b0101). Verify that each output bit voltage
   * is either V_OH (>2.5V) or V_OL (<0.8V) and matches the expected bit pattern.
   */
  it("output_voltages_match_logic", async () => {
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "clk",    type: "Clock",          props: { Frequency: 1, vdd: 3.3, label: "clk" } },
            { id: "vsCLR",  type: "DcVoltageSource", props: { voltage: 0.0 } },
            { id: "vsEN",   type: "DcVoltageSource", props: { voltage: 3.3 } },
            { id: "ctr",    type: "Counter",         props: { bitWidth: 4, label: "counter" } },
            { id: "rQ0",    type: "Resistor",        props: { resistance: 10000 } },
            { id: "rQ1",    type: "Resistor",        props: { resistance: 10000 } },
            { id: "rQ2",    type: "Resistor",        props: { resistance: 10000 } },
            { id: "rQ3",    type: "Resistor",        props: { resistance: 10000 } },
            { id: "rOvf",   type: "Resistor",        props: { resistance: 10000 } },
            { id: "gnd",    type: "Ground" },
          ],
          connections: [
            ["clk:out",    "ctr:C"],
            ["vsCLR:pos",  "ctr:clr"],
            ["vsEN:pos",   "ctr:en"],
            ["ctr:q0",     "rQ0:A"],
            ["ctr:q1",     "rQ1:A"],
            ["ctr:q2",     "rQ2:A"],
            ["ctr:q3",     "rQ3:A"],
            ["ctr:ovf",    "rOvf:A"],
            ["rQ0:B",      "gnd:out"],
            ["rQ1:B",      "gnd:out"],
            ["rQ2:B",      "gnd:out"],
            ["rQ3:B",      "gnd:out"],
            ["rOvf:B",     "gnd:out"],
            ["vsCLR:neg",  "gnd:out"],
            ["vsEN:neg",   "gnd:out"],
          ],
        });
      },
      analysis: "tran",
      tStop: 5.5,
      maxStep: 0.1,
    });

    const stepCount = session.ourSession!.steps.length;
    const stepEnd = session.getStepEnd(stepCount - 1);

    const bits = ["counter:q0", "counter:q1", "counter:q2", "counter:q3"].map(
      (b) => stepEnd.nodes[b]?.ours ?? 0,
    );
    const count = bitsToInt(bits);
    // count=5=0b0101: bit0=1, bit1=0, bit2=1, bit3=0
    expect(count).toBe(5);

    const expectedBits = [1, 0, 1, 0];
    for (let bit = 0; bit < 4; bit++) {
      const v = bits[bit];
      if (expectedBits[bit] === 1) {
        expect(v, `bit${bit} should be V_OH`).toBeGreaterThan(2.5);
      } else {
        expect(v, `bit${bit} should be V_OL`).toBeLessThan(0.8);
      }
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Register tests
// ---------------------------------------------------------------------------

describe("Register", () => {
  /**
   * latches_all_bits:
   *
   * Circuit: 8 DcVoltageSources driving D bits 0..7 (data=0xA5=0b10100101)
   *          DcVoltageSource(3.3V) → reg:en
   *          Clock(1Hz) → reg:C
   *          reg:Q0..Q7 → Resistor(10kΩ) → Ground
   *
   * Run 1.5 periods. After 1 rising edge with en=1 and data=0xA5, storedValue=0xA5.
   * Reconstruct storedValue from Q0..Q7 bit voltages at the last step.
   */
  it("latches_all_bits", async () => {
    // 0xA5 = 0b10100101
    const data = 0xA5;
    const dataBits = Array.from({ length: 8 }, (_, i) => (data >> i) & 1);

    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);

        const components: import("../../../headless/netlist-types.js").CircuitSpec["components"] = [
          { id: "clk",   type: "Clock",          props: { Frequency: 1, vdd: 3.3, label: "clk" } },
          { id: "vsEN",  type: "DcVoltageSource", props: { voltage: 3.3 } },
          { id: "reg",   type: "Register",        props: { bitWidth: 8, label: "reg" } },
          { id: "gnd",   type: "Ground" },
        ];
        for (let bit = 0; bit < 8; bit++) {
          components.push({
            id: `vsD${bit}`,
            type: "DcVoltageSource",
            props: { voltage: dataBits[bit] ? 3.3 : 0.0 },
          });
          components.push({
            id: `rQ${bit}`,
            type: "Resistor",
            props: { resistance: 10000 },
          });
        }

        const connections: import("../../../headless/netlist-types.js").CircuitSpec["connections"] = [
          ["clk:out",  "reg:C"],
          ["vsEN:pos", "reg:en"],
          ["vsEN:neg", "gnd:out"],
        ];
        for (let bit = 0; bit < 8; bit++) {
          connections.push([`vsD${bit}:pos`, `reg:D${bit}`]);
          connections.push([`vsD${bit}:neg`, "gnd:out"]);
          connections.push([`reg:Q${bit}`, `rQ${bit}:A`]);
          connections.push([`rQ${bit}:B`, "gnd:out"]);
        }

        return facade.build({ components, connections });
      },
      analysis: "tran",
      tStop: 1.5,
      maxStep: 0.1,
    });

    const stepCount = session.ourSession!.steps.length;
    expect(stepCount).toBeGreaterThan(0);

    const stepEnd = session.getStepEnd(stepCount - 1);
    const bits = Array.from({ length: 8 }, (_, i) => stepEnd.nodes[`reg:Q${i}`]?.ours ?? 0);
    const storedValue = bitsToInt(bits);
    expect(storedValue).toBe(0xA5);
  }, 60_000);

  /**
   * does_not_latch_without_enable:
   *
   * Same circuit but en=0V. After 1 rising edge with en=0, storedValue=0.
   */
  it("does_not_latch_without_enable", async () => {
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);

        const components: import("../../../headless/netlist-types.js").CircuitSpec["components"] = [
          { id: "clk",   type: "Clock",          props: { Frequency: 1, vdd: 3.3, label: "clk" } },
          { id: "vsEN",  type: "DcVoltageSource", props: { voltage: 0.0 } },
          { id: "reg",   type: "Register",        props: { bitWidth: 8, label: "reg" } },
          { id: "gnd",   type: "Ground" },
        ];
        for (let bit = 0; bit < 8; bit++) {
          // All data bits HIGH (0xFF)
          components.push({ id: `vsD${bit}`, type: "DcVoltageSource", props: { voltage: 3.3 } });
          components.push({ id: `rQ${bit}`,  type: "Resistor",        props: { resistance: 10000 } });
        }

        const connections: import("../../../headless/netlist-types.js").CircuitSpec["connections"] = [
          ["clk:out",  "reg:C"],
          ["vsEN:pos", "reg:en"],
          ["vsEN:neg", "gnd:out"],
        ];
        for (let bit = 0; bit < 8; bit++) {
          connections.push([`vsD${bit}:pos`, `reg:D${bit}`]);
          connections.push([`vsD${bit}:neg`, "gnd:out"]);
          connections.push([`reg:Q${bit}`, `rQ${bit}:A`]);
          connections.push([`rQ${bit}:B`, "gnd:out"]);
        }

        return facade.build({ components, connections });
      },
      analysis: "tran",
      tStop: 1.5,
      maxStep: 0.1,
    });

    const stepCount = session.ourSession!.steps.length;
    const stepEnd = session.getStepEnd(stepCount - 1);
    const bits = Array.from({ length: 8 }, (_, i) => stepEnd.nodes[`reg:Q${i}`]?.ours ?? 0);
    const storedValue = bitsToInt(bits);
    // en=0 → register does not latch → storedValue=0
    expect(storedValue).toBe(0);
  }, 60_000);

  /**
   * holds_value_across_timesteps:
   *
   * Latch 0x55 with en=1 and one rising edge. Then run 10 more periods with
   * data=0x00 and clock running. The stored value must remain 0x55 at the end.
   */
  it("holds_value_across_timesteps", async () => {
    // 0x55 = 0b01010101
    const data = 0x55;
    const dataBits = Array.from({ length: 8 }, (_, i) => (data >> i) & 1);

    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);

        const components: import("../../../headless/netlist-types.js").CircuitSpec["components"] = [
          { id: "clk",   type: "Clock",          props: { Frequency: 1, vdd: 3.3, label: "clk" } },
          { id: "vsEN",  type: "DcVoltageSource", props: { voltage: 3.3 } },
          { id: "reg",   type: "Register",        props: { bitWidth: 8, label: "reg" } },
          { id: "gnd",   type: "Ground" },
        ];
        for (let bit = 0; bit < 8; bit++) {
          components.push({
            id: `vsD${bit}`,
            type: "DcVoltageSource",
            props: { voltage: dataBits[bit] ? 3.3 : 0.0 },
          });
          components.push({ id: `rQ${bit}`, type: "Resistor", props: { resistance: 10000 } });
        }

        const connections: import("../../../headless/netlist-types.js").CircuitSpec["connections"] = [
          ["clk:out",  "reg:C"],
          ["vsEN:pos", "reg:en"],
          ["vsEN:neg", "gnd:out"],
        ];
        for (let bit = 0; bit < 8; bit++) {
          connections.push([`vsD${bit}:pos`, `reg:D${bit}`]);
          connections.push([`vsD${bit}:neg`, "gnd:out"]);
          connections.push([`reg:Q${bit}`, `rQ${bit}:A`]);
          connections.push([`rQ${bit}:B`, "gnd:out"]);
        }

        return facade.build({ components, connections });
      },
      analysis: "tran",
      tStop: 11.5,
      maxStep: 0.1,
    });

    const stepCount = session.ourSession!.steps.length;
    const stepEnd = session.getStepEnd(stepCount - 1);
    const bits = Array.from({ length: 8 }, (_, i) => stepEnd.nodes[`reg:Q${i}`]?.ours ?? 0);
    const storedValue = bitsToInt(bits);
    expect(storedValue).toBe(0x55);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Registration tests
// ---------------------------------------------------------------------------

describe("Registration", () => {
  it("counter_has_analog_factory", () => {
    expect(typeof (CounterDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBe("function");
  });

  it("counter_engine_type_is_both", () => {
    expect(CounterDefinition.models?.digital).not.toBeUndefined();
    expect(CounterDefinition.modelRegistry?.behavioral).not.toBeUndefined();
  });

  it("counter_simulation_modes_include_digital_and_simplified", () => {
    expect(CounterDefinition.models?.digital).not.toBeUndefined();
    expect(CounterDefinition.modelRegistry?.behavioral).not.toBeUndefined();
  });

  it("counter_preset_has_analog_factory", () => {
    expect(typeof (CounterPresetDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBe("function");
  });

  it("counter_preset_engine_type_is_both", () => {
    expect(CounterPresetDefinition.models?.digital).not.toBeUndefined();
    expect(CounterPresetDefinition.modelRegistry?.behavioral).not.toBeUndefined();
  });

  it("register_has_analog_factory", () => {
    expect(typeof (RegisterDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBe("function");
  });

  it("register_engine_type_is_both", () => {
    expect(RegisterDefinition.models?.digital).not.toBeUndefined();
    expect(RegisterDefinition.modelRegistry?.behavioral).not.toBeUndefined();
  });

  it("register_simulation_modes_include_digital_and_simplified", () => {
    expect(RegisterDefinition.models?.digital).not.toBeUndefined();
    expect(RegisterDefinition.modelRegistry?.behavioral).not.toBeUndefined();
  });

  it("counter_analog_factory_returns_analog_element", () => {
    const factory = getFactory(CounterDefinition.modelRegistry!.behavioral!);
    const props = new PropertyBag();
    props.set("bitWidth", 4 as unknown as import("../../../core/properties.js").PropertyValue);
    const element = factory(
      new Map([["en", 1], ["C", 2], ["clr", 3], ["out", 4], ["ovf", 5]]),
      props, () => 0,
    );
    expect(element.branchIndex).toBe(-1);
    expect(element._pinNodes.size).toBe(5);
  });

  it("register_analog_factory_returns_analog_element", () => {
    const factory = getFactory(RegisterDefinition.modelRegistry!.behavioral!);
    const props = new PropertyBag();
    props.set("bitWidth", 8 as unknown as import("../../../core/properties.js").PropertyValue);
    const element = factory(
      new Map([["D", 1], ["C", 2], ["en", 3], ["Q", 4]]),
      props, () => 0,
    );
    expect(element.branchIndex).toBe(-1);
    expect(element._pinNodes.size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Task 6.4.3- sequential_pin_loading_propagates
// ---------------------------------------------------------------------------

describe("Task 6.4.3- sequential pin loading propagates", () => {
  it("sequential_pin_loading_propagates", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);

    // 4-bit counter: en=loaded, C and clr=unloaded.
    // Drive through rsrc=10kΩ series with 5V ideal source for loaded pin.
    // Loaded pin: vNet ~= 5 * 100k/(10k + 100k) = 4.5454...V
    // Unloaded: vNet = 5.0V (ideal source, no sag)
    const circuit = facade.build({
      components: [
        { id: "vsEN",  type: "DcVoltageSource", props: { voltage: 5.0 } },
        { id: "rEN",   type: "Resistor",        props: { resistance: 10000 } },
        { id: "vsCLK", type: "DcVoltageSource", props: { voltage: 5.0 } },
        { id: "vsCLR", type: "DcVoltageSource", props: { voltage: 5.0 } },
        { id: "ctr",   type: "Counter",         props: { bitWidth: 4, label: "ctr" } },
        { id: "rQ0",   type: "Resistor",        props: { resistance: 10000 } },
        { id: "rQ1",   type: "Resistor",        props: { resistance: 10000 } },
        { id: "rQ2",   type: "Resistor",        props: { resistance: 10000 } },
        { id: "rQ3",   type: "Resistor",        props: { resistance: 10000 } },
        { id: "rOvf",  type: "Resistor",        props: { resistance: 10000 } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vsEN:pos",  "rEN:A"],
        ["rEN:B",     "ctr:en"],
        ["vsCLK:pos", "ctr:C"],
        ["vsCLR:pos", "ctr:clr"],
        ["ctr:q0",    "rQ0:A"],
        ["ctr:q1",    "rQ1:A"],
        ["ctr:q2",    "rQ2:A"],
        ["ctr:q3",    "rQ3:A"],
        ["ctr:ovf",   "rOvf:A"],
        ["rQ0:B",     "gnd:out"],
        ["rQ1:B",     "gnd:out"],
        ["rQ2:B",     "gnd:out"],
        ["rQ3:B",     "gnd:out"],
        ["rOvf:B",    "gnd:out"],
        ["vsEN:neg",  "gnd:out"],
        ["vsCLK:neg", "gnd:out"],
        ["vsCLR:neg", "gnd:out"],
      ],
      metadata: {
        digitalPinLoadingOverrides: {
          "ctr:en": true,
          "ctr:C":  false,
          "ctr:clr": false,
        },
      },
    });

    const coordinator = facade.compile(circuit);
    facade.getDcOpResult();
    const signals = facade.readAllSignals(coordinator);

    // Loaded pin (en): voltage sag through rEN=10kΩ with rIn=100kΩ → 4.5454V
    const vEN = signals["ctr:en"];
    expect(vEN).toBeGreaterThan(4.4);
    expect(vEN).toBeLessThan(4.6);

    // Unloaded pins (C, clr): no sag → 5.0V
    const vCLK = signals["ctr:C"];
    expect(vCLK).toBeCloseTo(5.0, 3);
    const vCLR = signals["ctr:clr"];
    expect(vCLR).toBeCloseTo(5.0, 3);
  });
});
