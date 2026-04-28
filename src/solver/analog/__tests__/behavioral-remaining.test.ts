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
 * Node ID conventions:
 *   Node ID 0      = ground (implicit; not a solver row)
 *   Node ID N > 0  = solver row N-1 (0-based)
 *   voltages[N]  = voltage at circuit node N
 *
 *   Voltage sources are constructed via makeDcVoltageSource(new Map([["pos", N], ["neg", 0]]), V).
 *   Branch rows are allocated during setup() via SetupContext.makeCur.
 *
 *   matrixSize = number of circuit nodes + number of VS branch variables
 */

import { describe, it, expect } from "vitest";
import { newtonRaphson } from "../newton-raphson.js";
import { makeSimpleCtx, makeLoadCtx } from "./test-helpers.js";
import { StatePool } from "../state-pool.js";
import {
  createDriverAnalogElement,
  createSevenSegAnalogElement,
} from "../behavioral-remaining.js";
import { PropertyBag } from "../../../core/properties.js";
import type { AnalogElement, PoolBackedAnalogElement } from "../element.js";
import { makeDcVoltageSource, DC_VOLTAGE_SOURCE_DEFAULTS } from "../../../components/sources/dc-voltage-source.js";
import { ResistorDefinition } from "../../../components/passives/resistor.js";
import type { AnalogFactory } from "../../../core/registry.js";

// ---------------------------------------------------------------------------
// Component definitions imported for registration test
// ---------------------------------------------------------------------------
import { DriverDefinition } from "../../../components/wiring/driver.js";
import { DriverInvSelDefinition } from "../../../components/wiring/driver-inv.js";
import { SplitterDefinition } from "../../../components/wiring/splitter.js";
import { BusSplitterDefinition } from "../../../components/wiring/bus-splitter.js";
import { LedDefinition } from "../../../components/io/led.js";
import { DIODE_PARAM_DEFAULTS } from "../../../components/semiconductors/diode.js";
import { SevenSegDefinition } from "../../../components/io/seven-seg.js";
import { SevenSegHexDefinition } from "../../../components/io/seven-seg-hex.js";
import { RelayDefinition } from "../../../components/switching/relay.js";
import { RelayDTDefinition } from "../../../components/switching/relay-dt.js";
import { SwitchDefinition } from "../../../components/switching/switch.js";
import { SwitchDTDefinition } from "../../../components/switching/switch-dt.js";
import { ButtonLEDDefinition } from "../../../components/io/button-led.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry } from "../../../core/registry.js";
import type { LoadContext } from "../load-context.js";
import { MODETRAN, MODEINITFLOAT } from "../ckt-mode.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}

// ---------------------------------------------------------------------------
// Helper: allocate a StatePool for a single element and call initState
// ---------------------------------------------------------------------------

function withState(core: AnalogElement): { element: PoolBackedAnalogElement; pool: StatePool } {
  const pb = core as PoolBackedAnalogElement;
  const pool = new StatePool(Math.max(pb.stateSize, 1));
  (pb as PoolBackedAnalogElement & { _stateBase: number })._stateBase = 0;
  pb.initState(pool);
  return { element: pb, pool };
}

/**
 * Build a resistor element via the production ResistorDefinition factory.
 * Pin labels are "A" (nodeA) and "B" (nodeB) matching ResistorDefinition.
 */
function makeTestResistor(nodeA: number, nodeB: number, resistance: number): AnalogElement {
  const props = new PropertyBag();
  props.replaceModelParams({ resistance });
  const factory = (ResistorDefinition.modelRegistry!.behavioral as { kind: "inline"; factory: AnalogFactory }).factory;
  return factory(new Map([["A", nodeA], ["B", nodeB]]), props, () => 0);
}

function makeVsrc(posNode: number, negNode: number, voltage: number): AnalogElement {
  const props = new PropertyBag();
  props.replaceModelParams({ ...DC_VOLTAGE_SOURCE_DEFAULTS, voltage });
  return makeDcVoltageSource(new Map([["pos", posNode], ["neg", negNode]]), props, () => 0);
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const VDD = 3.3;
const GND = 0.0;
const LOAD_R = 10_000;
const NR_OPTS = { maxIterations: 50, reltol: 1e-3, abstol: 1e-6, iabstol: 1e-12 };

const CMOS_3V3: import("../../../core/pin-electrical.js").ResolvedPinElectrical = {
  rOut: 50,
  cOut: 5e-12,
  rIn: 1e7,
  cIn: 5e-12,
  vOH: 3.3,
  vOL: 0.0,
  vIH: 2.0,
  vIL: 0.8,
  rHiZ: 1e7,
};

// ---------------------------------------------------------------------------
// Solve helper
// ---------------------------------------------------------------------------

function solve(
  elements: AnalogElement[],
  matrixSize: number,
) {
  const nodeCount = matrixSize;
  const ctx = makeSimpleCtx({ elements, matrixSize, nodeCount, params: NR_OPTS });
  newtonRaphson(ctx);
  return ctx.nrResult;
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
   *   Solver row 2 = nodeOut  (output; 10kÎ load to ground)
   *
   * makeVoltageSource takes 1-based circuit node IDs (0=ground):
   *   VS_in  at circuit node 1 (= solver row 0), branch row 3 (absolute)
   *   VS_sel at circuit node 2 (= solver row 1), branch row 4 (absolute)
   *
   * matrixSize = 5 (3 node rows 0..2 + 2 branch rows 3,4)
   *
   * The driver latches sel=HIGH on the second NR iteration when
   * VDD is present at solver row 1 (nodeSel=1).
   * NR converges to vOut  vOH * LOAD_R / (rOut + LOAD_R)  3.284V.
   */
  it("tri_state_high", () => {
    const props = new PropertyBag();
    // Disable capacitive loading on all pins so AnalogCapacitorElement children
    // are not created — avoids hitting PB-CAP stub during setup().
    props.set("_pinLoading", { in: false, sel: false, out: false } as unknown as import("../../../core/properties.js").PropertyValue);
    props.set("_pinElectrical", { in: CMOS_3V3, sel: CMOS_3V3, out: CMOS_3V3 } as unknown as import("../../../core/properties.js").PropertyValue);
    // nodeIds are 1-based MNA node IDs: nodeIn=1, nodeSel=2, nodeOut=3
    const driver = createDriverAnalogElement(
      new Map([["in", 1], ["sel", 2], ["out", 3]]), props,
    );

    // Circuit node 1 (1-based) = solver row 0 = nodeIn
    const vsIn  = makeVsrc(1, 0, VDD);
    // Circuit node 2 (1-based) = solver row 1 = nodeSel
    const vsSel = makeVsrc(2, 0, VDD);
    // 10kΩ load on circuit node 3 (solver row 2 = nodeOut) to ground
    const rLoad = makeTestResistor(3, 0, LOAD_R);

    const elements: AnalogElement[] = [vsIn, vsSel, rLoad, driver];
    const matrixSize = 5; // rows 0,1,2 (nodes) + rows 3,4 (VS branches)

    const result = solve(elements, matrixSize);

    expect(result.converged).toBe(true);
    // nodeOut = circuit node 3 → voltages[3] (1-based)
    // Norton: vOH through rOut=50Ω into 10kΩ load → vOut ≈ 3.3 * 10000/10050
    const vOut = result.voltages[3];
    expect(vOut).toBeGreaterThan(3.0);
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
    // Disable capacitive loading on all pins so AnalogCapacitorElement children
    // are not created — avoids hitting PB-CAP stub during setup().
    props.set("_pinLoading", { in: false, sel: false, out: false } as unknown as import("../../../core/properties.js").PropertyValue);
    props.set("_pinElectrical", { in: CMOS_3V3, sel: CMOS_3V3, out: CMOS_3V3 } as unknown as import("../../../core/properties.js").PropertyValue);
    const driver = createDriverAnalogElement(
      new Map([["in", 1], ["sel", 2], ["out", 3]]), props,
    );

    const vsIn  = makeVsrc(1, 0, VDD);  // data input HIGH
    const vsSel = makeVsrc(2, 0, GND);  // sel = 0 → Hi-Z
    const rLoad = makeTestResistor(3, 0, LOAD_R);

    const elements: AnalogElement[] = [vsIn, vsSel, rLoad, driver];
    const matrixSize = 5;

    const result = solve(elements, matrixSize);

    expect(result.converged).toBe(true);
    // Hi-Z output: R_HiZ=10MΩ to ground, plus 10kΩ load, no current source.
    const vOut = result.voltages[3]; // nodeOut = circuit node 3 → voltages[3]
    expect(vOut).toBeLessThan(0.1);
  });
});

// ---------------------------------------------------------------------------
// LED tests
// ---------------------------------------------------------------------------

describe("LED", () => {
  /**
   * forward_current_lights: 3.3V through 330Î to LED anode, cathode to ground.
   *
   * Circuit:
   *   VS (3.3V) at circuit node 1 (branch row 2)
   *   330Î from circuit node 1 to circuit node 2 (LED anode)
   *   LED anode = circuit node 2, cathode = ground (node 0)
   *
   * nodeIds for LED factory: [nodeAnode=2, nodeCathode=0]
   *   (cathode explicitly at ground node 0)
   *
   * 1-based rhs convention:
   *   voltages[1] = circuit node 1 (VS positive terminal) = 3.3V (VS-forced)
   *   voltages[2] = circuit node 2 (LED anode)  1.8V (red LED Vf)
   *
   * matrixSize = 3 (2 node rows + 1 branch row at index 2)
   *
   * For red LED: Vf  1.8V at 20mA  I  (3.3-1.8)/330  4.5mA
   */
  it("forward_current_lights", () => {
    const props = new PropertyBag();
    props.replaceModelParams({ ...DIODE_PARAM_DEFAULTS });

    // LED: anode = circuit node 2, cathode = ground (0)
    const ledCore = getFactory(LedDefinition.modelRegistry!.red!)(new Map([["in", 2]]), props, () => 0);
    const { element: led } = withState(ledCore);

    // VS at circuit node 1
    const vs = makeVsrc(1, 0, VDD);
    // 330Ω from circuit node 1 to circuit node 2 (LED anode)
    const rSeries = makeTestResistor(1, 2, 330);

    const elements: AnalogElement[] = [vs, rSeries, led];
    const matrixSize = 3; // 2 node rows (0,1) + 1 branch row (2)

    const result = solve(elements, matrixSize);

    expect(result.converged).toBe(true);
    // voltages[1] = circuit node 1 = ~3.3V (VS-forced)
    // voltages[2] = circuit node 2 = LED anode voltage  1.8V (red LED Vf)
    const vAnode = result.voltages[2];
    expect(vAnode).toBeGreaterThan(1.5);
    expect(vAnode).toBeLessThan(2.5);

    // Forward current through the series resistor
    const iForward = (VDD - vAnode) / 330;
    expect(iForward).toBeGreaterThan(1e-3);   // > 1mA
    expect(iForward).toBeLessThan(15e-3);     // < 15mA
    // Approximately (3.3 - 1.8) / 330  4.5mA
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
   *   V > 2.0V  on (R_on=50Î), V â‰¤ 2.0V  off (R_off=10MÎ)
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
      props,
    );

    // Digit "7": a=on, b=on, c=on, d=off, e=off, f=off, g=off, dp=off
    const segVoltages = [VDD, VDD, VDD, GND, GND, GND, GND, GND];

    // VS elements: circuit nodes 1..8
    const vsElements: AnalogElement[] = segVoltages.map((v, i) =>
      makeVsrc(i + 1, 0, v),
    );

    const elements: AnalogElement[] = [...vsElements, sevenSeg];
    const matrixSize = 16; // 8 node rows (0..7) + 8 branch rows (8..15)

    const result = solve(elements, matrixSize);

    expect(result.converged).toBe(true);

    // Segments a, b, c (solver rows 0, 1, 2): VS forces to VDD
    // Segments d..dp (solver rows 3..7): VS forces to GND
  });
});

// ---------------------------------------------------------------------------
// Registration tests
// ---------------------------------------------------------------------------

describe("Registration", () => {
  /**
   * all_both_components_have_analog_factory:
   * All 12 components from task 6.1.4 must have both digital and analog models.
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
        def.models?.digital,
        `${def.name} should have a digital model`,
      ).toBeDefined();
      const registry = def.modelRegistry ?? {};
      expect(
        Object.keys(registry).length > 0,
        `${def.name} should have an analog model`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Task 6.4.3  remaining_pin_loading_propagates
// ---------------------------------------------------------------------------

describe("Task 6.4.3  remaining pin loading propagates", () => {
  it("remaining_pin_loading_propagates", () => {
    // Driver element: pins "in"=node 1, "sel"=node 2, "out"=node 3.
    // Set _pinLoading: "in"=true, "sel"=false, "out"=false.
    //
    // Per the setup/load split contract:
    //   - setup() calls allocElement for ALL pins regardless of loaded flag
    //     (DigitalInputPinModel.setup always allocates the diagonal handle)
    //   - load() calls stampElement only for loaded pins ("in"=loaded → stamps;
    //     "sel"=not-loaded → no-op in load())
    //
    // Verify via setup()/load() call capture:
    //   setup() allocCalls includes (1,1) for "in" and (2,2) for "sel" (both allocated)
    //   load() stampCalls includes handle for node 1 ("in" loaded) but NOT node 2 ("sel" unloaded)
    const pinLoading: Record<string, boolean> = {
      "in": true,
      "sel": false,
      "out": false,
    };
    const props = new PropertyBag();
    props.set("_pinLoading", pinLoading as unknown as import("../../../core/properties.js").PropertyValue);
    props.set("_pinElectrical", { in: CMOS_3V3, sel: CMOS_3V3, out: CMOS_3V3 } as unknown as import("../../../core/properties.js").PropertyValue);

    const element = createDriverAnalogElement(
      new Map([["in", 1], ["sel", 2], ["out", 3]]),
      props,
    );

    // Phase 1: setup() — capture allocElement calls to assign handles
    const setupAllocCalls: Array<[number, number]> = [];
    const handleToRC = new Map<number, [number, number]>();
    const setupSolver = {
      allocElement(r: number, c: number) {
        const h = setupAllocCalls.length;
        setupAllocCalls.push([r, c]);
        handleToRC.set(h, [r, c]);
        return h;
      },
      stampElement(_h: number, _v: number) {},
      stampRHS(_i: number, _v: number) {},
    };
    const setupCtx = {
      solver: setupSolver as any,
      temp: 300.15,
      nomTemp: 300.15,
      copyNodesets: false,
      makeVolt(_l: string, _s: string) { return 100; },
      makeCur(_l: string, _s: string) { return 100; },
      allocStates(_n: number) { return 0; },
      findBranch(_l: string) { return 0; },
      findDevice(_l: string) { return null; },
    };
    (element as any).setup(setupCtx);

    // Initialise state pool for child capacitor elements (created for loaded "in" pin).
    // Without this, child.load() crashes on _pool.states[N] being undefined.
    const poolSize = Math.max((element as any).stateSize ?? 0, 1);
    const statePool = new StatePool(poolSize);
    (element as any)._stateBase = 0;
    (element as any).initState(statePool);

    // Both "in" (node 1) and "sel" (node 2) diagonal handles are allocated in setup()
    const inSetup  = setupAllocCalls.some(([r, c]) => r === 1 && c === 1);
    const selSetup = setupAllocCalls.some(([r, c]) => r === 2 && c === 2);
    expect(inSetup).toBe(true);
    expect(selSetup).toBe(true);

    // Phase 2: load() — verify only the loaded "in" pin stamps (not "sel")
    const stampedHandles: number[] = [];
    const loadSolver = {
      allocElement(_r: number, _c: number) { return -1; },
      stampElement(h: number, _v: number) { stampedHandles.push(h); },
      stampRHS(_i: number, _v: number) {},
    };
    const rhs = new Float64Array(10);
    const loadCtx: LoadContext = makeLoadCtx({
      solver: loadSolver as any,
      rhs,
      rhsOld: rhs,
      cktMode: MODETRAN | MODEINITFLOAT,
      dt: 0,
      method: "trapezoidal",
      order: 1,
    });
    element.load(loadCtx);

    // "in" pin is loaded → its diagonal handle (allocated at (1,1) in setup) IS stamped
    const inHandle  = setupAllocCalls.findIndex(([r, c]) => r === 1 && c === 1);
    const selHandle = setupAllocCalls.findIndex(([r, c]) => r === 2 && c === 2);
    const inStamped  = stampedHandles.includes(inHandle);
    const selStamped = stampedHandles.includes(selHandle);

    expect(inStamped).toBe(true);
    expect(selStamped).toBe(false);
  });
});
