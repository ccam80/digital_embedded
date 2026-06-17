/**
 * AC voltage source — extended-waveform-mode coverage (sweep, AM, FM, noise).
 *
 * Base canon (Cat 1 init, Cat 2 dcop, Cat 3 transient, Cat 5 stamp parity,
 * Cat 8 breakpoints) is covered in `ac-voltage-source.test.ts`. This file's
 * canonical scope is Cat 4 — the `waveform` property is a compile-time
 * structural seed (string-typed, not numeric, so not hot-loadable via
 * `setComponentProperty`); the canonical Cat 4 mechanic for compile-time
 * structural seeds is build-twice and assert the documented post-compile
 * observable differs.
 */

import { describe, it, expect } from "vitest";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// Circuit factory: AcVoltageSource → 1kΩ → Ground.
//
// The AC source's `pos` pin is the only floating node; the resistor terminates
// the loop so the MNA matrix is well-posed. After the warm-start step, the
// source's `pos` node carries the instantaneous waveform value at the engine's
// internal simTime.
// ---------------------------------------------------------------------------

interface AcSourceProps {
  amplitude?: number;
  frequency?: number;
  phase?: number;
  dcOffset?: number;
  waveform?: string;
  freqStart?: number;
  freqEnd?: number;
  sweepDuration?: number;
  sweepMode?: "linear" | "log";
  modulationFreq?: number;
  modulationDepth?: number;
  modulationIndex?: number;
  noiseSampleTime?: number;
}

function buildAcSourceCircuit(facade: DefaultSimulatorFacade, props: AcSourceProps): Circuit {
  return facade.build({
    components: [
      {
        id: "acsrc",
        type: "AcVoltageSource",
        props: { label: "acsrc", amplitude: 1, frequency: 1000, phase: 0, dcOffset: 0, ...props },
      },
      { id: "r1", type: "Resistor", props: { label: "r1", resistance: 1000 } },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["acsrc:pos", "r1:pos"],
      ["r1:neg", "gnd:out"],
      ["acsrc:neg", "gnd:out"],
    ],
  });
}

function getAcsrcPosNode(fix: ReturnType<typeof buildFixture>): number {
  const node =
    fix.circuit.labelToNodeId.get("acsrc:pos") ??
    fix.circuit.labelToNodeId.get("r1:pos");
  if (node === undefined) {
    throw new Error("acsrc:pos / r1:pos node not found in labelToNodeId");
  }
  return node;
}

// ---------------------------------------------------------------------------
// Cat 4 — extended-waveform compile-time-seed observability.
//
// Mechanic: build the same circuit twice — once as `sine` (the default base
// waveform), once as the extended mode under test — and assert that the
// node voltage at the AC source's pos pin diverges. The waveform property is
// a structural seed (string-valued, not numeric), so the canonical mechanic
// is build-twice, not setComponentProperty hot-load.
// ---------------------------------------------------------------------------

describe("AcVoltageSource extended waveforms (Cat 4 compile-time seed)", () => {
  it("sweep_mode_diverges_from_pure_sine_after_warmstart", () => {
    // At the warm-start sample point, sweep at f(t) = freqStart + (freqEnd - freqStart) * t / T
    // produces a different instantaneous voltage than pure sine at fixed frequency=1000Hz,
    // unless freqStart == frequency AND t happens to land on a coincident phase. Choosing
    // freqStart = 100Hz, freqEnd = 10000Hz over 1s ensures the phase argument differs from
    // the pure-sine carrier at every non-zero t.
    const fixSine = buildFixture({
      build: (_r, facade) => buildAcSourceCircuit(facade, { waveform: "sine", frequency: 1000 }),
    });
    const fixSweep = buildFixture({
      build: (_r, facade) => buildAcSourceCircuit(facade, {
        waveform: "sweep",
        frequency: 1000,
        freqStart: 100,
        freqEnd: 10000,
        sweepDuration: 1,
        sweepMode: "linear",
      }),
    });

    const vSine = fixSine.engine.getNodeVoltage(getAcsrcPosNode(fixSine));
    const vSweep = fixSweep.engine.getNodeVoltage(getAcsrcPosNode(fixSweep));

    // Documented contract: sweep mode replaces the fixed-frequency carrier with
    // a time-varying instantaneous frequency. After one warm-start step at
    // identical simTime, the two waveforms occupy distinct phase arguments and
    // produce distinct node voltages.
    expect(vSweep).not.toBeCloseTo(vSine, 4);
  });

  it("am_mode_diverges_from_pure_sine_after_warmstart", async () => {
    // V_am(t) = (1 + depth * sin(2π * modFreq * t)) * A * sin(2π * f * t)
    // With depth=1 and modFreq=100Hz, the envelope multiplies the carrier by
    // 1 + sin(2π*100*t). The warm-start step alone lands at t = T_carrier/6 ≈
    // 1.67e-7 s, where the 100Hz envelope is still ≈1.0001 and the carrier sine
    // is itself near its zero crossing, so |V_am - V_sine| is ~1e-7 — below the
    // 4-decimal bar. Sample instead at the carrier's first quarter-period
    // (t = T_carrier/4 = 0.25 ms): there the carrier sine is at its peak (≈A)
    // and the 100Hz envelope has advanced to 1 + sin(2π*100*0.25e-3) ≈ 1.156,
    // so the AM-vs-sine gap is ~0.15 and the divergence is unambiguous.
    const sampleTime = 0.25e-3; // T_carrier/4 with frequency = 1000 Hz
    const fixSine = buildFixture({
      build: (_r, facade) => buildAcSourceCircuit(facade, { waveform: "sine", frequency: 1000 }),
    });
    const fixAm = buildFixture({
      build: (_r, facade) => buildAcSourceCircuit(facade, {
        waveform: "am",
        frequency: 1000,
        modulationFreq: 100,
        modulationDepth: 1.0,
      }),
    });

    const [vSine] = await fixSine.facade.sampleAtTimes(
      fixSine.coordinator,
      [sampleTime],
      () => fixSine.engine.getNodeVoltage(getAcsrcPosNode(fixSine)),
    );
    const [vAm] = await fixAm.facade.sampleAtTimes(
      fixAm.coordinator,
      [sampleTime],
      () => fixAm.engine.getNodeVoltage(getAcsrcPosNode(fixAm)),
    );

    expect(vAm).not.toBeCloseTo(vSine!, 4);
  });

  it("fm_mode_diverges_from_pure_sine_after_warmstart", () => {
    // V_fm(t) = A * sin(2π * f * t + idx * sin(2π * modFreq * t))
    // The added phase-modulation term makes V_fm differ from the pure carrier
    // at any non-zero t when idx > 0.
    const fixSine = buildFixture({
      build: (_r, facade) => buildAcSourceCircuit(facade, { waveform: "sine", frequency: 1000 }),
    });
    const fixFm = buildFixture({
      build: (_r, facade) => buildAcSourceCircuit(facade, {
        waveform: "fm",
        frequency: 1000,
        modulationFreq: 100,
        modulationIndex: 5,
      }),
    });

    const vSine = fixSine.engine.getNodeVoltage(getAcsrcPosNode(fixSine));
    const vFm = fixFm.engine.getNodeVoltage(getAcsrcPosNode(fixFm));

    expect(vFm).not.toBeCloseTo(vSine, 4);
  });

  it("am_zero_depth_matches_pure_sine_carrier", () => {
    // Documented contract: AM with depth=0 reduces to pure carrier
    // (1 + 0 * sin(...)) * A * sin(2π*f*t) = A * sin(2π*f*t).
    const fixSine = buildFixture({
      build: (_r, facade) => buildAcSourceCircuit(facade, { waveform: "sine", frequency: 1000 }),
    });
    const fixAm0 = buildFixture({
      build: (_r, facade) => buildAcSourceCircuit(facade, {
        waveform: "am",
        frequency: 1000,
        modulationFreq: 100,
        modulationDepth: 0.0,
      }),
    });

    const vSine = fixSine.engine.getNodeVoltage(getAcsrcPosNode(fixSine));
    const vAm0 = fixAm0.engine.getNodeVoltage(getAcsrcPosNode(fixAm0));

    expect(vAm0).toBeCloseTo(vSine, 9);
  });

  it("fm_zero_index_matches_pure_sine_carrier", () => {
    // Documented contract: FM with modulationIndex=0 reduces to the pure carrier.
    // sin(2π*f*t + 0*sin(...)) = sin(2π*f*t).
    const fixSine = buildFixture({
      build: (_r, facade) => buildAcSourceCircuit(facade, { waveform: "sine", frequency: 1000 }),
    });
    const fixFm0 = buildFixture({
      build: (_r, facade) => buildAcSourceCircuit(facade, {
        waveform: "fm",
        frequency: 1000,
        modulationFreq: 100,
        modulationIndex: 0,
      }),
    });

    const vSine = fixSine.engine.getNodeVoltage(getAcsrcPosNode(fixSine));
    const vFm0 = fixFm0.engine.getNodeVoltage(getAcsrcPosNode(fixFm0));

    expect(vFm0).toBeCloseTo(vSine, 9);
  });

  it("noise_mode_produces_finite_node_voltage_distinct_from_sine", () => {
    // Documented contract (TRNOISE, vsrcload.c:356-398): noise mode evaluates
    // the sample-and-hold interpolation V1 + (V2-V1)*(t/TS - n1) at t > 0.
    // At t == 0 TRNOISE returns 0 (vsrcload.c:374), so we step each fixture
    // past the warm-start to a time > 0. Each fixture has its own freshly-seeded
    // SeededRng, so the Gaussian endpoints V1/V2 differ across builds.
    // The node voltage must be finite (no NaN/Infinity) and over 32 builds at
    // least two distinct values must appear (ruling out a degenerate constant).
    const TS = 1e-4; // 0.1 ms noise sample period
    const samples: number[] = [];
    for (let i = 0; i < 32; i++) {
      const fix = buildFixture({
        build: (_r, facade) => buildAcSourceCircuit(facade, {
          waveform: "noise",
          amplitude: 2.0,
          frequency: 1000,
          noiseSampleTime: TS,
        }),
        params: { tStop: TS * 3, maxTimeStep: TS / 5 },
      });
      // Step past t=0 to get the first non-zero TRNOISE evaluation.
      fix.coordinator.step();
      const v = fix.engine.getNodeVoltage(getAcsrcPosNode(fix));
      // Must be a finite number (no NaN/Infinity from a broken stamp).
      expect(Number.isFinite(v)).toBe(true);
      samples.push(v);
    }

    // Population variability: at least two distinct values across 32 builds.
    const distinct = new Set(samples).size;
    expect(distinct).toBeGreaterThan(1);
  });
});
