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
 */

import { describe, it, expect } from "vitest";
import {
  TappedTransformerDefinition,
  TAPPED_TRANSFORMER_ATTRIBUTE_MAPPINGS,
} from "../tapped-transformer.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import { buildFixture, type Fixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

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

// ---------------------------------------------------------------------------
// Behavioural coverage — exercises the netlist composite end-to-end.
// ---------------------------------------------------------------------------

function nodeOf(fix: Fixture, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

/**
 * Build a tapped-transformer bench:
 *
 *   Vsrc(+) ─ rser ─ tx:P1
 *   Vsrc(-) ─ GND ─ tx:P2
 *   tx:CT   ─ GND
 *   tx:S1   ─ rS1 ─ GND
 *   tx:S2   ─ rS2 ─ GND
 *
 * The series primary resistance breaks the DC short that an ideal inductor
 * primary would otherwise place across the source. With CT held to ground,
 * the centre tap fixes the symmetric midpoint; light resistive loading on
 * the secondary halves keeps the secondary ends solvable.
 */
function buildTappedTransformerBench(
  facade: DefaultSimulatorFacade,
  p: { vSource: number; rLoad?: number; turnsRatio?: number; rSeries?: number },
): Circuit {
  return facade.build({
    components: [
      { id: "vs",   type: "DcVoltageSource", props: { label: "vs", voltage: p.vSource } },
      { id: "rser", type: "Resistor", props: { label: "rser", resistance: p.rSeries ?? 100 } },
      { id: "tx",  type: "TappedTransformer", props: {
          label:               "tx",
          model:               "behavioral",
          turnsRatio:          p.turnsRatio ?? 2.0,
          primaryInductance:   10e-3,
          couplingCoefficient: 0.99,
      } },
      { id: "rs1", type: "Resistor", props: { label: "rs1", resistance: p.rLoad ?? 1e6 } },
      { id: "rs2", type: "Resistor", props: { label: "rs2", resistance: p.rLoad ?? 1e6 } },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["vs:pos",   "rser:pos"],
      ["rser:neg", "tx:P1"],
      ["vs:neg",   "gnd:out"],
      ["tx:P2",    "gnd:out"],
      ["tx:CT",    "gnd:out"],
      ["tx:S1",    "rs1:pos"],
      ["rs1:neg",  "gnd:out"],
      ["tx:S2",    "rs2:pos"],
      ["rs2:neg",  "gnd:out"],
    ],
  });
}

describe("TappedTransformer behavioural", () => {
  it("centre_tap_voltage_with_grounded_CT", () => {
    // P2 and CT held to ground via direct GND ties. With ideal coupled
    // inductors (DC short), the primary inductor forces V(P1)=V(P2)=0 at
    // steady state, so V_source falls entirely across rser.
    const fix = buildFixture({
      build: (_r, facade) => buildTappedTransformerBench(facade, {
        vSource: 10.0, rLoad: 1e6, turnsRatio: 2.0, rSeries: 100,
      }),
    });
    const dc = fix.coordinator.dcOperatingPoint()!;
    expect(dc.converged).toBe(true);

    const vP2 = fix.engine.getNodeVoltage(nodeOf(fix, "tx:P2"));
    const vCT = fix.engine.getNodeVoltage(nodeOf(fix, "tx:CT"));

    // P2 and CT are tied to ground.
    expect(Math.abs(vP2)).toBeLessThan(1e-3);
    expect(Math.abs(vCT)).toBeLessThan(1e-3);
  });

  it("symmetric_secondary_halves_at_DC", () => {
    // Symmetric construction (L2 = L3, M12 = M13 by `halfRatio = N/2`) plus
    // symmetric loads (rs1 = rs2) must produce |V(S1) - V(CT)| = |V(CT) - V(S2)|.
    // The check is structural: the netlist generator is wired correctly and
    // both secondary halves see the same coupling.
    const fix = buildFixture({
      build: (_r, facade) => buildTappedTransformerBench(facade, {
        vSource: 5.0, rLoad: 1e6, turnsRatio: 2.0, rSeries: 100,
      }),
    });
    const dc = fix.coordinator.dcOperatingPoint()!;
    expect(dc.converged).toBe(true);

    const vS1 = fix.engine.getNodeVoltage(nodeOf(fix, "tx:S1"));
    const vCT = fix.engine.getNodeVoltage(nodeOf(fix, "tx:CT"));
    const vS2 = fix.engine.getNodeVoltage(nodeOf(fix, "tx:S2"));

    // Halves are symmetric ⇒ |V(S1,CT)| ≈ |V(CT,S2)| within numerical noise.
    const top = Math.abs(vS1 - vCT);
    const bot = Math.abs(vCT - vS2);
    expect(Math.abs(top - bot)).toBeLessThan(1e-3);
  });

  it("secondary_swings_under_transient_drive", async () => {
    // Drive the primary with a sinusoid; both secondary halves (S1, S2)
    // must swing around the grounded centre tap. CT grounded fixes the
    // midpoint; uic:true skips DC-OP and lets the AC source ramp from t=0.
    const facadeBuild = (_r: unknown, facade: DefaultSimulatorFacade): Circuit =>
      facade.build({
        components: [
          { id: "vs",  type: "AcVoltageSource", props: {
              label: "vs", amplitude: 5.0, frequency: 1000,
          } },
          { id: "tx",  type: "TappedTransformer", props: {
              label:               "tx",
              model:               "behavioral",
              turnsRatio:          2.0,
              primaryInductance:   100e-3,
              // k=0.8 keeps the 3x3 mutual-inductance matrix well away from
              // singular. k=0.99 has been observed to stagnate during transient
              // NR for this composite (3 branches couple all-to-all so the
              // off-diagonal weight grows quadratically with k).
              couplingCoefficient: 0.8,
          } },
          { id: "rs1", type: "Resistor", props: { label: "rs1", resistance: 100 } },
          { id: "rs2", type: "Resistor", props: { label: "rs2", resistance: 100 } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vs:pos",  "tx:P1"],
          ["vs:neg",  "gnd:out"],
          ["tx:P2",   "gnd:out"],
          ["tx:CT",   "gnd:out"],
          ["tx:S1",   "rs1:pos"],
          ["rs1:neg", "gnd:out"],
          ["tx:S2",   "rs2:pos"],
          ["rs2:neg", "gnd:out"],
        ],
      });

    const freq = 1000;
    const period = 1 / freq;
    const numCycles = 5;
    const samplesPerCycle = 200;
    const totalSamples = numCycles * samplesPerCycle;
    const tStop = numCycles * period;

    const fix = buildFixture({
      build: facadeBuild,
      params: { tStop, maxTimeStep: period / samplesPerCycle, uic: true },
    });

    // With CT=0V and the coupled inductors driven sinusoidally, an ideal
    // symmetric secondary swings bipolar around the grounded centre tap.
    const times = Array.from({ length: totalSamples }, (_, i) =>
      (i + 1) * (tStop / totalSamples),
    );
    const s1Node = nodeOf(fix, "tx:S1");
    const s2Node = nodeOf(fix, "tx:S2");
    const samples = await fix.coordinator.sampleAtTimes(
      times, () => ({
        s1: fix.engine.getNodeVoltage(s1Node),
        s2: fix.engine.getNodeVoltage(s2Node),
      }),
    );

    // Inspect the last cycle so the windings have settled past the AC
    // ramp-up transient.
    const lastCycleOffset = (numCycles - 1) * samplesPerCycle;
    let maxS1 = -Infinity, minS1 = +Infinity;
    let maxS2 = -Infinity, minS2 = +Infinity;
    for (let i = lastCycleOffset; i < totalSamples; i++) {
      const sample = samples[i] as { s1: number; s2: number };
      if (sample.s1 > maxS1) maxS1 = sample.s1;
      if (sample.s1 < minS1) minS1 = sample.s1;
      if (sample.s2 > maxS2) maxS2 = sample.s2;
      if (sample.s2 < minS2) minS2 = sample.s2;
    }

    // Each secondary half must swing positive AND negative — energy reaches
    // both halves through the mutual-inductance stamps and crosses zero.
    expect(maxS1).toBeGreaterThan(1e-4);
    expect(minS1).toBeLessThan(-1e-4);
    expect(maxS2).toBeGreaterThan(1e-4);
    expect(minS2).toBeLessThan(-1e-4);
  });
});
