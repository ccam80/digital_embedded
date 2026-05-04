/**
 * Tests for the Triac (bidirectional thyristor) component.
 *
 * The Triac is a netlist-based composite of four BJT sub-elements representing
 * two anti-parallel SCRs sharing a gate terminal. Tests exercise the component
 * definition metadata, parameter declarations, and end-to-end simulation
 * via DefaultSimulatorFacade.
 *
 * Covers:
 *   - definition_has_correct_fields: TriacDefinition exports correct metadata
 *   - netlist_structure: TRIAC_NETLIST has correct ports, elements, and internal net count
 *   - param_presence: TRIAC_PARAM_DEFS contains expected parameter keys
 *   - facade_compile_does_not_throw: compile() does not throw for a valid Triac circuit
 *   - dcop_converges: DC operating point converges for a resistively-loaded Triac
 */

import { describe, it, expect } from "vitest";
import { TriacDefinition, TRIAC_PARAM_DEFS, TRIAC_NETLIST, TRIAC_PARAM_DEFAULTS } from "../triac.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../register-all.js";

// ---------------------------------------------------------------------------
// Triac netlist structure tests
// ---------------------------------------------------------------------------

describe("TRIAC_NETLIST structure", () => {
  it("has three ports: MT2, MT1, G", () => {
    expect(TRIAC_NETLIST.ports).toEqual(["MT2", "MT1", "G"]);
  });

  it("has four sub-elements: Q1, Q2, Q3, Q4", () => {
    expect(TRIAC_NETLIST.elements).toHaveLength(4);
    expect(TRIAC_NETLIST.elements[0].subElementName).toBe("Q1");
    expect(TRIAC_NETLIST.elements[1].subElementName).toBe("Q2");
    expect(TRIAC_NETLIST.elements[2].subElementName).toBe("Q3");
    expect(TRIAC_NETLIST.elements[3].subElementName).toBe("Q4");
  });

  it("has exactly two internal nets (latch1 and latch2)", () => {
    expect(TRIAC_NETLIST.internalNetCount).toBe(2);
    expect(TRIAC_NETLIST.internalNetLabels).toContain("latch1");
    expect(TRIAC_NETLIST.internalNetLabels).toContain("latch2");
  });

  it("netlist connectivity has four rows (one per element)", () => {
    expect(TRIAC_NETLIST.netlist).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Triac definition metadata tests
// ---------------------------------------------------------------------------

describe("TriacDefinition", () => {
  it("definition_has_correct_fields", () => {
    expect(TriacDefinition.name).toBe("Triac");
    expect(TriacDefinition.modelRegistry?.["behavioral"]).toBeDefined();
    expect(TriacDefinition.modelRegistry?.["behavioral"]?.kind).toBe("netlist");
    expect(TriacDefinition.category).toBe("SEMICONDUCTORS");
    expect(TriacDefinition.defaultModel).toBe("behavioral");
  });

  it("behavioral model entry has paramDefs and params", () => {
    const entry = TriacDefinition.modelRegistry?.["behavioral"];
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe("netlist");
    if (entry!.kind === "netlist") {
      expect(entry!.paramDefs).toBeDefined();
      expect(entry!.params).toBeDefined();
      expect(entry!.params["BF"]).toBeCloseTo(100);
      expect(entry!.params["IS"]).toBeLessThan(1e-14);
    }
  });

  it("TRIAC_PARAM_DEFAULTS has expected keys", () => {
    expect(TRIAC_PARAM_DEFAULTS).toHaveProperty("BF");
    expect(TRIAC_PARAM_DEFAULTS).toHaveProperty("BR");
    expect(TRIAC_PARAM_DEFAULTS).toHaveProperty("IS");
    expect(TRIAC_PARAM_DEFAULTS).toHaveProperty("TEMP");
    expect(TRIAC_PARAM_DEFAULTS).toHaveProperty("AREA");
  });

  it("TRIAC_PARAM_DEFS contains BF, BR, IS entries", () => {
    const bfDef = TRIAC_PARAM_DEFS.find((d) => d.key === "BF");
    const brDef = TRIAC_PARAM_DEFS.find((d) => d.key === "BR");
    const isDef = TRIAC_PARAM_DEFS.find((d) => d.key === "IS");

    expect(bfDef).toBeDefined();
    expect(brDef).toBeDefined();
    expect(isDef).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Triac end-to-end simulation tests via DefaultSimulatorFacade
// ---------------------------------------------------------------------------

describe("Triac simulation", () => {
  it("facade_compile_does_not_throw for minimal Triac circuit", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);

    const circuit = facade.build({
      components: [
        { id: "vs",    type: "DcVoltageSource", props: { label: "vs",    voltage: 5 } },
        { id: "r1",    type: "Resistor",        props: { label: "r1",    resistance: 100 } },
        { id: "triac", type: "Triac",           props: { label: "triac" } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vs:pos",    "r1:pos"],
        ["r1:neg",    "triac:MT2"],
        ["triac:MT1", "gnd:out"],
        ["triac:G",   "gnd:out"],
        ["vs:neg",    "gnd:out"],
      ],
    });

    expect(() => facade.compile(circuit)).not.toThrow();
  });

  it("dcop_converges for resistively-loaded Triac in blocking state", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);

    const circuit = facade.build({
      components: [
        { id: "vs",    type: "DcVoltageSource", props: { label: "vs",    voltage: 5 } },
        { id: "r1",    type: "Resistor",        props: { label: "r1",    resistance: 1000 } },
        { id: "triac", type: "Triac",           props: { label: "triac" } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vs:pos",    "r1:pos"],
        ["r1:neg",    "triac:MT2"],
        ["triac:MT1", "gnd:out"],
        ["triac:G",   "gnd:out"],
        ["vs:neg",    "gnd:out"],
      ],
    });

    const coordinator = facade.compile(circuit);
    const result = coordinator.dcOperatingPoint();

    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
  });

  it("dcop_converges for Triac with gate bias applied", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);

    const circuit = facade.build({
      components: [
        { id: "va",    type: "DcVoltageSource", props: { label: "va",    voltage: 10 } },
        { id: "vg",    type: "DcVoltageSource", props: { label: "vg",    voltage: 0.65 } },
        { id: "ra",    type: "Resistor",        props: { label: "ra",    resistance: 100 } },
        { id: "rg",    type: "Resistor",        props: { label: "rg",    resistance: 100 } },
        { id: "triac", type: "Triac",           props: { label: "triac" } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["va:pos",    "ra:pos"],
        ["ra:neg",    "triac:MT2"],
        ["triac:MT1", "gnd:out"],
        ["vg:pos",    "rg:pos"],
        ["rg:neg",    "triac:G"],
        ["vg:neg",    "gnd:out"],
        ["va:neg",    "gnd:out"],
      ],
    });

    const coordinator = facade.compile(circuit);
    const result = coordinator.dcOperatingPoint();

    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
  });

  it("dcop_converges for reverse polarity Triac", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);

    const circuit = facade.build({
      components: [
        { id: "vs",    type: "DcVoltageSource", props: { label: "vs",    voltage: 5 } },
        { id: "r1",    type: "Resistor",        props: { label: "r1",    resistance: 1000 } },
        { id: "triac", type: "Triac",           props: { label: "triac" } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vs:pos",    "r1:pos"],
        ["r1:neg",    "triac:MT1"],
        ["triac:MT2", "gnd:out"],
        ["triac:G",   "gnd:out"],
        ["vs:neg",    "gnd:out"],
      ],
    });

    const coordinator = facade.compile(circuit);
    const result = coordinator.dcOperatingPoint();

    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
  });
});
