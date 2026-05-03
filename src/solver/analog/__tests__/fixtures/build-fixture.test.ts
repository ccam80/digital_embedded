/**
 * `buildFixture` contract tests.
 *
 * Pins down what §4c migrations rely on: the fixture returns a fully
 * warm-started simulation whose public surface (node voltages, pool slots,
 * matrix stamps, element identities) carries correct, consistent values.
 *
 * Test circuit: VS=5V → R=1kΩ → C=1μF → GND. In DC steady state the
 * capacitor holds 5V, no current flows. Every assertion below either reads
 * a value that ngspice would compute the same way, or checks a structural
 * invariant of the fixture itself.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildFixture } from "./build-fixture.js";
import { AnalogCapacitorElement } from "../../../../components/passives/capacitor.js";

import type { Circuit } from "../../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../../headless/default-facade.js";

const CAP_SLOT_V = 2;

function buildVrcCircuit(facade: DefaultSimulatorFacade): Circuit {
  return facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { label: "V1", voltage: 5.0 } },
      { id: "r1",  type: "Resistor",        props: { label: "R1", resistance: 1000 } },
      { id: "c1",  type: "Capacitor",       props: { label: "C1", capacitance: 1e-6 } },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["vs:pos", "r1:pos"],
      ["r1:neg", "c1:pos"],
      ["c1:neg", "gnd:out"],
      ["vs:neg", "gnd:out"],
    ],
  });
}

describe("buildFixture", () => {
  it("warm-started simulation reaches DC steady state (cap holds source voltage)", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildVrcCircuit(facade),
    });

    const capIdx = fix.circuit.elements.findIndex(
      (el) => el instanceof AnalogCapacitorElement,
    );
    expect(capIdx).toBeGreaterThanOrEqual(0);
    const cap = fix.circuit.elements[capIdx]! as AnalogCapacitorElement;

    // Node voltage at the cap's pos pin equals the source voltage in DC steady
    // state (no current through R since cap is open at DC). Ngspice computes
    // the same value via DC operating-point analysis.
    const posNode = cap._pinNodes.get("pos")!;
    const vCapPos = fix.engine.getNodeVoltage(posNode);
    expect(vCapPos).toBeCloseTo(5.0, 6);

    // Pool slot inspection: the capacitor's V slot in state0 carries the
    // same DCOP voltage (bottom-of-load CKTstate0 idiom).
    expect(fix.pool.state0[cap._stateBase + CAP_SLOT_V]!).toBeCloseTo(5.0, 6);

    // state1 carries the seeded post-DCOP snapshot. _seedFromDcop runs as
    // part of the warm-start, so state1[V] mirrors the converged state0[V].
    expect(fix.pool.state1[cap._stateBase + CAP_SLOT_V]!).toBeCloseTo(5.0, 6);
  });

  it("matrix stamps are populated after warm-start (resistor conductance present)", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildVrcCircuit(facade),
    });

    // After the warm-start step the solver has been factored at least once,
    // and the resistor's 4 conductance entries (2 diagonals + 2 off-diagonals)
    // have been stamped into the matrix.
    expect(fix.engine.solver).not.toBeNull();
    const nzs = fix.engine.solver!.getCSCNonZeros();
    expect(nzs.length).toBeGreaterThan(0);
    // Resistor conductance G = 1e-3 stamps a +G diagonal entry on each
    // non-ground node. Look for at least one entry whose value is exactly +G.
    const G = 1e-3;
    const hasResistorDiag = nzs.some(({ value }) => Math.abs(value - G) < 1e-15);
    expect(hasResistorDiag).toBe(true);
  });

  it("elementLabels resolves user-authored labels for every CircuitElement", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildVrcCircuit(facade),
    });

    const labels = new Set(fix.elementLabels.values());
    expect(labels.has("V1")).toBe(true);
    expect(labels.has("R1")).toBe(true);
    expect(labels.has("C1")).toBe(true);
  });

  it("custom SimulationParams (e.g. tStop) flow through to the engine without error", () => {
    // Pass a tStop near zero so the engine clamps the warm-start step. The
    // observable: simTime is bounded above by tStop. (Can't read engine.params
    // directly  it's private  so we verify the override took effect via its
    // downstream behavioural consequence.)
    const tStop = 1e-9;
    const fix = buildFixture({
      build: (_r, facade) => buildVrcCircuit(facade),
      params: { tStop },
    });
    expect(fix.engine.simTime).toBeGreaterThan(0);
    expect(fix.engine.simTime).toBeLessThanOrEqual(tStop);
  });

  it("returns the same pool the engine and compiled circuit hold (single-ownership)", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildVrcCircuit(facade),
    });
    expect(fix.engine.compiled).toBe(fix.circuit);
    expect(fix.circuit.statePool).toBe(fix.pool);
  });

  it("loads from a .dts file on disk and reaches the same DC steady state", () => {
    // Round-trip via facade.serialize() to produce a known-good .dts blob;
    // avoids hand-coding the dts-schema and verifies dtsPath against the
    // canonical writer.
    const seedFix = buildFixture({ build: (_r, facade) => buildVrcCircuit(facade) });
    const seedCircuit = seedFix.facade.getCircuit();
    expect(seedCircuit).not.toBeNull();
    const dts = seedFix.facade.serialize(seedCircuit!);

    const tmpFile = path.join(os.tmpdir(), `digits-build-fixture-${process.pid}.dts`);
    fs.writeFileSync(tmpFile, dts, "utf8");
    try {
      const fix = buildFixture({ dtsPath: tmpFile });
      const capIdx = fix.circuit.elements.findIndex(
        (el) => el instanceof AnalogCapacitorElement,
      );
      expect(capIdx).toBeGreaterThanOrEqual(0);
      const cap = fix.circuit.elements[capIdx]! as AnalogCapacitorElement;
      const posNode = cap._pinNodes.get("pos")!;
      expect(fix.engine.getNodeVoltage(posNode)).toBeCloseTo(5.0, 6);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* best effort */ }
    }
  });

  it("rejects calls with neither build nor dtsPath", () => {
    expect(() => buildFixture({})).toThrow(/exactly one of/);
  });

  it("rejects calls with both build and dtsPath", () => {
    expect(() => buildFixture({
      build: () => null as never,
      dtsPath: "/nonexistent/path.dts",
    })).toThrow(/exactly one of/);
  });
});
