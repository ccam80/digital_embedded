// Side-effect-free-import probe for the ngspice guard.
//
// Run as a standalone child (node --import tsx import-guard-probe.mjs). It
// imports the guard chain and then closes its own stdin and idles briefly. If
// the worker's main() were to run on import (the defect), it would: read this
// child's stdin (now ended → empty spec), write a RESULT_BEGIN envelope to
// stdout, and process.exit(2). The entry-point guard + protocol-marker split
// must prevent all of that.
//
// On success the probe prints exactly "PROBE_CLEAN_EXIT" and exits 0 — proving
// nothing else wrote to stdout and nothing forced an early exit code.
//
// Path is taken from argv[2] so the test can pass the absolute guard path
// without hard-coding it here.

import { pathToFileURL } from "node:url";

const guardPath = process.argv[2];

async function run() {
  // Importing the guard pulls in the whole harness chain (ngspice-guarded ->
  // ngspice-worker-protocol, ngspice-job-serde, win32-job-object, ngspice-bridge).
  // It must NOT execute the worker's main().
  // On Windows, ESM import() of an absolute path requires a file:// URL.
  await import(pathToFileURL(guardPath).href);

  // End our own stdin so that, IF a stray worker were listening on it, its
  // readStdin() would resolve and trigger the envelope-write + process.exit.
  process.stdin.resume();
  process.stdin.on("data", () => {});
  if (process.stdin.readable) process.stdin.push(null);
  try {
    process.stdin.destroy();
  } catch {
    /* ignore */
  }

  // Give any stray async worker a window to misbehave before we declare clean.
  await new Promise((r) => setTimeout(r, 400));

  process.stdout.write("PROBE_CLEAN_EXIT");
  // Natural exit (code 0). A stray worker would have forced exit(2)/exit(3)
  // before reaching here.
}

run().catch((err) => {
  process.stderr.write("PROBE_IMPORT_ERROR: " + (err && err.message ? err.message : String(err)) + "\n");
  process.exit(1);
});
