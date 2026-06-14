/**
 * Tests for the digitalPinLoading circuit metadata field, on the real
 * production registry (createDefaultRegistry). The per-pin boundary synthesis
 * expands real SPICE-faithful adapter composites, so a stub registry cannot
 * exercise it- these tests build real mixed circuits and read the compiled
 * per-pin adapter map (bridgeAdaptersByPinKey).
 *
 * Modes:
 *   cross-domain (default): adapters only at real digital↔analog boundaries.
 *   all:                    every digital net gets an analog domain injected,
 *                           so each crossing digital pin gets a loaded adapter.
 *   none:                   real boundaries only (same set as cross-domain).
 */

import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../components/register-all.js";
import { compileUnified } from "@/compile/compile.js";
import type { CompiledAnalogCircuit } from "../../../core/analog-engine-interface.js";

const registry = createDefaultRegistry();
const facade = new DefaultSimulatorFacade(registry);

// In(A),In(B) → And(digital) → Resistor → Ground.
// And:out↔Resistor:pos is a real digital→analog boundary (one crossing in
// cross-domain). In "all" mode the pure-digital In→And nets also gain an analog
// domain, so their crossing pins get loaded adapters too.
function buildMixed(mode?: "cross-domain" | "all" | "none") {
  const c = facade.build({
    components: [
      { id: "A", type: "In", props: { label: "A", bitWidth: 1 } },
      { id: "B", type: "In", props: { label: "B", bitWidth: 1 } },
      { id: "g", type: "And", props: { model: "digital" } },
      { id: "r", type: "Resistor", props: { label: "R", resistance: 1000 } },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["A:out", "g:In_1"],
      ["B:out", "g:In_2"],
      ["g:out", "r:pos"],
      ["r:neg", "gnd:out"],
    ],
  });
  if (mode) c.metadata.digitalPinLoading = mode;
  return c;
}

// Pure-digital In(A),In(B) → And → Out(Y): no analog domain at all.
function buildPureDigital(mode?: "cross-domain" | "all" | "none") {
  const c = facade.build({
    components: [
      { id: "A", type: "In", props: { label: "A", bitWidth: 1 } },
      { id: "B", type: "In", props: { label: "B", bitWidth: 1 } },
      { id: "g", type: "And" },
      { id: "Y", type: "Out", props: { label: "Y", bitWidth: 1 } },
    ],
    connections: [
      ["A:out", "g:In_1"],
      ["B:out", "g:In_2"],
      ["g:out", "Y:in"],
    ],
  });
  if (mode) c.metadata.digitalPinLoading = mode;
  return c;
}

function countBridgeAdapters(analog: CompiledAnalogCircuit | null): number {
  // Per-pin: one handle per crossing digital pin- the flat map's size is the count.
  return analog === null ? 0 : analog.bridgeAdaptersByPinKey.size;
}

describe("digitalPinLoading: cross-domain (default)", () => {
  it("absent metadata defaults to cross-domain: no bridges for a pure-digital circuit", () => {
    const compiled = compileUnified(buildPureDigital(), registry);
    expect(compiled.bridges).toHaveLength(0);
  });

  it("explicit cross-domain: a real boundary produces exactly the crossing adapters", () => {
    const compiled = compileUnified(buildMixed("cross-domain"), registry);
    // Only And:out↔Resistor is a real boundary → one output crossing pin.
    expect(compiled.bridges.filter((b) => b.role === "output")).toHaveLength(1);
    expect(compiled.bridges.filter((b) => b.role === "input")).toHaveLength(0);
    expect(countBridgeAdapters(compiled.analog)).toBe(1);
  });
});

describe("digitalPinLoading: all", () => {
  it("all mode produces more per-pin adapters than cross-domain", () => {
    const all = compileUnified(buildMixed("all"), registry);
    const cross = compileUnified(buildMixed("cross-domain"), registry);
    expect(countBridgeAdapters(all.analog)).toBeGreaterThan(countBridgeAdapters(cross.analog));
  });

  it("all mode: per-pin adapters are stored in bridgeAdaptersByPinKey", () => {
    const compiled = compileUnified(buildMixed("all"), registry);
    expect(compiled.analog).not.toBeNull();
    expect(countBridgeAdapters(compiled.analog)).toBeGreaterThan(0);
  });

  it("all mode: each adapter handle carries a role and an expanded wrapper", () => {
    const compiled = compileUnified(buildMixed("all"), registry);
    expect(compiled.analog).not.toBeNull();
    for (const handle of compiled.analog!.bridgeAdaptersByPinKey.values()) {
      expect(handle.role === "input" || handle.role === "output").toBe(true);
      expect(handle.wrapper).toBeDefined();
    }
  });

  it("all mode: both input and output per-pin adapters appear (And out + In_1/In_2)", () => {
    const compiled = compileUnified(buildMixed("all"), registry);
    let hasInput = false;
    let hasOutput = false;
    for (const handle of compiled.analog!.bridgeAdaptersByPinKey.values()) {
      if (handle.role === "input") hasInput = true;
      if (handle.role === "output") hasOutput = true;
    }
    expect(hasInput).toBe(true);
    expect(hasOutput).toBe(true);
  });
});

describe("digitalPinLoading: none", () => {
  it("none mode adapter count equals cross-domain (same real boundaries)", () => {
    const none = compileUnified(buildMixed("none"), registry);
    const cross = compileUnified(buildMixed("cross-domain"), registry);
    expect(none.bridges.length).toBe(cross.bridges.length);
    expect(countBridgeAdapters(none.analog)).toBe(countBridgeAdapters(cross.analog));
  });
});

describe("digitalPinLoading: ordering invariant (all > cross-domain >= none)", () => {
  it("all > cross-domain >= none for the same mixed circuit", () => {
    const all = countBridgeAdapters(compileUnified(buildMixed("all"), registry).analog);
    const cross = countBridgeAdapters(compileUnified(buildMixed("cross-domain"), registry).analog);
    const none = countBridgeAdapters(compileUnified(buildMixed("none"), registry).analog);
    expect(all).toBeGreaterThan(cross);
    expect(cross).toBeGreaterThanOrEqual(none);
  });
});
