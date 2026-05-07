import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../components/register-all.js";

const registry = createDefaultRegistry();

// ---------------------------------------------------------------------------
// Category 9 — Bridge / digital interaction (T1)
//
// NAndDefinition has `models.digital.executeFn = executeNAnd` and no analog
// `getLteTimestep` / `acceptStep` / `*lim` calls on its element class. The
// component's primary observable is digital-input -> digital-output through
// the registered executeFn. Categories 1-5 (analog state-pool / MNA / DCOP /
// transient / stamp parity) do not apply to the digital execution path.
// Category 6 (junction limiting), 7 (LTE rollback) and 8 (breakpoint
// registration via acceptStep) do not apply.
//
// Canonical Cat 9 mechanic: drive each input pin via facade.setSignal,
// advance one step via facade.step, read the labelled "out" pin via
// facade.readSignal. setSignal / step / readSignal are thin wrappers over
// coordinator.writeSignal / step() / readSignal — sanctioned simulator
// surface per the binary canonical gate (Step 2b).
// ---------------------------------------------------------------------------

// ===========================================================================
// 2-input NAnd — full truth table at bitWidth=1
// ===========================================================================

describe("NAnd 2-input bitWidth=1 (Cat 9)", () => {
  function build2(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "a",   type: "In",   props: { label: "A", bitWidth: 1 } },
        { id: "b",   type: "In",   props: { label: "B", bitWidth: 1 } },
        { id: "g",   type: "NAnd", props: { inputCount: 2, bitWidth: 1 } },
        { id: "out", type: "Out",  props: { label: "OUT", bitWidth: 1 } },
      ],
      connections: [
        ["a:out", "g:In_1"],
        ["b:out", "g:In_2"],
        ["g:out", "out:in"],
      ],
    });
  }

  it("0 NAND 0 = 1", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(build2(facade));
    facade.setSignal(coord, "A", 0);
    facade.setSignal(coord, "B", 0);
    facade.step(coord);
    expect(facade.readSignal(coord, "OUT")).toBe(1);
  });

  it("0 NAND 1 = 1", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(build2(facade));
    facade.setSignal(coord, "A", 0);
    facade.setSignal(coord, "B", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "OUT")).toBe(1);
  });

  it("1 NAND 0 = 1", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(build2(facade));
    facade.setSignal(coord, "A", 1);
    facade.setSignal(coord, "B", 0);
    facade.step(coord);
    expect(facade.readSignal(coord, "OUT")).toBe(1);
  });

  it("1 NAND 1 = 0", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(build2(facade));
    facade.setSignal(coord, "A", 1);
    facade.setSignal(coord, "B", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "OUT")).toBe(0);
  });
});

// ===========================================================================
// 3-input NAnd — covers wider input-count code path
// ===========================================================================

describe("NAnd 3-input bitWidth=1 (Cat 9)", () => {
  function build3(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "a",   type: "In",   props: { label: "A", bitWidth: 1 } },
        { id: "b",   type: "In",   props: { label: "B", bitWidth: 1 } },
        { id: "c",   type: "In",   props: { label: "C", bitWidth: 1 } },
        { id: "g",   type: "NAnd", props: { inputCount: 3, bitWidth: 1 } },
        { id: "out", type: "Out",  props: { label: "OUT", bitWidth: 1 } },
      ],
      connections: [
        ["a:out", "g:In_1"],
        ["b:out", "g:In_2"],
        ["c:out", "g:In_3"],
        ["g:out", "out:in"],
      ],
    });
  }

  it("all-zero inputs produce 1", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(build3(facade));
    facade.setSignal(coord, "A", 0);
    facade.setSignal(coord, "B", 0);
    facade.setSignal(coord, "C", 0);
    facade.step(coord);
    expect(facade.readSignal(coord, "OUT")).toBe(1);
  });

  it("all-one inputs produce 0", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(build3(facade));
    facade.setSignal(coord, "A", 1);
    facade.setSignal(coord, "B", 1);
    facade.setSignal(coord, "C", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "OUT")).toBe(0);
  });

  it("a single zero input forces output to 1", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(build3(facade));
    facade.setSignal(coord, "A", 1);
    facade.setSignal(coord, "B", 0);
    facade.setSignal(coord, "C", 1);
    facade.step(coord);
    expect(facade.readSignal(coord, "OUT")).toBe(1);
  });
});

// ===========================================================================
// Multi-bit NAnd — bitwise NAND across full bus width
// ===========================================================================

describe("NAnd 2-input bitWidth=8 (Cat 9 multi-bit)", () => {
  function build8(facade: DefaultSimulatorFacade) {
    return facade.build({
      components: [
        { id: "a",   type: "In",   props: { label: "A", bitWidth: 8 } },
        { id: "b",   type: "In",   props: { label: "B", bitWidth: 8 } },
        { id: "g",   type: "NAnd", props: { inputCount: 2, bitWidth: 8 } },
        { id: "out", type: "Out",  props: { label: "OUT", bitWidth: 8 } },
      ],
      connections: [
        ["a:out", "g:In_1"],
        ["b:out", "g:In_2"],
        ["g:out", "out:in"],
      ],
    });
  }

  it("0xFF NAND 0x0F = 0xF0", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(build8(facade));
    facade.setSignal(coord, "A", 0xFF);
    facade.setSignal(coord, "B", 0x0F);
    facade.step(coord);
    expect(facade.readSignal(coord, "OUT")).toBe(0xF0);
  });

  it("0xAA NAND 0x55 = 0xFF (no overlapping bits)", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(build8(facade));
    facade.setSignal(coord, "A", 0xAA);
    facade.setSignal(coord, "B", 0x55);
    facade.step(coord);
    expect(facade.readSignal(coord, "OUT")).toBe(0xFF);
  });

  it("0xFF NAND 0xFF = 0x00 (all-ones bus)", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const coord = facade.compile(build8(facade));
    facade.setSignal(coord, "A", 0xFF);
    facade.setSignal(coord, "B", 0xFF);
    facade.step(coord);
    expect(facade.readSignal(coord, "OUT")).toBe(0x00);
  });
});
