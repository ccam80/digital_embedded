/**
 * `buildDigital` — the shared constructor for pure-digital test fixtures.
 *
 * Returns a compiled circuit driven through the public facade surface: a real
 * `DefaultSimulatorFacade` + `facade.compile()` `SimulationCoordinator`, never a
 * hand-rolled engine mock. Mirrors the analog `build-fixture.ts` contract for the
 * digital domain so tests stop duplicating (and drifting from) the compile path.
 *
 * Usage:
 *   const fix = buildDigital({
 *     components: [{ id: "a", type: "In", props: { label: "A" } }, ...],
 *     connections: [["a:out", "g:in0"], ...],
 *   });
 *   drive(fix, { A: 1, B: 0 });
 *   expect(read(fix, "Y")).toBe(1);
 *
 * The returned `circuit` is the compiled Circuit (e.g. for CircuitBuilder.runTests).
 */

import { DefaultSimulatorFacade } from "../headless/default-facade.js";
import { createDefaultRegistry } from "../components/register-all.js";

import type { Circuit } from "../core/circuit.js";
import type { SimulationCoordinator } from "../solver/coordinator-types.js";

export interface DigitalFixture {
  readonly facade: DefaultSimulatorFacade;
  readonly coordinator: SimulationCoordinator;
  readonly circuit: Circuit;
}

export interface DigitalSpec {
  components: ReadonlyArray<{
    id: string;
    type: string;
    props?: Record<string, number | string | boolean>;
  }>;
  connections: ReadonlyArray<readonly [string, string]>;
}

export function buildDigital(spec: DigitalSpec): DigitalFixture {
  const facade = new DefaultSimulatorFacade(createDefaultRegistry());
  const circuit = facade.build({
    components: spec.components.map((c) => ({
      id: c.id,
      type: c.type,
      ...(c.props ? { props: c.props } : {}),
    })),
    connections: spec.connections.map((c) => [c[0], c[1]] as [string, string]),
  });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator, circuit };
}

/** Set labelled input signals and advance one step. */
export function drive(fix: DigitalFixture, values: Record<string, number>): void {
  for (const [label, value] of Object.entries(values)) {
    fix.facade.setSignal(fix.coordinator, label, value);
  }
  fix.facade.step(fix.coordinator);
}

/** Read a labelled output signal. */
export function read(fix: DigitalFixture, label: string): number {
  return fix.facade.readSignal(fix.coordinator, label) as number;
}
