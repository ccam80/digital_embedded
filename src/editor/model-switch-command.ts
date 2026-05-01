/**
 * ModelSwitchCommand- undo/redo record for a model selection change.
 *
 * Captures the old and new model keys plus the full model param snapshots
 * so that undo restores both the selection and all param values atomically.
 */

import type { CircuitElement } from "@/core/element";
import type { PropertyValue } from "@/core/properties";

// ---------------------------------------------------------------------------
// EditCommand interface (local- avoids circular imports)
// ---------------------------------------------------------------------------

export interface EditCommand {
  execute(): void;
  undo(): void;
}

// ---------------------------------------------------------------------------
// ModelSwitchCommand
// ---------------------------------------------------------------------------

export interface ModelSwitchCommand extends EditCommand {
  readonly elementId: string;
  readonly oldModelKey: string;
  readonly oldParamSnapshot: Record<string, PropertyValue>;
  readonly newModelKey: string;
  readonly newParamSnapshot: Record<string, PropertyValue>;
}

/**
 * Create a ModelSwitchCommand for the given element.
 *
 * Captures the current model key and param snapshot as "old", and
 * accepts the desired new model key and param snapshot as "new".
 */
export function createModelSwitchCommand(
  element: CircuitElement,
  newModelKey: string,
  newParamSnapshot: Record<string, PropertyValue>,
): ModelSwitchCommand {
  const bag = element.getProperties();
  const oldModelKey = bag.has("model") ? bag.get<string>("model") : "";
  const oldParamSnapshot: Record<string, PropertyValue> = {};
  for (const key of bag.getModelParamKeys()) {
    oldParamSnapshot[key] = bag.getModelParam(key);
  }

  return {
    elementId: element.instanceId,
    oldModelKey,
    oldParamSnapshot,
    newModelKey,
    newParamSnapshot,

    execute(): void {
      const b = element.getProperties();
      b.set("model", newModelKey);
      b.replaceModelParams(newParamSnapshot);
    },

    undo(): void {
      const b = element.getProperties();
      b.set("model", oldModelKey);
      b.replaceModelParams(oldParamSnapshot);
    },
  };
}
