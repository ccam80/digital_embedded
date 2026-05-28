/**
 * ngspice-worker.ts — the ONLY process that loads ngspice via koffi.
 *
 * Spawned as a child by `runNgspiceGuarded` (ngspice-guarded.ts). Reads a
 * single `NgspiceJobSpec` JSON document from stdin, drives one ngspice run via
 * the shared `runNgspiceInProcess` (no FFI logic is duplicated here), encodes
 * the `NgspiceRunResult` with the transport serializer, and writes it to stdout
 * wrapped in unique result markers. Exits 0 on success, non-zero on any error.
 *
 * Why markers: ngspice.dll writes diagnostics straight to the process's fd 1 /
 * fd 2, bypassing koffi's SendChar callback (see run-all-tests.mjs). That noise
 * can interleave with our payload on stdout. The parent extracts exactly the
 * bytes between RESULT_BEGIN and RESULT_END, so interleaved native chatter is
 * harmless. Errors go to stderr AND a marked stdout envelope so the parent can
 * classify them even when the exit code alone is ambiguous.
 *
 * Run via: `node --import tsx <thisfile>` (or `tsx <thisfile>`). The guard
 * picks the launcher.
 */

import { pathToFileURL } from "node:url";
import { runNgspiceInProcess } from "./ngspice-bridge.js";
import type { NgspiceJobSpec } from "./ngspice-bridge.js";
import { encodeForTransport } from "./ngspice-job-serde.js";
import { RESULT_BEGIN, RESULT_END } from "./ngspice-worker-protocol.js";

function readStdin(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolvePromise(data));
    process.stdin.on("error", reject);
  });
}

function emitResult(payload: unknown): void {
  // Single atomic write of the framed envelope.
  process.stdout.write(RESULT_BEGIN + JSON.stringify(payload) + RESULT_END);
}

async function main(): Promise<void> {
  let spec: NgspiceJobSpec;
  try {
    const raw = await readStdin();
    if (!raw.trim()) {
      throw new Error("ngspice-worker: empty job spec on stdin");
    }
    spec = JSON.parse(raw) as NgspiceJobSpec;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitResult({ ok: false, error: `job-spec parse failed: ${message}` });
    process.stderr.write(`ngspice-worker: ${message}\n`);
    process.exit(2);
    return;
  }

  try {
    const result = await runNgspiceInProcess(spec);
    emitResult({ ok: true, result: encodeForTransport(result) });
    // Explicit success exit. ngspice's static teardown can otherwise leave the
    // event loop alive; force a clean 0.
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    emitResult({ ok: false, error: message, stack });
    process.stderr.write(`ngspice-worker: run failed: ${message}\n`);
    process.exit(3);
  }
}

// Entry-point guard: run `main()` ONLY when this module is the launched script
// (node --import tsx ngspice-worker.ts). When the module is merely IMPORTED
// — e.g. the stdio MCP server pulling in the harness chain — `main()` must NOT
// run, or it would read the server's stdin, write a worker envelope to its
// stdout (corrupting the JSON-RPC transport), and `process.exit` the server.
// Defense-in-depth alongside the marker split into ngspice-worker-protocol.ts.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
