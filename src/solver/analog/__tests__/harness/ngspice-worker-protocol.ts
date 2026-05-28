/**
 * ngspice-worker-protocol.ts — side-effect-free shared constants for the
 * guarded-worker stdout protocol.
 *
 * Lives apart from `ngspice-worker.ts` (which runs `main()` at module load) so
 * the guard parent (`ngspice-guarded.ts`) and any importer of the harness chain
 * can reference the result markers WITHOUT executing the worker. This file does
 * nothing on import: no I/O, no `main()`, no `process.exit`.
 *
 * The worker writes its JSON result payload framed between these markers on
 * stdout. They are long + random-looking so they cannot collide with ngspice's
 * own diagnostics, which the DLL writes straight to fd 1 / fd 2 (bypassing the
 * koffi SendChar callback). The parent extracts exactly the bytes between the
 * markers, so interleaved native chatter is harmless.
 */

export const RESULT_BEGIN = "<<<NGSPICE_WORKER_RESULT_BEGIN_7f3a9c>>>";
export const RESULT_END = "<<<NGSPICE_WORKER_RESULT_END_7f3a9c>>>";
