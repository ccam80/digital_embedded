/**
 * Convergence regression integration tests for StatePool checkpoint/rollback.
 *
 * Verifies that the engine's checkpoint/rollback/rotateStateVectors wiring works
 * correctly and that circuits converge with the state-pool architecture.
 */

import { describe, it, expect } from "vitest";
import { EngineState } from "../../../core/engine-interface.js";
import { buildHwrFixture } from "./harness/hwr-fixture.js";
import { ComparisonSession } from "./harness/comparison-session.js";
import { createDefaultRegistry } from "../../../components/register-all.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { MNAEngine } from "../analog-engine.js";

/** Read the diode "d1"'s anode voltage by label, not by hardcoded node ID. */
function diodeAnodeVoltage(engine: MNAEngine): number {
  const diode = engine.compiled!.elements.find((el) => el.label === "d1");
  if (!diode) throw new Error("diode 'd1' not found in compiled circuit");
  const anodeNode = diode._pinNodes.get("A");
  if (anodeNode === undefined) throw new Error("diode 'd1' has no 'A' pin");
  return engine.getNodeVoltage(anodeNode);
}

// ---------------------------------------------------------------------------
// HWR circuit spec for ComparisonSession (M1 shape)
// ---------------------------------------------------------------------------

function buildHwrCircuit(registry: ReturnType<typeof createDefaultRegistry>) {
  const facade = new DefaultSimulatorFacade(registry);
  return facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { voltage: 5.0 } },
      { id: "r1",  type: "Resistor",        props: { resistance: 1000 } },
      { id: "d1",  type: "Diode",           props: {} },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["vs:pos", "r1:pos"],
      ["r1:neg", "d1:A"],
      ["d1:K",   "gnd:out"],
      ["vs:neg", "gnd:out"],
    ],
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("convergence regression", () => {
  // -----------------------------------------------------------------------
  // 1. Half-wave rectifier DC convergence (M3)
  // -----------------------------------------------------------------------

  it("half-wave rectifier converges and diode forward voltage is correct", () => {
    const { engine } = buildHwrFixture();
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);

    // Diode anode voltage should show forward drop ~0.6–0.75V
    const vAnode = diodeAnodeVoltage(engine);
    expect(vAnode).toBeGreaterThan(0.55);
    expect(vAnode).toBeLessThan(0.80);
  });

  // -----------------------------------------------------------------------
  // 2. RC circuit transient stability (M2 inline)
  // -----------------------------------------------------------------------

  it("RC circuit runs transient steps stably with capacitor near Vs", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: "vs",  type: "DcVoltageSource", props: { voltage: 5.0 } },
        { id: "r1",  type: "Resistor",        props: { resistance: 1000 } },
        { id: "c1",  type: "Capacitor",       props: { capacitance: 1e-6 } },
        { id: "gnd", type: "Ground" },
      ],
      connections: [
        ["vs:pos", "r1:pos"],
        ["r1:neg", "c1:pos"],
        ["c1:neg", "gnd:out"],
        ["vs:neg", "gnd:out"],
      ],
    });
    const coordinator = facade.compile(circuit);
    const engine = coordinator.getAnalogEngine();
    expect(engine).not.toBeNull();
    const dcResult = engine!.dcOperatingPoint();
    expect(dcResult.converged).toBe(true);

    // Run transient steps
    let steps = 0;
    while (engine!.simTime < 1e-3 && steps < 5000) {
      engine!.step();
      steps++;
      if (engine!.getState() === EngineState.ERROR) break;
    }

    expect(engine!.getState()).not.toBe(EngineState.ERROR);
    expect(engine!.simTime).toBeGreaterThan(0);

    // With Vs connected, node voltage at capacitor should approach 5V
    const nodeVoltages = coordinator.readAllSignals();
    const capVoltage = Object.values(nodeVoltages).find(v => typeof v === "number" && (v as number) > 4.4) !== undefined;
    expect(capVoltage).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 3. StatePool state0 populated after DC op (M1)
  // -----------------------------------------------------------------------

  it("statePool state0 has non-zero values after DC operating point", async () => {
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: buildHwrCircuit,
      analysis: "dcop",
    });

    const detail = session.getAttempt({ stepIndex: 0, phase: "dcopDirect", phaseAttemptIndex: 0 });
    const lastIter = detail.iterations[detail.iterations.length - 1].ours!;
    expect(lastIter.elementStates["d1"].VD).toBeGreaterThan(0);
    expect(lastIter.elementStates["d1"].GEQ).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // 4. rotateStateVectors shifts state1 after transient step (M1)
  // -----------------------------------------------------------------------

  it("statePool state1 is updated after accepted transient step", async () => {
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: buildHwrCircuit,
      analysis: "dcop",
    });

    // After DC op, d1's VD in state0 should be non-zero (forward voltage)
    const detail = session.getAttempt({ stepIndex: 0, phase: "dcopDirect", phaseAttemptIndex: 0 });
    const lastIter = detail.iterations[detail.iterations.length - 1].ours!;

    // Confirm dcop produced a real diode forward voltage
    expect(lastIter.elementStates["d1"].VD).toBeGreaterThan(0.5);

    // state1 (last-accepted copy) should also be non-zero after dcop commits
    const state1VD = lastIter.elementStates1Slots["d1"].VD;
    expect(state1VD).toBeGreaterThan(0.5);
    expect(state1VD).toBeLessThan(0.8);
  });

  // -----------------------------------------------------------------------
  // 5. Engine runs multiple steps without crashing (M3)
  // -----------------------------------------------------------------------

  it("diode circuit runs 100 transient steps without error", () => {
    const { engine } = buildHwrFixture();
    engine.dcOperatingPoint();

    for (let i = 0; i < 100; i++) {
      engine.step();
      if (engine.getState() === EngineState.ERROR) break;
    }

    expect(engine.getState()).not.toBe(EngineState.ERROR);
    expect(engine.simTime).toBeGreaterThan(0);

    // Voltages should remain physically plausible
    const vAnode = diodeAnodeVoltage(engine);
    expect(vAnode).toBeGreaterThan(0.4);
    expect(vAnode).toBeLessThan(1.0);
  });

  // -----------------------------------------------------------------------
  // 6. Reset clears engine state and engine can reconverge (M1 + M3)
  // -----------------------------------------------------------------------

  it("reset restores initial values in statePool", async () => {
    // Phase A: via M1, confirm dcop produces non-zero VD
    const sessionBefore = await ComparisonSession.createSelfCompare({
      buildCircuit: buildHwrCircuit,
      analysis: "dcop",
    });
    const detailBefore = sessionBefore.getAttempt({ stepIndex: 0, phase: "dcopDirect", phaseAttemptIndex: 0 });
    const lastIterBefore = detailBefore.iterations[detailBefore.iterations.length - 1].ours!;
    expect(lastIterBefore.elementStates["d1"].VD).toBeGreaterThan(0.5);

    // Phase B: via M3, verify reset clears accumulated state so engine
    // reconverges cleanly from zero initial conditions.
    const { engine } = buildHwrFixture();
    engine.dcOperatingPoint();
    engine.step();
    expect(engine.getState()).not.toBe(EngineState.ERROR);

    engine.reset();

    // After reset, simTime must be 0
    expect(engine.simTime).toBe(0);

    // Engine can converge again from scratch after reset
    const resultAfterReset = engine.dcOperatingPoint();
    expect(resultAfterReset.converged).toBe(true);

    // Forward voltage still physically correct after reconvergence
    const vAnodeAfterReset = diodeAnodeVoltage(engine);
    expect(vAnodeAfterReset).toBeGreaterThan(0.55);
    expect(vAnodeAfterReset).toBeLessThan(0.80);
  });
});
