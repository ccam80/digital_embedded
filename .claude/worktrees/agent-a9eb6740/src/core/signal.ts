/**
 * Signal value types for the digital logic simulator.
 *
 * Provides two representations:
 *   1. BitVector — rich OOP API for UI code (property panels, tooltips, data tables).
 *      Allocates. Used at low frequency.
 *   2. Flat Uint32Array slots — zero-allocation hot path for the engine inner loop and
 *      wire coloring. High-Z state is stored in a parallel Uint32Array.
 *
 * Flat representation layout:
 *   - Signals ≤ 32 bits:  one slot in the value array + one slot in the highZ array.
 *   - Signals 33–64 bits: two consecutive slots (low word at index, high word at index+1)
 *     in both arrays. Only values up to 64 bits are supported.
 *   - UNDEFINED is encoded as value=0 with highZ=0xFFFFFFFF (all bits Z). The distinction
 *     between "all HIGH_Z" and "UNDEFINED" is carried only in BitVector.isUndefined. In the
 *     flat representation they are identical (highZ mask set). This is the same approach
 *     Digital's ObservableValue uses: HIGH_Z bits are zeroed in the value field.
 */

// ---------------------------------------------------------------------------
// Bit enum — state of a single bit line
// ---------------------------------------------------------------------------

/** State of a single bit on a signal line. */
export const enum Bit {
  ZERO = 0,
  ONE = 1,
  HIGH_Z = 2,
  UNDEFINED = 3,
}

// ---------------------------------------------------------------------------
// Display format
// ---------------------------------------------------------------------------

/**
 * How a BitVector is rendered as a string.
 * Matches IntFormat variants from Digital's Java source.
 */
export type DisplayFormat =
  | "bin"
  | "oct"
  | "dec"
  | "decSigned"
  | "hex"
  | "ascii";

// ---------------------------------------------------------------------------
// BitVector — rich multi-bit signal value
// ---------------------------------------------------------------------------

/**
 * Arbitrary-width multi-bit signal value (1–64 bits).
 *
 * Stores the value as a bigint internally so that all widths up to 64 bits are
 * handled uniformly. HIGH_Z and UNDEFINED bits are tracked in a separate bigint
 * mask (highZMask). A bit that is HIGH_Z or UNDEFINED has its position set in
 * highZMask AND the corresponding value bit is zero (matching Digital's invariant:
 * "high Z bits are always set to zero").
 *
 * UNDEFINED is represented as highZMask === fullMask AND the isUndefined flag set.
 * This matches the semantic used in circuit analysis: UNDEFINED propagates through
 * logic gates differently from HIGH_Z (which collapses on a wired-or bus).
 */
export class BitVector {
  readonly width: number;

  /** Raw value bits. Bits that are HIGH_Z/UNDEFINED are always 0 here. */
  private readonly _value: bigint;

  /**
   * Mask of bits that are in HIGH_Z or UNDEFINED state.
   * Bit position i is set when bit i is HIGH_Z or UNDEFINED.
   */
  private readonly _highZMask: bigint;

  /** True when the entire value is UNDEFINED (not merely HIGH_Z). */
  readonly isUndefined: boolean;

  private constructor(
    width: number,
    value: bigint,
    highZMask: bigint,
    isUndefined: boolean,
  ) {
    this.width = width;
    this._value = value;
    this._highZMask = highZMask;
    this.isUndefined = isUndefined;
  }

  // -------------------------------------------------------------------------
  // Factory methods
  // -------------------------------------------------------------------------

  /**
   * Create a BitVector from a numeric value with no HIGH_Z bits.
   * The value is masked to `width` bits.
   */
  static fromNumber(value: number, width: number): BitVector {
    validateWidth(width);
    const mask = fullMask(width);
    return new BitVector(width, BigInt(value) & mask, 0n, false);
  }

  /**
   * Create a BitVector from a bigint value with no HIGH_Z bits.
   * The value is masked to `width` bits.
   */
  static fromBigInt(value: bigint, width: number): BitVector {
    validateWidth(width);
    const mask = fullMask(width);
    return new BitVector(width, value & mask, 0n, false);
  }

  /** Create a BitVector where every bit is HIGH_Z. */
  static allHighZ(width: number): BitVector {
    validateWidth(width);
    const mask = fullMask(width);
    return new BitVector(width, 0n, mask, false);
  }

  /** Create a BitVector where every bit is UNDEFINED. */
  static allUndefined(width: number): BitVector {
    validateWidth(width);
    const mask = fullMask(width);
    return new BitVector(width, 0n, mask, true);
  }

  /**
   * Create from raw flat representation.
   * `rawValue` is the value word (or low word for >32-bit).
   * `rawHighZ` is the HIGH_Z mask (same slot layout).
   * For widths > 32: `rawValueHi` and `rawHighZHi` are the high words.
   */
  static fromRaw(
    rawValue: number,
    rawHighZ: number,
    width: number,
    rawValueHi?: number,
    rawHighZHi?: number,
  ): BitVector {
    validateWidth(width);
    const mask = fullMask(width);

    let valueBig: bigint;
    let highZBig: bigint;

    if (width <= 32) {
      valueBig = BigInt(rawValue >>> 0) & mask;
      highZBig = BigInt(rawHighZ >>> 0) & mask;
    } else {
      const lo = BigInt(rawValue >>> 0);
      const hi = BigInt((rawValueHi ?? 0) >>> 0);
      valueBig = ((hi << 32n) | lo) & mask;
      const loZ = BigInt(rawHighZ >>> 0);
      const hiZ = BigInt((rawHighZHi ?? 0) >>> 0);
      highZBig = ((hiZ << 32n) | loZ) & mask;
    }

    // High-Z bits must be zero in the value field (Digital's invariant)
    valueBig = valueBig & ~highZBig;

    return new BitVector(width, valueBig, highZBig, false);
  }

  // -------------------------------------------------------------------------
  // Conversions
  // -------------------------------------------------------------------------

  /** Convert to a JS number. Throws if width > 32 or any bit is HIGH_Z/UNDEFINED. */
  toNumber(): number {
    if (this._highZMask !== 0n) {
      throw new RangeError("Cannot convert HIGH_Z or UNDEFINED BitVector to number");
    }
    if (this.width > 32) {
      throw new RangeError("Cannot convert >32-bit BitVector to number; use toBigInt()");
    }
    return Number(this._value);
  }

  /** Convert to a bigint. Throws if any bit is HIGH_Z/UNDEFINED. */
  toBigInt(): bigint {
    if (this._highZMask !== 0n) {
      throw new RangeError("Cannot convert HIGH_Z or UNDEFINED BitVector to bigint");
    }
    return this._value;
  }

  /**
   * Convert to a signed JS number (two's complement).
   * Throws if width > 32 or any bit is HIGH_Z/UNDEFINED.
   */
  toSignedNumber(): number {
    const unsigned = this.toNumber();
    const signBit = 1 << (this.width - 1);
    if (unsigned & signBit) {
      return unsigned - (signBit << 1);
    }
    return unsigned;
  }

  /**
   * Convert to a signed bigint (two's complement).
   * Throws if any bit is HIGH_Z/UNDEFINED.
   */
  toSignedBigInt(): bigint {
    const unsigned = this.toBigInt();
    const signBit = 1n << BigInt(this.width - 1);
    if (unsigned & signBit) {
      return unsigned - (signBit << 1n);
    }
    return unsigned;
  }

  /** True if any bit is HIGH_Z or UNDEFINED. */
  get isHighZ(): boolean {
    return this._highZMask !== 0n;
  }

  /** The raw HIGH_Z mask as a bigint. */
  get highZMask(): bigint {
    return this._highZMask;
  }

  /** The raw value bigint (HIGH_Z bits are 0). */
  get valueBits(): bigint {
    return this._value;
  }

  // -------------------------------------------------------------------------
  // Display
  // -------------------------------------------------------------------------

  /**
   * Format the value as a string.
   *
   * - If all bits are HIGH_Z: returns "Z".
   * - If any (but not all) bits are HIGH_Z: returns a per-bit string where Z
   *   bits are rendered as 'z' (binary-style), regardless of requested format.
   * - If isUndefined: returns "X".
   * - Otherwise: renders in the requested format.
   *
   * @param format Display format (default: "hex")
   */
  toString(format: DisplayFormat = "hex"): string {
    const mask = fullMask(this.width);

    if (this.isUndefined) {
      return "X";
    }

    if (this._highZMask === mask) {
      return "Z";
    }

    if (this._highZMask !== 0n) {
      // Mixed HIGH_Z — render bit by bit
      return formatMixed(this._value, this._highZMask, this.width);
    }

    switch (format) {
      case "bin":
        return formatBinary(this._value, this.width);
      case "oct":
        return formatOctal(this._value, this.width);
      case "dec":
        return this._value.toString(10);
      case "decSigned":
        return this.toSignedBigInt().toString(10);
      case "hex":
        return formatHex(this._value, this.width);
      case "ascii":
        return formatAscii(this._value);
    }
  }

  // -------------------------------------------------------------------------
  // Arithmetic
  // -------------------------------------------------------------------------

  add(other: BitVector): BitVector {
    assertCompatible(this, other);
    if (this._highZMask !== 0n || other._highZMask !== 0n) {
      return BitVector.allUndefined(this.width);
    }
    const mask = fullMask(this.width);
    return new BitVector(this.width, (this._value + other._value) & mask, 0n, false);
  }

  subtract(other: BitVector): BitVector {
    assertCompatible(this, other);
    if (this._highZMask !== 0n || other._highZMask !== 0n) {
      return BitVector.allUndefined(this.width);
    }
    const mask = fullMask(this.width);
    return new BitVector(this.width, (this._value - other._value + (mask + 1n)) & mask, 0n, false);
  }

  and(other: BitVector): BitVector {
    assertCompatible(this, other);
    if (this._highZMask !== 0n || other._highZMask !== 0n) {
      return BitVector.allUndefined(this.width);
    }
    return new BitVector(this.width, this._value & other._value, 0n, false);
  }

  or(other: BitVector): BitVector {
    assertCompatible(this, other);
    if (this._highZMask !== 0n || other._highZMask !== 0n) {
      return BitVector.allUndefined(this.width);
    }
    return new BitVector(this.width, this._value | other._value, 0n, false);
  }

  xor(other: BitVector): BitVector {
    assertCompatible(this, other);
    if (this._highZMask !== 0n || other._highZMask !== 0n) {
      return BitVector.allUndefined(this.width);
    }
    return new BitVector(this.width, this._value ^ other._value, 0n, false);
  }

  not(): BitVector {
    if (this._highZMask !== 0n) {
      return BitVector.allUndefined(this.width);
    }
    const mask = fullMask(this.width);
    return new BitVector(this.width, (~this._value) & mask, 0n, false);
  }

  shiftLeft(bits: number): BitVector {
    if (this._highZMask !== 0n) {
      return BitVector.allUndefined(this.width);
    }
    const mask = fullMask(this.width);
    return new BitVector(this.width, (this._value << BigInt(bits)) & mask, 0n, false);
  }

  shiftRight(bits: number): BitVector {
    if (this._highZMask !== 0n) {
      return BitVector.allUndefined(this.width);
    }
    return new BitVector(this.width, this._value >> BigInt(bits), 0n, false);
  }

  shiftRightArithmetic(bits: number): BitVector {
    if (this._highZMask !== 0n) {
      return BitVector.allUndefined(this.width);
    }
    const signed = this.toSignedBigInt();
    const mask = fullMask(this.width);
    return new BitVector(this.width, (signed >> BigInt(bits)) & mask, 0n, false);
  }

  // -------------------------------------------------------------------------
  // Comparison
  // -------------------------------------------------------------------------

  /**
   * Strict equality: both value and highZMask must match exactly.
   * Use equalsWithDontCare for UNDEFINED-tolerant comparison.
   */
  equals(other: BitVector): boolean {
    return (
      this.width === other.width &&
      this._value === other._value &&
      this._highZMask === other._highZMask &&
      this.isUndefined === other.isUndefined
    );
  }

  /**
   * Equality with don't-care for UNDEFINED bits.
   * Any bit position that is UNDEFINED in either operand is considered matching.
   */
  equalsWithDontCare(other: BitVector): boolean {
    if (this.width !== other.width) return false;
    const dontCare = this._highZMask | other._highZMask;
    const mask = fullMask(this.width) & ~dontCare;
    return (this._value & mask) === (other._value & mask);
  }

  // -------------------------------------------------------------------------
  // Flat conversion
  // -------------------------------------------------------------------------

  /**
   * Convert to raw flat representation for the signal array.
   * Returns { valueLo, valueHi, highZLo, highZHi }.
   * For widths ≤ 32, Hi words are always 0.
   */
  toRaw(): { valueLo: number; valueHi: number; highZLo: number; highZHi: number } {
    const LOW_MASK = 0xFFFFFFFFn;
    const valueLo = Number(this._value & LOW_MASK) >>> 0;
    const valueHi = Number((this._value >> 32n) & LOW_MASK) >>> 0;
    const highZLo = Number(this._highZMask & LOW_MASK) >>> 0;
    const highZHi = Number((this._highZMask >> 32n) & LOW_MASK) >>> 0;
    return { valueLo, valueHi, highZLo, highZHi };
  }

  // -------------------------------------------------------------------------
  // Static factory from raw (convenience for ≤ 32-bit single-slot case)
  // -------------------------------------------------------------------------

  static from(raw: number, width: number): BitVector {
    return BitVector.fromRaw(raw, 0, width);
  }
}

// ---------------------------------------------------------------------------
// Flat representation conversion functions
// ---------------------------------------------------------------------------

/**
 * Write a BitVector into a signal array pair at the given slot index.
 *
 * For widths ≤ 32: writes one slot (index).
 * For widths > 32: writes two slots (index = low word, index+1 = high word).
 *
 * @param bv       The BitVector to write
 * @param values   The signal value array (Uint32Array)
 * @param highZs   The HIGH_Z mask array (Uint32Array, parallel to values)
 * @param index    Slot index in the arrays
 */
export function bitVectorToRaw(
  bv: BitVector,
  values: Uint32Array,
  highZs: Uint32Array,
  index: number,
): void {
  const { valueLo, valueHi, highZLo, highZHi } = bv.toRaw();
  values[index] = valueLo;
  highZs[index] = highZLo;
  if (bv.width > 32) {
    values[index + 1] = valueHi;
    highZs[index + 1] = highZHi;
  }
}

/**
 * Read a BitVector from a signal array pair at the given slot index.
 *
 * @param values   The signal value array (Uint32Array)
 * @param highZs   The HIGH_Z mask array (Uint32Array, parallel to values)
 * @param index    Slot index in the arrays
 * @param width    Bit width of the signal
 */
export function rawToBitVector(
  values: Uint32Array,
  highZs: Uint32Array,
  index: number,
  width: number,
): BitVector {
  if (width <= 32) {
    return BitVector.fromRaw(values[index], highZs[index], width);
  }
  return BitVector.fromRaw(
    values[index],
    highZs[index],
    width,
    values[index + 1],
    highZs[index + 1],
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function validateWidth(width: number): void {
  if (!Number.isInteger(width) || width < 1 || width > 64) {
    throw new RangeError(`BitVector width must be 1–64, got ${width}`);
  }
}

function fullMask(width: number): bigint {
  if (width === 64) return 0xFFFFFFFFFFFFFFFFn;
  return (1n << BigInt(width)) - 1n;
}

function assertCompatible(a: BitVector, b: BitVector): void {
  if (a.width !== b.width) {
    throw new RangeError(`BitVector width mismatch: ${a.width} vs ${b.width}`);
  }
}


function formatMixed(value: bigint, highZMask: bigint, width: number): string {
  let result = "";
  for (let i = width - 1; i >= 0; i--) {
    const bit = 1n << BigInt(i);
    if (highZMask & bit) {
      result += "z";
    } else {
      result += value & bit ? "1" : "0";
    }
  }
  return result;
}

function formatBinary(value: bigint, width: number): string {
  let result = "0b";
  for (let i = width - 1; i >= 0; i--) {
    result += value & (1n << BigInt(i)) ? "1" : "0";
  }
  return result;
}

function formatOctal(value: bigint, width: number): string {
  const numDigits = Math.ceil(width / 3);
  let result = "0";
  for (let i = numDigits - 1; i >= 0; i--) {
    result += ((value >> BigInt(i * 3)) & 7n).toString();
  }
  return result;
}

function formatHex(value: bigint, width: number): string {
  const numDigits = Math.ceil(width / 4);
  const HEX = "0123456789ABCDEF";
  let result = "0x";
  for (let i = numDigits - 1; i >= 0; i--) {
    result += HEX[Number((value >> BigInt(i * 4)) & 15n)];
  }
  return result;
}

function formatAscii(value: bigint): string {
  return "'" + String.fromCharCode(Number(value & 0xFFn)) + "'";
}
