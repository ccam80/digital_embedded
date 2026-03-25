/**
 * Tests for createTestBridge — lightweight coordinate and state API for E2E tests.
 *
 * Covers the renamed getCircuitDomain() method (was getEngineType) and the
 * updated getAnalogState() that reads from the SimulationCoordinator.
 */

import { describe, it, expect } from "vitest";
import { createTestBridge } from "../test-bridge.js";
import type { TestBridge } from "../test-bridge.js";
import { Circuit } from "@/core/circuit";
import type { SimulationCoordinator } from "@/solver/coordinator-types";
import type { SignalValue } from "@/compile/types";
import { MockCoordinator } from "@/test-utils/mock-coordinator";
import type { ComponentRegistry } from "@/core/registry";
import type { ComponentPalette } from "@/editor/palette";
import type { Viewport } from "@/editor/viewport";

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeCanvas(): HTMLCanvasElement {
  return {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  } as unknown as HTMLCanvasElement;
}

function makeViewport(): Viewport {
  return {
    zoom: 1,
    pan: { x: 0, y: 0 },
  } as unknown as Viewport;
}

function makeRegistry(): ComponentRegistry {
  return {
    get: (_typeId: string) => undefined,
  } as unknown as ComponentRegistry;
}

function makePalette(): ComponentPalette {
  return {} as unknown as ComponentPalette;
}

// ---------------------------------------------------------------------------
// getCircuitDomain tests
// ---------------------------------------------------------------------------

describe("createTestBridge", () => {
  describe("getCircuitDomain", () => {
    it("returns 'digital' when all circuit elements have only digital models", () => {
      const circuit = new Circuit();
      const coordinator = new MockCoordinator();

      const bridge: TestBridge = createTestBridge(
        circuit,
        makeViewport(),
        makeCanvas(),
        makePalette(),
        makeRegistry(),
        coordinator,
      );

      expect(bridge.getCircuitDomain()).toBe('digital');
    });

    it("returns 'digital' for empty circuit", () => {
      const circuit = new Circuit();
      const coordinator = new MockCoordinator();

      const bridge: TestBridge = createTestBridge(
        circuit,
        makeViewport(),
        makeCanvas(),
        makePalette(),
        makeRegistry(),
        coordinator,
      );

      expect(bridge.getCircuitDomain()).toBe('digital');
    });

    it("TestBridge interface has getCircuitDomain, not getEngineType", () => {
      const circuit = new Circuit();
      const coordinator = new MockCoordinator();

      const bridge: TestBridge = createTestBridge(
        circuit,
        makeViewport(),
        makeCanvas(),
        makePalette(),
        makeRegistry(),
        coordinator,
      );

      expect(typeof bridge.getCircuitDomain).toBe('function');
      expect('getEngineType' in bridge).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getAnalogState tests
  // -------------------------------------------------------------------------

  describe("getAnalogState", () => {
    it("returns null when coordinator is null", () => {
      const circuit = new Circuit();

      const bridge: TestBridge = createTestBridge(
        circuit,
        makeViewport(),
        makeCanvas(),
        makePalette(),
        makeRegistry(),
        null,
      );

      expect(bridge.getAnalogState()).toBeNull();
    });

    it("returns null when coordinator.simTime is null (discrete/digital circuit)", () => {
      const circuit = new Circuit();
      const coordinator = new MockCoordinator();

      const bridge: TestBridge = createTestBridge(
        circuit,
        makeViewport(),
        makeCanvas(),
        makePalette(),
        makeRegistry(),
        coordinator,
      );

      expect(bridge.getAnalogState()).toBeNull();
    });

    it("returns state with simTime and nodeVoltages from coordinator when simTime is not null", () => {
      const circuit = new Circuit();

      class AnalogCoordinator extends MockCoordinator {
        private _simTime = 0.001;
        private _signals = new Map<string, SignalValue>([
          ['V_out', { type: 'analog', voltage: 5.0 }],
          ['V_in', { type: 'analog', voltage: 3.3 }],
        ]);

        override get simTime(): number | null {
          return this._simTime;
        }

        override readAllSignals(): Map<string, SignalValue> {
          return this._signals;
        }
      }

      const coordinator = new AnalogCoordinator();

      const bridge: TestBridge = createTestBridge(
        circuit,
        makeViewport(),
        makeCanvas(),
        makePalette(),
        makeRegistry(),
        coordinator,
      );

      const state = bridge.getAnalogState();
      expect(state).not.toBeNull();
      expect(state!.simTime).toBe(0.001);
      expect(state!.nodeVoltages['V_out']).toBe(5.0);
      expect(state!.nodeVoltages['V_in']).toBe(3.3);
      expect(state!.nodeCount).toBe(2);
    });

    it("maps digital signal values to nodeVoltages using raw value", () => {
      const circuit = new Circuit();

      class MixedCoordinator extends MockCoordinator {
        private _signals = new Map<string, SignalValue>([
          ['clk', { type: 'digital', value: 1 }],
        ]);

        override get simTime(): number | null {
          return 0.01;
        }

        override readAllSignals(): Map<string, SignalValue> {
          return this._signals;
        }
      }

      const coordinator = new MixedCoordinator();

      const bridge: TestBridge = createTestBridge(
        circuit,
        makeViewport(),
        makeCanvas(),
        makePalette(),
        makeRegistry(),
        coordinator,
      );

      const state = bridge.getAnalogState();
      expect(state).not.toBeNull();
      expect(state!.nodeVoltages['clk']).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // worldToScreen / screenToWorld basic sanity
  // -------------------------------------------------------------------------

  describe("coordinate transforms", () => {
    it("worldToScreen converts grid position to pixel coords", () => {
      const circuit = new Circuit();
      const viewport = { zoom: 1, pan: { x: 100, y: 50 } } as unknown as Viewport;

      const bridge: TestBridge = createTestBridge(
        circuit,
        viewport,
        makeCanvas(),
        makePalette(),
        makeRegistry(),
        null,
      );

      const { x, y } = bridge.worldToScreen(2, 3);
      expect(x).toBe(2 * 1 * 20 + 100);
      expect(y).toBe(3 * 1 * 20 + 50);
    });
  });
});
