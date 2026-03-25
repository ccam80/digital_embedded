/**
 * Tests for AnalogScopePanel — channel capture, reset, Y-axis ranging, FFT.
 */

import { describe, it, expect } from "vitest";
import { AnalogScopePanel } from "../analog-scope-panel.js";
import { AnalogScopeBuffer } from "../analog-scope-buffer.js";
import { MockCoordinator } from "@/test-utils/mock-coordinator.js";
import type { SignalAddress } from "@/compile/types.js";

// ---------------------------------------------------------------------------
// Shared signal addresses
// ---------------------------------------------------------------------------

const VOLTAGE_ADDR: SignalAddress = { domain: "analog", nodeId: 3 };
const VOLTAGE_ADDR2: SignalAddress = { domain: "analog", nodeId: 5 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a coordinator with configurable simTime, voltage, and current sources.
 * Returns the coordinator plus mutation helpers.
 */
function buildCoordinator(opts: {
  simTime?: number;
  voltage?: number;
  branchCurrent?: number;
  elementCurrent?: number;
} = {}): {
  coordinator: MockCoordinator;
  setSimTime(t: number): void;
  setVoltage(addr: SignalAddress, v: number): void;
} {
  const coord = new MockCoordinator();
  if (opts.voltage !== undefined) {
    coord.setSignal(VOLTAGE_ADDR, { type: "analog", voltage: opts.voltage });
    coord.setSignal(VOLTAGE_ADDR2, { type: "analog", voltage: opts.voltage });
  }

  let currentSimTime = opts.simTime ?? 0;
  Object.defineProperty(coord, "simTime", {
    get: () => currentSimTime,
    configurable: true,
  });

  if (opts.branchCurrent !== undefined) {
    const bc = opts.branchCurrent;
    (coord as unknown as { readBranchCurrent(i: number): number | null }).readBranchCurrent = (_i: number) => bc;
  }
  if (opts.elementCurrent !== undefined) {
    const ec = opts.elementCurrent;
    (coord as unknown as { readElementCurrent(i: number): number | null }).readElementCurrent = (_i: number) => ec;
  }

  return {
    coordinator: coord,
    setSimTime: (t: number) => { currentSimTime = t; },
    setVoltage: (addr: SignalAddress, v: number) => {
      coord.setSignal(addr, { type: "analog", voltage: v });
    },
  };
}

function makePanel(coordinator: MockCoordinator): AnalogScopePanel {
  return new AnalogScopePanel(null, coordinator);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AnalogScope", () => {
  it("captures_voltage_on_step", () => {
    const { coordinator, setSimTime } = buildCoordinator({ voltage: 4.2 });
    const panel = makePanel(coordinator);
    panel.addVoltageChannel(VOLTAGE_ADDR, "Vout", "#4488ff");

    setSimTime(1e-6);
    panel.onStep(1);

    const ch = (panel as unknown as { _channels: { buffer: AnalogScopeBuffer }[] })._channels[0];
    expect(ch).toBeDefined();
    expect(ch!.buffer.sampleCount).toBe(1);

    const samples = ch!.buffer.getSamplesInRange(0, 1);
    expect(samples.value[0]).toBeCloseTo(4.2);
  });

  it("multiple_channels_independent", () => {
    const { coordinator, setSimTime } = buildCoordinator({
      voltage: 3.3,
      branchCurrent: 0.01,
    });

    const panel = makePanel(coordinator);
    panel.addVoltageChannel(VOLTAGE_ADDR, "V1", "#ff0000");
    panel.addCurrentChannel(0, "I1", "#00ff00");

    setSimTime(1e-6);
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
    const { coordinator, setSimTime } = buildCoordinator({ voltage: 5 });
    const panel = makePanel(coordinator);
    panel.addVoltageChannel(VOLTAGE_ADDR, "V1", "#4488ff");

    for (let i = 0; i < 5; i++) {
      setSimTime(i * 1e-6);
      panel.onStep(i);
    }

    const channels = (panel as unknown as { _channels: { buffer: AnalogScopeBuffer }[] })._channels;
    expect(channels[0]!.buffer.sampleCount).toBe(5);

    panel.onReset();

    expect(channels[0]!.buffer.sampleCount).toBe(0);
  });

  it("auto_y_range_tracks_visible", () => {
    const voltages = [0, 1, 2, 3, 4, 5];
    const { coordinator, setSimTime, setVoltage } = buildCoordinator({ voltage: 0 });

    const panel = makePanel(coordinator);
    panel.addVoltageChannel(VOLTAGE_ADDR, "V1", "#4488ff");
    panel.setTimeRange(1);

    for (let i = 0; i < voltages.length; i++) {
      setVoltage(VOLTAGE_ADDR, voltages[i] ?? 0);
      setSimTime(i * 1e-3);
      panel.onStep(i);
    }

    const vp = (panel as unknown as {
      _computeSharedYRange: (tStart: number, tEnd: number) => { yMin: number; yMax: number };
    })._computeSharedYRange(0, 1);

    expect(vp.yMin).toBeCloseTo(-0.5, 1);
    expect(vp.yMax).toBeCloseTo(5.5, 1);
  });

  it("manual_y_range_overrides", () => {
    const { coordinator, setSimTime } = buildCoordinator({ voltage: 5 });
    const panel = makePanel(coordinator);
    panel.addVoltageChannel(VOLTAGE_ADDR, "V1", "#4488ff");
    panel.setYRange("V1", 0, 3.3);
    panel.setTimeRange(1);

    for (let i = 0; i < 10; i++) {
      setSimTime(i * 1e-4);
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
    expect(ch.autoRange).toBe(false);
    expect(ch.yMin).toBeCloseTo(0, 5);
    expect(ch.yMax).toBeCloseTo(3.3, 5);
  });

  it("envelope_at_low_zoom", () => {
    const { coordinator, setSimTime, setVoltage } = buildCoordinator({ voltage: 0 });

    const panel = makePanel(coordinator);
    panel.addVoltageChannel(VOLTAGE_ADDR, "V1", "#4488ff");
    panel.setTimeRange(1);

    const N = 10000;
    for (let i = 0; i < N; i++) {
      setVoltage(VOLTAGE_ADDR, Math.sin(2 * Math.PI * i / 1000));
      setSimTime(i * 1e-4);
      panel.onStep(i);
    }

    const channels = (panel as unknown as { _channels: { buffer: AnalogScopeBuffer }[] })._channels;
    const ch = channels[0]!;
    expect(ch.buffer.sampleCount).toBeGreaterThanOrEqual(N < 65536 ? N : 65536);

    const tEnd = (panel as unknown as { _viewEnd: number })._viewEnd;
    const duration = (panel as unknown as { _viewDuration: number })._viewDuration;
    const tStart = tEnd - duration;
    const visibleSamples = ch.buffer.getSamplesInRange(tStart, tEnd);
    expect(visibleSamples.time.length).toBeGreaterThan(1000);
  });

  it("fft_enabled_toggle", () => {
    const { coordinator } = buildCoordinator();
    const panel = makePanel(coordinator);

    panel.setFftEnabled(true);
    expect((panel as unknown as { _fftEnabled: boolean })._fftEnabled).toBe(true);

    panel.setFftEnabled(false);
    expect((panel as unknown as { _fftEnabled: boolean })._fftEnabled).toBe(false);
  });

  it("fft_channel_selection", () => {
    const { coordinator } = buildCoordinator();
    const panel = makePanel(coordinator);

    panel.addVoltageChannel(VOLTAGE_ADDR, "Vout", "#4488ff");
    panel.addVoltageChannel(VOLTAGE_ADDR2, "Vin", "#ff4444");

    panel.setFftChannel("Vin");
    expect((panel as unknown as { _fftChannelLabel: string })._fftChannelLabel).toBe("Vin");
  });

  it("registers_as_observer_on_construction", () => {
    const { coordinator } = buildCoordinator();
    const panel = makePanel(coordinator);

    const observers = (coordinator as unknown as { _observers: Set<unknown> })._observers;
    expect(observers.has(panel)).toBe(true);
  });

  it("deregisters_as_observer_on_dispose", () => {
    const { coordinator } = buildCoordinator();
    const panel = makePanel(coordinator);

    panel.dispose();

    const observers = (coordinator as unknown as { _observers: Set<unknown> })._observers;
    expect(observers.has(panel)).toBe(false);
  });

  it("reads_element_current_via_coordinator", () => {
    const { coordinator, setSimTime } = buildCoordinator({ elementCurrent: 0.05 });
    const panel = makePanel(coordinator);
    panel.addElementCurrentChannel(2, "Iel", "#ff8800");

    setSimTime(1e-6);
    panel.onStep(1);

    const channels = (panel as unknown as { _channels: { buffer: AnalogScopeBuffer; kind: string }[] })._channels;
    const ch = channels.find((c) => c.kind === "elementCurrent");
    expect(ch).toBeDefined();
    const samples = ch!.buffer.getSamplesInRange(0, 1);
    expect(samples.value[0]).toBeCloseTo(0.05);
  });

  it("reads_branch_current_via_coordinator", () => {
    const { coordinator, setSimTime } = buildCoordinator({ branchCurrent: 0.02 });
    const panel = makePanel(coordinator);
    panel.addCurrentChannel(1, "Ibranch", "#44cccc");

    setSimTime(1e-6);
    panel.onStep(1);

    const channels = (panel as unknown as { _channels: { buffer: AnalogScopeBuffer; kind: string }[] })._channels;
    const ch = channels.find((c) => c.kind === "current");
    expect(ch).toBeDefined();
    const samples = ch!.buffer.getSamplesInRange(0, 1);
    expect(samples.value[0]).toBeCloseTo(0.02);
  });

  it("uses_coordinator_simTime_for_x_axis", () => {
    const { coordinator, setSimTime } = buildCoordinator({ voltage: 1.0 });
    const panel = makePanel(coordinator);
    panel.addVoltageChannel(VOLTAGE_ADDR, "V1");

    setSimTime(5e-3);
    panel.onStep(1);

    const ch = (panel as unknown as { _channels: { buffer: AnalogScopeBuffer }[] })._channels[0]!;
    const samples = ch.buffer.getSamplesInRange(0, 1);
    expect(samples.time[0]).toBeCloseTo(5e-3);
  });
});
