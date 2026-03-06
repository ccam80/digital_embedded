/**
 * Application initialization sequence.
 *
 * Wires together the component registry, file resolver, editor subsystems,
 * and canvas rendering pipeline. Called once on page load from main.ts.
 *
 * Browser-only: imports DOM-dependent modules.
 */

import { parseUrlParams, type SimulatorParams } from './url-params.js';
import { createDefaultResolver, type FileResolver } from '../io/file-resolver.js';
import { createDefaultRegistry } from '../components/register-all.js';
import type { ComponentRegistry } from '../core/registry.js';
import { Circuit } from '../core/circuit.js';
import { ComponentPalette } from '../editor/palette.js';
import { PaletteUI } from '../editor/palette-ui.js';
import { PropertyPanel } from '../editor/property-panel.js';
import { Viewport } from '../editor/viewport.js';
import { SelectionModel } from '../editor/selection.js';
import { PlacementMode } from '../editor/placement.js';
import { WireDrawingMode } from '../editor/wire-drawing.js';
import { CanvasRenderer } from '../editor/canvas-renderer.js';
import { ElementRenderer } from '../editor/element-renderer.js';
import { WireRenderer } from '../editor/wire-renderer.js';
import { GridRenderer } from '../editor/grid.js';
import { UndoRedoStack } from '../editor/undo-redo.js';
import { SpeedControl } from '../integration/speed-control.js';
import { darkColorScheme, lightColorScheme } from '../core/renderer-interface.js';
import type { ColorScheme } from '../core/renderer-interface.js';

// ---------------------------------------------------------------------------
// AppContext — runtime state shared between modules
// ---------------------------------------------------------------------------

export interface AppContext {
  params: SimulatorParams;
  resolver: FileResolver;
  isIframe: boolean;
  registry: ComponentRegistry;
  circuit: Circuit;
  palette: ComponentPalette;
  paletteUI: PaletteUI;
  propertyPanel: PropertyPanel;
  viewport: Viewport;
  selection: SelectionModel;
  placement: PlacementMode;
  wireDrawing: WireDrawingMode;
  canvasRenderer: CanvasRenderer;
  elementRenderer: ElementRenderer;
  wireRenderer: WireRenderer;
  gridRenderer: GridRenderer;
  undoStack: UndoRedoStack;
  speedControl: SpeedControl;
  colorScheme: ColorScheme;
  canvas: HTMLCanvasElement;
  ctx2d: CanvasRenderingContext2D;
}

// ---------------------------------------------------------------------------
// initApp
// ---------------------------------------------------------------------------

/**
 * Initialize the simulator application.
 *
 * Creates the full editor subsystem graph and wires it to DOM elements.
 */
export function initApp(search?: string): AppContext {
  const params = parseUrlParams(search);
  const resolver = createDefaultResolver(params.base);
  const isIframe = typeof window !== 'undefined'
    ? window.self !== window.top
    : false;

  applyColorScheme(params.dark);

  // Registry with all built-in components
  const registry = createDefaultRegistry();

  // Empty circuit to start
  const circuit = new Circuit();

  // Color scheme for canvas rendering
  const colorScheme = params.dark ? darkColorScheme : lightColorScheme;

  // Canvas setup
  const canvas = document.getElementById('sim-canvas') as HTMLCanvasElement;
  const ctx2d = canvas.getContext('2d')!;
  const canvasRenderer = new CanvasRenderer(ctx2d, colorScheme);

  // Editor subsystems
  const viewport = new Viewport();
  const selection = new SelectionModel();
  const placement = new PlacementMode();
  const wireDrawing = new WireDrawingMode();
  const elementRenderer = new ElementRenderer();
  const wireRenderer = new WireRenderer();
  const gridRenderer = new GridRenderer();
  const undoStack = new UndoRedoStack();
  const speedControl = new SpeedControl();

  // Palette
  const palette = new ComponentPalette(registry);
  const paletteContainer = document.getElementById('palette-content')!;
  const paletteUI = new PaletteUI(palette, paletteContainer);

  // Wire palette click → placement mode
  paletteUI.onPlace((def) => {
    placement.start(def);
  });

  paletteUI.render();

  // Property panel
  const propertyContainer = document.getElementById('property-content')!;
  const propertyPanel = new PropertyPanel(propertyContainer);

  // Wire selection → property panel
  selection.onChange(() => {
    const selected = selection.getSelectedElements();
    if (selected.size === 1) {
      const element = selected.values().next().value!;
      const def = registry.get(element.typeId);
      if (def) {
        propertyPanel.showProperties(element, def.propertyDefs);
      }
    } else {
      propertyPanel.clear();
    }
  });

  return {
    params,
    resolver,
    isIframe,
    registry,
    circuit,
    palette,
    paletteUI,
    propertyPanel,
    viewport,
    selection,
    placement,
    wireDrawing,
    canvasRenderer,
    elementRenderer,
    wireRenderer,
    gridRenderer,
    undoStack,
    speedControl,
    colorScheme,
    canvas,
    ctx2d,
  };
}

// ---------------------------------------------------------------------------
// applyColorScheme
// ---------------------------------------------------------------------------

function applyColorScheme(dark: boolean): void {
  if (typeof document === 'undefined') return;
  if (dark) {
    document.documentElement.classList.add('dark');
    document.documentElement.classList.remove('light');
  } else {
    document.documentElement.classList.add('light');
    document.documentElement.classList.remove('dark');
  }
}
