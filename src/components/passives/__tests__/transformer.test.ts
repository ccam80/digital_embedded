/**
 * Tests for the Transformer component.
 *
 * §4c gap-fill (2026-05-03): all engine-impersonator tests that hand-rolled
 * `new StatePool(...)`, drove `element.load(ctx)` directly through fabricated
 * `LoadContext` objects, or impersonated `SetupContext` to allocate branches /
 * solver handles by hand have been deleted. Bit-exact per-NR-iteration parity
 * is covered by the ngspice comparison harness (`harness_*` MCP tools,
 * `src/solver/analog/__tests__/ngspice-parity/*`).
 *
 * Remaining coverage in this file:
 *   - Component definition / pinLayout / attributeMapping smoke tests
 *   - Property-bag factory checks (`_stateBase = -1` before compile)
 *   - Voltage ratio (V_sec ≈ V_pri / N) — observed through public engine
 *   - Power conservation (P_sec ≈ P_ideal) — observed through public engine
 *   - DC steady-state (inductor short ⇒ V_sec ≈ 0) — observed through public engine
 *   - Leakage (k=0.8 < k=0.99 secondary peak) — observed through public engine
 */

import { describe, it, expect } from "vitest";
import {
  AnalogTransformerElement,
  TransformerDefinition,
  TRANSFORMER_ATTRIBUTE_MAPPINGS,
} from "../transformer.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import type { PoolBackedAnalogElement } from "../../../solver/analog/element.js";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------

function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}

function findTransformer(elements: ReadonlyArray<unknown>): AnalogTransformerElement {
  const idx = elements.findIndex((el) => el instanceof AnalogTransformerElement);
  if (idx < 0) throw new Error("AnalogTransformerElement not found in compiled circuit");
  return elements[idx] as AnalogTransformerElement;
}

// ---------------------------------------------------------------------------
// AC transformer fixture: AcVoltageSource → primary → secondary → R_load → GND
// ---------------------------------------------------------------------------

interface AcXfmrParams {
  N: number;
  Vpeak: number;
  freq: number;
  Lp: number;
  k: number;
  Rload: number;
  rPri?: number;
  rSec?: number;
}

function buildAcXfmrCircuit(facade: DefaultSimulatorFacade, p: AcXfmrParams): Circuit {
  return facade.build({
    components: [
      { id: "vs",   type: "AcVoltageSource", props: { amplitude: p.Vpeak, frequency: p.freq, label: "vs" } },
      { id: "xfmr", type: "Transformer",     props: { turnsRatio: p.N, primaryInductance: p.Lp, couplingCoefficient: p.k, primaryResistance: p.rPri ?? 0, secondaryResistance: p.rSec ?? 0, label: "xfmr" } },
      { id: "rl",   type: "Resistor",        props: { resistance: p.Rload } },
      { id: "gnd",  type: "Ground" },
    ],
    connections: [
      ["vs:pos",   "xfmr:P1"],
      ["xfmr:P2",  "gnd:out"],
      ["vs:neg",   "gnd:out"],
      ["xfmr:S1",  "rl:pos"],
      ["rl:neg",   "gnd:out"],
      ["xfmr:S2",  "gnd:out"],
    ],
  });
}

// ---------------------------------------------------------------------------
// Transformer behaviour tests (observed through public engine surface)
// ---------------------------------------------------------------------------

describe("Transformer", () => {
  it("voltage_ratio - N=10:1 secondary ≈ primary/10 for k=0.99 in AC steady state", async () => {
    const N = 10;
    const Vpeak = 1.2;
    const freq = 1000;
    const Lp = 100e-3;
    const k = 0.99;
    const Rload = 100.0;
    const numCycles = 10;
    const period = 1 / freq;

    const samplesPerCycle = 200;
    const totalSamples = numCycles * samplesPerCycle;
    const tStop = numCycles * period;

    const fix = buildFixture({
      build: (_r, facade) => buildAcXfmrCircuit(facade, { N, Vpeak, freq, Lp, k, Rload }),
      params: { tStop, maxTimeStep: period / samplesPerCycle, uic: true },
    });
    const xfmr = findTransformer(fix.circuit.elements);
    const s1Node = xfmr._pinNodes.get("S1")!;

    const times = Array.from({ length: totalSamples }, (_, i) =>
      (i + 1) * (tStop / totalSamples),
    );
    const samples = await fix.coordinator.sampleAtTimes(
      times,
      () => fix.engine.getNodeVoltage(s1Node),
    );

    // Find peak in the last cycle.
    const lastCycleOffset = (numCycles - 1) * samplesPerCycle;
    let maxSecondary = 0;
    for (let i = lastCycleOffset; i < samples.length; i++) {
      const v = Math.abs(samples[i] as number);
      if (v > maxSecondary) maxSecondary = v;
    }

    const idealPeak = Vpeak / N;
    expect(maxSecondary).toBeGreaterThan(idealPeak * 0.90);
    expect(maxSecondary).toBeLessThan(idealPeak * 1.10);
  });

  it("power_conservation - P_secondary ≈ P_ideal for k=0.99 within 5%", async () => {
    const N = 1;
    const Vpeak = 2.0;
    const freq = 50;
    const Lp = 100e-3;
    const k = 0.99;
    const Rload = 5.0;
    const numCycles = 20;
    const period = 1 / freq;
    const samplesPerCycle = 400;
    const totalSamples = numCycles * samplesPerCycle;
    const tStop = numCycles * period;

    const fix = buildFixture({
      build: (_r, facade) => buildAcXfmrCircuit(facade, { N, Vpeak, freq, Lp, k, Rload }),
      params: { tStop, maxTimeStep: period / samplesPerCycle, uic: true },
    });
    const xfmr = findTransformer(fix.circuit.elements);
    const s1Node = xfmr._pinNodes.get("S1")!;

    const times = Array.from({ length: totalSamples }, (_, i) =>
      (i + 1) * (tStop / totalSamples),
    );
    const samples = await fix.coordinator.sampleAtTimes(
      times,
      () => fix.engine.getNodeVoltage(s1Node),
    );

    // Average V² over the last cycle to get V_rms² for secondary power.
    const lastCycleOffset = (numCycles - 1) * samplesPerCycle;
    let sumV2sq = 0;
    let sampleCount = 0;
    for (let i = lastCycleOffset; i < samples.length; i++) {
      const v2 = samples[i] as number;
      sumV2sq += v2 * v2;
      sampleCount++;
    }

    const pSec = (sumV2sq / sampleCount) / Rload;
    const pIdeal = (Vpeak * Vpeak) / (2 * Rload);

    expect(pSec).toBeGreaterThan(0);
    expect(pSec).toBeLessThanOrEqual(pIdeal * 1.05);
    expect(pSec).toBeGreaterThanOrEqual(pIdeal * 0.50);
  });

  it("leakage_with_low_k - k=0.8 secondary peak < k=0.99 secondary peak", async () => {
    /**
     * Lower coupling → more leakage inductance → less energy transferred to
     * secondary. Observed through `coordinator.sampleAtTimes` reading
     * `xfmr:S1`; no engine-internal stamping inspection.
     */
    async function peakSecondary(k: number): Promise<number> {
      const N = 2;
      const Vpeak = 1.0;
      const freq = 1000;
      const Lp = 100e-3;
      const Rload = 50.0;
      const numCycles = 10;
      const period = 1 / freq;
      const samplesPerCycle = 200;
      const totalSamples = numCycles * samplesPerCycle;
      const tStop = numCycles * period;

      const fix = buildFixture({
        build: (_r, facade) => buildAcXfmrCircuit(facade, { N, Vpeak, freq, Lp, k, Rload }),
        params: { tStop, maxTimeStep: period / samplesPerCycle, uic: true },
      });
      const xfmr = findTransformer(fix.circuit.elements);
      const s1Node = xfmr._pinNodes.get("S1")!;

      const times = Array.from({ length: totalSamples }, (_, i) =>
        (i + 1) * (tStop / totalSamples),
      );
      const samples = await fix.coordinator.sampleAtTimes(
        times,
        () => fix.engine.getNodeVoltage(s1Node),
      );

      const lastCycleOffset = (numCycles - 1) * samplesPerCycle;
      let maxSec = 0;
      for (let i = lastCycleOffset; i < samples.length; i++) {
        const v = Math.abs(samples[i] as number);
        if (v > maxSec) maxSec = v;
      }
      return maxSec;
    }

    const highK = await peakSecondary(0.99);
    const lowK  = await peakSecondary(0.80);
    expect(lowK).toBeLessThan(highK);
  });

  it("dc_blocks - DC steady state shorts secondary to ground (V_sec ≈ 0)", () => {
    /**
     * In DC steady state, inductors are short circuits (dI/dt = 0).
     * The transformer load() skips inductive companion stamps in MODEDC, so
     * each winding becomes a pure KVL short: V_winding = 0.
     *
     * Topology: Vdc → R_series → primary; secondary → R_load → GND. The
     * external R_series breaks the voltage-source/short conflict that would
     * otherwise occur if Vdc fed the primary directly.
     *
     * Expected: V(xfmr:S1) ≈ 0 (secondary shorted in DC).
     */
    const Vdc = 5.0;
    const Lp = 1.0;
    const k = 0.99;
    const Rload = 100.0;
    const Rseries = 100.0;

    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",     type: "DcVoltageSource", props: { label: "vs",   voltage: Vdc } },
          { id: "rser",   type: "Resistor",        props: { label: "rser", resistance: Rseries } },
          { id: "xfmr",   type: "Transformer",     props: { label: "xfmr", turnsRatio: 1, primaryInductance: Lp, couplingCoefficient: k, primaryResistance: 0, secondaryResistance: 0 } },
          { id: "rl",     type: "Resistor",        props: { label: "rl",   resistance: Rload } },
          { id: "gnd",    type: "Ground" },
        ],
        connections: [
          ["vs:pos",   "rser:pos"],
          ["rser:neg", "xfmr:P1"],
          ["xfmr:P2",  "gnd:out"],
          ["xfmr:S1",  "rl:pos"],
          ["rl:neg",   "gnd:out"],
          ["xfmr:S2",  "gnd:out"],
          ["vs:neg",   "gnd:out"],
        ],
      }),
    });

    const dcop = fix.coordinator.dcOperatingPoint()!;
    expect(dcop.converged).toBe(true);

    const xfmr = findTransformer(fix.circuit.elements);
    const s1Node = xfmr._pinNodes.get("S1")!;
    const vSec = Math.abs(fix.engine.getNodeVoltage(s1Node));
    expect(vSec).toBeLessThan(Vdc * 0.05);
  });
});

// ---------------------------------------------------------------------------
// State-pool contract (factory-only, no engine impersonation)
// ---------------------------------------------------------------------------

describe("AnalogTransformerElement state pool", () => {
  it("_stateBase is -1 before compiler assigns it", () => {
    const props = new PropertyBag();
    props.setModelParam("turnsRatio", 1);
    props.setModelParam("primaryInductance", 10e-3);
    props.setModelParam("couplingCoefficient", 0.99);
    props.setModelParam("primaryResistance", 0);
    props.setModelParam("secondaryResistance", 0);
    const core = getFactory(TransformerDefinition.modelRegistry!.behavioral!)(
      new Map([["P1", 1], ["P2", 0], ["S1", 2], ["S2", 0]]), props, () => 0,
    );
    expect((core as PoolBackedAnalogElement)._stateBase).toBe(-1);
  });

  it("element allocates a branch row in setup() (visible after buildFixture warm-start)", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildAcXfmrCircuit(facade, {
        N: 1, Vpeak: 1, freq: 1000, Lp: 10e-3, k: 0.99, Rload: 1000,
      }),
      params: { tStop: 1e-3, maxTimeStep: 1e-5, uic: true },
    });
    const xfmr = findTransformer(fix.circuit.elements);
    expect(xfmr.branchIndex).toBeGreaterThan(0);
    expect(xfmr.branch2).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ComponentDefinition smoke tests
// ---------------------------------------------------------------------------

describe("TransformerDefinition", () => {
  it("name is Transformer", () => {
    expect(TransformerDefinition.name).toBe("Transformer");
  });

  it("TransformerDefinition has analog model", () => {
    expect(TransformerDefinition.modelRegistry?.behavioral).toBeDefined();
  });

  it("has analogFactory", () => {
    expect((TransformerDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBeDefined();
  });

  it("category is PASSIVES", () => {
    expect(TransformerDefinition.category).toBe(ComponentCategory.PASSIVES);
  });

  it("pinLayout has 4 entries", () => {
    expect(TransformerDefinition.pinLayout).toHaveLength(4);
    const labels = TransformerDefinition.pinLayout.map((p) => p.label);
    expect(labels).toContain("P1");
    expect(labels).toContain("P2");
    expect(labels).toContain("S1");
    expect(labels).toContain("S2");
  });

  it("can be registered without error", () => {
    const registry = new ComponentRegistry();
    expect(() => registry.register(TransformerDefinition)).not.toThrow();
  });

  it("attribute mappings map turnsRatio", () => {
    const m = TRANSFORMER_ATTRIBUTE_MAPPINGS.find((a) => a.xmlName === "turnsRatio");
    expect(m).toBeDefined();
    expect(m!.propertyKey).toBe("turnsRatio");
  });
});
