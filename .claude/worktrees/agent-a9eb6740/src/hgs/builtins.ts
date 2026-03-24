/**
 * HGS built-in functions — port of the inner classes in Context.java.
 *
 * Registers all ~25 built-in functions into a root HGSContext.
 */

import { HGSContext, registerBuiltin } from "./context";
import {
  HGSFunction,
  HGSArray,
  type HGSValue,
  toBigint,
  toNumber,
  toBool,
  toStringValue,
  toArray,
  hgsToString,
} from "./value";
import { HGSEvalError } from "./parser-error";

// ---------------------------------------------------------------------------
// Registration entry point
// ---------------------------------------------------------------------------

export function registerBuiltins(ctx: HGSContext): void {
  registerBuiltin(ctx, "bitsNeededFor", builtinBitsNeededFor());
  registerBuiltin(ctx, "ceil", builtinCeil());
  registerBuiltin(ctx, "floor", builtinFloor());
  registerBuiltin(ctx, "round", builtinRound());
  registerBuiltin(ctx, "abs", builtinAbs());
  registerBuiltin(ctx, "min", builtinMin());
  registerBuiltin(ctx, "max", builtinMax());
  registerBuiltin(ctx, "random", builtinRandom());
  registerBuiltin(ctx, "int", builtinInt());
  registerBuiltin(ctx, "float", builtinFloat());
  registerBuiltin(ctx, "print", builtinPrint(ctx));
  registerBuiltin(ctx, "println", builtinPrintln(ctx));
  registerBuiltin(ctx, "printf", builtinPrintf(ctx));
  registerBuiltin(ctx, "format", builtinFormat());
  registerBuiltin(ctx, "output", builtinOutput(ctx));
  registerBuiltin(ctx, "log", builtinLog());
  registerBuiltin(ctx, "panic", builtinPanic());
  registerBuiltin(ctx, "isPresent", builtinIsPresent());
  registerBuiltin(ctx, "sizeOf", builtinSizeOf());
  registerBuiltin(ctx, "splitString", builtinSplitString());
  registerBuiltin(ctx, "identifier", builtinIdentifier());
  registerBuiltin(ctx, "startsWith", builtinStartsWith());
  registerBuiltin(ctx, "loadHex", builtinLoadHex(ctx));
  registerBuiltin(ctx, "loadFile", builtinLoadFile(ctx));
}

// ---------------------------------------------------------------------------
// Helper: build a simple HGSFunction from a sync or async callable
// ---------------------------------------------------------------------------

function fn(name: string, callable: (...args: HGSValue[]) => HGSValue | Promise<HGSValue>): HGSFunction {
  return new HGSFunction(async (args) => callable(...args), name);
}

// ---------------------------------------------------------------------------
// Math builtins
// ---------------------------------------------------------------------------

function builtinBitsNeededFor(): HGSFunction {
  return fn("bitsNeededFor", (v) => {
    const n = toBigint(v);
    if (n <= 0n) return 0n;
    let bits = 0n;
    let val = n;
    while (val > 0n) {
      bits++;
      val >>= 1n;
    }
    return bits;
  });
}

function builtinCeil(): HGSFunction {
  return fn("ceil", (v) => {
    if (typeof v === "number") return BigInt(Math.ceil(v));
    return toBigint(v);
  });
}

function builtinFloor(): HGSFunction {
  return fn("floor", (v) => {
    if (typeof v === "number") return BigInt(Math.floor(v));
    return toBigint(v);
  });
}

function builtinRound(): HGSFunction {
  return fn("round", (v) => {
    if (typeof v === "number") return BigInt(Math.round(v));
    return toBigint(v);
  });
}

function builtinAbs(): HGSFunction {
  return fn("abs", (v) => {
    if (typeof v === "number") return Math.abs(v);
    const n = toBigint(v);
    return n < 0n ? -n : n;
  });
}

function builtinMin(): HGSFunction {
  return new HGSFunction(async (args) => {
    if (args.length === 0) throw new HGSEvalError("min() requires at least one argument");
    let hasFloat = false;
    for (const a of args) {
      if (typeof a === "number") { hasFloat = true; break; }
    }
    if (hasFloat) {
      return Math.min(...args.map(toNumber));
    }
    let best = toBigint(args[0]);
    for (let i = 1; i < args.length; i++) {
      const v = toBigint(args[i]);
      if (v < best) best = v;
    }
    return best;
  }, "min");
}

function builtinMax(): HGSFunction {
  return new HGSFunction(async (args) => {
    if (args.length === 0) throw new HGSEvalError("max() requires at least one argument");
    let hasFloat = false;
    for (const a of args) {
      if (typeof a === "number") { hasFloat = true; break; }
    }
    if (hasFloat) {
      return Math.max(...args.map(toNumber));
    }
    let best = toBigint(args[0]);
    for (let i = 1; i < args.length; i++) {
      const v = toBigint(args[i]);
      if (v > best) best = v;
    }
    return best;
  }, "max");
}

function builtinRandom(): HGSFunction {
  return fn("random", (bound) => {
    const n = Number(toBigint(bound));
    return BigInt(Math.floor(Math.random() * n));
  });
}

// ---------------------------------------------------------------------------
// Type conversion builtins
// ---------------------------------------------------------------------------

function builtinInt(): HGSFunction {
  return fn("int", (v) => toBigint(v));
}

function builtinFloat(): HGSFunction {
  return fn("float", (v) => toNumber(v));
}

// ---------------------------------------------------------------------------
// I/O builtins (need ctx for print target)
// ---------------------------------------------------------------------------

function builtinPrint(ctx: HGSContext): HGSFunction {
  return new HGSFunction(async (args) => {
    for (const a of args) ctx.print(hgsToString(a));
    return null;
  }, "print");
}

function builtinPrintln(ctx: HGSContext): HGSFunction {
  return new HGSFunction(async (args) => {
    for (const a of args) ctx.print(hgsToString(a));
    ctx.print("\n");
    return null;
  }, "println");
}

function builtinPrintf(ctx: HGSContext): HGSFunction {
  return new HGSFunction(async (args) => {
    ctx.print(formatString(args));
    return null;
  }, "printf");
}

function builtinFormat(): HGSFunction {
  return new HGSFunction(async (args) => formatString(args), "format");
}

function formatString(args: HGSValue[]): string {
  if (args.length < 1) throw new HGSEvalError("format() requires at least one argument");
  const template = toStringValue(args[0]);
  const rest = args.slice(1);
  let i = 0;
  return template.replace(/%([sdifoxXeEgGb%])/g, (_, spec) => {
    if (spec === "%") return "%";
    const val = rest[i++];
    if (val === undefined) throw new HGSEvalError("not enough arguments for format string");
    switch (spec) {
      case "s": return hgsToString(val);
      case "d": case "i": return String(toBigint(val));
      case "f": return toNumber(val).toFixed(6);
      case "e": return toNumber(val).toExponential();
      case "E": return toNumber(val).toExponential().toUpperCase();
      case "g": case "G": {
        const n = toNumber(val);
        const s = n.toPrecision();
        return spec === "G" ? s.toUpperCase() : s;
      }
      case "o": return (toBigint(val) >= 0n ? toBigint(val) : BigInt.asUintN(64, toBigint(val))).toString(8);
      case "x": return (toBigint(val) >= 0n ? toBigint(val) : BigInt.asUintN(64, toBigint(val))).toString(16);
      case "X": return (toBigint(val) >= 0n ? toBigint(val) : BigInt.asUintN(64, toBigint(val))).toString(16).toUpperCase();
      case "b": return (toBigint(val) >= 0n ? toBigint(val) : BigInt.asUintN(64, toBigint(val))).toString(2);
      default: return hgsToString(val);
    }
  });
}

function builtinOutput(ctx: HGSContext): HGSFunction {
  return new HGSFunction(async (_args) => ctx.getOutput(), "output");
}

function builtinLog(): HGSFunction {
  return new HGSFunction(async (args) => {
    if (args.length !== 1) throw new HGSEvalError("log() requires exactly 1 argument");
    console.log(hgsToString(args[0]));
    return args[0];
  }, "log");
}

// ---------------------------------------------------------------------------
// Control builtins
// ---------------------------------------------------------------------------

function builtinPanic(): HGSFunction {
  return new HGSFunction(async (args) => {
    const msg = args.length > 0 ? hgsToString(args[0]) : "panic";
    throw new HGSEvalError(msg);
  }, "panic");
}

function builtinIsPresent(): HGSFunction {
  return new HGSFunction(async (_args) => true, "isPresent");
}

// ---------------------------------------------------------------------------
// Data builtins
// ---------------------------------------------------------------------------

function builtinSizeOf(): HGSFunction {
  return fn("sizeOf", (v) => {
    const arr = toArray(v);
    return BigInt(arr.size());
  });
}

function builtinSplitString(): HGSFunction {
  return fn("splitString", (v) => {
    const s = hgsToString(v);
    const tokens = s.split(/[\s,:;]+/).filter(t => t.length > 0);
    const arr = new HGSArray();
    for (const t of tokens) arr.add(t);
    return arr;
  });
}

function builtinIdentifier(): HGSFunction {
  return fn("identifier", (v) => {
    const s = hgsToString(v);
    let result = "";
    for (let p = 0; p < s.length; p++) {
      const c = s[p];
      if (c >= "0" && c <= "9") {
        if (result.length === 0) result += "n";
        result += c;
      } else if (
        (c >= "A" && c <= "Z") ||
        (c >= "a" && c <= "z") ||
        c === "_"
      ) {
        result += c;
      }
    }
    return result;
  });
}

function builtinStartsWith(): HGSFunction {
  return fn("startsWith", (a, b) => hgsToString(a).startsWith(hgsToString(b)));
}

// ---------------------------------------------------------------------------
// File I/O builtins (async — delegate to FileResolver)
// ---------------------------------------------------------------------------

function builtinLoadHex(ctx: HGSContext): HGSFunction {
  return new HGSFunction(async (args) => {
    if (args.length < 2) throw new HGSEvalError("loadHex() requires at least 2 arguments");
    const filename = hgsToString(args[0]);
    const dataBits = Number(toBigint(args[1]));
    const bigEndian = args.length > 2 ? toBool(args[2]) : false;
    const resolver = ctx.fileResolver;
    if (!resolver) throw new HGSEvalError("loadHex() not available: no FileResolver configured");
    const data = await resolver.resolve(filename, ctx.getRootPath());
    const { importHex } = await import("../io/hex-import");
    const dataField = importHex(data, dataBits, bigEndian);
    const arr = new HGSArray();
    for (let i = 0; i < dataField.size(); i++) {
      arr.add(dataField.getWord(i));
    }
    return arr;
  }, "loadHex");
}

function builtinLoadFile(ctx: HGSContext): HGSFunction {
  return new HGSFunction(async (args) => {
    if (args.length < 1) throw new HGSEvalError("loadFile() requires 1 argument");
    const filename = hgsToString(args[0]);
    const resolver = ctx.fileResolver;
    if (!resolver) throw new HGSEvalError("loadFile() not available: no FileResolver configured");
    const data = await resolver.resolve(filename, ctx.getRootPath());
    return new TextDecoder().decode(data);
  }, "loadFile");
}
