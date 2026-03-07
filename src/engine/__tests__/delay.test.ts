/**
 * Tests for delay resolution — task 3.3.1.
 *
 * Verifies the three-level priority:
 *   1. Instance property "delay"
 *   2. ComponentDefinition.defaultDelay
 *   3. DEFAULT_GATE_DELAY (10ns global fallback)
 */

import { describe, it, expect } from "vitest";
import { resolveDelays, DEFAULT_GATE_DELAY } from "../delay.js";
import { CompiledCircuitImpl, FlatComponentLayout } from "../compiled-circuit.js";
import { ComponentRegistry, ComponentCategory } from "@/core/registry";
import type { ComponentDefinition } from "@/core/registry";
import type { CircuitElement } from "@/core/element";
import type { Pin } from "@/core/pin";
import { PropertyBag } from "@/core/properties";
import type { PropertyValue } from "@/core/properties";
import type { Point, Rect, RenderContext } from "@/core/renderer-interface";
import type { Rotation } from "@/core/pin";

// ---------------------------------------------------------------------------
// Minimal mock CircuitElement for tests
// ---------------------------------------------------------------------------

class MockElement implements CircuitElement {
  readonly typeId: string;
  private readonly _props: PropertyBag;
  readonly instanceId = "mock-0";
  readonly position: Point = { x: 0, y: 0 };
  readonly rotation: Rotation = 0;
  readonly mirror = false;

  constructor(typeId: string, props: PropertyBag = new PropertyBag()) {
    this.typeId = typeId;
    this._props = props;
  }

  getAttribute(key: string): PropertyValue | undefined {
    if (this._props.has(key)) {
      return this._props.get(key);
    }
    return undefined;
  }

  getProperties(): PropertyBag {
    return this._props;
  }

  getPins(): Pin[] {
    return [];
  }

  getBoundingBox(): Rect {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  draw(_ctx: RenderContext): void {}

  getHelpText(): string {
    return "";
  }

  serialize(): import("@/core/element").SerializedElement {
    return {
      typeId: this.typeId,
      instanceId: this.instanceId,
      position: this.position,
      rotation: this.rotation,
      mirror: this.mirror,
      properties: {},
    };
  }
}

// ---------------------------------------------------------------------------
// Helper — build a minimal CompiledCircuitImpl for N components
// ---------------------------------------------------------------------------

function buildCompiled(
  componentCount: number,
  componentToElement: Map<number, CircuitElement>,
): CompiledCircuitImpl {
  const emptyWiringTable = new Int32Array(0);
  const emptyLayout = new FlatComponentLayout(
    new Int32Array(componentCount),
    new Int32Array(componentCount),
    new Uint8Array(componentCount),
    new Uint8Array(componentCount),
    emptyWiringTable,
  );

  return new CompiledCircuitImpl({
    netCount: 0,
    componentCount,
    typeIds: new Uint8Array(componentCount),
    executeFns: [],
    wiringTable: emptyWiringTable,
    layout: emptyLayout,
    evaluationOrder: [],
    sequentialComponents: new Uint32Array(0),
    netWidths: new Uint8Array(0),
    sccSnapshotBuffer: new Uint32Array(1),
    delays: new Uint32Array(componentCount),
    componentToElement,
    labelToNetId: new Map(),
    wireToNetId: new Map(),
    pinNetMap: new Map(),
    resetComponentIndices: new Uint32Array(0),
    busResolver: null,
    switchComponentIndices: new Uint32Array(0),
    switchClassification: new Uint8Array(0),
  });
}

// ---------------------------------------------------------------------------
// Helper — build a minimal ComponentRegistry with one definition
// ---------------------------------------------------------------------------

function makeRegistry(name: string, defaultDelay?: number): ComponentRegistry {
  const registry = new ComponentRegistry();
  const def: ComponentDefinition = {
    name,
    typeId: -1,
    factory: (_props) => new MockElement(name),
    executeFn: () => {},
    pinLayout: [],
    propertyDefs: [],
    attributeMap: [],
    category: ComponentCategory.LOGIC,
    helpText: "",
    ...(defaultDelay !== undefined ? { defaultDelay } : {}),
  };
  registry.register(def);
  return registry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Delays", () => {
  it("defaultDelayIs10ns", () => {
    // Component with no explicit delay property and no definition defaultDelay.
    // resolveDelays should return DEFAULT_GATE_DELAY (10) for that component.
    const element = new MockElement("And");
    const componentToElement = new Map<number, CircuitElement>([[0, element]]);
    const compiled = buildCompiled(1, componentToElement);

    // Registry for "And" with no defaultDelay set
    const registry = makeRegistry("And");

    const delays = resolveDelays(compiled, registry);

    expect(delays.length).toBe(1);
    expect(delays[0]).toBe(DEFAULT_GATE_DELAY);
    expect(DEFAULT_GATE_DELAY).toBe(10);
  });

  it("instanceOverridesDefault", () => {
    // Component with delay: 20 in its property bag.
    // resolveDelays should return 20, ignoring definition default and global default.
    const props: PropertyBag = new PropertyBag([["delay", 20]]);
    const element = new MockElement("And", props);
    const componentToElement = new Map<number, CircuitElement>([[0, element]]);
    const compiled = buildCompiled(1, componentToElement);

    // Registry with defaultDelay: 5 — instance override should win
    const registry = makeRegistry("And", 5);

    const delays = resolveDelays(compiled, registry);

    expect(delays.length).toBe(1);
    expect(delays[0]).toBe(20);
  });

  it("definitionOverridesGlobalDefault", () => {
    // Component with no instance delay property.
    // ComponentDefinition has defaultDelay: 5.
    // resolveDelays should return 5 (not the global 10).
    const element = new MockElement("SlowGate");
    const componentToElement = new Map<number, CircuitElement>([[0, element]]);
    const compiled = buildCompiled(1, componentToElement);

    const registry = makeRegistry("SlowGate", 5);

    const delays = resolveDelays(compiled, registry);

    expect(delays.length).toBe(1);
    expect(delays[0]).toBe(5);
  });
});
