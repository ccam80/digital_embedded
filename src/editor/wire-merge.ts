/**
 * Wire merging — re-export shim.
 *
 * The implementation has moved to src/core/wire-utils.ts to eliminate the
 * layering violation where core/circuit.ts imported from the editor layer.
 * This shim preserves backward compatibility for any consumers that still
 * import from @/editor/wire-merge.
 */

export { mergeCollinearSegments } from "@/core/wire-utils";
