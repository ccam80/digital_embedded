/**
 * V2: per-iteration matrix-entry parity for resistive-divider.
 *
 * Asserts that on the first NR iteration both engines emit the same multiset
 * of (row, col, value) entries. Internal indices on each side are assigned
 * lazily by ngspice's `Translate` / our `_translate` (sparse-solver.ts:399)
 * on first sight of each external row/col. For the indices to match, both
 * engines must call `cktLoad` in the same per-device-type order — that's
 * the A1 sort applied in `compileAnalogPartition` against
 * `ngspiceLoadOrder`.
 *
 * The structural-parity gate in ComparisonSession also runs this check, but
 * having a dedicated parity test means a regression surfaces with a clear
 * test name rather than as a session-init throw inside an unrelated test.
 */

import { it, expect } from "vitest";
import { resolve } from "path";
import { ComparisonSession } from "../harness/comparison-session.js";
import { describeIfDll, DLL_PATH } from "./parity-helpers.js";

const DTS_PATH = resolve(
  process.cwd(),
  "src/solver/analog/__tests__/ngspice-parity/fixtures/resistive-divider.dts",
);

describeIfDll("Load-order parity (matrix entries)", () => {
  it("resistive-divider first-iteration matrix entries match bit-exact", async () => {
    const session = new ComparisonSession({
      dtsPath: DTS_PATH,
      dllPath: DLL_PATH,
    });
    await session.init();
    // runDcOp() triggers the structural-parity gate which throws on any
    // size or matrix-entry divergence. Reaching the assertion below means
    // the gate already passed; we add a redundant explicit assertion so
    // a future change to the gate doesn't silently neutralise this test.
    await session.runDcOp();

    const ourIt =
      session.ourSession?.steps[0]?.attempts[0]?.iterations[0];
    const ngIt =
      session.ngspiceSession?.steps[0]?.attempts[0]?.iterations[0];

    expect(ourIt).toBeDefined();
    expect(ngIt).toBeDefined();
    if (!ourIt || !ngIt) return;

    type Entry = { row: number; col: number; value: number };
    const key = (e: Entry) => `${e.row},${e.col}`;
    const ourMap = new Map<string, Entry>();
    const ngMap = new Map<string, Entry>();
    for (const e of ourIt.matrix) ourMap.set(key(e), e);
    for (const e of ngIt.matrix) ngMap.set(key(e), e);

    expect(
      ourMap.size,
      `Matrix entry count mismatch: ours=${ourMap.size} ngspice=${ngMap.size}`,
    ).toBe(ngMap.size);

    for (const [k, e] of ourMap) {
      const n = ngMap.get(k);
      expect(n, `(${k}) present in ours but missing in ngspice`).toBeDefined();
      if (n !== undefined) {
        expect(
          e.value,
          `Matrix entry (${k}): ours=${e.value} ngspice=${n.value}`,
        ).toBe(n.value);
      }
    }
    for (const k of ngMap.keys()) {
      expect(
        ourMap.has(k),
        `(${k}) present in ngspice but missing in ours`,
      ).toBe(true);
    }
  }, 60_000);
});
