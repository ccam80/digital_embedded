/**
 * VGA component — VGA-resolution pixel display.
 *
 * Inputs:
 *   - R: colorBits-wide — red channel
 *   - G: colorBits-wide — green channel
 *   - B: colorBits-wide — blue channel
 *   - H: 1-bit — HSync signal
 *   - V: 1-bit — VSync signal
 *   - C: 1-bit — pixel clock (rising edge samples pixel)
 *
 * The VGA component decodes pixel clock, HSync, and VSync signals to build
 * a framebuffer. On each rising clock edge, the current pixel position is
 * advanced and an RGB pixel is written. HSync resets the X position and
 * advances Y. VSync resets both positions.
 *
 * Framebuffer resolution defaults to 640x480. Contents shown in a floating
 * display panel.
 *
 * internalStateCount: 0 (framebuffer lives on the element, accessed via
 * engine post-step hook calling element.writePixel()).
 *
 * The executeFn packs the current R/G/B/H/V/C inputs into an output slot
 * for engine tracking.
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
// Layout constants
// ---------------------------------------------------------------------------

const COMP_WIDTH = 4;
const COMP_HEIGHT = 6;

const DEFAULT_COLOR_BITS = 4;
const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 480;

// ---------------------------------------------------------------------------
// Pin layout — 6 inputs on the west face: R, G, B, H, V, C
// ---------------------------------------------------------------------------

function buildVgaPinDeclarations(colorBits: number): PinDeclaration[] {
  const positions = layoutPinsOnFace("west", 6, COMP_WIDTH, COMP_HEIGHT);

  return [
    {
      direction: PinDirection.INPUT,
      label: "R",
      defaultBitWidth: colorBits,
      position: positions[0],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "G",
      defaultBitWidth: colorBits,
      position: positions[1],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "B",
      defaultBitWidth: colorBits,
      position: positions[2],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "H",
      defaultBitWidth: 1,
      position: positions[3],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "V",
      defaultBitWidth: 1,
      position: positions[4],
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "C",
      defaultBitWidth: 1,
      position: positions[5],
      isNegatable: false,
      isClockCapable: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// VGAElement — CircuitElement implementation
// ---------------------------------------------------------------------------

export class VGAElement extends AbstractCircuitElement {
  /** Framebuffer: packed RGB32 values, row-major [y * frameWidth + x]. */
  private readonly _framebuffer: Uint32Array;

  /** Current pixel write position. */
  private _xPos: number;
  private _yPos: number;

  /** Previous clock value for rising-edge detection. */
  private _lastClock: boolean;

  /** Previous HSync value for edge detection. */
  private _lastHSync: boolean;

  /** Previous VSync value for edge detection. */
  private _lastVSync: boolean;

  constructor(
    instanceId: string,
    position: { x: number; y: number },
    rotation: Rotation,
    mirror: boolean,
    props: PropertyBag,
  ) {
    super("VGA", instanceId, position, rotation, mirror, props);

    const frameWidth = props.getOrDefault<number>("frameWidth", DEFAULT_WIDTH);
    const frameHeight = props.getOrDefault<number>("frameHeight", DEFAULT_HEIGHT);

    this._framebuffer = new Uint32Array(frameWidth * frameHeight);
    this._xPos = 0;
    this._yPos = 0;
    this._lastClock = false;
    this._lastHSync = false;
    this._lastVSync = false;
  }

  get colorBits(): number {
    return this._properties.getOrDefault<number>("colorBits", DEFAULT_COLOR_BITS);
  }

  get frameWidth(): number {
    return this._properties.getOrDefault<number>("frameWidth", DEFAULT_WIDTH);
  }

  get frameHeight(): number {
    return this._properties.getOrDefault<number>("frameHeight", DEFAULT_HEIGHT);
  }

  /**
   * Write a pixel at the current position with the given RGB values.
   * Called by the engine post-step hook.
   *
   * @param r Red channel value (0..2^colorBits-1)
   * @param g Green channel value
   * @param b Blue channel value
   * @param clock Current clock level
   * @param hSync Current HSync level
   * @param vSync Current VSync level
   */
  processInputs(
    r: number,
    g: number,
    b: number,
    clock: boolean,
    hSync: boolean,
    vSync: boolean,
  ): void {
    const risingClock = clock && !this._lastClock;

    if (risingClock) {
      // VSync rising edge: reset to top of frame
      if (vSync && !this._lastVSync) {
        this._yPos = 0;
      }

      // HSync rising edge: reset to start of line, advance Y
      if (hSync && !this._lastHSync) {
        this._xPos = 0;
        if (!vSync || this._lastVSync) {
          this._yPos++;
        }
      } else {
        // Normal pixel clock: write pixel, advance X
        this._writePixel(this._xPos, this._yPos, r, g, b);
        this._xPos++;
      }
    }

    this._lastClock = clock;
    this._lastHSync = hSync;
    this._lastVSync = vSync;
  }

  private _writePixel(x: number, y: number, r: number, g: number, b: number): void {
    if (x < 0 || x >= this.frameWidth || y < 0 || y >= this.frameHeight) return;

    const maxVal = (1 << this.colorBits) - 1;
    const r8 = Math.round((r / maxVal) * 255);
    const g8 = Math.round((g / maxVal) * 255);
    const b8 = Math.round((b / maxVal) * 255);

    const packed = ((r8 & 0xFF) << 16) | ((g8 & 0xFF) << 8) | (b8 & 0xFF);
    this._framebuffer[y * this.frameWidth + x] = packed;
  }

  /**
   * Directly write a pixel at (x, y) with a pre-packed RGB32 value.
   * Used for testing and direct framebuffer access.
   */
  writePixelAt(x: number, y: number, rgb: number): void {
    if (x >= 0 && x < this.frameWidth && y >= 0 && y < this.frameHeight) {
      this._framebuffer[y * this.frameWidth + x] = rgb >>> 0;
    }
  }

  /**
   * Read the packed RGB32 value at (x, y).
   */
  readPixelAt(x: number, y: number): number {
    if (x < 0 || x >= this.frameWidth || y < 0 || y >= this.frameHeight) return 0;
    return this._framebuffer[y * this.frameWidth + x];
  }

  /** Returns a snapshot of the framebuffer. */
  getFramebuffer(): Uint32Array {
    return new Uint32Array(this._framebuffer);
  }

  /** Clear the framebuffer (called on simulation reset). */
  clearFramebuffer(): void {
    this._framebuffer.fill(0);
    this._xPos = 0;
    this._yPos = 0;
    this._lastClock = false;
    this._lastHSync = false;
    this._lastVSync = false;
  }

  getPins(): readonly Pin[] {
    return resolvePins(
      buildVgaPinDeclarations(this.colorBits),
      { x: 0, y: 0 },
      0,
      createInverterConfig([]),
      { clockPins: new Set<string>(["C"]) },
    );
  }

  getBoundingBox(): Rect {
    return {
      x: this.position.x,
      y: this.position.y,
      width: COMP_WIDTH,
      height: COMP_HEIGHT,
    };
  }

  draw(ctx: RenderContext): void {

    ctx.save();

    // Component body
    ctx.setColor("COMPONENT_FILL");
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, true);
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0, 0, COMP_WIDTH, COMP_HEIGHT, false);

    // Screen representation: a small rectangle with scan lines
    ctx.setColor("COMPONENT");
    ctx.setLineWidth(1);
    ctx.drawRect(0.5, 0.8, COMP_WIDTH - 1, COMP_HEIGHT - 1.8, false);

    // Scan line icon
    const scanY = 1.4;
    const scanStep = 0.4;
    for (let i = 0; i < 4; i++) {
      ctx.drawLine(0.7, scanY + i * scanStep, COMP_WIDTH - 0.7, scanY + i * scanStep);
    }

    // Label
    ctx.setColor("TEXT");
    ctx.setFont({ family: "sans-serif", size: 0.6 });
    ctx.drawText("VGA", COMP_WIDTH / 2, COMP_HEIGHT + 0.3, {
      horizontal: "center",
      vertical: "top",
    });

    ctx.restore();
  }

  getHelpText(): string {
    return (
      "VGA — VGA-resolution pixel display.\n" +
      "Inputs: R, G, B (color channels), H (HSync), V (VSync), C (pixel clock).\n" +
      "Rising clock edge samples a pixel. HSync resets X, VSync resets Y.\n" +
      "Framebuffer contents displayed in a floating panel.\n" +
      "colorBits: bit width of each color channel (default 4).\n" +
      "frameWidth/frameHeight: framebuffer resolution (default 640x480)."
    );
  }
}

// ---------------------------------------------------------------------------
// executeVga — read inputs, pack into output slot for engine tracking
// ---------------------------------------------------------------------------

export function executeVga(
  index: number,
  state: Uint32Array,
  _highZs: Uint32Array,
  layout: ComponentLayout,
): void {
  const wt = layout.wiringTable;
  const inputStart = layout.inputOffset(index);
  // Inputs: [R=0, G=1, B=2, H=3, V=4, C=5]
  const r = state[wt[inputStart]] >>> 0;
  const g = state[wt[inputStart + 1]] >>> 0;
  const b = state[wt[inputStart + 2]] >>> 0;
  const h = state[wt[inputStart + 3]] & 1;
  const v = state[wt[inputStart + 4]] & 1;
  const c = state[wt[inputStart + 5]] & 1;

  // Pack all signals into output slot for change detection
  state[wt[layout.outputOffset(index)]] =
    ((r & 0xF) << 8) | ((g & 0xF) << 4) | (b & 0xF) |
    (h << 16) | (v << 17) | (c << 18);
}

// ---------------------------------------------------------------------------
// VGA_ATTRIBUTE_MAPPINGS — .dig XML attribute → PropertyBag conversions
// ---------------------------------------------------------------------------

export const VGA_ATTRIBUTE_MAPPINGS: AttributeMapping[] = [
  {
    xmlName: "Label",
    propertyKey: "label",
    convert: (v) => v,
  },
  {
    xmlName: "colorBits",
    propertyKey: "colorBits",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "frameWidth",
    propertyKey: "frameWidth",
    convert: (v) => parseInt(v, 10),
  },
  {
    xmlName: "frameHeight",
    propertyKey: "frameHeight",
    convert: (v) => parseInt(v, 10),
  },
];

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------

const VGA_PROPERTY_DEFS: PropertyDefinition[] = [
  {
    key: "label",
    type: PropertyType.STRING,
    label: "Label",
    defaultValue: "",
    description: "Optional label for the component",
  },
  {
    key: "colorBits",
    type: PropertyType.BIT_WIDTH,
    label: "Color bits",
    defaultValue: DEFAULT_COLOR_BITS,
    min: 1,
    max: 8,
    description: "Bit width of each color channel (R, G, B)",
  },
  {
    key: "frameWidth",
    type: PropertyType.INT,
    label: "Frame width",
    defaultValue: DEFAULT_WIDTH,
    min: 1,
    max: 1920,
    description: "Framebuffer width in pixels",
  },
  {
    key: "frameHeight",
    type: PropertyType.INT,
    label: "Frame height",
    defaultValue: DEFAULT_HEIGHT,
    min: 1,
    max: 1200,
    description: "Framebuffer height in pixels",
  },
];

// ---------------------------------------------------------------------------
// VGADefinition — ComponentDefinition for registry registration
// ---------------------------------------------------------------------------

function vgaFactory(props: PropertyBag): VGAElement {
  return new VGAElement(crypto.randomUUID(), { x: 0, y: 0 }, 0, false, props);
}

export const VGADefinition: ComponentDefinition = {
  name: "VGA",
  typeId: -1,
  factory: vgaFactory,
  executeFn: executeVga,
  pinLayout: buildVgaPinDeclarations(DEFAULT_COLOR_BITS),
  propertyDefs: VGA_PROPERTY_DEFS,
  attributeMap: VGA_ATTRIBUTE_MAPPINGS,
  category: ComponentCategory.GRAPHICS,
  helpText:
    "VGA — VGA-resolution pixel display.\n" +
    "Inputs: R, G, B (color channels), H (HSync), V (VSync), C (pixel clock).\n" +
    "Rising clock edge samples a pixel. HSync resets X, VSync resets Y.\n" +
    "Framebuffer contents displayed in a floating panel.\n" +
    "colorBits: bit width of each color channel (default 4).\n" +
    "frameWidth/frameHeight: framebuffer resolution (default 640x480).",
};
