/**
 * Pin system — visual/declarative only.
 *
 * Per Decision 6: Pin has no simulation state. No netId, no signalValue.
 * The compiler assigns net IDs from pin declarations and wire topology.
 */

import type { Point } from "./renderer-interface.js";

export type { Point };

export const enum PinDirection {
  INPUT = "INPUT",
  OUTPUT = "OUTPUT",
  BIDIRECTIONAL = "BIDIRECTIONAL",
}

/**
 * A resolved pin instance on a placed component.
 * Position is relative to the component's origin.
 */
export interface Pin {
  readonly direction: PinDirection;
  readonly position: Point;
  readonly label: string;
  readonly bitWidth: number;
  readonly isNegated: boolean;
  readonly isClock: boolean;
}

/**
 * Static template for a pin, stored in ComponentDefinition.
 * Describes the pin's default characteristics before component instantiation.
 */
export interface PinDeclaration {
  readonly direction: PinDirection;
  readonly label: string;
  readonly defaultBitWidth: number;
  readonly position: Point;
  readonly isNegatable: boolean;
  readonly isClockCapable: boolean;
  /** Whether this pin carries a signal or a power rail. */
  readonly kind: "signal" | "power";
  /** Which face of a subcircuit chip this pin is on (left/right/top/bottom). */
  readonly face?: "left" | "right" | "top" | "bottom";
}

/**
 * A fully resolved pin — produced once per component instance during compilation.
 * Carries identity, geometry, and electrical binding in a single object.
 * The array of ResolvedPins is always in `pinLayout` order.
 */
export interface ResolvedPin {
  readonly label: string;
  readonly direction: PinDirection;
  readonly localPosition: { x: number; y: number };
  readonly worldPosition: { x: number; y: number };
  readonly wireVertex: { x: number; y: number } | null;
  readonly nodeId: number;
  readonly bitWidth: number;
}

/**
 * Per-pin inversion configuration as stored in .dig files.
 * A set of pin labels whose inversion bubble is active.
 */
export interface InverterConfig {
  readonly invertedPins: ReadonlySet<string>;
}

export function createInverterConfig(invertedPinLabels: readonly string[]): InverterConfig {
  return { invertedPins: new Set(invertedPinLabels) };
}

function isPinInverted(config: InverterConfig, label: string): boolean {
  return config.invertedPins.has(label);
}

/**
 * Per-pin clock designation configuration.
 * A set of pin labels that are designated as clock inputs.
 */
export interface ClockConfig {
  readonly clockPins: ReadonlySet<string>;
}

export function createClockConfig(clockPinLabels: readonly string[]): ClockConfig {
  return { clockPins: new Set(clockPinLabels) };
}

export function isPinClock(config: ClockConfig, label: string): boolean {
  return config.clockPins.has(label);
}

/**
 * Construct a Pin from a PinDeclaration, applying a concrete position and
 * resolving the isNegated and isClock flags from the component's configs.
 */
export function makePin(
  decl: PinDeclaration,
  position: Point,
  inverterConfig: InverterConfig,
  clockConfig: ClockConfig,
): Pin {
  return {
    direction: decl.direction,
    position,
    label: decl.label,
    bitWidth: decl.defaultBitWidth,
    isNegated: decl.isNegatable && isPinInverted(inverterConfig, decl.label),
    isClock: decl.isClockCapable && isPinClock(clockConfig, decl.label),
  };
}

/**
 * Rotation values: quarter-turns clockwise (0=east, 1=south, 2=west, 3=north).
 */
export type Rotation = 0 | 1 | 2 | 3;

/**
 * Rotate a point by the given rotation around the origin.
 *
 * Digital's coordinate system has y increasing downward.
 * Quarter-turn clockwise maps (x, y) → (-y, x) in standard math,
 * but with y-down: (x, y) → (y, -x).
 * Applied four times returns to the original.
 *
 * Mapping for each rotation value:
 *   0 (0°):   (x, y)  → ( x,  y)
 *   1 (90°):  (x, y)  → (-y,  x)
 *   2 (180°): (x, y)  → (-x, -y)
 *   3 (270°): (x, y)  → ( y, -x)
 */
export function rotatePoint(p: Point, rotation: Rotation): Point {
  switch (rotation) {
    case 0: return { x: p.x, y: p.y };
    case 1: return { x: p.y || 0, y: (-p.x) || 0 };
    case 2: return { x: (-p.x) || 0, y: (-p.y) || 0 };
    case 3: return { x: (-p.y) || 0, y: p.x || 0 };
  }
}

/**
 * Translate a point by an offset.
 */
export function translatePoint(p: Point, offset: Point): Point {
  return { x: p.x + offset.x, y: p.y + offset.y };
}

/**
 * Compute the world-space position of a pin on a placed element.
 *
 * Pin positions from getPins() are in LOCAL coordinates (resolvePins runs
 * at construction time with rotation=0 because the factory creates elements
 * before dig-loader sets position/rotation). This function applies the
 * full transform: mirror → rotate → translate.
 *
 * Java Digital's transform order (VisualElement.getTransform):
 *   1. Rotate + translate: TransformRotate(pos, rot)
 *   2. If mirror: Transform.mul(mirror[1,0,0,-1], rotateTranslate)
 * The composed result is equivalent to: mirror Y in local space, then
 * rotate, then translate.
 *
 * All code that needs a pin's world position MUST use this function
 * instead of the raw `element.position + pin.position` pattern.
 */
export function pinWorldPosition(
  element: { position: Point; rotation: Rotation; mirror: boolean },
  pin: { position: Point },
): Point {
  let p = pin.position;
  if (element.mirror) {
    // Mirror negates Y in local space (vertical flip), matching Java Digital's
    // TransformMatrix(1,0,0,-1) convention.  Wire positions in .dig files are
    // authored to match this transform.
    p = { x: p.x, y: -p.y };
  }
  const rotated = rotatePoint(p, element.rotation);
  return { x: element.position.x + rotated.x, y: element.position.y + rotated.y };
}

/**
 * Compute pin positions for a set of PinDeclarations given a component's
 * origin, rotation, and inverter configuration.
 *
 * Returns resolved Pin objects with positions relative to the component
 * origin (rotation applied, but NOT translated by origin). Consumers must
 * add element.position to get world-space coordinates.
 *
 * The origin parameter is accepted for API compatibility but ignored —
 * all position offsetting is done at the consumer side.
 */
export function resolvePins(
  declarations: readonly PinDeclaration[],
  _origin: Point,
  rotation: Rotation,
  inverterConfig: InverterConfig,
  clockConfig: ClockConfig,
): Pin[] {
  return declarations.map((decl) => {
    // Java GenericShape: inverted input pins shift 1 grid unit left (dx = -SIZE)
    let pos = decl.position;
    if (
      decl.direction === PinDirection.INPUT &&
      decl.isNegatable &&
      isPinInverted(inverterConfig, decl.label)
    ) {
      pos = { x: pos.x - 1, y: pos.y };
    }
    const rotated = rotatePoint(pos, rotation);
    return makePin(decl, rotated, inverterConfig, clockConfig);
  });
}

/**
 * N/S/E/W layout helpers.
 *
 * These compute standard pin positions for a component of given width/height
 * when pins are placed on a specific face. Grid units are integers.
 *
 * Convention: component origin is the top-left corner in default orientation.
 * Pins on the west (left) face have x=0; east face x=width.
 * Pins on the north (top) face have y=0; south face y=height.
 *
 * Spacing is 1 grid unit per pin slot. Pins are centred on the face.
 */

type CardinalFace = "north" | "south" | "east" | "west";

/**
 * Compute evenly-spaced pin positions along a face of a rectangular component.
 *
 * @param face       Which face to place pins on.
 * @param count      Number of pins.
 * @param componentW Component width in grid units.
 * @param componentH Component height in grid units.
 * @returns Array of pin positions relative to component origin.
 */
export function layoutPinsOnFace(
  face: CardinalFace,
  count: number,
  componentW: number,
  componentH: number,
): Point[] {
  const positions: Point[] = [];

  if (count <= 0) return positions;

  // Even distribution: for count==1 centre on the face; for count>1
  // distribute with equal margins on each end.
  // margin = 1 grid unit from each edge, remaining space split evenly.
  function distribute(dim: number, n: number): number[] {
    if (n === 1) return [Math.floor(dim / 2)];
    // When pins are too dense (can't fit with margin=1), pack 1-apart centered
    if (n > dim - 1) {
      const start = Math.floor((dim - n + 1) / 2);
      return Array.from({ length: n }, (_, i) => start + i);
    }
    const margin = 1;
    const step = (dim - 2 * margin) / (n - 1);
    const result: number[] = [];
    for (let i = 0; i < n; i++) {
      result.push(Math.round(margin + i * step));
    }
    return result;
  }

  switch (face) {
    case "west": {
      for (const y of distribute(componentH, count)) {
        positions.push({ x: 0, y });
      }
      break;
    }
    case "east": {
      for (const y of distribute(componentH, count)) {
        positions.push({ x: componentW, y });
      }
      break;
    }
    case "north": {
      for (const x of distribute(componentW, count)) {
        positions.push({ x, y: 0 });
      }
      break;
    }
    case "south": {
      for (const x of distribute(componentW, count)) {
        positions.push({ x, y: componentH });
      }
      break;
    }
  }

  return positions;
}

/**
 * Build PinDeclarations for a set of inputs on the west face and a single
 * output on the east face — the most common gate layout.
 *
 * Pin positions match Java Digital's GenericShape.createPins():
 *   - Input pins at x=0, spaced 1 grid unit apart starting at y=0
 *   - For even input counts (symmetric): gap of 1 grid unit at the midpoint
 *   - Output pin centred vertically: y = floor(inputCount / 2)
 *
 * @param inputLabels   Labels for input pins (west face), top to bottom.
 * @param outputLabel   Label for the output pin (east face).
 * @param componentW    Component width in grid units.
 * @param _componentH   Unused (kept for API compat); height derives from input count.
 * @param defaultBitWidth  Default bit width for all pins.
 */
export function standardGatePinLayout(
  inputLabels: readonly string[],
  outputLabel: string,
  componentW: number,
  _componentH: number = 0,
  defaultBitWidth: number = 1,
  outputBubbleOffset: number = 0,
): PinDeclaration[] {
  const n = inputLabels.length;
  const symmetric = true; // single output → symmetric
  const even = n > 0 && (n & 1) === 0;

  const inputs: PinDeclaration[] = inputLabels.map((label, i) => {
    // Java: correct = SIZE when symmetric && even && i >= n/2
    const correct = (symmetric && even && i >= n / 2) ? 1 : 0;
    return {
      direction: PinDirection.INPUT,
      label,
      defaultBitWidth,
      position: { x: 0, y: i + correct },
      isNegatable: true,
      isClockCapable: false,
    };
  });

  // Java: output y = floor(n / 2) * SIZE → grid: floor(n / 2)
  // Java: non-inverted dx=0, inverted dx=SIZE (1 grid unit past body)
  const outputY = Math.floor(n / 2);
  const output: PinDeclaration = {
    direction: PinDirection.OUTPUT,
    label: outputLabel,
    defaultBitWidth,
    position: { x: componentW + outputBubbleOffset, y: outputY },
    isNegatable: false,
    isClockCapable: false,
  };

  return [...inputs, output];
}

/**
 * Compute the visual body height for a standard gate matching Java's GenericShape.
 *
 * Java body extends from y = -TOP_BORDER to y = maxPinY + TOP_BORDER
 * (plus extra SIZE for even input counts in symmetric mode).
 *
 * @returns Object with topBorder (offset above y=0) and bodyHeight (total).
 */
export function gateBodyMetrics(inputCount: number): { topBorder: number; bodyHeight: number } {
  const TOP_BORDER = 0.5; // Java SIZE2 / SIZE = 10/20
  const max = inputCount;
  // Java: yBottom = (max - 1) * SIZE + topBottomBorder; if even: yBottom += SIZE
  const even = inputCount > 0 && (inputCount & 1) === 0;
  const yBottom = (max - 1) + TOP_BORDER + (even ? 1 : 0);
  return { topBorder: TOP_BORDER, bodyHeight: yBottom + TOP_BORDER };
}
