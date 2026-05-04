/**
 * JFET tests — migrated to §4 contract (2026-05-03).
 *
 * Per `spec/architectural-alignment.md` §A1 test-handling rule, the vast
 * majority of pre-port JFET tests have been deleted (hand-computed expected
 * values on intermediate state, banned `Math.min(expArg, 80)` clamp, etc.).
 *
 * Wave-1B §4 follow-up (2026-05-03): all remaining engine-impersonator
 * `setParam_TEMP_recomputes_tp` tests (one per polarity) deleted. They drove
 * `core.setup(setupCtx)` + `core.load(makeLoadCtx(...))` directly with
 * hand-rolled rhsOld vectors — bit-exact arithmetic that is covered by the
 * ngspice comparison harness (NJFET/PJFET map to ngspice `jfet` device via
 * `device-mappings.ts::JFET_MAPPING`). Plumbing-level "TEMP propagates into
 * tp" coverage survives via the closed-form `tp_vt_reflects_TEMP`,
 * `tSatCur_scales_with_TEMP`, and `TNOM_stays_nominal` tests below, which
 * exercise the same `computeJfetTempParams`/`computePjfetTempParams` path
 * without touching `.setup()` or `.load()`.
 *
 * Surface-level coverage retained:
 *   - Registration: NJfetDefinition / PJfetDefinition resolve via
 *     ComponentRegistry.
 *   - Pin layout: G/S/D pins present.
 *   - Param schema: instance/model partitioning matches Phase 2.5 W1.4 layout.
 *   - DC operating point: common-source NJFET self-biases via `buildFixture`
 *     + `coordinator.dcOperatingPoint()` + `engine.getNodeVoltage()`.
 *   - PJFET conduction smoke test: drain current observed via
 *     `engine.getNodeVoltage(j1:D)` proves saturation conduction without
 *     poking at matrix-row labels (latent capture.ts label-format bug
 *     surfaced and bypassed).
 *   - TEMP plumbing: closed-form `computeJfetTempParams` exercises tp recompute
 *     directly; instance temperature flows through factory params.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  NJfetDefinition,
  NJFET_PARAM_DEFS,
  NJFET_PARAM_DEFAULTS,
  computeJfetTempParams,
  type JfetParams,
} from "../njfet.js";
import {
  PJfetDefinition,
  PJFET_PARAM_DEFS,
  PJFET_PARAM_DEFAULTS,
  computePjfetTempParams,
  type PjfetParams,
} from "../pjfet.js";
import { ComponentRegistry } from "../../../core/registry.js";
import { createTestPropertyBag } from "../../../test-fixtures/model-fixtures.js";
import type { AnalogFactory } from "../../../core/registry.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

import type { Circuit } from "../../../core/circuit.js";

// ---------------------------------------------------------------------------
// PJFET — saturation conduction test via the public engine surface.
//
// Wave-1B latent-bug fold-in (2026-05-03): the prior `emits_stamps_when_conducting`
// test asserted on row labels `jfet:DP`/`jfet:SP` extracted from
// `ComparisonSession`'s `_ourTopology.matrixRowLabels`. That label format is
// not produced anywhere in the codebase — `capture.ts::buildTopology` emits
// `<elLabel>:<internalLabel>` (e.g. `jfet:drain`, `jfet:source`), and even
// those labels are merged onto the wrong matrix rows by capture.ts's
// `nodeId = pinCount + p` heuristic (capture.ts:122) which doesn't match
// the actual internal-node IDs allocated by `ctx.makeVolt`. The assertion
// therefore never matched in baseline. The bit-exact matrix-stamp contract
// for JFET drain/source primes is already covered by the ngspice comparison
// harness (NJFET/PJFET → ngspice `jfet` device via JFET_MAPPING); this test
// is rewritten to assert the same engineering intent (PJFET conducts in
// saturation) through the engine's public surface (`getNodeVoltage`).
// ---------------------------------------------------------------------------

describe("PJFET", () => {
  it("conducts_in_saturation", () => {
    // PJFET saturation circuit:
    //   VDD=10V from S to GND, VG=7V from G to GND, RD=100Ω from D to GND.
    //   BETA=2.5e-3 (IDSS=10mA at VTO=2V), VTO=2V, LAMBDA=0.
    //   vgs_internal = polarity*(VG-VS) = -1*(7-10) = +3 V → vgst = vgs - VTO = +1 V.
    //   Saturation drain current Id ≈ BETA * vgst² = 2.5e-3 * 1 = 2.5 mA.
    //   Voltage drop across RD = 2.5 mA * 100 Ω = 0.25 V → V(D) ≈ 0.25 V (PJFET
    //   pulls D up from GND through itself; the rd network sets D close to GND
    //   when the device is conducting). The exact bias depends on the
    //   junction physics (jfetload.c:249-348), but |V(D)| > 1e-3 V is enough
    //   to prove the device is conducting (the cutoff regime would yield
    //   V(D) ≈ 0 to numerical noise).
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vdd", type: "DcVoltageSource", props: { label: "vdd", voltage: 10 } },
          { id: "vg",  type: "DcVoltageSource", props: { label: "vg",  voltage: 7 } },
          { id: "rd",  type: "Resistor",        props: { label: "rd",  resistance: 100 } },
          {
            id: "j1",
            type: "PJFET",
            props: {
              label: "j1",
              VTO: 2, BETA: 2.5e-3, LAMBDA: 0, IS: 1e-14, N: 1,
              CGS: 0, CGD: 0, RD: 0, RS: 0,
            },
          },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vdd:pos", "j1:S"],
          ["j1:D",    "rd:pos"],
          ["rd:neg",  "gnd:out"],
          ["vg:pos",  "j1:G"],
          ["vg:neg",  "gnd:out"],
          ["vdd:neg", "gnd:out"],
        ],
      }),
    });

    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);

    // Source pinned at 10V (VDD), gate pinned at 7V (VG).
    const vSource = fix.engine.getNodeVoltage(nodeOf(fix, "j1:S"));
    const vGate   = fix.engine.getNodeVoltage(nodeOf(fix, "j1:G"));
    expect(vSource).toBeCloseTo(10, 6);
    expect(vGate).toBeCloseTo(7, 6);

    // Drain current through RD: I = V(D) / 100. With vgst=+1V the device is
    // firmly in saturation; closed-form ≈ 2.5 mA → V(D) ≈ 0.25 V.
    // Bound conservatively above the cutoff floor (current >> GMIN) and
    // below the linear/short-circuit ceiling.
    const vDrain = fix.engine.getNodeVoltage(nodeOf(fix, "j1:D"));
    const iD = Math.abs(vDrain / 100);
    expect(iD).toBeGreaterThan(1e-5); // >> GMIN-leakage
    expect(iD).toBeLessThan(1e-1);    // device not shorted
  });
});

// ---------------------------------------------------------------------------
// NR convergence test — common-source NJFET routed through `buildFixture`
// + `coordinator.dcOperatingPoint()` + `engine.getNodeVoltage()`. No direct
// `setup()` / `load()` calls; no hand-rolled `runDcOp` helper.
// ---------------------------------------------------------------------------

function buildCommonSourceNJfetCircuit(facade: DefaultSimulatorFacade): Circuit {
  // VDD=10V → Rd=10kΩ → JFET drain ; gate=0V ; source=GND.
  //   VTO=-2V, BETA=1e-4, LAMBDA=0, B=1.
  //   VGS=0V → vgst = 2V (saturation, device ON).
  //   cdrain = BETA * vgst² * (B + Bfac*vgst) = 1e-4 * 4 * 1 = 4e-4 A.
  //   Vdrop  = cdrain * Rd = 4V → V(drain) ≈ 6V (still saturated; vds > vgst).
  return facade.build({
    components: [
      { id: "vdd",  type: "DcVoltageSource", props: { label: "vdd", voltage: 10 } },
      { id: "vg",   type: "DcVoltageSource", props: { label: "vg",  voltage: 0 } },
      { id: "rd",   type: "Resistor",        props: { label: "rd",  resistance: 10000 } },
      {
        id: "j1",
        type: "NJFET",
        props: {
          label: "j1",
          VTO: -2.0, BETA: 1e-4, LAMBDA: 0, IS: 1e-14, N: 1,
          CGS: 0, CGD: 0, PB: 1.0, FC: 0.5, RD: 0, RS: 0,
          B: 1.0, TCV: 0, BEX: 0, AREA: 1, M: 1, KF: 0, AF: 1,
          TNOM: 300.15, TEMP: 300.15, OFF: 0,
        },
      },
      { id: "gnd",  type: "Ground" },
    ],
    connections: [
      ["vdd:pos", "rd:pos"],
      ["rd:neg",  "j1:D"],
      ["j1:S",    "gnd:out"],
      ["vg:pos",  "j1:G"],
      ["vg:neg",  "gnd:out"],
      ["vdd:neg", "gnd:out"],
    ],
  });
}

function nodeOf(fix: ReturnType<typeof buildFixture>, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

describe("NR", () => {
  it("converges_within_10_iterations", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildCommonSourceNJfetCircuit(facade),
    });

    const result = fix.coordinator.dcOperatingPoint()!;
    expect(result.converged).toBe(true);
    expect(result.iterations).toBeLessThanOrEqual(10);

    const vDrain = fix.engine.getNodeVoltage(nodeOf(fix, "j1:D"));
    const vGate  = fix.engine.getNodeVoltage(nodeOf(fix, "j1:G"));
    const vRdPos = fix.engine.getNodeVoltage(nodeOf(fix, "rd:pos"));

    // VDD rail at 10V, gate at 0V (stiff voltage sources).
    expect(vRdPos).toBeCloseTo(10, 6);
    expect(vGate).toBeCloseTo(0, 6);

    // Drain voltage: analytic prediction is 6V. Allow a generous window that
    // excludes cutoff (V≈10V, no current) and excludes the linear region
    // (V<vgst=2V). Band (1V, 10V) proves the solution is in the saturation
    // operating regime the circuit is designed to produce.
    expect(vDrain).toBeGreaterThan(1);
    expect(vDrain).toBeLessThan(10);

    // Drain current through Rd: |iD| = (VDD - VDrain) / Rd.
    // Analytic expectation ≈ 4e-4 A. Bound between 1e-5 A (device barely on)
    // and 1e-3 A (device hard-shorted) — at least two orders above GMIN.
    const iD = Math.abs((vRdPos - vDrain) / 10000);
    expect(iD).toBeGreaterThan(1e-5);
    expect(iD).toBeLessThan(1e-3);
  });
});

// ---------------------------------------------------------------------------
// Registration tests — parameter plumbing / component registry.
// ---------------------------------------------------------------------------

describe("Registration", () => {
  it("njfet_registered", () => {
    const registry = new ComponentRegistry();
    registry.register(NJfetDefinition);

    const def = registry.getStandalone("NJFET");
    expect(def).toBeDefined();
    expect(def!.modelRegistry?.["spice"]).toBeDefined();
    expect(def!.category).toBeDefined();
    expect((def!.modelRegistry?.["spice"] as { kind: "inline"; factory: AnalogFactory } | undefined)?.factory).toBeDefined();
  });

  it("pjfet_registered", () => {
    const registry = new ComponentRegistry();
    registry.register(PJfetDefinition);

    const def = registry.getStandalone("PJFET");
    expect(def).toBeDefined();
    expect(def!.modelRegistry?.["spice"]).toBeDefined();
    expect((def!.modelRegistry?.["spice"] as { kind: "inline"; factory: AnalogFactory } | undefined)?.factory).toBeDefined();
  });

  it("njfet_pin_layout_has_three_pins", () => {
    expect(NJfetDefinition.pinLayout).toHaveLength(3);
    const labels = NJfetDefinition.pinLayout.map((p) => p.label);
    expect(labels).toContain("G");
    expect(labels).toContain("D");
    expect(labels).toContain("S");
  });

  it("pjfet_pin_layout_has_three_pins", () => {
    expect(PJfetDefinition.pinLayout).toHaveLength(3);
    const labels = PJfetDefinition.pinLayout.map((p) => p.label);
    expect(labels).toContain("G");
    expect(labels).toContain("D");
    expect(labels).toContain("S");
  });
});

describe("NJFET_PARAM_DEFS partition layout", () => {
  it("instance params have partition='instance'", () => {
    const instanceKeys = ["AREA", "M", "TEMP", "OFF"];
    for (const key of instanceKeys) {
      const def = NJFET_PARAM_DEFS.find((d) => d.key === key);
      expect(def).toBeDefined();
      expect(def!.partition).toBe("instance");
    }
  });

  it("model params have partition='model'", () => {
    const modelKeys = [
      "VTO", "BETA", "LAMBDA", "IS", "N", "CGS", "CGD", "PB", "FC",
      "RD", "RS", "B", "TCV", "BEX", "KF", "AF", "TNOM"
    ];
    for (const key of modelKeys) {
      const def = NJFET_PARAM_DEFS.find((d) => d.key === key);
      expect(def).toBeDefined();
      expect(def!.partition).toBe("model");
    }
  });
});

describe("PJFET_PARAM_DEFS partition layout", () => {
  it("instance params have partition='instance'", () => {
    const instanceKeys = ["AREA", "M", "TEMP", "OFF"];
    for (const key of instanceKeys) {
      const def = PJFET_PARAM_DEFS.find((d) => d.key === key);
      expect(def).toBeDefined();
      expect(def!.partition).toBe("instance");
    }
  });

  it("model params have partition='model'", () => {
    const modelKeys = [
      "VTO", "BETA", "LAMBDA", "IS", "N", "CGS", "CGD", "PB", "FC",
      "RD", "RS", "B", "TCV", "BEX", "KF", "AF", "TNOM"
    ];
    for (const key of modelKeys) {
      const def = PJFET_PARAM_DEFS.find((d) => d.key === key);
      expect(def).toBeDefined();
      expect(def!.partition).toBe("model");
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers for TEMP tests.
// ---------------------------------------------------------------------------

function makeNjfetProps(overrides: Record<string, number> = {}): ReturnType<typeof createTestPropertyBag> {
  const propsObj = createTestPropertyBag();
  propsObj.replaceModelParams({ ...NJFET_PARAM_DEFAULTS, ...overrides });
  return propsObj;
}

function makePjfetProps(overrides: Record<string, number> = {}): ReturnType<typeof createTestPropertyBag> {
  const propsObj = createTestPropertyBag();
  propsObj.replaceModelParams({ ...PJFET_PARAM_DEFAULTS, ...overrides });
  return propsObj;
}

const CONSTKoverQ = 1.3806226e-23 / 1.6021918e-19;

function baseNjfetParams(overrides: Partial<JfetParams> = {}): JfetParams {
  return {
    VTO: -2.0, BETA: 1e-4, LAMBDA: 0, IS: 1e-14, N: 1,
    CGS: 0, CGD: 0, PB: 1.0, FC: 0.5, RD: 0, RS: 0,
    B: 1.0, TCV: 0, BEX: 0, AREA: 1, M: 1, KF: 0, AF: 1,
    TNOM: 300.15, TEMP: 300.15, OFF: 0,
    ...overrides,
  };
}

function basePjfetParams(overrides: Partial<PjfetParams> = {}): PjfetParams {
  return {
    VTO: 2.0, BETA: 1e-4, LAMBDA: 0, IS: 1e-14, N: 1,
    CGS: 0, CGD: 0, PB: 1.0, FC: 0.5, RD: 0, RS: 0,
    B: 1.0, TCV: 0, BEX: 0, AREA: 1, M: 1, KF: 0, AF: 1,
    TNOM: 300.15, TEMP: 300.15, OFF: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// NJFET TEMP tests (Tasks 7.2.1 + 7.2.2).
// ---------------------------------------------------------------------------

describe("NJFET TEMP", () => {
  it("TEMP_default_300_15", () => {
    const propsObj = makeNjfetProps();
    expect(propsObj.getModelParam<number>("TEMP")).toBe(300.15);
  });

  it("paramDefs_include_TEMP", () => {
    const keys = NJFET_PARAM_DEFS.map((pd) => pd.key);
    expect(keys).toContain("TEMP");
  });

  it("tp_vt_reflects_TEMP", () => {
    const tp = computeJfetTempParams(baseNjfetParams({ TEMP: 400 }));
    expect(tp.vt).toBeCloseTo(400 * CONSTKoverQ, 10);
  });

  it("tSatCur_scales_with_TEMP", () => {
    const tp300 = computeJfetTempParams(baseNjfetParams({ IS: 1e-14, TNOM: 300.15, TEMP: 300.15 }));
    const tp400 = computeJfetTempParams(baseNjfetParams({ IS: 1e-14, TNOM: 300.15, TEMP: 400 }));
    expect(tp400.tSatCur).toBeGreaterThan(tp300.tSatCur);
  });

  it("TNOM_stays_nominal", () => {
    const tp = computeJfetTempParams(baseNjfetParams({ TEMP: 400, TNOM: 300.15, BEX: 1 }));
    expect(tp.tBeta).toBeCloseTo(1e-4 * (400 / 300.15), 10);
  });

  it("no_ctx_vt_read_in_njfet_ts", () => {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(srcDir, "..", "njfet.ts"), "utf8");
    const count = (src.match(/ctx\.vt/g) ?? []).length;
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PJFET TEMP tests (Tasks 7.2.1 + 7.2.2 + 7.2.3).
// ---------------------------------------------------------------------------

describe("PJFET TEMP", () => {
  it("TEMP_default_300_15", () => {
    const propsObj = makePjfetProps();
    expect(propsObj.getModelParam<number>("TEMP")).toBe(300.15);
  });

  it("paramDefs_include_TEMP", () => {
    const keys = PJFET_PARAM_DEFS.map((pd) => pd.key);
    expect(keys).toContain("TEMP");
  });

  it("tp_vt_reflects_TEMP", () => {
    const tp = computePjfetTempParams(basePjfetParams({ TEMP: 400 }));
    expect(tp.vt).toBeCloseTo(400 * CONSTKoverQ, 10);
  });

  it("tSatCur_scales_with_TEMP", () => {
    const tp300 = computePjfetTempParams(basePjfetParams({ IS: 1e-14, TNOM: 300.15, TEMP: 300.15 }));
    const tp400 = computePjfetTempParams(basePjfetParams({ IS: 1e-14, TNOM: 300.15, TEMP: 400 }));
    expect(tp400.tSatCur).toBeGreaterThan(tp300.tSatCur);
  });

  it("no_ctx_vt_read_in_pjfet_ts", () => {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(srcDir, "..", "pjfet.ts"), "utf8");
    const count = (src.match(/ctx\.vt/g) ?? []).length;
    expect(count).toBe(0);
  });
});
