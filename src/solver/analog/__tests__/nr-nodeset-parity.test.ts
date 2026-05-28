/**
 * Newton-Raphson `.nodeset` DC operating-point parity (T3, paired vs ngspice).
 *
 * DESIRED behaviour vs CURRENT behaviour:
 *   - DESIRED (ngspice-equivalent): a SPICE `.nodeset` is a DC operating-point
 *     GUESS. ngspice clamps each listed node to its value with a 1e10
 *     conductance during the MODEINITJCT / MODEINITFIX passes and releases it
 *     before the final MODEINITFLOAT solve (cktload.c:107-120; the
 *     one-iteration deferral gate is niiter.c:1297-1302). On a circuit with
 *     more than one stable DC operating point the guess selects which state the
 *     solver settles into.
 *   - CURRENT (digiTS): digiTS never populates `cac.nodesets` and derives
 *     `hadNodeset` from `nodesets.size` (always 0), so it ignores nodesets
 *     entirely and lands wherever its own NR settles from the zero guess.
 *
 * The fixture is a symmetric cross-coupled NPN-BJT latch — two stable DC
 * operating points (Q1 saturated / Q2 off, and the mirror). Feeding ngspice a
 * `.nodeset` steers ONLY ngspice into one latch state, while digiTS stays at
 * the symmetric metastable point it finds without the guess. The result is a
 * genuine ours-vs-ngspice node-voltage divergence.
 *
 * This test asserts the DESIRED parity (ours === ngspice on the steered node)
 * and therefore FAILS today: its failure IS the standing signal that digiTS
 * lacks nodeset support. Do not weaken the assertion, skip, or xfail it — when
 * digiTS gains nodeset support the assertion passes on its own.
 */

import { it, beforeAll, afterAll, expect } from "vitest";
import path from "node:path";

import { ComparisonSession } from "./harness/comparison-session.js";
import type { ComparedValue } from "./harness/types.js";
import { DLL_PATH, describeIfDll } from "./ngspice-parity/parity-helpers.js";

const DTS_LATCH = path.resolve(
  "src/solver/analog/__tests__/ngspice-parity/fixtures/bjt-bistable-latch.dts",
);

/**
 * Find the single `getStepEnd().nodes` entry whose compound label
 * (`"Q1:C/RB2:pos/RC1:neg"`) carries the requested `LABEL:PIN` segment. Throws
 * if zero or more than one match so a topology change can never silently make
 * the assertion vacuous.
 */
function nodeForPin(
  nodes: Record<string, ComparedValue>,
  pin: string,
): ComparedValue {
  const matches = Object.entries(nodes).filter(([label]) =>
    label.split("/").includes(pin),
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one node carrying pin '${pin}', found ${matches.length}: ` +
      `[${matches.map(([l]) => l).join(", ")}]`,
    );
  }
  return matches[0]![1];
}

describeIfDll("NR .nodeset DC-OP parity on a bistable latch (T3)", () => {
  let session: ComparisonSession;

  beforeAll(async () => {
    // `.nodeset V(Q1:C)=5 V(Q2:C)=0.1` steers ngspice into the latch state with
    // Q1 off (collector high) and Q2 saturated (collector low). digiTS ignores
    // it. `deferStructuralAsserts: true` lets the DCOP run to completion so the
    // assertion lands on converged node VOLTAGES (the substantive nodeset gap),
    // not on the BJT first-iteration matrix-entry parity check.
    const nodesets = new Map<string, number>([
      ["Q1:C", 5],
      ["Q2:C", 0.1],
    ]);
    session = await ComparisonSession.create({
      dtsPath: DTS_LATCH,
      dllPath: DLL_PATH,
      nodesets,
      deferStructuralAsserts: true,
    });
    await session.runDcOp();
  });

  afterAll(async () => {
    if (session !== undefined) await session.dispose();
  });

  it("nodeset_steers_ngspice_to_latch_state_digiTS_does_not", () => {
    const { nodes } = session.getStepEnd(0);

    // The nodeset steers ngspice's Q1 collector high and Q2 collector low.
    // DESIRED: digiTS honours the same guess and converges to the same state,
    // so ours === ngspice (IEEE-754 identity) on both steered collectors.
    const q1c = nodeForPin(nodes, "Q1:C");
    const q2c = nodeForPin(nodes, "Q2:C");

    expect(
      q1c.withinTol,
      `Q1:C ours=${q1c.ours} ngspice=${q1c.ngspice} absDelta=${q1c.absDelta}: ` +
      `ngspice honoured the .nodeset and settled into the latch state; digiTS ` +
      `ignored it and stayed at the symmetric operating point. This failure is ` +
      `the desired surfaced gap (digiTS lacks .nodeset support).`,
    ).toBe(true);
    expect(
      q2c.withinTol,
      `Q2:C ours=${q2c.ours} ngspice=${q2c.ngspice} absDelta=${q2c.absDelta}: ` +
      `same surfaced gap as Q1:C.`,
    ).toBe(true);
  });
});
