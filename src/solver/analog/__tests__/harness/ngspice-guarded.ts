/**
 * ngspice-guarded.ts — the safety-isolated entry point for every ngspice run.
 *
 * Spawns `ngspice-worker.ts` as a child process and wraps it in two orthogonal
 * kernel-enforced guards so a runaway native deck (e.g. VDMOS) can never again
 * take down the MCP server or the host:
 *
 *   1. MEMORY — a Windows Job Object with a per-process commit cap
 *      (`assignProcessToMemoryCappedJob`). This is the SINGLE memory mechanism;
 *      there is deliberately no parent-side RSS-poll backstop. If the Job Object
 *      cannot be established the run is aborted (we never proceed unguarded).
 *   2. WALL CLOCK — a timer that tree-kills the child (`taskkill /F /T`) and the
 *      job on expiry. Orthogonal hang backstop; covers spins that never grow
 *      memory.
 *
 * On child exit the parent extracts the framed result envelope from stdout and
 * returns the reconstructed `CaptureSession` / AC points, or rejects with a
 * TYPED error (`timeout` | `memoryExceeded` | `crashed` | `parseError`). The
 * parent NEVER throws synchronously on a child fault — every failure path
 * resolves the same promise with a typed rejection.
 *
 * The `spawnGuarded` core (spawn + Job Object + timeout + tree-kill + exit
 * classification) is factored out so the synthetic kill-path tests exercise the
 * exact same guard machinery the real ngspice path uses — only the result
 * decoding differs.
 *
 * The `CaptureSession` / `AcCaptureSession` shape returned here is byte-identical
 * to the in-process path, so all downstream diff/compare code is unchanged.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { decodeFromTransport } from "./ngspice-job-serde.js";
// Import the protocol markers from the side-effect-free module, NOT from
// ngspice-worker.ts. Importing the worker module would run its `main()` in
// whatever process loaded the guard (e.g. the MCP server), spawning a stray
// worker that fights the JSON-RPC transport. The guard never imports the
// executing worker module — only its file path (resolved at spawn time).
import { RESULT_BEGIN, RESULT_END } from "./ngspice-worker-protocol.js";
import { assignProcessToMemoryCappedJob } from "./win32-job-object.js";
import type { JobObjectGuard } from "./win32-job-object.js";
import type {
  NgspiceJobSpec,
  NgspiceRunResult,
} from "./ngspice-bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Conservative defaults for real runs. Tests pass small caps explicitly. */
export const DEFAULT_GUARD_TIMEOUT_MS = 60_000;
export const DEFAULT_GUARD_MEM_LIMIT_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

export type GuardErrorKind = "timeout" | "memoryExceeded" | "crashed" | "parseError";

/** Typed failure from a guarded run. The parent never lets a child fault throw
 *  raw; every fault becomes one of these. */
export class GuardedRunError extends Error {
  readonly kind: GuardErrorKind;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly childStderr: string;
  constructor(
    kind: GuardErrorKind,
    message: string,
    opts: { exitCode?: number | null; signal?: NodeJS.Signals | null; childStderr?: string } = {},
  ) {
    super(message);
    this.name = "GuardedRunError";
    this.kind = kind;
    this.exitCode = opts.exitCode ?? null;
    this.signal = opts.signal ?? null;
    this.childStderr = opts.childStderr ?? "";
  }
}

export interface GuardOptions {
  timeoutMs?: number;
  memLimitBytes?: number;
}

/** Outcome of a guarded spawn, BEFORE result-envelope interpretation. */
export interface GuardedSpawnOutcome {
  /** True when the child exited on its own within the timeout. */
  exited: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Set when the wall-clock timer fired and we killed the child. */
  timedOut: boolean;
  /** Typed error, when the guard itself classified a fault (timeout / spawn
   *  failure / could-not-isolate). null on a normal child exit. */
  error: GuardedRunError | null;
}

/** Best-effort Windows process-tree kill. Used on timeout. */
function treeKill(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // The child may already be gone; tree-kill is best-effort.
  }
}

/**
 * Spawn `command args` as a child, bind it to a memory-capped Job Object, set a
 * wall-clock timeout, and resolve with a structured outcome once it exits (or
 * is killed). NEVER rejects — the parent must never crash on a child fault, so
 * every fault is reported in the resolved `GuardedSpawnOutcome`.
 *
 * `onSpawned(child)` runs synchronously right after the Job Object is attached,
 * so callers can write to stdin without racing the isolation setup.
 */
export function spawnGuarded(
  command: string,
  args: string[],
  opts: GuardOptions & { onSpawned?: (child: ChildProcess) => void } = {},
): Promise<GuardedSpawnOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GUARD_TIMEOUT_MS;
  const memLimitBytes = opts.memLimitBytes ?? DEFAULT_GUARD_MEM_LIMIT_BYTES;

  return new Promise<GuardedSpawnOutcome>((resolvePromise) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let jobGuard: JobObjectGuard | null = null;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (jobGuard) {
        // Closing the job releases handles AND (KILL_ON_JOB_CLOSE) kills any
        // child still alive — a final safety net.
        jobGuard.close();
        jobGuard = null;
      }
    };

    const settle = (outcome: Omit<GuardedSpawnOutcome, "stdout" | "stderr">): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({ ...outcome, stdout, stderr });
    };

    child.on("error", (err) => {
      settle({
        exited: false,
        exitCode: null,
        signal: null,
        timedOut: false,
        error: new GuardedRunError("crashed", `failed to spawn child: ${err.message}`),
      });
    });

    if (child.pid === undefined) {
      // 'error' will fire; nothing else to do.
      return;
    }

    // Establish the Job Object memory cap BEFORE the child does real work. If
    // isolation cannot be established, abort rather than proceed unguarded.
    try {
      jobGuard = assignProcessToMemoryCappedJob(child.pid, memLimitBytes);
    } catch (err) {
      treeKill(child.pid);
      settle({
        exited: false,
        exitCode: null,
        signal: null,
        timedOut: false,
        error: new GuardedRunError(
          "crashed",
          `could not establish Job Object memory isolation: ${err instanceof Error ? err.message : String(err)}`,
        ),
      });
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) treeKill(child.pid);
      if (jobGuard) jobGuard.terminate();
      settle({
        exited: false,
        exitCode: null,
        signal: null,
        timedOut: true,
        error: new GuardedRunError("timeout", `child exceeded ${timeoutMs}ms wall-clock timeout`),
      });
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });

    child.on("exit", (code, signal) => {
      if (timedOut) return; // already settled by the timer
      settle({
        exited: true,
        exitCode: code,
        signal,
        timedOut: false,
        error: null,
      });
    });

    // Hand the live child to the caller (e.g. to write stdin) now that the Job
    // Object is attached.
    if (opts.onSpawned) opts.onSpawned(child);
  });
}

/** Extract the JSON between RESULT_BEGIN / RESULT_END markers, ignoring any
 *  ngspice native chatter that interleaved on stdout. Returns null if the
 *  envelope is absent (the worker died before emitting one). */
function extractEnvelope(stdout: string): string | null {
  const begin = stdout.indexOf(RESULT_BEGIN);
  if (begin < 0) return null;
  const end = stdout.indexOf(RESULT_END, begin + RESULT_BEGIN.length);
  if (end < 0) return null;
  return stdout.slice(begin + RESULT_BEGIN.length, end);
}

/**
 * Run one ngspice job in an isolated, memory-capped, time-bounded child.
 *
 * Resolves with the reconstructed `NgspiceRunResult`; rejects with a
 * `GuardedRunError` whose `kind` classifies the fault. Never rejects with an
 * untyped error and never crashes the parent on a child fault.
 */
export async function runNgspiceGuarded(
  spec: NgspiceJobSpec,
  opts: GuardOptions = {},
): Promise<NgspiceRunResult> {
  const memLimitBytes = opts.memLimitBytes ?? DEFAULT_GUARD_MEM_LIMIT_BYTES;
  const workerPath = resolve(__dirname, "ngspice-worker.ts");

  // Launch the .ts worker through tsx's loader. `node --import tsx` is the
  // package's sanctioned way to run TS entry points (tsx is a devDependency).
  const outcome = await spawnGuarded(process.execPath, ["--import", "tsx", workerPath], {
    ...opts,
    onSpawned: (child) => {
      // Feed the job spec to the worker and close stdin so it starts. Wrapped
      // so a broken pipe (child already dead) doesn't throw out of the guard.
      try {
        child.stdin?.write(JSON.stringify(spec));
        child.stdin?.end();
      } catch {
        /* child may already be gone; its exit will be classified below */
      }
    },
  });

  // Guard-classified fault (timeout / spawn failure / isolation failure).
  if (outcome.error) {
    // Attach stderr for diagnostics.
    throw new GuardedRunError(outcome.error.kind, outcome.error.message, {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      childStderr: outcome.stderr,
    });
  }

  const envelope = extractEnvelope(outcome.stdout);

  // No result envelope — the worker died before emitting one. Classify by exit
  // code / signal: a signal is a hard native crash; a non-zero exit with no
  // envelope after a memory-capped run is the OS tearing it down for the cap.
  if (envelope === null) {
    if (outcome.signal) {
      throw new GuardedRunError("crashed", `worker killed by signal ${outcome.signal} with no result`, {
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        childStderr: outcome.stderr,
      });
    }
    throw new GuardedRunError(
      "memoryExceeded",
      `worker exited (code=${outcome.exitCode}) without emitting a result; ` +
        `likely the Job Object memory cap (${memLimitBytes} bytes) or a native abort. ` +
        `stderr: ${outcome.stderr.slice(-2000)}`,
      { exitCode: outcome.exitCode, signal: outcome.signal, childStderr: outcome.stderr },
    );
  }

  // We have an envelope. Parse it.
  let parsed: { ok: boolean; result?: unknown; error?: string; stack?: string };
  try {
    parsed = JSON.parse(envelope);
  } catch (err) {
    throw new GuardedRunError(
      "parseError",
      `failed to parse worker result envelope: ${err instanceof Error ? err.message : String(err)}`,
      { exitCode: outcome.exitCode, signal: outcome.signal, childStderr: outcome.stderr },
    );
  }

  if (!parsed.ok) {
    // The worker ran but ngspice (or the spec) errored internally. Clean,
    // reportable failure — surface as `crashed` with the message.
    throw new GuardedRunError("crashed", `ngspice worker reported error: ${parsed.error ?? "(no message)"}`, {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      childStderr: outcome.stderr,
    });
  }

  try {
    return decodeFromTransport(parsed.result) as NgspiceRunResult;
  } catch (err) {
    throw new GuardedRunError(
      "parseError",
      `failed to decode worker result: ${err instanceof Error ? err.message : String(err)}`,
      { exitCode: outcome.exitCode, signal: outcome.signal, childStderr: outcome.stderr },
    );
  }
}
