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
import { drawGenericShape } from "../generic-shape.js";
import type { Pin, PinDeclaration, Rotation } from "../../core/pin.js";
import {
  PinDirection,
  createInverterConfig,
  resolvePins,
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
// Java VGA uses GenericShape: 6 inputs (R,G,B,H,V,C), 0 outputs, width=3
// Non-symmetric → offs=0. R@(0,0), G@(0,1), B@(0,2), H@(0,3), V@(0,4), C@(0,5)
// → COMP_WIDTH=3, COMP_HEIGHT=6
// ---------------------------------------------------------------------------

const COMP_WIDTH = 3;
const COMP_HEIGHT = 6;

const DEFAULT_COLOR_BITS = 4;
const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 480;

// ---------------------------------------------------------------------------
// Pin layout — Java GenericShape(6 inputs, 0 outputs, width=3):
//   R at (0, 0), G at (0, 1), B at (0, 2), H at (0, 3), V at (0, 4), C at (0, 5)
// ---------------------------------------------------------------------------

function buildVgaPinDeclarations(colorBits: number): PinDeclaration[] {
  return [
    {
      direction: PinDirection.INPUT,
      label: "R",
      defaultBitWidth: colorBits,
      position: { x: 0, y: 0 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "G",
      defaultBitWidth: colorBits,
      position: { x: 0, y: 1 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "B",
      defaultBitWidth: colorBits,
      position: { x: 0, y: 2 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "H",
      defaultBitWidth: 1,
      position: { x: 0, y: 3 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "V",
      defaultBitWidth: 1,
      position: { x: 0, y: 4 },
      isNegatable: false,
      isClockCapable: false,
    },
    {
      direction: PinDirection.INPUT,
      label: "C",
      defaultBitWidth: 1,
      position: { x: 0, y: 5 },
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
      x: this.position.x + 0.05,
      y: this.position.y - 0.5,
      width: (COMP_WIDTH - 0.05) - 0.05,
      height: COMP_HEIGHT,
    };
  }

  draw(ctx: RenderContext): void {
    const label = this._properties.getOrDefault<string>("label", "");
    drawGenericShape(ctx, {
      inputLabels: ["R", "G", "B", "H", "V", "C"],
      outputLabels: [],
      clockInputIndices: [5],
      componentName: "VGA",
      width: COMP_WIDTH,
      ...(label.length > 0 ? { label } : {}),
    });
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
  _index: number,
  _state: Uint32Array,
  _highZs: Uint32Array,
  _layout: ComponentLayout,
): void {
  // VGA has no outputs — it is a display-only sink component.
  // The display panel reads R, G, B, H, V, C inputs via the engine's
  // post-step hook accessing the element. No output slots to write.
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
