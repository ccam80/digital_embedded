/**
 * Bus resolution subsystem.
 *
 * Handles nets where multiple components drive the same wire (tri-state buses,
 * bidirectional lines, switches). When a net has multiple output drivers, the
 * bus resolver determines the net's value by combining all driver outputs.
 *
 * Resolution logic (per bus net, on every change):
 *   1. For each driver, get its value and highZ mask.
 *   2. A bit is high-Z only if ALL drivers assert high-Z on that bit (AND of
 *      all highZ masks).
 *   3. The resolved value is the OR of all non-high-Z driver values.
 *   4. Burn detection: two non-high-Z drivers that disagree on a bit are a
 *      bus conflict. Detection is deferred to post-step — transient conflicts
 *      are normal during propagation.
 *   5. Pull resistors: if the net has a pull-up, floating bits resolve to 1.
 *      Pull-down: floating bits resolve to 0.
 *
 * Switch-driven net merging: when a switch closes, two bus nets merge into one
 * logical net. When it opens, they separate. This reconfigures which driver
 * net IDs contribute to the output net.
 *
 */

import { BurnException } from "@/core/errors.js";

// ---------------------------------------------------------------------------
// PullResistor — pull-up / pull-down / none
// ---------------------------------------------------------------------------

export type PullResistor = "up" | "down" | "none";

// ---------------------------------------------------------------------------
// BusNet — one multi-driver net
// ---------------------------------------------------------------------------

/**
 * Manages a single net that has multiple output drivers.
 *
 * Holds the set of driver net IDs, a pull-resistor configuration, and the
 * output net ID to which the resolved value is written.
 *
 * All driver net IDs are indices into the engine's state/highZ Uint32Arrays.
 * The output net ID is the index of the net whose value this BusNet controls.
 */
export class BusNet {
  private readonly _outputNetId: number;
  private _driverNetIds: number[];
  private readonly _pull: PullResistor;
  private _burnDetected = false;
  private _conflictingValues: number[] = [];

  constructor(
    outputNetId: number,
    driverNetIds: number[],
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

  /**
   * Add an extra driver net to this bus (used when a switch closes and
   * two buses merge).
   */
  addDriverNet(netId: number): void {
    if (!this._driverNetIds.includes(netId)) {
      this._driverNetIds.push(netId);
    }
  }

  /**
   * Remove a driver net from this bus (used when a switch opens).
   */
  removeDriverNet(netId: number): void {
    this._driverNetIds = this._driverNetIds.filter((id) => id !== netId);
  }

  /**
   * Recombine all driver values and write the resolved result to the output
   * net slot in the state arrays.
   *
   * Resolution rules:
   *   - highZ mask for output bit i = AND of all driver highZ masks at bit i
   *     (a bit is floating only when ALL drivers float it)
   *   - value for non-floating bit i = OR of all non-high-Z driver values at bit i
   *   - pull resistor: floating bits become 1 (pull-up) or 0 (pull-down)
   *   - burn: two drivers both non-high-Z but with different bit values
   */
  recalculate(state: Uint32Array, highZState: Uint32Array): void {
    if (this._driverNetIds.length === 0) {
      // No drivers: full high-Z
      state[this._outputNetId] = 0;
      highZState[this._outputNetId] = 0xffffffff;
      this._burnDetected = false;
      this._conflictingValues = [];
      return;
    }

    // Start: assume all bits are high-Z (AND identity is all-ones)
    let combinedHighZ = 0xffffffff;
    let combinedValue = 0;
    let burnMask = 0; // bits where two non-high-Z drivers disagree

    // Collect each driver's contribution
    // We track the "committed value" built so far bit-by-bit so we can detect
    // conflicts when a second non-high-Z driver drives the same bit differently.
    let committedValue = 0; // value contributed by the first non-high-Z driver per bit
    let committedMask = 0;  // bits that have at least one non-high-Z driver

    for (const driverId of this._driverNetIds) {
      const driverValue = state[driverId] ?? 0;
      const driverHighZ = highZState[driverId] ?? 0xffffffff;

      // A bit is high-Z from this driver when its highZ mask bit is set
      const driverNonHighZ = ~driverHighZ; // bits this driver is actively driving

      // Combined high-Z: only bits where ALL drivers are high-Z remain high-Z
      combinedHighZ &= driverHighZ;

      // For non-high-Z bits from this driver: OR into combined value
      combinedValue |= driverValue & driverNonHighZ;

      // Burn detection: a bit already committed (non-high-Z from a prior
      // driver) that this driver also drives but to a different value
      const newNonHighZ = driverNonHighZ & ~burnMask; // skip bits already burning
      const alreadyDriven = committedMask & newNonHighZ;
      // Conflict: both drive the bit, values differ
      const conflict = alreadyDriven & (committedValue ^ (driverValue & driverNonHighZ));
      burnMask |= conflict;

      // Add new non-high-Z bits from this driver to the committed set
      committedValue |= driverValue & newNonHighZ;
      committedMask |= newNonHighZ;
    }

    // Apply pull resistors to floating (still-high-Z after combining) bits
    const floatingBits = combinedHighZ;
    if (floatingBits !== 0) {
      if (this._pull === "up") {
        // Pull-up: floating bits become 1, no longer high-Z
        combinedValue |= floatingBits;
        combinedHighZ = 0;
      } else if (this._pull === "down") {
        // Pull-down: floating bits become 0, no longer high-Z
        // (combinedValue bits are already 0 for floating positions)
        combinedHighZ = 0;
      }
      // 'none': floating bits remain high-Z — combinedHighZ unchanged
    }

    // Mask burn to only non-high-Z bits in the final output (burns on
    // otherwise-floating bits are irrelevant)
    burnMask &= ~combinedHighZ;

    state[this._outputNetId] = combinedValue >>> 0;
    highZState[this._outputNetId] = combinedHighZ >>> 0;

    if (burnMask !== 0) {
      this._burnDetected = true;
      this._conflictingValues = [combinedValue, burnMask];
    } else {
      this._burnDetected = false;
      this._conflictingValues = [];
    }
  }

  /**
   * Check whether a burn persists after the propagation step has settled.
   * Returns a BurnException if burn is detected, undefined otherwise.
   *
   * Per the spec, burn detection is deferred to post-step. Transient conflicts
   * during propagation are normal; only persistent conflicts are errors.
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
// SwitchRecord — tracks a registered switch and its current state
// ---------------------------------------------------------------------------

interface SwitchRecord {
  readonly switchId: number;
  /** Net IDs that are joined when this switch is closed. */
  readonly netA: number;
  readonly netB: number;
  closed: boolean;
}

// ---------------------------------------------------------------------------
// BusResolver — manages all bus nets in a compiled circuit
// ---------------------------------------------------------------------------

/**
 * Manages all multi-driver nets in a circuit.
 *
 * Each bus net is registered with `addBusNet()`. When a driver net changes,
 * `onNetChanged()` triggers recalculation of affected bus nets. After a full
 * propagation step, `checkAllBurns()` returns any persistent conflicts.
 *
 * Switch-driven merging: `reconfigureForSwitch()` adds/removes driver nets
 * from the affected bus when a switch opens or closes.
 */
export class BusResolver {
  private readonly _busNets: Map<number, BusNet> = new Map();
  // Map from driver net ID → set of output net IDs it contributes to
  private readonly _driverToOutputs: Map<number, Set<number>> = new Map();
  private readonly _switches: Map<number, SwitchRecord> = new Map();

  /**
   * Register a bus net.
   *
   * @param outputNetId   The net ID whose value this bus resolves.
   * @param driverNetIds  The net IDs of all drivers on this bus.
   * @param pullResistor  Pull-up, pull-down, or none.
   */
  addBusNet(
    outputNetId: number,
    driverNetIds: number[],
    pullResistor: PullResistor,
  ): void {
    const busNet = new BusNet(outputNetId, driverNetIds, pullResistor);
    this._busNets.set(outputNetId, busNet);

    for (const driverId of driverNetIds) {
      this._registerDriverToOutput(driverId, outputNetId);
    }
  }

  /**
   * Called when a driver net changes value. Recalculates all bus nets that
   * include this driver.
   */
  onNetChanged(
    netId: number,
    state: Uint32Array,
    highZState: Uint32Array,
  ): void {
    const outputs = this._driverToOutputs.get(netId);
    if (outputs === undefined) return;

    for (const outputNetId of outputs) {
      const busNet = this._busNets.get(outputNetId);
      if (busNet !== undefined) {
        busNet.recalculate(state, highZState);
      }
    }
  }

  /**
   * Check all registered bus nets for persistent burn conditions.
   * Call this after a full propagation step has settled.
   *
   * Returns an array of BurnExceptions for any nets still in conflict.
   */
  checkAllBurns(): BurnException[] {
    const errors: BurnException[] = [];
    for (const busNet of this._busNets.values()) {
      const err = busNet.checkBurn();
      if (err !== undefined) {
        errors.push(err);
      }
    }
    return errors;
  }

  /**
   * Register a switch component so its open/close state can merge or split
   * bus nets.
   *
   * @param switchId  The component index of the switch.
   * @param netA      Net ID on one side of the switch.
   * @param netB      Net ID on the other side of the switch.
   */
  registerSwitch(switchId: number, netA: number, netB: number): void {
    this._switches.set(switchId, { switchId, netA, netB, closed: false });
  }

  /**
   * Update the bus topology when a switch opens or closes.
   *
   * When the switch closes, netB is added as a driver to the bus net that
   * drives netA (and vice versa, if both are bus outputs). When it opens,
   * the added driver is removed.
   */
  reconfigureForSwitch(switchId: number, closed: boolean): void {
    const sw = this._switches.get(switchId);
    if (sw === undefined) return;
    if (sw.closed === closed) return; // no change

    sw.closed = closed;

    if (closed) {
      // Merge: add each net as a driver of the other's bus
      this._addCrossDriver(sw.netA, sw.netB);
      this._addCrossDriver(sw.netB, sw.netA);
    } else {
      // Split: remove the cross-drivers
      this._removeCrossDriver(sw.netA, sw.netB);
      this._removeCrossDriver(sw.netB, sw.netA);
    }
  }

  /**
   * Return all bus output net IDs. Used by the engine to reset stale values
   * before recalculation after switch reconfiguration.
   */
  getOutputNetIds(): number[] {
    return Array.from(this._busNets.keys());
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _registerDriverToOutput(driverId: number, outputNetId: number): void {
    let set = this._driverToOutputs.get(driverId);
    if (set === undefined) {
      set = new Set();
      this._driverToOutputs.set(driverId, set);
    }
    set.add(outputNetId);
  }

  private _addCrossDriver(busOutputNetId: number, newDriverNetId: number): void {
    const busNet = this._busNets.get(busOutputNetId);
    if (busNet === undefined) return;
    busNet.addDriverNet(newDriverNetId);
    this._registerDriverToOutput(newDriverNetId, busOutputNetId);
  }

  private _removeCrossDriver(busOutputNetId: number, driverNetId: number): void {
    const busNet = this._busNets.get(busOutputNetId);
    if (busNet === undefined) return;
    busNet.removeDriverNet(driverNetId);
    const set = this._driverToOutputs.get(driverNetId);
    if (set !== undefined) {
      set.delete(busOutputNetId);
    }
  }
}
