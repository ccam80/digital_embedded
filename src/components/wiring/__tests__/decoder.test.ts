import { describe, it, expect } from "vitest";
import { createDefaultRegistry } from "../../register-all.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { PropertyValue } from "../../../core/properties.js";
import type { SignalValue } from "../../../compile/types.js";

// ---------------------------------------------------------------------------
// Decoder canonical test set
// Canon categories: 9 (Bridge / digital interaction), 11 (Multi-output digital
//   observability — sel=k drives out_k=1 and every other out_j=0 on the same
//   simulator step; multiple outputs are observed independently).
// File tier: fixture-only (digital-only — facade.compile + coordinator
//   writeByLabel/step/readByLabel; buildFixture requires an analog domain).
// ---------------------------------------------------------------------------

interface DecoderFixture {
  facade: DefaultSimulatorFacade;
  coordinator: ReturnType<DefaultSimulatorFacade["compile"]>;
}

function digital(value: number): SignalValue {
  return { type: "digital", value };
}

function buildDecoderFixture(opts: {
  selectorBits: number;
}): DecoderFixture {
  const selectorBits = opts.selectorBits;
  const outCount = 1 << selectorBits;

  const components: Array<{ id: string; type: string; props: Record<string, PropertyValue> }> = [
    { id: "selIn", type: "In", props: { label: "SEL", bitWidth: selectorBits } },
    { id: "dec1", type: "Decoder", props: { label: "DEC", selectorBits } },
  ];
  for (let i = 0; i < outCount; i++) {
    components.push({
      id: `out${i}`,
      type: "Out",
      props: { label: `OUT_${i}`, bitWidth: 1 },
    });
  }

  const connections: Array<[string, string]> = [
    ["selIn:out", "dec1:sel"],
  ];
  for (let i = 0; i < outCount; i++) {
    connections.push([`dec1:out_${i}`, `out${i}:in`]);
  }

  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({ components, connections });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

describe("Decoder — bridge / digital (T1)", () => {
  // -------------------------------------------------------------------------
  // Cat 9 — Bridge / digital interaction
  // 1-bit selector: sel=0 → out_0=1, out_1=0; sel=1 → out_0=0, out_1=1.
  // -------------------------------------------------------------------------

  it("one_bit_selector_one_hot_truth_table", () => {
    const fix = buildDecoderFixture({ selectorBits: 1 });
    fix.coordinator.writeByLabel("SEL", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT_0")).toMatchObject({ type: "digital", value: 1 });
    expect(fix.coordinator.readByLabel("OUT_1")).toMatchObject({ type: "digital", value: 0 });

    fix.coordinator.writeByLabel("SEL", digital(1));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT_0")).toMatchObject({ type: "digital", value: 0 });
    expect(fix.coordinator.readByLabel("OUT_1")).toMatchObject({ type: "digital", value: 1 });
    fix.coordinator.dispose();
  });

  // -------------------------------------------------------------------------
  // Cat 9 — Bridge / digital interaction
  // 2-bit selector: full one-hot truth table (sel=0..3 drives out_k=1 with all
  // other outputs 0).
  // -------------------------------------------------------------------------

  it("two_bit_selector_full_one_hot_truth_table", () => {
    const fix = buildDecoderFixture({ selectorBits: 2 });
    for (let sel = 0; sel < 4; sel++) {
      fix.coordinator.writeByLabel("SEL", digital(sel));
      fix.coordinator.step();
      for (let i = 0; i < 4; i++) {
        expect(fix.coordinator.readByLabel(`OUT_${i}`)).toMatchObject({
          type: "digital",
          value: i === sel ? 1 : 0,
        });
      }
    }
    fix.coordinator.dispose();
  });

  // -------------------------------------------------------------------------
  // Cat 9 — Bridge / digital interaction
  // 3-bit selector exercises a wider input bus and 8 outputs. Documented
  // contract: out_k = (sel === k ? 1 : 0). Pick three selector values that
  // exercise low/middle/high index space and confirm every output bit.
  // -------------------------------------------------------------------------

  it("three_bit_selector_drives_correct_one_hot_for_low_mid_high_indices", () => {
    const fix = buildDecoderFixture({ selectorBits: 3 });
    for (const sel of [0, 3, 7]) {
      fix.coordinator.writeByLabel("SEL", digital(sel));
      fix.coordinator.step();
      for (let i = 0; i < 8; i++) {
        expect(fix.coordinator.readByLabel(`OUT_${i}`)).toMatchObject({
          type: "digital",
          value: i === sel ? 1 : 0,
        });
      }
    }
    fix.coordinator.dispose();
  });

  // -------------------------------------------------------------------------
  // Cat 9 — Bridge / digital interaction
  // Selector change propagates through coordinator.step(): an output that was
  // high goes low after re-selecting a different output, and vice versa, on
  // the same fixture instance.
  // -------------------------------------------------------------------------

  it("selector_change_propagates_to_outputs_after_step", () => {
    const fix = buildDecoderFixture({ selectorBits: 2 });
    fix.coordinator.writeByLabel("SEL", digital(1));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT_1")).toMatchObject({ type: "digital", value: 1 });
    expect(fix.coordinator.readByLabel("OUT_2")).toMatchObject({ type: "digital", value: 0 });

    // Re-select a different output. OUT_1 must drop, OUT_2 must rise.
    fix.coordinator.writeByLabel("SEL", digital(2));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT_1")).toMatchObject({ type: "digital", value: 0 });
    expect(fix.coordinator.readByLabel("OUT_2")).toMatchObject({ type: "digital", value: 1 });
    fix.coordinator.dispose();
  });

  // -------------------------------------------------------------------------
  // Cat 11 — Multi-output digital observability
  // outputSchema for a Decoder with selectorBits=N declares 2^N output pins
  // (out_0 .. out_{N-1}) which take independent values for the same input
  // combination. Cat 11 requires every declared output be read independently
  // on the same step. Verified for selectorBits=2: a single sel=k step
  // produces 4 outputs that read independently as one-hot.
  // -------------------------------------------------------------------------

  it("two_bit_decoder_emits_four_outputs_independently_on_single_step", () => {
    // sel=2 → out_0=0, out_1=0, out_2=1, out_3=0 — every output observed
    // independently after one coordinator.step().
    const fix = buildDecoderFixture({ selectorBits: 2 });
    fix.coordinator.writeByLabel("SEL", digital(2));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT_0")).toMatchObject({ type: "digital", value: 0 });
    expect(fix.coordinator.readByLabel("OUT_1")).toMatchObject({ type: "digital", value: 0 });
    expect(fix.coordinator.readByLabel("OUT_2")).toMatchObject({ type: "digital", value: 1 });
    expect(fix.coordinator.readByLabel("OUT_3")).toMatchObject({ type: "digital", value: 0 });
    fix.coordinator.dispose();
  });

  // -------------------------------------------------------------------------
  // Cat 9 — Bridge / digital interaction
  // 4-bit selector covers the propertyDefs.max bound (selectorBits in [1, 4]).
  // 16 outputs; verify low / mid / high selector values all drive the
  // documented one-hot pattern.
  // -------------------------------------------------------------------------

  it("four_bit_selector_max_width_drives_correct_one_hot", () => {
    const fix = buildDecoderFixture({ selectorBits: 4 });
    for (const sel of [0, 5, 10, 15]) {
      fix.coordinator.writeByLabel("SEL", digital(sel));
      fix.coordinator.step();
      for (let i = 0; i < 16; i++) {
        expect(fix.coordinator.readByLabel(`OUT_${i}`)).toMatchObject({
          type: "digital",
          value: i === sel ? 1 : 0,
        });
      }
    }
    fix.coordinator.dispose();
  });
});
