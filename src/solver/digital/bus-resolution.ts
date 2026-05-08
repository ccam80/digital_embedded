/**
 * Bus resolution subsystem.
 *
 * Handles nets where multiple components drive the same wire (tri-state buses,
 * bidirectional lines, switches). When a net has multiple output drivers, the
 * bus resolver determines the net's value by combining all driver outputs.
 *
 * Resolution logic (per group, on every change):
 *   1. For each driver, get its value and highZ mask.
 *   2. A bit is high-Z only if ALL drivers assert high-Z on that bit (AND of
 *      all highZ masks).
 *   3. The resolved value is the OR of all non-high-Z driver values.
 *   4. Burn detection: two non-high-Z drivers that disagree on a bit are a
 *      bus conflict. Detection is deferred to post-step- transient conflicts
 *      are normal during propagation.
 *   5. Pull resistors: if the group has a pull-up, floating bits resolve to 1.
 *      Pull-down: floating bits resolve to 0.
 *
 * Switch-driven net merging: when a switch closes, the bus nets on either
 * side are unioned into one logical BusGroup whose driver list is the union
 * of both sides' shadow drivers. Resolution writes the same value to every
 * member output net. When a switch opens, groups are rebuilt from scratch
 * (singletons per BusNet, then unioned for every still-closed switch).
 *
 * The merge approach intentionally avoids treating a resolved bus output net
 * as a driver of the opposite side- doing so creates a self-feedback path
 * that lets the previous step's value of one side survive into the current
 * step's resolution of the other.
 */

import { BurnException } from "@/core/errors.js";

// ---------------------------------------------------------------------------
// PullResistor- pull-up / pull-down / none
// ---------------------------------------------------------------------------

export type PullResistor = "up" | "down" | "none";

// ---------------------------------------------------------------------------
// resolveBusDrivers- pure resolution math used by both BusNet and BusGroup
// ---------------------------------------------------------------------------

interface ResolutionResult {
  value: number;
  highZ: number;
  burnMask: number;
}

function resolveBusDrivers(
  driverNetIds: readonly number[],
  pull: PullResistor,
  state: Uint32Array,
  highZState: Uint32Array,
): ResolutionResult {
  if (driverNetIds.length === 0) {
    return { value: 0, highZ: 0xffffffff, burnMask: 0 };
  }

  let combinedHighZ = 0xffffffff;
  let combinedValue = 0;
  let burnMask = 0;
  let committedValue = 0;
  let committedMask = 0;

  for (const driverId of driverNetIds) {
    const driverValue = state[driverId] ?? 0;
    const driverHighZ = highZState[driverId] ?? 0xffffffff;
    const driverNonHighZ = ~driverHighZ;

    combinedHighZ &= driverHighZ;
    combinedValue |= driverValue & driverNonHighZ;

    const newNonHighZ = driverNonHighZ & ~burnMask;
    const alreadyDriven = committedMask & newNonHighZ;
    const conflict = alreadyDriven & (committedValue ^ (driverValue & driverNonHighZ));
    burnMask |= conflict;

    committedValue |= driverValue & newNonHighZ;
    committedMask |= newNonHighZ;
  }

  if (combinedHighZ !== 0) {
    if (pull === "up") {
      combinedValue |= combinedHighZ;
      combinedHighZ = 0;
    } else if (pull === "down") {
      combinedHighZ = 0;
    }
  }

  burnMask &= ~combinedHighZ;
  return {
    value: combinedValue >>> 0,
    highZ: combinedHighZ >>> 0,
    burnMask,
  };
}

// ---------------------------------------------------------------------------
// BusNet- registration record for one multi-driver net
// ---------------------------------------------------------------------------

/**
 * Holds the driver list, pull resistor, and output net ID for a single
 * registered multi-driver net.
 *
 * BusNets are immutable configuration records owned by the resolver. Active
 * resolution happens in BusGroup objects that are rebuilt on every switch
 * state change (each BusNet starts as its own singleton group; closed
 * switches union groups together).
 *
 * The recalculate/checkBurn methods on BusNet operate on the bus's own
 * driver list and write to its own output, treating the BusNet as a
 * standalone single-net resolver. The resolver routes through BusGroups
 * when switches are involved.
 */
export class BusNet {
  private readonly _outputNetId: number;
  private readonly _driverNetIds: readonly number[];
  private readonly _pull: PullResistor;
  private _burnDetected = false;
  private _conflictingValues: number[] = [];

  constructor(
    outputNetId: number,
    driverNetIds: readonly number[],
    pull: PullResistor,
  ) {
    this._outputNetId = outputNetId;
    this._driverNetIds = [...driverNetIds];
    this._pull = pull;
  }

  get outputNetId(): number {
    return this._outputNetId;
  }

  get driverNetIds(): readonly number[] {
    return this._driverNetIds;
  }

  get pull(): PullResistor {
    return this._pull;
  }

  /**
   * Recombine all driver values and write the resolved result to the output
   * net slot in the state arrays. Treats this BusNet as a standalone group
   * of one output net.
   */
  recalculate(state: Uint32Array, highZState: Uint32Array): void {
    const r = resolveBusDrivers(this._driverNetIds, this._pull, state, highZState);
    state[this._outputNetId] = r.value;
    highZState[this._outputNetId] = r.highZ;
    if (r.burnMask !== 0) {
      this._burnDetected = true;
      this._conflictingValues = [r.value, r.burnMask];
    } else {
      this._burnDetected = false;
      this._conflictingValues = [];
    }
  }

  /**
   * Check whether a burn persists after the propagation step has settled.
   */
  checkBurn(): BurnException | undefined {
    if (!this._burnDetected) return undefined;
    return new BurnException(
      `Bus conflict on net ${this._outputNetId}: conflicting drivers`,
      {
        netId: this._outputNetId,
        conflictingValues: this._conflictingValues,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// BusGroup- one or more BusNets unioned via closed switches
// ---------------------------------------------------------------------------

/**
 * Active resolution unit. A BusGroup is the union of one or more BusNets
 * that are currently joined by closed switches. Holds the union of all
 * member shadow driver net IDs and writes the resolved value to every
 * member output net.
 *
 * BusGroups are rebuilt from BusNets and the current switch closure set
 * on every reconfigureForSwitch call. They are never mutated outside of
 * rebuild.
 */
class BusGroup {
  outputNetIds: number[];
  driverNetIds: number[];
  pull: PullResistor;
  private _burnDetected = false;
  private _conflictingValues: number[] = [];

  constructor(
    outputNetIds: number[],
    driverNetIds: number[],
    pull: PullResistor,
  ) {
    this.outputNetIds = outputNetIds;
    this.driverNetIds = driverNetIds;
    this.pull = pull;
  }

  recalculate(state: Uint32Array, highZState: Uint32Array): void {
    const r = resolveBusDrivers(this.driverNetIds, this.pull, state, highZState);
    for (let i = 0; i < this.outputNetIds.length; i++) {
      const id = this.outputNetIds[i]!;
      state[id] = r.value;
      highZState[id] = r.highZ;
    }
    if (r.burnMask !== 0) {
      this._burnDetected = true;
      this._conflictingValues = [r.value, r.burnMask];
    } else {
      this._burnDetected = false;
      this._conflictingValues = [];
    }
  }

  checkBurn(): BurnException | undefined {
    if (!this._burnDetected) return undefined;
    const reportedNetId = this.outputNetIds[0]!;
    return new BurnException(
      `Bus conflict on net ${reportedNetId}: conflicting drivers`,
      {
        netId: reportedNetId,
        conflictingValues: this._conflictingValues,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// SwitchRecord- tracks a registered switch and its current state
// ---------------------------------------------------------------------------

interface SwitchRecord {
  readonly switchId: number;
  readonly netA: number;
  readonly netB: number;
  closed: boolean;
}

// ---------------------------------------------------------------------------
// BusResolver- manages all bus nets in a compiled circuit
// ---------------------------------------------------------------------------

/**
 * Manages all multi-driver nets in a circuit.
 *
 * Each bus net is registered with `addBusNet()`. Each switch is registered
 * with `registerSwitch()` and toggled via `reconfigureForSwitch()`. Active
 * resolution happens through BusGroups, which are rebuilt whenever any
 * switch changes state.
 *
 * `onNetChanged(driverNetId)` recalculates exactly the groups whose driver
 * list contains that net. `checkAllBurns()` returns persistent conflicts
 * after a full propagation step has settled.
 */
export class BusResolver {
  private readonly _busNets: Map<number, BusNet> = new Map();
  private readonly _switches: Map<number, SwitchRecord> = new Map();

  // Active grouping- rebuilt lazily before the first read after any
  // configuration change.
  private _groups: BusGroup[] = [];
  private readonly _busNetToGroup: Map<number, BusGroup> = new Map();
  private readonly _driverToGroups: Map<number, Set<BusGroup>> = new Map();
  private _groupsDirty = true;

  /**
   * Register a bus net.
   */
  addBusNet(
    outputNetId: number,
    driverNetIds: number[],
    pullResistor: PullResistor,
  ): void {
    this._busNets.set(outputNetId, new BusNet(outputNetId, driverNetIds, pullResistor));
    this._groupsDirty = true;
  }

  /**
   * Register a switch component so its open/close state can merge or split
   * bus nets.
   */
  registerSwitch(switchId: number, netA: number, netB: number): void {
    this._switches.set(switchId, { switchId, netA, netB, closed: false });
    this._groupsDirty = true;
  }

  /**
   * Update the bus topology when a switch opens or closes. Triggers a group
   * rebuild on the next read.
   */
  reconfigureForSwitch(switchId: number, closed: boolean): void {
    const sw = this._switches.get(switchId);
    if (sw === undefined) return;
    if (sw.closed === closed) return;
    sw.closed = closed;
    this._groupsDirty = true;
  }

  /**
   * Called when a driver net changes value. Recalculates every group whose
   * driver list contains this net.
   */
  onNetChanged(
    netId: number,
    state: Uint32Array,
    highZState: Uint32Array,
  ): void {
    this._ensureGroupsBuilt();
    const groups = this._driverToGroups.get(netId);
    if (groups === undefined) return;
    for (const group of groups) {
      group.recalculate(state, highZState);
    }
  }

  /**
   * Check every active group for persistent burn conditions. Call this
   * after a full propagation step has settled.
   */
  checkAllBurns(): BurnException[] {
    this._ensureGroupsBuilt();
    const errors: BurnException[] = [];
    for (const group of this._groups) {
      const err = group.checkBurn();
      if (err !== undefined) errors.push(err);
    }
    return errors;
  }

  /**
   * Return all bus output net IDs. Used by the engine to reset stale values
   * before recalculation after switch reconfiguration.
   */
  getOutputNetIds(): number[] {
    return Array.from(this._busNets.keys());
  }

  // -------------------------------------------------------------------------
  // Group rebuild
  // -------------------------------------------------------------------------

  private _ensureGroupsBuilt(): void {
    if (!this._groupsDirty) return;
    this._rebuildGroups();
    this._groupsDirty = false;
  }

  private _rebuildGroups(): void {
    this._groups = [];
    this._busNetToGroup.clear();
    this._driverToGroups.clear();

    // Each BusNet starts as its own singleton group.
    for (const [outputNetId, busNet] of this._busNets) {
      const group = new BusGroup(
        [outputNetId],
        [...busNet.driverNetIds],
        busNet.pull,
      );
      this._busNetToGroup.set(outputNetId, group);
      this._groups.push(group);
    }

    // For each closed switch, union the groups containing its endpoint nets.
    // Chained switches transitively merge their groups into one logical net.
    for (const sw of this._switches.values()) {
      if (!sw.closed) continue;
      const groupA = this._busNetToGroup.get(sw.netA);
      const groupB = this._busNetToGroup.get(sw.netB);
      if (groupA === undefined || groupB === undefined) continue;
      if (groupA === groupB) continue;
      this._unionGroups(groupA, groupB);
    }

    // Build the driver-net → groups index used by onNetChanged.
    for (const group of this._groups) {
      for (const driverId of group.driverNetIds) {
        let set = this._driverToGroups.get(driverId);
        if (set === undefined) {
          set = new Set();
          this._driverToGroups.set(driverId, set);
        }
        set.add(group);
      }
    }
  }

  private _unionGroups(target: BusGroup, source: BusGroup): void {
    for (const id of source.outputNetIds) target.outputNetIds.push(id);
    for (const id of source.driverNetIds) target.driverNetIds.push(id);

    // Combine pull resistors: pull-up dominates pull-down dominates none.
    if (target.pull === "none") {
      target.pull = source.pull;
    } else if (target.pull === "down" && source.pull === "up") {
      target.pull = "up";
    }

    for (const id of source.outputNetIds) {
      this._busNetToGroup.set(id, target);
    }

    const idx = this._groups.indexOf(source);
    if (idx >= 0) this._groups.splice(idx, 1);
  }
}
