/**
 * Element Help- builds structured help content from a CircuitElement and its
 * ComponentDefinition.
 *
 * Content is pure data (no DOM). The DOM rendering is handled separately in
 * element-help-ui.ts so this module can be unit-tested in a headless
 * environment.
 */

import type { CircuitElement } from "@/core/element";
import type { StandaloneComponentDefinition } from "@/core/registry";
import type { Pin } from "@/core/pin";
import { PinDirection } from "@/core/pin";
import type { PropertyDefinition } from "@/core/properties";

// ---------------------------------------------------------------------------
// PinInfo- one row in the pin table
// ---------------------------------------------------------------------------

/**
 * Describes one pin for display in the help dialog pin table.
 */
export interface PinInfo {
  /** Pin label as declared in the PinDeclaration. */
  readonly label: string;
  /** Human-readable direction: "Input", "Output", or "Bidirectional". */
  readonly direction: string;
  /** Bit width of the pin (number of parallel bits carried). */
  readonly bitWidth: number;
  /** Whether the pin has an inversion bubble active. */
  readonly isNegated: boolean;
  /** Whether the pin is a clock input. */
  readonly isClock: boolean;
}

// ---------------------------------------------------------------------------
// PropInfo- one row in the property table
// ---------------------------------------------------------------------------

/**
 * Describes one property for display in the help dialog property table.
 */
export interface PropInfo {
  /** Internal property key. */
  readonly key: string;
  /** Human-readable label shown in the property panel. */
  readonly label: string;
  /** Property type as a string (matches PropertyType enum value). */
  readonly type: string;
  /** Default value formatted as a string for display. */
  readonly defaultValue: string;
  /** Optional description of what this property controls. */
  readonly description: string;
}

// ---------------------------------------------------------------------------
// HelpContent- the full structured help record
// ---------------------------------------------------------------------------

/**
 * Complete help content for one component instance.
 *
 * Built by buildHelpContent() and rendered by the help dialog UI.
 */
export interface HelpContent {
  /** Component type name (e.g. "And", "FlipflopD"). */
  readonly title: string;
  /**
   * Short description sourced from the ComponentDefinition's helpText.
   * This is the definition-level description (same for all instances of a type).
   */
  readonly description: string;
  /** One row per resolved pin on the placed component instance. */
  readonly pinTable: PinInfo[];
  /** One row per property definition registered for the component type. */
  readonly propertyTable: PropInfo[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function directionLabel(direction: PinDirection): string {
  switch (direction) {
    case PinDirection.INPUT:
      return "Input";
    case PinDirection.OUTPUT:
      return "Output";
    case PinDirection.BIDIRECTIONAL:
      return "Bidirectional";
  }
}

function pinToPinInfo(pin: Pin): PinInfo {
  return {
    label: pin.label,
    direction: directionLabel(pin.direction),
    bitWidth: pin.bitWidth,
    isNegated: pin.isNegated,
    isClock: pin.isClock,
  };
}

function propDefToPropInfo(def: PropertyDefinition): PropInfo {
  return {
    key: def.key,
    label: def.label,
    type: def.type,
    defaultValue: String(def.defaultValue),
    description: def.description ?? "",
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build structured help content for a placed component instance.
 *
 * @param element     The placed CircuitElement instance. Provides resolved
 *                    pins (world-space positions already applied).
 * @param definition  The ComponentDefinition from the registry. Provides the
 *                    property definitions and definition-level help text.
 * @returns           A HelpContent record ready for display.
 */
export function buildHelpContent(
  element: CircuitElement,
  definition: StandaloneComponentDefinition,
): HelpContent {
  const pins = element.getPins();
  const pinTable: PinInfo[] = pins.map(pinToPinInfo);
  const propertyTable: PropInfo[] = definition.propertyDefs.map(propDefToPropInfo);

  return {
    title: definition.name,
    description: definition.helpText,
    pinTable,
    propertyTable,
  };
}
