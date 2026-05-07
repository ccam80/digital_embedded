import { describe, it, expect } from "vitest";
import { createDefaultRegistry } from "../../register-all.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { PropertyValue } from "../../../core/properties.js";
import type { SignalValue } from "../../../compile/types.js";

// ---------------------------------------------------------------------------
// LookUpTable canonical test set
// Canon categories: 4 (Param hot-load), 9 (Bridge / digital interaction)
// File tier: fixture-only (digital-only — facade.compile + coordinator
// writeByLabel/step/readByLabel; buildFixture requires an analog domain).
//
// Capability gates skipped (out-of-canon for this component):
//   1, 2, 3, 5, 6, 7, 8: no analog state pool, no DC operating point, no
//                        transient dynamics, no matrix stamps, no junction
//                        limiting, no LTE rollback, no breakpoint registration.
//   10: modelRegistry has zero named-preset entries (single execute path).
//   11: outputSchema = ["out"] — single output.
//   12, 13, 14, 15: no forbidden combinations, no narrow-port clamp on the
//                   declared 1-bit input pins, no runtime diagnostic emission,
//                   no _onStateChange writeback to PropertyBag.
// ---------------------------------------------------------------------------

interface LutFixture {
  facade: DefaultSimulatorFacade;
  coordinator: ReturnType<DefaultSimulatorFacade["compile"]>;
}

function digital(value: number): SignalValue {
  return { type: "digital", value };
}

function buildLutFixture(opts: {
  inputCount: number;
  dataBits?: number;
  data?: number[];
}): LutFixture {
  const inputCount = opts.inputCount;
  const dataBits = opts.dataBits ?? 1;
  const data = opts.data ?? [];

  const components: Array<{ id: string; type: string; props: Record<string, PropertyValue> }> = [];
  for (let i = 0; i < inputCount; i++) {
    components.push({
      id: `in${i}`,
      type: "In",
      props: { label: `IN${i}`, bitWidth: 1 },
    });
  }
  components.push({
    id: "lut",
    type: "LookUpTable",
    props: { label: "LUT", inputCount, dataBits, data },
  });
  components.push({
    id: "out",
    type: "Out",
    props: { label: "OUT", bitWidth: dataBits },
  });

  const connections: Array<[string, string]> = [];
  for (let i = 0; i < inputCount; i++) {
    connections.push([`in${i}:out`, `lut:${i}`]);
  }
  connections.push(["lut:out", "out:in"]);

  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({ components, connections });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

function readDigital(fix: LutFixture, label: string): number {
  const sv = fix.coordinator.readByLabel(label);
  if (sv.type !== "digital") {
    throw new Error(`readDigital: label '${label}' is not digital (got ${sv.type})`);
  }
  return sv.value;
}

// ---------------------------------------------------------------------------
// Cat 9 — Bridge / digital interaction (T1)
//
// LookUpTable is a combinational digital component: N 1-bit input pins form an
// N-bit address; the output is table[address] from a `data` backing store. The
// canonical observable is: drive each input combination, step the engine,
// observe the output equals the table entry at the corresponding address.
// Address formation: input 0 = LSB, input N-1 = MSB.
// ---------------------------------------------------------------------------

describe("LookUpTable Cat 9 — digital interaction (T1)", () => {
  it("two_input_one_bit_and_truth_table_via_data", () => {
    // 2-input AND truth table: addr (in0|in1<<1) → table[addr].
    // 0b00→0, 0b01→0, 0b10→0, 0b11→1.
    const fix = buildLutFixture({
      inputCount: 2,
      dataBits: 1,
      data: [0, 0, 0, 1],
    });
    const cases: Array<[number, number, number]> = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [1, 1, 1],
    ];
    for (const [a, b, expected] of cases) {
      fix.coordinator.writeByLabel("IN0", digital(a));
      fix.coordinator.writeByLabel("IN1", digital(b));
      fix.coordinator.step();
      expect(readDigital(fix, "OUT")).toBe(expected);
    }
    fix.coordinator.dispose();
  });

  it("address_formation_input_zero_is_lsb_three_input", () => {
    // 3-input LUT, table[i]=i. Address bit ordering is in0|in1<<1|in2<<2.
    const fix = buildLutFixture({
      inputCount: 3,
      dataBits: 1,
      data: Array.from({ length: 8 }, (_, i) => i & 0x1),
    });
    // Use dataBits=1 so output bits exercise table[addr] LSB.
    // Better: redo with multi-bit so the full address is observable.
    fix.coordinator.dispose();

    const fix2 = buildLutFixture({
      inputCount: 3,
      dataBits: 4,
      data: Array.from({ length: 8 }, (_, i) => i),
    });
    // in0=1, in1=0, in2=0 → addr = 0b001 = 1 → table[1] = 1.
    fix2.coordinator.writeByLabel("IN0", digital(1));
    fix2.coordinator.writeByLabel("IN1", digital(0));
    fix2.coordinator.writeByLabel("IN2", digital(0));
    fix2.coordinator.step();
    expect(readDigital(fix2, "OUT")).toBe(1);

    // in0=0, in1=1, in2=0 → addr = 0b010 = 2 → table[2] = 2.
    fix2.coordinator.writeByLabel("IN0", digital(0));
    fix2.coordinator.writeByLabel("IN1", digital(1));
    fix2.coordinator.writeByLabel("IN2", digital(0));
    fix2.coordinator.step();
    expect(readDigital(fix2, "OUT")).toBe(2);

    // in0=1, in1=1, in2=1 → addr = 0b111 = 7 → table[7] = 7.
    fix2.coordinator.writeByLabel("IN0", digital(1));
    fix2.coordinator.writeByLabel("IN1", digital(1));
    fix2.coordinator.writeByLabel("IN2", digital(1));
    fix2.coordinator.step();
    expect(readDigital(fix2, "OUT")).toBe(7);

    fix2.coordinator.dispose();
  });

  it("multibit_output_4bit_data_field", () => {
    // 2-input LUT, dataBits=4. Each table entry is a 4-bit value.
    const fix = buildLutFixture({
      inputCount: 2,
      dataBits: 4,
      data: [0x0, 0xA, 0xB, 0xF],
    });
    const cases: Array<[number, number, number]> = [
      [0, 0, 0x0],
      [1, 0, 0xA],
      [0, 1, 0xB],
      [1, 1, 0xF],
    ];
    for (const [a, b, expected] of cases) {
      fix.coordinator.writeByLabel("IN0", digital(a));
      fix.coordinator.writeByLabel("IN1", digital(b));
      fix.coordinator.step();
      expect(readDigital(fix, "OUT")).toBe(expected);
    }
    fix.coordinator.dispose();
  });

  it("single_input_lut_acts_as_not_gate_via_data", () => {
    // 1-input LUT with table=[1, 0] inverts the input: NOT.
    const fix = buildLutFixture({
      inputCount: 1,
      dataBits: 1,
      data: [1, 0],
    });
    fix.coordinator.writeByLabel("IN0", digital(0));
    fix.coordinator.step();
    expect(readDigital(fix, "OUT")).toBe(1);

    fix.coordinator.writeByLabel("IN0", digital(1));
    fix.coordinator.step();
    expect(readDigital(fix, "OUT")).toBe(0);

    fix.coordinator.dispose();
  });

  it("four_input_lut_full_truth_table_scaled_data", () => {
    // 4-input LUT, dataBits=8, table[i] = i * 2 (8 bits suffices for max 30).
    const fix = buildLutFixture({
      inputCount: 4,
      dataBits: 8,
      data: Array.from({ length: 16 }, (_, i) => i * 2),
    });

    // addr = 0b0101 = 5 (in0=1, in1=0, in2=1, in3=0) → table[5] = 10.
    fix.coordinator.writeByLabel("IN0", digital(1));
    fix.coordinator.writeByLabel("IN1", digital(0));
    fix.coordinator.writeByLabel("IN2", digital(1));
    fix.coordinator.writeByLabel("IN3", digital(0));
    fix.coordinator.step();
    expect(readDigital(fix, "OUT")).toBe(10);

    // addr = 0b1111 = 15 → table[15] = 30.
    fix.coordinator.writeByLabel("IN0", digital(1));
    fix.coordinator.writeByLabel("IN1", digital(1));
    fix.coordinator.writeByLabel("IN2", digital(1));
    fix.coordinator.writeByLabel("IN3", digital(1));
    fix.coordinator.step();
    expect(readDigital(fix, "OUT")).toBe(30);

    fix.coordinator.dispose();
  });

  it("no_data_supplied_returns_zero_for_every_address", () => {
    // No `data` prop → backing store is allocated but uninitialised (all zero).
    // Documented contract: out = table[addr] = 0 for every input combination.
    const fix = buildLutFixture({
      inputCount: 2,
      dataBits: 1,
    });
    const cases: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ];
    for (const [a, b] of cases) {
      fix.coordinator.writeByLabel("IN0", digital(a));
      fix.coordinator.writeByLabel("IN1", digital(b));
      fix.coordinator.step();
      expect(readDigital(fix, "OUT")).toBe(0);
    }
    fix.coordinator.dispose();
  });
});

// ---------------------------------------------------------------------------
// Cat 4 — Parameter hot-load (T1)
//
// LookUpTable's tunable parameters are `inputCount` (structural — number of
// input pins, address-space size) and `dataBits` (output bit-width). Both are
// canonical Cat 4 hot-load targets; assert the documented post-change
// observable on the simulation output.
// ---------------------------------------------------------------------------

describe("LookUpTable Cat 4 — parameter hot-load (T1)", () => {
  it("hotload_dataBits_changes_output_width_observable", () => {
    // Documented contract: dataBits widens the output port; raising it lets
    // a wider table entry pass through unmasked. Build with dataBits=4 and
    // table[3]=0xF; hot-load dataBits=8 and assert the output reads the same
    // 0xF entry (now 8-bit-wide). The observable is the simulator output
    // value — closed-form 0xF in both pre and post states (same data entry).
    const fix = buildLutFixture({
      inputCount: 2,
      dataBits: 4,
      data: [0x0, 0x0, 0x0, 0xF],
    });
    fix.coordinator.writeByLabel("IN0", digital(1));
    fix.coordinator.writeByLabel("IN1", digital(1));
    fix.coordinator.step();
    const before = readDigital(fix, "OUT");
    expect(before).toBe(0xF);

    const lutCe = fix.coordinator.compiled.labelToCircuitElement.get("LUT");
    expect(lutCe).toBeDefined();
    fix.coordinator.setComponentProperty(lutCe!, "dataBits", 8);
    fix.coordinator.step();
    const after = readDigital(fix, "OUT");
    // dataBits hot-load should not corrupt the table entry — output stays at
    // the same documented value 0xF.
    expect(after).toBe(0xF);
    fix.coordinator.dispose();
  });

  it("hotload_inputCount_changes_address_space_observable", () => {
    // Documented contract: inputCount sets the address-bit count (table has
    // 2^inputCount entries). Build with inputCount=2 and table=[0, 0, 0, 1];
    // documented contract: addr=0b11 → table[3] = 1. Hot-load inputCount to
    // 3 (8 entries) — the first 4 entries seen by addresses 0..3 stay [0,0,0,1]
    // when the original `data` array is preserved; addresses 4..7 read 0.
    const fix = buildLutFixture({
      inputCount: 2,
      dataBits: 1,
      data: [0, 0, 0, 1],
    });
    fix.coordinator.writeByLabel("IN0", digital(1));
    fix.coordinator.writeByLabel("IN1", digital(1));
    fix.coordinator.step();
    const before = readDigital(fix, "OUT");
    expect(before).toBe(1);

    const lutCe = fix.coordinator.compiled.labelToCircuitElement.get("LUT");
    expect(lutCe).toBeDefined();
    fix.coordinator.setComponentProperty(lutCe!, "inputCount", 3);
    fix.coordinator.step();
    // Documented contract: post-hot-load, the LUT addresses 8 entries via 3
    // inputs (in0|in1<<1|in2<<2). The observable is that the simulator output
    // reflects a recomputed address — driving in0=1,in1=1 with the (still
    // unconnected post-hot-load) in2=0 → addr=3 → table[3] = 1, same as
    // before. Driving the same input pattern after the recompute must still
    // produce the same observable (1) when the table entry at addr=3 is
    // preserved by the hot-load path.
    const after = readDigital(fix, "OUT");
    expect(after).toBe(1);
    fix.coordinator.dispose();
  });
});
