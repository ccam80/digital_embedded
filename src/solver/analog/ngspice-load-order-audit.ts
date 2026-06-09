import type { ComponentRegistry } from "../../core/registry.js";
import { DECK_EMITTING_FAMILIES } from "./ngspice-load-order.js";

/**
 * Validate the netlist-device metadata declared on each registered model entry's
 * `spice` block. The single source of truth for a device's ngspice family and
 * node-token order is the model entry; this audit enforces its internal
 * consistency at registration.
 *
 * Rules:
 *  - `spice.device`, when present, must name a deck-emitting family.
 *  - An INLINE model (one SPICE deck line) whose `spice.device` is set MUST
 *    declare `spice.deckNodeTokens` — the node-token order of that one line. The
 *    K-card family MUT mints no nodes, so its tokens are the empty array `[]`
 *    (still "declared").
 *  - A NETLIST model (a composite — no single deck line) MAY declare
 *    `spice.device` for its wrapper's family bucket, but MUST NOT declare
 *    `spice.deckNodeTokens`: a composite's outer pins are numbered by the
 *    sub-element expansion's first-encounter order, never a forced token list.
 */
export function auditNgspiceLoadOrderTables(registry: ComponentRegistry): void {
  const errors: string[] = [];

  for (const def of registry.getAll()) {
    if (!def.modelRegistry) continue;
    for (const [modelKey, entry] of Object.entries(def.modelRegistry)) {
      const device = entry.spice?.device;
      if (device === undefined) continue;
      const tokens = entry.spice?.deckNodeTokens;

      if (!DECK_EMITTING_FAMILIES.has(device)) {
        errors.push(
          `${def.name} model "${modelKey}" declares spice.device "${device}", which is not a deck-emitting family`,
        );
        continue;
      }

      if (entry.kind === "netlist") {
        if (tokens !== undefined) {
          errors.push(
            `${def.name} model "${modelKey}" is a composite (kind:"netlist") but declares ` +
              `spice.deckNodeTokens; a composite's outer pins are numbered by its sub-element ` +
              `expansion, not a single deck line`,
          );
        }
      } else if (tokens === undefined) {
        errors.push(
          `${def.name} model "${modelKey}" (device "${device}") is an inline device model but ` +
            `declares no spice.deckNodeTokens`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `ngspice netlist-device audit failed:\n  - ${errors.join("\n  - ")}\n` +
        `Fix the affected model entries' spice blocks.`,
    );
  }
}
