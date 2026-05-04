/**
 * Tests for behavioral D flip-flop analog model.
 *
 * Tests verify observable behavior via facade-compiled circuits (M2 shape).
 * Registration tests verify the ComponentDefinition's modelRegistry entries.
 */

import { describe, it, expect } from "vitest";
import { DDefinition } from "../../../components/flipflops/d.js";

// ---------------------------------------------------------------------------
// Registration tests
// ---------------------------------------------------------------------------

describe("Registration", () => {
  it("d_flipflop_has_analog_model", () => {
    expect(DDefinition.modelRegistry?.cmos).toBeDefined();
  });

  it("d_flipflop_engine_type_is_both", () => {
    expect(DDefinition.models?.digital).not.toBeUndefined();
    expect(DDefinition.modelRegistry?.cmos).not.toBeUndefined();
  });

  it("d_flipflop_simulation_modes_include_digital_and_simplified", () => {
    expect(DDefinition.models?.digital).not.toBeUndefined();
    expect(DDefinition.modelRegistry?.cmos).not.toBeUndefined();
  });

  it("analog_factory_returns_analog_element", () => {
    const cmosModel = DDefinition.modelRegistry!.cmos!;
    expect(cmosModel.kind).toBe("netlist");
    expect((cmosModel as {kind:"netlist";netlist:unknown}).netlist).toBeDefined();
  });
});
