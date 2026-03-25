/**
 * Test bridge — lightweight API exposed on `window.__test` for E2E tests.
 *
 * Provides coordinate queries so Playwright tests can discover where to click
 * on the canvas to place components and draw wires. All methods return screen
 * coordinates (pixels relative to the canvas element's bounding rect) so tests
 * can use Playwright's `page.mouse.click(x, y)` directly.
 *
 * This is NOT a simulation shortcut — tests still use real pointer events
 * that go through the full hit-test → placement → wire-drawing pipeline.
 */

import type { Circuit } from '../core/circuit.js';
import type { Viewport } from '../editor/viewport.js';
import type { ComponentPalette } from '../editor/palette.js';
import type { ComponentRegistry } from '../core/registry.js';
import { hasAnalogModel, hasDigitalModel } from '../core/registry.js';
import type { SimulationCoordinator } from '../solver/coordinator-types.js';
import { pinWorldPosition } from '../core/pin.js';
import { GRID_SPACING } from '../editor/coordinates.js';

export interface TestBridge {
  /** Convert a world-space grid position to screen coordinates relative to the canvas. */
  worldToScreen(worldX: number, worldY: number): { x: number; y: number };

  /** Convert screen coordinates back to the nearest grid position. */
  screenToWorld(screenX: number, screenY: number): { x: number; y: number };

  /** Get screen coordinates of a pin on an element (by element label and pin label). */
  getPinPosition(elementLabel: string, pinLabel: string): { x: number; y: number } | null;

  /** Get screen coordinates of an element's origin (by label). */
  getElementPosition(elementLabel: string): { x: number; y: number } | null;

  /**
   * Get screen coordinates of an element's bounding box center (by label or index).
   * More reliable than getElementPosition for hit-testing / double-click targeting,
   * because the element origin may be at the edge of the component (e.g. Out pin side).
   */
  getElementCenter(labelOrIndex: string | number): { x: number; y: number } | null;

  /** Get a summary of the current circuit state. */
  getCircuitInfo(): {
    elementCount: number;
    wireCount: number;
    elements: Array<{
      label: string;
      typeId: string;
      position: { x: number; y: number };
      pins: Array<{ label: string; screenX: number; screenY: number }>;
    }>;
  };

  /** Get the canvas element's bounding rect (for converting screen coords to page coords). */
  getCanvasRect(): { left: number; top: number; width: number; height: number };

  /** Get current viewport state. */
  getViewport(): { zoom: number; panX: number; panY: number };

  /** Get circuit domain derived from circuit component models ('analog' | 'digital'). */
  getCircuitDomain(): string;

  /**
   * Get analog engine state: simTime, node voltages by label and index.
   * Returns null if no analog engine is active.
   */
  getAnalogState(): {
    simTime: number;
    nodeVoltages: Record<string, number>;
    nodeCount: number;
  } | null;

  /** Get the exit direction unit vector for a pin (points away from component body). */
  getPinExitDirection(elementLabel: string, pinLabel: string): { dx: number; dy: number } | null;

  /** Get all element bounding boxes in grid (world) coordinates. */
  getElementBoundingBoxes(): Array<{ x: number; y: number; w: number; h: number }>;

  /**
   * Get all existing wire segments and pin positions for routing obstacle avoidance.
   * Wire segments are in grid (world) coordinates. Used by UICircuitBuilder to
   * ensure new wire vertices/segments don't land on existing wires or pins.
   */
  getRoutingObstacles(): {
    wires: Array<{ x1: number; y1: number; x2: number; y2: number }>;
    pins: Array<{ x: number; y: number }>;
  };
}

export function createTestBridge(
  circuit: Circuit,
  viewport: Viewport,
  canvas: HTMLCanvasElement,
  _palette: ComponentPalette,
  registry: ComponentRegistry,
  coordinator: SimulationCoordinator | null,
): TestBridge {
  function worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    return {
      x: worldX * viewport.zoom * GRID_SPACING + viewport.pan.x,
      y: worldY * viewport.zoom * GRID_SPACING + viewport.pan.y,
    };
  }

  function findElementByLabel(label: string) {
    for (const el of circuit.elements) {
      const elLabel = el.getProperties().getOrDefault('label', '') as string;
      if (elLabel === label) return el;
    }
    return null;
  }

  function screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: Math.round((screenX - viewport.pan.x) / (viewport.zoom * GRID_SPACING)),
      y: Math.round((screenY - viewport.pan.y) / (viewport.zoom * GRID_SPACING)),
    };
  }

  return {
    worldToScreen,
    screenToWorld,

    getPinPosition(elementLabel: string, pinLabel: string) {
      const el = findElementByLabel(elementLabel);
      if (!el) return null;
      const pin = el.getPins().find(p => p.label === pinLabel);
      if (!pin) return null;
      const worldPos = pinWorldPosition(el, pin);
      return worldToScreen(worldPos.x, worldPos.y);
    },

    getElementPosition(elementLabel: string) {
      const el = findElementByLabel(elementLabel);
      if (!el) return null;
      return worldToScreen(el.position.x, el.position.y);
    },

    getElementCenter(labelOrIndex: string | number) {
      let el;
      if (typeof labelOrIndex === 'number') {
        el = circuit.elements[labelOrIndex] ?? null;
      } else {
        el = findElementByLabel(labelOrIndex);
      }
      if (!el) return null;
      const bb = el.getBoundingBox();
      const cx = bb.x + bb.width / 2;
      const cy = bb.y + bb.height / 2;
      return worldToScreen(cx, cy);
    },

    getCircuitInfo() {
      return {
        elementCount: circuit.elements.length,
        wireCount: circuit.wires.length,
        elements: circuit.elements.map(el => {
          const label = el.getProperties().getOrDefault('label', '') as string;
          const def = registry.get(el.typeId);
          const bb = el.getBoundingBox();
          const centerScreen = worldToScreen(bb.x + bb.width / 2, bb.y + bb.height / 2);
          return {
            label,
            typeId: def?.name ?? el.typeId,
            position: { x: el.position.x, y: el.position.y },
            center: { screenX: centerScreen.x, screenY: centerScreen.y },
            pins: el.getPins().map(pin => {
              const wp = pinWorldPosition(el, pin);
              const sp = worldToScreen(wp.x, wp.y);
              return { label: pin.label, screenX: sp.x, screenY: sp.y };
            }),
          };
        }),
      };
    },

    getCanvasRect() {
      const r = canvas.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    },

    getViewport() {
      return { zoom: viewport.zoom, panX: viewport.pan.x, panY: viewport.pan.y };
    },

    getCircuitDomain() {
      const hasAnalogOnly = circuit.elements.some(el => {
        const def = registry.get(el.typeId);
        if (def === undefined) return false;
        return hasAnalogModel(def) && !hasDigitalModel(def);
      });
      return hasAnalogOnly ? 'analog' : 'digital';
    },

    getAnalogState() {
      if (!coordinator) return null;
      const simTime = coordinator.simTime;
      if (simTime === null) return null;

      const allSignals = coordinator.readAllSignals();
      const nodeVoltages: Record<string, number> = {};
      for (const [label, sv] of allSignals) {
        nodeVoltages[label] = sv.type === 'analog' ? sv.voltage : sv.value;
      }

      return {
        simTime,
        nodeVoltages,
        nodeCount: Object.keys(nodeVoltages).length,
      };
    },

    getPinExitDirection(elementLabel: string, pinLabel: string) {
      const el = findElementByLabel(elementLabel);
      if (!el) return null;
      const pin = el.getPins().find(p => p.label === pinLabel);
      if (!pin) return null;
      const bb = el.getBoundingBox();
      const wp = pinWorldPosition(el, pin);
      const dL = Math.abs(wp.x - bb.x);
      const dR = Math.abs(wp.x - (bb.x + bb.width));
      const dT = Math.abs(wp.y - bb.y);
      const dB = Math.abs(wp.y - (bb.y + bb.height));
      const min = Math.min(dL, dR, dT, dB);
      if (min === dL) return { dx: -1, dy: 0 };
      if (min === dR) return { dx: 1, dy: 0 };
      if (min === dT) return { dx: 0, dy: -1 };
      if (min === dB) return { dx: 0, dy: 1 };
      return { dx: 1, dy: 0 };
    },

    getElementBoundingBoxes() {
      return circuit.elements.map(el => {
        const bb = el.getBoundingBox();
        return { x: bb.x, y: bb.y, w: bb.width, h: bb.height };
      });
    },

    getRoutingObstacles() {
      const wires = circuit.wires.map(w => ({
        x1: w.start.x, y1: w.start.y,
        x2: w.end.x, y2: w.end.y,
      }));
      const pins: Array<{ x: number; y: number }> = [];
      for (const el of circuit.elements) {
        for (const pin of el.getPins()) {
          const wp = pinWorldPosition(el, pin);
          pins.push({ x: wp.x, y: wp.y });
        }
      }
      return { wires, pins };
    },
  };
}
