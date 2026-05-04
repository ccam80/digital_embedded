/**
 * Tests for the TappedTransformer component.
 *
 * §4c gap-fill (2026-05-03): the prior test file impersonated the engine
 * end-to-end - it instantiated the (now-deleted) `AnalogTappedTransformerElement`
 * with positional MNA constructor args, hand-rolled `SetupContext` with
 * `allocStates` / `makeCur` shims, drove `el.load(ctx)` through
 * `loadCtxFromFields`, and read state from `_l1.statePoolForMut.s0[base+0]`.
 * None of those surfaces survive §4: `AnalogTappedTransformerElement` has been
 * replaced by the netlist composite from `buildTappedTransformerNetlist` (3 x
 * Inductor + 3 x TransformerCoupling), the test-helpers module is deleted, and
 * direct setup/load drives are §3 poison.
 *
 * Bit-exact per-NR-iteration parity (the prior "C4.2 transient parity" check)
 * is covered by the ngspice comparison harness (`harness_*` MCP tools,
 * `src/solver/analog/__tests__/ngspice-parity/*`). Auto-deleted per
 * category-1 §4c rules.
 *
 * BLOCKED: behavioural transient tests (centre-tap voltage halving,
 * symmetric halves, full-wave rectifier) cannot run today because the
 * netlist composite hits a real engine bug at compile time:
 * `TransformerCoupling: ctx.findBranch(":L2") returned 0`. The compiler's
 * `siblingBranch` resolver (compiler.ts:391-394) writes
 * `${labelRef.value}:${subElementName}` into the leaf's prop bag at
 * SUB-ELEMENT CONSTRUCTION TIME, but `labelRef.value` is still `""` at that
 * point - it is patched later, when the per-instance caller invokes
 * `SubcircuitWrapperElement.setLabel(...)`. The leaf therefore caches the
 * stale `:L2` string, and `_findBranch(":L2")` returns 0 because the
 * deviceMap key is `tx:L2`. Same defect affects RelayCoupling and
 * InternalCccs; both currently happen to dodge it because their composites
 * are not actively driven by tests today.
 *
 * Logged as a §4e engine quirk - fix requires changing the siblingBranch
 * contract so the leaf re-reads the resolved label after `setLabel` runs
 * (or stores a live `labelRef` and concatenates at `setup()` time). That is
 * out of scope for this test migration; the entry on this line in
 * `manual_fix_list.md` should remain `[ ]` until the engine bug is fixed.
 *
 * Remaining coverage in this file:
 *   - Component definition / pinLayout / attributeMapping smoke tests
 *   - behavioural-model registration shape (kind: "netlist", Composite M26)
 */

import { describe, it, expect } from "vitest";
import {
  TappedTransformerDefinition,
  TAPPED_TRANSFORMER_ATTRIBUTE_MAPPINGS,
} from "../tapped-transformer.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";

// ---------------------------------------------------------------------------
// ComponentDefinition smoke tests
// ---------------------------------------------------------------------------

describe("TappedTransformerDefinition", () => {
  it("name is TappedTransformer", () => {
    expect(TappedTransformerDefinition.name).toBe("TappedTransformer");
  });

  it("TappedTransformerDefinition has behavioral model", () => {
    expect(TappedTransformerDefinition.modelRegistry?.behavioral).toBeDefined();
  });

  it("behavioral model is netlist-form (Composite M26 decomposition)", () => {
    const entry = TappedTransformerDefinition.modelRegistry?.behavioral;
    expect(entry?.kind).toBe("netlist");
  });

  it("category is PASSIVES", () => {
    expect(TappedTransformerDefinition.category).toBe(ComponentCategory.PASSIVES);
  });

  it("pinLayout has 5 entries with correct labels", () => {
    expect(TappedTransformerDefinition.pinLayout).toHaveLength(5);
    const labels = TappedTransformerDefinition.pinLayout.map((p) => p.label);
    expect(labels).toContain("P1");
    expect(labels).toContain("P2");
    expect(labels).toContain("S1");
    expect(labels).toContain("CT");
    expect(labels).toContain("S2");
  });

  it("can be registered without error", () => {
    const registry = new ComponentRegistry();
    expect(() => registry.register(TappedTransformerDefinition)).not.toThrow();
  });

  it("attribute mappings include turnsRatio", () => {
    const m = TAPPED_TRANSFORMER_ATTRIBUTE_MAPPINGS.find((a) => a.xmlName === "turnsRatio");
    expect(m).toBeDefined();
    expect(m!.propertyKey).toBe("turnsRatio");
  });
});
