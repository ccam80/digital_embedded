/**
 * Canonical tests for the XNOr gate component.
 *
 * Tier: fixture-only (pure-digital combinational; no analog domain).
 * Driver: facade.build({components, connections}) + facade.compile() + setSignal / step / readSignal.
 *
 * Canon coverage:
 *   - Cat 9 (digital interaction): drive labelled inputs, step, assert labelled output.
 *   - Cat 4 (param hot-load): BLOCKED. XNOr's propertyDefs (buildStandardGatePropertyDefs
 *     in src/components/gates/gate-shared.ts) declare every behavioral parameter
 *     (`inputCount`, `bitWidth`, `wideShape`) as `structural: true`. The remaining
 *     keys (`_inverterLabels`, `label`) are XML-attribute / metadata, not behavioral
 *     simulation parameters. There is no non-structural behavioral parameter
 *     documented as hot-loadable on this component, so the canonical Cat 4
 *     worked template (single fixture, mutate via setComponentProperty, assert
 *     post-change observable) has no candidate parameter. See Escalations.
 */

import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../components/register-all.js";
import type { SimulationCoordinator } from "../../../solver/coordinator-types.js";
import type { Circuit } from "../../../core/circuit.js";

const registry = createDefaultRegistry();

// ---------------------------------------------------------------------------
// Canonical builder for an XNOr gate driven by labelled In ports and observed
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
// 2-input XNOr fixture
// ---------------------------------------------------------------------------

function buildXnor2Fixture(bitWidth: number): DigitalFixture {
  return buildDigital({
    components: [
      { id: "a",    type: "In",   props: { label: "A",  bitWidth } },
      { id: "b",    type: "In",   props: { label: "B",  bitWidth } },
      { id: "xnor", type: "XNOr", props: { inputCount: 2, bitWidth } },
      { id: "y",    type: "Out",  props: { label: "Y",  bitWidth } },
    ],
    connections: [
      ["a:out",    "xnor:In_1"],
      ["b:out",    "xnor:In_2"],
      ["xnor:out", "y:in"],
    ],
  });
}

// ---------------------------------------------------------------------------
// 3-input XNOr fixture
// ---------------------------------------------------------------------------

function buildXnor3Fixture(bitWidth: number): DigitalFixture {
  return buildDigital({
    components: [
      { id: "a",    type: "In",   props: { label: "A",  bitWidth } },
      { id: "b",    type: "In",   props: { label: "B",  bitWidth } },
      { id: "c",    type: "In",   props: { label: "C",  bitWidth } },
      { id: "xnor", type: "XNOr", props: { inputCount: 3, bitWidth } },
      { id: "y",    type: "Out",  props: { label: "Y",  bitWidth } },
    ],
    connections: [
      ["a:out",    "xnor:In_1"],
      ["b:out",    "xnor:In_2"],
      ["c:out",    "xnor:In_3"],
      ["xnor:out", "y:in"],
    ],
  });
}

// ===========================================================================
// XNOr — Cat 9 (digital interaction): two-input truth table
// ===========================================================================

describe("XNOr 2-input digital interaction (Cat 9)", () => {
  it("1-bit: 0 XNOR 0 = 1 (equal inputs produce all-ones output)", () => {
    const fix = buildXnor2Fixture(1);
    drive(fix, { A: 0, B: 0 });
    expect(read(fix, "Y")).toBe(1);
  });

  it("1-bit: 1 XNOR 1 = 1 (equal inputs produce all-ones output)", () => {
    const fix = buildXnor2Fixture(1);
    drive(fix, { A: 1, B: 1 });
    expect(read(fix, "Y")).toBe(1);
  });

  it("1-bit: 1 XNOR 0 = 0 (unequal inputs produce zero)", () => {
    const fix = buildXnor2Fixture(1);
    drive(fix, { A: 1, B: 0 });
    expect(read(fix, "Y")).toBe(0);
  });

  it("1-bit: 0 XNOR 1 = 0 (unequal inputs produce zero)", () => {
    const fix = buildXnor2Fixture(1);
    drive(fix, { A: 0, B: 1 });
    expect(read(fix, "Y")).toBe(0);
  });
});

// ===========================================================================
// XNOr — Cat 9 (digital interaction): multi-bit truth table
// ===========================================================================

describe("XNOr 2-input multi-bit digital interaction (Cat 9)", () => {
  it("8-bit: 0xFF XNOR 0xFF = 0xFF (equal across all bits)", () => {
    const fix = buildXnor2Fixture(8);
    drive(fix, { A: 0xFF, B: 0xFF });
    expect(read(fix, "Y")).toBe(0xFF);
  });

  it("8-bit: 0xAA XNOR 0x55 = 0x00 (alternating opposite bits)", () => {
    const fix = buildXnor2Fixture(8);
    drive(fix, { A: 0xAA, B: 0x55 });
    expect(read(fix, "Y")).toBe(0x00);
  });

  it("8-bit: 0xF0 XNOR 0x0F = 0x00 (high vs low nibbles)", () => {
    const fix = buildXnor2Fixture(8);
    drive(fix, { A: 0xF0, B: 0x0F });
    expect(read(fix, "Y")).toBe(0x00);
  });

  it("8-bit: 0xC3 XNOR 0x3C = 0x00 (mixed-bit complement)", () => {
    const fix = buildXnor2Fixture(8);
    drive(fix, { A: 0xC3, B: 0x3C });
    expect(read(fix, "Y")).toBe(0x00);
  });

  it("8-bit: 0xC3 XNOR 0xC3 = 0xFF (identical pattern)", () => {
    const fix = buildXnor2Fixture(8);
    drive(fix, { A: 0xC3, B: 0xC3 });
    expect(read(fix, "Y")).toBe(0xFF);
  });

  it("8-bit: 0xF0 XNOR 0xF3 = 0xFC (mismatch in low two bits only)", () => {
    // bitwise XOR = 0x03; NOT(0x03) masked to 8 bits = 0xFC.
    const fix = buildXnor2Fixture(8);
    drive(fix, { A: 0xF0, B: 0xF3 });
    expect(read(fix, "Y")).toBe(0xFC);
  });

  it("16-bit: 0xABCD XNOR 0xABCD = 0xFFFF (identical pattern)", () => {
    const fix = buildXnor2Fixture(16);
    drive(fix, { A: 0xABCD, B: 0xABCD });
    expect(read(fix, "Y")).toBe(0xFFFF);
  });

  it("32-bit: 0x12345678 XNOR 0x12345678 = 0xFFFFFFFF (identical 32-bit pattern)", () => {
    const fix = buildXnor2Fixture(32);
    drive(fix, { A: 0x12345678, B: 0x12345678 });
    expect(read(fix, "Y")).toBe(0xFFFFFFFF);
  });

  it("32-bit: 0x0F0F0F0F XNOR 0xF0F0F0F0 = 0x00000000 (full bitwise complement)", () => {
    const fix = buildXnor2Fixture(32);
    drive(fix, { A: 0x0F0F0F0F, B: 0xF0F0F0F0 });
    expect(read(fix, "Y")).toBe(0x00000000);
  });
});

// ===========================================================================
// XNOr — Cat 9 (digital interaction): 3-input chained XNOR == NOT(XOR of all inputs)
// ===========================================================================

describe("XNOr 3-input digital interaction (Cat 9)", () => {
  it("8-bit: NOT(0xFF ^ 0x0F ^ 0x03) = 0x0C (cumulative XOR then invert)", () => {
    // 0xFF ^ 0x0F = 0xF0; 0xF0 ^ 0x03 = 0xF3; ~0xF3 & 0xFF = 0x0C.
    const fix = buildXnor3Fixture(8);
    drive(fix, { A: 0xFF, B: 0x0F, C: 0x03 });
    expect(read(fix, "Y")).toBe(0x0C);
  });

  it("1-bit: 1 XNOR 1 XNOR 1 = 0 (cumulative XOR=1, invert=0)", () => {
    // 1 ^ 1 = 0; 0 ^ 1 = 1; ~1 & 1 = 0.
    const fix = buildXnor3Fixture(1);
    drive(fix, { A: 1, B: 1, C: 1 });
    expect(read(fix, "Y")).toBe(0);
  });

  it("1-bit: 0 XNOR 0 XNOR 0 = 1 (cumulative XOR=0, invert=1)", () => {
    const fix = buildXnor3Fixture(1);
    drive(fix, { A: 0, B: 0, C: 0 });
    expect(read(fix, "Y")).toBe(1);
  });

  it("1-bit: 1 XNOR 0 XNOR 1 = 1 (cumulative XOR=0, invert=1)", () => {
    const fix = buildXnor3Fixture(1);
    drive(fix, { A: 1, B: 0, C: 1 });
    expect(read(fix, "Y")).toBe(1);
  });
});

// ===========================================================================
// XNOr — Cat 4 (param hot-load): BLOCKED.
//
// Per buildStandardGatePropertyDefs (src/components/gates/gate-shared.ts) all
// behavioral parameters of the XNOr gate are declared `structural: true`:
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
