/**
 * Surface 2 (MCP tool) — circuit_dc_op indVerbosity param-forwarding.
 *
 * Exercises the real registered circuit_dc_op handler via a ToolCapture mock
 * (mirrors McpServer.registerTool). Confirms indVerbosity rides the params-
 * forwarding contract: verbosity 2 surfaces the inductive-system verify
 * diagnostic, verbosity 0 disables it.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { createDefaultRegistry } from "../../../src/components/register-all.js";
import { DefaultSimulatorFacade } from "../../../src/headless/default-facade.js";
import { MutualInductorElement } from "../../../src/components/passives/mutual-inductor.js";
import { registerSimulationTools } from "../simulation-tools.js";
import { SessionState } from "../tool-helpers.js";
import type { ComponentRegistry } from "../../../src/core/registry.js";

let registry: ComponentRegistry;
let facade: DefaultSimulatorFacade;

beforeAll(() => {
  registry = createDefaultRegistry();
  facade = new DefaultSimulatorFacade(registry);
});

describe("circuit_dc_op indVerbosity — Surface 2 MCP", () => {
  it("gates the inductive-system verify diagnostic by indVerbosity", async () => {
    type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
    const handlers = new Map<string, Handler>();
    const server = { registerTool: (n: string, _m: unknown, h: Handler) => handlers.set(n, h) } as never;
    const session = new SessionState();
    registerSimulationTools(server, facade, registry, session);

    const circuit = facade.build({
      components: [
        { id: "vs", type: "AcVoltageSource", props: { label: "VS", amplitude: 1, frequency: 1000 } },
        { id: "tx", type: "Transformer", props: { label: "TX1", model: "behavioral", turnsRatio: 1, primaryInductance: 1e-3, couplingCoefficient: 0.5 } },
        { id: "rl", type: "Resistor", props: { label: "RL", resistance: 1000 } },
        { id: "gnd", type: "Ground", props: { label: "GND" } },
      ],
      connections: [
        ["vs:pos", "tx:P1"], ["vs:neg", "gnd:out"], ["tx:P2", "gnd:out"],
        ["tx:S1", "rl:pos"], ["rl:neg", "gnd:out"], ["tx:S2", "gnd:out"],
      ],
    });
    const handle = session.store(circuit);
    const coordinator = facade.compile(circuit);
    session.storeEngine(handle, coordinator);
    coordinator.dcOperatingPoint();

    // Transformer clamps couplingCoefficient to <=1; hot-load an invalid K=1.5
    // onto the MUT element to exercise the not-positive-definite path.
    const mut = coordinator.getAnalogEngine()!.elements.find(
      e => e instanceof MutualInductorElement,
    ) as MutualInductorElement;
    mut.setParam("K", 1.5);

    const emitted: string[] = [];
    coordinator.getAnalogEngine()!.onDiagnostic(d => emitted.push(d.code));

    const call = async (args: Record<string, unknown>): Promise<string> => {
      const r = await handlers.get("circuit_dc_op")!(args);
      return r.content[0]!.text;
    };

    emitted.length = 0;
    const v2 = await call({ handle, indVerbosity: 2 });
    expect(v2).toContain("inductive-system-not-positive-definite");
    expect(emitted).toContain("inductive-system-not-positive-definite");

    emitted.length = 0;
    await call({ handle, indVerbosity: 0 });
    expect(emitted).not.toContain("inductive-system-not-positive-definite");
  });
});
