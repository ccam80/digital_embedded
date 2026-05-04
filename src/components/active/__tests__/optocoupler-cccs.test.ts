/**
 * Regression test for the Optocoupler's InternalCccs photocurrent coupling.
 *
 * The Optocoupler netlist (`OPTOCOUPLER_NETLIST` in `optocoupler.ts`) emits an
 * InternalCccs sub-element with `params: { gain: "ctr",
 * sense: { kind: "siblingBranch", subElementName: "vSense" } }`. The compiler's
 * siblingBranch resolver writes `${labelRef.value}:${subElementName}` into the
 * leaf's prop bag; pre-Wave-10 that resolution happened at sub-element
 * construction time, when `labelRef.value` was still the empty string. The
 * leaf cached the stale `:vSense` string and `findBranch` returned 0,
 * silently zeroing the photocurrent coupling.
 *
 * This test wires up the canonical opto bench (LED driven by a current
 * source, phototransistor base loaded by a collector resistor) and verifies
 * that collector current actually flows. With CTR=1.0 the architectural
 * contract is `I_C ≈ I_LED`; we assert collector-side activity (V across
 * the collector resistor) that is impossible if the InternalCccs gain is
 * effectively zero.
 */

import { describe, it, expect } from "vitest";
import { buildFixture, type Fixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

function nodeOf(fix: Fixture, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

/**
 * Optocoupler bench:
 *
 *   vLed(+) ─ rLed ─ tx:anode      tx:cathode ─ GND
 *   vCC (+) ─ rCol ─ tx:collector  tx:emitter ─ GND
 *
 * The LED is forward-biased by vLed (5V) through rLed (1kΩ). The
 * phototransistor's collector is pulled up to vCC (5V) through rCol (1kΩ).
 * With CTR=1.0 the collector current mirrors the LED current; the collector
 * node V drops below vCC by approximately I_C * rCol = I_LED * rCol.
 */
function buildOptocouplerBench(facade: DefaultSimulatorFacade): Circuit {
  return facade.build({
    components: [
      { id: "vLed", type: "DcVoltageSource", props: { label: "vLed", voltage: 5.0 } },
      { id: "rLed", type: "Resistor",       props: { label: "rLed", resistance: 1000 } },
      { id: "vCC",  type: "DcVoltageSource", props: { label: "vCC",  voltage: 5.0 } },
      { id: "rCol", type: "Resistor",       props: { label: "rCol", resistance: 1000 } },
      { id: "tx",   type: "Optocoupler",    props: { label: "tx" } },
      { id: "gnd",  type: "Ground" },
    ],
    connections: [
      ["vLed:pos",  "rLed:pos"],
      ["rLed:neg",  "tx:anode"],
      ["tx:cathode","gnd:out"],
      ["vLed:neg",  "gnd:out"],
      ["vCC:pos",   "rCol:pos"],
      ["rCol:neg",  "tx:collector"],
      ["tx:emitter","gnd:out"],
      ["vCC:neg",   "gnd:out"],
    ],
  });
}

describe("Optocoupler InternalCccs siblingBranch coupling", () => {
  it("photocurrent_flows_through_phototransistor_collector", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildOptocouplerBench(facade),
    });
    const dc = fix.coordinator.dcOperatingPoint()!;
    expect(dc.converged).toBe(true);

    // LED forward drop ~0.7V at 1kΩ series ⇒ I_LED ≈ (5 - 0.7) / 1000 ≈ 4.3 mA.
    const vAnode = fix.engine.getNodeVoltage(nodeOf(fix, "tx:anode"));
    const iLed = (5.0 - vAnode) / 1000;
    expect(iLed).toBeGreaterThan(1e-3); // LED is forward-biased

    // Collector node sits below the +5V rail by I_C * rCol. With CTR=1.0
    // the architectural prediction is V_drop ≈ iLed * 1000 ≈ 4.3 V, leaving
    // V(collector) at ~0.7V. The pre-Wave-10 bug zeroed the CCCS gain,
    // which would leave the collector floating at +5V (no current flows).
    const vCollector = fix.engine.getNodeVoltage(nodeOf(fix, "tx:collector"));
    const iCollector = (5.0 - vCollector) / 1000;

    // Collector current must be measurable — i.e. the InternalCccs sense
    // branch resolved correctly and the photocurrent coupling fires.
    expect(iCollector).toBeGreaterThan(1e-4);

    // CTR=1.0 ⇒ I_C tracks I_LED. We use a wide band (0.1× to 10×) because
    // the phototransistor's BJT model adds its own beta-dependent dynamics
    // on top of the CCCS injection — the strict assertion is that the
    // coupling is ON, not that it's exactly unity.
    expect(iCollector / iLed).toBeGreaterThan(0.1);
    expect(iCollector / iLed).toBeLessThan(10.0);
  });
});
