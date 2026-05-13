/**
 * ucrt libm shim — replaces every implementation-defined Math transcendental
 * with the ucrt implementations (ucrtbase.dll) during a ComparisonSession's
 * lifetime so digiTS sees the same libm ngspice.dll statically embeds.
 *
 * IEEE 754 only mandates correctly-rounded results for +, -, *, /, sqrt,
 * fma, and remainder. Everything else (exp, log, pow, trig, hyperbolic, …)
 * is implementation-defined and V8 vs ucrt diverge by 1 ULP at scattered
 * input bit patterns. Each 1-ULP divergence shows up as a slot delta at
 * the harness CSC dump and burns hours in "where does this come from"
 * investigations. The cheapest answer is to make digiTS call exactly the
 * same libm functions ngspice does.
 *
 * Shimmed (every transcendental ucrtbase.dll exports that we touch):
 *   single-arg: exp, log, log2, log10, log1p, expm1,
 *               sin, cos, tan, asin, acos, atan,
 *               sinh, cosh, tanh, asinh, acosh, atanh,
 *               cbrt
 *   two-arg:    pow, atan2, hypot
 *
 * NOT shimmed: sqrt (IEEE-mandated bit-exact already), abs/sign/min/max
 * (pure bit ops), floor/ceil/round/trunc (exact-integer ops).
 *
 * Refcounted: multiple sessions may install concurrently; originals are
 * restored only when the last session disposes. Idempotent. Windows-only —
 * silently no-ops elsewhere or if ucrtbase.dll cannot be loaded.
 */

import koffi from "koffi";

type UnaryFn = (x: number) => number;
type BinaryFn = (x: number, y: number) => number;

const UNARY_NAMES = [
  "exp", "log", "log2", "log10", "log1p", "expm1",
  "sin", "cos", "tan", "asin", "acos", "atan",
  "sinh", "cosh", "tanh", "asinh", "acosh", "atanh",
  "cbrt",
] as const;
const BINARY_NAMES = ["pow", "atan2", "hypot"] as const;

type UnaryName = (typeof UNARY_NAMES)[number];
type BinaryName = (typeof BINARY_NAMES)[number];

interface UcrtFunctions {
  unary: Record<UnaryName, UnaryFn>;
  binary: Record<BinaryName, BinaryFn>;
}

let _ucrt: UcrtFunctions | null | undefined = undefined;
let _refCount = 0;
let _originalUnary: Partial<Record<UnaryName, UnaryFn>> = {};
let _originalBinary: Partial<Record<BinaryName, BinaryFn>> = {};

function _loadUcrt(): UcrtFunctions | null {
  if (_ucrt !== undefined) return _ucrt;
  if (process.platform !== "win32") {
    _ucrt = null;
    return null;
  }
  try {
    const lib = koffi.load("ucrtbase.dll");
    const unary = {} as Record<UnaryName, UnaryFn>;
    for (const name of UNARY_NAMES) {
      unary[name] = lib.func(`double ${name}(double)`) as UnaryFn;
    }
    const binary = {} as Record<BinaryName, BinaryFn>;
    for (const name of BINARY_NAMES) {
      binary[name] = lib.func(`double ${name}(double, double)`) as BinaryFn;
    }
    _ucrt = { unary, binary };
  } catch {
    _ucrt = null;
  }
  return _ucrt;
}

/**
 * Install the ucrt-libm shim. Safe to call multiple times — refcounted with
 * matching `uninstallUcrtLibmShim()` calls. Returns true if the shim is
 * active after this call, false if the platform / load failed and the shim
 * is a no-op.
 */
export function installUcrtLibmShim(): boolean {
  const ucrt = _loadUcrt();
  if (!ucrt) return false;
  _refCount++;
  if (_refCount === 1) {
    for (const name of UNARY_NAMES) {
      _originalUnary[name] = Math[name] as UnaryFn;
      (Math as unknown as Record<UnaryName, UnaryFn>)[name] = ucrt.unary[name];
    }
    for (const name of BINARY_NAMES) {
      _originalBinary[name] = Math[name] as BinaryFn;
      (Math as unknown as Record<BinaryName, BinaryFn>)[name] = ucrt.binary[name];
    }
  }
  return true;
}

/**
 * Remove one shim refcount. When refcount drops to zero, the original
 * Math.* functions are restored. Safe to over-call (clamps at zero).
 */
export function uninstallUcrtLibmShim(): void {
  if (_refCount === 0) return;
  _refCount--;
  if (_refCount === 0) {
    for (const name of UNARY_NAMES) {
      const orig = _originalUnary[name];
      if (orig) (Math as unknown as Record<UnaryName, UnaryFn>)[name] = orig;
    }
    for (const name of BINARY_NAMES) {
      const orig = _originalBinary[name];
      if (orig) (Math as unknown as Record<BinaryName, BinaryFn>)[name] = orig;
    }
    _originalUnary = {};
    _originalBinary = {};
  }
}

/** Test helper: is the shim currently installed at the Math level? */
export function isUcrtLibmShimActive(): boolean {
  return _refCount > 0;
}
