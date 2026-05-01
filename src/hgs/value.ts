/**
 * HGS value type system- port of Digital's hdl/hgs/Value.java.
 *
 * All integer arithmetic uses bigint for full Java Long (64-bit) parity.
 * Floating-point uses number. Strings, booleans, arrays, maps, and functions
 * are first-class values.
 */

import { HGSEvalError } from "./parser-error";

// ---------------------------------------------------------------------------
// Value type union
// ---------------------------------------------------------------------------

export type HGSValue =
  | bigint
  | number
  | string
  | boolean
  | HGSArray
  | HGSMap
  | HGSFunction
  | null;

// ---------------------------------------------------------------------------
// HGSArray
// ---------------------------------------------------------------------------

export class HGSArray {
  private readonly items: HGSValue[];

  constructor(items: HGSValue[] = []) {
    this.items = items;
  }

  get(i: number): HGSValue {
    if (i < 0 || i >= this.items.length) {
      throw new HGSEvalError(`array index out of bounds: ${i} (size ${this.items.length})`);
    }
    return this.items[i];
  }

  set(i: number, v: HGSValue): void {
    if (i < 0 || i >= this.items.length) {
      throw new HGSEvalError(`array index out of bounds: ${i} (size ${this.items.length})`);
    }
    this.items[i] = v;
  }

  add(v: HGSValue): void {
    this.items.push(v);
  }

  size(): number {
    return this.items.length;
  }

  toArray(): HGSValue[] {
    return this.items;
  }
}

// ---------------------------------------------------------------------------
// HGSMap
// ---------------------------------------------------------------------------

export class HGSMap {
  private readonly fields: Map<string, HGSValue>;

  constructor(fields: Map<string, HGSValue> = new Map()) {
    this.fields = fields;
  }

  get(key: string): HGSValue {
    if (!this.fields.has(key)) {
      throw new HGSEvalError(`field not found: ${key}`);
    }
    return this.fields.get(key)!;
  }

  set(key: string, v: HGSValue): void {
    this.fields.set(key, v);
  }

  has(key: string): boolean {
    return this.fields.has(key);
  }

  keys(): string[] {
    return Array.from(this.fields.keys());
  }
}

// ---------------------------------------------------------------------------
// HGSFunction
// ---------------------------------------------------------------------------

export type HGSCallable = (args: HGSValue[]) => Promise<HGSValue>;

export class HGSFunction {
  readonly callable: HGSCallable;
  readonly name: string;

  constructor(callable: HGSCallable, name: string = "<anonymous>") {
    this.callable = callable;
    this.name = name;
  }
}

// ---------------------------------------------------------------------------
// ReturnValue sentinel- thrown by return statements, caught by call handler
// ---------------------------------------------------------------------------

export class ReturnValue {
  constructor(readonly value: HGSValue) {}
}

// ---------------------------------------------------------------------------
// Type coercion helpers
// ---------------------------------------------------------------------------

export function toBigint(v: HGSValue): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  if (typeof v === "boolean") return v ? 1n : 0n;
  throw new HGSEvalError(`expected integer, got ${typeOf(v)}: ${String(v)}`);
}

export function toNumber(v: HGSValue): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  throw new HGSEvalError(`expected number, got ${typeOf(v)}: ${String(v)}`);
}

export function toBool(v: HGSValue): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "bigint") return v !== 0n;
  if (typeof v === "number") return v !== 0;
  throw new HGSEvalError(`expected boolean or integer, got ${typeOf(v)}: ${String(v)}`);
}

export function toStringValue(v: HGSValue): string {
  if (typeof v === "string") return v;
  throw new HGSEvalError(`expected string, got ${typeOf(v)}`);
}

export function toArray(v: HGSValue): HGSArray {
  if (v instanceof HGSArray) return v;
  throw new HGSEvalError(`expected array, got ${typeOf(v)}`);
}

export function toMap(v: HGSValue): HGSMap {
  if (v instanceof HGSMap) return v;
  throw new HGSEvalError(`expected map/struct, got ${typeOf(v)}`);
}

export function toFunction(v: HGSValue): HGSFunction {
  if (v instanceof HGSFunction) return v;
  throw new HGSEvalError(`expected function, got ${typeOf(v)}`);
}

function typeOf(v: HGSValue): string {
  if (v === null) return "null";
  if (v instanceof HGSArray) return "array";
  if (v instanceof HGSMap) return "map";
  if (v instanceof HGSFunction) return "function";
  return typeof v;
}

// ---------------------------------------------------------------------------
// Arithmetic and comparison operations- mirrors Value.java semantics
// ---------------------------------------------------------------------------

export function hgsAdd(a: HGSValue, b: HGSValue): HGSValue {
  if (typeof a === "string" || typeof b === "string") {
    return hgsToString(a) + hgsToString(b);
  }
  if (typeof a === "number" || typeof b === "number") {
    return toNumber(a) + toNumber(b);
  }
  if (typeof a === "bigint" && typeof b === "bigint") {
    return a + b;
  }
  throw new HGSEvalError(`+ requires int, float, or string operands`);
}

export function hgsSub(a: HGSValue, b: HGSValue): HGSValue {
  if (typeof a === "number" || typeof b === "number") {
    return toNumber(a) - toNumber(b);
  }
  return toBigint(a) - toBigint(b);
}

export function hgsMul(a: HGSValue, b: HGSValue): HGSValue {
  if (typeof a === "number" || typeof b === "number") {
    return toNumber(a) * toNumber(b);
  }
  return toBigint(a) * toBigint(b);
}

export function hgsDiv(a: HGSValue, b: HGSValue): HGSValue {
  if (typeof a === "number" || typeof b === "number") {
    return toNumber(a) / toNumber(b);
  }
  const bv = toBigint(b);
  if (bv === 0n) throw new HGSEvalError("division by zero");
  return toBigint(a) / bv;
}

export function hgsMod(a: HGSValue, b: HGSValue): HGSValue {
  const bv = toBigint(b);
  if (bv === 0n) throw new HGSEvalError("modulo by zero");
  return toBigint(a) % bv;
}

export function hgsAnd(a: HGSValue, b: HGSValue): HGSValue {
  if (typeof a === "bigint" && typeof b === "bigint") return a & b;
  if (
    (typeof a === "bigint" || typeof a === "number" || typeof a === "boolean") &&
    (typeof b === "bigint" || typeof b === "number" || typeof b === "boolean")
  ) {
    return toBool(a) && toBool(b);
  }
  throw new HGSEvalError(`& requires integer or boolean operands`);
}

export function hgsOr(a: HGSValue, b: HGSValue): HGSValue {
  if (typeof a === "bigint" && typeof b === "bigint") return a | b;
  if (
    (typeof a === "bigint" || typeof a === "number" || typeof a === "boolean") &&
    (typeof b === "bigint" || typeof b === "number" || typeof b === "boolean")
  ) {
    return toBool(a) || toBool(b);
  }
  throw new HGSEvalError(`| requires integer or boolean operands`);
}

export function hgsXor(a: HGSValue, b: HGSValue): HGSValue {
  if (typeof a === "bigint" && typeof b === "bigint") return a ^ b;
  if (
    (typeof a === "bigint" || typeof a === "number" || typeof a === "boolean") &&
    (typeof b === "bigint" || typeof b === "number" || typeof b === "boolean")
  ) {
    return toBool(a) !== toBool(b);
  }
  throw new HGSEvalError(`^ requires integer or boolean operands`);
}

export function hgsShiftLeft(a: HGSValue, b: HGSValue): HGSValue {
  return toBigint(a) << toBigint(b);
}

export function hgsShiftRight(a: HGSValue, b: HGSValue): HGSValue {
  // Java's >>> is unsigned right shift on long- in bigint terms this is
  // arithmetic shift right (bigint has no unsigned representation).
  // We truncate to 64-bit to match Java Long semantics.
  const av = BigInt.asUintN(64, toBigint(a));
  const shift = toBigint(b);
  return BigInt.asIntN(64, av >> shift);
}

export function hgsEqual(a: HGSValue, b: HGSValue): boolean {
  if (typeof a === "number" || typeof b === "number") {
    return toNumber(a) === toNumber(b);
  }
  if (typeof a === "bigint" && typeof b === "bigint") return a === b;
  if (typeof a === "string" || typeof b === "string") {
    return hgsToString(a) === hgsToString(b);
  }
  return a === b;
}

export function hgsLess(a: HGSValue, b: HGSValue): boolean {
  if (typeof a === "number" || typeof b === "number") {
    return toNumber(a) < toNumber(b);
  }
  if (typeof a === "bigint" && typeof b === "bigint") return a < b;
  if (typeof a === "string" && typeof b === "string") return a < b;
  throw new HGSEvalError(`< requires int, float, or string operands`);
}

export function hgsLessEqual(a: HGSValue, b: HGSValue): boolean {
  if (typeof a === "number" || typeof b === "number") {
    return toNumber(a) <= toNumber(b);
  }
  if (typeof a === "bigint" && typeof b === "bigint") return a <= b;
  if (typeof a === "string" && typeof b === "string") return a <= b;
  throw new HGSEvalError(`<= requires int, float, or string operands`);
}

export function hgsNeg(v: HGSValue): HGSValue {
  if (typeof v === "number") return -v;
  return -toBigint(v);
}

export function hgsBitwiseNot(v: HGSValue): HGSValue {
  return ~toBigint(v);
}

export function hgsLogicalNot(v: HGSValue): HGSValue {
  return !toBool(v);
}

/** Convert any HGS value to its string representation for output/concatenation. */
export function hgsToString(v: HGSValue): string {
  if (v === null) return "null";
  if (v instanceof HGSArray) return `[${v.toArray().map(hgsToString).join(", ")}]`;
  if (v instanceof HGSMap) return `{${v.keys().map(k => `${k}: ${hgsToString(v.get(k))}`).join(", ")}}`;
  if (v instanceof HGSFunction) return `<function ${v.name}>`;
  return String(v);
}
