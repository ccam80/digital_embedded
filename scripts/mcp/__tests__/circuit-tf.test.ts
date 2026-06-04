/**
 * .tf transfer-function — Surfaces 1 (headless facade) and 2 (MCP tool).
 *
 * The `analysis#recon/tf` driver (MNAEngine.transferFunction → runTransferFunction,
 * the tfanal.c port) re-solves the factored DC-OP Jacobian. These two surfaces
 * validate the core logic and the agent-facing contract without a transport
 * layer; the bit-exact-vs-ngspice check lives in the paired parity suite
 * (src/solver/analog/__tests__/ngspice-parity/tf-parity.test.ts).
 *
 * Fixture: resistive-divider.dts (V1=5, R1=R2=1k). The .tf of a resistive
 * divider is closed-form rational arithmetic, so the analytic values below are
 * exactly what ngspice computes: transfer 0.5, Rin R1+R2=2k, Rout R1||R2=500.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createDefaultRegistry } from "../../../src/components/register-all.js";
import { DefaultSimulatorFacade } from "../../../src/headless/default-facade.js";
import { registerSimulationTools } from "../simulation-tools.js";
import { SessionState } from "../tool-helpers.js";
import type { ComponentRegistry } from "../../../src/core/registry.js";

const DIVIDER = resolve(
  process.cwd(),
  "src/solver/analog/__tests__/ngspice-parity/fixtures/resistive-divider.dts",
);

let registry: ComponentRegistry;
let facade: DefaultSimulatorFacade;

beforeAll(() => {
  registry = createDefaultRegistry();
  facade = new DefaultSimulatorFacade(registry);
});

describe("circuit .tf — Surface 1 (headless facade)", () => {
  it("transferFunction returns transfer ratio / Zin / Zout for a resistive divider", () => {
    const circuit = facade.getLoader().loadJson(readFileSync(DIVIDER, "utf8"));
    const coordinator = facade.compile(circuit);
    const r = coordinator.transferFunction({ inputSource: "V1", output: "R1:neg" });
    expect(r).not.toBeNull();
    expect(r!.converged).toBe(true);
    expect(r!.transferFunction).toBeCloseTo(0.5, 12);
    expect(r!.inputResistance).toBeCloseTo(2000, 6);
    expect(r!.outputResistance).toBeCloseTo(500, 9);
  });

  it("source-current output uses the same-source shortcut (Rout === Rin)", () => {
    const circuit = facade.getLoader().loadJson(readFileSync(DIVIDER, "utf8"));
    const coordinator = facade.compile(circuit);
    const r = coordinator.transferFunction({ inputSource: "V1", output: "I(V1)" });
    expect(r).not.toBeNull();
    expect(r!.converged).toBe(true);
    expect(r!.transferFunction).toBeCloseTo(-5e-4, 12);
    expect(r!.inputResistance).toBeCloseTo(2000, 6);
    // tfanal.c:132-139 shortcut: output is the input source current → Rout = Rin.
    expect(r!.outputResistance).toBe(r!.inputResistance);
  });

  it("reports a not-of-proper-type failure for a non-source input", () => {
    const circuit = facade.getLoader().loadJson(readFileSync(DIVIDER, "utf8"));
    const coordinator = facade.compile(circuit);
    const r = coordinator.transferFunction({ inputSource: "R1", output: "R1:neg" });
    expect(r).not.toBeNull();
    expect(r!.converged).toBe(false);
    expect(r!.diagnostics.some(d => d.severity === "error")).toBe(true);
  });
});

describe("circuit_tf — Surface 2 (MCP tool)", () => {
  type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

  function buildHandlers(): { call: (args: Record<string, unknown>) => Promise<string>; handle: string } {
    const handlers = new Map<string, Handler>();
    const server = { registerTool: (n: string, _m: unknown, h: Handler) => handlers.set(n, h) } as never;
    const session = new SessionState();
    registerSimulationTools(server, facade, registry, session);

    const circuit = facade.getLoader().loadJson(readFileSync(DIVIDER, "utf8"));
    const handle = session.store(circuit);
    const coordinator = facade.compile(circuit);
    session.storeEngine(handle, coordinator);

    const call = async (args: Record<string, unknown>): Promise<string> => {
      const r = await handlers.get("circuit_tf")!(args);
      return r.content[0]!.text;
    };
    return { call, handle };
  }

  it("formats transfer ratio, input resistance, and output resistance", async () => {
    const { call, handle } = buildHandlers();
    const text = await call({ handle, inputSource: "V1", output: "R1:neg" });
    expect(text).toContain("Converged: true");
    expect(text).toContain("Transfer ratio");
    expect(text).toContain("0.5");
    expect(text).toContain("2000");
    expect(text).toContain("500");
  });

  it("surfaces the resolution error for an unknown output node", async () => {
    const { call, handle } = buildHandlers();
    const text = await call({ handle, inputSource: "V1", output: "nope" });
    expect(text).toMatch(/not found|error/i);
  });
});
