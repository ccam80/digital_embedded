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
import { WELL_KNOWN_PROPERTY_KEYS } from '../core/registry.js';

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
  let activeResizeObserver: ResizeObserver | null = null;
  function closePopup(): void {
    if (activeResizeObserver) {
      activeResizeObserver.disconnect();
      activeResizeObserver = null;
    }
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

    const def = ctx.registry.getStandalone(elementHit.typeId);
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

    // Regular properties (label etc.) first
    propertyPopup.showProperties(elementHit, def.propertyDefs);

    // Model selector: primary params, model dropdown, advanced params
    const family = ctx.circuit.metadata.logicFamily ?? defaultLogicFamily();
    const runtimeModels = ctx.circuit.metadata.models?.[elementHit.typeId];
    if (def.modelRegistry && Object.keys(def.modelRegistry).length > 0) {
      propertyPopup.showModelSelector(elementHit, def, runtimeModels);

      // Pin electrical overrides only when the component is currently using the digital model
      const bag = elementHit.getProperties();
      const activeModel = bag.has("model") ? bag.get<string>("model") : undefined;
      if (activeModel === "digital") {
        propertyPopup.showPinElectricalOverrides(elementHit, def, family);
      }
    }
    // Live-update property changes:
    //   - Render-only keys (label, showLabel, showValue) → just re-render
    //   - Structural properties (inputCount, bitWidth, model, etc.) → recompile
    //   - Numeric non-structural → hot-patch via coordinator.setComponentProperty()
    //   - Non-numeric non-structural → recompile (waveform, expression, etc.)
    propertyPopup.onPropertyChange((key, _oldValue, newValue) => {
      const engineKey = key.startsWith("model:") ? key.slice(6) : key;
      if (WELL_KNOWN_PROPERTY_KEYS.has(engineKey)) {
        // Render-only- no simulation effect, skip hot-load and recompile
      } else {
        const propDef = def.propertyDefs?.find(p => p.key === engineKey);
        if (propDef?.structural) {
          // Structural change- always recompile even if numeric
          if (ctx.compileAndBind()) {
            if (ctx.isSimActive()) deps.startSimulation();
          }
        } else if (typeof newValue === 'number') {
          ctx.facade.getCoordinator().setComponentProperty(elementHit, engineKey, newValue);
        } else {
          if (ctx.compileAndBind()) {
            if (ctx.isSimActive()) deps.startSimulation();
          }
        }
      }
      renderPipeline.scheduleRender();
    });


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

    // Position the popup near the double-click point but fully inside the
    // canvas container. The container is overflow-clipped, so any part of the
    // popup beyond its edges is unreachable; clamping against the popup's
    // measured size (not a fixed height guess) keeps every row on-screen and
    // lets the popup's own overflow-y:auto scrollbar cover tall content. The
    // max-height (calc(100% - 16px)) caps offsetHeight to the container
    // interior, so maxTop never drops below MARGIN.
    const MARGIN = 8;
    const clampIntoContainer = (desiredLeft: number, desiredTop: number): void => {
      const maxLeft = container.clientWidth - popup.offsetWidth - MARGIN;
      const maxTop = container.clientHeight - popup.offsetHeight - MARGIN;
      popup.style.left = `${Math.max(MARGIN, Math.min(desiredLeft, maxLeft))}px`;
      popup.style.top = `${Math.max(MARGIN, Math.min(desiredTop, maxTop))}px`;
    };
    clampIntoContainer(screenPt.x + 10, screenPt.y + 10);

    // Expanding "Advanced Parameters" grows the popup after it is positioned;
    // re-clamp on every size change so the grown popup never spills past the
    // clipped container edge and its bottom rows stay reachable.
    activeResizeObserver = new ResizeObserver(() => {
      clampIntoContainer(popup.offsetLeft, popup.offsetTop);
    });
    activeResizeObserver.observe(popup);
  }

  return { closePopup, openPopup };
}
