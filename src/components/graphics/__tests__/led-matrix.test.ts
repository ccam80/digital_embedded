import { describe, it, expect } from "vitest";
import { createDefaultRegistry } from "../../register-all.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { PropertyValue } from "../../../core/properties.js";
import type { SignalValue } from "../../../compile/types.js";

// ---------------------------------------------------------------------------
// LedMatrix canonical test set
// Canon categories: 9 (Bridge / digital interaction)
// File tier: fixture-only (digital-only display sink — facade.compile +
// coordinator writeByLabel/step; buildFixture requires an analog domain).
// ---------------------------------------------------------------------------

interface LedMatrixFixture {
  facade: DefaultSimulatorFacade;
  coordinator: ReturnType<DefaultSimulatorFacade["compile"]>;
}

function digital(value: number): SignalValue {
  return { type: "digital", value };
}

function buildLedMatrixFixture(opts?: {
  rowDataBits?: number;
  colAddrBits?: number;
}): LedMatrixFixture {
  const rowDataBits = opts?.rowDataBits ?? 8;
  const colAddrBits = opts?.colAddrBits ?? 3;

  const components: Array<{ id: string; type: string; props: Record<string, PropertyValue> }> = [
    {
      id: "rdata",
      type: "In",
      props: { label: "RDATA", bitWidth: rowDataBits },
    },
    {
      id: "caddr",
      type: "In",
      props: { label: "CADDR", bitWidth: colAddrBits },
    },
    {
      id: "lm",
      type: "LedMatrix",
      props: { label: "LM", rowDataBits, colAddrBits },
    },
  ];

  const connections: Array<[string, string]> = [
    ["rdata:out", "lm:r-data"],
    ["caddr:out", "lm:c-addr"],
  ];

  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({ components, connections });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

describe("LedMatrix — bridge / digital (T1)", () => {
  // -------------------------------------------------------------------------
  // Cat 9 — Bridge / digital interaction
  //
  // LedMatrix is a digital-only display sink with two inputs (r-data, c-addr)
  // and zero outputs. executeLedMatrix is documented as a no-op (the display
  // panel reads element internal state via UI hooks, not through the
  // simulator). The canonical Cat 9 observables for this component are:
  //   1. The engine compiles and steps a circuit containing the component
  //      with digital inputs of varying bit-widths driven through writeByLabel.
  //   2. The compiled circuit exposes the LedMatrix instance via
  //      compiled.labelToCircuitElement so the editor / display layer can
  //      reach the element by its label.
  // -------------------------------------------------------------------------

  it("digital_inputs_drive_step_without_throwing_default_widths", () => {
    const fix = buildLedMatrixFixture({ rowDataBits: 8, colAddrBits: 3 });
    fix.coordinator.writeByLabel("RDATA", digital(0xAB));
    fix.coordinator.writeByLabel("CADDR", digital(3));
    expect(() => fix.coordinator.step()).not.toThrow();
  });

  it("digital_inputs_drive_step_without_throwing_wide_rowDataBits", () => {
    // 16-row matrix exercises a wider r-data bus.
    const fix = buildLedMatrixFixture({ rowDataBits: 16, colAddrBits: 4 });
    fix.coordinator.writeByLabel("RDATA", digital(0xBEEF));
    fix.coordinator.writeByLabel("CADDR", digital(0xF));
    expect(() => fix.coordinator.step()).not.toThrow();
  });

  it("compiled_labelToCircuitElement_resolves_LedMatrix_instance", () => {
    const fix = buildLedMatrixFixture({ rowDataBits: 8, colAddrBits: 3 });
    fix.coordinator.writeByLabel("RDATA", digital(0xFF));
    fix.coordinator.writeByLabel("CADDR", digital(0));
    fix.coordinator.step();
    const ce = fix.coordinator.compiled.labelToCircuitElement.get("LM");
    expect(ce).toBeDefined();
    expect(ce!.typeId).toBe("LedMatrix");
  });

  it("multi_step_loop_with_changing_inputs_does_not_throw", () => {
    // Exercises the executeLedMatrix path repeatedly with varying inputs —
    // the engine must accept the digital sink across many step() invocations.
    const fix = buildLedMatrixFixture({ rowDataBits: 8, colAddrBits: 3 });
    for (let i = 0; i < 64; i++) {
      fix.coordinator.writeByLabel("RDATA", digital(i & 0xFF));
      fix.coordinator.writeByLabel("CADDR", digital(i & 0x7));
      expect(() => fix.coordinator.step()).not.toThrow();
    }
    const ce = fix.coordinator.compiled.labelToCircuitElement.get("LM");
    expect(ce).toBeDefined();
  });
});
