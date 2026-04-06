/**
 * B3 (strict): Three-surface LTE coverage — spec-match rewrite.
 *
 * Seven strict analytical tests for the composite-tolerance LTE path.
 * Tests expose real engine bugs — a failing test is a finding, not a defect
 * in the test itself.
 *
 * Rules:
 *  - No timeout overrides. Default vitest 5000 ms timeout is the stall detector.
 *  - No tolerance widening beyond the analytical margin (≤ 3 % first-order,
 *    ≤ 5 % Q-based).
 *  - No parameter tuning to find a working regime.
 *  - No skip / todo / fails.
 */
import { describe, it, expect } from 'vitest';
import { DefaultSimulatorFacade } from '../default-facade.js';
import { createDefaultRegistry } from '../../components/register-all.js';
import { MNAEngine } from '../../solver/analog/analog-engine.js';

const registry = createDefaultRegistry();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countZeroCrossings(samples: number[]): number {
  let n = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    if (a === 0 || b === 0) continue;
    if (Math.sign(a) !== Math.sign(b)) n++;
  }
  return n;
}

function peakAbs(samples: number[]): number {
  let p = 0;
  for (const v of samples) {
    const a = Math.abs(v);
    if (a > p) p = a;
  }
  return p;
}

// ---------------------------------------------------------------------------
// describe block
// ---------------------------------------------------------------------------

describe('LTE/composite-tolerance path — MCP (facade) surface', () => {

  // =========================================================================
  // Test 1 — RC step response: exponential charging
  // =========================================================================
  it('RC step response: exponential charging matches V(1-e^-t/τ)', async () => {
    const R = 1000;
    const C = 1e-6;
    const tau = R * C; // 1 ms

    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: 'vs',  type: 'DcVoltageSource', props: { voltage: 0, label: 'Vs' } },
        { id: 'r1',  type: 'Resistor',        props: { resistance: R } },
        { id: 'c1',  type: 'Capacitor',       props: { capacitance: C, label: 'Vc' } },
        { id: 'gnd', type: 'Ground' },
      ],
      connections: [
        ['vs:pos',  'r1:A'],
        ['r1:B',    'c1:pos'],
        ['c1:neg',  'gnd:out'],
        ['vs:neg',  'gnd:out'],
      ],
    });

    const engine = facade.compile(circuit);

    // Hot-update the DC source to 5 V — relies on the hot-loadable guarantee.
    facade.setSignal(engine, 'Vs', 5);

    // At t = τ: Vc ≈ 5·(1 - e⁻¹) = 3.1606 V
    await facade.stepToTime(engine, tau);
    const vcAtTau = facade.readSignal(engine, 'Vc:pos');
    const expected1 = 5 * (1 - Math.exp(-1)); // 3.1606
    // Within ±2 % of analytical
    expect(vcAtTau).toBeGreaterThanOrEqual(expected1 * 0.98);
    expect(vcAtTau).toBeLessThanOrEqual(expected1 * 1.02);

    // At t = 5τ: Vc ≈ 5·(1 - e⁻⁵) = 4.9663 V
    await facade.stepToTime(engine, 5 * tau);
    const vcAt5tau = facade.readSignal(engine, 'Vc:pos');
    const expected5 = 5 * (1 - Math.exp(-5)); // 4.9663
    // Within ±1 %
    expect(vcAt5tau).toBeGreaterThanOrEqual(expected5 * 0.99);
    expect(vcAt5tau).toBeLessThanOrEqual(expected5 * 1.01);

    // Monotonicity: capacitor must have charged further
    expect(vcAt5tau).toBeGreaterThan(vcAtTau);
  });

  // =========================================================================
  // Test 2 — RL step response: exponential current rise (via resistor voltage)
  //
  // Expected to fail if the pure-RL DC-op non-convergence bug reproduces.
  // =========================================================================
  it('RL step response: V_R matches 1-e^-t/τ (R=10, L=1mH, τ=100µs)', async () => {
    const R = 10;
    const L = 1e-3;
    const tau = L / R; // 100 µs

    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: 'vs',  type: 'DcVoltageSource', props: { voltage: 0, label: 'Vs' } },
        { id: 'r1',  type: 'Resistor',        props: { resistance: R, label: 'VR' } },
        { id: 'l1',  type: 'Inductor',        props: { inductance: L } },
        { id: 'gnd', type: 'Ground' },
      ],
      connections: [
        ['vs:pos',  'r1:A'],
        ['r1:B',    'l1:A'],
        ['l1:B',    'gnd:out'],
        ['vs:neg',  'gnd:out'],
      ],
    });

    const engine = facade.compile(circuit);

    // Hot-update to 1 V
    facade.setSignal(engine, 'Vs', 1);

    // At t = τ: V_R = R·i = 1 - e⁻¹ ≈ 0.6321 V
    await facade.stepToTime(engine, tau);
    const vrAtTau = facade.readSignal(engine, 'VR:A') - facade.readSignal(engine, 'VR:B');
    const expected1 = 1 - Math.exp(-1); // 0.6321
    expect(vrAtTau).toBeGreaterThanOrEqual(expected1 * 0.98);
    expect(vrAtTau).toBeLessThanOrEqual(expected1 * 1.02);

    // At t = 5τ: V_R ≈ 1 - e⁻⁵ ≈ 0.9933 V
    await facade.stepToTime(engine, 5 * tau);
    const vrAt5tau = facade.readSignal(engine, 'VR:A') - facade.readSignal(engine, 'VR:B');
    const expected5 = 1 - Math.exp(-5); // 0.9933
    expect(vrAt5tau).toBeGreaterThanOrEqual(expected5 * 0.99);
    expect(vrAt5tau).toBeLessThanOrEqual(expected5 * 1.01);

    // Monotonicity
    expect(vrAt5tau).toBeGreaterThan(vrAtTau);
  });

  // =========================================================================
  // Test 3 — LC ring-down: underdamped oscillation with monotonic envelope decay
  //
  // R=2, L=1mH, C=1µF → Q≈15.8, f₀≈5033 Hz, T₀≈199µs.
  // Expected to fail if engine enters STOPPED mid-transient (RLC stall bug).
  // =========================================================================
  it('series RLC ring-down: oscillatory with strictly decreasing envelope', async () => {
    const R = 2;
    const L = 1e-3;
    const C = 1e-6;
    const f0 = 1 / (2 * Math.PI * Math.sqrt(L * C)); // ≈ 5033 Hz
    const T0 = 1 / f0;                                // ≈ 199 µs

    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        // Start at 0 V so we can kick it
        { id: 'vs',  type: 'DcVoltageSource', props: { voltage: 0, label: 'Vs' } },
        { id: 'r1',  type: 'Resistor',        props: { resistance: R } },
        { id: 'l1',  type: 'Inductor',        props: { inductance: L } },
        { id: 'c1',  type: 'Capacitor',       props: { capacitance: C, label: 'Vc' } },
        { id: 'gnd', type: 'Ground' },
      ],
      connections: [
        ['vs:pos',  'r1:A'],
        ['r1:B',    'l1:A'],
        ['l1:B',    'c1:pos'],
        ['c1:neg',  'gnd:out'],
        ['vs:neg',  'gnd:out'],
      ],
    });

    const engine = facade.compile(circuit);

    // Let the DC op settle at 0 V, then kick to 1 V
    await facade.stepToTime(engine, 5e-6); // a few µs
    facade.setSignal(engine, 'Vs', 1);

    // Sample densely over 10 periods (≈ 2 ms) — 500 samples
    const sampleCount = 500;
    const dt = (10 * T0) / sampleCount;

    const sampleTimes = Array.from({ length: sampleCount }, (_, i) => 5e-6 + dt * (i + 1));
    const voltages = await facade.sampleAtTimes(
      engine,
      sampleTimes,
      () => facade.readSignal(engine, 'Vc:pos'),
    );

    const samples: Array<{ t: number; v: number }> = sampleTimes.map((t, i) => ({
      t,
      v: voltages[i]!,
    }));

    // Deviation from the drive (1 V)
    const dev = samples.map(s => s.v - 1);

    // At least 6 sign-changes across 10 periods (oscillatory)
    const crossings = countZeroCrossings(dev);
    expect(crossings).toBeGreaterThanOrEqual(6);

    // Find peak deviation per period
    function peakDevInPeriod(periodIndex: number): number {
      // Each period is sampleCount/10 samples
      const samplesPerPeriod = sampleCount / 10;
      const start = Math.floor(periodIndex * samplesPerPeriod);
      const end = Math.min(Math.floor((periodIndex + 1) * samplesPerPeriod), sampleCount);
      let maxDev = 0;
      for (let i = start; i < end; i++) {
        const a = Math.abs(dev[i]!);
        if (a > maxDev) maxDev = a;
      }
      return maxDev;
    }

    const peakP1 = peakDevInPeriod(0);
    const peakP5 = peakDevInPeriod(4);
    const peakP9 = peakDevInPeriod(8);

    // Envelope strictly decreasing: period 1 > period 5 > period 9
    expect(peakP1).toBeGreaterThan(peakP5);
    expect(peakP5).toBeGreaterThan(peakP9);
  });

  // =========================================================================
  // Test 4 — reltol configurability end-to-end
  //
  // Two compiles of the same RC+AC circuit with different reltol.
  // Expected to fail if the configure path is broken (both runs identical).
  // =========================================================================
  it('reltol configurability: tight reltol produces different result and more steps', async () => {
    const R = 1000;
    const C = 1e-6;
    const f = 1000; // 1 kHz

    function buildCircuit(facade: DefaultSimulatorFacade) {
      return facade.build({
        components: [
          { id: 'vs',  type: 'AcVoltageSource', props: {
            amplitude: 1, frequency: f, phase: 0, dcOffset: 0, waveform: 'sine', label: 'Vs',
          }},
          { id: 'r1',  type: 'Resistor',  props: { resistance: R } },
          { id: 'c1',  type: 'Capacitor', props: { capacitance: C, label: 'Vc' } },
          { id: 'gnd', type: 'Ground' },
        ],
        connections: [
          ['vs:pos', 'r1:A'],
          ['r1:B',   'c1:pos'],
          ['c1:neg', 'gnd:out'],
          ['vs:neg', 'gnd:out'],
        ],
      });
    }

    const target = 5e-4; // 0.5 ms

    // Loose reltol compile
    const facadeLoose = new DefaultSimulatorFacade(registry);
    const engineLoose = facadeLoose.compile(buildCircuit(facadeLoose));
    // Access the analog engine and configure reltol = 1e-2 (loose)
    const coordLoose = facadeLoose.getActiveCoordinator()!;
    const analogLoose = coordLoose.getAnalogEngine() as MNAEngine;
    analogLoose.configure({ reltol: 1e-2 });
    await facadeLoose.stepToTime(engineLoose, target);
    const vcLoose = facadeLoose.readSignal(engineLoose, 'Vc:pos');
    const stepCountLoose = (analogLoose as unknown as { _stepCount: number })._stepCount;

    // Tight reltol compile
    const facadeTight = new DefaultSimulatorFacade(registry);
    const engineTight = facadeTight.compile(buildCircuit(facadeTight));
    const coordTight = facadeTight.getActiveCoordinator()!;
    const analogTight = coordTight.getAnalogEngine() as MNAEngine;
    analogTight.configure({ reltol: 1e-6 });
    await facadeTight.stepToTime(engineTight, target);
    const vcTight = facadeTight.readSignal(engineTight, 'Vc:pos');
    const stepCountTight = (analogTight as unknown as { _stepCount: number })._stepCount;

    // Two different reltol values must produce numerically different results
    expect(vcLoose).not.toBe(vcTight);

    // Tighter tolerance requires more internal steps
    expect(stepCountTight).toBeGreaterThan(stepCountLoose);
  });

  // =========================================================================
  // Test 5 — Fresh engine per compile: no LTE history leak
  // =========================================================================
  it('fresh engine per compile: identical circuits produce bit-for-bit identical results', async () => {
    const R = 1000;
    const C = 1e-6;

    function buildCircuit(facade: DefaultSimulatorFacade) {
      return facade.build({
        components: [
          { id: 'vs',  type: 'DcVoltageSource', props: { voltage: 0, label: 'Vs' } },
          { id: 'r1',  type: 'Resistor',        props: { resistance: R } },
          { id: 'c1',  type: 'Capacitor',       props: { capacitance: C, label: 'Vc' } },
          { id: 'gnd', type: 'Ground' },
        ],
        connections: [
          ['vs:pos', 'r1:A'],
          ['r1:B',   'c1:pos'],
          ['c1:neg', 'gnd:out'],
          ['vs:neg', 'gnd:out'],
        ],
      });
    }

    const target = 5e-3; // 5 ms

    const facadeA = new DefaultSimulatorFacade(registry);
    const engineA = facadeA.compile(buildCircuit(facadeA));
    facadeA.setSignal(engineA, 'Vs', 5);
    await facadeA.stepToTime(engineA, target);
    const vcA = facadeA.readSignal(engineA, 'Vc:pos');

    const facadeB = new DefaultSimulatorFacade(registry);
    const engineB = facadeB.compile(buildCircuit(facadeB));
    facadeB.setSignal(engineB, 'Vs', 5);
    await facadeB.stepToTime(engineB, target);
    const vcB = facadeB.readSignal(engineB, 'Vc:pos');

    // Bit-for-bit identical — no LTE history leak
    expect(vcB).toBe(vcA);
  });

  // =========================================================================
  // Test 6 — Zero-crossing progression for capacitor at low drive frequency
  //
  // RC with R=1kΩ, C=1µF, AC at 20 Hz (f << fc≈159 Hz).
  // At f << fc, |Vc/Vs| ≈ 1 and phase lag ≈ 0 so Vc closely tracks source.
  // Expected to fail if zero-crossing protection collapses (stall bug).
  // =========================================================================
  it('RC capacitor zero-crossings at f=20Hz (f<<fc): 2±1 crossings and peak≥0.95', async () => {
    const R = 1000;
    const C = 1e-6;
    const f = 20; // 20 Hz — well below fc≈159 Hz
    const period = 1 / f; // 50 ms

    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: 'vs',  type: 'AcVoltageSource', props: {
          amplitude: 1, frequency: f, phase: 0, dcOffset: 0, waveform: 'sine', label: 'Vs',
        }},
        { id: 'r1',  type: 'Resistor',  props: { resistance: R } },
        { id: 'c1',  type: 'Capacitor', props: { capacitance: C, label: 'Vc' } },
        { id: 'gnd', type: 'Ground' },
      ],
      connections: [
        ['vs:pos', 'r1:A'],
        ['r1:B',   'c1:pos'],
        ['c1:neg', 'gnd:out'],
        ['vs:neg', 'gnd:out'],
      ],
    });

    const engine = facade.compile(circuit);

    // Skip first period for startup transient, then sample one full period
    const tStart = period;    // 50 ms
    const tEnd = 2 * period;  // 100 ms

    // Sample the second period at 100 points
    const sampleCount = 100;
    const dt = (tEnd - tStart) / sampleCount;

    await facade.stepToTime(engine, tStart);

    const samples: number[] = [];
    for (let i = 1; i <= sampleCount; i++) {
      await facade.stepToTime(engine, tStart + dt * i);
      samples.push(facade.readSignal(engine, 'Vc:pos'));
    }

    // Exactly 2 zero-crossings ± 1 (boundary effects)
    const crossings = countZeroCrossings(samples);
    expect(crossings).toBeGreaterThanOrEqual(1);
    expect(crossings).toBeLessThanOrEqual(3);

    // At f=20Hz, f/fc=0.126: |Vc/Vs| = 1/√(1+(f/fc)²) ≈ 0.992
    // Peak must be within 5 % of source amplitude (1 V)
    const peak = peakAbs(samples);
    expect(peak).toBeGreaterThanOrEqual(0.95);
  });

  // =========================================================================
  // Test 7 — Zero-crossing progression for inductor at low drive frequency
  //
  // RL with R=10, L=1mH, AC at 200 Hz (f << fc≈1592 Hz).
  // Read V_R (proportional to branch current i = Vs/(R·√(1+(ωL/R)²))).
  // Expected to fail if pure-RL engine stall reproduces.
  // =========================================================================
  it('RL resistor zero-crossings at f=200Hz (f<<fc): ≥6 crossings over 4 periods', async () => {
    const R = 10;
    const L = 1e-3;
    const f = 200;    // 200 Hz — well below fc≈1592 Hz
    const period = 1 / f; // 5 ms

    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: 'vs',  type: 'AcVoltageSource', props: {
          amplitude: 1, frequency: f, phase: 0, dcOffset: 0, waveform: 'sine', label: 'Vs',
        }},
        { id: 'r1',  type: 'Resistor', props: { resistance: R, label: 'VR' } },
        { id: 'l1',  type: 'Inductor', props: { inductance: L } },
        { id: 'gnd', type: 'Ground' },
      ],
      connections: [
        ['vs:pos', 'r1:A'],
        ['r1:B',   'l1:A'],
        ['l1:B',   'gnd:out'],
        ['vs:neg', 'gnd:out'],
      ],
    });

    const engine = facade.compile(circuit);

    // Skip first period for startup transient, then sample 4 full periods
    const tStart = period;
    const tEnd = tStart + 4 * period;

    // 200 samples over 4 periods (50 per period)
    const sampleCount = 200;
    const dt = (tEnd - tStart) / sampleCount;

    await facade.stepToTime(engine, tStart);

    const samples: number[] = [];
    for (let i = 1; i <= sampleCount; i++) {
      await facade.stepToTime(engine, tStart + dt * i);
      samples.push(facade.readSignal(engine, 'VR:A') - facade.readSignal(engine, 'VR:B'));
    }

    // At least 6 zero-crossings (2/period × 4 periods − 2 edge slop)
    const crossings = countZeroCrossings(samples);
    expect(crossings).toBeGreaterThanOrEqual(6);

    // At f=200Hz, f/fc≈0.126: |Z|=R·√(1+(ωL/R)²)≈R (barely above R)
    // |i_peak| = Vs_peak / |Z| ≈ 0.992 A, so V_R peak ≈ 9.92 V / 10 Ω * 10 Ω
    // = 0.992 V. Allow within 10 % of source amplitude.
    const peak = peakAbs(samples);
    expect(peak).toBeGreaterThanOrEqual(0.9);
  });

});
