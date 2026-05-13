import { describe, it, expect } from "vitest";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import type { Fixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// Programmatic fixture builder (T1) - Cat 9
//
// Topology:
//   In(A) --out--> Buf(U1).In_1
//   Buf(U1).out --> Out(Y)
//   Buf(U1).out --> Rload --> Ground   (gives buildFixture an analog domain
//                                       via the digital->analog boundary)
//
// The Buf gate's applicable canon category is Cat 9 (Bridge / digital
// interaction): models.digital.executeFn = executeBuf. The In->Buf->Out wire
// chain stays in the digital domain end-to-end; the Rload->GND tap on Buf.out
// crosses the domain boundary so the unified compiler emits a bridge adapter
// and the analog engine is non-null.
// ---------------------------------------------------------------------------

interface BufCircuitParams {
  bitWidth?: number;
}

function buildBufCircuit(
  facade: DefaultSimulatorFacade,
  p: BufCircuitParams = {},
): Circuit {
  const bitWidth = p.bitWidth ?? 1;
  return facade.build({
    components: [
      { id: "A",     type: "In",       props: { label: "A", bitWidth } },
      { id: "U1",    type: "Buf",      props: { label: "U1", bitWidth } },
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
// Buf gate Cat 9 - digital input drives digital output through the gate (T1)
// ---------------------------------------------------------------------------

describe("Buf gate Cat 9 - digital interaction (T1)", () => {
  it("digital_input_high_drives_output_high_1bit", () => {
    // Cat 9 (single-bit): A=1 => Y = 1 (pass-through).
    const fix = buildFixture({
      build: (_r, facade) => buildBufCircuit(facade, { bitWidth: 1 }),
    });
    writeDigital(fix, "A", 1);
    fix.coordinator.step();
    expect(readDigital(fix, "Y")).toBe(1);
    fix.coordinator.dispose();
  });

  it("digital_input_low_drives_output_low_1bit", () => {
    // Cat 9 (single-bit): A=0 => Y = 0 (pass-through).
    const fix = buildFixture({
      build: (_r, facade) => buildBufCircuit(facade, { bitWidth: 1 }),
    });
    writeDigital(fix, "A", 0);
    fix.coordinator.step();
    expect(readDigital(fix, "Y")).toBe(0);
    fix.coordinator.dispose();
  });

  it("digital_input_toggle_drives_output_same_1bit", () => {
    // Cat 9: contrast assertion - flipping A flips Y to the same value (identity).
    const fix = buildFixture({
      build: (_r, facade) => buildBufCircuit(facade, { bitWidth: 1 }),
    });

    writeDigital(fix, "A", 1);
    fix.coordinator.step();
    const yWhenAHigh = readDigital(fix, "Y");

    writeDigital(fix, "A", 0);
    fix.coordinator.step();
    const yWhenALow = readDigital(fix, "Y");

    expect(yWhenAHigh).toBe(1);
    expect(yWhenALow).toBe(0);
    expect(yWhenAHigh).not.toBe(yWhenALow);
    fix.coordinator.dispose();
  });

  it("digital_8bit_input_passes_through_unchanged", () => {
    // Cat 9 (multi-bit): A=0x0F over 8-bit port => Y = 0x0F (identity).
    const fix = buildFixture({
      build: (_r, facade) => buildBufCircuit(facade, { bitWidth: 8 }),
    });
    writeDigital(fix, "A", 0x0F);
    fix.coordinator.step();
    expect(readDigital(fix, "Y")).toBe(0x0F);
    fix.coordinator.dispose();
  });

  it("digital_8bit_alternating_pattern_passes_through", () => {
    // Cat 9 (multi-bit): A=0xAA over 8-bit port => Y = 0xAA (identity).
    const fix = buildFixture({
      build: (_r, facade) => buildBufCircuit(facade, { bitWidth: 8 }),
    });
    writeDigital(fix, "A", 0xAA);
    fix.coordinator.step();
    expect(readDigital(fix, "Y")).toBe(0xAA);
    fix.coordinator.dispose();
  });

  it("digital_8bit_all_ones_passes_through", () => {
    // Cat 9 (multi-bit): A=0xFF over 8-bit port => Y = 0xFF (identity).
    const fix = buildFixture({
      build: (_r, facade) => buildBufCircuit(facade, { bitWidth: 8 }),
    });
    writeDigital(fix, "A", 0xFF);
    fix.coordinator.step();
    expect(readDigital(fix, "Y")).toBe(0xFF);
    fix.coordinator.dispose();
  });

  it("digital_8bit_zero_passes_through", () => {
    // Cat 9 (multi-bit): A=0x00 over 8-bit port => Y = 0x00 (identity).
    const fix = buildFixture({
      build: (_r, facade) => buildBufCircuit(facade, { bitWidth: 8 }),
    });
    writeDigital(fix, "A", 0x00);
    fix.coordinator.step();
    expect(readDigital(fix, "Y")).toBe(0x00);
    fix.coordinator.dispose();
  });

  it("digital_double_buffer_is_identity", () => {
    // Cat 9: buf(x) = x. Drive A with a value; the output matches A exactly.
    const fix = buildFixture({
      build: (_r, facade) => buildBufCircuit(facade, { bitWidth: 8 }),
    });

    const original = 0x5A;
    writeDigital(fix, "A", original);
    fix.coordinator.step();
    expect(readDigital(fix, "Y")).toBe(original);
    fix.coordinator.dispose();
  });
});
