import { describe, it, expect } from "vitest";
import { createDefaultRegistry } from "../../register-all.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { PropertyValue } from "../../../core/properties.js";
import type { SignalValue } from "../../../compile/types.js";

// ---------------------------------------------------------------------------
// ProgramCounter canonical test set
//
// Component: ProgramCounter (memory) - edge-triggered counter with jump/load.
// On each rising clock edge:
//   - if ld=1: counter <- D (jump)
//   - else if en=1: counter <- counter + 1 (mod 2^bitWidth)
// Outputs Q (current counter) and ovf (1 on the edge that wraps through 0).
//
// Canon set: 9 (Bridge / digital interaction), 11 (Multi-output digital
//            observability - Q and ovf are independent observables; on a
//            wrap-step Q transitions to 0 while ovf pulses high, both
//            observed on the same step()).
//
// File tier: fixture-only (T1) - pure-digital component. No analog domain,
// no NR convergence, no junctions, no LTE rollback, no breakpoints, no
// runtime diagnostics, no PropertyBag writeback, no narrow input ports.
// Single entry in modelRegistry (defaultModel only).
//
// Cat 1-8, 10, 12-15 do not apply:
//   - 1/2/3/5/6: no analog state-pool slots / NR loop / matrix.
//   - 4: hot-loadable params on the production side are bitWidth (structural),
//        label (cosmetic), isProgramCounter (debugger flag); none drive a
//        documented post-change simulation observable in the digital domain.
//   - 7/8: no getLteTimestep, no acceptStep with breakpoint registration.
//   - 10: modelRegistry has no named presets (single default entry).
//   - 12: no documented forbidden input combinations (ld+en is documented as
//         "load wins", not forbidden).
//   - 13: D port matches counter bitWidth - no narrower destination port.
//   - 14: no coordinator.emitRuntimeDiagnostic call site.
//   - 15: no _onStateChange writeback subscription.
//
// Construction pattern follows the canonical Cat 9 (Bridge) mechanic from
// the IO and gates canonical sets: facade.build({components, connections})
// + facade.compile + writeByLabel/step/readByLabel. The clock pin C is
// driven by an In labelled "CLK" - same pattern as the canonical Clock
// bridge test in io.test.ts.
// ---------------------------------------------------------------------------

interface PcFixture {
  facade: DefaultSimulatorFacade;
  coordinator: ReturnType<DefaultSimulatorFacade["compile"]>;
  circuit: ReturnType<DefaultSimulatorFacade["build"]>;
}

function digital(value: number): SignalValue {
  return { type: "digital", value };
}

/**
 * Build a ProgramCounter wired with In drivers on every input pin and Out
 * displays on every output pin. ProgramCounter is a multi-pin component so
 * its bare label "PC" is not registered in labelSignalMap (only multi-pin
 * "PC:<pinLabel>" entries are - per src/compile/compile.ts:368-373). The
 * In/Out drivers expose the inputs/outputs through their own bare labels
 * (DRIVE_D / DRIVE_EN / DRIVE_CLK / DRIVE_LD / OBS_Q / OBS_OVF), giving the
 * test a clean writeByLabel/readByLabel surface.
 *
 * Pin defaultBitWidth=1 for every ProgramCounter pin (per the production
 * pin declarations) - so this fixture is built at bitWidth=1 throughout to
 * stay topology-consistent with what the digital compiler accepts.
 * Driving the In components at bitWidth=1 wires them onto the same 1-bit
 * net the ProgramCounter pin declares.
 */
function buildPcFixture(): PcFixture {
  const components: Array<{ id: string; type: string; props: Record<string, PropertyValue> }> = [
    { id: "inD",    type: "In",  props: { label: "DRIVE_D",   bitWidth: 1 } },
    { id: "inEN",   type: "In",  props: { label: "DRIVE_EN",  bitWidth: 1 } },
    { id: "inCLK",  type: "In",  props: { label: "DRIVE_CLK", bitWidth: 1 } },
    { id: "inLD",   type: "In",  props: { label: "DRIVE_LD",  bitWidth: 1 } },
    { id: "pc1",    type: "ProgramCounter", props: { label: "PC", bitWidth: 1 } },
    { id: "outQ",   type: "Out", props: { label: "OBS_Q",   bitWidth: 1 } },
    { id: "outOVF", type: "Out", props: { label: "OBS_OVF", bitWidth: 1 } },
  ];
  const connections: Array<[string, string]> = [
    ["inD:out",   "pc1:D"],
    ["inEN:out",  "pc1:en"],
    ["inCLK:out", "pc1:C"],
    ["inLD:out",  "pc1:ld"],
    ["pc1:Q",     "outQ:in"],
    ["pc1:ovf",   "outOVF:in"],
  ];

  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({ components, connections });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator, circuit };
}

/**
 * Apply one full clock cycle: drive CLK low, step, drive CLK high, step.
 * The rising-edge transition is what executeProgramCounter latches.
 */
function clockCycle(fix: PcFixture): void {
  fix.coordinator.writeByLabel("DRIVE_CLK", digital(0));
  fix.coordinator.step();
  fix.coordinator.writeByLabel("DRIVE_CLK", digital(1));
  fix.coordinator.step();
}

// ===========================================================================
// Cat 9  Bridge / digital interaction
// ===========================================================================


describe("ProgramCounter  bridge / digital (T1)", () => {
  it("first_rising_edge_advances_counter_when_enabled", () => {
    // Cat 9: documented edge-triggered increment. With en=1, ld=0, the
    // rising edge of CLK moves the internal counter from 0 to 1 and Q
    // observes 1 on the wired Out display. Falling-edge step does not
    // advance.
    const fix = buildPcFixture();
    fix.coordinator.writeByLabel("DRIVE_D", digital(0));
    fix.coordinator.writeByLabel("DRIVE_EN", digital(1));
    fix.coordinator.writeByLabel("DRIVE_LD", digital(0));

    // Initial state - CLK=0, no edge yet, Q = 0.
    fix.coordinator.writeByLabel("DRIVE_CLK", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OBS_Q")).toMatchObject({ type: "digital", value: 0 });

    // Rising edge: counter -> 1, Q -> 1.
    fix.coordinator.writeByLabel("DRIVE_CLK", digital(1));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OBS_Q")).toMatchObject({ type: "digital", value: 1 });

    // Falling edge: counter unchanged, Q stays 1.
    fix.coordinator.writeByLabel("DRIVE_CLK", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OBS_Q")).toMatchObject({ type: "digital", value: 1 });

    fix.coordinator.dispose();
  });

  it("load_high_latches_d_on_rising_edge", () => {
    // Cat 9: ld=1 latches D into the counter on the rising edge regardless
    // of the prior counter value. With D=1 and en=0, ld=1, after one rising
    // edge Q reads 1.
    const fix = buildPcFixture();
    fix.coordinator.writeByLabel("DRIVE_D", digital(1));
    fix.coordinator.writeByLabel("DRIVE_EN", digital(0));
    fix.coordinator.writeByLabel("DRIVE_LD", digital(1));

    clockCycle(fix);

    expect(fix.coordinator.readByLabel("OBS_Q")).toMatchObject({ type: "digital", value: 1 });

    fix.coordinator.dispose();
  });

  it("load_takes_priority_over_enable", () => {
    // Cat 9: documented priority - when ld=1 and en=1 are simultaneously
    // asserted, load wins. With D=1 the loaded value (1) drives Q, not the
    // increment-from-0 path which would also produce 1 on the first edge -
    // so disambiguate by loading D=0 with en=1: load wins, counter becomes
    // 0 (from D), not 1 (from increment).
    const fix = buildPcFixture();
    fix.coordinator.writeByLabel("DRIVE_D", digital(0));
    fix.coordinator.writeByLabel("DRIVE_EN", digital(1));
    fix.coordinator.writeByLabel("DRIVE_LD", digital(1));

    clockCycle(fix);

    expect(fix.coordinator.readByLabel("OBS_Q")).toMatchObject({ type: "digital", value: 0 });

    // Disable load and enable increment - next rising edge advances from 0
    // to 1 (proves the prior cycle did NOT increment 0->1; it loaded 0).
    fix.coordinator.writeByLabel("DRIVE_LD", digital(0));
    clockCycle(fix);
    expect(fix.coordinator.readByLabel("OBS_Q")).toMatchObject({ type: "digital", value: 1 });

    fix.coordinator.dispose();
  });

  it("disabled_counter_holds_value_across_clock_edges", () => {
    // Cat 9: with en=0 and ld=0, rising edges produce no state change.
    // Increment once to seed counter=1, then disable - subsequent rising
    // edges leave Q at 1.
    const fix = buildPcFixture();
    fix.coordinator.writeByLabel("DRIVE_D", digital(0));
    fix.coordinator.writeByLabel("DRIVE_EN", digital(1));
    fix.coordinator.writeByLabel("DRIVE_LD", digital(0));

    clockCycle(fix);
    expect(fix.coordinator.readByLabel("OBS_Q")).toMatchObject({ type: "digital", value: 1 });

    // Disable. Subsequent rising edges must not change Q.
    fix.coordinator.writeByLabel("DRIVE_EN", digital(0));
    clockCycle(fix);
    expect(fix.coordinator.readByLabel("OBS_Q")).toMatchObject({ type: "digital", value: 1 });
    clockCycle(fix);
    expect(fix.coordinator.readByLabel("OBS_Q")).toMatchObject({ type: "digital", value: 1 });

    fix.coordinator.dispose();
  });

  it("clock_held_high_does_not_re_trigger_increment", () => {
    // Cat 9: edge detection - holding CLK high across multiple step() calls
    // produces only one increment (the initial 0->1 rising edge). Subsequent
    // step()s with CLK still high observe Q frozen at 1.
    const fix = buildPcFixture();
    fix.coordinator.writeByLabel("DRIVE_D", digital(0));
    fix.coordinator.writeByLabel("DRIVE_EN", digital(1));
    fix.coordinator.writeByLabel("DRIVE_LD", digital(0));

    // First rising edge.
    clockCycle(fix);
    expect(fix.coordinator.readByLabel("OBS_Q")).toMatchObject({ type: "digital", value: 1 });

    // Hold CLK high - no new rising edge possible.
    fix.coordinator.writeByLabel("DRIVE_CLK", digital(1));
    fix.coordinator.step();
    fix.coordinator.step();
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OBS_Q")).toMatchObject({ type: "digital", value: 1 });

    fix.coordinator.dispose();
  });

  it("jump_then_increment_continues_from_loaded_value", () => {
    // Cat 9: documented sequence used by CPU PC - branch-then-fetch. Load
    // D=1 (jump target), then switch to increment - the next rising edge
    // advances the counter from the loaded value by one, modulo 2^bitWidth,
    // and Q observes that advanced value on the same step. At bitWidth=1 the
    // increment of the loaded value 1 wraps: (1 + 1) & 0b1 = 0.
    const fix = buildPcFixture();
    fix.coordinator.writeByLabel("DRIVE_D", digital(1));
    fix.coordinator.writeByLabel("DRIVE_EN", digital(0));
    fix.coordinator.writeByLabel("DRIVE_LD", digital(1));

    clockCycle(fix);
    expect(fix.coordinator.readByLabel("OBS_Q")).toMatchObject({ type: "digital", value: 1 });

    // Switch to increment mode. Counter advances from the loaded 1 by one,
    // wrapping at the 1-bit width: (1 + 1) & 0b1 = 0.
    fix.coordinator.writeByLabel("DRIVE_LD", digital(0));
    fix.coordinator.writeByLabel("DRIVE_EN", digital(1));

    clockCycle(fix);
    expect(fix.coordinator.readByLabel("OBS_Q")).toMatchObject({ type: "digital", value: 0 });

    fix.coordinator.dispose();
  });
});

// ===========================================================================
// Cat 11  Multi-output digital observability
//
// ProgramCounter declares two outputs in its digital schema:
//   Q   - bitWidth-wide counter value
//   ovf - 1-bit overflow pulse (high on the edge that wraps the counter
//         through zero)
//
// Q and ovf are observed independently after the same step(). Q reads the
// post-edge counter; ovf reads 1 on a wrap edge and 0 on every other edge.
// The Cat 11 mechanic is "wire one labelled Out per output pin, assert each
// independently after a single coordinator.step()".
// ===========================================================================

describe("ProgramCounter  multi-output digital observability (T1)", () => {
  it("non_overflow_increment_drives_q_high_and_ovf_low_independently", () => {
    // Cat 11: on a non-wrap rising edge, Q advances by 1 and ovf reads 0
    // simultaneously. Both pins are observed after the same step() through
    // separate Out displays (OBS_Q vs OBS_OVF), confirming the two outputs
    // are independent observables on the same step.
    const fix = buildPcFixture();
    fix.coordinator.writeByLabel("DRIVE_D", digital(0));
    fix.coordinator.writeByLabel("DRIVE_EN", digital(1));
    fix.coordinator.writeByLabel("DRIVE_LD", digital(0));

    clockCycle(fix);

    expect(fix.coordinator.readByLabel("OBS_Q")).toMatchObject({ type: "digital", value: 1 });
    expect(fix.coordinator.readByLabel("OBS_OVF")).toMatchObject({ type: "digital", value: 0 });

    fix.coordinator.dispose();
  });

  it("load_edge_drives_q_to_loaded_value_and_ovf_low_independently", () => {
    // Cat 11: a load-edge produces a documented Q value AND ovf=0 on the
    // same step. The ovf pin is gated on the increment branch only, so a
    // load-edge - even one that lands the counter at 0 from a non-zero
    // prior value - must report ovf=0. Both pins observed independently.
    const fix = buildPcFixture();
    fix.coordinator.writeByLabel("DRIVE_D", digital(1));
    fix.coordinator.writeByLabel("DRIVE_EN", digital(0));
    fix.coordinator.writeByLabel("DRIVE_LD", digital(1));

    clockCycle(fix);
    expect(fix.coordinator.readByLabel("OBS_Q")).toMatchObject({ type: "digital", value: 1 });
    expect(fix.coordinator.readByLabel("OBS_OVF")).toMatchObject({ type: "digital", value: 0 });

    // Now load D=0 - Q drops to 0 while ovf stays 0 (the load branch never
    // pulses ovf even when the loaded value is zero). Q and ovf observed
    // independently after the same step.
    fix.coordinator.writeByLabel("DRIVE_D", digital(0));
    clockCycle(fix);
    expect(fix.coordinator.readByLabel("OBS_Q")).toMatchObject({ type: "digital", value: 0 });
    expect(fix.coordinator.readByLabel("OBS_OVF")).toMatchObject({ type: "digital", value: 0 });

    fix.coordinator.dispose();
  });

  it("disabled_edge_drives_q_held_and_ovf_low_independently", () => {
    // Cat 11: with en=0 and ld=0, the rising edge is a no-op for the
    // counter - Q holds its prior value and ovf reads 0. Both observables
    // are visible on the same step through their independent Out displays.
    const fix = buildPcFixture();
    fix.coordinator.writeByLabel("DRIVE_D", digital(1));
    fix.coordinator.writeByLabel("DRIVE_EN", digital(1));
    fix.coordinator.writeByLabel("DRIVE_LD", digital(0));

    // Seed counter to 1 via one increment edge.
    clockCycle(fix);
    expect(fix.coordinator.readByLabel("OBS_Q")).toMatchObject({ type: "digital", value: 1 });
    expect(fix.coordinator.readByLabel("OBS_OVF")).toMatchObject({ type: "digital", value: 0 });

    // Disable - next edge holds Q=1 AND keeps ovf=0. Q and ovf are
    // independently observable on the same step().
    fix.coordinator.writeByLabel("DRIVE_EN", digital(0));
    clockCycle(fix);
    expect(fix.coordinator.readByLabel("OBS_Q")).toMatchObject({ type: "digital", value: 1 });
    expect(fix.coordinator.readByLabel("OBS_OVF")).toMatchObject({ type: "digital", value: 0 });

    fix.coordinator.dispose();
  });
});
