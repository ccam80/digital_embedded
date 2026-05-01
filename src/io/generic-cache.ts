/**
 * GenericCache- caches resolved generic circuits by parameter hash.
 *
 * Prevents redundant resolution when the same generic circuit is instantiated
 * multiple times with the same parameter values.
 *
 * The cache key is derived from the circuit's name (or an opaque identifier)
 * combined with a deterministic serialization of the parameter args.
 */

import type { Circuit } from "../core/circuit.js";
import type { HGSValue } from "../hgs/value.js";
import { HGSMap } from "../hgs/value.js";

// ---------------------------------------------------------------------------
// CacheKey computation
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic string key from a generic name and a Map of HGS
 * argument values.
 *
 * Keys are sorted for insertion-order independence. Values are serialized
 * recursively so that HGSMap arguments (nested parameter structs) also
 * produce stable keys.
 */
export function computeGenericCacheKey(
  genericName: string,
  args: Map<string, HGSValue>,
): string {
  return `${genericName}:${serializeArgs(args)}`;
}

function serializeArgs(args: Map<string, HGSValue>): string {
  const entries = Array.from(args.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return JSON.stringify(entries.map(([k, v]) => [k, serializeHGSValue(v)]));
}

function serializeHGSValue(v: HGSValue): string {
  if (v === null) return "null";
  if (typeof v === "bigint") return `bigint:${v}`;
  if (typeof v === "boolean") return `bool:${v}`;
  if (typeof v === "number") return `num:${v}`;
  if (typeof v === "string") return `str:${v}`;
  if (v instanceof HGSMap) {
    const pairs = v
      .keys()
      .sort()
      .map((k) => `${k}:${serializeHGSValue(v.get(k))}`);
    return `{${pairs.join(",")}}`;
  }
  return String(v);
}

// ---------------------------------------------------------------------------
// GenericCache
// ---------------------------------------------------------------------------

/**
 * Cache for resolved generic circuits keyed by (genericName, args).
 *
 * Usage:
 *   const cache = new GenericCache();
 *   const key = computeGenericCacheKey(name, args);
 *   const hit = cache.get(key);
 *   if (hit !== undefined) return hit;
 *   const resolved = await resolveGenericCircuit(...);
 *   cache.set(key, resolved);
 *   return resolved;
 */
export class GenericCache {
  private readonly _store: Map<string, Circuit> = new Map();

  /**
   * Retrieve a cached resolved circuit by key.
   * Returns undefined on a cache miss.
   */
  get(key: string): Circuit | undefined {
    return this._store.get(key);
  }

  /**
   * Store a resolved circuit under a key.
   */
  set(key: string, circuit: Circuit): void {
    this._store.set(key, circuit);
  }

  /**
   * Return true when the key is already cached.
   */
  has(key: string): boolean {
    return this._store.has(key);
  }

  /**
   * Remove all cached entries. Used when the subcircuit cache is cleared
   * (e.g. on checkpoint jump via digital-set-base).
   */
  clear(): void {
    this._store.clear();
  }

  /** Number of cached entries. */
  get size(): number {
    return this._store.size;
  }
}
