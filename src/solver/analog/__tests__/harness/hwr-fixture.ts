/**
 * HWR (half-wave rectifier) circuit fixture: VS=5V → R=1kΩ → D → GND.
 *
 * Thin wrapper around `buildFixture`. Use `buildHwrFixture()` when a test
 * just needs the canonical HWR topology; use `buildFixture({ build, ... })`
 * directly for any other circuit.
 */

import { buildFixture, type Fixture } from "../fixtures/build-fixture.js";

import type { Circuit } from "../../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../../headless/default-facade.js";

/**
 * VS(5V, pos→node1, neg→GND) ─ R(1kΩ, pos→node1, neg→node2) ─ D(A→node2, K→GND)
 *
 * matrixSize = 3  (2 voltage nodes + 1 branch row for VS)
 */
export function buildHwrCircuit(facade: DefaultSimulatorFacade): Circuit {
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

export function buildHwrFixture(): Fixture {
  return buildFixture({ build: (_registry, facade) => buildHwrCircuit(facade) });
}
