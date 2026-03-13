/**
 * Headless SimulatorFacade API
 *
 * Browser-free, Node.js-compatible API for programmatic circuit building and simulation.
 * Used by LLMs, AI agents, the postMessage bridge, and test automation.
 */

// ============================================
// Facade interface and types
// ============================================

export type { SimulatorFacade } from './facade.js';
export {
  FacadeError,
  type TestResults,
  type TestVector,
  type CircuitBuildOptions,
} from './types.js';

// ============================================
// Netlist, diagnostics, and editing types
// ============================================

export type {
  Netlist,
  NetDescriptor,
  NetPin,
  ComponentDescriptor,
  PinDescriptor,
  Diagnostic,
  DiagnosticCode,
  CircuitSpec,
  ComponentSpec,
  CircuitPatch,
  PatchOp,
  PatchSet,
  PatchAdd,
  PatchRemove,
  PatchConnect,
  PatchDisconnect,
  PatchReplace,
  PatchOptions,
} from './netlist-types.js';

// ============================================
// Builder
// ============================================

export { CircuitBuilder } from './builder.js';
export { autoLayout, type LayoutOptions } from './auto-layout.js';

// ============================================
// Core types (re-exported for convenience)
// ============================================

export type { CircuitMetadata } from '../core/circuit.js';
export { Circuit, Wire, Net } from '../core/circuit.js';
export type { CircuitElement } from '../core/element.js';
export type { Pin, PinDirection } from '../core/pin.js';
export type { PropertyBag, PropertyValue, PropertyDefinition, PropertyType } from '../core/properties.js';
export type { SimulationEngine, BitVector, CompiledCircuit } from '../core/engine-interface.js';
export { ComponentRegistry } from '../core/registry.js';
export type { ComponentDefinition } from '../core/registry.js';

// ============================================
// Rendering and element interfaces
// ============================================

export type {
  RenderContext,
  ColorScheme,
  ThemeColor,
  FontSpec,
  TextAnchor,
  PathData,
  Point,
  Rect,
  Transform,
} from '../core/renderer-interface.js';

export {
  defaultColorScheme,
  highContrastColorScheme,
  monochromeColorScheme,
  COLOR_SCHEMES,
  THEME_COLORS,
} from '../core/renderer-interface.js';

// ============================================
// Error types
// ============================================

export {
  SimulationError,
  BurnException,
  BacktrackException,
  BitsException,
  NodeException,
  PinException,
} from '../core/errors.js';
