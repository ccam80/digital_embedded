/**
 * Double-click handler for the canvas interaction layer.
 *
 * Opens the property popup, memory editor, or navigates into a subcircuit
 * depending on the element hit.
 */

import type { AppContext } from './app-context.js';
import type { RenderPipeline } from './render-pipeline.js';
import type { PopupController } from './canvas-popup.js';
import type { SubcircuitNavigator } from './canvas-subcircuit.js';
import type { MemoryEditorController } from './canvas-memory-editor.js';
import { hitTestElements } from '../editor/hit-test.js';

/** Component type names that are togglable during simulation- skip property popup on dblclick. */
const TOGGLABLE_TYPES = new Set(['In', 'Clock', 'Button', 'Switch', 'SwitchDT', 'DipSwitch']);

/** Memory component type IDs that support the hex editor. */
const MEMORY_TYPES = new Set(['RAM', 'ROM', 'EEPROM', 'RegisterFile']);

export function registerDblClickHandler(
  ctx: AppContext,
  renderPipeline: RenderPipeline,
  popup: PopupController,
  navigator: SubcircuitNavigator,
  memoryEditor: MemoryEditorController,
): void {
  const canvas = ctx.canvas;

  canvas.addEventListener('dblclick', (e: MouseEvent) => {
    const worldPt = renderPipeline.canvasToWorld(e);
    const elementHit = hitTestElements(worldPt, ctx.circuit.elements);
    if (!elementHit) return;

    // During simulation, don't open properties for togglable components
    if (ctx.isSimActive() && TOGGLABLE_TYPES.has(elementHit.typeId)) return;

    // Memory components: open hex editor (only during simulation)
    if (ctx.isSimActive() && MEMORY_TYPES.has(elementHit.typeId)) {
      void memoryEditor.openMemoryEditor(elementHit);
      return;
    }

    // Subcircuit elements: navigate into them on double-click
    if ('definition' in elementHit && (elementHit as any).definition?.circuit) {
      const subDef = (elementHit as any).definition;
      navigator.openSubcircuit(subDef.name, subDef.circuit);
      return;
    }

    const screenPt = renderPipeline.canvasToScreen(e);
    const container = canvas.parentElement!;
    popup.openPopup(elementHit, screenPt, container);
  });
}
