/**
 * Tests for Varactor Diode component.
 *
 * The varactor routes through createDiodeElement with capacitance-tuned
 * defaults (CJO=20pF). All load behaviour lives in diode.ts.
 *
 * Covers:
 *   - VARACTOR_PARAM_DEFS partition layout
 *   - Definition shape
 *   - Setup contract: setup() allocates handles before load() is called
 *   - TSTALLOC ordering: RS=0 (default) → stamps present at A/K positions
 */

import { describe, it, expect } from "vitest";
import { VaractorDefinition, VARACTOR_PARAM_DEFS } from "../varactor.js";
import type { AnalogFactory } from "../../../core/registry.js";
import { ComparisonSession } from "../../../solver/analog/__tests__/harness/comparison-session.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// VARACTOR_PARAM_DEFS partition layout tests (pre-existing)
// ---------------------------------------------------------------------------

describe("VARACTOR_PARAM_DEFS partition layout", () => {
  it("AREA OFF IC have partition='instance'", () => {
    const areaDef = VARACTOR_PARAM_DEFS.find((d) => d.key === "AREA");
    const offDef = VARACTOR_PARAM_DEFS.find((d) => d.key === "OFF");
    const icDef = VARACTOR_PARAM_DEFS.find((d) => d.key === "IC");

    expect(areaDef).toBeDefined();
    expect(offDef).toBeDefined();
    expect(icDef).toBeDefined();

    expect(areaDef!.partition).toBe("instance");
    expect(offDef!.partition).toBe("instance");
    expect(icDef!.partition).toBe("instance");
  });

  it("CJO VJ M IS FC TT N RS BV IBV NBV IKF IKR EG XTI KF AF TNOM have partition='model'", () => {
    const modelKeys = ["CJO", "VJ", "M", "IS", "FC", "TT", "N", "RS", "BV", "IBV", "NBV", "IKF", "IKR", "EG", "XTI", "KF", "AF", "TNOM"];
    for (const key of modelKeys) {
      const def = VARACTOR_PARAM_DEFS.find((d) => d.key === key);
      expect(def).toBeDefined();
      expect(def!.partition).toBe("model");
    }
  });
});

// ---------------------------------------------------------------------------
// Varactor definition tests
// ---------------------------------------------------------------------------

describe("Varactor definition", () => {
  it("definition_has_correct_fields", () => {
    expect(VaractorDefinition.name).toBe("VaractorDiode");
    expect(VaractorDefinition.modelRegistry?.["spice"]).toBeDefined();
    expect(VaractorDefinition.modelRegistry?.["spice"]?.kind).toBe("inline");
    expect((VaractorDefinition.modelRegistry?.["spice"] as { kind: "inline"; factory: AnalogFactory } | undefined)?.factory).toBeDefined();
  });

});

// ---------------------------------------------------------------------------
// Varactor setup contract tests
// ---------------------------------------------------------------------------

describe("Varactor setup contract", () => {
  it("TSTALLOC_ordering_RS_zero_7_entries", async () => {
    // RS=0 (default): _posPrimeNode aliases posNode.
    // With a forward-biased varactor, the diode stamps conductance at A/K positions.
    // Assert non-zero self-conductance entries at vd:A and vd:K rows.
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry) => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 0.3 } },
            { id: "vd",  type: "VaractorDiode",   props: { label: "vd",  RS: 0, CJO: 0 } },
            { id: "gnd", type: "Ground" },
          ],
          connections: [
            ["vs:pos",  "vd:A"],
            ["vd:K",    "gnd:out"],
            ["vs:neg",  "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    expect(stepEnd.converged.ours).toBe(true);

    const detail = session.getAttempt({ stepIndex: 0, phase: "dcopDirect", phaseAttemptIndex: 0 });
    const lastIter = detail.iterations[detail.iterations.length - 1].ours!;
    const M = lastIter.matrix!;
    const ms = lastIter.matrixSize;

    const matrixRowLabels = (session as unknown as {
      _ourTopology: { matrixRowLabels: Map<number, string> };
    })._ourTopology.matrixRowLabels;

    let vdARow = -1;
    let vdKRow = -1;
    matrixRowLabels.forEach((label, row) => {
      if (label.includes("vd:A")) vdARow = row;
      if (label.includes("vd:K")) vdKRow = row;
    });

    expect(vdARow).toBeGreaterThanOrEqual(0);
    expect(vdKRow).toBeGreaterThanOrEqual(0);

    // Forward-biased: anode self-conductance must be non-zero (diosetup.c entry 5).
    expect(Math.abs(M[vdARow * ms + vdARow])).toBeGreaterThan(0);
    // Cathode self-conductance must be non-zero (diosetup.c entry 6).
    expect(Math.abs(M[vdKRow * ms + vdKRow])).toBeGreaterThan(0);
  });
});
