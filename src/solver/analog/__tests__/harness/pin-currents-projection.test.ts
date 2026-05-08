/**
 * Verifies the DeviceMapping.pinCurrents projection end-to-end through the
 * comparison harness: capture (our side + ngspice via self-compare),
 * pairing into StepEndComponentEntry.pinCurrents, and the values that come
 * out the other side.
 *
 * Self-compare runs both sides through our engine, so cross-engine values
 * are identical by construction; what this exercises is that the
 * projection produces the expected pin-name keys and finite values, and
 * KCL closes per device.
 */

import { describe, it, expect } from "vitest";
import { ComparisonSession } from "./comparison-session.js";
import { DefaultSimulatorFacade } from "../../../../headless/default-facade.js";
import type { ComponentRegistry } from "../../../../core/registry.js";
import type { Circuit } from "../../../../core/circuit.js";

const KCL_TOL = 1e-9;

describe("pinCurrents projection (self-compare)", () => {
  it("capacitor exposes pos/neg with KCL closure and matching ours/ngspice", async () => {
    // V1 — R1 — C1 — gnd.  At DCOP, I_cap == 0, so pos = +0, neg = -0.
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry: ComponentRegistry): Circuit => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "v1", type: "DcVoltageSource", props: { label: "V1", voltage: 1 } },
            { id: "r1", type: "Resistor",        props: { label: "R1", resistance: 1000 } },
            { id: "c1", type: "Capacitor",       props: { label: "C1", capacitance: 1e-6 } },
            { id: "gnd", type: "Ground" },
          ],
          connections: [
            ["v1:pos", "r1:pos"],
            ["r1:neg", "c1:pos"],
            ["c1:neg", "gnd:out"],
            ["v1:neg", "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    const cap = stepEnd.components["C1"];
    expect(cap, `step-end components keys: ${Object.keys(stepEnd.components).join(",")}`).toBeDefined();
    expect(cap.deviceType).toBe("capacitor");

    expect(Object.keys(cap.pinCurrents).sort()).toEqual(["neg", "pos"]);
    const pos = cap.pinCurrents["pos"];
    const neg = cap.pinCurrents["neg"];
    expect(Number.isFinite(pos.ours!)).toBe(true);
    expect(Number.isFinite(neg.ours!)).toBe(true);
    expect(Math.abs(pos.ours! + neg.ours!)).toBeLessThan(KCL_TOL);
    // Self-compare: ours === ngspice exactly.
    expect(pos.ours).toBe(pos.ngspice);
    expect(neg.ours).toBe(neg.ngspice);
    expect(pos.withinTol).toBe(true);
    expect(neg.withinTol).toBe(true);
  });

  it("diode exposes A/K with KCL closure", async () => {
    // V1=1V — R1=1k — D1 — gnd.  Forward-biased; I_D ~ 0.3-0.5 mA range.
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry: ComponentRegistry): Circuit => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "v1", type: "DcVoltageSource", props: { label: "V1", voltage: 1 } },
            { id: "r1", type: "Resistor",        props: { label: "R1", resistance: 1000 } },
            { id: "d1", type: "Diode",           props: { label: "D1" } },
            { id: "gnd", type: "Ground" },
          ],
          connections: [
            ["v1:pos", "r1:pos"],
            ["r1:neg", "d1:A"],
            ["d1:K",   "gnd:out"],
            ["v1:neg", "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    const d = stepEnd.components["D1"];
    expect(d, `step-end components keys: ${Object.keys(stepEnd.components).join(",")}`).toBeDefined();
    expect(d.deviceType).toBe("diode");

    expect(Object.keys(d.pinCurrents).sort()).toEqual(["A", "K"]);
    const a = d.pinCurrents["A"];
    const k = d.pinCurrents["K"];
    expect(Number.isFinite(a.ours!)).toBe(true);
    expect(Number.isFinite(k.ours!)).toBe(true);
    // Forward-biased diode: anode current is positive (current flowing into anode).
    expect(a.ours!).toBeGreaterThan(0);
    expect(Math.abs(a.ours! + k.ours!)).toBeLessThan(KCL_TOL);
    expect(a.withinTol).toBe(true);
    expect(k.withinTol).toBe(true);
  });

  it("BJT exposes B/C/E with KCL closure", async () => {
    // Common-emitter NPN with VCC, base resistor, collector resistor.
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry: ComponentRegistry): Circuit => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vcc", type: "DcVoltageSource", props: { label: "VCC", voltage: 5 } },
            { id: "vb",  type: "DcVoltageSource", props: { label: "VB",  voltage: 1 } },
            { id: "rb",  type: "Resistor",        props: { label: "RB",  resistance: 100_000 } },
            { id: "rc",  type: "Resistor",        props: { label: "RC",  resistance: 1000 } },
            { id: "q1",  type: "NpnBJT",          props: { label: "Q1" } },
            { id: "gnd", type: "Ground" },
          ],
          connections: [
            ["vcc:pos", "rc:pos"],
            ["rc:neg",  "q1:C"],
            ["vb:pos",  "rb:pos"],
            ["rb:neg",  "q1:B"],
            ["q1:E",    "gnd:out"],
            ["vcc:neg", "gnd:out"],
            ["vb:neg",  "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    const q = stepEnd.components["Q1"];
    expect(q, `step-end components keys: ${Object.keys(stepEnd.components).join(",")}`).toBeDefined();
    expect(q.deviceType).toBe("bjt");

    expect(Object.keys(q.pinCurrents).sort()).toEqual(["B", "C", "E"]);
    const ib = q.pinCurrents["B"].ours!;
    const ic = q.pinCurrents["C"].ours!;
    const ie = q.pinCurrents["E"].ours!;
    expect(Number.isFinite(ib)).toBe(true);
    expect(Number.isFinite(ic)).toBe(true);
    expect(Number.isFinite(ie)).toBe(true);
    // Forward-active: Ic > 0, Ib > 0, Ie < 0 (currents flow into B/C, out of E).
    expect(ic).toBeGreaterThan(0);
    expect(ib).toBeGreaterThan(0);
    expect(ie).toBeLessThan(0);
    // KCL: Ic + Ib + Ie == 0 (by projection construction).
    expect(Math.abs(ic + ib + ie)).toBeLessThan(KCL_TOL);
    expect(q.pinCurrents["B"].withinTol).toBe(true);
    expect(q.pinCurrents["C"].withinTol).toBe(true);
    expect(q.pinCurrents["E"].withinTol).toBe(true);
  });

  it("MOSFET pinCurrents is empty (intentional, instance-field bridge not wired)", async () => {
    // Diode-connected NMOS to keep DCOP trivial.
    const session = await ComparisonSession.createSelfCompare({
      buildCircuit: (registry: ComponentRegistry): Circuit => {
        const facade = new DefaultSimulatorFacade(registry);
        return facade.build({
          components: [
            { id: "vdd", type: "DcVoltageSource", props: { label: "VDD", voltage: 3 } },
            { id: "rd",  type: "Resistor",        props: { label: "RD",  resistance: 10_000 } },
            { id: "m1",  type: "NMOS",            props: { label: "M1" } },
            { id: "gnd", type: "Ground" },
          ],
          connections: [
            ["vdd:pos", "rd:pos"],
            ["rd:neg",  "m1:D"],
            ["m1:D",    "m1:G"],
            ["m1:S",    "gnd:out"],
            ["vdd:neg", "gnd:out"],
          ],
        });
      },
      analysis: "dcop",
    });

    const stepEnd = session.getStepEnd(0);
    const m = stepEnd.components["M1"];
    expect(m).toBeDefined();
    expect(m.deviceType).toBe("mosfet");
    // No projection in DEVICE_MAPPINGS for mosfet — empty record by design.
    expect(Object.keys(m.pinCurrents)).toEqual([]);
  });
});
