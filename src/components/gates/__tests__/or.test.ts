import { describe, it, expect } from "vitest";
import { createDefaultRegistry } from "../../register-all.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { PropertyValue } from "../../../core/properties.js";
import type { SignalValue } from "../../../compile/types.js";

// ---------------------------------------------------------------------------
// Or gate canonical test set
// Canon categories: 9 (Bridge / digital interaction)
// File tier: fixture-only (digital-only — facade.compile + coordinator
// writeByLabel/step/readByLabel; buildFixture requires an analog domain).
// ---------------------------------------------------------------------------

interface OrFixture {
  facade: DefaultSimulatorFacade;
  coordinator: ReturnType<DefaultSimulatorFacade["compile"]>;
}

function digital(value: number): SignalValue {
  return { type: "digital", value };
}

function buildOrFixture(opts: {
  inputCount: number;
  bitWidth?: number;
  inputLabels?: string[];
}): OrFixture {
  const inputCount = opts.inputCount;
  const bitWidth = opts.bitWidth ?? 1;
  const inputLabels =
    opts.inputLabels ??
    Array.from({ length: inputCount }, (_, i) => `A${i + 1}`);

  const components: Array<{ id: string; type: string; props: Record<string, PropertyValue> }> = [];
  for (let i = 0; i < inputCount; i++) {
    components.push({
      id: `in${i + 1}`,
      type: "In",
      props: { label: inputLabels[i]!, bitWidth },
    });
  }
  components.push({
    id: "or1",
    type: "Or",
    props: { label: "Y", inputCount, bitWidth },
  });
  components.push({
    id: "out1",
    type: "Out",
    props: { label: "OUT", bitWidth },
  });

  const connections: Array<[string, string]> = [];
  for (let i = 0; i < inputCount; i++) {
    connections.push([`in${i + 1}:out`, `or1:In_${i + 1}`]);
  }
  connections.push(["or1:out", "out1:in"]);

  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({ components, connections });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

describe("Or gate — bridge / digital (T1)", () => {
  // -------------------------------------------------------------------------
  // Cat 9 — Bridge / digital interaction
  // -------------------------------------------------------------------------

  it("two_input_one_bit_or_truth_table", () => {
    const fix = buildOrFixture({ inputCount: 2, bitWidth: 1 });
    const cases: Array<[number, number, number]> = [
      [0, 0, 0],
      [0, 1, 1],
      [1, 0, 1],
      [1, 1, 1],
    ];
    for (const [a, b, expected] of cases) {
      fix.coordinator.writeByLabel("A1", digital(a));
      fix.coordinator.writeByLabel("A2", digital(b));
      fix.coordinator.step();
      expect(fix.coordinator.readByLabel("OUT")).toMatchObject({
        type: "digital",
        value: expected,
      });
    }
    fix.coordinator.dispose();
  });

  it("three_input_one_bit_or_truth_table", () => {
    const fix = buildOrFixture({ inputCount: 3, bitWidth: 1 });
    // OR is 1 unless every input is 0.
    const cases: Array<[number, number, number, number]> = [
      [0, 0, 0, 0],
      [1, 0, 0, 1],
      [0, 1, 0, 1],
      [0, 0, 1, 1],
      [1, 1, 0, 1],
      [1, 0, 1, 1],
      [0, 1, 1, 1],
      [1, 1, 1, 1],
    ];
    for (const [a, b, c, expected] of cases) {
      fix.coordinator.writeByLabel("A1", digital(a));
      fix.coordinator.writeByLabel("A2", digital(b));
      fix.coordinator.writeByLabel("A3", digital(c));
      fix.coordinator.step();
      expect(fix.coordinator.readByLabel("OUT")).toMatchObject({
        type: "digital",
        value: expected,
      });
    }
    fix.coordinator.dispose();
  });

  it("multibit_or_is_bitwise", () => {
    // 8-bit-wide Or with two inputs. Documented: bitwise OR of every bit.
    const fix = buildOrFixture({ inputCount: 2, bitWidth: 8 });
    const cases: Array<[number, number, number]> = [
      [0x00, 0x00, 0x00],
      [0x0F, 0xF0, 0xFF],
      [0xAA, 0x55, 0xFF],
      [0x12, 0x34, 0x36],
      [0xFF, 0x00, 0xFF],
    ];
    for (const [a, b, expected] of cases) {
      fix.coordinator.writeByLabel("A1", digital(a));
      fix.coordinator.writeByLabel("A2", digital(b));
      fix.coordinator.step();
      expect(fix.coordinator.readByLabel("OUT")).toMatchObject({
        type: "digital",
        value: expected,
      });
    }
    fix.coordinator.dispose();
  });

  it("single_input_change_propagates_to_output_after_step", () => {
    // Drive output through documented-low all-zero baseline, then flip one
    // input and observe the output change after a single coordinator.step().
    const fix = buildOrFixture({ inputCount: 2, bitWidth: 1 });
    fix.coordinator.writeByLabel("A1", digital(0));
    fix.coordinator.writeByLabel("A2", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({
      type: "digital",
      value: 0,
    });

    fix.coordinator.writeByLabel("A1", digital(1));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({
      type: "digital",
      value: 1,
    });
    fix.coordinator.dispose();
  });

  it("five_input_or_documented_when_all_low_drives_zero", () => {
    // Or gate accepts inputCount up to 5 (propertyDefs.max = 5).
    // Documented contract: all-zero inputs → zero output. Single high input
    // anywhere drives the output high.
    const fix = buildOrFixture({ inputCount: 5, bitWidth: 1 });
    for (let i = 1; i <= 5; i++) fix.coordinator.writeByLabel(`A${i}`, digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({
      type: "digital",
      value: 0,
    });

    // Flip the middle input only.
    fix.coordinator.writeByLabel("A3", digital(1));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({
      type: "digital",
      value: 1,
    });
    fix.coordinator.dispose();
  });

  it("32bit_or_full_width_is_bitwise", () => {
    // bitWidth=32 — exercise the high bit (sign-bit boundary in JS uint32
    // semantics). Documented contract: bitwise OR.
    const fix = buildOrFixture({ inputCount: 2, bitWidth: 32 });
    const A = 0xF0F0F0F0;
    const B = 0x0F0F0F0F;
    fix.coordinator.writeByLabel("A1", digital(A));
    fix.coordinator.writeByLabel("A2", digital(B));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT")).toMatchObject({
      type: "digital",
      value: 0xFFFFFFFF,
    });
    fix.coordinator.dispose();
  });
});
