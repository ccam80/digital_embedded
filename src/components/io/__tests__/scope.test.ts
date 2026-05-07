import { describe, it, expect } from "vitest";
import { createDefaultRegistry } from "../../register-all.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { ScopeElement } from "../scope.js";
import type { PropertyValue } from "../../../core/properties.js";
import type { SignalValue } from "../../../compile/types.js";

// ---------------------------------------------------------------------------
// Scope / ScopeTrigger canonical test set
// Canon categories applicable: 9 (bridge / digital interaction).
// File tier: fixture-only (digital-only display/observer components; no
// analog setup()/load(), no junctions, no LTE, no breakpoints, single
// inline digital model entry per component).
// ---------------------------------------------------------------------------

interface ScopeFixture {
  facade: DefaultSimulatorFacade;
  coordinator: ReturnType<DefaultSimulatorFacade["compile"]>;
}

function digital(value: number): SignalValue {
  return { type: "digital", value };
}

function buildScopeCircuit(): ScopeFixture {
  const components: Array<{
    id: string;
    type: string;
    props: Record<string, PropertyValue>;
  }> = [
    { id: "drv", type: "In", props: { label: "DRIVE", bitWidth: 1 } },
    {
      id: "scope1",
      type: "Scope",
      props: { label: "SCOPE", channelCount: 1, bitWidth: 1, timeScale: 1 },
    },
  ];
  // Single-channel Scope's input pin is named "clk"; multi-channel scopes
  // use "in0".."inN-1". The registered StandaloneComponent pinLayout uses
  // channelCount=1 at registry time.
  const connections: Array<[string, string]> = [
    ["drv:out", "scope1:clk"],
  ];
  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({ components, connections });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

// ===========================================================================
// Scope — bridge / digital (Cat 9, T1)
// ===========================================================================

describe("Scope — bridge / digital (Cat 9, T1)", () => {
  it("driven_one_recorded_into_channel_buffer_after_step", () => {
    const fix = buildScopeCircuit();
    fix.coordinator.writeByLabel("DRIVE", digital(1));
    fix.coordinator.step();
    const scope = fix.coordinator.compiled.labelToCircuitElement.get(
      "SCOPE",
    ) as ScopeElement | undefined;
    expect(scope).toBeDefined();
    const samples = scope!.getChannels()[0].samples;
    expect(samples.length).toBeGreaterThanOrEqual(1);
    expect(samples[samples.length - 1]).toBe(1);
    fix.coordinator.dispose();
  });

  it("driven_zero_recorded_into_channel_buffer_after_step", () => {
    const fix = buildScopeCircuit();
    fix.coordinator.writeByLabel("DRIVE", digital(0));
    fix.coordinator.step();
    const scope = fix.coordinator.compiled.labelToCircuitElement.get(
      "SCOPE",
    ) as ScopeElement | undefined;
    expect(scope).toBeDefined();
    const samples = scope!.getChannels()[0].samples;
    expect(samples.length).toBeGreaterThanOrEqual(1);
    expect(samples[samples.length - 1]).toBe(0);
    fix.coordinator.dispose();
  });

  it("multiple_steps_append_each_drive_value_to_channel_buffer", () => {
    const fix = buildScopeCircuit();
    const driveSequence = [1, 0, 1, 0, 1];
    for (const v of driveSequence) {
      fix.coordinator.writeByLabel("DRIVE", digital(v));
      fix.coordinator.step();
    }
    const scope = fix.coordinator.compiled.labelToCircuitElement.get(
      "SCOPE",
    ) as ScopeElement | undefined;
    expect(scope).toBeDefined();
    const samples = scope!.getChannels()[0].samples;
    expect(samples.length).toBe(driveSequence.length);
    for (let i = 0; i < driveSequence.length; i++) {
      expect(samples[i]).toBe(driveSequence[i]);
    }
    fix.coordinator.dispose();
  });
});

// ScopeTrigger Cat 9 is BLOCKED — see report Escalations.
