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

export function isPinInverted(config: InverterConfig, label: string): boolean {
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
  bitWidth?: number,
): Pin {
  return {
    direction: decl.direction,
    position,
    label: decl.label,
    bitWidth: bitWidth ?? decl.defaultBitWidth,
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
 * Quarter-turn clockwise maps (x, y) → (y, -x) in standard math,
 * but with y-down: (x, y) → (-y, x).
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
    case 1: return { x: (-p.y) || 0, y: p.x || 0 };
    case 2: return { x: (-p.x) || 0, y: (-p.y) || 0 };
    case 3: return { x: p.y || 0, y: (-p.x) || 0 };
  }
}

/**
 * Translate a point by an offset.
 */
export function translatePoint(p: Point, offset: Point): Point {
  return { x: p.x + offset.x, y: p.y + offset.y };
}

/**
 * Compute pin positions for a set of PinDeclarations given a component's
 * origin, rotation, and inverter configuration.
 *
 * Returns resolved Pin objects with world-space positions.
 */
export function resolvePins(
  declarations: readonly PinDeclaration[],
  origin: Point,
  rotation: Rotation,
  inverterConfig: InverterConfig,
  clockConfig: ClockConfig,
  bitWidth?: number,
): Pin[] {
  return declarations.map((decl) => {
    const rotated = rotatePoint(decl.position, rotation);
    const worldPos = translatePoint(rotated, origin);
    return makePin(decl, worldPos, inverterConfig, clockConfig, bitWidth);
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

export type CardinalFace = "north" | "south" | "east" | "west";

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

  switch (face) {
    case "west": {
      // Pins distributed along left edge, y from 1 to count (1-indexed row)
      const startY = Math.floor((componentH - count) / 2) + 1;
      for (let i = 0; i < count; i++) {
        positions.push({ x: 0, y: startY + i });
      }
      break;
    }
    case "east": {
      const startY = Math.floor((componentH - count) / 2) + 1;
      for (let i = 0; i < count; i++) {
        positions.push({ x: componentW, y: startY + i });
      }
      break;
    }
    case "north": {
      const startX = Math.floor((componentW - count) / 2) + 1;
      for (let i = 0; i < count; i++) {
        positions.push({ x: startX + i, y: 0 });
      }
      break;
    }
    case "south": {
      const startX = Math.floor((componentW - count) / 2) + 1;
      for (let i = 0; i < count; i++) {
        positions.push({ x: startX + i, y: componentH });
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
 * @param inputLabels   Labels for input pins (west face), top to bottom.
 * @param outputLabel   Label for the output pin (east face).
 * @param componentW    Component width in grid units.
 * @param componentH    Component height in grid units.
 * @param defaultBitWidth  Default bit width for all pins.
 */
export function standardGatePinLayout(
  inputLabels: readonly string[],
  outputLabel: string,
  componentW: number,
  componentH: number,
  defaultBitWidth: number = 1,
): PinDeclaration[] {
  const inputPositions = layoutPinsOnFace("west", inputLabels.length, componentW, componentH);
  const outputPositions = layoutPinsOnFace("east", 1, componentW, componentH);

  const inputs: PinDeclaration[] = inputLabels.map((label, i) => ({
    direction: PinDirection.INPUT,
    label,
    defaultBitWidth,
    position: inputPositions[i],
    isNegatable: true,
    isClockCapable: false,
  }));

  const output: PinDeclaration = {
    direction: PinDirection.OUTPUT,
    label: outputLabel,
    defaultBitWidth,
    position: outputPositions[0],
    isNegatable: false,
    isClockCapable: false,
  };

  return [...inputs, output];
}
