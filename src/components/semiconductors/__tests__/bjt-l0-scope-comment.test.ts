/**
 * Phase 4 Task 4.2.2 — BJT L0 scope-comment presence test.
 *
 * Guards the structural comment that explains why the L0 `load()` pnjlim block
 * stops at `icheckLimited = vbeLimFlag || vbcLimFlag;` (no vsubLimFlag). The
 * comment names `architectural-alignment.md §E1` so that a reader arriving at
 * the line finds the L0/L1 substrate divergence rationale immediately.
 *
 * The test reads `bjt.ts` as text (no element construction) and asserts the
 * substring appears between the L0 `icheckLimited = vbeLimFlag || vbcLimFlag;`
 * line and the L0 `computeBjtOp(` call.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BJT_PATH = resolve(__dirname, "..", "bjt.ts");

describe("BJT L0 scope documentation", () => {
  it("documents L0 substrate divergence after pnjlim block", () => {
    const source = readFileSync(BJT_PATH, "utf8");

    // L0 load() body has `icheckLimited = vbeLimFlag || vbcLimFlag;` (no vsub).
    // L1 load() body has `icheckLimited = vbeLimFlag || vbcLimFlag || vsubLimFlag;`
    // We want the L0 occurrence specifically — the one without `|| vsubLimFlag`.
    const l0AnchorRegex = /icheckLimited = vbeLimFlag \|\| vbcLimFlag;(?! \|\| vsubLimFlag)/;
    const l0AnchorMatch = l0AnchorRegex.exec(source);
    expect(l0AnchorMatch, "L0 icheckLimited anchor line must exist").not.toBeNull();
    const l0AnchorIndex = l0AnchorMatch!.index;

    // Find the next `computeBjtOp(` call after the L0 anchor — this delimits
    // the region in which the scope comment must appear.
    const computeBjtOpIndex = source.indexOf("computeBjtOp(", l0AnchorIndex);
    expect(computeBjtOpIndex, "computeBjtOp( must appear after L0 icheckLimited line").toBeGreaterThan(
      l0AnchorIndex,
    );

    const region = source.slice(l0AnchorIndex, computeBjtOpIndex);
    expect(
      region.includes("architectural-alignment.md §E1"),
      "L0 scope comment citing architectural-alignment.md §E1 must appear between the " +
        "L0 `icheckLimited = vbeLimFlag || vbcLimFlag;` line and the L0 `computeBjtOp(` call",
    ).toBe(true);
  });
});
