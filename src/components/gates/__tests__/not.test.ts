import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../components/register-all.js";

const registry = createDefaultRegistry();

// ---------------------------------------------------------------------------
// Category 9 — Bridge / digital interaction (T1)
//
// NotDefinition has `models.digital.executeFn = executeNot` and no analog
// state on its element class. The component's primary observable is
// digital-input -> digital-output through the registered executeFn.
// Categories 1-8 (analog state-pool / MNA / DCOP / transient / stamp /
// limiting / LTE / breakpoints) do not apply to the digital execution path.
//
// Canonical Cat 9 mechanic for a purely-digital gate: drive the input via
// facade.setSignal, advance one step via facade.step, read the labelled "out"
// pin via facade.readSignal. setSignal / step / readSignal are thin wrappers
// over coordinator.writeSignal / step() / readSignal — the sanctioned
// simulator surface for a digital-only component (no analog domain, so
// buildFixture does not apply).
// ---------------------------------------------------------------------------

describe("Not bitWidth=1 (Cat 9)", () => {
  function build1(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "a",   type: "In",  props: { label: "A", bitWidth: 1 } },
        { id: "g",   type: "Not", props: { label: "U1", bitWidth: 1 } },
        { id: "out", type: "Out", props: { label: "Y", bitWidth: 1 } },
      ],
      connections: [
        ["a:out", "g:In_1"],
        ["g:out", "out:in"],
      ],
    });
  }

  it("NOT 1 = 0", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(build1(facade));
    facade.setSignal(coord, "A", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "Y")).toBe(0);
  });

  it("NOT 0 = 1", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(build1(facade));
    facade.setSignal(coord, "A", 0);
    facade.step(coord);
    expect(facade.readSignal(coord, "Y")).toBe(1);
  });

  it("toggling A flips Y to its complement", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(build1(facade));

    facade.setSignal(coord, "A", 1);
    facade.step(coord);
    const yWhenAHigh = facade.readSignal(coord, "Y");

    facade.setSignal(coord, "A", 0);
    facade.step(coord);
    const yWhenALow = facade.readSignal(coord, "Y");

    expect(yWhenAHigh).toBe(0);
    expect(yWhenALow).toBe(1);
    expect(yWhenAHigh).not.toBe(yWhenALow);
  });
});

// ===========================================================================
// Multi-bit Not — bitwise inversion across the full bus width
// ===========================================================================

describe("Not bitWidth=8 (Cat 9 multi-bit)", () => {
  function build8(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "a",   type: "In",  props: { label: "A", bitWidth: 8 } },
        { id: "g",   type: "Not", props: { label: "U1", bitWidth: 8 } },
        { id: "out", type: "Out", props: { label: "Y", bitWidth: 8 } },
      ],
      connections: [
        ["a:out", "g:In_1"],
        ["g:out", "out:in"],
      ],
    });
  }

  it("~0x0F = 0xF0", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(build8(facade));
    facade.setSignal(coord, "A", 0x0F);
    facade.step(coord);
    expect(facade.readSignal(coord, "Y")).toBe(0xF0);
  });

  it("~0xAA = 0x55 (alternating pattern)", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(build8(facade));
    facade.setSignal(coord, "A", 0xAA);
    facade.step(coord);
    expect(facade.readSignal(coord, "Y")).toBe(0x55);
  });

  it("~0xFF = 0x00 (all-ones bus)", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(build8(facade));
    facade.setSignal(coord, "A", 0xFF);
    facade.step(coord);
    expect(facade.readSignal(coord, "Y")).toBe(0x00);
  });

  it("~0x00 = 0xFF (all-zero bus)", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(build8(facade));
    facade.setSignal(coord, "A", 0x00);
    facade.step(coord);
    expect(facade.readSignal(coord, "Y")).toBe(0xFF);
  });

  it("double inversion is identity within the port width", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(build8(facade));

    const original = 0x12;
    facade.setSignal(coord, "A", original);
    facade.step(coord);
    const inverted = facade.readSignal(coord, "Y");
    expect(inverted).toBe((~original) & 0xFF);

    // Re-drive A with the inverted value; the complement of the complement
    // returns to the original byte.
    facade.setSignal(coord, "A", inverted);
    facade.step(coord);
    expect(facade.readSignal(coord, "Y")).toBe(original);
  });
});
