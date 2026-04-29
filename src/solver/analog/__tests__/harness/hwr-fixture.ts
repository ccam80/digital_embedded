/**
 * Shared HWR (half-wave rectifier) fixture for harness integration tests.
 *
 * Builds and compiles a real VS→R→D circuit through DefaultSimulatorFacade
 * so the MNA solver allocates a proper branch row for the voltage source.
 *
 * Circuit topology:
 *   Vs(5V, pos→node1, neg→node0) — R1(1kΩ, A→node1, B→node2) — D1(A→node2, K→node0)
 *   matrixSize = 3  (2 voltage nodes + 1 branch row for Vs)
 */

import { createDefaultRegistry } from "../../../../components/register-all.js";
import { DefaultSimulatorFacade } from "../../../../headless/default-facade.js";
import { MNAEngine } from "../../analog-engine.js";
import type { ConcreteCompiledAnalogCircuit } from "../../compiled-analog-circuit.js";
import type { StatePool } from "../../state-pool.js";

export interface HwrFixture {
  circuit: ConcreteCompiledAnalogCircuit;
  pool: StatePool;
  engine: MNAEngine;
}

export function buildHwrFixture(): HwrFixture {
  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);

  const circuit = facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { voltage: 5.0 } },
      { id: "r1",  type: "Resistor",        props: { resistance: 1000 } },
      { id: "d1",  type: "Diode",           props: {} },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["vs:pos",  "r1:A"],
      ["r1:B",    "d1:A"],
      ["d1:K",    "gnd:out"],
      ["vs:neg",  "gnd:out"],
    ],
  });

  facade.compile(circuit);

  const coordinator = facade.getActiveCoordinator();
  if (coordinator === null) {
    throw new Error("buildHwrFixture: compile() did not produce an active coordinator");
  }

  const analogEngine = coordinator.getAnalogEngine();
  if (analogEngine === null) {
    throw new Error("buildHwrFixture: no analog engine — circuit has no analog domain");
  }

  const mnaEngine = analogEngine as MNAEngine;
  const compiled = mnaEngine.compiled;
  if (compiled === null) {
    throw new Error("buildHwrFixture: MNAEngine.compiled is null after init");
  }

  const pool = compiled.statePool;

  return { circuit: compiled, pool, engine: mnaEngine };
}
