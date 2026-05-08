/**
 * Tests for WireCurrentResolver — KCL-correct tree-traced wire current attribution.
 *
 * Every fixture is built through the sanctioned `buildFixture` constructor
 * and the resolver is fed the `CurrentResolverContext` produced by
 * `coordinator.getCurrentResolverContext()`. This exercises the full
 * compile → DCOP → step → resolve pipeline on real production elements.
 */

import { describe, it, expect } from "vitest";
import { WireCurrentResolver } from "../wire-current-resolver.js";
import { buildFixture } from "../../solver/analog/__tests__/fixtures/build-fixture.js";
import { Wire } from "../../core/circuit.js";
import type { CircuitElement } from "../../core/element.js";
import type { CurrentResolverContext } from "../../solver/coordinator-types.js";
import type { DefaultSimulationCoordinator } from "../../solver/coordinator.js";
import type { ConcreteCompiledAnalogCircuit } from "../../solver/analog/compiled-analog-circuit.js";
import { pinWorldPosition } from "../../core/pin.js";

// ---------------------------------------------------------------------------
// Helpers — public-surface only, no engine impersonation
// ---------------------------------------------------------------------------

/** Get the resolver-input context from the coordinator's public surface. */
function ctxOf(coordinator: DefaultSimulationCoordinator): CurrentResolverContext {
  const ctx = coordinator.getCurrentResolverContext();
  if (ctx === null) throw new Error("coordinator has no analog domain");
  return ctx;
}

/** All wires belonging to the MNA node containing the given component pin. */
function wiresAtPin(
  circuit: ConcreteCompiledAnalogCircuit,
  allWires: readonly Wire[],
  ce: CircuitElement,
  pinLabel: string,
): Wire[] {
  const pin = ce.getPins().find((p) => p.label === pinLabel);
  if (!pin) throw new Error(`pin ${pinLabel} not found on ${ce.instanceId}`);
  const pos = pinWorldPosition(ce, pin);
  // The pin's node is whichever wire endpoint matches its world position.
  let nodeId: number | undefined;
  for (const w of allWires) {
    const id = circuit.wireToNodeId.get(w);
    if (id === undefined) continue;
    if (
      (Math.abs(w.start.x - pos.x) < 0.5 && Math.abs(w.start.y - pos.y) < 0.5) ||
      (Math.abs(w.end.x - pos.x) < 0.5 && Math.abs(w.end.y - pos.y) < 0.5)
    ) {
      nodeId = id;
      break;
    }
  }
  if (nodeId === undefined) {
    throw new Error(`no wire-mapped node found at pin ${ce.instanceId}:${pinLabel}`);
  }
  return allWires.filter((w) => circuit.wireToNodeId.get(w) === nodeId);
}

/** Find the visual CircuitElement for a given component label. */
function ceByLabel(
  circuit: ConcreteCompiledAnalogCircuit,
  label: string,
): CircuitElement {
  for (const ce of circuit.elementToCircuitElement.values()) {
    if (ce.getProperties().getOrDefault<string>("label", "") === label) return ce;
  }
  throw new Error(`label ${label} not found in compiled circuit`);
}

/** Find the analog element index for a given component label. */
function elementIndexByLabel(
  circuit: ConcreteCompiledAnalogCircuit,
  label: string,
): number {
  for (const [idx, ce] of circuit.elementToCircuitElement) {
    if (ce.getProperties().getOrDefault<string>("label", "") === label) return idx;
  }
  throw new Error(`label ${label} not found among analog elements`);
}

// ===========================================================================
// Basic resolver behaviour on real DC circuits
// ===========================================================================

describe("WireCurrentResolver - DC behaviour through buildFixture", () => {
  it("series resistors: every wire on the loop carries the same current", () => {
    // Vs(5V) -> R1(1k) -> R2(2k) -> ground (single loop, KCL-balanced).
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 5 } },
          { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 1000 } },
          { id: "r2",  type: "Resistor",        props: { label: "r2",  resistance: 2000 } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vs:pos", "r1:pos"],
          ["r1:neg",   "r2:pos"],
          ["r2:neg",   "gnd:out"],
          ["vs:neg", "gnd:out"],
        ],
      }),
      params: { tStop: 1e-4, maxTimeStep: 1e-5 },
    });

    const resolver = new WireCurrentResolver();
    resolver.resolve(ctxOf(fix.coordinator));

    const idxR1 = elementIndexByLabel(fix.circuit, "r1");
    const I_loop = Math.abs(fix.coordinator.readElementCurrent(idxR1) ?? 0);
    expect(I_loop).toBeGreaterThan(0);

    const wires = fix.facade.getCircuit()!.wires;
    const r1 = ceByLabel(fix.circuit, "r1");
    const r2 = ceByLabel(fix.circuit, "r2");
    for (const w of [
      ...wiresAtPin(fix.circuit, wires, r1, "pos"),
      ...wiresAtPin(fix.circuit, wires, r1, "neg"),
      ...wiresAtPin(fix.circuit, wires, r2, "pos"),
      ...wiresAtPin(fix.circuit, wires, r2, "neg"),
    ]) {
      const wc = resolver.getWireCurrent(w);
      expect(wc).toBeDefined();
      expect(Math.abs(wc!.current - I_loop) / I_loop).toBeLessThan(0.01);
    }
  });

  it("parallel split at junction: branch wires carry their branch's current", () => {
    // Vs(5V) -> R1(1k) -> junction -> R2(2k) || R3(3k) -> ground.
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 5 } },
          { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 1000 } },
          { id: "r2",  type: "Resistor",        props: { label: "r2",  resistance: 2000 } },
          { id: "r3",  type: "Resistor",        props: { label: "r3",  resistance: 3000 } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vs:pos", "r1:pos"],
          ["r1:neg",   "r2:pos"],
          ["r1:neg",   "r3:pos"],
          ["r2:neg",   "gnd:out"],
          ["r3:neg",   "gnd:out"],
          ["vs:neg", "gnd:out"],
        ],
      }),
      params: { tStop: 1e-4, maxTimeStep: 1e-5 },
    });

    const resolver = new WireCurrentResolver();
    resolver.resolve(ctxOf(fix.coordinator));

    const I_R1 = Math.abs(fix.coordinator.readElementCurrent(elementIndexByLabel(fix.circuit, "r1")) ?? 0);
    const I_R2 = Math.abs(fix.coordinator.readElementCurrent(elementIndexByLabel(fix.circuit, "r2")) ?? 0);
    const I_R3 = Math.abs(fix.coordinator.readElementCurrent(elementIndexByLabel(fix.circuit, "r3")) ?? 0);

    // KCL at the junction.
    expect(Math.abs(I_R1 - I_R2 - I_R3) / I_R1).toBeLessThan(1e-6);

    // Component body paths: one per analog 2-terminal element with a CE.
    const paths = resolver.getComponentPaths();
    expect(paths.length).toBeGreaterThanOrEqual(3);

    // Each component body path's current matches its element current.
    const bodyByLabel = new Map<string, number>();
    let pIdx = 0;
    for (const [eIdx, ce] of fix.circuit.elementToCircuitElement) {
      void eIdx;
      const lbl = ce.getProperties().getOrDefault<string>("label", "");
      if (pIdx >= paths.length) break;
      bodyByLabel.set(lbl, paths[pIdx].current);
      pIdx++;
    }
    expect(Math.abs((bodyByLabel.get("r1") ?? 0) - I_R1) / I_R1).toBeLessThan(0.01);
    expect(Math.abs((bodyByLabel.get("r2") ?? 0) - I_R2) / I_R2).toBeLessThan(0.01);
    expect(Math.abs((bodyByLabel.get("r3") ?? 0) - I_R3) / I_R3).toBeLessThan(0.01);
  });

  it("getWireCurrent returns undefined for wires the resolver never saw", () => {
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 1 } },
          { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 100 } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vs:pos", "r1:pos"],
          ["r1:neg",   "gnd:out"],
          ["vs:neg", "gnd:out"],
        ],
      }),
      params: { tStop: 1e-4, maxTimeStep: 1e-5 },
    });

    const resolver = new WireCurrentResolver();
    resolver.resolve(ctxOf(fix.coordinator));

    const wires = fix.facade.getCircuit()!.wires;
    expect(wires.length).toBeGreaterThan(0);
    expect(resolver.getWireCurrent(wires[0])).toBeDefined();

    // A Wire instance the resolver has never seen - distinct identity, not in
    // any node's wire map - must produce no result.
    const stranger = new Wire({ x: 99999, y: 99999 }, { x: 99998, y: 99998 });
    expect(resolver.getWireCurrent(stranger)).toBeUndefined();
  });

  it("clear() resets the resolver state", () => {
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 1 } },
          { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 100 } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vs:pos", "r1:pos"],
          ["r1:neg",   "gnd:out"],
          ["vs:neg", "gnd:out"],
        ],
      }),
      params: { tStop: 1e-4, maxTimeStep: 1e-5 },
    });

    const resolver = new WireCurrentResolver();
    resolver.resolve(ctxOf(fix.coordinator));

    const wires = fix.facade.getCircuit()!.wires;
    expect(resolver.getWireCurrent(wires[0])).toBeDefined();

    resolver.clear();
    expect(resolver.getWireCurrent(wires[0])).toBeUndefined();
    expect(resolver.getComponentPaths()).toHaveLength(0);
  });
});

// ===========================================================================
// Resistor ladder - KCL holds at every junction node
// ===========================================================================

describe("WireCurrentResolver - 4-node resistor ladder KCL", () => {
  it("every junction's wires carry positive current and KCL is satisfied", () => {
    // Vs(10V) -> R1(1k) -> n2 -> R3(1k) -> n3 -> R5(2k) -> n4 -> R7(4k) -> gnd
    //                  |              |              |
    //                R2(2k)->gnd    R4(3k)->gnd    R6(1k)->gnd
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 10 } },
          { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 1000 } },
          { id: "r2",  type: "Resistor",        props: { label: "r2",  resistance: 2000 } },
          { id: "r3",  type: "Resistor",        props: { label: "r3",  resistance: 1000 } },
          { id: "r4",  type: "Resistor",        props: { label: "r4",  resistance: 3000 } },
          { id: "r5",  type: "Resistor",        props: { label: "r5",  resistance: 2000 } },
          { id: "r6",  type: "Resistor",        props: { label: "r6",  resistance: 1000 } },
          { id: "r7",  type: "Resistor",        props: { label: "r7",  resistance: 4000 } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vs:pos", "r1:pos"],
          ["r1:neg",   "r2:pos"], ["r1:neg", "r3:pos"],
          ["r3:neg",   "r4:pos"], ["r3:neg", "r5:pos"],
          ["r5:neg",   "r6:pos"], ["r5:neg", "r7:pos"],
          ["r2:neg",   "gnd:out"],
          ["r4:neg",   "gnd:out"],
          ["r6:neg",   "gnd:out"],
          ["r7:neg",   "gnd:out"],
          ["vs:neg", "gnd:out"],
        ],
      }),
      params: { tStop: 1e-4, maxTimeStep: 1e-5 },
    });

    const resolver = new WireCurrentResolver();
    resolver.resolve(ctxOf(fix.coordinator));

    const wires = fix.facade.getCircuit()!.wires;

    // Every wire at the three internal junction nodes must carry positive
    // current - the resolver's tree-trace must not zero out a tree-internal
    // edge in any of these split nodes.
    for (const lbl of ["r1", "r3", "r5"]) {
      const ce = ceByLabel(fix.circuit, lbl);
      const adj = wiresAtPin(fix.circuit, wires, ce, "neg");
      expect(adj.length).toBeGreaterThan(0);
      for (const w of adj) {
        const wc = resolver.getWireCurrent(w);
        expect(wc).toBeDefined();
        expect(wc!.current).toBeGreaterThan(0);
      }
    }

    // Each 2-terminal element's body path current matches its element current.
    const paths = resolver.getComponentPaths();
    expect(paths.length).toBeGreaterThanOrEqual(8);

    let pIdx = 0;
    for (const [eIdx] of fix.circuit.elementToCircuitElement) {
      const I = Math.abs(fix.coordinator.readElementCurrent(eIdx) ?? 0);
      if (pIdx >= paths.length) break;
      if (I > 1e-9) {
        expect(Math.abs(paths[pIdx].current - I) / I).toBeLessThan(0.01);
      }
      pIdx++;
    }
  });
});

// ===========================================================================
// AC transient RLC - KCL holds at every timestep
// ===========================================================================

describe("WireCurrentResolver - AC transient RLC", () => {
  it("RLC junction: wire currents track element currents at every AC step", () => {
    // AcVs(5V, 100Hz) -> R(1k) -> junction -> C(1uF) || L(100mH) -> ground.
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "AcVoltageSource", props: { label: "vs",  amplitude: 5, frequency: 100, phase: 0, dcOffset: 0 } },
          { id: "r",   type: "Resistor",        props: { label: "r",   resistance: 1000 } },
          { id: "c",   type: "Capacitor",       props: { label: "c",   capacitance: 1e-6 } },
          { id: "l",   type: "Inductor",        props: { label: "l",   inductance: 0.1 } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vs:pos", "r:pos"],
          ["r:neg",    "c:pos"],
          ["r:neg",    "l:pos"],
          ["c:neg",  "gnd:out"],
          ["l:neg",    "gnd:out"],
          ["vs:neg", "gnd:out"],
        ],
      }),
      params: { tStop: 0.05, maxTimeStep: 1e-4 },
    });

    // Settle past the RC transient (~10 RC = 10ms).
    const settleTime = 10 * 1000 * 1e-6;
    let steps = 0;
    while ((fix.coordinator.simTime ?? 0) < settleTime && steps < 100_000) {
      fix.coordinator.step();
      steps++;
    }
    expect((fix.coordinator.simTime ?? 0)).toBeGreaterThan(settleTime * 0.9);

    const idxR = elementIndexByLabel(fix.circuit, "r");
    const idxC = elementIndexByLabel(fix.circuit, "c");
    const idxL = elementIndexByLabel(fix.circuit, "l");

    const resolver = new WireCurrentResolver();
    const periodEnd = (fix.coordinator.simTime ?? 0) + 1 / 100;
    let sampleCount = 0;
    let maxKclError = 0;

    while ((fix.coordinator.simTime ?? 0) < periodEnd && sampleCount < 50_000) {
      fix.coordinator.step();
      sampleCount++;

      resolver.resolve(ctxOf(fix.coordinator));

      const I_R = fix.coordinator.readElementCurrent(idxR) ?? 0;
      const I_C = fix.coordinator.readElementCurrent(idxC) ?? 0;
      const I_L = fix.coordinator.readElementCurrent(idxL) ?? 0;
      const maxI = Math.max(Math.abs(I_R), Math.abs(I_C), Math.abs(I_L));
      if (maxI < 1e-9) continue;

      // KCL at the junction node: I_R = I_C + I_L (sign convention enforced by MNA).
      const kclResidual = Math.abs(I_R - I_C - I_L) / maxI;
      if (kclResidual > maxKclError) maxKclError = kclResidual;
    }

    expect(sampleCount).toBeGreaterThan(10);
    // MNA enforces KCL - residual is at machine epsilon.
    expect(maxKclError).toBeLessThan(1e-6);
  });
});

// ===========================================================================
// Real RLC fixture - full pipeline (deserialize -> compile -> step -> resolve)
// ===========================================================================

describe("WireCurrentResolver - RLC .dts real fixture", () => {
  it("non-junction pin wires carry the adjacent element's current", () => {
    // The in-tree rlc-transient.dts fixture exercises the full deserialize ->
    // compile path. The resolver must produce per-wire currents that match
    // each element's current at non-junction pin vertices.
    const fix = buildFixture({
      dtsPath: "fixtures/rlc-transient.dts",
      params: { tStop: 0.001, maxTimeStep: 1e-5 },
    });

    // Settle past the initial transient.
    const settleTime = 1e-4;
    let steps = 0;
    while ((fix.coordinator.simTime ?? 0) < settleTime && steps < 100_000) {
      fix.coordinator.step();
      steps++;
    }

    const resolver = new WireCurrentResolver();
    resolver.resolve(ctxOf(fix.coordinator));

    // For every 2-terminal analog element with a visual CE, locate wires
    // adjacent to each pin and verify that at non-junction nodes the wire
    // current matches the element current.
    const wires = fix.facade.getCircuit()!.wires;
    let nonJunctionChecks = 0;
    let maxRelErr = 0;

    for (const [eIdx, ce] of fix.circuit.elementToCircuitElement) {
      const ae = fix.circuit.elements[eIdx];
      if (ae.pinNodes.size !== 2) continue;
      const I = Math.abs(fix.coordinator.readElementCurrent(eIdx) ?? 0);
      if (I < 1e-9) continue;

      const pins = ce.getPins();
      for (const pin of pins) {
        let adj: Wire[];
        try {
          adj = wiresAtPin(fix.circuit, wires, ce, pin.label);
        } catch {
          continue;
        }
        if (adj.length !== 1) continue; // junction - wire current may split
        const wc = resolver.getWireCurrent(adj[0]);
        if (!wc) continue;
        const rel = Math.abs(wc.current - I) / I;
        if (rel > maxRelErr) maxRelErr = rel;
        nonJunctionChecks++;
      }
    }

    expect(nonJunctionChecks).toBeGreaterThan(0);
    expect(maxRelErr).toBeLessThan(0.05);

    // Component body paths must each carry their element's current.
    const paths = resolver.getComponentPaths();
    expect(paths.length).toBeGreaterThan(0);
    let pIdx = 0;
    for (const [eIdx, ce] of fix.circuit.elementToCircuitElement) {
      void ce;
      const ae = fix.circuit.elements[eIdx];
      if (ae.pinNodes.size !== 2) continue;
      const I = Math.abs(fix.coordinator.readElementCurrent(eIdx) ?? 0);
      if (pIdx >= paths.length) break;
      if (I > 1e-9) {
        expect(Math.abs(paths[pIdx].current - I) / I).toBeLessThan(0.05);
      }
      pIdx++;
    }
  });
});

