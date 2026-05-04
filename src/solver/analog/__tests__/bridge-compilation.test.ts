/**
 * Tests for bridge MNA element integration in compileAnalogPartition.
 *
 * Task 1.6: Verifies that bridge stubs produce BridgeOutputAdapter /
 * BridgeInputAdapter MNA elements, keyed by group ID in
 * bridgeAdaptersByGroupId, and that loading flags honour digitalPinLoading.
 */

import { describe, it, expect } from 'vitest';
import { MODEDCOP, MODEINITFLOAT } from '../ckt-mode.js';
import { compileAnalogPartition } from '../compiler.js';
import type {
  SolverPartition,
  ConnectivityGroup,
  BridgeStub,
  BridgeDescriptor,
  PartitionedComponent,
} from '../../../compile/types.js';
import type { BridgeOutputAdapter, BridgeInputAdapter } from '../bridge-adapter.js';
import { ComponentRegistry, ComponentCategory } from '../../../core/registry.js';
import type { StandaloneComponentDefinition } from '../../../core/registry.js';
import { CompositeElement } from '../composite-element.js';
import { loadCtxFromFields, makeTestSetupContext, setupAll } from './test-helpers.js';
import type { MnaSubcircuitNetlist } from '../../../core/mna-subcircuit-netlist.js';
import { PropertyBag } from '../../../core/properties.js';
import { SparseSolver } from '../sparse-solver.js';
import { ResistorDefinition } from '../../../components/passives/resistor.js';

const CMOS_3V3 = { rOut: 50, cOut: 5e-12, rIn: 1e7, cIn: 5e-12, vOH: 3.3, vOL: 0.0, vIH: 2.0, vIL: 0.8, rHiZ: 1e7 };

function makeBoundaryGroup(groupId: number): ConnectivityGroup {
  return { groupId, pins: [], wires: [], domains: new Set(['digital', 'analog']), bitWidth: 1 };
}

function makeStub(group: ConnectivityGroup, direction: 'digital-to-analog' | 'analog-to-digital'): BridgeStub {
  const descriptor: BridgeDescriptor = { boundaryGroup: group, direction, bitWidth: 1, electricalSpec: CMOS_3V3 };
  return { boundaryGroupId: group.groupId, descriptor };
}

function makePartition(stubs: BridgeStub[], groups: ConnectivityGroup[]): SolverPartition {
  return { components: [], groups, bridgeStubs: stubs };
}

function makeCtx(solver: SparseSolver, rhs?: Float64Array) {
  const rhsBuf = rhs ?? new Float64Array(8);
  return loadCtxFromFields({
    solver: solver as any,
    rhs: rhsBuf,
    rhsOld: rhsBuf,
    matrix: solver as any,
    cktMode: MODEDCOP | MODEINITFLOAT,
    dt: 0,
    method: 'trapezoidal' as const,
    order: 1,
    deltaOld: [0, 0, 0, 0, 0, 0, 0],
    ag: new Float64Array(7),
    srcFact: 1,
    noncon: { value: 0 },
    limitingCollector: null,
    convergenceCollector: null,
    xfact: 1,
    gmin: 1e-12,
    reltol: 1e-3,
    iabstol: 1e-12,
    time: 0,
    temp: 300.15,
    vt: 0.025852,
    cktFixLimit: false,
    bypass: false,
    voltTol: 1e-6,
  });
}

describe('bridge-compilation: boundary group adapter creation', () => {
  it('boundary group produces output adapter for digital-to-analog direction', () => {
    const group = makeBoundaryGroup(1);
    const stub = makeStub(group, 'digital-to-analog');
    const partition = makePartition([stub], [group]);
    const compiled = compileAnalogPartition(partition, new ComponentRegistry(), undefined, undefined, undefined, 'cross-domain');
    expect(compiled.bridgeAdaptersByGroupId.has(1)).toBe(true);
    const adapters = compiled.bridgeAdaptersByGroupId.get(1)!;
    expect(adapters).toHaveLength(1);
    expect(adapters[0]).toHaveProperty('setLogicLevel');
  });

  it('boundary group produces input adapter for analog-to-digital direction', () => {
    const group = makeBoundaryGroup(2);
    const stub = makeStub(group, 'analog-to-digital');
    const partition = makePartition([stub], [group]);
    const compiled = compileAnalogPartition(partition, new ComponentRegistry(), undefined, undefined, undefined, 'cross-domain');
    expect(compiled.bridgeAdaptersByGroupId.has(2)).toBe(true);
    const adapters = compiled.bridgeAdaptersByGroupId.get(2)!;
    expect(adapters).toHaveLength(1);
    expect(adapters[0]).toHaveProperty('readLogicLevel');
  });
});

describe('bridge-compilation: bridge output adapter branch index', () => {
  it('bridge output adapter has branch index >= 0', () => {
    const group = makeBoundaryGroup(1);
    const stub = makeStub(group, 'digital-to-analog');
    const partition = makePartition([stub], [group]);
    const compiled = compileAnalogPartition(partition, new ComponentRegistry(), undefined, undefined, undefined, 'cross-domain');
    const adapter = compiled.bridgeAdaptersByGroupId.get(1)![0] as BridgeOutputAdapter;
    expect(adapter.branchIndex).toBeGreaterThanOrEqual(0);
  });
});

describe('bridge-compilation: bridge adapters appear in elements array', () => {
  it('bridge adapters participate in analog elements array', () => {
    const group = makeBoundaryGroup(1);
    const stub = makeStub(group, 'digital-to-analog');
    const partition = makePartition([stub], [group]);
    const compiled = compileAnalogPartition(partition, new ComponentRegistry(), undefined, undefined, undefined, 'cross-domain');
    expect(compiled.elements.length).toBeGreaterThan(0);
    const adapter = compiled.bridgeAdaptersByGroupId.get(1)![0];
    expect(compiled.elements).toContain(adapter);
  });
});

describe('bridge-compilation: none mode bridge adapters are unloaded', () => {
  it('none mode output adapter does not stamp rOut conductance', () => {
    const group = makeBoundaryGroup(1);
    const stub = makeStub(group, 'digital-to-analog');
    const partition = makePartition([stub], [group]);
    const compiled = compileAnalogPartition(partition, new ComponentRegistry(), undefined, undefined, undefined, 'none');
    const adapter = compiled.bridgeAdaptersByGroupId.get(1)![0] as BridgeOutputAdapter;
    const solver = new SparseSolver();
    solver._initStructure();
    solver._resetForAssembly();
    adapter.load(makeCtx(solver));
    // nodeId=1 -> nodeIdx=0. Unloaded: no rOut conductance on diagonal.
    const entries = solver.getCSCNonZeros();
    const diagSum = entries
      .filter((e) => e.row === 0 && e.col === 0)
      .reduce((acc, e) => acc + e.value, 0);
    expect(diagSum).toBe(0);
  });

  it('none mode input adapter stamps nothing', () => {
    const group = makeBoundaryGroup(2);
    const stub = makeStub(group, 'analog-to-digital');
    const partition = makePartition([stub], [group]);
    const compiled = compileAnalogPartition(partition, new ComponentRegistry(), undefined, undefined, undefined, 'none');
    const adapter = compiled.bridgeAdaptersByGroupId.get(2)![0] as BridgeInputAdapter;
    const solver = new SparseSolver();
    solver._initStructure();
    const rhs = new Float64Array(8);
    solver._resetForAssembly();
    adapter.load(makeCtx(solver, rhs));
    const entries = solver.getCSCNonZeros();
    expect(entries.length).toBe(0);
    expect(rhs.every(v => v === 0)).toBe(true);
  });
});

describe('bridge-compilation: cross-domain mode bridge adapters are loaded', () => {
  it('cross-domain mode output adapter stamps rOut conductance', () => {
    const group = makeBoundaryGroup(1);
    const stub = makeStub(group, 'digital-to-analog');
    const partition = makePartition([stub], [group]);
    const compiled = compileAnalogPartition(partition, new ComponentRegistry(), undefined, undefined, undefined, 'cross-domain');
    const adapter = compiled.bridgeAdaptersByGroupId.get(1)![0] as BridgeOutputAdapter;
    const solver = new SparseSolver();
    solver._initStructure();
    solver._resetForAssembly();
    adapter.load(makeCtx(solver));
    // nodeId=1 -> nodeIdx=0. Loaded: 1/rOut on diagonal.
    const entries = solver.getCSCNonZeros();
    const diagSum = entries
      .filter((e) => e.row === 0 && e.col === 0)
      .reduce((acc, e) => acc + e.value, 0);
    expect(diagSum).toBeCloseTo(1 / CMOS_3V3.rOut, 9);
  });
});

describe('bridge-compilation: per-net ideal override produces unloaded adapters', () => {
  it('per-net ideal override on boundary group produces unloaded output adapter', () => {
    const group = makeBoundaryGroup(1);
    group.loadingMode = 'ideal';
    const stub = makeStub(group, 'digital-to-analog');
    const partition = makePartition([stub], [group]);
    const compiled = compileAnalogPartition(partition, new ComponentRegistry(), undefined, undefined, undefined, 'cross-domain');
    const adapter = compiled.bridgeAdaptersByGroupId.get(1)![0] as BridgeOutputAdapter;
    const solver = new SparseSolver();
    solver._initStructure();
    solver._resetForAssembly();
    adapter.load(makeCtx(solver));
    const entries = solver.getCSCNonZeros();
    const diagSum = entries
      .filter((e) => e.row === 0 && e.col === 0)
      .reduce((acc, e) => acc + e.value, 0);
    expect(diagSum).toBe(0);
  });
});

describe('bridge-compilation: bridge output in hi-z mode stamps I=0', () => {
  it('hi-z output stamps I=0 branch equation', () => {
    const group = makeBoundaryGroup(1);
    const stub = makeStub(group, 'digital-to-analog');
    const partition = makePartition([stub], [group]);
    const compiled = compileAnalogPartition(partition, new ComponentRegistry(), undefined, undefined, undefined, 'cross-domain');
    const adapter = compiled.bridgeAdaptersByGroupId.get(1)![0] as BridgeOutputAdapter;
    adapter.setHighZ(true);
    const solver = new SparseSolver();
    solver._initStructure();
    const rhs = new Float64Array(8);
    solver._resetForAssembly();
    adapter.load(makeCtx(solver, rhs));
    expect(rhs[adapter.branchIndex]).toBe(0);
  });
});

describe('bridge-compilation: compileSubcircuitToMnaModel returns CompositeElement subclass (ssA.21 item 3)', () => {
  it('factory returns instanceof CompositeElement and setup propagates _stateBase to sub-elements', () => {
    // Build a minimal subcircuit netlist: one resistor between port A and port B.
    // Ports: ["A", "B"] (indices 0, 1). No internal nets.
    const netlist: MnaSubcircuitNetlist = {
      ports: ["A", "B"],
      internalNetCount: 0,
      elements: [
        { typeId: "Resistor", params: { resistance: 1000 } },
      ],
      netlist: [
        [0, 1], // resistor Aâ†’B maps to net 0 (port A) and net 1 (port B)
      ],
    };

    // Register the Resistor component so the compiler can look it up.
    const registry = new ComponentRegistry();
    registry.register(ResistorDefinition);

    // Build a stub StandaloneComponentDefinition with the subcircuit netlist as a model entry.
    const stubDef: StandaloneComponentDefinition = {
      name: "SubcktResistor",
      typeId: -99,
      factory: (_props: unknown) => { throw new Error("unused"); },
      pinLayout: [
        { label: "A", direction: 0 as any, position: { x: 0, y: 0 } },
        { label: "B", direction: 0 as any, position: { x: 10, y: 0 } },
      ],
      propertyDefs: [],
      attributeMap: [],
      category: ComponentCategory.MISC,
      helpText: "Subcircuit resistor stub",
      defaultModel: "behavioral",
      modelRegistry: {
        behavioral: {
          kind: "netlist",
          netlist,
          paramDefs: [],
          params: { resistance: 1000 },
        },
      },
    } as unknown as StandaloneComponentDefinition;

    registry.register(stubDef);

    // Build a PartitionedComponent for this subcircuit.
    const props = new PropertyBag();
    props.set("model", "behavioral");

    const stubElement = {
      typeId: "SubcktResistor",
      instanceId: "r_sub1",
      position: { x: 0, y: 0 },
      rotation: 0,
      mirror: false,
      getPins() { return [
        { position: { x: 0, y: 0 }, label: "A", direction: 0, isNegated: false, kind: "signal", isClock: false, bitWidth: 1 },
        { position: { x: 10, y: 0 }, label: "B", direction: 0, isNegated: false, kind: "signal", isClock: false, bitWidth: 1 },
      ]; },
      getProperties() { return props; },
      getBoundingBox() { return { x: 0, y: 0, width: 10, height: 10 }; },
      draw() {},
      serialize() { return { typeId: "SubcktResistor", instanceId: "r_sub1", position: { x: 0, y: 0 }, rotation: 0, mirror: false, properties: {} }; },
      getAttribute(k: string) { return props.get(k); },
      setAttribute(k: string, v: any) { props.set(k, v); },
    } as any;

    const pc: PartitionedComponent = {
      element: stubElement,
      definition: stubDef,
      modelKey: "behavioral",
      model: null,
      resolvedPins: [
        {
          elementIndex: 0, pinIndex: 0, pinLabel: "A",
          direction: 0 as any, bitWidth: 1,
          worldPosition: { x: 0, y: 0 }, wireVertex: null, domain: "analog", kind: "signal",
        },
        {
          elementIndex: 0, pinIndex: 1, pinLabel: "B",
          direction: 0 as any, bitWidth: 1,
          worldPosition: { x: 10, y: 0 }, wireVertex: null, domain: "analog", kind: "signal",
        },
      ],
    };

    const group: ConnectivityGroup = {
      groupId: 10,
      pins: [
        {
          elementIndex: 0, pinIndex: 0, pinLabel: "A",
          direction: 0 as any, bitWidth: 1,
          worldPosition: { x: 0, y: 0 }, wireVertex: null, domain: "analog", kind: "signal",
        },
        {
          elementIndex: 0, pinIndex: 1, pinLabel: "B",
          direction: 0 as any, bitWidth: 1,
          worldPosition: { x: 10, y: 0 }, wireVertex: null, domain: "analog", kind: "signal",
        },
      ],
      wires: [],
      domains: new Set(["analog"]),
      bitWidth: 1,
    };
    const group2: ConnectivityGroup = {
      groupId: 11,
      pins: [
        {
          elementIndex: 0, pinIndex: 1, pinLabel: "B",
          direction: 0 as any, bitWidth: 1,
          worldPosition: { x: 10, y: 0 }, wireVertex: null, domain: "analog", kind: "signal",
        },
      ],
      wires: [],
      domains: new Set(["analog"]),
      bitWidth: 1,
    };

    const partition: SolverPartition = {
      components: [pc],
      groups: [group, group2],
      bridgeStubs: [],
    };

    const compiled = compileAnalogPartition(partition, registry);

    // The compiler should have produced exactly one analog element (the composite).
    expect(compiled.elements.length).toBeGreaterThanOrEqual(1);
    const composite = compiled.elements[0];

    // ssA.21 item 3: the factory result must be instanceof CompositeElement.
    expect(composite).toBeInstanceOf(CompositeElement);

    // setup â†’ _stateBase is propagated: after setup, all pool-backed sub-elements
    // within the composite must have _stateBase !== -1.
    // The composite itself gets _stateBase assigned by setupAll.
    const matrixSize = 2;
    const mockSolver = new SparseSolver();
    mockSolver._initStructure();
    const ctx = makeTestSetupContext({ solver: mockSolver as any, startNode: matrixSize + 1, startBranch: matrixSize + 1 });
    setupAll([composite], ctx);

    // After setup, _stateBase on the composite is set by the engine's setupAll.
    // The spec requirement (ssA.21 item 3): getSubElements() forwarding propagates
    // to all sub-elements- verify no sub-element has _stateBase === -1 after
    // super.setup (i.e., the CompositeElement.initState forwarding works).
    // setupAll already assigned _stateBase and called initState via ctx.allocStates.

    const subElements = (composite as any).getSubElements() as any[];
    for (const sub of subElements) {
      if (sub.poolBacked) {
        expect(sub._stateBase).not.toBe(-1);
      }
    }
  });
});
