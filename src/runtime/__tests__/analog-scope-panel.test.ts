/**
 * Tests for AnalogScopePanel — channel capture, reset, Y-axis ranging, FFT.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AnalogScopePanel } from "../analog-scope-panel.js";
import { AnalogScopeBuffer } from "../analog-scope-buffer.js";
import type { AnalogEngine } from "@/core/analog-engine-interface.js";

// ---------------------------------------------------------------------------
// Mock AnalogEngine
// ---------------------------------------------------------------------------

function makeEngine(overrides: Partial<AnalogEngine> = {}): AnalogEngine {
  return {
    simTime: 0,
    lastDt: 1e-6,
    getNodeVoltage: vi.fn().mockReturnValue(0),
    getBranchCurrent: vi.fn().mockReturnValue(0),
    getElementCurrent: vi.fn().mockReturnValue(0),
    getElementPower: vi.fn().mockReturnValue(0),
    dcOperatingPoint: vi.fn(),
    configure: vi.fn(),
    onDiagnostic: vi.fn(),
    addBreakpoint: vi.fn(),
    clearBreakpoints: vi.fn(),
    // SimulationEngine / Engine base methods
    init: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
    step: vi.fn(),
    dispose: vi.fn(),
    getState: vi.fn(),
    addChangeListener: vi.fn(),
    removeChangeListener: vi.fn(),
    addMeasurementObserver: vi.fn(),
    removeMeasurementObserver: vi.fn(),
    getSignalRaw: vi.fn(),
    setSignal: vi.fn(),
    saveSnapshot: vi.fn(),
    restoreSnapshot: vi.fn(),
    ...overrides,
  } as unknown as AnalogEngine;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePanel(engine: AnalogEngine): AnalogScopePanel {
  // Pass null canvas — rendering tests would need a real canvas
  return new AnalogScopePanel(null, engine);
}

/** Advance engine simTime and call onStep */
function step(panel: AnalogScopePanel, engine: ReturnType<typeof makeEngine>, t: number): void {
  (engine as unknown as { simTime: number }).simTime = t;
  panel.onStep(1);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AnalogScope", () => {
  it("captures_voltage_on_step", () => {
    const engine = makeEngine({
      getNodeVoltage: vi.fn().mockReturnValue(4.2),
    });
    const panel = makePanel(engine);
    panel.addVoltageChannel(3, "Vout", "#4488ff");

    (engine as unknown as { simTime: number }).simTime = 1e-6;
    panel.onStep(1);

    // Access internal buffer via reflection to verify
    const ch = (panel as unknown as { _channels: { buffer: AnalogScopeBuffer }[] })._channels[0];
    expect(ch).toBeDefined();
    expect(ch!.buffer.sampleCount).toBe(1);

    const samples = ch!.buffer.getSamplesInRange(0, 1);
    expect(samples.value[0]).toBeCloseTo(4.2);
  });

  it("multiple_channels_independent", () => {
    let voltageCallCount = 0;
    let currentCallCount = 0;

    const engine = makeEngine({
      getNodeVoltage: vi.fn(() => {
        voltageCallCount++;
        return 3.3;
      }),
      getBranchCurrent: vi.fn(() => {
        currentCallCount++;
        return 0.01;
      }),
    });

    const panel = makePanel(engine);
    panel.addVoltageChannel(1, "V1", "#ff0000");
    panel.addCurrentChannel(0, "I1", "#00ff00");

    (engine as unknown as { simTime: number }).simTime = 1e-6;
    panel.onStep(1);

    const channels = (panel as unknown as { _channels: { buffer: AnalogScopeBuffer; kind: string }[] })._channels;
    expect(channels.length).toBe(2);

    const vch = channels.find((c) => c.kind === "voltage");
    const ich = channels.find((c) => c.kind === "current");

    expect(vch!.buffer.sampleCount).toBe(1);
    expect(ich!.buffer.sampleCount).toBe(1);

    const vSamples = vch!.buffer.getSamplesInRange(0, 1);
    const iSamples = ich!.buffer.getSamplesInRange(0, 1);

    expect(vSamples.value[0]).toBeCloseTo(3.3);
    expect(iSamples.value[0]).toBeCloseTo(0.01);
  });

  it("reset_clears_buffers", () => {
    const engine = makeEngine({
      getNodeVoltage: vi.fn().mockReturnValue(5),
    });
    const panel = makePanel(engine);
    panel.addVoltageChannel(0, "V1", "#4488ff");

    // Push a few samples
    for (let i = 0; i < 5; i++) {
      (engine as unknown as { simTime: number }).simTime = i * 1e-6;
      panel.onStep(i);
    }

    const channels = (panel as unknown as { _channels: { buffer: AnalogScopeBuffer }[] })._channels;
    expect(channels[0]!.buffer.sampleCount).toBe(5);

    panel.onReset();

    expect(channels[0]!.buffer.sampleCount).toBe(0);
  });

  it("auto_y_range_tracks_visible", () => {
    const voltages = [0, 1, 2, 3, 4, 5];
    let idx = 0;
    const engine = makeEngine({
      getNodeVoltage: vi.fn(() => voltages[idx % voltages.length]),
    });

    const panel = makePanel(engine);
    panel.addVoltageChannel(0, "V1", "#4488ff");
    panel.setTimeRange(1); // 1 second window

    // Push samples across t=0..5e-3
    for (let i = 0; i < voltages.length; i++) {
      idx = i;
      (engine as unknown as { simTime: number }).simTime = i * 1e-3;
      panel.onStep(i);
    }

    // Compute shared Y range to test auto-range
    const vp = (panel as unknown as {
      _computeSharedYRange: (
        tStart: number,
        tEnd: number,
      ) => { yMin: number; yMax: number };
    })._computeSharedYRange(0, 1);

    // Range should be [0-10%padding, 5+10%padding] = [-0.5, 5.5]
    expect(vp.yMin).toBeCloseTo(-0.5, 1);
    expect(vp.yMax).toBeCloseTo(5.5, 1);
  });

  it("manual_y_range_overrides", () => {
    const engine = makeEngine({
      getNodeVoltage: vi.fn().mockReturnValue(5),
    });
    const panel = makePanel(engine);
    panel.addVoltageChannel(0, "V1", "#4488ff");
    panel.setYRange("V1", 0, 3.3);
    panel.setTimeRange(1);

    // Push samples up to 5V
    for (let i = 0; i < 10; i++) {
      (engine as unknown as { simTime: number }).simTime = i * 1e-4;
      panel.onStep(i);
    }

    const channels = (panel as unknown as {
      _channels: {
        buffer: AnalogScopeBuffer;
        autoRange: boolean;
        yMin: number;
        yMax: number;
      }[];
    })._channels;

    const ch = channels[0]!;
    // Manual range should not be overridden even though data goes to 5V
    expect(ch.autoRange).toBe(false);
    expect(ch.yMin).toBeCloseTo(0, 5);
    expect(ch.yMax).toBeCloseTo(3.3, 5);
  });

  it("envelope_at_low_zoom", () => {
    // Push 10000 samples, zoom out to show all. The panel should use
    // envelope rendering (sample density > ENVELOPE_THRESHOLD = 1000).
    const engine = makeEngine({
      getNodeVoltage: vi.fn((id) => Math.sin(2 * Math.PI * id / 1000)),
    });
    const panel = makePanel(engine);
    panel.addVoltageChannel(0, "V1", "#4488ff");
    panel.setTimeRange(1); // 1-second window

    const N = 10000;
    for (let i = 0; i < N; i++) {
      (engine as unknown as { simTime: number }).simTime = i * 1e-4;
      panel.onStep(i);
    }

    const channels = (panel as unknown as { _channels: { buffer: AnalogScopeBuffer }[] })._channels;
    const ch = channels[0]!;
    expect(ch.buffer.sampleCount).toBeGreaterThanOrEqual(N < 65536 ? N : 65536);

    // The panel should decide to use envelope when more than 1000 samples
    // are visible. Verify by counting visible samples directly.
    const tEnd = (panel as unknown as { _viewEnd: number })._viewEnd;
    const duration = (panel as unknown as { _viewDuration: number })._viewDuration;
    const tStart = tEnd - duration;
    const visibleSamples = ch.buffer.getSamplesInRange(tStart, tEnd);
    expect(visibleSamples.time.length).toBeGreaterThan(1000);
  });

  it("fft_enabled_toggle", () => {
    const engine = makeEngine();
    const panel = makePanel(engine);

    panel.setFftEnabled(true);
    expect((panel as unknown as { _fftEnabled: boolean })._fftEnabled).toBe(true);

    panel.setFftEnabled(false);
    expect((panel as unknown as { _fftEnabled: boolean })._fftEnabled).toBe(false);
  });

  it("fft_channel_selection", () => {
    const engine = makeEngine();
    const panel = makePanel(engine);

    panel.addVoltageChannel(0, "Vout", "#4488ff");
    panel.addVoltageChannel(1, "Vin", "#ff4444");

    panel.setFftChannel("Vin");
    expect((panel as unknown as { _fftChannelLabel: string })._fftChannelLabel).toBe("Vin");
  });
});
