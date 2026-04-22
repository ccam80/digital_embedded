/**
 * Tests for Analog Switch components (SPST and SPDT).
 *
 * Surviving tests per Phase 2.5 A1 §Test handling rule:
 *   - Parameter plumbing (setParam, defaults) — KEEP
 *   - Engine-agnostic interface contracts (poolBacked, stateSize, stateSchema) — KEEP
 *
 * Deleted per A1 §Test handling rule:
 *   - on_resistance      — hand-computed expected value based on tanh extension behavior → deleted
 *   - off_resistance     — hand-computed expected value based on tanh extension behavior → deleted
 *   - smooth_transition  — asserts tanh monotonicity, digiTS extension beyond ngspice SW → deleted
 *   - signal_passes_when_on — hand-computed circuit result, digiTS tanh extension → deleted
 *   - nr_converges_during_transition — asserts tanh convergence property, digiTS extension → deleted
 *   - no_and_nc_complementary — asserts tanh transition values, digiTS extension → deleted
 *   - break_before_make  — asserts tanh midpoint resistance, digiTS extension → deleted
 *   - analog_switch_load_dcop_parity (C4.5) — closed-form tanh reference, digiTS extension → deleted
 */

import { describe, it, expect } from "vitest";
import {
  SwitchSPSTDefinition,
  SwitchSPDTDefinition,
  SW_SCHEMA,
  SPDT_SCHEMA,
} from "../analog-switch.js";
import { PropertyBag } from "../../../core/properties.js";
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory
// ---------------------------------------------------------------------------
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}

// ---------------------------------------------------------------------------
// Helper: build props with ngspice SW model params
// ---------------------------------------------------------------------------
function makeProps(overrides: Record<string, number | string> = {}): PropertyBag {
  const modelParams: Record<string, number> = {
    rOn: 1, rOff: 1e9, vThreshold: 1.65, vHysteresis: 0,
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (typeof v === "number") modelParams[k] = v;
  }
  const bag = new PropertyBag([]);
  bag.replaceModelParams(modelParams);
  return bag;
}

// ---------------------------------------------------------------------------
// SPST interface contract tests
// ---------------------------------------------------------------------------

describe("SPST interface contracts", () => {
  it("poolBacked flag is true", () => {
    const factory = getFactory(SwitchSPSTDefinition.modelRegistry!["behavioral"]!);
    const el = factory(
      new Map([["in", 1], ["out", 2], ["ctrl", 3]]),
      [], -1, makeProps(), () => 0,
    );
    expect((el as any).poolBacked).toBe(true);
  });

  it("stateSize matches SW_SCHEMA (2 slots, SW_NUM_STATES)", () => {
    const factory = getFactory(SwitchSPSTDefinition.modelRegistry!["behavioral"]!);
    const el = factory(
      new Map([["in", 1], ["out", 2], ["ctrl", 3]]),
      [], -1, makeProps(), () => 0,
    );
    expect((el as any).stateSize).toBe(SW_SCHEMA.size);
    expect((el as any).stateSize).toBe(2);
  });

  it("stateSchema is SW_SCHEMA", () => {
    const factory = getFactory(SwitchSPSTDefinition.modelRegistry!["behavioral"]!);
    const el = factory(
      new Map([["in", 1], ["out", 2], ["ctrl", 3]]),
      [], -1, makeProps(), () => 0,
    );
    expect((el as any).stateSchema).toBe(SW_SCHEMA);
  });

  it("stateBaseOffset initialises to -1 (set by compiler)", () => {
    const factory = getFactory(SwitchSPSTDefinition.modelRegistry!["behavioral"]!);
    const el = factory(
      new Map([["in", 1], ["out", 2], ["ctrl", 3]]),
      [], -1, makeProps(), () => 0,
    );
    expect((el as any).stateBaseOffset).toBe(-1);
  });

  it("isNonlinear is true", () => {
    const factory = getFactory(SwitchSPSTDefinition.modelRegistry!["behavioral"]!);
    const el = factory(
      new Map([["in", 1], ["out", 2], ["ctrl", 3]]),
      [], -1, makeProps(), () => 0,
    );
    expect(el.isNonlinear).toBe(true);
  });

  it("isReactive is false (no junction capacitance)", () => {
    const factory = getFactory(SwitchSPSTDefinition.modelRegistry!["behavioral"]!);
    const el = factory(
      new Map([["in", 1], ["out", 2], ["ctrl", 3]]),
      [], -1, makeProps(), () => 0,
    );
    expect(el.isReactive).toBe(false);
  });

  it("branchIndex is -1 (no extra MNA row)", () => {
    const factory = getFactory(SwitchSPSTDefinition.modelRegistry!["behavioral"]!);
    const el = factory(
      new Map([["in", 1], ["out", 2], ["ctrl", 3]]),
      [], -1, makeProps(), () => 0,
    );
    expect(el.branchIndex).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// SPST parameter plumbing tests
// ---------------------------------------------------------------------------

describe("SPST parameter plumbing", () => {
  it("default params match ANALOG_SWITCH_DEFAULTS keys", () => {
    // Verify the factory accepts and reads all four SW model params
    const factory = getFactory(SwitchSPSTDefinition.modelRegistry!["behavioral"]!);
    // Should not throw
    expect(() => factory(
      new Map([["in", 1], ["out", 2], ["ctrl", 3]]),
      [], -1,
      makeProps({ rOn: 10, rOff: 1e6, vThreshold: 2.5, vHysteresis: 0.1 }),
      () => 0,
    )).not.toThrow();
  });

  it("setParam accepts rOn, rOff, vThreshold, vHysteresis", () => {
    const factory = getFactory(SwitchSPSTDefinition.modelRegistry!["behavioral"]!);
    const el = factory(
      new Map([["in", 1], ["out", 2], ["ctrl", 3]]),
      [], -1, makeProps(), () => 0,
    );
    // Should not throw — engine-agnostic interface contract
    expect(() => el.setParam("rOn", 50)).not.toThrow();
    expect(() => el.setParam("rOff", 1e8)).not.toThrow();
    expect(() => el.setParam("vThreshold", 2.5)).not.toThrow();
    expect(() => el.setParam("vHysteresis", 0.1)).not.toThrow();
  });

  it("unknown setParam key is silently ignored", () => {
    const factory = getFactory(SwitchSPSTDefinition.modelRegistry!["behavioral"]!);
    const el = factory(
      new Map([["in", 1], ["out", 2], ["ctrl", 3]]),
      [], -1, makeProps(), () => 0,
    );
    expect(() => el.setParam("transitionSharpness", 20)).not.toThrow();
    expect(() => el.setParam("nonexistent", 99)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SPDT interface contract tests
// ---------------------------------------------------------------------------

describe("SPDT interface contracts", () => {
  it("poolBacked flag is true", () => {
    const factory = getFactory(SwitchSPDTDefinition.modelRegistry!["behavioral"]!);
    const el = factory(
      new Map([["com", 1], ["no", 2], ["nc", 3], ["ctrl", 4]]),
      [], -1, makeProps(), () => 0,
    );
    expect((el as any).poolBacked).toBe(true);
  });

  it("stateSize matches SPDT_SCHEMA (4 slots = 2 paths × 2 SW slots)", () => {
    const factory = getFactory(SwitchSPDTDefinition.modelRegistry!["behavioral"]!);
    const el = factory(
      new Map([["com", 1], ["no", 2], ["nc", 3], ["ctrl", 4]]),
      [], -1, makeProps(), () => 0,
    );
    expect((el as any).stateSize).toBe(SPDT_SCHEMA.size);
    expect((el as any).stateSize).toBe(4);
  });

  it("stateSchema is SPDT_SCHEMA", () => {
    const factory = getFactory(SwitchSPDTDefinition.modelRegistry!["behavioral"]!);
    const el = factory(
      new Map([["com", 1], ["no", 2], ["nc", 3], ["ctrl", 4]]),
      [], -1, makeProps(), () => 0,
    );
    expect((el as any).stateSchema).toBe(SPDT_SCHEMA);
  });

  it("isNonlinear is true", () => {
    const factory = getFactory(SwitchSPDTDefinition.modelRegistry!["behavioral"]!);
    const el = factory(
      new Map([["com", 1], ["no", 2], ["nc", 3], ["ctrl", 4]]),
      [], -1, makeProps(), () => 0,
    );
    expect(el.isNonlinear).toBe(true);
  });

  it("isReactive is false", () => {
    const factory = getFactory(SwitchSPDTDefinition.modelRegistry!["behavioral"]!);
    const el = factory(
      new Map([["com", 1], ["no", 2], ["nc", 3], ["ctrl", 4]]),
      [], -1, makeProps(), () => 0,
    );
    expect(el.isReactive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SW_SCHEMA structure tests
// ---------------------------------------------------------------------------

describe("SW_SCHEMA structure", () => {
  it("has 2 slots (SW_NUM_STATES, swdefs.h:56)", () => {
    expect(SW_SCHEMA.size).toBe(2);
    expect(SW_SCHEMA.slots).toHaveLength(2);
  });

  it("slot 0 is CURRENT_STATE initialised to 0 (REALLY_OFF)", () => {
    const slot = SW_SCHEMA.slots[0];
    expect(slot.name).toBe("CURRENT_STATE");
    expect(slot.init.kind).toBe("constant");
    expect((slot.init as any).value).toBe(0);
  });

  it("slot 1 is V_CTRL initialised to zero", () => {
    const slot = SW_SCHEMA.slots[1];
    expect(slot.name).toBe("V_CTRL");
    expect(slot.init.kind).toBe("zero");
  });
});

describe("SPDT_SCHEMA structure", () => {
  it("has 4 slots (2 paths × SW_NUM_STATES)", () => {
    expect(SPDT_SCHEMA.size).toBe(4);
  });

  it("NC path state slot (index 2) initialises to 1 (REALLY_ON = starts closed)", () => {
    const slot = SPDT_SCHEMA.slots[2];
    expect(slot.name).toBe("NC_CURRENT_STATE");
    expect(slot.init.kind).toBe("constant");
    expect((slot.init as any).value).toBe(1);
  });
});
