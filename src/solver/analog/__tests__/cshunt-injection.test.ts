/**
 * `.option cshunt` injection — Surface 1 (headless). Exercises the
 * `analysis#recon/cshunt` injection pass (inppas4.c:54-75) directly through the
 * MNAEngine, with no transport layer:
 *   - the gate (cshunt <= 0 = off, inp.c:466) injects nothing;
 *   - cshunt > 0 injects exactly one AnalogCapacitorElement to ground per
 *     external/netlist voltage node (1..nodeCount), value = cshunt, pos bound to
 *     the voltage node and neg bound to ground (inppas4.c:62-67);
 *   - device-internal voltage nodes (a diode's internal anode, minted in
 *     setup() with number > nodeCount when RS != 0, diosetup.c:303-312 /
 *     diode.ts:838-844) get NO shunt cap;
 *   - the field is hot-loadable: a configure() change to the active cshunt
 *     value rebuilds the injected set on the next analysis.
 *
 * The fixture is cshunt-gate.dts (V1 sine -> R1 -> mid; D1(RS=10) mid->gnd; R2
 * mid->gnd): RS != 0 makes the diode mint a device-internal anode node
 * (D1#internal, number 3 > nodeCount 2), the load-bearing exclusion probe. The
 * paired-ngspice bit-exact gate is the separate Surface-3 test
 * (ngspice-parity/cshunt-parity.test.ts).
 */

import { describe, it, expect } from "vitest";
import { resolve } from "path";
import { buildFixture } from "./fixtures/build-fixture.js";

import type { Fixture } from "./fixtures/build-fixture.js";

const GATE_DTS = resolve(
  process.cwd(),
  "src/solver/analog/__tests__/ngspice-parity/fixtures/cshunt-gate.dts",
);

// Injected shunt-cap leaves are labelled capac<n>shunt (inppas4.c:58).
function shuntCaps(circuit: { elements: readonly { label: string }[] }): readonly { label: string }[] {
  return circuit.elements.filter(el => /^capac\d+shunt$/.test(el.label));
}

function posOf(el: { label: string }): number {
  return (el as unknown as { pinNodes: Map<string, number> }).pinNodes.get("pos")!;
}
function negOf(el: { label: string }): number {
  return (el as unknown as { pinNodes: Map<string, number> }).pinNodes.get("neg")!;
}

function gate(cshunt?: number): Fixture {
  return buildFixture({ dtsPath: GATE_DTS, ...(cshunt === undefined ? {} : { params: { cshunt } }) });
}

describe(".option cshunt injection (headless)", () => {
  it("default (cshunt unset = -1): injects nothing", () => {
    const fx = gate();
    expect(shuntCaps(fx.circuit)).toHaveLength(0);
  });

  it("cshunt <= 0: gated off (inp.c:466 sr<=0), injects nothing", () => {
    expect(shuntCaps(gate(0).circuit)).toHaveLength(0);
    expect(shuntCaps(gate(-2).circuit)).toHaveLength(0);
  });

  it("cshunt > 0: one cap to ground per external voltage node, value = cshunt", () => {
    const fx = gate(1e-9);
    const caps = shuntCaps(fx.circuit);
    // Two external/netlist voltage nodes (in, mid) -> two injected caps.
    const nodeCount = fx.circuit.nodeCount;
    expect(nodeCount).toBe(2);
    expect(caps).toHaveLength(2);

    // Each leaf: pos in 1..nodeCount, neg = ground 0 (inppas4.c:62-63); together
    // they cover every external node exactly once.
    const covered = new Set<number>();
    for (const el of caps) {
      expect(negOf(el)).toBe(0);
      expect(posOf(el)).toBeGreaterThanOrEqual(1);
      expect(posOf(el)).toBeLessThanOrEqual(nodeCount);
      covered.add(posOf(el));
    }
    expect(covered.size).toBe(nodeCount);
  });

  it("device-internal node (diode anode, RS != 0) is EXCLUDED", () => {
    // RS=10 makes the diode mint an internal anode node D1#internal with number
    // 3 > nodeCount 2 (diosetup.c:303-312; diode.ts:838-844). The injection
    // iterates only 1..nodeCount, so no injected cap lands on it.
    const fx = gate(1e-9);
    const caps = shuntCaps(fx.circuit);
    const nodeTable = fx.engine.getNodeTable();
    const internalVoltageNodes = nodeTable.filter(
      n => n.type === "voltage" && n.number > fx.circuit.nodeCount,
    );
    // The diode internal anode exists above nodeCount (positive exclusion probe).
    expect(internalVoltageNodes.length).toBeGreaterThanOrEqual(1);
    const internalNumbers = new Set(internalVoltageNodes.map(n => n.number));

    // No injected cap is bound to any device-internal voltage node.
    for (const el of caps) {
      expect(internalNumbers.has(posOf(el))).toBe(false);
    }
    // Cap count equals the EXTERNAL node count, never external + internal.
    expect(caps).toHaveLength(fx.circuit.nodeCount);
  });

  it("hot-loadable: configure() changing the active cshunt rebuilds the injected set", () => {
    // Start with cshunt off; warm-start runs _setup with no injection.
    const fx = gate();
    expect(shuntCaps(fx.engine.compiled!)).toHaveLength(0);

    // Turn cshunt on post-setup. configure() detects the structural change and
    // rebuilds so the next analysis re-runs _setup() and injects the new set.
    fx.engine.configure({ cshunt: 1e-9 });
    fx.coordinator.step();
    expect(shuntCaps(fx.engine.compiled!)).toHaveLength(2);

    // Re-configuring to the SAME value is a no-op (no rebuild, no double-inject).
    fx.engine.configure({ cshunt: 1e-9 });
    fx.coordinator.step();
    expect(shuntCaps(fx.engine.compiled!)).toHaveLength(2);

    // Turn it back off: the rebuild strips the prior leaves.
    fx.engine.configure({ cshunt: -1 });
    fx.coordinator.step();
    expect(shuntCaps(fx.engine.compiled!)).toHaveLength(0);
  });
});
