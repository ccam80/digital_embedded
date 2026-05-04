/**
 * Tests for post-setup diagnostic: competing voltage constraints on the same net.
 *
 * MNAEngine._setup() detects two ideal voltage sources on the same node and
 * emits competing-voltage-constraints via the engine's runtime
 * DiagnosticCollector, which the coordinator surfaces via getRuntimeDiagnostics().
 */

import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../components/register-all.js";

/** Build the engine, drive _setup() via dcOperatingPoint(), and return
 *  the coordinator's runtime diagnostics. Singular topologies will throw
 *  from dcOperatingPoint(); we swallow that- _setup() has already emitted
 *  topology diagnostics by the time the LU fails. */
function getRuntimeDiagnosticsAfterSetup(
  buildSpec: import("../../../headless/netlist-types.js").CircuitSpec,
): readonly import("../../../compile/types.js").Diagnostic[] {
  const facade = new DefaultSimulatorFacade(createDefaultRegistry());
  const circuit = facade.build(buildSpec);
  const coordinator = facade.compile(circuit);
  try { coordinator.dcOperatingPoint(); } catch { /* singular matrix expected */ }
  return coordinator.getRuntimeDiagnostics();
}

describe("competing voltage constraints diagnostic", () => {
  it("two voltage sources on same net emits competing-voltage-constraints error", () => {
    const diags = getRuntimeDiagnosticsAfterSetup({
      components: [
        { id: "vs1", type: "DcVoltageSource", props: { label: "vs1", voltage: 5 } },
        { id: "vs2", type: "DcVoltageSource", props: { label: "vs2", voltage: 3 } },
        { id: "r1",  type: "Resistor",        props: { label: "r1", resistance: 1000 } },
        { id: "gnd", type: "Ground" },
      ],
      connections: [
        ["vs1:pos", "vs2:pos"],
        ["vs2:pos", "r1:A"],
        ["vs1:neg", "vs2:neg"],
        ["vs2:neg", "r1:B"],
        ["r1:B",   "gnd:out"],
      ],
    });

    const competing = diags.filter(d => d.code === "competing-voltage-constraints");
    expect(competing.length).toBeGreaterThanOrEqual(1);
    expect(competing[0].severity).toBe("error");
    expect(competing[0].message).toContain("Two competing voltage sources");
  });

  it("single voltage source on net emits no competing-voltage-constraints", () => {
    const diags = getRuntimeDiagnosticsAfterSetup({
      components: [
        { id: "vs",  type: "DcVoltageSource", props: { label: "vs", voltage: 5 } },
        { id: "r1",  type: "Resistor",        props: { label: "r1", resistance: 1000 } },
        { id: "gnd", type: "Ground" },
      ],
      connections: [
        ["vs:pos", "r1:A"],
        ["r1:B",  "gnd:out"],
        ["vs:neg", "gnd:out"],
      ],
    });

    const competing = diags.filter(d => d.code === "competing-voltage-constraints");
    expect(competing.length).toBe(0);
  });

  it("voltage source plus resistor on same net emits no diagnostic", () => {
    const diags = getRuntimeDiagnosticsAfterSetup({
      components: [
        { id: "vs",  type: "DcVoltageSource", props: { label: "vs", voltage: 5 } },
        { id: "r1",  type: "Resistor",        props: { label: "r1", resistance: 1000 } },
        { id: "r2",  type: "Resistor",        props: { label: "r2", resistance: 1000 } },
        { id: "gnd", type: "Ground" },
      ],
      connections: [
        ["vs:pos", "r1:A"],
        ["r1:B",   "r2:A"],
        ["r2:B",   "gnd:out"],
        ["vs:neg",  "gnd:out"],
      ],
    });

    const competing = diags.filter(d => d.code === "competing-voltage-constraints");
    expect(competing.length).toBe(0);
  });
});
