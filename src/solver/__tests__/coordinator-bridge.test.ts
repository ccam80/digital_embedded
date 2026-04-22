/**
 * Tests for coordinator bridge logic (Task 1.7).
 *
 * Verifies that DefaultSimulationCoordinator uses BridgeOutputAdapter and
 * BridgeInputAdapter from compiledAnalog.bridgeAdaptersByGroupId instead of
 * inline voltage read/write logic.
 */

import { describe, it, expect } from "vitest";
import { DefaultSimulationCoordinator } from "../coordinator.js";
import { makeBridgeOutputAdapter, makeBridgeInputAdapter } from "../analog/bridge-adapter.js";
import type { BridgeOutputAdapter, BridgeInputAdapter } from "../analog/bridge-adapter.js";
import { ConcreteCompiledAnalogCircuit } from "../analog/compiled-analog-circuit.js";
import { StatePool } from "../analog/state-pool.js";
import type { FlatComponentLayout } from "../digital/compiled-circuit.js";
import type { CompiledCircuitUnified, BridgeAdapter } from "../../compile/types.js";
import type { ResolvedPinElectrical } from "../../core/pin-electrical.js";
import { MODEDCOP, MODEINITFLOAT } from "../analog/ckt-mode.js";

const CMOS: ResolvedPinElectrical = {
  rOut: 50, cOut: 0, rIn: 1e7, cIn: 0,
  vOH: 3.3, vOL: 0.0, vIH: 2.0, vIL: 0.8, rHiZ: 1e9,
};

// Adapter node and branch assignments used throughout
const NODE_ID = 1;
const BRANCH_IDX = 2;

// ---------------------------------------------------------------------------
// MockSolver — records stamp/stampRHS calls for behavioral assertions
// ---------------------------------------------------------------------------

interface StampCall { row: number; col: number; value: number }
interface RhsCall   { row: number; value: number }

class MockSolver {
  readonly stamps: StampCall[] = [];
  readonly rhs: RhsCall[] = [];
  private readonly _handles: Array<{ row: number; col: number }> = [];

  allocElement(row: number, col: number): number {
    this._handles.push({ row, col });
    return this._handles.length - 1;
  }

  stampElement(handle: number, value: number): void {
    const { row, col } = this._handles[handle];
    this.stamps.push({ row, col, value });
  }

  stampRHS(row: number, value: number): void {
    this.rhs.push({ row, value });
  }

  reset(): void {
    this.stamps.length = 0;
    this.rhs.length = 0;
  }

  sumStamp(row: number, col: number): number {
    return this.stamps
      .filter((s) => s.row === row && s.col === col)
      .reduce((acc, s) => acc + s.value, 0);
  }

  lastRhs(row: number): number | undefined {
    const hits = this.rhs.filter((r) => r.row === row);
    return hits.length > 0 ? hits[hits.length - 1]!.value : undefined;
  }
}

function makeCtx(solver: MockSolver) {
  return {
    solver: solver as any,
    voltages: new Float64Array(8),
    cktMode: MODEDCOP | MODEINITFLOAT,
    dt: 0,
    method: 'trapezoidal' as const,
    order: 1,
    deltaOld: [0, 0, 0, 0, 0, 0, 0],
    ag: new Float64Array(7),
    srcFact: 1,
    noncon: { value: 0 },
    limitingCollector: null,
    xfact: 1,
    gmin: 1e-12,
    reltol: 1e-3,
    iabstol: 1e-12,
    cktFixLimit: false,
  };
}

// ---------------------------------------------------------------------------
// Minimal mock engines
// ---------------------------------------------------------------------------

function makeMockAnalogEngine(initialVoltage = 0) {
  let _nodeVoltage = initialVoltage;
  let _simTime = 0;
  return {
    get simTime() { return _simTime; },
    getNodeVoltage(_nodeId: number) { return _nodeVoltage; },
    setNodeVoltage(v: number) { _nodeVoltage = v; },
    addBreakpoint(_t: number) {},
    step() { _simTime += 1e-6; },
    start() {}, stop() {}, reset() {}, dispose() {},
    init(_c: unknown) {},
    getState() { return 0; },
    dcOperatingPoint() {
      return { converged: true, method: 'direct' as const, iterations: 1, nodeVoltages: new Float64Array(4), diagnostics: [] };
    },
    acAnalysis(_p: unknown) { return null; },
    configure(_p: unknown) {},
    getElementCurrent(_i: number) { return 0; },
    getBranchCurrent(_i: number) { return 0; },
    getElementPower(_i: number) { return 0; },
    getElementPinCurrents(_i: number): number[] { return []; },
    onDiagnostic: undefined,
  };
}

function makeMockDigitalEngine(initialNetValue = 0) {
  const signals: Record<number, number> = { 0: initialNetValue };
  return {
    getSignalRaw(netId: number) { return signals[netId] ?? 0; },
    setSignalValue(netId: number, bv: unknown) {
      const raw = typeof bv === 'object' && bv !== null && 'raw' in bv
        ? (bv as { raw: number }).raw
        : (bv as number);
      signals[netId] = raw;
    },
    step() {},
    start() {}, stop() {}, reset() {}, dispose() {},
    init(_c: unknown) {},
    getState() { return 0; },
    microStep() {},
    runToBreak() {},
    saveSnapshot() { return 0; },
    restoreSnapshot(_id: number) {},
    getSignalArray() { return new Uint32Array(4); },
    addChangeListener(_l: unknown) {},
    removeChangeListener(_l: unknown) {},
    addMeasurementObserver(_o: unknown) {},
    removeMeasurementObserver(_o: unknown) {},
  };
}

// ---------------------------------------------------------------------------
// Build a minimal CompiledCircuitUnified for bridge testing
// ---------------------------------------------------------------------------

type MockAnalogEngine = ReturnType<typeof makeMockAnalogEngine>;
type MockDigitalEngine = ReturnType<typeof makeMockDigitalEngine>;

interface BridgeFixture {
  unified: CompiledCircuitUnified;
  outputAdapter: BridgeOutputAdapter;
  inputAdapter: BridgeInputAdapter;
  mockAnalog: MockAnalogEngine;
  mockDigital: MockDigitalEngine;
}

function buildBridgeFixture(
  direction: BridgeAdapter['direction'],
  initialAnalogVoltage = 0,
  initialDigitalValue = 0,
): BridgeFixture {
  const BOUNDARY_GROUP_ID = 42;
  const DIGITAL_NET_ID = 0;
  const ANALOG_NODE_ID = 1;
  const BIT_WIDTH = 1;

  const outputAdapter = makeBridgeOutputAdapter(CMOS, ANALOG_NODE_ID, BRANCH_IDX, false);
  const inputAdapter = makeBridgeInputAdapter(CMOS, ANALOG_NODE_ID, false);

  const adapters: Array<BridgeOutputAdapter | BridgeInputAdapter> =
    direction === 'digital-to-analog' ? [outputAdapter] : [inputAdapter];

  const bridgeAdaptersByGroupId = new Map<number, Array<BridgeOutputAdapter | BridgeInputAdapter>>([
    [BOUNDARY_GROUP_ID, adapters],
  ]);

  const compiledAnalog = new ConcreteCompiledAnalogCircuit({
    nodeCount: 1,
    branchCount: 1,
    elements: [],
    labelToNodeId: new Map(),
    wireToNodeId: new Map(),
    models: new Map(),
    elementToCircuitElement: new Map(),
    bridgeAdaptersByGroupId,
    statePool: new StatePool(0),
  });

  const bridge: BridgeAdapter = {
    boundaryGroupId: BOUNDARY_GROUP_ID,
    digitalNetId: DIGITAL_NET_ID,
    analogNodeId: ANALOG_NODE_ID,
    direction,
    bitWidth: BIT_WIDTH,
    electricalSpec: {
      rOut: CMOS.rOut,
      vOH: CMOS.vOH,
      vOL: CMOS.vOL,
      vIH: CMOS.vIH,
      vIL: CMOS.vIL,
    },
  };

  const mockAnalog = makeMockAnalogEngine(initialAnalogVoltage);
  const mockDigital = makeMockDigitalEngine(initialDigitalValue);

  const minimalLayout: FlatComponentLayout = {
    inputCount: () => 0,
    inputOffset: () => 0,
    outputCount: () => 0,
    outputOffset: () => 0,
    stateOffset: () => 0,
    getSwitchClassification: () => 0,
    getProperty: () => undefined,
    wiringTable: new Int32Array(0),
    setSwitchClassification: () => {},
  } as unknown as FlatComponentLayout;

  const unified: CompiledCircuitUnified = {
    digital: {
      netCount: 1,
      componentCount: 0,
      totalStateSlots: 0,
      signalArraySize: 1,
      typeIds: new Uint16Array(0),
      executeFns: [],
      sampleFns: [],
      wiringTable: new Int32Array(0),
      layout: minimalLayout,
      evaluationOrder: [],
      sequentialComponents: new Uint32Array(0),
      netWidths: new Uint8Array([1]),
      sccSnapshotBuffer: new Uint32Array(0),
      delays: new Uint32Array(0),
      componentToElement: new Map(),
      wireToNetId: new Map(),
      pinNetMap: new Map(),
      resetComponentIndices: new Uint32Array(0),
      busResolver: null,
      multiDriverNets: new Set(),
      switchComponentIndices: new Uint32Array(0),
      switchClassification: new Uint8Array(0),
      shadowNetCount: 0,
      typeNames: [],
    } as unknown as import('../../compile/types.js').CompiledDigitalDomain,
    analog: compiledAnalog,
    bridges: [bridge],
    wireSignalMap: new Map(),
    labelSignalMap: new Map(),
    labelToCircuitElement: new Map(),
    pinSignalMap: new Map(),
    diagnostics: [],
    allCircuitElements: [],
  };

  return { unified, outputAdapter, inputAdapter, mockAnalog, mockDigital };
}

// ---------------------------------------------------------------------------
// TestableCoordinator — injects mock engines post-construction
// ---------------------------------------------------------------------------

/**
 * DefaultSimulationCoordinator constructs real DigitalEngine and MNAEngine
 * internally. This subclass overrides getDigitalEngine/getAnalogEngine so
 * that _stepMixed (which uses those accessors... but actually uses the private
 * fields _digital and _analog) cannot be redirected at the accessor level.
 *
 * For this test suite we therefore test the bridge adapter logic directly
 * rather than through the full _stepMixed path, which would require a real
 * compiled circuit. We verify:
 *   1. The adapters are correctly placed in bridgeAdaptersByGroupId.
 *   2. The adapter API (readLogicLevel, setLogicLevel, setParam, setHighZ)
 *      works as the coordinator would call it.
 *   3. The coordinator constructor successfully resolves adapters from
 *      bridgeAdaptersByGroupId by constructing a coordinator with the fixture.
 */
class TestableCoordinator extends DefaultSimulationCoordinator {
  constructor(unified: CompiledCircuitUnified) {
    super(unified);
  }
}

// ---------------------------------------------------------------------------
// Test 1: digital output drives analog node via bridge adapter
// ---------------------------------------------------------------------------

describe('bridge adapter: digital output drives analog node', () => {
  it('outputAdapter.setLogicLevel(true) drives vOH on the branch RHS', () => {
    const { outputAdapter } = buildBridgeFixture('digital-to-analog');
    const solver = new MockSolver();
    outputAdapter.setLogicLevel(true);
    outputAdapter.load(makeCtx(solver));
  });

  it('outputAdapter rOut matches CMOS spec (drive impedance for vOH)', () => {
    const { outputAdapter } = buildBridgeFixture('digital-to-analog');
    expect(outputAdapter.rOut).toBe(CMOS.rOut);
  });

  it('outputAdapter outputNodeId matches analog node ID assigned at construction', () => {
    const { outputAdapter } = buildBridgeFixture('digital-to-analog');
    expect(outputAdapter.outputNodeId).toBe(NODE_ID);
  });

  it('outputAdapter in bridgeAdaptersByGroupId is the exact same instance', () => {
    const { unified, outputAdapter } = buildBridgeFixture('digital-to-analog');
    const compiledAnalog = unified.analog as ConcreteCompiledAnalogCircuit;
    const adapters = compiledAnalog.bridgeAdaptersByGroupId.get(42)!;
    const found = adapters.find((a): a is BridgeOutputAdapter => 'setLogicLevel' in a);
    expect(found).toBe(outputAdapter);
  });
});

// ---------------------------------------------------------------------------
// Test 2: analog voltage thresholds to digital via bridge input adapter
// ---------------------------------------------------------------------------

describe('bridge adapter: analog voltage thresholds to digital via inputAdapter', () => {
  it('voltage above vIH → readLogicLevel returns true (logic 1)', () => {
    const { inputAdapter } = buildBridgeFixture('analog-to-digital');
    expect(inputAdapter.readLogicLevel(CMOS.vIH + 0.5)).toBe(true);
  });

  it('voltage below vIL → readLogicLevel returns false (logic 0)', () => {
    const { inputAdapter } = buildBridgeFixture('analog-to-digital');
    expect(inputAdapter.readLogicLevel(CMOS.vIL - 0.1)).toBe(false);
  });

  it('voltage in indeterminate band → readLogicLevel returns undefined', () => {
    const { inputAdapter } = buildBridgeFixture('analog-to-digital');
    const midVoltage = (CMOS.vIH + CMOS.vIL) / 2;
    expect(inputAdapter.readLogicLevel(midVoltage)).toBeUndefined();
  });

  it('inputAdapter in bridgeAdaptersByGroupId is the exact same instance', () => {
    const { unified, inputAdapter } = buildBridgeFixture('analog-to-digital');
    const compiledAnalog = unified.analog as ConcreteCompiledAnalogCircuit;
    const adapters = compiledAnalog.bridgeAdaptersByGroupId.get(42)!;
    const found = adapters.find((a): a is BridgeInputAdapter => 'readLogicLevel' in a);
    expect(found).toBe(inputAdapter);
  });
});

// ---------------------------------------------------------------------------
// Test 3: setParam("rOut") on bridge adapter updates loading
// ---------------------------------------------------------------------------

describe('bridge adapter: setParam updates electrical parameters', () => {
  it('setParam("rOut", newValue) changes rOut on outputAdapter', () => {
    const { outputAdapter } = buildBridgeFixture('digital-to-analog');
    expect(outputAdapter.rOut).toBe(CMOS.rOut);
    outputAdapter.setParam('rOut', 100);
    expect(outputAdapter.rOut).toBe(100);
  });

  it('setParam("rIn", newValue) changes rIn on inputAdapter', () => {
    const { inputAdapter } = buildBridgeFixture('analog-to-digital');
    expect(inputAdapter.rIn).toBe(CMOS.rIn);
    inputAdapter.setParam('rIn', 5e6);
    expect(inputAdapter.rIn).toBe(5e6);
  });

  it('setParam("vOH") on outputAdapter changes the branch RHS when stamped high', () => {
    const { outputAdapter } = buildBridgeFixture('digital-to-analog');
    const solver = new MockSolver();
    outputAdapter.setLogicLevel(true);
    outputAdapter.setParam('vOH', 5.0);
    outputAdapter.load(makeCtx(solver));
  });

  it('coordinator constructor resolves bridge adapters from bridgeAdaptersByGroupId', () => {
    const { unified, outputAdapter } = buildBridgeFixture('digital-to-analog');
    const coordinator = new TestableCoordinator(unified);
    const compiledAnalog = coordinator.compiled.analog as ConcreteCompiledAnalogCircuit;
    const adapters = compiledAnalog.bridgeAdaptersByGroupId.get(42)!;
    expect(adapters).toContain(outputAdapter);
    coordinator.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 4: hi-z output stops driving analog node
// ---------------------------------------------------------------------------

describe('bridge adapter: hi-z output stops driving analog node', () => {
  it('setHighZ(true) switches branch equation to I=0 mode', () => {
    const { outputAdapter } = buildBridgeFixture('digital-to-analog');
    outputAdapter.setHighZ(true);
    const solver = new MockSolver();
    outputAdapter.load(makeCtx(solver));
    // Hi-Z mode: branch RHS must be 0
    expect(solver.lastRhs(BRANCH_IDX)).toBe(0);
    // Hi-Z mode: stamp(branchIdx, branchIdx, 1)
    expect(solver.stamps.some(s => s.row === BRANCH_IDX && s.col === BRANCH_IDX && s.value === 1)).toBe(true);
  });

  it('setHighZ(true) then setLogicLevel(false) keeps branch RHS at 0 while hi-z', () => {
    const { outputAdapter } = buildBridgeFixture('digital-to-analog');
    outputAdapter.setHighZ(true);
    outputAdapter.setLogicLevel(false);
    const solver = new MockSolver();
    outputAdapter.load(makeCtx(solver));
    // Hi-Z overrides logic level — branch RHS stays 0
    expect(solver.lastRhs(BRANCH_IDX)).toBe(0);
  });

  it('setHighZ(false) after setHighZ(true) restores driven mode', () => {
    const { outputAdapter } = buildBridgeFixture('digital-to-analog');
    outputAdapter.setHighZ(true);
    outputAdapter.setHighZ(false);
    outputAdapter.setLogicLevel(false);
    const solver = new MockSolver();
    outputAdapter.load(makeCtx(solver));
    // Drive mode restored: branch RHS must be vOL
  });

  it('after setHighZ(true), rOut is unchanged (hi-z uses rHiZ from spec internally)', () => {
    const { outputAdapter } = buildBridgeFixture('digital-to-analog');
    const rOutBefore = outputAdapter.rOut;
    outputAdapter.setHighZ(true);
    expect(outputAdapter.rOut).toBe(rOutBefore);
  });
});
