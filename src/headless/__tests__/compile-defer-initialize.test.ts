/**
 * Smoke tests for compile(circuit, { deferInitialize: true }) and
 * coordinator.initialize() idempotency (W2.T4).
 */

import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../default-facade.js";
import { createDefaultRegistry } from "../../components/register-all.js";

const registry = createDefaultRegistry();

function buildRcCircuit(facade: DefaultSimulatorFacade) {
  return facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { voltage: 5 } },
      { id: "r1",  type: "Resistor",        props: { resistance: 1000 } },
      { id: "c1",  type: "Capacitor",       props: { capacitance: 1e-6 } },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["vs:pos", "r1:A"],
      ["r1:B",   "c1:pos"],
      ["c1:neg", "gnd:out"],
      ["vs:neg", "gnd:out"],
    ],
  });
}

describe("compile deferInitialize", () => {
  it("does NOT run DCOP when deferInitialize is true", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildRcCircuit(facade);
    const coord = facade.compile(circuit, { deferInitialize: true });
    expect(coord.dcOperatingPoint()).toBeNull();
  });

  it("runs DCOP when initialize() is called explicitly", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildRcCircuit(facade);
    const coord = facade.compile(circuit, { deferInitialize: true });
    coord.initialize();
    expect(coord.dcOperatingPoint()).not.toBeNull();
  });

  it("initialize() is idempotent", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildRcCircuit(facade);
    const coord = facade.compile(circuit, { deferInitialize: true });
    coord.initialize();
    const first = coord.dcOperatingPoint();
    coord.initialize();
    expect(coord.dcOperatingPoint()).toBe(first);
  });

  it("compile without opts runs DCOP immediately (backwards compatible)", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildRcCircuit(facade);
    const coord = facade.compile(circuit);
    expect(coord.dcOperatingPoint()).not.toBeNull();
  });
});
