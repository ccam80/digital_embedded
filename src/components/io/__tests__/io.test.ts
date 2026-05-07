import { describe, it, expect } from "vitest";
import { createDefaultRegistry } from "../../register-all.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { PropertyValue } from "../../../core/properties.js";
import type { SignalValue } from "../../../compile/types.js";
import type { CircuitElement } from "../../../core/element.js";

// ---------------------------------------------------------------------------
// IO components canonical test set
//   In, Out, Clock, Const, Ground, VDD, NotConnected
//
// Canon set: 9 (Bridge / digital interaction). The Cat-4 hot-load on Const's
// "value" property is also covered (Const is the only IO component with a
// hot-loadable digital data parameter that drives a simulation observable).
// All other Canon categories (1, 2, 3, 5, 6, 7, 8, 10, 11, 12, 13) do not
// apply: these are pure-digital fixed-function components. They have no
// state-pool slots, no NR convergence, no junctions, no LTE rollback path,
// no multiple model presets in modelRegistry, no multi-output digital
// schemas, no forbidden input combinations, and no narrow ports.
//
// Note on Clock: Clock has an analog model (square-wave VSRC stamp + Cat-8
// breakpoints inside acceptStep). Authoring Cat 8 for Clock requires an
// analog harness containing the clock; that is exercised in dedicated
// analog-clock harness tests, not here. The digital surface of Clock is
// what this file owns.
//
// File tier: fixture-only (T1). Each test composes a tiny digital circuit
// with facade.compile and exercises the Cat 9 observation pattern:
// writeByLabel/setComponentProperty -> step -> readByLabel.
// ---------------------------------------------------------------------------

interface IoFixture {
  facade: DefaultSimulatorFacade;
  coordinator: ReturnType<DefaultSimulatorFacade["compile"]>;
  circuit: ReturnType<DefaultSimulatorFacade["build"]>;
}

function digital(value: number): SignalValue {
  return { type: "digital", value };
}

function buildIoFixture(spec: {
  components: Array<{ id: string; type: string; props: Record<string, PropertyValue> }>;
  connections: Array<[string, string]>;
}): IoFixture {
  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build(spec);
  const coordinator = facade.compile(circuit);
  return { facade, coordinator, circuit };
}

function findElementByLabel(fix: IoFixture, label: string): CircuitElement {
  const ltce = fix.coordinator.compiled.labelToCircuitElement;
  const el = ltce.get(label);
  if (el === undefined) {
    throw new Error(
      `findElementByLabel: '${label}' not in labelToCircuitElement (have: ${Array.from(ltce.keys()).join(", ")})`,
    );
  }
  return el;
}

// ===========================================================================
// In  Cat 9 (Bridge / digital)
// ===========================================================================

describe("In  bridge / digital (T1)", () => {
  it("in_value_written_externally_propagates_to_out_one_bit", () => {
    // Cat 9: writeByLabel("A", 1) -> step -> Out(Y) reads 1.
    // executeIn is a no-op; the engine.setSignalValue path supplies the
    // value, and executeOut copies in -> out. The complete write/read is
    // observable through the unified label-keyed signal API.
    const fix = buildIoFixture({
      components: [
        { id: "in1", type: "In",  props: { label: "A", bitWidth: 1 } },
        { id: "ou1", type: "Out", props: { label: "Y", bitWidth: 1 } },
      ],
      connections: [["in1:out", "ou1:in"]],
    });

    fix.coordinator.writeByLabel("A", digital(1));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("Y")).toMatchObject({ type: "digital", value: 1 });

    fix.coordinator.writeByLabel("A", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("Y")).toMatchObject({ type: "digital", value: 0 });

    fix.coordinator.dispose();
  });

  it("in_eight_bit_pattern_passes_through_unchanged", () => {
    // Cat 9 (multi-bit): 0xA5 written to In(A) propagates through Out(Y).
    const fix = buildIoFixture({
      components: [
        { id: "in1", type: "In",  props: { label: "A", bitWidth: 8 } },
        { id: "ou1", type: "Out", props: { label: "Y", bitWidth: 8 } },
      ],
      connections: [["in1:out", "ou1:in"]],
    });

    fix.coordinator.writeByLabel("A", digital(0xA5));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("Y")).toMatchObject({ type: "digital", value: 0xA5 });

    fix.coordinator.dispose();
  });
});

// ===========================================================================
// Out  Cat 9 (Bridge / digital)
// ===========================================================================

describe("Out  bridge / digital (T1)", () => {
  it("out_copies_input_to_observable_output_one_bit", () => {
    // Cat 9: executeOut copies in -> out. After a step, Out(Y)'s readByLabel
    // returns the value driven onto its input pin from In(A).
    const fix = buildIoFixture({
      components: [
        { id: "in1", type: "In",  props: { label: "A", bitWidth: 1 } },
        { id: "ou1", type: "Out", props: { label: "Y", bitWidth: 1 } },
      ],
      connections: [["in1:out", "ou1:in"]],
    });

    fix.coordinator.writeByLabel("A", digital(1));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("Y")).toMatchObject({ type: "digital", value: 1 });

    fix.coordinator.dispose();
  });

  it("out_copies_all_ones_input_eight_bit", () => {
    // Cat 9 (multi-bit): all-ones drive yields 0xFF on the Out display label.
    const fix = buildIoFixture({
      components: [
        { id: "in1", type: "In",  props: { label: "A", bitWidth: 8 } },
        { id: "ou1", type: "Out", props: { label: "Y", bitWidth: 8 } },
      ],
      connections: [["in1:out", "ou1:in"]],
    });

    fix.coordinator.writeByLabel("A", digital(0xFF));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("Y")).toMatchObject({ type: "digital", value: 0xFF });

    fix.coordinator.dispose();
  });
});

// ===========================================================================
// Clock  Cat 9 (Bridge / digital)
// ===========================================================================

describe("Clock  bridge / digital (T1)", () => {
  it("clock_signal_value_observable_through_label_after_step", () => {
    // Cat 9: Clock's executeClock is a no-op (the value is driven externally
    // by the engine's ClockManager). Like In, the bridge observable is the
    // round-trip: writeByLabel sets the externally-managed slot, step()
    // executes the digital pass, and the value is readable via Out.
    const fix = buildIoFixture({
      components: [
        { id: "ck1", type: "Clock", props: { label: "CLK" } },
        { id: "ou1", type: "Out",   props: { label: "Y", bitWidth: 1 } },
      ],
      connections: [["ck1:out", "ou1:in"]],
    });

    fix.coordinator.writeByLabel("CLK", digital(1));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("Y")).toMatchObject({ type: "digital", value: 1 });

    fix.coordinator.writeByLabel("CLK", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("Y")).toMatchObject({ type: "digital", value: 0 });

    fix.coordinator.dispose();
  });
});

// ===========================================================================
// Const  Cat 9 (Bridge / digital) + Cat 4 (param hot-load on `value`)
// ===========================================================================

describe("Const  bridge / digital (T1)", () => {
  it("const_writes_configured_value_to_output_each_step", () => {
    // Cat 9: executeConst reads layout.getProperty(idx, "value") and writes
    // it to the wired output slot. With value=0xBE and bitWidth=8, Out(Y)
    // returns 0xBE after one step.
    const fix = buildIoFixture({
      components: [
        { id: "k1",  type: "Const", props: { label: "K", value: 0xBE, bitWidth: 8 } },
        { id: "ou1", type: "Out",   props: { label: "Y", bitWidth: 8 } },
      ],
      connections: [["k1:out", "ou1:in"]],
    });

    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("Y")).toMatchObject({ type: "digital", value: 0xBE });

    fix.coordinator.dispose();
  });

  it("const_value_zero_writes_zero_to_output", () => {
    // Cat 9: edge case  value=0 yields 0 at Out. Distinguishes "writes the
    // configured value" from "writes some non-zero default".
    const fix = buildIoFixture({
      components: [
        { id: "k1",  type: "Const", props: { label: "K", value: 0, bitWidth: 8 } },
        { id: "ou1", type: "Out",   props: { label: "Y", bitWidth: 8 } },
      ],
      connections: [["k1:out", "ou1:in"]],
    });

    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("Y")).toMatchObject({ type: "digital", value: 0 });

    fix.coordinator.dispose();
  });
});

describe("Const  parameter hot-load (T1)", () => {
  it("hotload_value_changes_const_output", () => {
    // Cat 4: setComponentProperty(constEl, "value", 0x5A) routes through the
    // digital domain via layout.setProperty (coordinator.ts:861). After the
    // next step, executeConst reads the new layout property and writes 0x5A
    // to the output. The closed-form post-change observable is the new
    // value byte itself.
    const fix = buildIoFixture({
      components: [
        { id: "k1",  type: "Const", props: { label: "K", value: 0x12, bitWidth: 8 } },
        { id: "ou1", type: "Out",   props: { label: "Y", bitWidth: 8 } },
      ],
      connections: [["k1:out", "ou1:in"]],
    });

    fix.coordinator.step();
    const before = fix.coordinator.readByLabel("Y");
    expect(before).toMatchObject({ type: "digital", value: 0x12 });

    const constEl = findElementByLabel(fix, "K");
    fix.coordinator.setComponentProperty(constEl, "value", 0x5A);
    fix.coordinator.step();

    const after = fix.coordinator.readByLabel("Y");
    expect(after).toMatchObject({ type: "digital", value: 0x5A });
    expect(after).not.toEqual(before);

    fix.coordinator.dispose();
  });
});

// ===========================================================================
// Ground  Cat 9 (Bridge / digital)
// ===========================================================================

describe("Ground  bridge / digital (T1)", () => {
  it("ground_drives_output_zero_each_step", () => {
    // Cat 9: executeGround writes 0 to its output slot unconditionally.
    // Confirmed by reading the wired Out display label.
    const fix = buildIoFixture({
      components: [
        { id: "g1",  type: "Ground", props: { label: "GND" } },
        { id: "ou1", type: "Out",    props: { label: "Y", bitWidth: 1 } },
      ],
      connections: [["g1:out", "ou1:in"]],
    });

    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("Y")).toMatchObject({ type: "digital", value: 0 });

    fix.coordinator.dispose();
  });

  it("ground_drives_zero_in_multibit_topology", () => {
    // Cat 9 (multi-bit): Ground on an 8-bit net yields 0x00 at the wired
    // Out display.
    const fix = buildIoFixture({
      components: [
        { id: "g1",  type: "Ground", props: { label: "GND", bitWidth: 8 } },
        { id: "ou1", type: "Out",    props: { label: "Y",   bitWidth: 8 } },
      ],
      connections: [["g1:out", "ou1:in"]],
    });

    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("Y")).toMatchObject({ type: "digital", value: 0x00 });

    fix.coordinator.dispose();
  });
});

// ===========================================================================
// VDD  Cat 9 (Bridge / digital)
// ===========================================================================

describe("VDD  bridge / digital (T1)", () => {
  it("vdd_drives_one_bit_high", () => {
    // Cat 9: executeVdd writes 0xFFFFFFFF to its output slot; the bit-width
    // mask is applied by the net resolver. For a 1-bit net the observable
    // value at Out(Y) is 1.
    const fix = buildIoFixture({
      components: [
        { id: "v1",  type: "VDD", props: { label: "VDD", bitWidth: 1 } },
        { id: "ou1", type: "Out", props: { label: "Y",   bitWidth: 1 } },
      ],
      connections: [["v1:out", "ou1:in"]],
    });

    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("Y")).toMatchObject({ type: "digital", value: 1 });

    fix.coordinator.dispose();
  });

  it("vdd_drives_all_ones_eight_bit", () => {
    // Cat 9 (multi-bit): VDD on an 8-bit net  Out reads 0xFF.
    const fix = buildIoFixture({
      components: [
        { id: "v1",  type: "VDD", props: { label: "VDD", bitWidth: 8 } },
        { id: "ou1", type: "Out", props: { label: "Y",   bitWidth: 8 } },
      ],
      connections: [["v1:out", "ou1:in"]],
    });

    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("Y")).toMatchObject({ type: "digital", value: 0xFF });

    fix.coordinator.dispose();
  });
});

// ===========================================================================
// NotConnected  Cat 9 (Bridge / digital)
// ===========================================================================

describe("NotConnected  bridge / digital (T1)", () => {
  it("notconnected_terminates_input_without_disturbing_upstream_signal", () => {
    // Cat 9: NotConnected has an input pin "nc" but its executeFn is a
    // pure no-op (suppresses unconnected-pin warnings only). The bridge
    // observable is that putting NotConnected on a wired output does not
    // disturb the value visible at a parallel Out display.
    //
    //   In(A) ----+---- Out(Y)
    //             |
    //             +---- NotConnected:nc
    //
    // Driving A=1 must still produce Y=1; driving A=0 must still produce
    // Y=0. NotConnected is an "observation hole" that does not write the
    // shared net.
    const fix = buildIoFixture({
      components: [
        { id: "in1", type: "In",            props: { label: "A", bitWidth: 1 } },
        { id: "ou1", type: "Out",           props: { label: "Y", bitWidth: 1 } },
        { id: "nc1", type: "NotConnected",  props: { label: "NC" } },
      ],
      connections: [
        ["in1:out", "ou1:in"],
        ["in1:out", "nc1:nc"],
      ],
    });

    fix.coordinator.writeByLabel("A", digital(1));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("Y")).toMatchObject({ type: "digital", value: 1 });

    fix.coordinator.writeByLabel("A", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("Y")).toMatchObject({ type: "digital", value: 0 });

    fix.coordinator.dispose();
  });
});
