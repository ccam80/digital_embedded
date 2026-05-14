import { describe, it, expect, beforeAll } from "vitest";
import { allocNortonStamp } from "../stamp-helpers.js";
import { buildFixture, type Fixture } from "./fixtures/build-fixture.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { ComponentRegistry } from "../../../core/registry.js";
import type { Circuit } from "../../../core/circuit.js";

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------
//
// A minimal mux circuit gives a fully initialised SparseSolver and a real
// LoadContext (fix.engine.cktContext).  Using node IDs within the circuit's
// own matrixSize range keeps rhs writes in-bounds.  The mux driver uses
// allocNortonStamp + stampNortonValue in production, so the same stamp
// helpers are exercised on every coordinator.step() call.
//
// Circuit topology:
//   vsSel  (0 V, LOW — selects in_0)
//   vsIn0  (5 V, HIGH — data input 0)
//   vsIn1  (0 V, LOW — data input 1)
//   mux    (BehavioralMuxDriver, selectorBits=1, rOut=100, vOH=5, vOL=0)
//   rLoad  (10000 Ω, gnd — load resistor on mux output)
//
// At DC-OP with vsSel=0 V, in_0 is selected.  vsIn0=5 V > vIH=2 V so
// result=1 and the driver stamps vOH=5 V through rOut=100 Ω.
// Expected output voltage = vOH * rLoad / (rLoad + rOut)
//                         = 5 * 10000 / (10000 + 100)
//                         ≈ 4.9505 V

function buildMuxCircuit(): (registry: ComponentRegistry, facade: DefaultSimulatorFacade) => Circuit {
  return (_registry, facade) =>
    facade.build({
      components: [
        { id: "vsSel",  type: "DcVoltageSource", props: { voltage: 0.0 } },
        { id: "vsIn0",  type: "DcVoltageSource", props: { voltage: 5.0 } },
        { id: "vsIn1",  type: "DcVoltageSource", props: { voltage: 0.0 } },
        {
          id: "mux",
          type: "Multiplexer",
          props: { label: "mux", model: "behavioral", selectorBits: 1 },
        },
        { id: "rLoad", type: "Resistor", props: { resistance: 10000 } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vsSel:pos",  "mux:sel"],
        ["vsIn0:pos",  "mux:in_0"],
        ["vsIn1:pos",  "mux:in_1"],
        ["mux:out",    "rLoad:pos"],
        ["rLoad:neg",  "gnd:out"],
        ["vsSel:neg",  "gnd:out"],
        ["vsIn0:neg",  "gnd:out"],
        ["vsIn1:neg",  "gnd:out"],
      ],
    });
}

// ---------------------------------------------------------------------------
// allocNortonStamp
// ---------------------------------------------------------------------------
// The mux driver calls allocNortonStamp(solver, ctrlOutNode, gndNode) during
// setup().  After buildFixture the solver is fully initialised and we can
// call allocNortonStamp on it with the circuit's own node IDs to verify that
// the returned tuple is length-4 with pairwise-distinct handles.
//
// Node IDs 1 and 2 exist in any multi-node circuit and have no special
// meaning for distinctness — the solver allocates one slot per (row, col)
// location, so four different locations yield four different handles.

describe("allocNortonStamp", () => {
  it("returns four distinct handles for a non-degenerate (pos, neg) pair", () => {
    const fix = buildFixture({ build: buildMuxCircuit() });
    const solver = fix.engine.solver!;
    const handles = allocNortonStamp(solver, 1, 2);
    expect(handles).toHaveLength(4);
    // Pairwise distinct: (1,1), (2,2), (1,2), (2,1) are four different
    // matrix locations so allocElement returns four different pool slots.
    const set = new Set(handles);
    expect(set.size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// stampNortonAt and stampNortonValue — behavioral verification via DCOP
// ---------------------------------------------------------------------------
//
// The mux driver stamps a Norton equivalent (G = 1/rOut, I = G*vTarget) on
// every NR iteration.  With vsSel=0 V and vsIn0=5 V the mux selects in_0
// (HIGH), so vTarget = vOH = 5 V and rOut = 100 Ω.  After the DCOP
// converges, the output node voltage satisfies KCL:
//
//   (V_out - vOH) / rOut + V_out / rLoad = 0
//   V_out = vOH * rLoad / (rLoad + rOut)
//         = 5 * 10000 / 10100
//         ≈ 4.9505 V  (exact: 50000/10100)
//
// This result can only be correct if allocNortonStamp produced four distinct
// handles AND stampNortonAt/stampNortonValue wrote ±G and ±I correctly.

let sharedFix: Fixture;

beforeAll(() => {
  sharedFix = buildFixture({ build: buildMuxCircuit() });
});

describe("stampNortonAt / stampNortonValue — DCOP behavioral", () => {
  it("stampNortonValue (called by mux driver) stamps correct G: output voltage matches Norton divider", () => {
    const result = sharedFix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);

    const outNodeId = sharedFix.circuit.labelToNodeId.get("mux:out");
    expect(outNodeId).toBeDefined();
    const vOut = sharedFix.engine.getNodeVoltage(outNodeId!);

    // Exact Norton divider: vOH=5, rOut=100, rLoad=10000
    // V_out = 5 * 10000 / (10000 + 100) = 50000/10100
    const expected = (5 * 10000) / (10000 + 100);
    expect(vOut).toBeCloseTo(expected, 6);
  });

  it("stampNortonAt (same code path via stampNortonValue) stamps zero RHS for vOL=0 output: vOut ≈ 0 V", () => {
    // Drive vsSel HIGH so mux selects in_1 (vsIn1 = 0 V → vOL path).
    // The driver stamps vOL = 0, so I = G * 0 = 0 — stampNortonAt skips RHS.
    // Expected V_out = vOL * rLoad / (rLoad + rOut) = 0.
    const fix = buildFixture({
      build: (_registry, facade) =>
        facade.build({
          components: [
            { id: "vsSel",  type: "DcVoltageSource", props: { voltage: 5.0 } },
            { id: "vsIn0",  type: "DcVoltageSource", props: { voltage: 0.0 } },
            { id: "vsIn1",  type: "DcVoltageSource", props: { voltage: 0.0 } },
            {
              id: "mux",
              type: "Multiplexer",
              props: { label: "mux", model: "behavioral", selectorBits: 1 },
            },
            { id: "rLoad", type: "Resistor", props: { resistance: 10000 } },
            { id: "gnd",   type: "Ground" },
          ],
          connections: [
            ["vsSel:pos",  "mux:sel"],
            ["vsIn0:pos",  "mux:in_0"],
            ["vsIn1:pos",  "mux:in_1"],
            ["mux:out",    "rLoad:pos"],
            ["rLoad:neg",  "gnd:out"],
            ["vsSel:neg",  "gnd:out"],
            ["vsIn0:neg",  "gnd:out"],
            ["vsIn1:neg",  "gnd:out"],
          ],
        }),
    });

    const result = fix.coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(true);

    const outNodeId = fix.circuit.labelToNodeId.get("mux:out");
    expect(outNodeId).toBeDefined();
    const vOut = fix.engine.getNodeVoltage(outNodeId!);
    expect(vOut).toBeCloseTo(0, 9);
  });
});
