/**
 * `buildFixture` — the only sanctioned constructor for analog/mixed-signal
 * test fixtures.
 *
 * Returns a fully warm-started simulation. Every test that needs to inspect
 * element state, node voltages, currents, matrix stamps, convergence stats,
 * breakpoints, or diagnostics goes through this entry point and reads the
 * results off the public engine surface.
 *
 * No `skipBoot`, no escape hatches. If a test thinks it needs raw
 * post-compile state, that test is reaching past the engine boundary and
 * has to be redesigned to verify the same property at the public surface
 * (matrix introspection, DcOpResult, captureElementStates, etc.).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { createDefaultRegistry } from "../../../../components/register-all.js";
import { DefaultSimulatorFacade } from "../../../../headless/default-facade.js";
import { DefaultSimulationCoordinator } from "../../../../solver/coordinator.js";
import { MNAEngine } from "../../analog-engine.js";

import type { Circuit } from "../../../../core/circuit.js";
import type { ComponentRegistry } from "../../../../core/registry.js";
import type { SimulationParams } from "../../../../core/analog-engine-interface.js";
import type { ConcreteCompiledAnalogCircuit } from "../../compiled-analog-circuit.js";
import type { StatePool } from "../../state-pool.js";

export interface FixtureOptions {
  /**
   * Path to a .dts file. Preferred entry point  exercises the same
   * deserializer the GUI uses and keeps test circuits human-readable.
   * Resolved relative to CWD when not absolute (vitest runs from repo root).
   * Mutually exclusive with `build`.
   */
  dtsPath?: string;

  /**
   * Build a Circuit programmatically. Use only when a .dts fixture would
   * be awkward (e.g. registering a one-off custom definition). Receives the
   * same registry the facade uses. Mutually exclusive with `dtsPath`.
   */
  build?: (registry: ComponentRegistry, facade: DefaultSimulatorFacade) => Circuit;

  /**
   * Override SimulationParams. Applied after compile() and before the
   * warm-start step, so per-test tStop / maxTimeStep / gmin take effect
   * for the boot path and any subsequent coordinator.step() calls.
   */
  params?: Partial<SimulationParams>;
}

export interface Fixture {
  readonly facade: DefaultSimulatorFacade;
  readonly coordinator: DefaultSimulationCoordinator;
  readonly engine: MNAEngine;
  readonly pool: StatePool;
  readonly circuit: ConcreteCompiledAnalogCircuit;
  /** Element index → user-visible label for state-capture lookups and assertion messages. */
  readonly elementLabels: ReadonlyMap<number, string>;
}

export function buildFixture(opts: FixtureOptions): Fixture {
  const hasBuild = typeof opts.build === "function";
  const hasDts = typeof opts.dtsPath === "string" && opts.dtsPath.length > 0;
  if (hasBuild === hasDts) {
    throw new Error(
      "buildFixture: exactly one of { build, dtsPath } must be provided",
    );
  }

  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);

  let circuit: Circuit;
  if (hasDts) {
    const fullPath = path.isAbsolute(opts.dtsPath!)
      ? opts.dtsPath!
      : path.resolve(opts.dtsPath!);
    const json = fs.readFileSync(fullPath, "utf8");
    circuit = facade.deserialize(json);
  } else {
    circuit = opts.build!(registry, facade);
  }

  facade.compile(circuit);

  const coordinator = facade.getActiveCoordinator();
  if (coordinator === null) {
    throw new Error(
      "buildFixture: facade.compile() did not produce an active coordinator. " +
      "Circuit must contain at least one analog or digital element.",
    );
  }

  const analogEngine = coordinator.getAnalogEngine();
  if (analogEngine === null) {
    throw new Error(
      "buildFixture: circuit has no analog domain. " +
      "buildFixture is for analog and mixed-signal tests.",
    );
  }
  if (!(analogEngine instanceof MNAEngine)) {
    throw new Error(
      "buildFixture: analog engine is not an MNAEngine.",
    );
  }
  const engine: MNAEngine = analogEngine;

  if (opts.params !== undefined) {
    engine.configure(opts.params);
  }

  // The first coordinator.step() call drives the canonical warm-start:
  // _setup() (allocates the StatePool, runs initState() on every pool-backed
  // element), then _transientDcop() (DCOP convergence + _seedFromDcop's
  // state1.set(state0)), then the first transient step. After this, every
  // public engine surface is populated and ready to inspect.
  coordinator.step();

  const compiled = engine.compiled;
  if (compiled === null) {
    throw new Error("buildFixture: engine.compiled is null after warm-start.");
  }
  const pool = compiled.statePool;
  if (pool === null) {
    throw new Error("buildFixture: compiled.statePool is null after warm-start.");
  }

  return {
    facade,
    coordinator,
    engine,
    pool,
    circuit: compiled,
    elementLabels: buildElementLabels(compiled),
  };
}

/**
 * Element index → label. Preference order: CircuitElement label property,
 * then CircuitElement instanceId, then AnalogElement.label, then a
 * positional name `element_${i}` for elements with no upstream identity.
 */
function buildElementLabels(
  compiled: ConcreteCompiledAnalogCircuit,
): ReadonlyMap<number, string> {
  const labels = new Map<number, string>();
  for (let i = 0; i < compiled.elements.length; i++) {
    const el = compiled.elements[i]!;
    const ce = compiled.elementToCircuitElement.get(i);
    if (ce !== undefined) {
      const ceLabel = ce.getProperties().getOrDefault<string>("label", "");
      labels.set(i, ceLabel !== "" ? ceLabel : ce.instanceId);
      continue;
    }
    labels.set(i, el.label !== "" ? el.label : `element_${i}`);
  }
  return labels;
}
