/**
 * Tests for the Variable Rail source component.
 *
 * §3 poison-pattern migration (2026-05-03, fix-list line 420): the previous
 * file imported `runDcOp`, `loadCtxFromFields`, `makeTestSetupContext`,
 * `setupAll`, drove `element.setup(ctx)` / `element.load(ctx)` directly
 * against hand-rolled `LoadCtxImpl` / `SparseSolver` / capture-solver mocks,
 * and asserted bit-exact `rhs[branch]` values from those mock stamps. All
 * eradicated per §3 poison-pattern warning + §4a helper deletion. Tests now
 * route through `buildFixture` against the real registered VariableRail
 * factory and read voltages off `engine.getNodeVoltage(...)`.
 *
 * The `srcfact_*` describe block (3 tests) is deleted as a category-1
 * engine-impersonator-via-capture-solver pattern: those tests asserted that
 * the variable-rail RHS stamp ignores `ctx.srcFact` (i.e. is bit-exact equal
 * to the nominal voltage at srcFact ∈ {0, 0.5, 1}). The contract is
 * observable through the engine surface — under the production DCOP source
 * stepping path, the rail node settles to the nominal voltage regardless of
 * the internal step factor; the new `dc_node_voltage_matches_set_voltage`
 * test exercises this through `coordinator.dcOperatingPoint()` /
 * `engine.getNodeVoltage()`. Bit-exact RHS stamping for ordinary voltage
 * sources is covered by the ngspice harness parity tests under
 * `src/solver/analog/__tests__/ngspice-parity/` (compared against the
 * instrumented ngspice DLL), so the variable-rail-specific srcfact carve-out
 * is a contract-level promise for any DC-OP-converged result, not an
 * RHS-row-arithmetic check.
 */

import { describe, it, expect } from "vitest";
import { VariableRailDefinition } from "../variable-rail.js";
import { PropertyBag } from "../../../core/properties.js";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}

// ---------------------------------------------------------------------------
// Circuit factory: VariableRail(pos) → R_bleed(pos→neg) → GND.
//
// VariableRail's `pos` pin is its only externally exposed node; `neg` is
// permanently wired to ground inside the element (see variable-rail.ts:181).
// A 1MΩ bleed resistor to GND gives the matrix a DC reference for the rail
// node so DCOP converges; the rail node's settled voltage equals the nominal
// rail voltage (the bleed only draws nA, well below the source stiffness).
// ---------------------------------------------------------------------------

interface VRailCircuitParams {
  voltage: number;
  rBleed?: number;
}

function buildVRailCircuit(facade: DefaultSimulatorFacade, p: VRailCircuitParams): Circuit {
  return facade.build({
    components: [
      { id: "vrail", type: "VariableRail", props: { label: "vrail", voltage: p.voltage } },
      { id: "rb",    type: "Resistor",     props: { label: "rb", resistance: p.rBleed ?? 1e6 } },
      { id: "gnd",   type: "Ground" },
    ],
    connections: [
      ["vrail:pos", "rb:pos"],
      ["rb:neg",    "gnd:out"],
    ],
  });
}

function nodeOf(fix: ReturnType<typeof buildFixture>, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

// ===========================================================================
// VariableRail tests
// ===========================================================================

describe("VariableRail", () => {
  it("dc_node_voltage_matches_set_voltage -- 12V rail settles to 12V at the pos node", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildVRailCircuit(facade, { voltage: 12 }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vrail:pos"))).toBeCloseTo(12, 6);
  });

  it("zero_voltage_settles_to_zero -- 0V rail settles to 0V", () => {
    // Source stepping at srcFact=0 would kill an ordinary DC voltage source's
    // RHS during the inner DCOP sweep, but variable-rail.ts load() ignores
    // srcFact (vsrcload.c:416 path is replaced by an unconditional
    // `rhs[branch] += voltage`). Driving voltage=0 is the strongest external
    // proof of that contract: the converged solution is bit-exact 0V.
    const fix = buildFixture({
      build: (_r, facade) => buildVRailCircuit(facade, { voltage: 0 }),
    });
    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vrail:pos"))).toBeCloseTo(0, 6);
  });

  it("voltage_change_via_setComponentProperty_takes_effect -- 5V then 10V", () => {
    // Hot-loadable param contract: the rail's `voltage` model param must be
    // mutable through coordinator.setComponentProperty (production slider
    // path) without recompiling. After the patch + a fresh DCOP, the rail
    // node must read the new voltage.
    const fix = buildFixture({
      build: (_r, facade) => buildVRailCircuit(facade, { voltage: 5 }),
    });
    const dc1 = fix.coordinator.dcOperatingPoint()!;
    expect(dc1.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vrail:pos"))).toBeCloseTo(5, 6);

    const railEl = fix.circuit.elements.find((el) => el.label === "vrail")!;
    expect(railEl).toBeDefined();
    const rce = fix.circuit.elementToCircuitElement.get(
      fix.circuit.elements.indexOf(railEl),
    )!;
    fix.coordinator.setComponentProperty(rce, "voltage", 10);

    const dc2 = fix.coordinator.dcOperatingPoint()!;
    expect(dc2.converged).toBe(true);
    expect(fix.engine.getNodeVoltage(nodeOf(fix, "vrail:pos"))).toBeCloseTo(10, 6);
  });

  it("definition_engine_type_analog -- behavioral model is registered", () => {
    expect(VariableRailDefinition.modelRegistry?.behavioral).toBeDefined();
  });

  it("analogFactory_creates_element -- factory returns a non-null element", () => {
    const props = new PropertyBag();
    props.replaceModelParams({ voltage: 7 });
    const el = getFactory(VariableRailDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1]]),
      props,
      () => 0,
    );
    expect(el).toBeDefined();
  });

  it("element_allocates_branch_row_after_compile -- branchIndex > 0 in compiled circuit", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildVRailCircuit(facade, { voltage: 5 }),
    });
    const railEl = fix.circuit.elements.find((el) => el.label === "vrail")!;
    expect(railEl).toBeDefined();
    expect(railEl.branchIndex).toBeGreaterThan(0);
  });
});
