/**
 * Type declarations for gifenc — a fast pure-JS GIF encoder.
 * Package: https://www.npmjs.com/package/gifenc
 */

declare module "gifenc" {
  /** A color palette: array of [r, g, b] or [r, g, b, a] tuples. */
  export type Palette = number[][];

  export interface QuantizeOptions {
    format?: "rgb565" | "rgb444" | "rgba4444";
    oneBitAlpha?: boolean | number;
    clearAlpha?: boolean;
    clearAlphaThreshold?: number;
    clearAlphaColor?: number;
  }

  export interface WriteFrameOptions {
    /** Color table for this frame (required for first frame). */
    palette?: Palette;
    /** Set true when encoding the first frame in non-auto mode. */
    first?: boolean;
    /** Enable 1-bit transparency. */
    transparent?: boolean;
    /** Palette index treated as fully transparent. */
    transparentIndex?: number;
    /** Frame delay in milliseconds. */
    delay?: number;
    /** Repeat count: -1 = once, 0 = forever, positive = N repetitions. */
    repeat?: number;
    /** GIF dispose flag override (-1 = use default). */
    dispose?: number;
  }

  export interface GIFStream {
    writeByte(byte: number): void;
    writeBytes(data: Uint8Array, offset: number, byteLength: number): void;
  }

  export interface GIFEncoderInstance {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: WriteFrameOptions,
    ): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    writeHeader(): void;
    reset(): void;
    readonly buffer: ArrayBuffer;
    readonly stream: GIFStream;
  }

  export interface GIFEncoderOptions {
    /** Auto-write header on first frame. Default: true. */
    auto?: boolean;
    /** Initial buffer capacity in bytes. Default: 4096. */
    initialCapacity?: number;
  }

  /**
   * Quantize RGBA pixel data to a color palette of at most maxColors entries.
   */
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: QuantizeOptions,
  ): Palette;

  /**
   * Map each pixel in rgba to the nearest palette index.
   * Returns a Uint8Array of length rgba.length / 4.
   */
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: Palette,
    format?: string,
  ): Uint8Array;

  /**
   * Find the index of the nearest color in the palette to the given pixel.
   */
  export function nearestColorIndex(
    palette: Palette,
    pixel: number[],
  ): number;

  /**
   * Create a new GIF encoder stream.
   */
  export function GIFEncoder(opts?: GIFEncoderOptions): GIFEncoderInstance;
}
