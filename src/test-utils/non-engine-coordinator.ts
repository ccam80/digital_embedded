/**
 * `buildNonEngineCoordinator` — single sanctioned coordinator stand-in for
 * non-engine (UI / integration / app-bridge) tests.
 *
 * Stands up a plain object that satisfies every narrow consumer interface
 * declared in `solver/coordinator-types` (TooltipDataSource, ScopeDataSource,
 * SliderBridgeDataSource, TimingDiagramDataSource, EditorBindingDataSource,
 * TestBridgeDataSource, DataTableDataSource). Tests pass it directly to the
 * consumer they are exercising; production code keeps using the real
 * `SimulationCoordinator`.
 *
 * NOT an engine impersonator. Holds no state machine, no NR loop, no
 * matrix, no element life-cycle. The MNA / digital engines are tested via
 * `buildFixture` (`src/solver/analog/__tests__/fixtures/build-fixture.ts`).
 * If a UI test needs real engine behaviour, use `buildFixture` and pass
 * `fixture.coordinator` instead.
 *
 * When `SimulationCoordinator` grows or renames a method that one of the
 * narrow interfaces names, this factory is the single place to update.
 */

import type {
  DataTableDataSource,
  EditorBindingDataSource,
  ScopeDataSource,
  SliderBridgeDataSource,
  TestBridgeDataSource,
  TimingDiagramDataSource,
  TooltipDataSource,
  CurrentResolverContext,
} from "@/solver/coordinator-types";
import type { MeasurementObserver, SnapshotId } from "@/core/engine-interface";
import type { SignalAddress, SignalValue } from "@/compile/types";
import type { Wire } from "@/core/circuit";
import type { CircuitElement } from "@/core/element";

export interface WriteCall {
  readonly addr: SignalAddress;
  readonly value: SignalValue;
}

export interface SetComponentPropertyCall {
  readonly element: CircuitElement;
  readonly key: string;
  readonly value: number;
}

export interface NonEngineCoordinatorOptions {
  /** Initial labelled signals — keyed by label, used by `readByLabel` and `readAllSignals`. */
  signalsByLabel?: ReadonlyMap<string, SignalValue>;
  /** Initial wire→address map (the tooltip / wire-current paths read this via `compiled`). */
  wireSignalMap?: ReadonlyMap<Wire, SignalAddress>;
  /** Initial pin-voltage map: per CircuitElement, a `pinLabel → voltage` map. */
  pinVoltages?: ReadonlyMap<CircuitElement, ReadonlyMap<string, number>>;
  /** Initial element-current readings keyed by element index. */
  elementCurrents?: ReadonlyMap<number, number>;
  /** Initial element-power readings keyed by element index. */
  elementPowers?: ReadonlyMap<number, number>;
  /** Initial branch-current readings keyed by branch index. */
  branchCurrents?: ReadonlyMap<number, number>;
  /** Initial resolver context (null when no analog backend is active). */
  resolverContext?: CurrentResolverContext | null;
  /** Initial sim time. `null` = no analog timeline (pure digital / no engine). */
  simTime?: number | null;
  /** Initial playback rate in sim-seconds per wall-second (defaults to the engine default 1e-3). */
  speed?: number;
}

/**
 * The object returned by `buildNonEngineCoordinator`. Satisfies every narrow
 * consumer interface; also exposes test-only mutators and capture arrays so
 * tests can seed and assert.
 */
export interface NonEngineCoordinator
  extends TooltipDataSource,
    SliderBridgeDataSource,
    TimingDiagramDataSource,
    ScopeDataSource,
    EditorBindingDataSource,
    TestBridgeDataSource,
    DataTableDataSource {
  // --- test mutators ---
  setSignal(addr: SignalAddress, value: SignalValue): void;
  setSignalByLabel(label: string, value: SignalValue): void;
  setWireSignal(wire: Wire, nodeId: number, voltage: number): void;
  setPinVoltages(element: CircuitElement, voltages: ReadonlyMap<string, number>): void;
  setElementCurrent(elementIndex: number, current: number): void;
  setElementPower(elementIndex: number, power: number): void;
  setBranchCurrent(branchIndex: number, current: number): void;
  setResolverContext(ctx: CurrentResolverContext | null): void;
  setSimTime(time: number | null): void;

  // --- test capture (read-only views into recorded calls) ---
  readonly writeCalls: readonly WriteCall[];
  readonly observerCount: number;
  readonly snapshotCalls: { saves: number; restores: SnapshotId[] };
  readonly setComponentPropertyCalls: readonly SetComponentPropertyCall[];
}

function addrKey(addr: SignalAddress): string {
  return JSON.stringify(addr);
}

export function buildNonEngineCoordinator(
  opts: NonEngineCoordinatorOptions = {},
): NonEngineCoordinator {
  // --- backing state ---
  const signalsByAddr = new Map<string, SignalValue>();
  const signalsByLabel = new Map<string, SignalValue>(opts.signalsByLabel ?? []);
  let wireSignalMap = new Map<Wire, SignalAddress>(opts.wireSignalMap ?? []);
  const pinVoltages = new Map<CircuitElement, Map<string, number>>();
  if (opts.pinVoltages !== undefined) {
    for (const [el, voltages] of opts.pinVoltages) {
      pinVoltages.set(el, new Map(voltages));
    }
  }
  const elementCurrents = new Map<number, number>(opts.elementCurrents ?? []);
  const elementPowers = new Map<number, number>(opts.elementPowers ?? []);
  const branchCurrents = new Map<number, number>(opts.branchCurrents ?? []);
  let resolverContext: CurrentResolverContext | null = opts.resolverContext ?? null;
  let simTime: number | null = opts.simTime ?? null;
  const speed: number = opts.speed ?? 1e-3;

  // --- capture ---
  const writeCalls: WriteCall[] = [];
  const observers = new Set<MeasurementObserver>();
  const snapshotCalls = { saves: 0, restores: [] as SnapshotId[] };
  const setComponentPropertyCalls: SetComponentPropertyCall[] = [];
  let nextSnapshotId = 0;

  return {
    // --- TooltipDataSource / EditorBindingDataSource shared `compiled` shape ---
    get compiled() {
      return { wireSignalMap };
    },

    readSignal(addr: SignalAddress): SignalValue {
      return signalsByAddr.get(addrKey(addr)) ?? { type: "digital", value: 0 };
    },

    writeSignal(addr: SignalAddress, value: SignalValue): void {
      writeCalls.push({ addr, value });
    },

    readByLabel(label: string): SignalValue {
      return signalsByLabel.get(label) ?? { type: "digital", value: 0 };
    },

    readAllSignals(): Map<string, SignalValue> {
      return new Map(signalsByLabel);
    },

    getPinVoltages(element: CircuitElement): Map<string, number> | null {
      const m = pinVoltages.get(element);
      return m === undefined ? null : new Map(m);
    },

    getCurrentResolverContext(): CurrentResolverContext | null {
      return resolverContext;
    },

    setComponentProperty(element: CircuitElement, key: string, value: number): void {
      setComponentPropertyCalls.push({ element, key, value });
    },

    readElementCurrent(elementIndex: number): number | null {
      return elementCurrents.get(elementIndex) ?? null;
    },

    readElementPower(elementIndex: number): number | null {
      return elementPowers.get(elementIndex) ?? null;
    },

    readBranchCurrent(branchIndex: number): number | null {
      return branchCurrents.get(branchIndex) ?? null;
    },

    saveSnapshot(): SnapshotId {
      snapshotCalls.saves++;
      return nextSnapshotId++ as SnapshotId;
    },

    restoreSnapshot(id: SnapshotId): void {
      snapshotCalls.restores.push(id);
    },

    addMeasurementObserver(observer: MeasurementObserver): void {
      observers.add(observer);
    },

    removeMeasurementObserver(observer: MeasurementObserver): void {
      observers.delete(observer);
    },

    get simTime(): number | null {
      return simTime;
    },

    get speed(): number {
      return speed;
    },

    // --- test mutators ---
    setSignal(addr: SignalAddress, value: SignalValue): void {
      signalsByAddr.set(addrKey(addr), value);
    },

    setSignalByLabel(label: string, value: SignalValue): void {
      signalsByLabel.set(label, value);
    },

    setWireSignal(wire: Wire, nodeId: number, voltage: number): void {
      const addr: SignalAddress = { domain: "analog", nodeId };
      wireSignalMap = new Map(wireSignalMap);
      wireSignalMap.set(wire, addr);
      signalsByAddr.set(addrKey(addr), { type: "analog", voltage });
    },

    setPinVoltages(element: CircuitElement, voltages: ReadonlyMap<string, number>): void {
      pinVoltages.set(element, new Map(voltages));
    },

    setElementCurrent(elementIndex: number, current: number): void {
      elementCurrents.set(elementIndex, current);
    },

    setElementPower(elementIndex: number, power: number): void {
      elementPowers.set(elementIndex, power);
    },

    setBranchCurrent(branchIndex: number, current: number): void {
      branchCurrents.set(branchIndex, current);
    },

    setResolverContext(ctx: CurrentResolverContext | null): void {
      resolverContext = ctx;
    },

    setSimTime(time: number | null): void {
      simTime = time;
    },

    // --- test capture views ---
    get writeCalls(): readonly WriteCall[] {
      return writeCalls;
    },

    get observerCount(): number {
      return observers.size;
    },

    get snapshotCalls() {
      return snapshotCalls;
    },

    get setComponentPropertyCalls(): readonly SetComponentPropertyCall[] {
      return setComponentPropertyCalls;
    },
  };
}
