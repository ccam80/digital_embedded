import { describe, it, expect } from "vitest";
import {
  Bit,
  BitVector,
  bitVectorToRaw,
  rawToBitVector,
} from "../signal";

// ---------------------------------------------------------------------------
// Bit enum
// ---------------------------------------------------------------------------

describe("Bit enum", () => {
  it("has correct numeric values", () => {
    expect(Bit.ZERO).toBe(0);
    expect(Bit.ONE).toBe(1);
    expect(Bit.HIGH_Z).toBe(2);
    expect(Bit.UNDEFINED).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// BitVector.fromNumber / fromBigInt
// ---------------------------------------------------------------------------

describe("BitVector.fromNumber", () => {
  it("creates a 1-bit zero", () => {
    const bv = BitVector.fromNumber(0, 1);
    expect(bv.width).toBe(1);
    expect(bv.toNumber()).toBe(0);
    expect(bv.isHighZ).toBe(false);
    expect(bv.isUndefined).toBe(false);
  });

  it("creates a 1-bit one", () => {
    const bv = BitVector.fromNumber(1, 1);
    expect(bv.toNumber()).toBe(1);
  });

  it("masks value to width", () => {
    const bv = BitVector.fromNumber(0xff, 4);
    expect(bv.toNumber()).toBe(0xf);
  });

  it("creates an 8-bit value", () => {
    const bv = BitVector.fromNumber(0xab, 8);
    expect(bv.toNumber()).toBe(0xab);
    expect(bv.width).toBe(8);
  });

  it("creates a 32-bit max value", () => {
    const bv = BitVector.fromNumber(0xffffffff, 32);
    expect(bv.toNumber()).toBe(0xffffffff);
  });

  it("rejects width 0", () => {
    expect(() => BitVector.fromNumber(0, 0)).toThrow(RangeError);
  });

  it("rejects width 65", () => {
    expect(() => BitVector.fromNumber(0, 65)).toThrow(RangeError);
  });
});

describe("BitVector.fromBigInt", () => {
  it("creates a 64-bit value", () => {
    const val = 0xDEADBEEFCAFEBABEn;
    const bv = BitVector.fromBigInt(val, 64);
    expect(bv.toBigInt()).toBe(val);
    expect(bv.width).toBe(64);
  });

  it("masks to width", () => {
    const bv = BitVector.fromBigInt(0xFFFFn, 8);
    expect(bv.toBigInt()).toBe(0xFFn);
  });
});

// ---------------------------------------------------------------------------
// HIGH_Z and UNDEFINED factories
// ---------------------------------------------------------------------------

describe("BitVector.allHighZ", () => {
  it("marks all bits HIGH_Z", () => {
    const bv = BitVector.allHighZ(8);
    expect(bv.isHighZ).toBe(true);
    expect(bv.width).toBe(8);
    expect(bv.highZMask).toBe(0xFFn);
    expect(bv.valueBits).toBe(0n);
  });

  it("1-bit HIGH_Z", () => {
    const bv = BitVector.allHighZ(1);
    expect(bv.isHighZ).toBe(true);
    expect(bv.highZMask).toBe(1n);
  });

  it("64-bit HIGH_Z has full mask", () => {
    const bv = BitVector.allHighZ(64);
    expect(bv.isHighZ).toBe(true);
    expect(bv.highZMask).toBe(0xFFFFFFFFFFFFFFFFn);
  });
});

describe("BitVector.allUndefined", () => {
  it("marks as undefined", () => {
    const bv = BitVector.allUndefined(8);
    expect(bv.isUndefined).toBe(true);
    expect(bv.isHighZ).toBe(true);
    expect(bv.width).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// toNumber / toBigInt guards
// ---------------------------------------------------------------------------

describe("toNumber / toBigInt guards", () => {
  it("toNumber throws for HIGH_Z", () => {
    expect(() => BitVector.allHighZ(8).toNumber()).toThrow(RangeError);
  });

  it("toNumber throws for UNDEFINED", () => {
    expect(() => BitVector.allUndefined(8).toNumber()).toThrow(RangeError);
  });

  it("toNumber throws for width > 32", () => {
    const bv = BitVector.fromBigInt(1n, 33);
    expect(() => bv.toNumber()).toThrow(RangeError);
  });

  it("toBigInt throws for HIGH_Z", () => {
    expect(() => BitVector.allHighZ(8).toBigInt()).toThrow(RangeError);
  });

  it("toBigInt throws for UNDEFINED", () => {
    expect(() => BitVector.allUndefined(8).toBigInt()).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Signed conversion
// ---------------------------------------------------------------------------

describe("toSignedNumber", () => {
  it("positive 4-bit value stays positive", () => {
    const bv = BitVector.fromNumber(7, 4);
    expect(bv.toSignedNumber()).toBe(7);
  });

  it("negative 4-bit value is sign-extended", () => {
    const bv = BitVector.fromNumber(0b1000, 4); // -8 in signed 4-bit
    expect(bv.toSignedNumber()).toBe(-8);
  });

  it("0xF as 4-bit signed is -1", () => {
    const bv = BitVector.fromNumber(0xf, 4);
    expect(bv.toSignedNumber()).toBe(-1);
  });

  it("0x80 as 8-bit signed is -128", () => {
    const bv = BitVector.fromNumber(0x80, 8);
    expect(bv.toSignedNumber()).toBe(-128);
  });
});

describe("toSignedBigInt", () => {
  it("negative 64-bit value", () => {
    // 0xFFFFFFFFFFFFFFFF in 64-bit signed is -1
    const bv = BitVector.fromBigInt(0xFFFFFFFFFFFFFFFFn, 64);
    expect(bv.toSignedBigInt()).toBe(-1n);
  });

  it("positive 64-bit value unchanged", () => {
    const bv = BitVector.fromBigInt(42n, 64);
    expect(bv.toSignedBigInt()).toBe(42n);
  });
});

// ---------------------------------------------------------------------------
// Display formatting
// ---------------------------------------------------------------------------

describe("BitVector.toString", () => {
  it("formats hex by default", () => {
    const bv = BitVector.fromNumber(0xAB, 8);
    expect(bv.toString()).toBe("0xAB");
  });

  it("formats hex explicit", () => {
    const bv = BitVector.fromNumber(0xAB, 8);
    expect(bv.toString("hex")).toBe("0xAB");
  });

  it("formats binary", () => {
    const bv = BitVector.fromNumber(0b1010, 4);
    expect(bv.toString("bin")).toBe("0b1010");
  });

  it("formats binary with leading zeros", () => {
    const bv = BitVector.fromNumber(0b0010, 4);
    expect(bv.toString("bin")).toBe("0b0010");
  });

  it("formats decimal", () => {
    const bv = BitVector.fromNumber(42, 8);
    expect(bv.toString("dec")).toBe("42");
  });

  it("formats signed decimal for negative", () => {
    const bv = BitVector.fromNumber(0xf, 4);
    expect(bv.toString("decSigned")).toBe("-1");
  });

  it("formats signed decimal for positive", () => {
    const bv = BitVector.fromNumber(7, 4);
    expect(bv.toString("decSigned")).toBe("7");
  });

  it("formats octal", () => {
    const bv = BitVector.fromNumber(0b111, 3);
    expect(bv.toString("oct")).toBe("07");
  });

  it("formats octal for 8-bit", () => {
    const bv = BitVector.fromNumber(0xff, 8);
    // 3 octal digits for 8-bit: ceil(8/3) = 3
    expect(bv.toString("oct")).toBe("0377");
  });

  it("formats ascii", () => {
    const bv = BitVector.fromNumber(65, 8); // 'A'
    expect(bv.toString("ascii")).toBe("'A'");
  });

  it("returns 'Z' for all HIGH_Z (8-bit)", () => {
    expect(BitVector.allHighZ(8).toString()).toBe("Z");
  });

  it("returns 'X' for UNDEFINED", () => {
    expect(BitVector.allUndefined(8).toString()).toBe("X");
  });

  it("returns per-bit string for mixed HIGH_Z", () => {
    // value=0b0101, highZMask=0b1010 on 4-bit: bits 3,1 are Z
    const bv = BitVector.fromRaw(0b0101, 0b1010, 4);
    // bit 3 = Z, bit 2 = 1, bit 1 = Z, bit 0 = 1
    expect(bv.toString()).toBe("z1z1");
  });

  it("hex for 4-bit zero is '0x0'", () => {
    const bv = BitVector.fromNumber(0, 4);
    expect(bv.toString("hex")).toBe("0x0");
  });

  it("hex for 16-bit value has 4 digits", () => {
    const bv = BitVector.fromNumber(0x1234, 16);
    expect(bv.toString("hex")).toBe("0x1234");
  });
});

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

describe("Arithmetic", () => {
  it("add basic", () => {
    const a = BitVector.fromNumber(3, 8);
    const b = BitVector.fromNumber(4, 8);
    expect(a.add(b).toNumber()).toBe(7);
  });

  it("add wraps at width boundary", () => {
    const a = BitVector.fromNumber(255, 8);
    const b = BitVector.fromNumber(1, 8);
    expect(a.add(b).toNumber()).toBe(0);
  });

  it("subtract basic", () => {
    const a = BitVector.fromNumber(10, 8);
    const b = BitVector.fromNumber(3, 8);
    expect(a.subtract(b).toNumber()).toBe(7);
  });

  it("subtract wraps (unsigned underflow)", () => {
    const a = BitVector.fromNumber(0, 8);
    const b = BitVector.fromNumber(1, 8);
    expect(a.subtract(b).toNumber()).toBe(255);
  });

  it("and", () => {
    const a = BitVector.fromNumber(0b1100, 4);
    const b = BitVector.fromNumber(0b1010, 4);
    expect(a.and(b).toNumber()).toBe(0b1000);
  });

  it("or", () => {
    const a = BitVector.fromNumber(0b1100, 4);
    const b = BitVector.fromNumber(0b1010, 4);
    expect(a.or(b).toNumber()).toBe(0b1110);
  });

  it("xor", () => {
    const a = BitVector.fromNumber(0b1100, 4);
    const b = BitVector.fromNumber(0b1010, 4);
    expect(a.xor(b).toNumber()).toBe(0b0110);
  });

  it("not", () => {
    const a = BitVector.fromNumber(0b1010, 4);
    expect(a.not().toNumber()).toBe(0b0101);
  });

  it("shiftLeft", () => {
    const a = BitVector.fromNumber(0b0001, 4);
    expect(a.shiftLeft(2).toNumber()).toBe(0b0100);
  });

  it("shiftLeft masks at width", () => {
    const a = BitVector.fromNumber(0b1000, 4);
    expect(a.shiftLeft(1).toNumber()).toBe(0b0000);
  });

  it("shiftRight", () => {
    const a = BitVector.fromNumber(0b1000, 4);
    expect(a.shiftRight(2).toNumber()).toBe(0b0010);
  });

  it("shiftRightArithmetic preserves sign for negative", () => {
    const a = BitVector.fromNumber(0b1000, 4); // -8 signed
    expect(a.shiftRightArithmetic(1).toSignedNumber()).toBe(-4);
  });

  it("shiftRightArithmetic preserves sign for positive", () => {
    const a = BitVector.fromNumber(0b0110, 4); // 6 signed
    expect(a.shiftRightArithmetic(1).toNumber()).toBe(3);
  });

  it("arithmetic ops with HIGH_Z produce UNDEFINED", () => {
    const a = BitVector.fromNumber(3, 8);
    const z = BitVector.allHighZ(8);
    expect(a.add(z).isUndefined).toBe(true);
    expect(a.subtract(z).isUndefined).toBe(true);
    expect(a.and(z).isUndefined).toBe(true);
    expect(a.or(z).isUndefined).toBe(true);
    expect(a.xor(z).isUndefined).toBe(true);
    expect(BitVector.allHighZ(8).not().isUndefined).toBe(true);
    expect(BitVector.allHighZ(8).shiftLeft(1).isUndefined).toBe(true);
    expect(BitVector.allHighZ(8).shiftRight(1).isUndefined).toBe(true);
    expect(BitVector.allHighZ(8).shiftRightArithmetic(1).isUndefined).toBe(true);
  });

  it("arithmetic throws on width mismatch", () => {
    const a = BitVector.fromNumber(1, 4);
    const b = BitVector.fromNumber(1, 8);
    expect(() => a.add(b)).toThrow(RangeError);
  });

  it("64-bit add", () => {
    const a = BitVector.fromBigInt(0xFFFFFFFFn, 64);
    const b = BitVector.fromBigInt(1n, 64);
    expect(a.add(b).toBigInt()).toBe(0x100000000n);
  });
});

// ---------------------------------------------------------------------------
// Equality
// ---------------------------------------------------------------------------

describe("equals", () => {
  it("equal values", () => {
    const a = BitVector.fromNumber(5, 8);
    const b = BitVector.fromNumber(5, 8);
    expect(a.equals(b)).toBe(true);
  });

  it("different values", () => {
    const a = BitVector.fromNumber(5, 8);
    const b = BitVector.fromNumber(6, 8);
    expect(a.equals(b)).toBe(false);
  });

  it("different widths", () => {
    const a = BitVector.fromNumber(5, 8);
    const b = BitVector.fromNumber(5, 16);
    expect(a.equals(b)).toBe(false);
  });

  it("HIGH_Z matches only HIGH_Z", () => {
    const a = BitVector.allHighZ(8);
    const b = BitVector.allHighZ(8);
    expect(a.equals(b)).toBe(true);
  });

  it("HIGH_Z != value", () => {
    const a = BitVector.allHighZ(8);
    const b = BitVector.fromNumber(0, 8);
    expect(a.equals(b)).toBe(false);
  });
});

describe("equalsWithDontCare", () => {
  it("UNDEFINED in one operand matches anything in same position", () => {
    const a = BitVector.fromNumber(0b1010, 4);
    const b = BitVector.allHighZ(4); // all don't-care
    expect(a.equalsWithDontCare(b)).toBe(true);
  });

  it("UNDEFINED only in some bits", () => {
    // a = 0b1010, b has highZ on bits 3,1 and value 0 on bits 2,0
    // dontCare covers bits 3,1- compare bits 2,0: a=01, b=00 → false
    const a = BitVector.fromNumber(0b1010, 4);
    const b = BitVector.fromRaw(0b0000, 0b1010, 4);
    // bit 2 of a is 0, bit 2 of b (not Z) is 0 → match
    // bit 0 of a is 0, bit 0 of b (not Z) is 0 → match
    expect(a.equalsWithDontCare(b)).toBe(true);
  });

  it("mismatched non-Z bits return false", () => {
    const a = BitVector.fromNumber(0b1100, 4);
    const b = BitVector.fromRaw(0b0100, 0b1000, 4);
    // bit 3: Z in b → don't care
    // bit 2: a=1, b=1 → match
    // bit 1: a=0, b=0 → match
    // bit 0: a=0, b=0 → match
    expect(a.equalsWithDontCare(b)).toBe(true);
  });

  it("mismatched non-Z bits → false", () => {
    const a = BitVector.fromNumber(0b0001, 4);
    const b = BitVector.fromNumber(0b0010, 4); // no Z bits, differ at bits 0,1
    expect(a.equalsWithDontCare(b)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: BitVector ↔ flat Uint32Array
// ---------------------------------------------------------------------------

describe("bitVectorToRaw / rawToBitVector round-trip", () => {
  it("round-trips a simple 8-bit value", () => {
    const bv = BitVector.fromNumber(0xAB, 8);
    const values = new Uint32Array(4);
    const highZs = new Uint32Array(4);
    bitVectorToRaw(bv, values, highZs, 0);
    const bv2 = rawToBitVector(values, highZs, 0, 8);
    expect(bv2.toNumber()).toBe(0xAB);
    expect(bv2.isHighZ).toBe(false);
  });

  it("round-trips 32-bit max value", () => {
    const bv = BitVector.fromNumber(0xffffffff, 32);
    const values = new Uint32Array(2);
    const highZs = new Uint32Array(2);
    bitVectorToRaw(bv, values, highZs, 0);
    const bv2 = rawToBitVector(values, highZs, 0, 32);
    expect(bv2.toNumber()).toBe(0xffffffff);
  });

  it("round-trips a HIGH_Z value", () => {
    const bv = BitVector.allHighZ(8);
    const values = new Uint32Array(2);
    const highZs = new Uint32Array(2);
    bitVectorToRaw(bv, values, highZs, 0);
    const bv2 = rawToBitVector(values, highZs, 0, 8);
    expect(bv2.isHighZ).toBe(true);
    expect(bv2.highZMask).toBe(0xFFn);
    expect(values[0]).toBe(0); // HIGH_Z bits are zero in value array
  });

  it("round-trips a 64-bit value", () => {
    const val = 0xDEADBEEFCAFEBABEn;
    const bv = BitVector.fromBigInt(val, 64);
    const values = new Uint32Array(4);
    const highZs = new Uint32Array(4);
    bitVectorToRaw(bv, values, highZs, 2); // use non-zero index
    const bv2 = rawToBitVector(values, highZs, 2, 64);
    expect(bv2.toBigInt()).toBe(val);
  });

  it("round-trips 48-bit value (>32, <64)", () => {
    const val = 0xABCDEF012345n;
    const bv = BitVector.fromBigInt(val, 48);
    const values = new Uint32Array(2);
    const highZs = new Uint32Array(2);
    bitVectorToRaw(bv, values, highZs, 0);
    const bv2 = rawToBitVector(values, highZs, 0, 48);
    expect(bv2.toBigInt()).toBe(val);
  });

  it("round-trips 64-bit HIGH_Z", () => {
    const bv = BitVector.allHighZ(64);
    const values = new Uint32Array(2);
    const highZs = new Uint32Array(2);
    bitVectorToRaw(bv, values, highZs, 0);
    const bv2 = rawToBitVector(values, highZs, 0, 64);
    expect(bv2.isHighZ).toBe(true);
    expect(values[0]).toBe(0);
    expect(values[1]).toBe(0);
    expect(highZs[0]).toBe(0xffffffff);
    expect(highZs[1]).toBe(0xffffffff);
  });

  it("value bits are zero where HIGH_Z is set", () => {
    // create with value bits set in HIGH_Z positions- they must be cleared
    const bv = BitVector.fromRaw(0xFF, 0xF0, 8); // value=0x0F after mask
    const values = new Uint32Array(1);
    const highZs = new Uint32Array(1);
    bitVectorToRaw(bv, values, highZs, 0);
    // HIGH_Z bits (high nibble) must be zero in value
    expect(values[0] & highZs[0]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// BitVector.from (static convenience)
// ---------------------------------------------------------------------------

describe("BitVector.from", () => {
  it("creates from raw with no HIGH_Z", () => {
    const bv = BitVector.from(42, 8);
    expect(bv.toNumber()).toBe(42);
    expect(bv.isHighZ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fromRaw direct
// ---------------------------------------------------------------------------

describe("BitVector.fromRaw", () => {
  it("clears value bits where highZ is set", () => {
    // raw value has bits set in Z positions- they must be cleared
    const bv = BitVector.fromRaw(0xFF, 0xF0, 8);
    expect(bv.valueBits).toBe(0x0Fn); // high nibble cleared
    expect(bv.highZMask).toBe(0xF0n);
  });

  it("1-bit HIGH_Z", () => {
    const bv = BitVector.fromRaw(0, 1, 1);
    expect(bv.isHighZ).toBe(true);
    expect(bv.width).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
  it("1-bit BitVector: value 0", () => {
    const bv = BitVector.fromNumber(0, 1);
    expect(bv.toNumber()).toBe(0);
    expect(bv.toString("bin")).toBe("0b0");
  });

  it("1-bit BitVector: value 1", () => {
    const bv = BitVector.fromNumber(1, 1);
    expect(bv.toNumber()).toBe(1);
    expect(bv.toString("bin")).toBe("0b1");
  });

  it("64-bit all-ones", () => {
    const bv = BitVector.fromBigInt(0xFFFFFFFFFFFFFFFFn, 64);
    expect(bv.toBigInt()).toBe(0xFFFFFFFFFFFFFFFFn);
    expect(bv.toString("hex")).toBe("0xFFFFFFFFFFFFFFFF");
  });

  it("64-bit zero", () => {
    const bv = BitVector.fromBigInt(0n, 64);
    expect(bv.toBigInt()).toBe(0n);
    expect(bv.toString("hex")).toBe("0x0000000000000000");
  });

  it("all HIGH_Z toString is 'Z' for 1-bit", () => {
    expect(BitVector.allHighZ(1).toString()).toBe("Z");
  });

  it("not() on 1-bit 0 gives 1", () => {
    expect(BitVector.fromNumber(0, 1).not().toNumber()).toBe(1);
  });

  it("not() on 1-bit 1 gives 0", () => {
    expect(BitVector.fromNumber(1, 1).not().toNumber()).toBe(0);
  });

  it("add 64-bit wraps correctly", () => {
    const max = BitVector.fromBigInt(0xFFFFFFFFFFFFFFFFn, 64);
    const one = BitVector.fromBigInt(1n, 64);
    expect(max.add(one).toBigInt()).toBe(0n);
  });

  it("shiftLeft by 0 is identity", () => {
    const bv = BitVector.fromNumber(0b1010, 4);
    expect(bv.shiftLeft(0).toNumber()).toBe(0b1010);
  });

  it("shiftRight by 0 is identity", () => {
    const bv = BitVector.fromNumber(0b1010, 4);
    expect(bv.shiftRight(0).toNumber()).toBe(0b1010);
  });
});
