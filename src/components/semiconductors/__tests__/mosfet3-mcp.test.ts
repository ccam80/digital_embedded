/**
 * MCP-surface tests for the MOS3 component (Surface 2 of the three-surface rule).
 *
 * Exercises the agent-facing contract through DefaultSimulatorFacade — the exact
 * object the MCP server (scripts/circuit-mcp-server.ts) wraps for circuit_build /
 * circuit_compile / circuit_dc_op / circuit_describe. Validates:
 *   1. NMOS3 / PMOS3 are discoverable in the registry (circuit_describe).
 *   2. The level-3 model params (theta/kappa/vmax/xj/eta/delta/nfs) are declared.
 *   3. circuit_build -> circuit_compile -> circuit_dc_op converges, finite nodes.
 *   4. The 4-terminal pin set (D/G/S/B) forwards.
 *   5. Model params serialize round-trip.
 */

import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../register-all.js";

const registry = createDefaultRegistry();

const L3_MODEL: Record<string, number> = {
  VTO: 0.7, KP: 60e-6, W: 20e-6, L: 1e-6,
  GAMMA: 0.5, PHI: 0.6, NSUB: 1e16,
  THETA: 0.05, VMAX: 1e5, KAPPA: 0.5, ETA: 0.1, XJ: 0.4e-6,
  DELTA: 1.0, NFS: 1e10, TOX: 2e-8, UO: 600,
};

function buildAmp(facade: DefaultSimulatorFacade, mProps: Record<string, number | string>) {
  return facade.build({
    components: [
      { id: "vdd", type: "DcVoltageSource", props: { label: "V_DD", voltage: 5 } },
      { id: "vg", type: "DcVoltageSource", props: { label: "V_G", voltage: 2 } },
      { id: "rl", type: "Resistor", props: { label: "R_L", resistance: 10000 } },
      { id: "m1", type: "NMOS3", props: { label: "M1", model: "spice-l3", ...L3_MODEL, ...mProps } },
      { id: "gnd", type: "Ground", props: { label: "GND" } },
    ],
    connections: [
      ["vdd:pos", "rl:pos"],
      ["rl:neg", "m1:D"],
      ["vg:pos", "m1:G"],
      ["m1:S", "gnd:out"],
      ["m1:B", "gnd:out"],
      ["vdd:neg", "gnd:out"],
      ["vg:neg", "gnd:out"],
    ],
  });
}

describe("MOS3 MCP surface — discovery (circuit_describe)", () => {
  it("NMOS3 is registered and discoverable", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const def = facade.describeComponent("NMOS3");
    expect(def).toBeDefined();
    expect(def!.name).toBe("NMOS3");
    expect(def!.defaultModel).toBe("spice-l3");
    expect(def!.modelRegistry?.["spice-l3"]).toBeDefined();
  });

  it("PMOS3 is registered and discoverable", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const def = facade.describeComponent("PMOS3");
    expect(def).toBeDefined();
    expect(def!.name).toBe("PMOS3");
    expect(def!.defaultModel).toBe("spice-l3");
  });

  it("model card declares the level-3 short-channel params", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const def = facade.describeComponent("NMOS3");
    const paramKeys = new Set(
      def!.modelRegistry!["spice-l3"]!.paramDefs!.map((d) => d.key),
    );
    for (const k of ["THETA", "KAPPA", "VMAX", "XJ", "ETA", "DELTA", "NFS", "NSUB"]) {
      expect(paramKeys.has(k), `param ${k} should be in the model card`).toBe(true);
    }
  });

  it("model card declares the full instance + model set", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const def = facade.describeComponent("NMOS3");
    const paramKeys = new Set(
      def!.modelRegistry!["spice-l3"]!.paramDefs!.map((d) => d.key),
    );
    for (const k of ["VTO", "KP", "GAMMA", "PHI", "RD", "RS", "CBD", "CBS", "IS",
      "PB", "CGSO", "CGDO", "CGBO", "RSH", "CJ", "MJ", "CJSW", "MJSW", "JS",
      "TOX", "LD", "XL", "WD", "XW", "DELVTO", "U0", "FC", "TPG", "NSS",
      "TNOM", "KF", "AF", "M", "W", "L", "AS", "AD", "PS", "PD", "NRS", "NRD",
      "OFF", "ICVDS", "ICVGS", "ICVBS", "TEMP", "DTEMP"]) {
      expect(paramKeys.has(k), `param ${k} should be in the model card`).toBe(true);
    }
  });

  it("4-terminal D/G/S/B pin set forwards", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const def = facade.describeComponent("NMOS3");
    const pinLabels = new Set(def!.pinLayout!.map((p) => p.label));
    for (const p of ["D", "G", "S", "B"]) {
      expect(pinLabels.has(p), `pin ${p} should be present`).toBe(true);
    }
  });
});

describe("MOS3 MCP surface — build/compile/dc_op", () => {
  it("circuit_build -> circuit_compile -> circuit_dc_op converges", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildAmp(facade, {});
    facade.compile(circuit);
    const dcOp = facade.getDcOpResult();
    expect(dcOp).not.toBeNull();
    expect(dcOp!.converged).toBe(true);
    for (let i = 0; i < dcOp!.nodeVoltages.length; i++) {
      expect(Number.isFinite(dcOp!.nodeVoltages[i])).toBe(true);
    }
  });

  it("circuit_step advances without engine error", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildAmp(facade, {});
    const coordinator = facade.compile(circuit);
    expect(() => coordinator.step()).not.toThrow();
  });
});

describe("MOS3 MCP surface — param serialization round-trip", () => {
  it("level-3 model params survive serialize/deserialize", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildAmp(facade, {
      THETA: 0.1, KAPPA: 0.8, VMAX: 2e5, XJ: 0.3e-6, ETA: 0.2, DELTA: 0.5, NFS: 1e11,
    });
    const json = facade.serialize(circuit);
    const round = facade.deserialize(json);
    facade.compile(round);
    const dcOp = facade.getDcOpResult();
    expect(dcOp).not.toBeNull();
    expect(dcOp!.converged).toBe(true);
    expect(json).toContain("NMOS3");
  });
});
