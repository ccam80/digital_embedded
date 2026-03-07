/**
 * PRNG component — pseudo-random number generator.
 *
 * Ports from Digital's PRNG.java:
 *   Inputs: S (seed, bitWidth), se (set enable, 1-bit), ne (next enable, 1-bit), C (clock, 1-bit)
 *   Output: R (random value, bitWidth)
 *   internalStateCount: 1 (current PRNG state value stored in state array)
 *
 * On rising clock edge:
 *   1. If se=1: reset PRNG state using S as seed.
 *   2. If ne=1: advance to next value.
 *
 * LFSR implementation (Galois LFSR) for zero-allocation pseudo-randomness.
 * The LFSR polynomial used is a maximal-length polynomial for the given bit width.
 * For seeding, the seed value initialises the LFSR state directly (non-zero seed
 * required; if seed=0, state is set to 1 to avoid the all-zero lock-up state).
 *
 * The current PRNG value is stored at layout.stateOffset(index) + 0.
 * The previous clock value (for edge detection) is stored at layout.stateOffset(index) + 1.
 * internalStateCount = 2 (value + prev clock).
 */

import { AbstractCircuitElement } from "../../core/element.js";
import type { RenderContext } from "../../core/renderer-interface.js";
import type { Rect } from "../../core/renderer-interface.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
  createInverterConfig,
  resolvePins,
  layoutPinsOnFace,
} from "../../core/pin.js";
import { PropertyBag, PropertyType } from "../../core/properties.js";
import type { PropertyDefinition } from "../../core/properties.js";
import {
  ComponentCategory,
  type AttributeMapping,
  type ComponentDefinition,
  type ComponentLayout,
} from "../../core/registry.js";

// ---------------------------------------------------------------------------
// LFSR taps for maximal-length sequences per bit width
// Source: standard maximal-length LFSR polynomial tables
// ---------------------------------------------------------------------------

const LFSR_TAPS: Record<number, number> = {
  1: 0x1,
  2: 0x3,
  3: 0x6,
  4: 0xC,
  5: 0x14,
  6: 0x30,
  7: 0x60,
  8: 0xB8,
  9: 0x110,
  10: 0x240,
  11: 0x500,
  12: 0xE08,
  13: 0x1C80,
  14: 0x3802,
  15: 0x6000,
  16: 0xD008,
  17: 0x12000,
  18: 0x20400,
  19: 0x40023,
  20: 0x90000,
  21: 0x140000,
  22: 0x300000,
  23: 0x420000,
  24: 0xE10000,
  25: 0x1200000,
  26: 0x2000023,
  27: 0x4000013,
  28: 0x9000000,
  29: 0x14000000,
  30: 0x20000029,
  31: 0x48000000,
  32: 0x80200003,
};

function lfsrNext(state: number, taps: number, mask: number): number {
  // Galois LFSR: if LSB is 1, XOR with taps; then shift right
  const feedback = state & 1;
  let next = state >>> 1;
  if (feedback !== 0) {
    next ^= taps;
  }
  return (next & mask) >>> 0;
}

const COMP_WIDTH = 4;
const COMP_HEIGHT = 6;

function buildPRNGPinDeclarations(bitWidth: number): PinDeclaration[] {
  const inputPositions = layoutPinsOnFace("west", 4, COMP_WIDTH, COMP_HEIGHT);
  const outputPositions = layoutPinsOnFace("east", 1, COMP_WIDTH, COMP_HEIGHT);
  return [
    { direction: PinDirection.INPUT, label: "S", defaultBitWidth: bitWidth, position: inputPositions[0], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "se", defaultBitWidth: 1, position: inputPositions[1], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "ne", defaultBitWidth: 1, position: inputPositions[2], isNegatable: false, isClockCapable: false },
    { direction: PinDirection.INPUT, label: "C", defaultBitWidth: 1, position: inputPositions[3], isNegatable: false, isClockCapable: true },
    { direction: PinDirection.OUTPUT, label: "R", defaultBitWidth: bitWidth, position: outputPositions[0], isNegatable: false, isClockCapable: false },
  ];
}

export class PRNGElement extends AbstractCircuitElement {
  private readonly _bitWidth: number;
  private readonly _pins: readonly Pin[];

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("PRNG", instanceId, position, rotation, mirror, props);
    this._bitWidth = props.getOrDefault<number>("bitWidth", 8);
    const decls = buildPRNGPinDeclarations(this._bitWidth);
    this._pins = resolvePins(decls, position, rotation, createInverterConfig([]), { clockPins: new Set<string>(["C"]) });
  }

  getPins(): readonly Pin[] { return this._pins; }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: COMP_WIDTH, height: COMP_HEIGHT };
  }

  draw(ctx: RenderContext): void {
    ctx.save();
    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, false);
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 1.0, weight: "bold" });
    ctx.drawText("PRNG", COMP_WIDTH / 2, COMP_HEIGHT / 2, { horizontal: "center", vertical: "middle" });
    ctx.restore();
  }

  getHelpText(): string {
    return "PRNG — pseudo-random number generator (LFSR-based). On rising clock edge: se=1 seeds with S input; ne=1 advances to next value. Output R is current random value.";
  }
}

// ---------------------------------------------------------------------------
// State layout: stateOffset(index)+0 = current LFSR value, +1 = prev clock
// internalStateCount = 2
// ---------------------------------------------------------------------------

export interface PRNGLayout extends ComponentLayout {
  stateOffset(componentIndex: number): number;
}

export function makeExecutePRNG(
  bitWidth: number,
): (index: number, state: Uint32Array, _highZs: Uint32Array, layout: PRNGLayout) => void {
  const mask = bitWidth >= 32 ? 0xFFFFFFFF : ((1 << bitWidth) - 1);
  const taps = LFSR_TAPS[bitWidth] ?? LFSR_TAPS[8];

  return function executePRNG(index: number, state: Uint32Array, _highZs: Uint32Array, layout: PRNGLayout): void {
    const inBase = layout.inputOffset(index);
    const outBase = layout.outputOffset(index);
    const stateBase = layout.stateOffset(index);

    const seedInput = state[inBase] & mask;
    const se = state[inBase + 1] & 1;
    const ne = state[inBase + 2] & 1;
    const clock = state[inBase + 3] & 1;
    const prevClock = state[stateBase + 1] & 1;

    let lfsrState = state[stateBase] >>> 0;

    // Rising edge detection
    if (clock === 1 && prevClock === 0) {
      if (se === 1) {
        // Seed: use seedInput, avoid all-zero state
        lfsrState = seedInput !== 0 ? seedInput & mask : 1;
      }
      if (ne === 1) {
        lfsrState = lfsrNext(lfsrState, taps, mask);
        // Ensure non-zero state
        if (lfsrState === 0) lfsrState = 1;
      }
    }

    state[stateBase] = lfsrState;
    state[stateBase + 1] = clock;
    state[outBase] = lfsrState;
  };
}

export function executePRNG(index: number, state: Uint32Array, _highZs: Uint32Array, layout: ComponentLayout): void {
  makeExecutePRNG(8)(index, state, _highZs, layout as PRNGLayout);
}

export const PRNG_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  { xmlName: "Bits", propertyKey: "bitWidth", convert: (v) => parseInt(v, 10) },
  { xmlName: "Label", propertyKey: "label", convert: (v) => v },
];

const PRNG_PROPERTY_DEFS: PropertyDefinition[] = [
  { key: "bitWidth", type: PropertyType.BIT_WIDTH, label: "Bits", defaultValue: 8, min: 1, max: 32 },
  { key: "label", type: PropertyType.STRING, label: "Label", defaultValue: "" },
];

export const PRNGDefinition: ComponentDefinition = {
  name: "PRNG",
  typeId: -1,
  factory: (props) => new PRNGElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props),
  executeFn: executePRNG,
  pinLayout: buildPRNGPinDeclarations(8),
  propertyDefs: PRNG_PROPERTY_DEFS,
  attributeMap: PRNG_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.ARITHMETIC,
  helpText: "PRNG — pseudo-random number generator (LFSR-based). se=1 seeds; ne=1 advances on rising clock edge.",
  stateSlotCount: 2,
  defaultDelay: 10,
};
