import { describe, it } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../components/register-all.js";
import { DefaultSimulationCoordinator } from "../../../solver/coordinator.js";

describe("debug_tline_signals", () => {
  it("prints signal keys for TLine circuit", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: "vs",    type: "DcVoltageSource", props: { voltage: 1.0, label: "vs" } },
        { id: "tl",    type: "TransmissionLine", props: { impedance: 50, delay: 10e-9, lossPerMeter: 0, length: 1.0, segments: 5, label: "tl" } },
        { id: "rload", type: "Resistor",         props: { resistance: 50, label: "rload" } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vs:pos",   "tl:P1b"],
        ["vs:neg",   "gnd:out"],
        ["tl:P1a",   "gnd:out"],
        ["tl:P2b",   "rload:A"],
        ["tl:P2a",   "gnd:out"],
        ["rload:B",  "gnd:out"],
      ],
    });
    const coordinator = facade.compile(circuit) as DefaultSimulationCoordinator;
    coordinator.step();
    const sigs = facade.readAllSignals(coordinator);
    console.log("ALL SIGNAL KEYS:", JSON.stringify(Object.keys(sigs)));
    console.log("ALL SIGNAL VALUES:", JSON.stringify(sigs));
    const compiled = (coordinator as any).compiled;
    if (compiled?.labelSignalMap) {
      console.log("LABEL MAP KEYS:", JSON.stringify([...compiled.labelSignalMap.keys()]));
    }
    const state = coordinator.getState();
    console.log("ENGINE STATE:", state);
  });
});
