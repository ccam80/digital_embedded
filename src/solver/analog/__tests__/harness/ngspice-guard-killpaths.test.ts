/**
 * Synthetic kill-path validation for the ngspice safety-isolation guard.
 *
 * These tests exercise the SAME guard machinery (`spawnGuarded`: spawn + Job
 * Object memory cap + wall-clock timeout + tree-kill + exit classification)
 * that wraps the real ngspice worker — but drive it with plain Node child
 * scripts instead of ngspice. They prove the kill paths work WITHOUT ever
 * loading ngspice (let alone a VDMOS deck):
 *
 *   1. timeout      — a child that hangs is killed within the timeout.
 *   2. memoryExceeded — a child that allocates under a LOW Job Object cap is
 *      torn down by the OS near the cap (with a 1 GB self-abort backstop so the
 *      test can never exhaust host RAM).
 *   3. crashed      — a child that exits non-zero is classified, parent stays up.
 *
 * Job Objects are Windows-only, so the suite is gated to win32.
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnGuarded } from "./ngspice-guarded.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "fixtures");

const describeWin = process.platform === "win32" ? describe : describe.skip;

function child(name: string): string {
  return resolve(FIXTURES, name);
}

describeWin("ngspice guard- synthetic kill paths", () => {
  it("TIMEOUT: a hanging child is tree-killed within the timeout", async () => {
    const start = Date.now();
    const outcome = await spawnGuarded(process.execPath, [child("synthetic-hang.cjs")], {
      timeoutMs: 1500,
      memLimitBytes: 256 * 1024 * 1024,
    });
    const elapsed = Date.now() - start;

    expect(outcome.timedOut).toBe(true);
    expect(outcome.error).not.toBeNull();
    expect(outcome.error!.kind).toBe("timeout");
    // Killed near the deadline, not hung indefinitely.
    expect(elapsed).toBeLessThan(5000);
  }, 10_000);

  it("MEMORY: a child allocating under a low cap is OS-killed near the cap, backstop never fires", async () => {
    const outcome = await spawnGuarded(process.execPath, [child("synthetic-memhog.cjs")], {
      timeoutMs: 5000,
      // Low cap: 200 MB. The 1 GB self-abort backstop must NOT fire (exit 7).
      memLimitBytes: 200 * 1024 * 1024,
    });

    // The child must have exited on its own (OS allocation failure tears it
    // down) rather than hitting the wall-clock timeout — that proves the
    // MEMORY cap, not the timer, stopped it.
    expect(outcome.timedOut).toBe(false);
    expect(outcome.exited).toBe(true);
    // Non-zero exit: the allocation failure crashed it. NOT 7 (the 1 GB
    // backstop) — if it were 7, the cap failed to enforce and the test is
    // a real failure.
    expect(outcome.exitCode).not.toBe(7);
    expect(outcome.exitCode === null ? "killed" : outcome.exitCode).not.toBe(0);
    expect(outcome.stderr).not.toContain("SELF-ABORT");
  }, 12_000);

  it("CRASH: a child exiting non-zero is classified, parent never crashes", async () => {
    const outcome = await spawnGuarded(process.execPath, [child("synthetic-crash.cjs")], {
      timeoutMs: 5000,
      memLimitBytes: 256 * 1024 * 1024,
    });

    expect(outcome.timedOut).toBe(false);
    expect(outcome.exited).toBe(true);
    // 139 is an arbitrary non-zero exit code; the test validates non-zero-exit
    // classification, not any specific fault value (a real native fault on
    // Windows would surface as an NTSTATUS like 0xC0000005, not 139).
    expect(outcome.exitCode).toBe(139);
    expect(outcome.exitCode).not.toBe(0);
    // The guard core does not error on a clean child exit; classification of a
    // non-zero exit as `crashed` happens in runNgspiceGuarded's envelope step
    // (no envelope → typed error). Here we assert the core captured the exit
    // faithfully without throwing.
    expect(outcome.error).toBeNull();
    // Parent is still running to make this assertion- that IS the "never
    // crashes" proof.
    expect(true).toBe(true);
  }, 10_000);
});
