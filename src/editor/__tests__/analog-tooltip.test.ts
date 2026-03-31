/**
 * Tests for AnalogTooltip.
 *
 * Uses vitest fake timers for the 200ms hover delay tests.
 * Uses lightweight mock objects — no DOM, no canvas required for the
 * logic-only tests (wire voltage, component current/power, delay, leave).
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { AnalogTooltip } from "@/editor/analog-tooltip";
import { MockCoordinator } from "@/test-utils/mock-coordinator";
import type { HitResult } from "@/editor/hit-test";
import { Wire } from "@/core/circuit";
import type { CircuitElement } from "@/core/element";
import type { SignalAddress } from "@/compile/types";
import type { CurrentResolverContext } from "@/solver/coordinator-types";
import type { AnalogElement } from "@/solver/analog/element";

// ---------------------------------------------------------------------------
// Minimal mocks
// ---------------------------------------------------------------------------

function makeWire(): Wire {
  return new Wire({ x: 0, y: 0 }, { x: 10, y: 0 });
}

function makeCircuitElement(): CircuitElement {
  return {
    getPins: () => [],
    getBoundingBox: () => ({ x: 0, y: 0, width: 10, height: 10 }),
    position: { x: 0, y: 0 },
    rotation: 0,
    mirror: false,
  } as unknown as CircuitElement;
}

class TestCoordinator extends MockCoordinator {
  private _wireSignalMap = new Map<Wire, SignalAddress>();
  private _labelSignalMap = new Map<string, SignalAddress>();
  private _pinVoltagesMap = new Map<CircuitElement, Map<string, number>>();
  private _resolverCtx: CurrentResolverContext | null = null;
  private _elementCurrents = new Map<number, number>();
  private _elementPowers = new Map<number, number>();

  setWireSignal(wire: Wire, nodeId: number, voltage: number): void {
    const addr: SignalAddress = { domain: 'analog', nodeId };
    this._wireSignalMap.set(wire, addr);
    this.setSignal(addr, { type: 'analog', voltage });
  }

  setElementData(
    element: CircuitElement,
    elementIndex: number,
    current: number,
    power: number,
  ): void {
    const elementMap = new Map<number, CircuitElement>([[elementIndex, element]]);
    this._resolverCtx = {
      wireToNodeId: new Map(),
      elements: [] as unknown as readonly AnalogElement[],
      elementToCircuitElement: elementMap,
      circuitElements: [element],
      getElementPinCurrents: () => [],
    };
    this._elementCurrents.set(elementIndex, current);
    this._elementPowers.set(elementIndex, power);
  }

  override get compiled(): { wireSignalMap: ReadonlyMap<Wire, SignalAddress>; labelSignalMap: ReadonlyMap<string, SignalAddress>; diagnostics: readonly import("@/compile/types").Diagnostic[] } {
    return {
      wireSignalMap: this._wireSignalMap,
      labelSignalMap: this._labelSignalMap,
      diagnostics: [],
    };
  }

  override getPinVoltages(element: CircuitElement): Map<string, number> | null {
    return this._pinVoltagesMap.get(element) ?? null;
  }

  override getCurrentResolverContext(): CurrentResolverContext | null {
    return this._resolverCtx;
  }

  override readElementCurrent(elementIndex: number): number | null {
    return this._elementCurrents.get(elementIndex) ?? null;
  }

  override readElementPower(elementIndex: number): number | null {
    return this._elementPowers.get(elementIndex) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Tooltip", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("wire_shows_voltage", () => {
    const wire = makeWire();
    const coord = new TestCoordinator();
    coord.setWireSignal(wire, 3, 3.3);

    const tooltip = new AnalogTooltip(coord, { getWireCurrent: () => undefined, clear: () => {}, resolve: () => {} } as any);

    const hit: HitResult = { type: "wire", wire };
    vi.useFakeTimers();
    tooltip.onMouseMove(100, 100, hit);
    vi.advanceTimersByTime(250);

    expect(tooltip.text).toBe("3.30 V");
    expect(tooltip.visible).toBe(true);
  });

  it("component_shows_current_and_power", () => {
    const element = makeCircuitElement();
    const coord = new TestCoordinator();
    coord.setElementData(element, 0, 0.005, 0.025);

    const tooltip = new AnalogTooltip(coord, { getWireCurrent: () => undefined, clear: () => {}, resolve: () => {} } as any);

    const hit: HitResult = { type: "element", element };
    vi.useFakeTimers();
    tooltip.onMouseMove(50, 50, hit);
    vi.advanceTimersByTime(250);

    expect(tooltip.text).toContain("5.00 mA");
    expect(tooltip.text).toContain("25.0 mW");
    expect(tooltip.visible).toBe(true);
  });

  it("delay_200ms", () => {
    vi.useFakeTimers();

    const wire = makeWire();
    const coord = new TestCoordinator();
    coord.setWireSignal(wire, 1, 1.0);

    const tooltip = new AnalogTooltip(coord, { getWireCurrent: () => undefined, clear: () => {}, resolve: () => {} } as any);

    const hit: HitResult = { type: "wire", wire };
    tooltip.onMouseMove(0, 0, hit);

    // At 100ms — not yet visible.
    vi.advanceTimersByTime(100);
    expect(tooltip.visible).toBe(false);

    // At 250ms total (100 + 150) — now visible.
    vi.advanceTimersByTime(150);
    expect(tooltip.visible).toBe(true);
  });

  it("disappears_on_leave", () => {
    vi.useFakeTimers();

    const wire = makeWire();
    const coord = new TestCoordinator();
    coord.setWireSignal(wire, 1, 5.0);

    const tooltip = new AnalogTooltip(coord, { getWireCurrent: () => undefined, clear: () => {}, resolve: () => {} } as any);

    const hit: HitResult = { type: "wire", wire };
    tooltip.onMouseMove(0, 0, hit);
    vi.advanceTimersByTime(250);
    expect(tooltip.visible).toBe(true);

    // Leave — tooltip must disappear immediately.
    tooltip.onMouseLeave();
    expect(tooltip.visible).toBe(false);
  });
});
