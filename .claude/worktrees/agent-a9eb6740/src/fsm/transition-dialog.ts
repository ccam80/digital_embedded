/**
 * Transition property editor dialog.
 *
 * Presents editable fields for an FSMTransition: condition expression
 * and optional Mealy output actions. Returns updated values on confirm.
 */

import type { FSMTransition } from "@/fsm/model";

export interface TransitionDialogResult {
  condition: string;
  actions: Record<string, number>;
}

export interface TransitionDialogHost {
  showDialog(
    title: string,
    fields: TransitionDialogField[],
  ): Promise<TransitionDialogResult | undefined>;
}

export interface TransitionDialogField {
  label: string;
  type: "text" | "keyvalue";
  value: string | Record<string, number>;
}

/**
 * Open the transition property editor for the given transition.
 * Returns the updated values, or undefined if the user cancelled.
 */
export async function openTransitionDialog(
  host: TransitionDialogHost,
  transition: FSMTransition,
): Promise<TransitionDialogResult | undefined> {
  return host.showDialog(`Edit Transition`, [
    { label: "Condition", type: "text", value: transition.condition },
    { label: "Actions", type: "keyvalue", value: { ...(transition.actions ?? {}) } },
  ]);
}

/**
 * Apply dialog results to a transition (mutates in place).
 */
export function applyTransitionDialogResult(
  transition: FSMTransition,
  result: TransitionDialogResult,
): void {
  transition.condition = result.condition;
  transition.actions =
    Object.keys(result.actions).length > 0 ? { ...result.actions } : undefined;
}
