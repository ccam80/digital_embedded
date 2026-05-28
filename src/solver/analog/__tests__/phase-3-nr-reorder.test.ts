// Tests NR loop-top NISHOULDREORDER-routing citation hygiene in newton-raphson.ts and dc-operating-point.ts.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Task 3.1.2- non-top-of-loop NISHOULDREORDER-routing citations
// ---------------------------------------------------------------------------

describe("Task 3.1.2- non-top-of-loop NISHOULDREORDER-routing citations", () => {
  it("cites niiter.c:856-859 in the loop-top gate comment", () => {
    // Read the newton-raphson.ts file and verify the citation is present
    const nrPath = path.join(
      path.dirname(__dirname),
      "newton-raphson.ts"
    );
    const content = fs.readFileSync(nrPath, "utf-8");

    // Find the NISHOULDREORDER trigger within the loop-top mode gate
    const lines = content.split("\n");
    let foundCitation = false;

    // Search for the comment block before the NISHOULDREORDER routing assignment
    // The citation should appear within 30 lines before the first `shouldReorder = true`
    // set in the NR loop (the loop-top mode-gate).
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("shouldReorder = true")) {
        // This is a NISHOULDREORDER trigger; check the preceding 30 lines for the citation
        const searchStart = Math.max(0, i - 30);
        const searchText = lines.slice(searchStart, i).join("\n");
        if (searchText.includes("niiter.c:856-859")) {
          foundCitation = true;
          break;
        }
      }
    }

    expect(foundCitation).toBe(true);
  });

  it("cites niiter.c:888-891 at the E_SINGULAR retry", () => {
    // Read the newton-raphson.ts file and verify the E_SINGULAR retry citation
    const nrPath = path.join(
      path.dirname(__dirname),
      "newton-raphson.ts"
    );
    const content = fs.readFileSync(nrPath, "utf-8");
    const lines = content.split("\n");

    let foundCitation = false;

    // Find the NISHOULDREORDER trigger within the E_SINGULAR retry block
    // It should be preceded by a check on solver.lastFactorWalkedReorder.
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("shouldReorder = true") && i > 0) {
        // Check if this is in the E_SINGULAR retry block by looking for preceding context
        const contextStart = Math.max(0, i - 10);
        const contextText = lines.slice(contextStart, i).join("\n");
        if (contextText.includes("lastFactorWalkedReorder") || contextText.includes("!factorResult")) {
          // This is the E_SINGULAR retry block; check for the citation
          const citationStart = Math.max(0, i - 10);
          const citationText = lines.slice(citationStart, i).join("\n");
          if (citationText.includes("niiter.c:888-891")) {
            foundCitation = true;
            break;
          }
        }
      }
    }

    expect(foundCitation).toBe(true);
  });

  it("rejects a stale niiter.c:474-499 citation anywhere in NR path", () => {
    const nrPath = path.join(
      path.dirname(__dirname),
      "newton-raphson.ts"
    );
    const dcOpPath = path.join(
      path.dirname(__dirname),
      "dc-operating-point.ts"
    );

    const nrContent = fs.readFileSync(nrPath, "utf-8");
    const dcOpContent = fs.readFileSync(dcOpPath, "utf-8");

    // Assert that neither file contains the stale citation
    expect(nrContent).not.toContain("niiter.c:474-499");
    expect(dcOpContent).not.toContain("niiter.c:474-499");
  });
});
