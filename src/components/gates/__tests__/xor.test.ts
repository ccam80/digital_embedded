/**
 * Canonical tests for the XOr gate component.
 *
 * Tier: fixture-only (pure-digital combinational; no analog domain).
 * Driver: facade.build({components, connections}) + facade.compile() + setSignal / step / readSignal.
 *
 * Canon coverage:
 *   - Cat 9 (digital interaction): drive labelled inputs, step, assert labelled output.
 *   - Cat 4 (param hot-load): BLOCKED. XOr's propertyDefs (buildStandardGatePropertyDefs
 *     in src/components/gates/gate-shared.ts) declare every behavioral parameter
 *     (`inputCount`, `bitWidth`, `wideShape`) as `structural: true`. The remaining
 *     keys (`_inverterLabels`, `label`) are XML-attribute / metadata, not behavioral
 *     simulation parameters. There is no non-structural behavioral parameter
 *     documented as hot-loadable on this component, so the canonical Cat 4 worked
 *     template (single fixture, mutate via setComponentProperty, assert post-change
 *     observable) has no candidate parameter. See Escalations.
 */

import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../components/register-all.js";
import type { SimulationCoordinator } from "../../../solver/coordinator-types.js";
import type { Circuit } from "../../../core/circuit.js";

const registry = createDefaultRegistry();

// ---------------------------------------------------------------------------
// Canonical builder for an XOr gate driven by labelled In ports and observed
// via a labelled Out port.
// ---------------------------------------------------------------------------

interface DigitalFixture {
  facade: DefaultSimulatorFacade;
  coordinator: SimulationCoordinator;
  circuit: Circuit;
}

function buildDigital(spec: {
  components: ReadonlyArray<{ id: string; type: string; props: Record<string, number | string | boolean> }>;
  connections: ReadonlyArray<readonly [string, string]>;
}): DigitalFixture {
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({
    components: spec.components.map((c) => ({ id: c.id, type: c.type, props: c.props })),
    connections: spec.connections.map((c) => [c[0], c[1]] as [string, string]),
  });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator, circuit };
}

function drive(fix: DigitalFixture, values: Record<string, number>): void {
  for (const [label, value] of Object.entries(values)) {
    fix.facade.setSignal(fix.coordinator, label, value);
  }
  fix.facade.step(fix.coordinator);
}

function read(fix: DigitalFixture, label: string): number {
  return fix.facade.readSignal(fix.coordinator, label) as number;
}

// ---------------------------------------------------------------------------
// 2-input XOr fixture
// ---------------------------------------------------------------------------

function buildXor2Fixture(bitWidth: number): DigitalFixture {
  return buildDigital({
    components: [
      { id: "a",   type: "In",  props: { label: "A", bitWidth } },
      { id: "b",   type: "In",  props: { label: "B", bitWidth } },
      { id: "xor", type: "XOr", props: { inputCount: 2, bitWidth } },
      { id: "y",   type: "Out", props: { label: "Y", bitWidth } },
    ],
    connections: [
      ["a:out",   "xor:In_1"],
      ["b:out",   "xor:In_2"],
      ["xor:out", "y:in"],
    ],
  });
}

// ---------------------------------------------------------------------------
// 3-input XOr fixture
// ---------------------------------------------------------------------------

function buildXor3Fixture(bitWidth: number): DigitalFixture {
  return buildDigital({
    components: [
      { id: "a",   type: "In",  props: { label: "A", bitWidth } },
      { id: "b",   type: "In",  props: { label: "B", bitWidth } },
      { id: "c",   type: "In",  props: { label: "C", bitWidth } },
      { id: "xor", type: "XOr", props: { inputCount: 3, bitWidth } },
      { id: "y",   type: "Out", props: { label: "Y", bitWidth } },
    ],
    connections: [
      ["a:out",   "xor:In_1"],
      ["b:out",   "xor:In_2"],
      ["c:out",   "xor:In_3"],
      ["xor:out", "y:in"],
    ],
  });
}

// ---------------------------------------------------------------------------
// 4-input XOr fixture (covers even-arity chained XOR, where 4 equal values
// produce 0 — exercises the multi-input loop in the executeFn beyond 3-input
// arity).
// ---------------------------------------------------------------------------

function buildXor4Fixture(bitWidth: number): DigitalFixture {
  return buildDigital({
    components: [
      { id: "a",   type: "In",  props: { label: "A", bitWidth } },
      { id: "b",   type: "In",  props: { label: "B", bitWidth } },
      { id: "c",   type: "In",  props: { label: "C", bitWidth } },
      { id: "d",   type: "In",  props: { label: "D", bitWidth } },
      { id: "xor", type: "XOr", props: { inputCount: 4, bitWidth } },
      { id: "y",   type: "Out", props: { label: "Y", bitWidth } },
    ],
    connections: [
      ["a:out",   "xor:In_1"],
      ["b:out",   "xor:In_2"],
      ["c:out",   "xor:In_3"],
      ["d:out",   "xor:In_4"],
      ["xor:out", "y:in"],
    ],
  });
}

// ===========================================================================
// XOr — Cat 9 (digital interaction): two-input truth table
// ===========================================================================

describe("XOr 2-input digital interaction (Cat 9)", () => {
  it("1-bit: 0 XOR 0 = 0 (equal inputs produce zero)", () => {
    const fix = buildXor2Fixture(1);
    drive(fix, { A: 0, B: 0 });
    expect(read(fix, "Y")).toBe(0);
  });

  it("1-bit: 1 XOR 0 = 1 (one-hot input produces one)", () => {
    const fix = buildXor2Fixture(1);
    drive(fix, { A: 1, B: 0 });
    expect(read(fix, "Y")).toBe(1);
  });

  it("1-bit: 0 XOR 1 = 1 (one-hot input produces one)", () => {
    const fix = buildXor2Fixture(1);
    drive(fix, { A: 0, B: 1 });
    expect(read(fix, "Y")).toBe(1);
  });

  it("1-bit: 1 XOR 1 = 0 (equal inputs produce zero)", () => {
    const fix = buildXor2Fixture(1);
    drive(fix, { A: 1, B: 1 });
    expect(read(fix, "Y")).toBe(0);
  });
});

// ===========================================================================
// XOr — Cat 9 (digital interaction): multi-bit truth table
// ===========================================================================

describe("XOr 2-input multi-bit digital interaction (Cat 9)", () => {
  it("8-bit: 0xFF XOR 0xFF = 0x00 (identical pattern cancels)", () => {
    const fix = buildXor2Fixture(8);
    drive(fix, { A: 0xFF, B: 0xFF });
    expect(read(fix, "Y")).toBe(0x00);
  });

  it("8-bit: 0xAA XOR 0x55 = 0xFF (alternating opposite bits)", () => {
    const fix = buildXor2Fixture(8);
    drive(fix, { A: 0xAA, B: 0x55 });
    expect(read(fix, "Y")).toBe(0xFF);
  });

  it("8-bit: 0xF0 XOR 0x0F = 0xFF (high vs low nibbles)", () => {
    const fix = buildXor2Fixture(8);
    drive(fix, { A: 0xF0, B: 0x0F });
    expect(read(fix, "Y")).toBe(0xFF);
  });

  it("8-bit: 0xC3 XOR 0x3C = 0xFF (mixed-bit complement)", () => {
    const fix = buildXor2Fixture(8);
    drive(fix, { A: 0xC3, B: 0x3C });
    expect(read(fix, "Y")).toBe(0xFF);
  });

  it("8-bit: 0xC3 XOR 0xC3 = 0x00 (identical pattern cancels)", () => {
    const fix = buildXor2Fixture(8);
    drive(fix, { A: 0xC3, B: 0xC3 });
    expect(read(fix, "Y")).toBe(0x00);
  });

  it("8-bit: 0xF0 XOR 0xF3 = 0x03 (mismatch in low two bits only)", () => {
    const fix = buildXor2Fixture(8);
    drive(fix, { A: 0xF0, B: 0xF3 });
    expect(read(fix, "Y")).toBe(0x03);
  });

  it("16-bit: 0xABCD XOR 0xABCD = 0x0000 (identical pattern cancels)", () => {
    const fix = buildXor2Fixture(16);
    drive(fix, { A: 0xABCD, B: 0xABCD });
    expect(read(fix, "Y")).toBe(0x0000);
  });

  it("32-bit: 0x12345678 XOR 0x12345678 = 0x00000000 (identical 32-bit pattern cancels)", () => {
    const fix = buildXor2Fixture(32);
    drive(fix, { A: 0x12345678, B: 0x12345678 });
    expect(read(fix, "Y")).toBe(0x00000000);
  });

  it("32-bit: 0x0F0F0F0F XOR 0xF0F0F0F0 = 0xFFFFFFFF (full bitwise complement)", () => {
    const fix = buildXor2Fixture(32);
    drive(fix, { A: 0x0F0F0F0F, B: 0xF0F0F0F0 });
    expect(read(fix, "Y")).toBe(0xFFFFFFFF);
  });
});

// ===========================================================================
// XOr — Cat 9 (digital interaction): 3-input chained XOR
// ===========================================================================

describe("XOr 3-input digital interaction (Cat 9)", () => {
  it("8-bit: 0xFF XOR 0x0F XOR 0x03 = 0xF3 (cumulative XOR)", () => {
    // 0xFF ^ 0x0F = 0xF0; 0xF0 ^ 0x03 = 0xF3.
    const fix = buildXor3Fixture(8);
    drive(fix, { A: 0xFF, B: 0x0F, C: 0x03 });
    expect(read(fix, "Y")).toBe((0xFF ^ 0x0F ^ 0x03) >>> 0);
  });

  it("1-bit: 1 XOR 1 XOR 1 = 1 (odd number of highs)", () => {
    const fix = buildXor3Fixture(1);
    drive(fix, { A: 1, B: 1, C: 1 });
    expect(read(fix, "Y")).toBe(1);
  });

  it("1-bit: 0 XOR 0 XOR 0 = 0 (no highs)", () => {
    const fix = buildXor3Fixture(1);
    drive(fix, { A: 0, B: 0, C: 0 });
    expect(read(fix, "Y")).toBe(0);
  });

  it("1-bit: 1 XOR 0 XOR 1 = 0 (even number of highs)", () => {
    const fix = buildXor3Fixture(1);
    drive(fix, { A: 1, B: 0, C: 1 });
    expect(read(fix, "Y")).toBe(0);
  });

  it("8-bit: 0xAB XOR 0xAB XOR 0xAB = 0xAB (3 equal values: odd number of highs preserves original)", () => {
    const fix = buildXor3Fixture(8);
    drive(fix, { A: 0xAB, B: 0xAB, C: 0xAB });
    expect(read(fix, "Y")).toBe(0xAB);
  });
});

// ===========================================================================
// XOr — Cat 9 (digital interaction): 4-input chained XOR
// ===========================================================================

describe("XOr 4-input digital interaction (Cat 9)", () => {
  it("8-bit: 0xFF XOR 0xFF XOR 0xFF XOR 0xFF = 0x00 (4 equal values: even number of highs cancels)", () => {
    const fix = buildXor4Fixture(8);
    drive(fix, { A: 0xFF, B: 0xFF, C: 0xFF, D: 0xFF });
    expect(read(fix, "Y")).toBe(0x00);
  });
});

// ===========================================================================
// XOr — Cat 4 (param hot-load): BLOCKED.
//
// Per buildStandardGatePropertyDefs (src/components/gates/gate-shared.ts) all
// behavioral parameters of the XOr gate are declared `structural: true`:
//   - inputCount   (structural: true)
//   - bitWidth     (structural: true)
//   - wideShape    (structural: true; render-only)
// The remaining propertyDefs entries are non-behavioral metadata:
//   - _inverterLabels (XML attribute round-trip; not a simulation parameter)
//   - label           (LABEL_PROPERTY_DEF; identifier metadata)
//
// The Cat 4 worked template (build ONE fixture, capture `before`, call
// coordinator.setComponentProperty(element, paramName, newValue), step,
// capture `after`, assert the documented post-change observable) requires a
// non-structural behavioral parameter. None exists on this component, so no
// canonical Cat 4 it() can be authored. Recorded as a BLOCKED row in the
// canonical-set table; surfaced in Escalations of the final report.
// ===========================================================================
