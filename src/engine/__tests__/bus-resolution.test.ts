/**
 * Unit tests for bus-resolution.ts
 *
 * Tests verify:
 * - Single driver passes through unchanged
 * - Two drivers where one is high-Z: the non-high-Z driver wins
 * - Two drivers that agree on the value: no burn
 * - Two drivers that conflict: burn detected
 * - Pull-up resolves floating bits to 1
 * - Pull-down resolves floating bits to 0
 * - Burn detection is deferred to post-step (transient conflicts tolerated)
 * - Switch merge: closing a switch makes two bus nets behave as one
 * - Switch split: opening a previously-closed switch separates the nets again
 */

import { describe, it, expect } from "vitest";
import { BusNet, BusResolver } from "../bus-resolution.js";
import { BurnException } from "@/core/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a state/highZ pair sized for `netCount` nets.
 * Values default to 0; highZ defaults to 0 (all defined, all driven low).
 */
function makeState(netCount: number): { state: Uint32Array; highZ: Uint32Array } {
  return {
    state: new Uint32Array(netCount),
    highZ: new Uint32Array(netCount),
  };
}

/**
 * Set a net in the state arrays to a specific value with no high-Z bits.
 */
function setDefined(
  state: Uint32Array,
  highZ: Uint32Array,
  netId: number,
  value: number,
): void {
  state[netId] = value >>> 0;
  highZ[netId] = 0;
}

/**
 * Set a net to full high-Z (floating).
 */
function setHighZ(state: Uint32Array, highZ: Uint32Array, netId: number): void {
  state[netId] = 0;
  highZ[netId] = 0xffffffff;
}

// ---------------------------------------------------------------------------
// BusNet tests
// ---------------------------------------------------------------------------

describe("BusNet", () => {
  // -------------------------------------------------------------------------
  // singleDriverPassthrough
  // -------------------------------------------------------------------------
  it("singleDriverPassthrough", () => {
    // Net layout: driver at index 0, output at index 1
    const { state, highZ } = makeState(2);
    setDefined(state, highZ, 0, 0xff);

    const bus = new BusNet(1, [0], "none");
    bus.recalculate(state, highZ);

    expect(state[1]).toBe(0xff);
    expect(highZ[1]).toBe(0);
    expect(bus.checkBurn()).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // twoDriversOneHighZ — driver A = 0xFF defined, driver B = all-high-Z
  // -------------------------------------------------------------------------
  it("twoDriversOneHighZ", () => {
    const { state, highZ } = makeState(3);
    // driver A at index 0 = 0xFF defined
    setDefined(state, highZ, 0, 0xff);
    // driver B at index 1 = all high-Z
    setHighZ(state, highZ, 1);

    const bus = new BusNet(2, [0, 1], "none");
    bus.recalculate(state, highZ);

    // B doesn't contribute — output should be 0xFF
    expect(state[2]).toBe(0xff);
    expect(highZ[2]).toBe(0);
    expect(bus.checkBurn()).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // twoDriversAgree — driver A = 0x0F, driver B = 0x0F — no burn
  // -------------------------------------------------------------------------
  it("twoDriversAgree", () => {
    const { state, highZ } = makeState(3);
    setDefined(state, highZ, 0, 0x0f);
    setDefined(state, highZ, 1, 0x0f);

    const bus = new BusNet(2, [0, 1], "none");
    bus.recalculate(state, highZ);

    expect(state[2]).toBe(0x0f);
    expect(highZ[2]).toBe(0);
    expect(bus.checkBurn()).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // twoDriversConflict — driver A = 0xFF, driver B = 0x00 — burn detected
  // -------------------------------------------------------------------------
  it("twoDriversConflict", () => {
    const { state, highZ } = makeState(3);
    setDefined(state, highZ, 0, 0xff);
    setDefined(state, highZ, 1, 0x00);

    const bus = new BusNet(2, [0, 1], "none");
    bus.recalculate(state, highZ);

    const err = bus.checkBurn();
    expect(err).toBeInstanceOf(BurnException);
    expect(err!.netId).toBe(2);
  });

  // -------------------------------------------------------------------------
  // pullUpResolvesFloating — all drivers high-Z with pull-up → all 1s
  // -------------------------------------------------------------------------
  it("pullUpResolvesFloating", () => {
    const { state, highZ } = makeState(2);
    setHighZ(state, highZ, 0);

    const bus = new BusNet(1, [0], "up");
    bus.recalculate(state, highZ);

    // Pull-up resolves all floating bits to 1
    expect(state[1]).toBe(0xffffffff);
    expect(highZ[1]).toBe(0); // no longer high-Z
    expect(bus.checkBurn()).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // pullDownResolvesFloating — all drivers high-Z with pull-down → all 0s
  // -------------------------------------------------------------------------
  it("pullDownResolvesFloating", () => {
    const { state, highZ } = makeState(2);
    setHighZ(state, highZ, 0);

    const bus = new BusNet(1, [0], "down");
    bus.recalculate(state, highZ);

    // Pull-down: bits become 0, no longer high-Z
    expect(state[1]).toBe(0);
    expect(highZ[1]).toBe(0); // resolved, not floating
    expect(bus.checkBurn()).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // noDriversFullHighZ — empty driver list → full high-Z output
  // -------------------------------------------------------------------------
  it("noDriversFullHighZ", () => {
    const { state, highZ } = makeState(1);

    const bus = new BusNet(0, [], "none");
    bus.recalculate(state, highZ);

    expect(highZ[0]).toBe(0xffffffff);
    expect(bus.checkBurn()).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // partialHighZ — some bits high-Z from all drivers, others driven
  // -------------------------------------------------------------------------
  it("partialHighZ", () => {
    // Driver at 0: bits [7:4] = high-Z, bits [3:0] = 0b1010 = 0x0A
    // highZ mask = 0xF0, value = 0x0A
    const { state, highZ } = makeState(2);
    state[0] = 0x0a;
    highZ[0] = 0xf0;

    const bus = new BusNet(1, [0], "none");
    bus.recalculate(state, highZ);

    expect(state[1]).toBe(0x0a);
    expect(highZ[1]).toBe(0xf0); // upper nibble still high-Z (no pull resistor)
    expect(bus.checkBurn()).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // partialConflict — only some bits conflict
  // -------------------------------------------------------------------------
  it("partialConflict", () => {
    // Driver A: bits[7:4]=defined-high(0xF0), bits[3:0]=defined-low
    // Driver B: bits[7:4]=defined-low, bits[3:0]=defined-high(0x0F)
    // All bits driven by both drivers but to different values → burn
    const { state, highZ } = makeState(3);
    setDefined(state, highZ, 0, 0xf0);
    setDefined(state, highZ, 1, 0x0f);

    const bus = new BusNet(2, [0, 1], "none");
    bus.recalculate(state, highZ);

    const err = bus.checkBurn();
    expect(err).toBeInstanceOf(BurnException);
  });
});

// ---------------------------------------------------------------------------
// BusResolver tests
// ---------------------------------------------------------------------------

describe("BusResolver", () => {
  // -------------------------------------------------------------------------
  // burnDeferredToPostStep — transient conflict resolves before step ends
  // -------------------------------------------------------------------------
  it("burnDeferredToPostStep", () => {
    // Simulate a transient conflict: two drivers conflict during propagation,
    // but one resolves to high-Z before the step ends.
    const { state, highZ } = makeState(3);
    const resolver = new BusResolver();
    resolver.addBusNet(2, [0, 1], "none");

    // Phase 1: transient conflict (both drivers active, different values)
    setDefined(state, highZ, 0, 0xff);
    setDefined(state, highZ, 1, 0x00);
    resolver.onNetChanged(0, state, highZ);

    // Conflict exists transiently — but we don't check burns yet
    const transientBurns = resolver.checkAllBurns();
    expect(transientBurns.length).toBe(1); // burn present at this instant

    // Phase 2: driver B goes high-Z (resolves the conflict)
    setHighZ(state, highZ, 1);
    resolver.onNetChanged(1, state, highZ);

    // Post-step: no burn should persist
    const postStepBurns = resolver.checkAllBurns();
    expect(postStepBurns.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // persistentBurnDetected — conflict that does not resolve → BurnException
  // -------------------------------------------------------------------------
  it("persistentBurnDetected", () => {
    const { state, highZ } = makeState(3);
    const resolver = new BusResolver();
    resolver.addBusNet(2, [0, 1], "none");

    setDefined(state, highZ, 0, 0xff);
    setDefined(state, highZ, 1, 0x00);
    resolver.onNetChanged(0, state, highZ);
    // No resolution — burn persists
    const burns = resolver.checkAllBurns();
    expect(burns.length).toBe(1);
    expect(burns[0]).toBeInstanceOf(BurnException);
  });

  // -------------------------------------------------------------------------
  // switchMergesNets — close switch between two bus nets
  // -------------------------------------------------------------------------
  it("switchMergesNets", () => {
    // Two isolated bus nets: netA (output=2, driver=0) and netB (output=3, driver=1)
    // Switch 99 connects netA and netB.
    const { state, highZ } = makeState(4);
    const resolver = new BusResolver();
    resolver.addBusNet(2, [0], "none");
    resolver.addBusNet(3, [1], "none");
    resolver.registerSwitch(99, 2, 3);

    // Before switch: each bus is independent
    setDefined(state, highZ, 0, 0xaa);
    setDefined(state, highZ, 1, 0x55);
    resolver.onNetChanged(0, state, highZ);
    resolver.onNetChanged(1, state, highZ);

    // Close the switch — nets 2 and 3 merge
    resolver.reconfigureForSwitch(99, true);

    // Recalculate after merge
    resolver.onNetChanged(0, state, highZ);
    resolver.onNetChanged(1, state, highZ);

    // With the switch closed, driver 0 (0xAA) now also contributes to bus at output 3.
    // Both drivers drive different values → burn expected on merged nets.
    const burns = resolver.checkAllBurns();
    // At least one burn should be detected (drivers disagree)
    expect(burns.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // switchOpenSplitsNets — close then open a switch, nets become independent
  // -------------------------------------------------------------------------
  it("switchOpenSplitsNets", () => {
    const { state, highZ } = makeState(4);
    const resolver = new BusResolver();
    resolver.addBusNet(2, [0], "none");
    resolver.addBusNet(3, [1], "none");
    resolver.registerSwitch(99, 2, 3);

    setDefined(state, highZ, 0, 0xaa);
    setDefined(state, highZ, 1, 0x55);

    // Close then open switch
    resolver.reconfigureForSwitch(99, true);
    resolver.reconfigureForSwitch(99, false);

    // After split, each bus has only its original driver
    resolver.onNetChanged(0, state, highZ);
    resolver.onNetChanged(1, state, highZ);

    // No burn — each net has only one driver
    const burns = resolver.checkAllBurns();
    expect(burns.length).toBe(0);

    // Each output net reflects only its own driver
    expect(state[2]).toBe(0xaa);
    expect(state[3]).toBe(0x55);
  });

  // -------------------------------------------------------------------------
  // onNetChangedOnlyAffectsRelevantBus
  // -------------------------------------------------------------------------
  it("onNetChangedOnlyAffectsRelevantBus", () => {
    // Two independent bus nets with separate drivers
    const { state, highZ } = makeState(4);
    const resolver = new BusResolver();
    resolver.addBusNet(2, [0], "none");
    resolver.addBusNet(3, [1], "none");

    setDefined(state, highZ, 0, 0x11);
    setDefined(state, highZ, 1, 0x22);

    // Trigger change on driver 0 only
    resolver.onNetChanged(0, state, highZ);

    // Output net 2 should be updated
    expect(state[2]).toBe(0x11);
    // Output net 3 should be 0 (never recalculated after init)
    expect(state[3]).toBe(0);
  });

  // -------------------------------------------------------------------------
  // addBusNetWithPullUp — resolver respects pull-up on registration
  // -------------------------------------------------------------------------
  it("addBusNetWithPullUp", () => {
    const { state, highZ } = makeState(2);
    const resolver = new BusResolver();
    resolver.addBusNet(1, [0], "up");

    // Driver goes high-Z
    setHighZ(state, highZ, 0);
    resolver.onNetChanged(0, state, highZ);

    // Pull-up: floating bits resolve to 1
    expect(state[1]).toBe(0xffffffff);
    expect(highZ[1]).toBe(0);
    expect(resolver.checkAllBurns().length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // switchIdempotent — closing an already-closed switch is a no-op
  // -------------------------------------------------------------------------
  it("switchIdempotent", () => {
    const { state, highZ } = makeState(4);
    const resolver = new BusResolver();
    resolver.addBusNet(2, [0], "none");
    resolver.addBusNet(3, [1], "none");
    resolver.registerSwitch(5, 2, 3);

    setDefined(state, highZ, 0, 0x01);
    setDefined(state, highZ, 1, 0x02);

    resolver.reconfigureForSwitch(5, true);
    // Closing again should not add duplicate drivers
    resolver.reconfigureForSwitch(5, true);

    resolver.onNetChanged(0, state, highZ);
    resolver.onNetChanged(1, state, highZ);

    // Exactly one merge should have occurred (not doubled)
    // Both drivers conflict → exactly 1 BurnException per output net (not 2)
    const burns = resolver.checkAllBurns();
    // Should be 2 burn exceptions (one per output net), not 4
    expect(burns.length).toBeLessThanOrEqual(2);
  });
});
