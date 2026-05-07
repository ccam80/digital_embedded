import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../register-all.js";

const registry = createDefaultRegistry();

// ---------------------------------------------------------------------------
// Category 9 — Bridge / digital interaction (T1)
//
// ButtonLED carries a `models.digital` entry (executeFn = executeButtonLED;
// inputSchema = ["in"], outputSchema = ["out"]). Capability gate 9 is the
// only applicable canon category: there is no analog model exposed at the
// digital surface (the modelRegistry.behavioral entry is a netlist-driver
// for the analog domain, not a state-pool/MNA model that the digital test
// surface observes), no junction limiting, no LTE rollback, no breakpoints,
// no transient dynamics, no DCOP, no named multi-preset model swap.
//
// Cat 9 worked structure: drive labeled In through facade.setSignal,
// advance via facade.step, observe labeled Out via facade.readSignal.
// facade.setSignal / step / readSignal are the sanctioned simulator
// surface from Step 2b's binary canonical gate.
// ---------------------------------------------------------------------------

describe("ButtonLED (Cat 9 bridge / digital)", () => {
  function buildBLed(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "in",  type: "In",  props: { label: "IN",  bitWidth: 1 } },
        { id: "bl",  type: "ButtonLED", props: { label: "BL" } },
        { id: "out", type: "Out", props: { label: "OUT", bitWidth: 1 } },
      ],
      connections: [
        ["in:out", "bl:in"],
        ["bl:out", "out:in"],
      ],
    });
  }

  it("LED input=1 propagates to OUT after step", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildBLed(facade));
    facade.setSignal(coord, "IN", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "OUT")).toBe(1);
  });

  it("LED input=0 propagates to OUT after step", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildBLed(facade));
    facade.setSignal(coord, "IN", 0);
    facade.step(coord);
    expect(facade.readSignal(coord, "OUT")).toBe(0);
  });

  it("LED input toggles 0->1->0 propagate to OUT each step", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(buildBLed(facade));
    facade.setSignal(coord, "IN", 0);
    facade.step(coord);
    expect(facade.readSignal(coord, "OUT")).toBe(0);
    facade.setSignal(coord, "IN", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "OUT")).toBe(1);
    facade.setSignal(coord, "IN", 0);
    facade.step(coord);
    expect(facade.readSignal(coord, "OUT")).toBe(0);
  });
});
