/**
 * ColorSchemeManager- runtime color scheme switching and IEEE/IEC gate shape toggle.
 *
 * Built-in schemes (default, high-contrast, monochrome) are defined in
 * src/core/renderer-interface.ts. This manager wraps them with:
 *
 *   - Named scheme selection at runtime (triggers re-render via onChange listeners).
 *   - IEEE vs IEC/DIN gate shape style toggle (global setting, gates read it in draw()).
 *   - Custom scheme creation from a full ThemeColor → CSS color map.
 *   - onChange listeners for triggering re-renders on any setting change.
 */

import type { ThemeColor, ColorScheme } from "@/core/renderer-interface";
import { COLOR_SCHEMES, THEME_COLORS } from "@/core/renderer-interface";

// ---------------------------------------------------------------------------
// Gate shape style
// ---------------------------------------------------------------------------

export type GateShapeStyle = "ieee" | "iec";

// ---------------------------------------------------------------------------
// ChangeListener
// ---------------------------------------------------------------------------

export type ColorSchemeChangeListener = () => void;

// ---------------------------------------------------------------------------
// ColorSchemeManager
// ---------------------------------------------------------------------------

/**
 * Manages the active color scheme and gate shape style for the editor.
 *
 * All registered onChange callbacks are notified whenever the active scheme
 * or gate shape style changes.
 *
 * Custom schemes can be created with createCustomScheme() and then activated
 * by name via setActive().
 */
export class ColorSchemeManager {
  private _activeScheme: ColorScheme;
  private _activeName: string;
  private _gateShapeStyle: GateShapeStyle;
  private readonly _schemes: Map<string, ColorScheme>;
  private readonly _listeners: ColorSchemeChangeListener[] = [];

  constructor(initialScheme = "default", initialGateShape: GateShapeStyle = "ieee") {
    this._schemes = new Map(Object.entries(COLOR_SCHEMES));

    const scheme = this._schemes.get(initialScheme);
    if (scheme === undefined) {
      throw new Error(
        `ColorSchemeManager: unknown initial scheme "${initialScheme}". ` +
        `Available: ${Array.from(this._schemes.keys()).join(", ")}`,
      );
    }

    this._activeScheme = scheme;
    this._activeName = initialScheme;
    this._gateShapeStyle = initialGateShape;
  }

  // ---------------------------------------------------------------------------
  // Active scheme
  // ---------------------------------------------------------------------------

  /**
   * Returns the currently active ColorScheme.
   */
  getActive(): ColorScheme {
    return this._activeScheme;
  }

  /**
   * Returns the name of the currently active scheme.
   */
  getActiveName(): string {
    return this._activeName;
  }

  /**
   * Switch to the named scheme and notify all onChange listeners.
   *
   * @throws Error when the name is not registered (built-in or custom).
   */
  setActive(name: string): void {
    const scheme = this._schemes.get(name);
    if (scheme === undefined) {
      throw new Error(
        `ColorSchemeManager: unknown scheme "${name}". ` +
        `Available: ${Array.from(this._schemes.keys()).join(", ")}`,
      );
    }
    this._activeScheme = scheme;
    this._activeName = name;
    this._notifyListeners();
  }

  // ---------------------------------------------------------------------------
  // Gate shape style
  // ---------------------------------------------------------------------------

  /**
   * Returns the current gate shape style: "ieee" (ANSI) or "iec" (DIN/IEC).
   */
  getGateShapeStyle(): GateShapeStyle {
    return this._gateShapeStyle;
  }

  /**
   * Switch the gate shape style and notify all onChange listeners.
   *
   * Gates read this setting in their draw() method to choose the correct shape.
   */
  setGateShapeStyle(style: GateShapeStyle): void {
    this._gateShapeStyle = style;
    this._notifyListeners();
  }

  // ---------------------------------------------------------------------------
  // Custom scheme creation
  // ---------------------------------------------------------------------------

  /**
   * Create and register a custom color scheme.
   *
   * The scheme is registered under `name` so it can be activated with
   * setActive(name). The colors map must cover every ThemeColor- missing
   * entries will throw at resolve time.
   *
   * @param name    Unique name for the custom scheme. Overwrites an existing
   *                scheme with the same name if already registered.
   * @param colors  Full mapping from ThemeColor to CSS color string.
   * @returns       The new ColorScheme instance.
   */
  createCustomScheme(name: string, colors: Record<ThemeColor, string>): ColorScheme {
    const frozen: Record<ThemeColor, string> = { ...colors };
    const scheme: ColorScheme = {
      resolve(color: ThemeColor): string {
        return frozen[color];
      },
    };
    this._schemes.set(name, scheme);
    return scheme;
  }

  // ---------------------------------------------------------------------------
  // Change listeners
  // ---------------------------------------------------------------------------

  /**
   * Register a callback to be called whenever the active scheme or gate shape
   * style changes.
   *
   * @param callback  Called synchronously when setActive() or setGateShapeStyle()
   *                  succeeds.
   * @returns         A function that removes the listener when called.
   */
  onChange(callback: ColorSchemeChangeListener): () => void {
    this._listeners.push(callback);
    return () => {
      const index = this._listeners.indexOf(callback);
      if (index !== -1) {
        this._listeners.splice(index, 1);
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Available schemes
  // ---------------------------------------------------------------------------

  /**
   * Returns the names of all registered schemes (built-in + custom).
   */
  getSchemeNames(): string[] {
    return Array.from(this._schemes.keys());
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _notifyListeners(): void {
    for (const listener of this._listeners) {
      listener();
    }
  }
}

// ---------------------------------------------------------------------------
// Utility: build a full color map from a partial override
// ---------------------------------------------------------------------------

/**
 * Build a complete ThemeColor → CSS color map by merging overrides onto a base
 * scheme. Useful for creating custom schemes that only change a few colors.
 *
 * @param base      The base ColorScheme to inherit unoverridden colors from.
 * @param overrides Partial map of ThemeColor → CSS color string.
 */
export function buildColorMap(
  base: ColorScheme,
  overrides: Partial<Record<ThemeColor, string>>,
): Record<ThemeColor, string> {
  const map = {} as Record<ThemeColor, string>;
  for (const color of THEME_COLORS) {
    map[color] = overrides[color] ?? base.resolve(color);
  }
  return map;
}
