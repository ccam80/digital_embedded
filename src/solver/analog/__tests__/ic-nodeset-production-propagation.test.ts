/**
 * `.ic` / `.nodeset` propagation on the PRODUCTION path.
 *
 * Two surfaces:
 *
 *  1. Headless API (DefaultSimulatorFacade.deserialize + compile): proves the
 *     compiler reads circuit.ics / circuit.nodesets and resolves each net/pin
 *     NAME to its MNA node id in compiled.analog.ics / .nodesets. The harness
 *     CANNOT cover this — it self-seeds compiled.ics directly
 *     (comparison-session.ts), bypassing the compiler resolution that the
 *     production / headless / MCP path depends on. ngspice counterpart:
 *     CKTsetNodPm setting node->icGiven/node->ic (cktsetnp.c:34-36, PARM_IC)
 *     and node->nsGiven/node->nodeset (cktsetnp.c:29-31, PARM_NS).
 *
 *  2. Harness capture (ComparisonSession vs ngspice): proves the resolved IC
 *     reaches the runtime matrix — the per-iteration IC diagonal stamp
 *     (cktload.c:131-158) lands on the handle pre-allocated before _setup()
 *     (cktic.c:28,35 -> _allocateNodesetIcHandles), so the constrained node's
 *     Jacobian row matches ngspice bit-exact at the boot-DCOP's first iteration.
 *     Without the handle the row would be zeroed and singular.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import path from "node:path";

import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../components/register-all.js";
import { compileUnified } from "../../../compile/compile.js";
import type { ConcreteCompiledAnalogCircuit } from "../compiled-analog-circuit.js";
import { ComparisonSession } from "./harness/comparison-session.js";
import { DLL_PATH, describeIfDll } from "./ngspice-parity/parity-helpers.js";

const IC_GATE_DTS = path.resolve(
  "src/solver/analog/__tests__/ngspice-parity/fixtures/ic-gate.dts",
);

/**
 * Minimal RC charge circuit: V1(5V) - R1(1k) - C1(1uF) - gnd, with the cap's
 * top node carrying a `.ic` of 2V. Authored as a programmatic `.dts` document
 * so the NAME-keyed `circuit.ics` object is exercised through the real
 * deserializer + compiler, not a test-only seed.
 */
function rcWithIc(icValue: number): string {
  return JSON.stringify({
    format: "dts",
    version: 1,
    circuit: {
      name: "rc-ic-production",
      elements: [
        { id: "v1", type: "DcVoltageSource", position: { x: 0, y: 0 }, rotation: 0, properties: { label: "V1", voltage: 5 } },
        { id: "r1", type: "Resistor", position: { x: 4, y: 0 }, rotation: 0, properties: { label: "R1", resistance: 1000 } },
        { id: "c1", type: "Capacitor", position: { x: 8, y: 0 }, rotation: 0, properties: { label: "C1", capacitance: 1e-6 } },
        { id: "gnd", type: "Ground", position: { x: 12, y: 0 }, rotation: 0, properties: { label: "gnd" } },
      ],
      wires: [
        { points: [{ x: 1, y: 0 }, { x: 4, y: 0 }] },
        { points: [{ x: 5, y: 0 }, { x: 8, y: 0 }] },
        { points: [{ x: 9, y: 0 }, { x: 12, y: 0 }] },
        { points: [{ x: 0, y: 0 }, { x: 0, y: 4 }] },
        { points: [{ x: 0, y: 4 }, { x: 12, y: 4 }] },
        { points: [{ x: 12, y: 4 }, { x: 12, y: 0 }] },
      ],
      ics: { "C1:pos": icValue },
    },
  });
}

describe(".ic production-path propagation (headless API)", () => {
  it("circuit.ics NAME resolves to an MNA node id in compiled.analog.ics", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);

    const circuit = facade.deserialize(rcWithIc(2));
    // The Circuit object carries the NAME-keyed map straight from the document.
    expect(circuit.ics).toBeDefined();
    expect(circuit.ics!.get("C1:pos")).toBe(2);

    // compileUnified is the production compile entry point the facade / MCP path
    // calls. Its analog partition is the ConcreteCompiledAnalogCircuit the engine runs.
    const unified = compileUnified(circuit, registry);
    const analog = unified.analog as ConcreteCompiledAnalogCircuit | null;
    expect(analog).not.toBeNull();

    // Defect #1: the compiler must read circuit.ics and resolve "C1:pos" -> nodeId.
    expect(analog!.ics).toBeDefined();
    expect(analog!.ics!.size).toBe(1);

    // The resolved key is the same MNA node id "C1:pos" addresses.
    const cposNode = analog!.labelPinNodes.get("C1")!.find(p => p.pinLabel === "pos")!.nodeId;
    expect(analog!.ics!.get(cposNode)).toBe(2);
  });

  it("a circuit with no .ic leaves compiled.analog.ics undefined", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);

    const doc = JSON.parse(rcWithIc(2)) as { circuit: Record<string, unknown> };
    delete doc.circuit.ics;

    const circuit = facade.deserialize(JSON.stringify(doc));
    expect(circuit.ics).toBeUndefined();

    const unified = compileUnified(circuit, registry);
    const analog = unified.analog as ConcreteCompiledAnalogCircuit | null;
    expect(analog).not.toBeNull();
    expect(analog!.ics).toBeUndefined();
  });
});

describeIfDll(".ic reaches the runtime matrix (harness capture vs ngspice)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    // ic-gate.dts carries `circuit.ics: {"C1:pos": 2}`. The harness compiles it
    // through the production pipeline AND seeds ngspice with the same `.ic`, so
    // the boot-DCOP (MODETRANOP, no MODEUIC) enforces the IC on both sides. With
    // the handle allocated before _setup() the constrained node's Jacobian row
    // is stamped identically to ngspice at the first boot iteration.
    session = await ComparisonSession.create({
      dtsPath: IC_GATE_DTS,
      dllPath: DLL_PATH,
      deferStructuralAsserts: true,
    });
    await session.runTransient(0, 5e-3);
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("boot-DCOP IC diagonal stamp matches ngspice bit-exact (matrix class clean)", () => {
    // The matrix-class signal is what defects #1+#2 own: the IC enforcement
    // (cktload.c Step 4b) writes the 1e10 / 1.0 diagonal onto the pre-allocated
    // handle, so the constrained node's row is present and equal to ngspice's.
    const diff = session.matrixDiff({ stepIndex: 0, iterationIndex: 0 });
    expect(
      diff.classification,
      `step0/iter0 matrix classification=${diff.classification}; ` +
      `oursOnly=${diff.oursOnly.length} ngspiceOnly=${diff.ngspiceOnly.length} ` +
      `valueMismatches=${diff.valueMismatches.length}. A non-"match" verdict means ` +
      `the IC diagonal handle was not allocated/stamped on the production path.`,
    ).toBe("match");

    // Cross-check via the classified first-divergence: the matrix axis must be
    // null (the IC reaches the Jacobian). voltage/rhs/state divergence here is
    // the SEPARATE cktic rhsOld seed (cktic.c:31,39), out of this fix's scope.
    const fd = session.firstDivergence();
    expect(
      fd.matrix,
      `firstDivergence.matrix should be null once the IC diagonal is stamped; got ` +
      `${JSON.stringify(fd.matrix)}`,
    ).toBeNull();
  });
});
