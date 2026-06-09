import { describe, it, expect } from "vitest";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import type { Fixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// Programmatic fixture builder (T1) — Cat 9
//
// Topology:
//   In(A) ──out──► Not(U1).in
//   Not(U1).out ──► Out(Y)
//   Not(U1).out ──► Rload ──► Ground   (gives buildFixture an analog domain
//                                       via the digital→analog boundary)
//
// The Not gate's only applicable canon category is Cat 9 (Bridge / digital
// interaction): models.digital.executeFn = executeNot. The In→Not→Out wire
// chain stays in the digital domain end-to-end; the Rload→GND tap on Not.out
// crosses the cross-domain boundary so the unified compiler emits a bridge
// adapter and the analog engine is non-null. This keeps the canonical Cat 9
// observation surface — writeByLabel('A', ...); step(); readByLabel('Y') —
// while satisfying buildFixture's "must have analog domain" precondition.
// ---------------------------------------------------------------------------

interface NotCircuitParams {
  bitWidth?: number;
}

function buildNotInverterCircuit(
  facade: DefaultSimulatorFacade,
  p: NotCircuitParams = {},
): Circuit {
  const bitWidth = p.bitWidth ?? 1;
  return facade.build({
    components: [
      { id: "A",     type: "In",       props: { label: "A", bitWidth } },
      { id: "U1",    type: "Not",      props: { label: "U1", bitWidth } },
      { id: "Y",     type: "Out",      props: { label: "Y", bitWidth } },
      { id: "Rload", type: "Resistor", props: { label: "Rload", resistance: 1e6 } },
      { id: "gnd",   type: "Ground",   props: { label: "gnd" } },
    ],
    connections: [
      ["A:out",     "U1:In_1"],
      ["U1:out",    "Y:in"],
      ["U1:out",    "Rload:pos"],
      ["Rload:neg", "gnd:out"],
    ],
  });
}

function readDigital(fix: Fixture, label: string): number {
  const sv = fix.coordinator.readByLabel(label);
  if (sv.type !== "digital") {
    throw new Error(`readDigital: label '${label}' is not digital (got ${sv.type})`);
  }
  return sv.value;
}

function writeDigital(fix: Fixture, label: string, value: number): void {
  fix.coordinator.writeByLabel(label, { type: "digital", value });
}

// ---------------------------------------------------------------------------
// Not gate Cat 9 — digital input drives digital output through the gate (T1)
// ---------------------------------------------------------------------------

describe("Not gate Cat 9 — digital interaction (T1)", () => {
  it("digital_input_high_drives_output_low_1bit", () => {
    // Cat 9 (single-bit): A=1 ⇒ Y = ~1 & 0x1 = 0.
    const fix = buildFixture({
      build: (_r, facade) => buildNotInverterCircuit(facade, { bitWidth: 1 }),
    });
    writeDigital(fix, "A", 1);
    fix.coordinator.step();
    expect(readDigital(fix, "Y")).toBe(0);
    fix.coordinator.dispose();
  });

  it("digital_input_low_drives_output_high_1bit", () => {
    // Cat 9 (single-bit): A=0 ⇒ Y = ~0 & 0x1 = 1.
    const fix = buildFixture({
      build: (_r, facade) => buildNotInverterCircuit(facade, { bitWidth: 1 }),
    });
    writeDigital(fix, "A", 0);
    fix.coordinator.step();
    expect(readDigital(fix, "Y")).toBe(1);
    fix.coordinator.dispose();
  });

  it("digital_input_toggle_drives_output_inverse_1bit", () => {
    // Cat 9: contrast assertion — flipping A flips Y to its complement.
    const fix = buildFixture({
      build: (_r, facade) => buildNotInverterCircuit(facade, { bitWidth: 1 }),
    });

    writeDigital(fix, "A", 1);
    fix.coordinator.step();
    const yWhenAHigh = readDigital(fix, "Y");

    writeDigital(fix, "A", 0);
    fix.coordinator.step();
    const yWhenALow = readDigital(fix, "Y");

    expect(yWhenAHigh).toBe(0);
    expect(yWhenALow).toBe(1);
    expect(yWhenAHigh).not.toBe(yWhenALow);
    fix.coordinator.dispose();
  });

  it("digital_8bit_input_inverts_to_complement_byte", () => {
    // Cat 9 (multi-bit): A=0x0F over 8-bit port ⇒ Y = ~0x0F & 0xFF = 0xF0.
    const fix = buildFixture({
      build: (_r, facade) => buildNotInverterCircuit(facade, { bitWidth: 8 }),
    });
    writeDigital(fix, "A", 0x0F);
    fix.coordinator.step();
    expect(readDigital(fix, "Y")).toBe(0xF0);
    fix.coordinator.dispose();
  });

  it("digital_8bit_alternating_pattern_inverts_to_complement", () => {
    // Cat 9 (multi-bit): A=0xAA over 8-bit port ⇒ Y = ~0xAA & 0xFF = 0x55.
    const fix = buildFixture({
      build: (_r, facade) => buildNotInverterCircuit(facade, { bitWidth: 8 }),
    });
    writeDigital(fix, "A", 0xAA);
    fix.coordinator.step();
    expect(readDigital(fix, "Y")).toBe(0x55);
    fix.coordinator.dispose();
  });

  it("digital_8bit_all_ones_inverts_to_zero", () => {
    // Cat 9 (multi-bit): A=0xFF over 8-bit port ⇒ Y = ~0xFF & 0xFF = 0x00.
    const fix = buildFixture({
      build: (_r, facade) => buildNotInverterCircuit(facade, { bitWidth: 8 }),
    });
    writeDigital(fix, "A", 0xFF);
    fix.coordinator.step();
    expect(readDigital(fix, "Y")).toBe(0x00);
    fix.coordinator.dispose();
  });

  it("digital_8bit_zero_inverts_to_all_ones", () => {
    // Cat 9 (multi-bit): A=0x00 over 8-bit port ⇒ Y = ~0x00 & 0xFF = 0xFF.
    const fix = buildFixture({
      build: (_r, facade) => buildNotInverterCircuit(facade, { bitWidth: 8 }),
    });
    writeDigital(fix, "A", 0x00);
    fix.coordinator.step();
    expect(readDigital(fix, "Y")).toBe(0xFF);
    fix.coordinator.dispose();
  });

  it("digital_double_inversion_is_identity", () => {
    // Cat 9: ~~x = x (within port width). Two cascaded toggles end at the
    // original value — observable through one Not and re-driving the input.
    const fix = buildFixture({
      build: (_r, facade) => buildNotInverterCircuit(facade, { bitWidth: 8 }),
    });

    const original = 0x12;

    writeDigital(fix, "A", original);
    fix.coordinator.step();
    const inverted = readDigital(fix, "Y");
    expect(inverted).toBe((~original) & 0xFF);

    // Re-drive A with the inverted value; the Not gate's complement of the
    // complement returns to the original byte.
    writeDigital(fix, "A", inverted);
    fix.coordinator.step();
    expect(readDigital(fix, "Y")).toBe(original);
    fix.coordinator.dispose();
  });
});
