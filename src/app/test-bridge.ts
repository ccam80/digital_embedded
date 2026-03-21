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
import { Wire } from '../core/circuit.js';
import type { Viewport } from '../editor/viewport.js';
import type { ComponentPalette } from '../editor/palette.js';
import type { ComponentRegistry } from '../core/registry.js';
import type { AnalogEngine } from '../core/analog-engine-interface.js';
import { PropertyBag } from '../core/properties.js';
import { pinWorldPosition } from '../core/pin.js';
import { GRID_SPACING } from '../editor/coordinates.js';

/**
 * Mutable context for analog engine state. Updated by app-init when analog
 * compilation succeeds or the engine is disposed. The test bridge reads this
 * lazily so it always reflects the current engine state.
 */
export interface AnalogTestContext {
  engine: AnalogEngine | null;
  compiled: { labelToNodeId: Map<string, number>; nodeCount: number } | null;
  compileAndBind: (() => boolean) | null;
}

export interface TestBridge {
  /** Convert a world-space grid position to screen coordinates relative to the canvas. */
  worldToScreen(worldX: number, worldY: number): { x: number; y: number };

  /** Get screen coordinates of a pin on an element (by element label and pin label). */
  getPinPosition(elementLabel: string, pinLabel: string): { x: number; y: number } | null;

  /** Get screen coordinates of an element's origin (by label). */
  getElementPosition(elementLabel: string): { x: number; y: number } | null;

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

  /** Get current engine type from circuit metadata. */
  getEngineType(): string;

  /**
   * Get analog engine state: simTime, node voltages by label and index.
   * Returns null if no analog engine is active.
   */
  getAnalogState(): {
    simTime: number;
    nodeVoltages: Record<string, number>;
    nodeCount: number;
  } | null;

  /**
   * Step the analog engine N times (default 1). Returns the final simTime.
   * Returns null if no analog engine is active.
   */
  stepAnalog(count?: number): { simTime: number; steps: number } | null;

  /**
   * Trigger circuit compilation and binding. Returns true on success.
   */
  compileCircuit(): boolean;

  /**
   * Build an analog RC lowpass test circuit programmatically.
   * AC Source (5V, 100Hz) → R (1kΩ) → C (1µF) → GND
   * Sets engineType to "analog". Call compileCircuit() after this.
   */
  buildAnalogRcCircuit(): { elementCount: number; wireCount: number };
}

export function createTestBridge(
  circuit: Circuit,
  viewport: Viewport,
  canvas: HTMLCanvasElement,
  _palette: ComponentPalette,
  registry: ComponentRegistry,
  analogCtx?: AnalogTestContext,
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

  return {
    worldToScreen,

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

    getCircuitInfo() {
      return {
        elementCount: circuit.elements.length,
        wireCount: circuit.wires.length,
        elements: circuit.elements.map(el => {
          const label = el.getProperties().getOrDefault('label', '') as string;
          const def = registry.get(el.typeId);
          return {
            label,
            typeId: def?.name ?? el.typeId,
            position: { x: el.position.x, y: el.position.y },
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

    getEngineType() {
      return circuit.metadata.engineType;
    },

    getAnalogState() {
      const eng = analogCtx?.engine;
      const comp = analogCtx?.compiled;
      if (!eng || !comp) return null;

      const nodeVoltages: Record<string, number> = {};
      for (const [label, nodeId] of comp.labelToNodeId) {
        nodeVoltages[label] = eng.getNodeVoltage(nodeId);
      }
      for (let i = 1; i <= comp.nodeCount; i++) {
        nodeVoltages[`node_${i}`] = eng.getNodeVoltage(i);
      }

      // Expose engine internals for diagnostics (TS private = runtime accessible)
      const engAny = eng as any;
      return {
        simTime: eng.simTime,
        nodeVoltages,
        nodeCount: comp.nodeCount,
        _engineState: engAny._engineState,
        _hasCompiled: engAny._compiled !== null && engAny._compiled !== undefined,
        _matrixSize: engAny._compiled?.matrixSize ?? -1,
        _elementCount: engAny._compiled?.elements?.length ?? -1,
      };
    },

    stepAnalog(count = 1) {
      const eng = analogCtx?.engine;
      if (!eng) return null;

      let steps = 0;
      for (let i = 0; i < count; i++) {
        eng.step();
        steps++;
      }
      return { simTime: eng.simTime, steps };
    },

    compileCircuit() {
      if (!analogCtx?.compileAndBind) return false;
      return analogCtx.compileAndBind();
    },

    buildAnalogRcCircuit() {
      // Clear existing circuit
      while (circuit.elements.length > 0) circuit.removeElement(circuit.elements[0]);
      while (circuit.wires.length > 0) circuit.removeWire(circuit.wires[0]);

      // Set engine type to analog
      circuit.metadata = { ...circuit.metadata, engineType: 'analog' };

      // Create elements via registry factories with explicit property values
      const vsDef = registry.get('AcVoltageSource')!;
      const rDef = registry.get('AnalogResistor')!;
      const cDef = registry.get('AnalogCapacitor')!;
      const gndDef = registry.get('Ground')!;

      const vsProps = new PropertyBag(new Map<string, unknown>([
        ['label', 'Vs'], ['amplitude', 5], ['frequency', 100],
        ['phase', 0], ['dcOffset', 0], ['waveform', 'sine'],
      ]).entries() as IterableIterator<[string, unknown]>);
      const rProps = new PropertyBag(new Map<string, unknown>([
        ['label', 'R1'], ['resistance', 1000],
      ]).entries() as IterableIterator<[string, unknown]>);
      const cProps = new PropertyBag(new Map<string, unknown>([
        ['label', 'C1'], ['capacitance', 1e-6],
      ]).entries() as IterableIterator<[string, unknown]>);
      const gndProps = new PropertyBag(new Map<string, unknown>().entries() as IterableIterator<[string, unknown]>);

      // AC source at grid (7,10): pos at (5,10), neg at (11,10)
      const vsEl = vsDef.factory(vsProps);
      vsEl.position = { x: 7, y: 10 };
      circuit.addElement(vsEl);

      // Resistor at grid (15,10): A at (15,10), B at (19,10)
      const rEl = rDef.factory(rProps);
      rEl.position = { x: 15, y: 10 };
      circuit.addElement(rEl);

      // Capacitor at grid (23,10): pos at (23,10), neg at (25,10)
      const cEl = cDef.factory(cProps);
      cEl.position = { x: 23, y: 10 };
      circuit.addElement(cEl);

      // Two grounds
      const gnd1El = gndDef.factory(gndProps);
      gnd1El.position = { x: 11, y: 15 };
      circuit.addElement(gnd1El);

      const gnd2El = gndDef.factory(new PropertyBag(new Map<string, unknown>().entries() as IterableIterator<[string, unknown]>));
      gnd2El.position = { x: 25, y: 15 };
      circuit.addElement(gnd2El);

      // Wires connecting pins
      circuit.addWire(new Wire({ x: 5, y: 10 }, { x: 15, y: 10 }));   // vs:pos → r:A
      circuit.addWire(new Wire({ x: 19, y: 10 }, { x: 23, y: 10 }));  // r:B → c:pos
      circuit.addWire(new Wire({ x: 25, y: 10 }, { x: 25, y: 15 }));  // c:neg → gnd2
      circuit.addWire(new Wire({ x: 11, y: 10 }, { x: 11, y: 15 }));  // vs:neg → gnd1

      return { elementCount: circuit.elements.length, wireCount: circuit.wires.length };
    },
  };
}
