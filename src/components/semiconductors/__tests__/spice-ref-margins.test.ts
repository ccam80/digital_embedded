/**
 * Diagnostic test: prints actual relative errors for all SPICE reference assertions.
 * DELETE after verifying margins.
 */
import { describe, it, expect } from "vitest";
import { solveDcOperatingPoint } from "../../../solver/analog/dc-operating-point.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { DiagnosticCollector } from "../../../solver/analog/diagnostics.js";
import { DEFAULT_SIMULATION_PARAMS } from "../../../core/analog-engine-interface.js";
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
import { withNodeIds } from "../../../solver/analog/__tests__/test-helpers.js";
import { createDiodeElement } from "../diode.js";
import { createBjtElement, BJT_NPN_DEFAULTS } from "../bjt.js";
import { createMosfetElement } from "../mosfet.js";
import { createZenerElement } from "../zener.js";
import { PropertyBag } from "../../../core/properties.js";
import { createTestPropertyBag } from "../../../test-fixtures/model-fixtures.js";
import type { AnalogElement } from "../../../solver/analog/element.js";

function makeParamBag(params: Record<string, number>): PropertyBag {
  const bag = createTestPropertyBag();
  bag.replaceModelParams(params);
  return bag;
}

function makeResistorElement(n1: number, n2: number, r: number): AnalogElement {
  const g = 1 / r;
  return {
    pinNodeIds: [n1, n2],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    stamp(solver: { stamp(r: number, c: number, v: number): void }) {
      solver.stamp(n1, n1, g); solver.stamp(n1, n2, -g);
      solver.stamp(n2, n1, -g); solver.stamp(n2, n2, g);
    },
  } as unknown as AnalogElement;
}

const results: string[] = [];

function check(label: string, actual: number, expected: number) {
  const rel = Math.abs((actual - expected) / expected);
  const pct = (rel * 100).toFixed(6);
  const status = rel < 0.001 ? "PASS" : "FAIL";
  results.push(`  ${status} ${label}: actual=${actual.toPrecision(7)}, ref=${expected.toPrecision(7)}, relErr=${pct}%`);
}

describe("SPICE reference margin report", () => {
  it("all circuits", () => {
    const solver = new SparseSolver();
    const diag = new DiagnosticCollector();

    // --- DIODE ---
    results.push("\n=== DIODE (IS=1e-14, N=1) ===");
    {
      const vs = makeDcVoltageSource(2, 0, 2, 5) as unknown as AnalogElement;
      const r = makeResistorElement(1, 2, 1000);
      const d = withNodeIds(createDiodeElement(new Map([["A", 1], ["K", 0]]), [], -1,
        makeParamBag({ IS: 1e-14, N: 1, CJO: 0, VJ: 0.7, M: 0.5, TT: 0, FC: 0.5, BV: Infinity, IBV: 1e-3 })), [1, 0]);
      const res = solveDcOperatingPoint({ solver, elements: [vs, r, d], matrixSize: 3, params: DEFAULT_SIMULATION_PARAMS, diagnostics: diag });
      check("V(diode)", res.nodeVoltages[0], 6.928910e-01);
      check("I(diode)", (res.nodeVoltages[1] - res.nodeVoltages[0]) / 1000, 4.307675e-03);
    }

    // --- BJT BF=100 ---
    results.push("\n=== BJT (BF=100, IS=1e-14) ===");
    {
      const vcc = makeDcVoltageSource(4, 0, 4, 5) as unknown as AnalogElement;
      const vbb = makeDcVoltageSource(3, 0, 5, 5) as unknown as AnalogElement;
      const rc = makeResistorElement(4, 1, 1000);
      const rb = makeResistorElement(3, 2, 100_000);
      const props = createTestPropertyBag();
      props.replaceModelParams({ ...BJT_NPN_DEFAULTS });
      const bjt = withNodeIds(createBjtElement(1, new Map([["B", 2], ["C", 1], ["E", 0]]), -1, props), [2, 1, 0]);
      const res = solveDcOperatingPoint({ solver, elements: [vcc, vbb, rc, rb, bjt], matrixSize: 6, params: DEFAULT_SIMULATION_PARAMS, diagnostics: diag });
      check("V(collector)", res.nodeVoltages[0], 6.928910e-01);
      check("V(base)", res.nodeVoltages[1], 6.928910e-01);
      check("Ic", (res.nodeVoltages[3] - res.nodeVoltages[0]) / 1000, 4.307675e-03);
      check("Ib", (res.nodeVoltages[2] - res.nodeVoltages[1]) / 100_000, 4.307675e-05);
    }

    // --- NMOS ---
    results.push("\n=== NMOS (W=10u, VTO=0.7, KP=120u) ===");
    {
      const vdd = makeDcVoltageSource(2, 0, 3, 5) as unknown as AnalogElement;
      const vg = makeDcVoltageSource(3, 0, 4, 3) as unknown as AnalogElement;
      const rd = makeResistorElement(2, 1, 1000);
      const nmos = withNodeIds(createMosfetElement(1, new Map([["G", 3], ["S", 0], ["D", 1]]), [], -1,
        makeParamBag({ VTO: 0.7, KP: 120e-6, LAMBDA: 0.02, PHI: 0.6, GAMMA: 0.37, CBD: 0, CBS: 0, CGDO: 0, CGSO: 0, W: 10e-6, L: 1e-6 })), [3, 0, 1]);
      const res = solveDcOperatingPoint({ solver, elements: [vdd, vg, rd, nmos], matrixSize: 5, params: DEFAULT_SIMULATION_PARAMS, diagnostics: diag });
      check("V(drain)", res.nodeVoltages[0], 1.840508e+00);
      check("Id", (res.nodeVoltages[1] - res.nodeVoltages[0]) / 1000, 3.159492e-03);
    }

    // --- ZENER ---
    results.push("\n=== ZENER (BV=5.1, IBV=1e-3) ===");
    {
      const vs = withNodeIds(makeDcVoltageSource(2, 0, 2, 12) as unknown as AnalogElement, [2, 0]);
      const r = makeResistorElement(1, 2, 1000);
      const z = withNodeIds(createZenerElement(new Map([["A", 0], ["K", 1]]), [], -1,
        makeParamBag({ IS: 1e-14, N: 1, BV: 5.1, IBV: 1e-3 })), [0, 1]);
      const res = solveDcOperatingPoint({ solver, elements: [vs, r, z], matrixSize: 3, params: DEFAULT_SIMULATION_PARAMS, diagnostics: diag });
      check("V(zener)", res.nodeVoltages[0], 5.149965e+00);
      check("I(zener)", (res.nodeVoltages[1] - res.nodeVoltages[0]) / 1000, 6.850035e-03);
    }

    // Print all at once for clean output
    console.log(results.join("\n"));
  });
});
