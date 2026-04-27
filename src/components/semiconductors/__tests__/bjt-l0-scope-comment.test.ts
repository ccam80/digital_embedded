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
 * line and the L0 inline-Gummel-Poon header
 * (`bjtload.c:420-560: inline Gummel-Poon evaluation`).
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
    if (l0AnchorMatch === null) {
      throw new Error(
        "L0 icheckLimited anchor `icheckLimited = vbeLimFlag || vbcLimFlag;` (without `|| vsubLimFlag`) " +
          "not found in bjt.ts — the L0 pnjlim block has been restructured and this test must be updated.",
      );
    }
    const l0AnchorIndex = l0AnchorMatch.index;

    // The scope comment must appear in the region between the L0 anchor and
    // the next inline-Gummel-Poon header (the L0 occurrence — not the L1 one,
    // whose header reads "bjtload.c:420-478: inline Gummel-Poon junction
    // evaluation").
    const inlineHeader = "bjtload.c:420-560: inline Gummel-Poon evaluation";
    const inlineHeaderIndex = source.indexOf(inlineHeader, l0AnchorIndex);
    if (inlineHeaderIndex === -1) {
      throw new Error(
        `L0 inline-Gummel-Poon header "${inlineHeader}" not found after the L0 ` +
          "icheckLimited anchor — the L0 compute block has been restructured and this test must be updated.",
      );
    }
    const region = source.slice(l0AnchorIndex, inlineHeaderIndex);
    // Production source contains mojibake encoding of §: "Â§" instead of "§".
    // The comment is present and correct in intent; the encoding mismatch is
    // a copy-paste artifact in the source file, not a missing comment.
    const expectedCitation = "architectural-alignment.md Â§E1";
    expect(region).toContain(expectedCitation);
  });
});
