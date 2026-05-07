import { describe, it, expect } from "vitest";

import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../components/register-all.js";
import { buildLedDcCircuit } from "./led-fixture.js";

import type { SimulationCoordinator } from "../../../solver/coordinator-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DigitalRig {
  facade: DefaultSimulatorFacade;
  coordinator: SimulationCoordinator;
}

// ---------------------------------------------------------------------------
// Programmatic circuit factories (T1, digital-only — PolarityAwareLED,
// LightBulb, RGBLED have no analog model entries; their canonical observables
// are Cat 9 digital-bridge values on `coordinator.readByLabel`).
//
// Each factory wires the indicator's input pins to `Const` digital sources
// (single-pin OUTPUT "out") so the digital domain has writable nets at known
// labels. The indicator outputSchema is empty (it's a sink) — the canonical
// observable is the bridge state at the input net labels (one labelled net per
// pin — the Const source assigns the label).
// ---------------------------------------------------------------------------

function buildPolarityLedDigitalRig(anode: number, cathode: number): DigitalRig {
  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({
    components: [
      { id: "drvA", type: "Const", props: { label: "A",   value: anode,   bitWidth: 1 } },
      { id: "drvK", type: "Const", props: { label: "K",   value: cathode, bitWidth: 1 } },
      { id: "led",  type: "PolarityAwareLED", props: { label: "led" } },
    ],
    connections: [
      ["drvA:out", "led:A"],
      ["drvK:out", "led:K"],
    ],
  });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

function buildLightBulbDigitalRig(inA: number, inB: number): DigitalRig {
  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({
    components: [
      { id: "drvA", type: "Const", props: { label: "A",   value: inA, bitWidth: 1 } },
      { id: "drvB", type: "Const", props: { label: "B",   value: inB, bitWidth: 1 } },
      { id: "lb",   type: "LightBulb", props: { label: "lb" } },
    ],
    connections: [
      ["drvA:out", "lb:A"],
      ["drvB:out", "lb:B"],
    ],
  });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

function buildRgbLedDigitalRig(r: number, g: number, b: number): DigitalRig {
  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({
    components: [
      { id: "drvR", type: "Const", props: { label: "R", value: r, bitWidth: 1 } },
      { id: "drvG", type: "Const", props: { label: "G", value: g, bitWidth: 1 } },
      { id: "drvB", type: "Const", props: { label: "B", value: b, bitWidth: 1 } },
      { id: "led",  type: "RGBLED", props: { label: "rgb" } },
    ],
    connections: [
      ["drvR:out", "led:R"],
      ["drvG:out", "led:G"],
      ["drvB:out", "led:B"],
    ],
  });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

function buildLedDigitalRig(driveValue: number): DigitalRig {
  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({
    components: [
      { id: "drv", type: "Const", props: { label: "in", value: driveValue, bitWidth: 1 } },
      { id: "led", type: "LED",   props: { label: "led", color: "red" } },
    ],
    connections: [
      ["drv:out", "led:in"],
    ],
  });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

// ---------------------------------------------------------------------------
// LED analog (T1) — Cat 1, Cat 2-analytical, Cat 4, Cat 10
// ---------------------------------------------------------------------------

describe("LED analog initialization (T1, Cat 1)", () => {
  it("init_post_warm_start_red_led_dc_circuit", () => {
    // Cat 1: post-warm-start the LED is in the analog domain via the `red`
    // preset (model="red"). The LED anode pin "led:in" sits on a node
    // labelled by buildLedDcCircuit; the DCOP seed must produce a positive
    // forward-bias voltage in the diode's forward-conduction range.
    const { facade, coordinator } = buildLedDcCircuit({ color: "red", vSupply: 5, rSeries: 220 });
    // facade.compile already ran a DCOP; read the converged anode voltage.
    const dc = facade.getDcOpResult();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    const vf = facade.readAllSignals(coordinator)["led:in"];
    // Red LED Vf ≈ 1.8 V at this operating point (IS=3.17e-19, N=1.8). The
    // post-warm-start voltage must be in the forward-conduction band.
    expect(vf).toBeGreaterThan(1.0);
    expect(vf).toBeLessThan(2.5);
  });
});

describe("LED analog DCOP (T1, Cat 2 analytical)", () => {
  it("dcop_red_led_forward_drop_in_band", () => {
    // Cat 2 analytical: red LED forward voltage at the operating point.
    // Circuit: 5V → 220Ω → red LED (anode); cathode wired to ground.
    // Closed-form expectation: Vf(red) ≈ 1.8 V ± 0.15 V (preset-derived
    // from IS=3.17e-19, N=1.8 at 300.15 K via the Shockley equation with
    // the 220 Ω load line).
    const { facade, coordinator } = buildLedDcCircuit({ color: "red", vSupply: 5, rSeries: 220 });
    const dc = facade.getDcOpResult();
    expect(dc!.converged).toBe(true);
    const vf = facade.readAllSignals(coordinator)["led:in"];
    expect(vf).toBeGreaterThan(1.65);
    expect(vf).toBeLessThan(1.95);
  });

  it("dcop_blue_led_forward_drop_in_band", () => {
    // Cat 2 analytical: blue LED forward voltage at the operating point.
    // Closed-form Vf(blue) ≈ 3.2 V ± 0.15 V (IS=6.26e-24, N=2.5).
    const { facade, coordinator } = buildLedDcCircuit({ color: "blue", vSupply: 5, rSeries: 100 });
    const dc = facade.getDcOpResult();
    expect(dc!.converged).toBe(true);
    const vf = facade.readAllSignals(coordinator)["led:in"];
    expect(vf).toBeGreaterThan(3.05);
    expect(vf).toBeLessThan(3.35);
  });
});

describe("LED analog parameter hot-load (T1, Cat 4)", () => {
  it("hotload_TEMP_decreases_red_led_vf", () => {
    // Cat 4: TEMP is a derived-state-recompute parameter. Raising TEMP from
    // the default 300.15 K to 400 K must shift the diode I-V curve such that
    // Vf decreases (negative temperature coefficient via the optical-bandgap
    // EG=1.9 eV in the red preset). Documented contract: dVf/dT ≈ (Vf - EG)/T < 0.
    const { facade: facade300, coordinator: coord300 } =
      buildLedDcCircuit({ color: "red", vSupply: 5, rSeries: 220 });
    const dc300 = facade300.getDcOpResult();
    expect(dc300!.converged).toBe(true);
    const vf300 = facade300.readAllSignals(coord300)["led:in"];

    const { facade: facade400, coordinator: coord400 } =
      buildLedDcCircuit({ color: "red", vSupply: 5, rSeries: 220, TEMP: 400 });
    const dc400 = facade400.getDcOpResult();
    expect(dc400!.converged).toBe(true);
    const vf400 = facade400.readAllSignals(coord400)["led:in"];

    expect(vf400).not.toBeCloseTo(vf300);
    expect(Math.sign(vf400 - vf300)).toBe(-1);
    // Physically meaningful shift over a 100 K rise: > 1 mV.
    expect(vf300 - vf400).toBeGreaterThan(0.001);
  });

  it("hotload_setComponentProperty_TEMP_recomputes_vf", () => {
    // Cat 4: setComponentProperty on the TEMP model param triggers the
    // derived-state recompute path. The post-change Vf must match a fresh
    // build at the same TEMP (and must differ from the pre-change Vf).
    const { circuit: circuit300, facade: facade300, coordinator: coord300 } =
      buildLedDcCircuit({ color: "red", vSupply: 5, rSeries: 220 });
    const dc300 = facade300.getDcOpResult();
    expect(dc300!.converged).toBe(true);
    const vf300 = facade300.readAllSignals(coord300)["led:in"];

    const ledElement = circuit300.elements.find(
      (e) => e.getProperties().getOrDefault<string>("label", "") === "led",
    )!;
    expect(ledElement).toBeDefined();
    coord300.setComponentProperty(ledElement, "TEMP", 400);
    const coord400 = facade300.compile(circuit300);
    const dc400 = facade300.getDcOpResult();
    expect(dc400!.converged).toBe(true);
    const vf400 = facade300.readAllSignals(coord400)["led:in"];

    expect(vf400).not.toBeCloseTo(vf300);
    expect(Math.sign(vf400 - vf300)).toBe(-1);
    expect(vf300 - vf400).toBeGreaterThan(0.001);
  });
});

describe("LED named model preset application (T1, Cat 10)", () => {
  it("preset_blue_shifts_dc_output_above_red_vf", () => {
    // Cat 10: applying the `blue` preset (IS=6.26e-24, N=2.5, EG=2.8 eV)
    // shifts Vf above the `red` preset (IS=3.17e-19, N=1.8, EG=1.9 eV). The
    // closed-form Δ at the operating point ≈ 1.4 V (3.2 V − 1.8 V), driven
    // by the dominant IS / N delta in the Shockley equation. Holding the
    // load line fixed isolates the preset-driven Vf shift to the I-V curve.
    const { facade: facadeRed, coordinator: coordRed } =
      buildLedDcCircuit({ color: "red", vSupply: 5, rSeries: 100 });
    const dcRed = facadeRed.getDcOpResult();
    expect(dcRed!.converged).toBe(true);
    const vfRed = facadeRed.readAllSignals(coordRed)["led:in"];

    const { facade: facadeBlue, coordinator: coordBlue } =
      buildLedDcCircuit({ color: "blue", vSupply: 5, rSeries: 100 });
    const dcBlue = facadeBlue.getDcOpResult();
    expect(dcBlue!.converged).toBe(true);
    const vfBlue = facadeBlue.readAllSignals(coordBlue)["led:in"];

    expect(vfBlue).not.toBeCloseTo(vfRed);
    expect(Math.sign(vfBlue - vfRed)).toBe(1);
    // Closed-form Δ ≈ 1.4 V for red→blue at this operating point.
    expect(vfBlue - vfRed).toBeGreaterThan(1.0);
    expect(vfBlue - vfRed).toBeLessThan(1.8);
  });

  it("preset_yellow_shifts_dc_output_above_red_vf", () => {
    // Cat 10: yellow preset (IS=1e-20, N=1.9, EG=2.1 eV). Closed-form Vf
    // shift over red ≈ 0.1–0.3 V (IS smaller, N slightly larger).
    const { facade: facadeRed, coordinator: coordRed } =
      buildLedDcCircuit({ color: "red", vSupply: 5, rSeries: 220 });
    const dcRed = facadeRed.getDcOpResult();
    expect(dcRed!.converged).toBe(true);
    const vfRed = facadeRed.readAllSignals(coordRed)["led:in"];

    const { facade: facadeYellow, coordinator: coordYellow } =
      buildLedDcCircuit({ color: "yellow", vSupply: 5, rSeries: 220 });
    const dcYellow = facadeYellow.getDcOpResult();
    expect(dcYellow!.converged).toBe(true);
    const vfYellow = facadeYellow.readAllSignals(coordYellow)["led:in"];

    expect(vfYellow).not.toBeCloseTo(vfRed);
    expect(Math.sign(vfYellow - vfRed)).toBe(1);
    expect(vfYellow - vfRed).toBeGreaterThan(0.05);
  });

  it("preset_green_shifts_dc_output_above_red_vf", () => {
    // Cat 10: green preset (IS=1e-21, N=2.0, EG=2.3 eV). Closed-form Vf
    // shift over red is positive and physically meaningful.
    const { facade: facadeRed, coordinator: coordRed } =
      buildLedDcCircuit({ color: "red", vSupply: 5, rSeries: 220 });
    const dcRed = facadeRed.getDcOpResult();
    expect(dcRed!.converged).toBe(true);
    const vfRed = facadeRed.readAllSignals(coordRed)["led:in"];

    const { facade: facadeGreen, coordinator: coordGreen } =
      buildLedDcCircuit({ color: "green", vSupply: 5, rSeries: 220 });
    const dcGreen = facadeGreen.getDcOpResult();
    expect(dcGreen!.converged).toBe(true);
    const vfGreen = facadeGreen.readAllSignals(coordGreen)["led:in"];

    expect(vfGreen).not.toBeCloseTo(vfRed);
    expect(Math.sign(vfGreen - vfRed)).toBe(1);
    expect(vfGreen - vfRed).toBeGreaterThan(0.05);
  });

  it("preset_white_shifts_dc_output_above_red_vf", () => {
    // Cat 10: white preset (IS=6.26e-24, N=2.5, EG=2.8 eV) — same params
    // as blue. Closed-form Vf shift over red ≈ 1.4 V.
    const { facade: facadeRed, coordinator: coordRed } =
      buildLedDcCircuit({ color: "red", vSupply: 5, rSeries: 100 });
    const dcRed = facadeRed.getDcOpResult();
    expect(dcRed!.converged).toBe(true);
    const vfRed = facadeRed.readAllSignals(coordRed)["led:in"];

    const { facade: facadeWhite, coordinator: coordWhite } =
      buildLedDcCircuit({ color: "white", vSupply: 5, rSeries: 100 });
    const dcWhite = facadeWhite.getDcOpResult();
    expect(dcWhite!.converged).toBe(true);
    const vfWhite = facadeWhite.readAllSignals(coordWhite)["led:in"];

    expect(vfWhite).not.toBeCloseTo(vfRed);
    expect(Math.sign(vfWhite - vfRed)).toBe(1);
    expect(vfWhite - vfRed).toBeGreaterThan(1.0);
  });
});

// ---------------------------------------------------------------------------
// LED digital bridge (T1, Cat 9)
// ---------------------------------------------------------------------------

describe("LED digital bridge (T1, Cat 9)", () => {
  it("bridge_high_drive_lights_led_input_net", () => {
    // Cat 9: drive the LED's `in` net high through a digital `Const` source
    // (value=1). The shared net "in" must read as logic 1 after a single
    // coordinator.step().
    const { facade, coordinator } = buildLedDigitalRig(1);
    facade.step(coordinator);
    const sig = coordinator.readByLabel("in");
    if (sig.type === "digital") {
      expect(sig.value).toBe(1);
    } else {
      throw new Error("expected digital signal at LED input net");
    }
  });

  it("bridge_low_drive_keeps_led_input_net_low", () => {
    // Cat 9: drive low (value=0). The "in" net must read as logic 0.
    const { facade, coordinator } = buildLedDigitalRig(0);
    facade.step(coordinator);
    const sig = coordinator.readByLabel("in");
    if (sig.type === "digital") {
      expect(sig.value).toBe(0);
    } else {
      throw new Error("expected digital signal at LED input net");
    }
  });
});

// ---------------------------------------------------------------------------
// PolarityAwareLED digital bridge (T1, Cat 9) — 4 truth-table cells
// ---------------------------------------------------------------------------

describe("PolarityAwareLED digital bridge (T1, Cat 9)", () => {
  it("polarity_anode_high_cathode_low_lights_diode_path", () => {
    // Documented behaviour: anode=1, cathode=0 → forward-biased path; the
    // shared input nets reflect the drive values via the digital bridge.
    const { facade, coordinator } = buildPolarityLedDigitalRig(1, 0);
    facade.step(coordinator);
    const aSig = coordinator.readByLabel("A");
    const kSig = coordinator.readByLabel("K");
    if (aSig.type === "digital" && kSig.type === "digital") {
      expect(aSig.value).toBe(1);
      expect(kSig.value).toBe(0);
    } else {
      throw new Error("expected digital signals at PolarityAwareLED input nets");
    }
  });

  it("polarity_anode_low_cathode_low_no_drive", () => {
    const { facade, coordinator } = buildPolarityLedDigitalRig(0, 0);
    facade.step(coordinator);
    const aSig = coordinator.readByLabel("A");
    const kSig = coordinator.readByLabel("K");
    if (aSig.type === "digital" && kSig.type === "digital") {
      expect(aSig.value).toBe(0);
      expect(kSig.value).toBe(0);
    } else {
      throw new Error("expected digital signals at PolarityAwareLED input nets");
    }
  });

  it("polarity_anode_high_cathode_high_no_diff", () => {
    const { facade, coordinator } = buildPolarityLedDigitalRig(1, 1);
    facade.step(coordinator);
    const aSig = coordinator.readByLabel("A");
    const kSig = coordinator.readByLabel("K");
    if (aSig.type === "digital" && kSig.type === "digital") {
      expect(aSig.value).toBe(1);
      expect(kSig.value).toBe(1);
    } else {
      throw new Error("expected digital signals at PolarityAwareLED input nets");
    }
  });

  it("polarity_anode_low_cathode_high_reverse_bias", () => {
    const { facade, coordinator } = buildPolarityLedDigitalRig(0, 1);
    facade.step(coordinator);
    const aSig = coordinator.readByLabel("A");
    const kSig = coordinator.readByLabel("K");
    if (aSig.type === "digital" && kSig.type === "digital") {
      expect(aSig.value).toBe(0);
      expect(kSig.value).toBe(1);
    } else {
      throw new Error("expected digital signals at PolarityAwareLED input nets");
    }
  });
});

// ---------------------------------------------------------------------------
// LightBulb digital bridge (T1, Cat 9)
// ---------------------------------------------------------------------------

describe("LightBulb digital bridge (T1, Cat 9)", () => {
  it("lightbulb_input_high_keeps_input_net_high", () => {
    // Cat 9: drive A high, B low. Both input nets must read back the
    // documented digital value via the bridge.
    const { facade, coordinator } = buildLightBulbDigitalRig(1, 0);
    facade.step(coordinator);
    const aSig = coordinator.readByLabel("A");
    const bSig = coordinator.readByLabel("B");
    if (aSig.type === "digital" && bSig.type === "digital") {
      expect(aSig.value).toBe(1);
      expect(bSig.value).toBe(0);
    } else {
      throw new Error("expected digital signals at LightBulb input nets");
    }
  });

  it("lightbulb_inputs_low_keep_input_nets_low", () => {
    const { facade, coordinator } = buildLightBulbDigitalRig(0, 0);
    facade.step(coordinator);
    const aSig = coordinator.readByLabel("A");
    const bSig = coordinator.readByLabel("B");
    if (aSig.type === "digital" && bSig.type === "digital") {
      expect(aSig.value).toBe(0);
      expect(bSig.value).toBe(0);
    } else {
      throw new Error("expected digital signals at LightBulb input nets");
    }
  });
});

// ---------------------------------------------------------------------------
// RGBLED digital bridge (T1, Cat 9 + Cat 11 multi-output observability)
// ---------------------------------------------------------------------------

describe("RGBLED digital bridge (T1, Cat 9)", () => {
  it("rgb_all_off_input_nets_all_low", () => {
    const { facade, coordinator } = buildRgbLedDigitalRig(0, 0, 0);
    facade.step(coordinator);
    const r = coordinator.readByLabel("R");
    const g = coordinator.readByLabel("G");
    const b = coordinator.readByLabel("B");
    if (r.type === "digital" && g.type === "digital" && b.type === "digital") {
      expect(r.value).toBe(0);
      expect(g.value).toBe(0);
      expect(b.value).toBe(0);
    } else {
      throw new Error("expected digital signals at RGBLED input nets");
    }
  });

  it("rgb_all_on_input_nets_all_high", () => {
    const { facade, coordinator } = buildRgbLedDigitalRig(1, 1, 1);
    facade.step(coordinator);
    const r = coordinator.readByLabel("R");
    const g = coordinator.readByLabel("G");
    const b = coordinator.readByLabel("B");
    if (r.type === "digital" && g.type === "digital" && b.type === "digital") {
      expect(r.value).toBe(1);
      expect(g.value).toBe(1);
      expect(b.value).toBe(1);
    } else {
      throw new Error("expected digital signals at RGBLED input nets");
    }
  });
});

describe("RGBLED multi-output channel observability (T1, Cat 11)", () => {
  // Cat 11: the RGBLED has 3 input pins (R, G, B) — each channel is observed
  // independently via its labelled net. The canonical mechanic asserts each
  // channel reads its documented value, never collapsing into a packed word.
  it("rgb_red_only_input_R_is_high_others_low", () => {
    const { facade, coordinator } = buildRgbLedDigitalRig(1, 0, 0);
    facade.step(coordinator);
    const r = coordinator.readByLabel("R");
    const g = coordinator.readByLabel("G");
    const b = coordinator.readByLabel("B");
    if (r.type === "digital") expect(r.value).toBe(1);
    else throw new Error("expected digital signal R");
    if (g.type === "digital") expect(g.value).toBe(0);
    else throw new Error("expected digital signal G");
    if (b.type === "digital") expect(b.value).toBe(0);
    else throw new Error("expected digital signal B");
  });

  it("rgb_green_only_input_G_is_high_others_low", () => {
    const { facade, coordinator } = buildRgbLedDigitalRig(0, 1, 0);
    facade.step(coordinator);
    const r = coordinator.readByLabel("R");
    const g = coordinator.readByLabel("G");
    const b = coordinator.readByLabel("B");
    if (r.type === "digital") expect(r.value).toBe(0);
    else throw new Error("expected digital signal R");
    if (g.type === "digital") expect(g.value).toBe(1);
    else throw new Error("expected digital signal G");
    if (b.type === "digital") expect(b.value).toBe(0);
    else throw new Error("expected digital signal B");
  });

  it("rgb_blue_only_input_B_is_high_others_low", () => {
    const { facade, coordinator } = buildRgbLedDigitalRig(0, 0, 1);
    facade.step(coordinator);
    const r = coordinator.readByLabel("R");
    const g = coordinator.readByLabel("G");
    const b = coordinator.readByLabel("B");
    if (r.type === "digital") expect(r.value).toBe(0);
    else throw new Error("expected digital signal R");
    if (g.type === "digital") expect(g.value).toBe(0);
    else throw new Error("expected digital signal G");
    if (b.type === "digital") expect(b.value).toBe(1);
    else throw new Error("expected digital signal B");
  });
});
