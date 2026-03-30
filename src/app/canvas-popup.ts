/**
 * Property popup lifecycle for canvas interaction.
 *
 * Opens a draggable property editor popup on double-click, and closes it
 * when the user clicks elsewhere or explicitly dismisses it.
 */

import type { AppContext } from './app-context.js';
import type { RenderPipeline } from './render-pipeline.js';
import type { CanvasInteractionDeps } from './canvas-interaction.js';
import { PropertyPanel } from '../editor/property-panel.js';
import { defaultLogicFamily } from '../core/logic-family.js';
import { openSpiceImportDialog } from './spice-import-dialog.js';
import { applySpiceImportResult, applySpiceSubcktImportResult } from './spice-model-apply.js';

// ---------------------------------------------------------------------------
// PopupController
// ---------------------------------------------------------------------------

export interface PopupController {
  closePopup(): void;
  openPopup(elementHit: import('../core/element.js').CircuitElement, screenPt: { x: number; y: number }, container: HTMLElement): void;
}

export function createPopupController(
  ctx: AppContext,
  renderPipeline: RenderPipeline,
  deps: CanvasInteractionDeps,
): PopupController {
  let activePopup: HTMLElement | null = null;
  function closePopup(): void {
    if (activePopup) {
      activePopup.remove();
      activePopup = null;
    }
  }

  function openPopup(
    elementHit: import('../core/element.js').CircuitElement,
    screenPt: { x: number; y: number },
    container: HTMLElement,
  ): void {
    closePopup();

    const def = ctx.registry.get(elementHit.typeId);
    if (!def || def.propertyDefs.length === 0) return;

    const popup = document.createElement('div');
    popup.className = 'prop-popup';

    const header = document.createElement('div');
    header.className = 'prop-popup-header';
    const title = document.createElement('span');
    title.className = 'prop-popup-title';
    title.textContent = elementHit.typeId;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'prop-popup-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', closePopup);
    header.appendChild(title);
    header.appendChild(closeBtn);
    popup.appendChild(header);

    const propsContainer = document.createElement('div');
    popup.appendChild(propsContainer);
    const propertyPopup = new PropertyPanel(propsContainer);
    propertyPopup.showProperties(elementHit, def.propertyDefs);
    if (availableModels(def).length > 1) {
      propertyPopup.showModelSelector(elementHit, def);
    }
    try {
      const activeKey = getActiveModelKey(elementHit, def);
      const domain = modelKeyToDomain(activeKey, def);

      if (domain === 'digital') {
        const family = ctx.circuit.metadata.logicFamily ?? defaultLogicFamily();
        propertyPopup.showPinElectricalOverrides(elementHit, def, family);
      } else {
        const mnaModel = def.models.mnaModels?.[activeKey];
        if (mnaModel?.deviceType) {
          propertyPopup.showSpiceModelParameters(elementHit, def);
        }
      }
    } catch {
      // Component has no models — skip panel display.
    }
    // Live-update: numeric parameter changes are hot-patched into the running
    // engine via coordinator.setComponentProperty() (updates conductances
    // in-place, no recompile). Non-numeric changes (waveform, expression, etc.)
    // are compile-sensitive — recompile and continue automatically.
    propertyPopup.onPropertyChange((key, _oldValue, newValue) => {
      if (ctx.isSimActive()) {
        if (typeof newValue === 'number') {
          ctx.facade.getCoordinator().setComponentProperty(elementHit, key, newValue);
        } else {
          // Compile-sensitive change — recompile and resume simulation
          if (ctx.compileAndBind()) {
            deps.startSimulation();
          }
        }
      }
      renderPipeline.scheduleRender();
    });

    // SPICE import buttons — shown for semiconductor components with deviceType models
    {
      let hasSemiconductorModel = false;
      const hasSubcircuitModel = def.subcircuitRefs !== undefined && Object.keys(def.subcircuitRefs).length > 0;
      if (def.models?.mnaModels) {
        for (const mnaModel of Object.values(def.models.mnaModels)) {
          if (mnaModel.deviceType) hasSemiconductorModel = true;
        }
      }

      if (hasSemiconductorModel) {
        const spiceBtn = document.createElement('button');
        spiceBtn.className = 'spice-import-apply';
        spiceBtn.textContent = 'Import SPICE Model\u2026';
        spiceBtn.disabled = ctx.isSimActive();
        spiceBtn.addEventListener('click', () => {
          closePopup();
          void openSpiceImportDialog(elementHit, container, def).then((result) => {
            if (!result) return;
            applySpiceImportResult(elementHit, result, ctx.circuit);
            ctx.invalidateCompiled();
            ctx.showStatus(`Applied SPICE model "${result.modelName}" to ${elementHit.typeId}`);
          });
        });
        propsContainer.appendChild(spiceBtn);
      }

      if (hasSubcircuitModel) {
        const subcktBtn = document.createElement('button');
        subcktBtn.className = 'spice-import-apply';
        subcktBtn.textContent = 'Import SPICE Subcircuit\u2026';
        subcktBtn.disabled = ctx.isSimActive();
        subcktBtn.addEventListener('click', () => {
          closePopup();
          void openSpiceSubcktDialog(elementHit, container).then((result) => {
            if (!result) return;
            applySpiceSubcktImportResult(elementHit, result, getTransistorModels(), ctx.circuit);
            ctx.invalidateCompiled();
            ctx.showStatus(`Registered subcircuit "${result.subcktName}" and applied to ${elementHit.typeId}`);
          });
        });
        propsContainer.appendChild(subcktBtn);
      }
    }

    popup.style.left = `${Math.min(screenPt.x + 10, container.clientWidth - 200)}px`;
    popup.style.top = `${Math.min(screenPt.y + 10, container.clientHeight - 200)}px`;

    // Drag support via header
    {
      let dragOffsetX = 0;
      let dragOffsetY = 0;
      let containerRect: DOMRect | null = null;
      let popupW = 0;
      let popupH = 0;

      const onDragMove = (ev: PointerEvent): void => {
        ev.stopPropagation();
        ev.preventDefault();
        const cr = containerRect!;
        let newLeft = ev.clientX - cr.left - dragOffsetX;
        let newTop = ev.clientY - cr.top - dragOffsetY;
        newLeft = Math.max(0, Math.min(newLeft, cr.width - popupW));
        newTop = Math.max(0, Math.min(newTop, cr.height - popupH));
        popup.style.left = `${newLeft}px`;
        popup.style.top = `${newTop}px`;
      };

      const onDragEnd = (ev: PointerEvent): void => {
        ev.stopPropagation();
        document.removeEventListener('pointermove', onDragMove, true);
        document.removeEventListener('pointerup', onDragEnd, true);
        containerRect = null;
      };

      header.addEventListener('pointerdown', (ev: PointerEvent) => {
        if ((ev.target as HTMLElement).tagName === 'BUTTON') return;
        containerRect = container.getBoundingClientRect();
        const popupRect = popup.getBoundingClientRect();
        popupW = popupRect.width;
        popupH = popupRect.height;
        dragOffsetX = ev.clientX - popupRect.left;
        dragOffsetY = ev.clientY - popupRect.top;
        document.addEventListener('pointermove', onDragMove, true);
        document.addEventListener('pointerup', onDragEnd, true);
        ev.stopPropagation();
        ev.preventDefault();
      });
    }

    container.appendChild(popup);
    activePopup = popup;
  }

  return { closePopup, openPopup };
}
