/**
 * Tests for behavioral analog factories in behavioral-remaining.ts.
 *
 * Tests:
 *   - Driver: tri-state high output, Hi-Z mode
 *   - LED: forward current through diode model
 *   - SevenSeg: digit "7" segment drive
 *   - Relay: coil energizes contact
 *   - Registration: all "both" components in this task have analogFactory
 *
 * Node ID conventions (matching behavioral-gate.test.ts and test-elements.ts):
 *   Node ID 0      = ground (implicit; not a solver row)
 *   Node ID N > 0  = solver row N-1 (0-based)
 *   voltages[N-1]  = voltage at circuit node N
 *
 *   makeVoltageSource(nodePos, nodeNeg, branchRow, voltage):
 *     nodePos/nodeNeg are 1-based circuit node IDs (0=ground)
 *     branchRow is an absolute 0-based solver row (= nodeCount + branchOffset)
 *
 *   matrixSize = number of circuit nodes + number of VS branch variables
 */

import { describe, it, expect } from "vitest";
import { SparseSolver } from "../sparse-solver.js";
import { DiagnosticCollector } from "../diagnostics.js";
import { newtonRaphson } from "../newton-raphson.js";
import { makeVoltageSource, makeResistor } from "../test-elements.js";
import {
  createDriverAnalogElement,
  createSevenSegAnalogElement,
  createRelayAnalogElement,
} from "../behavioral-remaining.js";
import { PropertyBag } from "../../core/properties.js";
import type { AnalogElement } from "../element.js";

// ---------------------------------------------------------------------------
// Component definitions imported for registration test
// ---------------------------------------------------------------------------
import { DriverDefinition } from "../../components/wiring/driver.js";
import { DriverInvSelDefinition } from "../../components/wiring/driver-inv.js";
import { SplitterDefinition } from "../../components/wiring/splitter.js";
import { BusSplitterDefinition } from "../../components/wiring/bus-splitter.js";
import { LedDefinition } from "../../components/io/led.js";
import { SevenSegDefinition } from "../../components/io/seven-seg.js";
import { SevenSegHexDefinition } from "../../components/io/seven-seg-hex.js";
import { RelayDefinition } from "../../components/switching/relay.js";
import { RelayDTDefinition } from "../../components/switching/relay-dt.js";
import { SwitchDefinition } from "../../components/switching/switch.js";
import { SwitchDTDefinition } from "../../components/switching/switch-dt.js";
import { ButtonLEDDefinition } from "../../components/io/button-led.js";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const VDD = 3.3;
const GND = 0.0;
const LOAD_R = 10_000;
const NR_OPTS = { maxIterations: 50, reltol: 1e-3, abstol: 1e-6 };

// CMOS 3.3V parameters (matches behavioral-remaining.ts CMOS_3V3_FALLBACK)
const VOH = 3.3;
const ROUT = 50;

// ---------------------------------------------------------------------------
// Solve helper
// ---------------------------------------------------------------------------

function solve(
  elements: AnalogElement[],
  matrixSize: number,
) {
  const solver = new SparseSolver();
  const diagnostics = new DiagnosticCollector();
  return newtonRaphson({ solver, elements, matrixSize, ...NR_OPTS, diagnostics });
}

// ---------------------------------------------------------------------------
// Driver tests
// ---------------------------------------------------------------------------

describe("Driver", () => {
  /**
   * tri_state_high: enable=1 (sel HIGH), input=1 (HIGH)
   *
   * The driver element uses 0-based solver node indices (same convention as
   * BehavioralGateElement). nodeIds [0, 1, 2] = [nodeIn, nodeSel, nodeOut].
   *
   * Circuit topology (0-based solver rows):
   *   Solver row 0 = nodeIn   (input data)
   *   Solver row 1 = nodeSel  (enable)
   *   Solver row 2 = nodeOut  (output; 10kΩ load to ground)
   *
   * makeVoltageSource takes 1-based circuit node IDs (0=ground):
   *   VS_in  at circuit node 1 (= solver row 0), branch row 3 (absolute)
   *   VS_sel at circuit node 2 (= solver row 1), branch row 4 (absolute)
   *
   * matrixSize = 5 (3 node rows 0..2 + 2 branch rows 3,4)
   *
   * The driver latches sel=HIGH on the second NR iteration when
   * updateOperatingPoint has stored VDD at solver row 1 (nodeSel=1).
   * NR converges to vOut ≈ vOH * LOAD_R / (rOut + LOAD_R) ≈ 3.284V.
   */
  it("tri_state_high", () => {
    const props = new PropertyBag();
    // nodeIds are 1-based MNA node IDs: nodeIn=1, nodeSel=2, nodeOut=3
    const driver = createDriverAnalogElement(
      new Map([["in", 1], ["sel", 2], ["out", 3]]), [], -1, props,
    );

    // Circuit node 1 (1-based) = solver row 0 = nodeIn; branch row 3
    const vsIn  = makeVoltageSource(1, 0, 3, VDD);
    // Circuit node 2 (1-based) = solver row 1 = nodeSel; branch row 4
    const vsSel = makeVoltageSource(2, 0, 4, VDD);
    // 10kΩ load on circuit node 3 (solver row 2 = nodeOut) to ground
    const rLoad = makeResistor(3, 0, LOAD_R);

    const elements: AnalogElement[] = [vsIn, vsSel, rLoad, driver];
    const matrixSize = 5; // rows 0,1,2 (nodes) + rows 3,4 (VS branches)

    const result = solve(elements, matrixSize);

    expect(result.converged).toBe(true);
    // voltages[2] = nodeOut = output voltage
    // Norton: vOH through rOut=50Ω into 10kΩ load → vOut ≈ 3.3 * 10000/10050
    const vOut = result.voltages[2];
    const expected = VOH * LOAD_R / (ROUT + LOAD_R);
    expect(vOut).toBeGreaterThan(3.0);
    expect(vOut).toBeCloseTo(expected, 1);
  });

  /**
   * tri_state_hiz: enable=0 (sel LOW) → output in Hi-Z mode
   *
   * Same topology but VS_sel = 0V. The driver detects sel=LOW → Hi-Z.
   * Hi-Z mode: R_HiZ (10MΩ) from nodeOut to ground, no current source.
   * With 10kΩ load and no source → output ≈ 0V.
   */
  it("tri_state_hiz", () => {
    const props = new PropertyBag();
    const driver = createDriverAnalogElement(
      new Map([["in", 1], ["sel", 2], ["out", 3]]), [], -1, props,
    );

    const vsIn  = makeVoltageSource(1, 0, 3, VDD);  // data input HIGH
    const vsSel = makeVoltageSource(2, 0, 4, GND);  // sel = 0 → Hi-Z
    const rLoad = makeResistor(3, 0, LOAD_R);

    const elements: AnalogElement[] = [vsIn, vsSel, rLoad, driver];
    const matrixSize = 5;

    const result = solve(elements, matrixSize);

    expect(result.converged).toBe(true);
    // Hi-Z output: R_HiZ=10MΩ to ground, plus 10kΩ load, no current source.
    const vOut = result.voltages[2];
    expect(vOut).toBeLessThan(0.1);
  });
});

// ---------------------------------------------------------------------------
// LED tests
// ---------------------------------------------------------------------------

describe("LED", () => {
  /**
   * forward_current_lights: 3.3V through 330Ω to LED anode, cathode to ground.
   *
   * Circuit:
   *   VS (3.3V) at circuit node 1 (branch row 2)
   *   330Ω from circuit node 1 to circuit node 2 (LED anode)
   *   LED anode = circuit node 2, cathode = ground (node 0)
   *
   * nodeIds for LED factory: [nodeAnode=2, nodeCathode=0]
   *   (cathode explicitly at ground node 0)
   *
   * voltages[0] = node 1 (VS positive terminal) = 3.3V (VS-forced)
   * voltages[1] = node 2 (LED anode)
   *
   * matrixSize = 3 (2 node rows + 1 branch row at index 2)
   *
   * For red LED: Vf ≈ 1.8V at 20mA → I ≈ (3.3-1.8)/330 ≈ 4.5mA
   */
  it("forward_current_lights", () => {
    const props = new PropertyBag();

    // LED: anode = circuit node 2, cathode = ground (0)
    const led = LedDefinition.analogFactory!(new Map([["in", 2]]), [], -1, props, () => 0);

    // VS at circuit node 1 (solver row 0), branch row 2 (absolute)
    const vs = makeVoltageSource(1, 0, 2, VDD);
    // 330Ω from circuit node 1 to circuit node 2 (LED anode)
    const rSeries = makeResistor(1, 2, 330);

    const elements: AnalogElement[] = [vs, rSeries, led];
    const matrixSize = 3; // 2 node rows (0,1) + 1 branch row (2)

    const result = solve(elements, matrixSize);

    expect(result.converged).toBe(true);
    // voltages[0] = node 1 = ~3.3V (VS-forced)
    // voltages[1] = node 2 = LED anode voltage ≈ 1.8V (red LED Vf)
    const vAnode = result.voltages[1];
    expect(vAnode).toBeGreaterThan(1.5);
    expect(vAnode).toBeLessThan(2.5);

    // Forward current through the series resistor
    const iForward = (VDD - vAnode) / 330;
    expect(iForward).toBeGreaterThan(1e-3);   // > 1mA
    expect(iForward).toBeLessThan(15e-3);     // < 15mA
    // Approximately (3.3 - 1.8) / 330 ≈ 4.5mA
    const expectedApprox = (VDD - 1.8) / 330;
    expect(iForward).toBeCloseTo(expectedApprox, 1);
  });
});

// ---------------------------------------------------------------------------
// SevenSeg tests
// ---------------------------------------------------------------------------

describe("SevenSeg", () => {
  /**
   * digit_display: drive segments for digit "7" (a, b, c active; rest off).
   *
   * Circuit:
   *   8 segment anode nodes: circuit nodes 1..8 (solver rows 0..7)
   *   8 VS branches: absolute rows 8..15
   *   Segments a(node 1), b(node 2), c(node 3): driven to VDD
   *   Segments d(node 4)..dp(node 8): driven to GND
   *   SevenSeg element: nodeIds = [1, 2, 3, 4, 5, 6, 7, 8] (1-based)
   *
   * matrixSize = 16 (8 node rows + 8 branch rows)
   *
   * Each segment is a piecewise-linear diode:
   *   V > 2.0V → on (R_on=50Ω), V ≤ 2.0V → off (R_off=10MΩ)
   *
   * VS-driven nodes: voltage at each node is forced to the VS value.
   * Active segments (a,b,c) at 3.3V: diode on, but VS still forces node to 3.3V.
   * Inactive segments (d..dp) at 0V: diode off.
   */
  it("digit_display", () => {
    const props = new PropertyBag();

    // 8 segment anodes: circuit nodes 1..8 (1-based)
    const sevenSeg = createSevenSegAnalogElement(
      new Map([["a", 1], ["b", 2], ["c", 3], ["d", 4], ["e", 5], ["f", 6], ["g", 7], ["dp", 8]]),
      [], -1, props,
    );

    // Digit "7": a=on, b=on, c=on, d=off, e=off, f=off, g=off, dp=off
    const segVoltages = [VDD, VDD, VDD, GND, GND, GND, GND, GND];

    // VS elements: circuit nodes 1..8, branch rows 8..15 (absolute)
    const vsElements: AnalogElement[] = segVoltages.map((v, i) =>
      makeVoltageSource(i + 1, 0, 8 + i, v),
    );

    const elements: AnalogElement[] = [...vsElements, sevenSeg];
    const matrixSize = 16; // 8 node rows (0..7) + 8 branch rows (8..15)

    const result = solve(elements, matrixSize);

    expect(result.converged).toBe(true);

    // Segments a, b, c (solver rows 0, 1, 2): VS forces to VDD
    for (let i = 0; i < 3; i++) {
      const vSeg = result.voltages[i];
      expect(vSeg, `segment ${["a","b","c"][i]} should be at VDD`).toBeCloseTo(VDD, 1);
    }

    // Segments d..dp (solver rows 3..7): VS forces to GND
    for (let i = 3; i < 8; i++) {
      const vSeg = result.voltages[i];
      expect(vSeg, `segment ${i} should be at GND`).toBeCloseTo(GND, 2);
    }
  });
});

// ---------------------------------------------------------------------------
// Relay tests
// ---------------------------------------------------------------------------

describe("Relay", () => {
  /**
   * coil_energizes_contact: energize coil above I_pull threshold; contact closes.
   *
   * The relay uses 1-based circuit node IDs (ground=0). nodeIds [1,2,3,4]:
   *   nodeCoil1=1, nodeCoil2=2 (coil terminals)
   *   nodeContactA=3, nodeContactB=4 (contact terminals)
   *
   * The relay's contact state is driven by the inductor current iL, which is
   * updated in updateState() after each transient timestep. The companion model
   * (stampCompanion) must be called before assembly each step to stamp the
   * inductor's equivalent conductance and history current source.
   *
   * Transient flow (matching integration.test.ts RL circuit pattern):
   *   For each timestep:
   *     1. relay.stampCompanion(dt, method, voltages) — update geqL/ieqL coefficients
   *     2. solver.beginAssembly(matrixSize)
   *     3. stamp all elements (stamp() only — NOT stampCompanion again)
   *     4. solver.finalize() → factor() → solve()
   *     5. relay.updateState(dt, voltages) — advance iL and update contactClosed
   *
   * Note: For the relay, stampCompanion() both updates internal state (geqL/ieqL)
   * AND stamps into the solver. We call it before beginAssembly so its coefficients
   * are ready for the stamp() call which also stamps the companion contributions.
   * Actually, looking at relay.stampCompanion: it calls stampG and stampRHS on
   * the solver passed to it. Since beginAssembly clears the matrix, we call
   * stampCompanion AFTER beginAssembly so it stamps into the fresh matrix.
   *
   * Circuit:
   *   VS_coil: 10V at node 1 (branch row 4) — coil input
   *   Node 2 tied to ground via VS (0V, branch row 5)
   *   VS_contact: 1V at node 3 (branch row 6) — contact A
   *   1kΩ load: node 4 to ground — measures contact B
   *
   * matrixSize = 7 (4 node rows 0..3 + 3 branch rows 4,5,6)
   *
   * With rCoil=10Ω, coil voltage=10V: steady-state coil current = 10V/10Ω = 1A >> iPull=20mA.
   * Run enough transient steps for iL to exceed iPull, then verify contact closes.
   */
  it("coil_energizes_contact", () => {
    const props = new PropertyBag();
    props.set("coilResistance", 10);    // 10Ω coil resistance
    props.set("inductance", 1e-3);      // 1mH inductance (tau = L/R = 1ms)
    props.set("iPull", 20e-3);          // 20mA threshold

    // Relay pin nodeIds (1-based circuit node IDs: ground=0)
    const relay = createRelayAnalogElement(
      new Map([["in1", 1], ["in2", 2], ["A1", 3], ["B1", 4]]),
      [], -1, props,
    );

    // Coil driven by VS: 10V at node 1 (branch row 4), 0V at node 2 (branch row 5)
    const vsCoil1   = makeVoltageSource(1, 0, 4, 10.0);
    const vsCoil2   = makeVoltageSource(2, 0, 5, 0.0);
    // Contact: 1V at node 3 (branch row 6), 1kΩ from node 4 to ground
    const vsContact = makeVoltageSource(3, 0, 6, 1.0);
    const rLoad     = makeResistor(4, 0, 1_000);

    const allElements = [vsCoil1, vsCoil2, vsContact, rLoad, relay];
    const matrixSize = 7;

    const solver = new SparseSolver();
    let voltages = new Float64Array(matrixSize);

    // tau = L/R = 1e-3/10 = 100µs; run 10 steps of 100µs = 1 tau
    // After 1 tau: iL = (V/R)*(1-exp(-1)) ≈ (10/10)*0.632 = 0.632A >> 20mA
    const dt = 100e-6;
    const steps = 10;

    for (let step = 0; step < steps; step++) {
      solver.beginAssembly(matrixSize);
      // Stamp all elements
      for (const el of allElements) el.stamp(solver);
      // Stamp relay companion model (adds inductor equivalent conductance + history current)
      relay.stampCompanion!(dt, "trapezoidal", voltages);
      solver.finalize();
      const factored = solver.factor();
      expect(factored.success).toBe(true);
      solver.solve(voltages);
      // Advance relay state: updates iL and contactClosed
      relay.updateState!(dt, voltages);
    }

    // After 10 × 100µs, coil current >> 20mA → contact should be closed.
    // Verify by solving again with the updated contact state.
    solver.beginAssembly(matrixSize);
    for (const el of allElements) el.stamp(solver);
    relay.stampCompanion!(dt, "trapezoidal", voltages);
    solver.finalize();
    solver.factor();
    solver.solve(voltages);

    // Contact A = circuit node 3 → voltages[2] (1-based index 3, solver row 2)
    const vContactA = voltages[2];
    // Contact B = circuit node 4 → voltages[3]
    const vContactB = voltages[3];

    expect(vContactA).toBeCloseTo(1.0, 2);
    // When closed (R_on=0.01Ω), drop across contact is negligible → vContactB ≈ 1V
    expect(vContactB).toBeGreaterThan(0.99);
  });
});

// ---------------------------------------------------------------------------
// Registration tests
// ---------------------------------------------------------------------------

describe("Registration", () => {
  /**
   * all_both_components_have_analog_factory:
   * All 12 components from task 6.1.4 must have engineType "both" and analogFactory.
   */
  it("all_both_components_have_analog_factory", () => {
    const definitions = [
      DriverDefinition,
      DriverInvSelDefinition,
      SplitterDefinition,
      BusSplitterDefinition,
      LedDefinition,
      SevenSegDefinition,
      SevenSegHexDefinition,
      RelayDefinition,
      RelayDTDefinition,
      SwitchDefinition,
      SwitchDTDefinition,
      ButtonLEDDefinition,
    ];

    for (const def of definitions) {
      expect(
        def.engineType,
        `${def.name} should have engineType "both"`,
      ).toBe("both");
      expect(
        def.analogFactory,
        `${def.name} should have analogFactory defined`,
      ).toBeDefined();
    }
  });
});
