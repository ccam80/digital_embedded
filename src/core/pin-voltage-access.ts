/**
 * PinVoltageAccess- signal context passed to component draw() methods.
 *
 * Allows analog components to query per-pin node voltages during rendering
 * so they can color leads and bodies based on live simulation state.
 * Digital components ignore the optional parameter- no breaking change.
 */

/**
 * Read-only voltage access for a component's pins during draw().
 *
 * Components query by pin label (e.g. "A", "B") and receive the MNA node
 * voltage, or undefined if no engine is connected or the pin has no net.
 */
export interface PinVoltageAccess {
  /**
   * Return the MNA node voltage at the given pin, or undefined.
   *
   * @param pinLabel - The pin label as declared in the component's pin layout.
   */
  getPinVoltage(pinLabel: string): number | undefined;

  /**
   * Map a voltage to a CSS color string using the active voltage range
   * and color scheme. Returns a color on the NEG→GND→POS gradient.
   */
  voltageColor(voltage: number): string;
}
