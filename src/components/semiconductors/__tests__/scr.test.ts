/**
 * Tests for the SCR (Silicon Controlled Rectifier) component.
 *
 * The SCR is a netlist-based composite of two BJT sub-elements in a
 * two-transistor latch configuration (Q1 NPN + Q2 PNP). Tests exercise
 * the component definition metadata, parameter declarations, and
 * end-to-end simulation via DefaultSimulatorFacade.
 *
 * Covers:
 *   - definition_has_correct_fields: ScrDefinition exports correct metadata
 *   - partition_layout: SCR_PARAM_DEFS has correct partition assignments
 *   - param_presence: SCR_PARAM_DEFS contains expected parameter keys
 *   - netlist_structure: SCR_NETLIST has correct ports, elements, and internal net count
 *   - facade_compile_does_not_throw: compile() does not throw for a valid SCR circuit
 *   - dcop_converges: DC operating point converges for a resistively-loaded SCR
 */

import { describe, it, expect } from "vitest";
import { ScrDefinition, SCR_PARAM_DEFS, SCR_NETLIST, SCR_PARAM_DEFAULTS } from "../scr.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../register-all.js";

// ---------------------------------------------------------------------------
// SCR partition layout tests
// ---------------------------------------------------------------------------

describe("SCR_PARAM_DEFS partition layout", () => {
  it("TEMP and AREA have partition='instance'", () => {
    const tempDef = SCR_PARAM_DEFS.find((d) => d.key === "TEMP");
    const areaDef = SCR_PARAM_DEFS.find((d) => d.key === "AREA");

    expect(tempDef).toBeDefined();
    expect(areaDef).toBeDefined();

    expect(tempDef!.partition).toBe("instance");
    expect(areaDef!.partition).toBe("instance");
  });

  it("BF BR IS are present in SCR_PARAM_DEFS", () => {
    const bfDef = SCR_PARAM_DEFS.find((d) => d.key === "BF");
    const brDef = SCR_PARAM_DEFS.find((d) => d.key === "BR");
    const isDef = SCR_PARAM_DEFS.find((d) => d.key === "IS");

    expect(bfDef).toBeDefined();
    expect(brDef).toBeDefined();
    expect(isDef).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// SCR netlist structure tests
// ---------------------------------------------------------------------------

describe("SCR_NETLIST structure", () => {
  it("has three ports: A, K, G", () => {
    expect(SCR_NETLIST.ports).toEqual(["A", "K", "G"]);
  });

  it("has two sub-elements: Q1 NPN and Q2 PNP", () => {
    expect(SCR_NETLIST.elements).toHaveLength(2);
    expect(SCR_NETLIST.elements[0].subElementName).toBe("Q1");
    expect(SCR_NETLIST.elements[1].subElementName).toBe("Q2");
  });

  it("has exactly one internal net (latch node)", () => {
    expect(SCR_NETLIST.internalNetCount).toBe(1);
    expect(SCR_NETLIST.internalNetLabels).toContain("latch");
  });

  it("netlist connectivity has two rows (one per element)", () => {
    expect(SCR_NETLIST.netlist).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// SCR definition metadata tests
// ---------------------------------------------------------------------------

describe("ScrDefinition", () => {
  it("definition_has_correct_fields", () => {
    expect(ScrDefinition.name).toBe("SCR");
    expect(ScrDefinition.modelRegistry?.["behavioral"]).toBeDefined();
    expect(ScrDefinition.modelRegistry?.["behavioral"]?.kind).toBe("netlist");
    expect(ScrDefinition.category).toBe("SEMICONDUCTORS");
    expect(ScrDefinition.defaultModel).toBe("behavioral");
  });

  it("behavioral model entry has paramDefs and params", () => {
    const entry = ScrDefinition.modelRegistry?.["behavioral"];
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe("netlist");
    if (entry!.kind === "netlist") {
      expect(entry!.paramDefs).toBeDefined();
      expect(entry!.params).toBeDefined();
      expect(entry!.params["BF"]).toBeCloseTo(100);
      expect(entry!.params["IS"]).toBeLessThan(1e-14);
    }
  });

  it("SCR_PARAM_DEFAULTS has expected keys", () => {
    expect(SCR_PARAM_DEFAULTS).toHaveProperty("BF");
    expect(SCR_PARAM_DEFAULTS).toHaveProperty("BR");
    expect(SCR_PARAM_DEFAULTS).toHaveProperty("IS");
    expect(SCR_PARAM_DEFAULTS).toHaveProperty("TEMP");
    expect(SCR_PARAM_DEFAULTS).toHaveProperty("AREA");
  });
});

// ---------------------------------------------------------------------------
// SCR end-to-end simulation tests via DefaultSimulatorFacade
// ---------------------------------------------------------------------------

describe("SCR simulation", () => {
  it("facade_compile_does_not_throw for minimal SCR circuit", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);

    const circuit = facade.build({
      components: [
        { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 5 } },
        { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 100 } },
        { id: "scr", type: "SCR",             props: { label: "scr" } },
        { id: "gnd", type: "Ground" },
      ],
      connections: [
        ["vs:pos",  "r1:pos"],
        ["r1:neg",  "scr:A"],
        ["scr:K",   "gnd:out"],
        ["scr:G",   "gnd:out"],
        ["vs:neg",  "gnd:out"],
      ],
    });

    expect(() => facade.compile(circuit)).not.toThrow();
  });

  it("dcop_converges for resistively-loaded SCR in blocking state", async () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);

    const circuit = facade.build({
      components: [
        { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 5 } },
        { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 1000 } },
        { id: "scr", type: "SCR",             props: { label: "scr" } },
        { id: "gnd", type: "Ground" },
      ],
      connections: [
        ["vs:pos",  "r1:pos"],
        ["r1:neg",  "scr:A"],
        ["scr:K",   "gnd:out"],
        ["scr:G",   "gnd:out"],
        ["vs:neg",  "gnd:out"],
      ],
    });

    const coordinator = facade.compile(circuit);
    const result = coordinator.dcOperatingPoint();

    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
  });

  it("dcop_converges for SCR with gate bias applied", async () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);

    const circuit = facade.build({
      components: [
        { id: "va",  type: "DcVoltageSource", props: { label: "va",  voltage: 10 } },
        { id: "vg",  type: "DcVoltageSource", props: { label: "vg",  voltage: 0.65 } },
        { id: "ra",  type: "Resistor",        props: { label: "ra",  resistance: 100 } },
        { id: "rg",  type: "Resistor",        props: { label: "rg",  resistance: 100 } },
        { id: "scr", type: "SCR",             props: { label: "scr" } },
        { id: "gnd", type: "Ground" },
      ],
      connections: [
        ["va:pos",  "ra:pos"],
        ["ra:neg",  "scr:A"],
        ["scr:K",   "gnd:out"],
        ["vg:pos",  "rg:pos"],
        ["rg:neg",  "scr:G"],
        ["vg:neg",  "gnd:out"],
        ["va:neg",  "gnd:out"],
      ],
    });

    const coordinator = facade.compile(circuit);
    const result = coordinator.dcOperatingPoint();

    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);
  });
});
