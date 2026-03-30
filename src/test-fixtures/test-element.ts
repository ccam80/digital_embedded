/**
 * Shared TestElement for use in tests.
 *
 * Eliminates ~40 repeated inline class definitions of the form
 * "class TestElement/StubElement/MockElement extends AbstractCircuitElement"
 * across test files.
 */

import { AbstractCircuitElement } from "../core/element.js";
import type { Pin, PinDeclaration } from "../core/pin.js";
import {
  PinDirection,
  resolvePins,
  createInverterConfig,
  createClockConfig,
} from "../core/pin.js";
import type { RenderContext, Rect } from "../core/renderer-interface.js";
import { PropertyBag } from "../core/properties.js";

// ---------------------------------------------------------------------------
// TestElement — configurable AbstractCircuitElement for tests
// ---------------------------------------------------------------------------

/**
 * Minimal circuit element for tests. Supports configurable typeId, pins,
 * PropertyBag, and an optional drawFn for render-testing scenarios.
 */
export class TestElement extends AbstractCircuitElement {
  private readonly _pins: readonly Pin[];
  private readonly _bb?: Rect;
  private readonly _drawFn?: (ctx: RenderContext) => void;
  drawCallCount = 0;

  constructor(
    typeId: string,
    instanceId: string,
    position: { x: number; y: number },
    pins: readonly Pin[],
    props?: PropertyBag,
    options?: {
      rotation?: 0 | 1 | 2 | 3;
      mirror?: boolean;
      boundingBox?: Rect;
      drawFn?: (ctx: RenderContext) => void;
    },
  ) {
    super(
      typeId,
      instanceId,
      position,
      options?.rotation ?? 0,
      options?.mirror ?? false,
      props ?? new PropertyBag(),
    );
    this._pins = pins;
    this._bb = options?.boundingBox;
    this._drawFn = options?.drawFn;
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  draw(ctx: RenderContext): void {
    this.drawCallCount++;
    this._drawFn?.(ctx);
  }

  getBoundingBox(): Rect {
    return this._bb ?? { x: this.position.x, y: this.position.y, width: 4, height: 4 };
  }
}

// ---------------------------------------------------------------------------
// Pin factory helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal signal Pin with the given label, direction, and position.
 */
export function makePin(
  label: string,
  direction: PinDirection,
  x: number,
  y: number,
  bitWidth = 1,
): Pin {
  return {
    label,
    direction,
    position: { x, y },
    bitWidth,
    isNegated: false,
    isClock: false,
    kind: "signal",
  };
}

/**
 * Create an INPUT pin declaration.
 */
export function inputPinDecl(
  label: string,
  x: number,
  y: number,
  bitWidth = 1,
): PinDeclaration {
  return {
    direction: PinDirection.INPUT,
    label,
    defaultBitWidth: bitWidth,
    position: { x, y },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  };
}

/**
 * Create an OUTPUT pin declaration.
 */
export function outputPinDecl(
  label: string,
  x: number,
  y: number,
  bitWidth = 1,
): PinDeclaration {
  return {
    direction: PinDirection.OUTPUT,
    label,
    defaultBitWidth: bitWidth,
    position: { x, y },
    isNegatable: false,
    isClockCapable: false,
    kind: "signal",
  };
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/**
 * Create a TestElement from PinDeclarations (resolved at position {0,0}).
 * This is the most common pattern in tests that work with the compiler.
 */
export function createTestElementFromDecls(
  typeId: string,
  instanceId: string,
  pinDecls: PinDeclaration[],
  props?: PropertyBag,
  position: { x: number; y: number } = { x: 0, y: 0 },
): TestElement {
  const pins = resolvePins(
    pinDecls,
    position,
    0,
    createInverterConfig([]),
    createClockConfig([]),
  );
  return new TestElement(typeId, instanceId, position, pins, props);
}

/**
 * Create a TestElement with pre-built Pin objects.
 */
export function createTestElement(
  typeId: string,
  instanceId: string,
  pins: Pin[] = [],
  props?: PropertyBag,
  position: { x: number; y: number } = { x: 0, y: 0 },
): TestElement {
  return new TestElement(typeId, instanceId, position, pins, props);
}
