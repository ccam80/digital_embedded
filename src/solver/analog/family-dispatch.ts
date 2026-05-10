/**
 * Per-type device family dispatcher.
 *
 * Mirrors ngspice's per-type DEVload orchestration from
 * `ref/ngspice/src/spicelib/analysis/cktload.c:61-75`:
 *   `for i in DEVmaxnum: DEVices[i]->DEVload(ckt)`
 *
 * Instead of a flat element walk, the dispatcher iterates family buckets in
 * ascending `min(ngspiceLoadOrder)` order -- one bucket per DeviceFamily
 * present in the compiled circuit. For each bucket, it either calls the
 * registered family handler (which may implement multi-pass structure, e.g.
 * IND_FAMILY's 3-pass INDload) or falls back to the caller-supplied default
 * handler (which performs the trivial per-instance walk equivalent to the
 * old flat loop body).
 *
 * The sorted family order is cached per `buckets` map instance via a WeakMap.
 * Since `elementsByFamily` is built once per compiled circuit and passed by
 * reference, the expensive sort runs exactly once per compilation -- not on
 * every NR iteration.
 */

import type { DeviceFamily } from "./ngspice-load-order.js";
import type { FamilyCallback, FamilyHandler } from "./family-registry.js";
import { FAMILY_REGISTRY } from "./family-registry.js";
import type { AnalogElement } from "./element.js";

// ---------------------------------------------------------------------------
// Sort-key cache -- avoids re-sorting the family list on every NR call.
// Keyed on the buckets ReadonlyMap instance, which is stable per compiled
// circuit (elementsByFamily is built once in compiler.ts).
// ---------------------------------------------------------------------------

/** Sorted [family, instances] pairs, stable for the lifetime of the buckets ref. */
type SortedEntries = ReadonlyArray<[DeviceFamily, readonly AnalogElement[]]>;

const _sortCache = new WeakMap<
  ReadonlyMap<DeviceFamily, readonly AnalogElement[]>,
  SortedEntries
>();

/**
 * Compute `min(ngspiceLoadOrder)` across all instances in a bucket.
 * Returns Infinity for empty buckets so they sort last (and are then skipped).
 */
function minLoadOrder(instances: readonly AnalogElement[]): number {
  let min = Infinity;
  for (const el of instances) {
    if (el.ngspiceLoadOrder < min) {
      min = el.ngspiceLoadOrder;
    }
  }
  return min;
}

/**
 * Return (and cache) the sorted family entries for a given buckets map.
 * Sort key: `min(ngspiceLoadOrder)` of each bucket's instances, ascending.
 * This matches ngspice's `for i in DEVmaxnum: DEVices[i]->DEVload(ckt)` order.
 */
function getSortedEntries(
  buckets: ReadonlyMap<DeviceFamily, readonly AnalogElement[]>,
): SortedEntries {
  const cached = _sortCache.get(buckets);
  if (cached !== undefined) {
    return cached;
  }
  const sorted = [...buckets.entries()].sort(
    (a, b) => minLoadOrder(a[1]) - minLoadOrder(b[1]),
  );
  _sortCache.set(buckets, sorted);
  return sorted;
}

// ---------------------------------------------------------------------------
// runByDeviceFamily -- the single primitive consumed by cktLoad, cktTemp,
// the AC analysis stamp loop, and the dev probe.
// ---------------------------------------------------------------------------

/**
 * Iterate device families in ascending `min(ngspiceLoadOrder)` order and
 * dispatch each non-empty bucket to its registered handler or to the
 * caller-supplied default handler.
 *
 * @param buckets        - Compile-time family->instances map (stable ref per circuit).
 * @param callback       - Which handler slot to look up: "load" | "stampAc" | "computeTemperature".
 * @param ctx            - Opaque context forwarded verbatim to the handler's run().
 *                         Callers pass LoadContext, AcLoadContext, or TempContext.
 * @param defaultHandler - Fallback when no registered handler covers (family, callback).
 */
export function runByDeviceFamily(
  buckets: ReadonlyMap<DeviceFamily, readonly AnalogElement[]>,
  callback: FamilyCallback,
  ctx: unknown,
  defaultHandler: FamilyHandler,
): void {
  const ordered = getSortedEntries(buckets);
  for (const [family, instances] of ordered) {
    if (instances.length === 0) continue;
    const handler = FAMILY_REGISTRY.get(family)?.[callback] ?? defaultHandler;
    handler.run(ctx, instances);
  }
}
