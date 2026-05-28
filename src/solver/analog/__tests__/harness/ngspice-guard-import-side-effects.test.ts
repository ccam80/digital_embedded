/**
 * Regression test: importing the ngspice guard chain MUST be side-effect-free.
 *
 * The reviewer reproduced a HIGH defect where importing `ngspice-guarded.ts`
 * (which pulled `RESULT_BEGIN`/`RESULT_END` from `ngspice-worker.ts`) executed
 * the worker's top-level `void main()` in the host process. Any importer — the
 * stdio MCP server via harness-tools.ts → comparison-session.ts →
 * ngspice-guarded.ts — would spawn a stray worker that read the server's stdin,
 * wrote a worker envelope to its stdout (corrupting JSON-RPC), and could
 * `process.exit` the server.
 *
 * The fix is (a) markers moved to side-effect-free `ngspice-worker-protocol.ts`,
 * and (b) an entry-point guard so `main()` runs only when the worker is the
 * launched script. This test locks both down: a clean child that imports the
 * guard chain must emit NO worker envelope and must NOT exit early.
 *
 * Runs on all platforms — the defect (and its fix) are platform-independent;
 * only the actual Job Object run is Windows-only.
 */

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { RESULT_BEGIN } from "./ngspice-worker-protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("ngspice guard- import side effects", () => {
  it("importing the guard chain emits no worker envelope and does not exit early", async () => {
    const probe = resolve(__dirname, "fixtures", "import-guard-probe.mjs");
    const guardPath = resolve(__dirname, "ngspice-guarded.ts");

    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>(
      (resolvePromise) => {
        const child = spawn(process.execPath, ["--import", "tsx", probe, guardPath], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (d: string) => {
          stdout += d;
        });
        child.stderr.on("data", (d: string) => {
          stderr += d;
        });
        // Feed a job-spec-shaped payload on the probe's stdin. If a stray worker
        // were listening, this is exactly the input it would consume and act on,
        // making the defect manifest as an envelope on stdout.
        child.stdin.write(
          JSON.stringify({ dllPath: "x", netlist: "* nothing", analysis: { kind: "dcop" } }),
        );
        child.stdin.end();
        child.on("exit", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
      },
    );

    // No worker result envelope leaked onto stdout.
    expect(result.stdout).not.toContain(RESULT_BEGIN);
    expect(result.stdout).not.toContain("ngspice-worker:");
    // The probe ran to its natural clean end and printed exactly its sentinel.
    expect(result.stdout).toContain("PROBE_CLEAN_EXIT");
    expect(result.stderr).not.toContain("PROBE_IMPORT_ERROR");
    // Clean exit (0) — a stray worker would have forced exit(2)/exit(3) before
    // the probe could finish.
    expect(result.code).toBe(0);
  }, 30_000);
});
