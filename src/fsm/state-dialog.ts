/**
 * State property editor dialog.
 *
 * Presents editable fields for an FSMState: name, outputs (key=value pairs),
 * and the initial-state flag. Returns the updated values when the user confirms.
 */

import type { FSMState } from "@/fsm/model";

export interface StateDialogResult {
  name: string;
  outputs: Record<string, number>;
  isInitial: boolean;
}

export interface StateDialogHost {
  showDialog(
    title: string,
    fields: StateDialogField[],
  ): Promise<StateDialogResult | undefined>;
}

export interface StateDialogField {
  label: string;
  type: "text" | "checkbox" | "keyvalue";
  value: string | boolean | Record<string, number>;
}

/**
 * Open the state property editor for the given state.
 * Returns the updated values, or undefined if the user cancelled.
 */
export async function openStateDialog(
  host: StateDialogHost,
  state: FSMState,
): Promise<StateDialogResult | undefined> {
  return host.showDialog(`Edit State: ${state.name}`, [
    { label: "Name", type: "text", value: state.name },
    { label: "Initial State", type: "checkbox", value: state.isInitial },
    { label: "Outputs", type: "keyvalue", value: { ...state.outputs } },
  ]);
}

/**
 * Apply dialog results to a state (mutates in place).
 */
export function applyStateDialogResult(
  state: FSMState,
  result: StateDialogResult,
): void {
  state.name = result.name;
  state.outputs = { ...result.outputs };
  state.isInitial = result.isInitial;
}
