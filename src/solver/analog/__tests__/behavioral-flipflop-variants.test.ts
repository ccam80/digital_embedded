/**
 * Tests for behavioral analog factories for JK, RS, and T flip-flops.
 *
 * Registration tests verify that all flip-flop ComponentDefinitions have
 * the expected modelRegistry entries.
 */

import { describe, it, expect } from "vitest";
import { JKDefinition } from "../../../components/flipflops/jk.js";
import { RSDefinition } from "../../../components/flipflops/rs.js";
import { TDefinition } from "../../../components/flipflops/t.js";
import { JKAsyncDefinition } from "../../../components/flipflops/jk-async.js";
import { RSAsyncDefinition } from "../../../components/flipflops/rs-async.js";
import { DAsyncDefinition } from "../../../components/flipflops/d-async.js";

// ---------------------------------------------------------------------------
// Registration tests
// ---------------------------------------------------------------------------

describe("Registration", () => {
  it("all_flipflops_have_modelRegistry", () => {
    expect(JKDefinition.modelRegistry).toBeDefined();
    expect(RSDefinition.modelRegistry).toBeDefined();
    expect(TDefinition.modelRegistry).toBeDefined();
    expect(JKAsyncDefinition.modelRegistry).toBeDefined();
    expect(RSAsyncDefinition.modelRegistry).toBeDefined();
    expect(DAsyncDefinition.modelRegistry).toBeDefined();
  });
});
