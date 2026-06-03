/**
 * Surface 1 (headless API) — inductive-system Cholesky verify pass.
 *
 * Drives verifyInductiveSystems directly with real compiled IND/MUT elements
 * (the Transformer property clamps couplingCoefficient to [0,1], so K=1.5 and
 * 3-inductor topologies are assembled via the package-private verify binder),
 * plus an end-to-end engine gate test through DefaultSimulatorFacade.configure.
 *
 * cite: muttemp.c:35-205 — MUTtemp verify pass (acceptance criteria 10-13 + waiver).
 */

import { describe, it, expect } from "vitest";
import { verifyInductiveSystems } from "../loaders/ind-family-temperature.js";
import { DiagnosticCollector } from "../diagnostics.js";
import type { TempContext } from "../temp-context.js";
import type { Diagnostic } from "../../../compile/types.js";
import { AnalogInductorElement } from "../../../components/passives/inductor.js";
import { MutualInductorElement } from "../../../components/passives/mutual-inductor.js";
import { PropertyBag } from "../../../core/properties.js";
import { buildFixture } from "./fixtures/build-fixture.js";

function makeInd(label: string, L: number): AnalogInductorElement {
  const props = new PropertyBag();
  props.setModelParam("inductance", L);
  const el = new AnalogInductorElement(new Map([["pos", 1], ["neg", 0]]), props);
  el.label = label;
  return el;
}

function makeMut(
  label: string,
  K: number,
  p1: AnalogInductorElement,
  p2: AnalogInductorElement,
): MutualInductorElement {
  const props = new PropertyBag();
  props.setModelParam("K", K);
  props.set("L1_branch", p1.label);
  props.set("L2_branch", p2.label);
  const m = new MutualInductorElement(new Map(), props);
  m.label = label;
  m._bindPartnersForVerify(p1, p2);
  return m;
}

function tempCtxOf(diagnostics: DiagnosticCollector, indVerbosity: number): TempContext {
  return { cktTemp: 300.15, cktNomTemp: 300.15, reltol: 1e-3, epsmin: 1e-28, _indVerbosity: indVerbosity, diagnostics };
}

describe("verifyInductiveSystems — Surface 1 headless", () => {
  // Criterion 10
  it("K=0.5 two coupled inductors emits no diagnostics", () => {
    const l1 = makeInd("L1", 1e-3);
    const l2 = makeInd("L2", 1e-3);
    const m = makeMut("K1", 0.5, l1, l2);
    const dc = new DiagnosticCollector();
    verifyInductiveSystems(tempCtxOf(dc, 2), [l1, l2], [m], dc);
    expect(dc.getDiagnostics()).toHaveLength(0);
  });

  // Criterion 11
  it("K=1.5 emits exactly one not-positive-definite diagnostic listing both inductors and the coupling", () => {
    const l1 = makeInd("L1", 1e-3);
    const l2 = makeInd("L2", 1e-3);
    const m = makeMut("K1", 1.5, l1, l2);
    const dc = new DiagnosticCollector();
    verifyInductiveSystems(tempCtxOf(dc, 2), [l1, l2], [m], dc);
    const ds = dc.getDiagnostics();
    expect(ds).toHaveLength(1);
    expect(ds[0]!.code).toBe("inductive-system-not-positive-definite");
    expect(ds[0]!.message).toContain("L1");
    expect(ds[0]!.message).toContain("L2");
    expect(ds[0]!.message).toContain("K1");
    expect(ds[0]!.explanation).toContain("|K1| > 1");
  });

  // Criterion 12
  it("two K couplings between the same pair emits exactly one duplicate-k diagnostic (repetitions==1)", () => {
    const l1 = makeInd("L1", 1e-3);
    const l2 = makeInd("L2", 1e-3);
    const m1 = makeMut("K1", 0.5, l1, l2);
    const m2 = makeMut("K2", 0.5, l1, l2);
    const dc = new DiagnosticCollector();
    verifyInductiveSystems(tempCtxOf(dc, 2), [l1, l2], [m1, m2], dc);
    const dup = dc.getDiagnostics().filter(d => d.code === "inductive-system-duplicate-k");
    expect(dup).toHaveLength(1);
  });

  // Criterion 13
  it("three inductors with two couplings emits incomplete-k at verbosity 2, nothing at verbosity 1", () => {
    const build = () => {
      const l1 = makeInd("L1", 1e-3);
      const l2 = makeInd("L2", 1e-3);
      const l3 = makeInd("L3", 1e-3);
      return { inds: [l1, l2, l3], muts: [makeMut("K1", 0.3, l1, l2), makeMut("K2", 0.3, l2, l3)] };
    };

    const dc2 = new DiagnosticCollector();
    const a = build();
    verifyInductiveSystems(tempCtxOf(dc2, 2), a.inds, a.muts, dc2);
    expect(dc2.getDiagnostics().filter(d => d.code === "inductive-system-incomplete-k")).toHaveLength(1);

    const dc1 = new DiagnosticCollector();
    const b = build();
    verifyInductiveSystems(tempCtxOf(dc1, 1), b.inds, b.muts, dc1);
    expect(dc1.getDiagnostics().filter(d => d.code === "inductive-system-incomplete-k")).toHaveLength(0);
  });

  // Waiver (muttemp.c:168-181)
  it("|K|=1 with non-negative inductances passes the positive-definite waiver", () => {
    const l1 = makeInd("L1", 1e-3);
    const l2 = makeInd("L2", 1e-3);
    const m = makeMut("K1", 1.0, l1, l2);
    const dc = new DiagnosticCollector();
    verifyInductiveSystems(tempCtxOf(dc, 2), [l1, l2], [m], dc);
    expect(dc.getDiagnostics().filter(d => d.code === "inductive-system-not-positive-definite")).toHaveLength(0);
  });

  // Engine gate (Decision (i) — configure hot-loads indVerbosity)
  it("DefaultSimulatorFacade.configure({indVerbosity}) gates the verify pass through the engine", () => {
    const diags: Diagnostic[] = [];
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs", type: "AcVoltageSource", props: { label: "VS", amplitude: 1, frequency: 1000 } },
          { id: "tx", type: "Transformer", props: { label: "TX1", model: "behavioral", turnsRatio: 1, primaryInductance: 1e-3, couplingCoefficient: 0.5 } },
          { id: "rl", type: "Resistor", props: { label: "RL", resistance: 1000 } },
          { id: "gnd", type: "Ground", props: { label: "GND" } },
        ],
        connections: [
          ["vs:pos", "tx:P1"], ["vs:neg", "gnd:out"], ["tx:P2", "gnd:out"],
          ["tx:S1", "rl:pos"], ["rl:neg", "gnd:out"], ["tx:S2", "gnd:out"],
        ],
      }),
    });
    fix.engine.onDiagnostic(d => diags.push(d));

    const mut = fix.circuit.elements.find(e => e instanceof MutualInductorElement) as MutualInductorElement;
    expect(mut).toBeDefined();
    mut.setParam("K", 1.5);

    diags.length = 0;
    fix.facade.setCircuitTemp(310);
    expect(diags.some(d => d.code === "inductive-system-not-positive-definite")).toBe(true);

    diags.length = 0;
    fix.facade.configure({ indVerbosity: 0 });
    expect(diags.some(d => d.code === "inductive-system-not-positive-definite")).toBe(false);
  });
});
