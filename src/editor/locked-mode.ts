/**
 * Locked mode guard- prevents circuit mutations when a circuit is locked.
 *
 * In locked mode users may still toggle switches, press buttons, and observe
 * outputs, but they cannot add, move, delete, or wire up components.
 *
 * The lock state is per-circuit: store it in CircuitMetadata.isLocked.
 * LockedModeGuard reads/writes that flag and provides helper predicates for
 * the editor to check before each mutating operation.
 */

import type { CircuitElement } from "@/core/element";

/** Component type names that remain interactive even in locked mode. */
const INTERACTIVE_TYPES = new Set(["In", "Button", "Switch", "DipSwitch"]);

// ---------------------------------------------------------------------------
// LockedModeGuard
// ---------------------------------------------------------------------------

/**
 * Stateful guard for locked-mode enforcement.
 *
 * isLocked()              - returns current lock state.
 * setLocked(locked)       - toggle the lock.
 * canEdit()               - true when NOT locked.
 * canInteract(element)    - true for interactive components, always.
 *                            true for any component when NOT locked.
 * guardMutation(operation)- throws if locked.
 */
export class LockedModeGuard {
  private _locked: boolean;

  constructor(initialLocked = false) {
    this._locked = initialLocked;
  }

  isLocked(): boolean {
    return this._locked;
  }

  setLocked(locked: boolean): void {
    this._locked = locked;
  }

  canEdit(): boolean {
    return !this._locked;
  }

  canInteract(element: CircuitElement): boolean {
    if (!this._locked) return true;
    return INTERACTIVE_TYPES.has(element.typeId);
  }

  guardMutation(operation: string): void {
    if (this._locked) {
      throw new Error(
        `Circuit is locked. Unlock to edit. (operation: ${operation})`,
      );
    }
  }
}
