/**
 * Surface 2 (MCP tool) — harness_run_dcop OPtran param-forwarding.
 *
 * Exercises the real registered harness_run_dcop handler via a ToolCapture mock
 * (mirrors McpServer.registerTool). Confirms the `optran` argument rides the
 * params-forwarding contract: enabling it configures the digiTS engine for the
 * OPtran fallback (ngspice optran.c / cktop.c:101-108) and issues the ngspice
 * `optran ... ` analysis variant, and the DC-OP comparison runs end to end on
 * the inductor-singular fixture (both sides reach v1=3, v2=5).
 *
 * Gated on the ngspice DLL: harness_run_dcop runs the instrumented DLL, so the
 * test skips when the DLL is absent (same gate the ngspice-parity suite uses).
 */

import { describe, it, expect } from "vitest";
import { resolve } from "path";
import { registerHarnessTools } from "../harness-tools.js";
import { HarnessSessionState } from "../harness-session-state.js";
import { ngspiceDllFileExists } from "../../../src/solver/analog/__tests__/harness/ngspice-dll-path.js";

const DTS_PATH = resolve(
  process.cwd(),
  "src/solver/analog/__tests__/ngspice-parity/fixtures/optran-inductor-singular.dts",
);

const describeIfDll = ngspiceDllFileExists() ? describe : describe.skip;

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function buildHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (n: string, _m: unknown, h: Handler) => handlers.set(n, h),
  } as never;
  registerHarnessTools(server, new HarnessSessionState());
  return handlers;
}

describeIfDll("harness_run_dcop OPtran — Surface 2 MCP", () => {
  it("registers harness_run_dcop with an optional optran param", () => {
    const handlers = buildHandlers();
    expect(handlers.has("harness_run_dcop")).toBe(true);
  });

  it("forwards the optran option to both engines and runs the DC-OP comparison", async () => {
    const handlers = buildHandlers();
    const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const r = await handlers.get(name)!(args);
      return r.content[0]!.text;
    };

    const startText = await call("harness_start", { dtsPath: DTS_PATH });
    const start = JSON.parse(startText) as { handle: string };
    expect(start.handle).toBeTruthy();

    const runText = await call("harness_run_dcop", {
      handle: start.handle,
      optran: { opstepsize: 1e-8, opfinaltime: 1e-6, opramptime: 0 },
    });
    const run = JSON.parse(runText) as {
      analysis: string;
      errors: string[];
    };
    expect(run.analysis).toBe("dcop");
    expect(run.errors).toEqual([]);

    await call("harness_dispose", { handle: start.handle });
  }, 240_000);
});
