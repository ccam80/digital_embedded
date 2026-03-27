/**
 * CanvasInteraction — pointer event handling, drag state machine, touch gestures,
 * subcircuit navigation, popup management, and memory editor.
 *
 * Extracted from app-init.ts (Step 9 of modularization plan).
 * Owns: pointerdown/pointermove/pointerup/pointercancel/wheel/dblclick handlers,
 * drag state machine (DragMode), box-select coordination via renderPipeline.state,
 * touch gesture delegation, long-press context menu, subcircuit navigation stack,
 * property popup lifecycle, memory editor overlay, tryCompleteWire() (fixes D6).
 */

import type { AppContext } from './app-context.js';
import type { RenderPipeline } from './render-pipeline.js';
import type { SimulationController } from './simulation-controller.js';
import { Circuit } from '../core/circuit.js';
import type { Wire } from '../core/circuit.js';
import type { Point } from '../core/renderer-interface.js';
import { snapToGrid } from '../editor/coordinates.js';
import { hitTestElements, hitTestWires, hitTestPins } from '../editor/hit-test.js';
import { TouchGestureTracker } from '../editor/touch-gestures.js';
import { splitWiresAtPoint, isWireEndpoint } from '../editor/wire-drawing.js';
import { PropertyPanel } from '../editor/property-panel.js';
import { pasteFromClipboard, placeComponent } from '../editor/edit-operations.js';
import { pinWorldPosition } from '../core/pin.js';
import { createModal } from './dialog-manager.js';
import { BitVector } from '../core/signal.js';
import { EngineState } from '../core/engine-interface.js';
import { availableModels, hasDigitalModel } from '../core/registry.js';
import { defaultLogicFamily } from '../core/logic-family.js';
import type { CircuitElement } from '../core/element.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CanvasInteractionDeps {
  startSimulation(): void;
  stopSimulation(): void;
  compileAndBind(): boolean;
}

export interface CanvasInteraction {
  closePopup(): void;
  navigateBack(): void;
  openSubcircuit(name: string, subCircuit: Circuit): void;
  openMemoryEditor(element: import('../core/element.js').CircuitElement): Promise<void>;
  readonly circuitStack: Array<{ name: string; circuit: Circuit; zoom: number; pan: { x: number; y: number } }>;
}

// ---------------------------------------------------------------------------
// Module-level helpers (extracted from top of app-init.ts)
// ---------------------------------------------------------------------------

/** Component type names that are togglable during simulation — skip property popup on dblclick. */
const TOGGLABLE_TYPES = new Set(["In", "Clock", "Button", "Switch", "SwitchDT", "DipSwitch"]);

/** Memory component type IDs that support the hex editor. */
const MEMORY_TYPES = new Set(['RAM', 'ROM', 'EEPROM', 'RegisterFile']);

/**
 * After completing a wire to a pin or junction, check if the newly added
 * segments contain a dead-end stub that overshot the target. A dead-end stub
 * is a zero-length wire or a segment whose endpoint is not connected to any
 * pin or any other wire endpoint in the circuit.
 */
function removeDeadEndStubs(newWires: Wire[], circuit: Circuit): void {
  // Collect all wire endpoint positions (excluding the new wires themselves)
  const endpointCounts = new Map<string, number>();
  const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;

  for (const w of circuit.wires) {
    const sk = key(w.start);
    const ek = key(w.end);
    endpointCounts.set(sk, (endpointCounts.get(sk) ?? 0) + 1);
    endpointCounts.set(ek, (endpointCounts.get(ek) ?? 0) + 1);
  }

  // Remove zero-length wires
  for (const w of newWires) {
    if (w.start.x === w.end.x && w.start.y === w.end.y) {
      circuit.removeWire(w);
    }
  }

  // Check new wires for dead-end stubs: segments with an endpoint that has
  // exactly 1 connection (only this wire) and doesn't touch any component pin.
  for (const w of newWires) {
    if (w.start.x === w.end.x && w.start.y === w.end.y) continue; // already removed

    for (const pt of [w.start, w.end]) {
      const k = key(pt);
      const count = endpointCounts.get(k) ?? 0;
      if (count <= 1) {
        // Check if this endpoint touches a pin
        let touchesPin = false;
        for (const el of circuit.elements) {
          for (const pin of el.getPins()) {
            const wp = pinWorldPosition(el, pin);
            if (wp.x === pt.x && wp.y === pt.y) {
              touchesPin = true;
              break;
            }
          }
          if (touchesPin) break;
        }
        if (!touchesPin && newWires.length > 1) {
          circuit.removeWire(w);
          break;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// initCanvasInteraction
// ---------------------------------------------------------------------------

export function initCanvasInteraction(
  ctx: AppContext,
  renderPipeline: RenderPipeline,
  simController: SimulationController,
  deps: CanvasInteractionDeps,
): CanvasInteraction {
  const canvas = ctx.canvas;

  // -------------------------------------------------------------------------
  // Hit-test constants
  // -------------------------------------------------------------------------

  const HIT_THRESHOLD = 0.5;
  const TOUCH_HIT_THRESHOLD = 1.5;
  const TOUCH_HIT_MARGIN = 0.5;

  // -------------------------------------------------------------------------
  // Drag state machine
  // -------------------------------------------------------------------------

  type DragMode = 'none' | 'pan' | 'select-drag' | 'wire-drag' | 'box-select';

  let dragMode: DragMode = 'none';
  let dragStart: Point = { x: 0, y: 0 };
  let dragStartScreen: Point = { x: 0, y: 0 };

  // -------------------------------------------------------------------------
  // Pointer tracking
  // -------------------------------------------------------------------------

  let activePointerId: number | null = null;
  const pointerTypeRef = { value: 'mouse' };

  // Long-press context menu state (touch only)
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressStartX = 0;
  let longPressStartY = 0;
  let longPressClientX = 0;
  let longPressClientY = 0;
  const LONG_PRESS_MS = 500;
  const LONG_PRESS_MOVE_THRESHOLD = 10;

  function cancelLongPress(): void {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  const touchGestures = new TouchGestureTracker();

  canvas.style.touchAction = 'none';

  // -------------------------------------------------------------------------
  // Popup state
  // -------------------------------------------------------------------------

  let activePopup: HTMLElement | null = null;
  let activePopupPanel: PropertyPanel | null = null;

  function closePopup(): void {
    if (activePopup) {
      if (activePopupPanel?.commitAll()) {
        if (ctx.facade.getCoordinator().timingModel !== 'discrete' && ctx.isSimActive()) {
          ctx.compiledDirty = true;
          if (deps.compileAndBind()) {
            deps.startSimulation();
          }
        } else {
          ctx.invalidateCompiled();
        }
        renderPipeline.scheduleRender();
      }
      activePopupPanel = null;
      activePopup.remove();
      activePopup = null;
    }
  }

  // -------------------------------------------------------------------------
  // Subcircuit navigation
  // -------------------------------------------------------------------------

  let currentCircuitName = 'Main';
  const circuitStack: Array<{ name: string; circuit: Circuit; zoom: number; pan: { x: number; y: number } }> = [];

  function updateBreadcrumb(): void {
    let breadcrumb = document.getElementById('circuit-breadcrumb');
    if (!breadcrumb) {
      breadcrumb = document.createElement('div');
      breadcrumb.id = 'circuit-breadcrumb';
      breadcrumb.style.cssText = 'position:absolute;top:4px;left:50%;transform:translateX(-50%);z-index:100;display:flex;gap:4px;align-items:center;font-family:sans-serif;font-size:13px;color:#ccc;background:rgba(0,0,0,0.55);padding:2px 10px;border-radius:4px;pointer-events:auto;';
      canvas.parentElement!.appendChild(breadcrumb);
    }
    breadcrumb.innerHTML = '';

    const allEntries = [...circuitStack.map(s => s.name), currentCircuitName];
    for (let i = 0; i < allEntries.length; i++) {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.textContent = ' > ';
        sep.style.color = '#666';
        breadcrumb.appendChild(sep);
      }
      const crumb = document.createElement('span');
      crumb.textContent = allEntries[i];
      if (i < allEntries.length - 1) {
        crumb.style.cssText = 'cursor:pointer;color:#88f;text-decoration:underline;';
        const levelsBack = allEntries.length - 1 - i;
        crumb.addEventListener('click', () => {
          for (let j = 0; j < levelsBack; j++) navigateBack();
        });
      } else {
        crumb.style.fontWeight = 'bold';
      }
      breadcrumb.appendChild(crumb);
    }

    breadcrumb.style.display = circuitStack.length === 0 ? 'none' : 'flex';
  }

  function openSubcircuit(name: string, subCircuit: Circuit): void {
    circuitStack.push({
      name: currentCircuitName,
      circuit: ctx.circuit,
      zoom: ctx.viewport.zoom,
      pan: { x: ctx.viewport.pan.x, y: ctx.viewport.pan.y },
    });
    ctx.setCircuit(subCircuit);
    currentCircuitName = name;
    ctx.fitViewport();
    ctx.selection.clear();
    closePopup();
    updateBreadcrumb();
    renderPipeline.scheduleRender();
  }

  function navigateBack(): void {
    if (circuitStack.length === 0) return;
    const prev = circuitStack.pop()!;
    ctx.setCircuit(prev.circuit);
    currentCircuitName = prev.name;
    ctx.viewport.zoom = prev.zoom;
    ctx.viewport.pan = prev.pan;
    ctx.selection.clear();
    closePopup();
    updateBreadcrumb();
    renderPipeline.scheduleRender();
  }

  // -------------------------------------------------------------------------
  // Memory editor
  // -------------------------------------------------------------------------

  let activeMemoryOverlay: HTMLElement | null = null;

  function closeMemoryEditor(): void {
    activeMemoryOverlay?.remove();
    activeMemoryOverlay = null;
  }

  async function openMemoryEditor(element: CircuitElement): Promise<void> {
    closeMemoryEditor();

    const elementIdx = ctx.circuit.elements.indexOf(element);
    const { getBackingStore } = await import('../components/memory/ram.js');
    const dataField = getBackingStore(elementIdx);
    if (!dataField) {
      ctx.showStatus('Memory contents not available — run simulation first', false);
      return;
    }

    const props = element.getProperties();
    const label = String(props.has('label') ? props.get('label') : '');
    const typeId = element.typeId;
    const size = dataField.size;
    const width = Number(props.has('bitWidth') ? props.get('bitWidth') : props.has('dataBits') ? props.get('dataBits') : 8);
    const title = label
      ? `${label}: ${typeId} (${size} words × ${width} bits)`
      : `${typeId} (${size} words × ${width} bits)`;

    const { overlay, dialog, body } = createModal({
      title,
      className: 'memory-dialog',
      overlayClassName: 'memory-dialog-overlay',
      onClose: () => { activeMemoryOverlay = null; },
    });

    const { MemoryEditorDialog } = await import('../runtime/memory-editor.js');
    const editor = new MemoryEditorDialog(dataField, body);
    editor.render();

    const memEng = ctx.facade.getCoordinator();
    if (memEng?.getState() === EngineState.RUNNING) {
      editor.enableLiveUpdate(memEng);
    }

    const footer = document.createElement('div');
    footer.className = 'memory-dialog-footer';

    const addrLabel = document.createElement('span');
    addrLabel.textContent = 'Go to:';
    addrLabel.style.fontSize = '12px';
    addrLabel.style.opacity = '0.7';

    const addrInput = document.createElement('input');
    addrInput.type = 'text';
    addrInput.placeholder = '0x0000';
    addrInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        const addr = parseInt(addrInput.value, 16);
        if (!isNaN(addr)) editor.goToAddress(addr);
      }
    });

    const goBtn = document.createElement('button');
    goBtn.textContent = 'Go';
    goBtn.addEventListener('click', () => {
      const addr = parseInt(addrInput.value, 16);
      if (!isNaN(addr)) editor.goToAddress(addr);
    });

    const spacer = document.createElement('div');
    spacer.className = 'spacer';

    const closeBtnFooter = document.createElement('button');
    closeBtnFooter.textContent = 'Close';
    closeBtnFooter.addEventListener('click', closeMemoryEditor);

    footer.appendChild(addrLabel);
    footer.appendChild(addrInput);
    footer.appendChild(goBtn);
    footer.appendChild(spacer);
    footer.appendChild(closeBtnFooter);

    dialog.appendChild(footer);

    document.body.appendChild(overlay);
    activeMemoryOverlay = overlay;
  }

  // -------------------------------------------------------------------------
  // Wire completion helper (fixes D6)
  // -------------------------------------------------------------------------

  function tryCompleteWire(fn: () => Wire[]): void {
    try {
      const wires = fn();
      removeDeadEndStubs(wires, ctx.circuit);
      ctx.invalidateCompiled();
    } catch (err) {
      ctx.showStatus(err instanceof Error ? err.message : 'Wire connection failed', true);
      ctx.wireDrawing.cancel();
    }
  }

  // -------------------------------------------------------------------------
  // finishPointerDrag
  // -------------------------------------------------------------------------

  function finishPointerDrag(): void {
    if (dragMode === 'wire-drag') {
      ctx.wireDrag.finish(ctx.circuit);
      ctx.invalidateCompiled();
      renderPipeline.scheduleRender();
    }

    if (dragMode === 'box-select') {
      const topLeft = renderPipeline.canvasToWorld({
        clientX: Math.min(renderPipeline.state.boxSelect.startScreen.x, renderPipeline.state.boxSelect.currentScreen.x) + canvas.getBoundingClientRect().left,
        clientY: Math.min(renderPipeline.state.boxSelect.startScreen.y, renderPipeline.state.boxSelect.currentScreen.y) + canvas.getBoundingClientRect().top,
      });
      const bottomRight = renderPipeline.canvasToWorld({
        clientX: Math.max(renderPipeline.state.boxSelect.startScreen.x, renderPipeline.state.boxSelect.currentScreen.x) + canvas.getBoundingClientRect().left,
        clientY: Math.max(renderPipeline.state.boxSelect.startScreen.y, renderPipeline.state.boxSelect.currentScreen.y) + canvas.getBoundingClientRect().top,
      });

      const boxedElements = ctx.circuit.elements.filter((el) => {
        const bb = el.getBoundingBox();
        return bb.x >= topLeft.x && bb.y >= topLeft.y &&
          bb.x + bb.width <= bottomRight.x && bb.y + bb.height <= bottomRight.y;
      });
      const boxedWires = ctx.circuit.wires.filter((w) => {
        return w.start.x >= topLeft.x && w.start.y >= topLeft.y &&
          w.end.x <= bottomRight.x && w.end.y <= bottomRight.y;
      });

      if (boxedElements.length > 0 || boxedWires.length > 0) {
        ctx.selection.boxSelect(boxedElements, boxedWires);
      }

      renderPipeline.state.boxSelect.active = false;
      renderPipeline.scheduleRender();
    }

    dragMode = 'none';
  }

  // -------------------------------------------------------------------------
  // pointerdown
  // -------------------------------------------------------------------------

  canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    pointerTypeRef.value = e.pointerType;

    // Touch pointers are handled by the gesture tracker (supports multi-touch).
    if (e.pointerType === 'touch') {
      const worldPt = renderPipeline.canvasToWorld(e);
      const pinHit = hitTestPins(worldPt, ctx.circuit.elements, TOUCH_HIT_THRESHOLD);
      const elementHit = !pinHit ? hitTestElements(worldPt, ctx.circuit.elements, TOUCH_HIT_MARGIN) : undefined;
      const hitEmpty = !pinHit && !elementHit;
      touchGestures.onPointerDown(e, hitEmpty);

      // Long-press: start 500ms timer; if pointer doesn't move >10px, show context menu
      cancelLongPress();
      longPressStartX = e.clientX;
      longPressStartY = e.clientY;
      longPressClientX = e.clientX;
      longPressClientY = e.clientY;
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        // Fire context menu at long-press position (reuse contextmenu handler logic)
        const synth = new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true,
          clientX: longPressClientX, clientY: longPressClientY,
        });
        canvas.dispatchEvent(synth);
      }, LONG_PRESS_MS);

      // If gesture tracker is in WAIT state (could still be a tap), fall through
      // to normal logic only for first touch on a hit target.
      if (touchGestures.isActive) return;
      if (!hitEmpty) {
        // Let normal logic handle taps on elements/pins below
      } else {
        // Empty canvas tap — gesture tracker will pan once threshold exceeded
        return;
      }
    }

    // Mouse/pen: reject secondary pointers
    if (e.pointerType !== 'touch') {
      if (activePointerId !== null && e.pointerId !== activePointerId) return;
      activePointerId = e.pointerId;
    }

    const worldPt = renderPipeline.canvasToWorld(e);
    const screenPt = renderPipeline.canvasToScreen(e);
    const isTouch = e.pointerType === 'touch';
    const hitThreshold = isTouch ? TOUCH_HIT_THRESHOLD : HIT_THRESHOLD;
    const hitMargin = isTouch ? TOUCH_HIT_MARGIN : 0;

    if (e.button === 1) {
      dragMode = 'pan';
      dragStartScreen = screenPt;
      e.preventDefault();
      return;
    }

    if (e.button !== 0 && e.pointerType !== 'touch') return;

    // Placement takes priority even during simulation — stop sim and place.
    if (ctx.placement.isActive() && ctx.placement.isPasteMode()) {
      ctx.invalidateCompiled();
      ctx.placement.updateCursor(worldPt);
      const transformed = ctx.placement.getTransformedClipboard();
      const cmd = pasteFromClipboard(ctx.circuit, transformed, worldPt);
      ctx.undoStack.push(cmd);
      ctx.placement.cancel();
      return;
    }

    if (ctx.placement.isActive()) {
      // If the click lands on the just-placed component (its body or a pin),
      // exit placement mode and select/start-wire instead of placing another copy.
      const lastPlaced = ctx.placement.getLastPlaced();
      if (lastPlaced) {
        const pinHit = hitTestPins(worldPt, [lastPlaced], hitThreshold);
        const elemHit = !pinHit && hitTestElements(worldPt, [lastPlaced]);
        if (pinHit || elemHit) {
          ctx.placement.cancel();
          ctx.invalidateCompiled();
          renderPipeline.scheduleRender();
          if (pinHit) {
            ctx.wireDrawing.startFromPin(pinHit.element, pinHit.pin);
          } else {
            ctx.selection.clear();
            ctx.selection.select(lastPlaced);
          }
          renderPipeline.scheduleRender();
          return;
        }
      }
      ctx.invalidateCompiled();
      ctx.placement.updateCursor(worldPt);
      const placed = ctx.placement.place(ctx.circuit);
      ctx.undoStack.push(placeComponent(ctx.circuit, placed));
      return;
    }

    // During simulation, only allow toggling interactive components (In, Clock, etc.)
    if (ctx.isSimActive()) {
      if (ctx.facade.getCoordinator().timingModel !== 'discrete') {
        // During analog/mixed simulation, allow element selection (for slider panel)
        const elementHit = hitTestElements(worldPt, ctx.circuit.elements, hitMargin);
        if (elementHit) {
          ctx.selection.clear();
          ctx.selection.select(elementHit);

          // Interactive toggle during analog simulation — recompile to update state
          if (elementHit.typeId === 'Switch' || elementHit.typeId === 'SwitchDT') {
            const momentary = (elementHit.getAttribute('momentary') as boolean | undefined) ?? false;
            if (momentary) {
              elementHit.setAttribute('closed', true);
              const onPointerUp = (): void => {
                elementHit.setAttribute('closed', false);
                ctx.compiledDirty = true;
                if (deps.compileAndBind()) {
                  deps.startSimulation();
                }
                renderPipeline.scheduleRender();
              };
              document.addEventListener('pointerup', onPointerUp, { once: true });
            } else {
              const current = (elementHit.getAttribute('closed') as boolean | undefined) ?? false;
              elementHit.setAttribute('closed', !current);
            }
            ctx.compiledDirty = true;
            if (deps.compileAndBind()) {
              deps.startSimulation();
            }
          } else if (elementHit.typeId === 'In' || elementHit.typeId === 'Clock' || elementHit.typeId === 'Port') {
            // In/Clock/Port toggle during analog/mixed sim — change defaultValue and recompile
            const bitWidth = (elementHit.getAttribute('bitWidth') as number | undefined) ?? 1;
            const current = (elementHit.getAttribute('defaultValue') as number | undefined) ?? 0;
            const newVal = bitWidth === 1
              ? (current === 0 ? 1 : 0)
              : ((current + 1) & ((1 << bitWidth) - 1));
            elementHit.setAttribute('defaultValue', newVal);
            ctx.compiledDirty = true;
            if (deps.compileAndBind()) {
              deps.startSimulation();
            }
          }
        } else {
          ctx.selection.clear();
        }
        renderPipeline.scheduleRender();
        return;
      }

      const elementHit = hitTestElements(worldPt, ctx.circuit.elements, hitMargin);
      if (elementHit && (elementHit.typeId === 'In' || elementHit.typeId === 'Clock' || elementHit.typeId === 'Port')) {
        const bitWidth = (elementHit.getAttribute('bitWidth') as number | undefined) ?? 1;
        const current = ctx.binding.getPinValue(elementHit, 'out');
        const newVal = bitWidth === 1
          ? (current === 0 ? 1 : 0)
          : ((current + 1) & ((1 << bitWidth) - 1));
        ctx.binding.setInput(elementHit, 'out', BitVector.fromNumber(newVal, bitWidth));
        const eng = ctx.facade.getCoordinator();
        if (eng.getState() !== EngineState.RUNNING) {
          ctx.facade.step(eng, { clockAdvance: elementHit.typeId !== 'Clock' && elementHit.typeId !== 'Port' });
        }
        renderPipeline.scheduleRender();
      }

      // Switch toggle: Switch (SPST) and SwitchDT (SPDT) clicked during simulation
      if (elementHit && (elementHit.typeId === 'Switch' || elementHit.typeId === 'SwitchDT')) {
        const momentary = (elementHit.getAttribute('momentary') as boolean | undefined) ?? false;
        if (momentary) {
          // Momentary: set closed=true on pointerdown, release on pointerup
          elementHit.setAttribute('closed', true);
          const onPointerUp = (): void => {
            elementHit.setAttribute('closed', false);
            const eng = ctx.facade.getCoordinator();
            if (eng.getState() !== EngineState.RUNNING) {
              ctx.facade.step(eng, { clockAdvance: true });
            }
            renderPipeline.scheduleRender();
          };
          document.addEventListener('pointerup', onPointerUp, { once: true });
        } else {
          // Latching: toggle closed property
          const current = (elementHit.getAttribute('closed') as boolean | undefined) ?? false;
          elementHit.setAttribute('closed', !current);
        }
        const eng = ctx.facade.getCoordinator();
        if (eng.getState() !== EngineState.RUNNING) {
          ctx.facade.step(eng, { clockAdvance: true });
        }
        renderPipeline.scheduleRender();
      }
      return;
    }

    if (ctx.wireDrawing.isActive()) {
      const pinHit = hitTestPins(worldPt, ctx.circuit.elements, hitThreshold);
      if (pinHit) {
        tryCompleteWire(() => ctx.wireDrawing.completeToPin(pinHit.element, pinHit.pin, ctx.circuit, ctx.analogTypeIds));
      } else {
        // Check if cursor lands on an existing wire — split interior or connect at endpoint
        const snappedPt = snapToGrid(worldPt, 1);
        const tappedPoint = splitWiresAtPoint(snappedPt, ctx.circuit);
        if (tappedPoint !== undefined) {
          tryCompleteWire(() => ctx.wireDrawing.completeToPoint(tappedPoint, ctx.circuit, ctx.analogTypeIds));
        } else if (isWireEndpoint(snappedPt, ctx.circuit)) {
          tryCompleteWire(() => ctx.wireDrawing.completeToPoint(snappedPt, ctx.circuit, ctx.analogTypeIds));
        } else if (ctx.wireDrawing.isSameAsLastWaypoint(snappedPt)) {
          // Clicking the same spot twice ends the wire at that point
          tryCompleteWire(() => ctx.wireDrawing.completeToPoint(snappedPt, ctx.circuit, ctx.analogTypeIds));
        } else {
          ctx.wireDrawing.addWaypoint();
        }
      }
      renderPipeline.scheduleRender();
      return;
    }

    const pinHit = hitTestPins(worldPt, ctx.circuit.elements, hitThreshold);
    if (pinHit) {
      ctx.wireDrawing.startFromPin(pinHit.element, pinHit.pin);
      renderPipeline.scheduleRender();
      return;
    }

    const elementHit = hitTestElements(worldPt, ctx.circuit.elements, hitMargin);
    if (elementHit) {
      if (e.shiftKey) {
        ctx.selection.toggleSelect(elementHit);
      } else if (!ctx.selection.isSelected(elementHit)) {
        ctx.selection.select(elementHit);
      }
      dragMode = 'select-drag';
      dragStart = worldPt;
      renderPipeline.scheduleRender();
      return;
    }

    const wireHit = hitTestWires(worldPt, ctx.circuit.wires, hitThreshold);
    if (wireHit) {
      if (e.shiftKey) {
        ctx.selection.toggleSelect(wireHit);
        renderPipeline.scheduleRender();
        return;
      }
      // If the clicked point is a wire endpoint (junction), start wire-drawing
      // from that point instead of dragging the wire segment.
      const snappedPt = snapToGrid(worldPt, 1);
      if (isWireEndpoint(snappedPt, ctx.circuit)) {
        ctx.wireDrawing.startFromPoint(snappedPt);
        renderPipeline.scheduleRender();
        return;
      }
      // If the clicked wire is already part of a multi-wire selection,
      // drag the whole group; otherwise select just this wire.
      if (!ctx.selection.isSelected(wireHit)) {
        ctx.selection.select(wireHit);
      }
      const selectedWires = ctx.selection.getSelectedWires();
      ctx.wireDrag.start(
        selectedWires.size > 1 ? selectedWires : wireHit,
        worldPt, ctx.circuit, ctx.circuit.elements,
      );
      dragMode = 'wire-drag';
      dragStart = worldPt;
      renderPipeline.scheduleRender();
      return;
    }

    if (!e.shiftKey) {
      ctx.selection.clear();
    }
    dragMode = 'box-select';
    renderPipeline.state.boxSelect.active = true;
    renderPipeline.state.boxSelect.startScreen = screenPt;
    renderPipeline.state.boxSelect.currentScreen = screenPt;
    renderPipeline.scheduleRender();
  });

  // -------------------------------------------------------------------------
  // pointermove
  // -------------------------------------------------------------------------

  canvas.addEventListener('pointermove', (e: PointerEvent) => {
    // Touch: delegate to gesture tracker first
    if (e.pointerType === 'touch') {
      // Cancel long-press if pointer moved more than threshold
      if (longPressTimer !== null) {
        const dx = e.clientX - longPressStartX;
        const dy = e.clientY - longPressStartY;
        if (Math.sqrt(dx * dx + dy * dy) > LONG_PRESS_MOVE_THRESHOLD) {
          cancelLongPress();
        } else {
          longPressClientX = e.clientX;
          longPressClientY = e.clientY;
        }
      }
      if (touchGestures.onPointerMove(e, canvas, ctx.viewport, () => renderPipeline.scheduleRender())) return;
    } else {
      if (activePointerId !== null && e.pointerId !== activePointerId) return;
    }
    const worldPt = renderPipeline.canvasToWorld(e);
    const screenPt = renderPipeline.canvasToScreen(e);
    ctx.lastWorldPt = worldPt;

    // Update cursor grid coordinates in status bar
    const statusCoords = document.getElementById('status-coords');
    if (statusCoords) {
      const gx = Math.round(worldPt.x * 100) / 100;
      const gy = Math.round(worldPt.y * 100) / 100;
      statusCoords.textContent = `${gx}, ${gy}`;
    }

    if (ctx.placement.isActive()) {
      ctx.placement.updateCursor(worldPt);
      renderPipeline.scheduleRender();
      return;
    }

    if (ctx.wireDrawing.isActive()) {
      ctx.wireDrawing.updateCursor(worldPt);
      renderPipeline.scheduleRender();
      return;
    }

    if (dragMode === 'pan') {
      const dx = screenPt.x - dragStartScreen.x;
      const dy = screenPt.y - dragStartScreen.y;
      ctx.viewport.panBy({ x: dx, y: dy });
      dragStartScreen = screenPt;
      renderPipeline.scheduleRender();
      return;
    }

    if (dragMode === 'select-drag') {
      const snappedWorld = snapToGrid(worldPt, 1);
      const snappedStart = snapToGrid(dragStart, 1);
      const dx = snappedWorld.x - snappedStart.x;
      const dy = snappedWorld.y - snappedStart.y;
      if (dx !== 0 || dy !== 0) {
        const selectedElements = ctx.selection.getSelectedElements();
        const selectedWires = ctx.selection.getSelectedWires();

        // Collect world-space pin positions BEFORE moving elements.
        const pinPositions = new Set<string>();
        for (const el of selectedElements) {
          for (const pin of el.getPins()) {
            const wp = pinWorldPosition(el, pin);
            pinPositions.add(`${wp.x},${wp.y}`);
          }
        }

        // Move elements.
        for (const el of selectedElements) {
          el.position = { x: el.position.x + dx, y: el.position.y + dy };
        }

        // Stretch wires: move endpoints that were connected to moved pins.
        // Skip wires that are part of the selection (they move with it).
        for (const wire of ctx.circuit.wires) {
          if (selectedWires.has(wire)) continue;
          const startKey = `${wire.start.x},${wire.start.y}`;
          const endKey = `${wire.end.x},${wire.end.y}`;
          if (pinPositions.has(startKey)) {
            wire.start = { x: wire.start.x + dx, y: wire.start.y + dy };
          }
          if (pinPositions.has(endKey)) {
            wire.end = { x: wire.end.x + dx, y: wire.end.y + dy };
          }
        }

        // Also move selected wires with the selection.
        for (const wire of selectedWires) {
          wire.start = { x: wire.start.x + dx, y: wire.start.y + dy };
          wire.end = { x: wire.end.x + dx, y: wire.end.y + dy };
        }

        dragStart = snappedWorld;
        ctx.invalidateCompiled();
      }
      return;
    }

    if (dragMode === 'wire-drag') {
      if (ctx.wireDrag.update(worldPt)) {
        ctx.invalidateCompiled();
      }
      return;
    }

    if (dragMode === 'box-select') {
      renderPipeline.state.boxSelect.currentScreen = screenPt;
      renderPipeline.scheduleRender();
      return;
    }
  });

  // -------------------------------------------------------------------------
  // pointerup
  // -------------------------------------------------------------------------

  canvas.addEventListener('pointerup', (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      cancelLongPress();
      touchGestures.onPointerUp(e);
      // If gesture was active, skip normal drag finish
      if (touchGestures.state === 'IDLE' || !touchGestures.isActive) {
        finishPointerDrag();
      }
      return;
    }
    if (activePointerId !== null && e.pointerId !== activePointerId) return;
    activePointerId = null;
    finishPointerDrag();
  });

  // -------------------------------------------------------------------------
  // pointercancel
  // -------------------------------------------------------------------------

  canvas.addEventListener('pointercancel', (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      cancelLongPress();
      touchGestures.onPointerUp(e);
      touchGestures.reset();
      dragMode = 'none';
      renderPipeline.state.boxSelect.active = false;
      renderPipeline.scheduleRender();
      return;
    }
    if (activePointerId !== null && e.pointerId !== activePointerId) return;
    activePointerId = null;
    // Reset drag state on cancel
    dragMode = 'none';
    ctx.wireDrawing.cancel();
    renderPipeline.state.boxSelect.active = false;
    ctx.wireDrag.cancel();
    renderPipeline.scheduleRender();
  });

  // -------------------------------------------------------------------------
  // wheel (zoom)
  // -------------------------------------------------------------------------

  // passive: true lets the browser compositor run without waiting for JS.
  canvas.addEventListener('wheel', (e: WheelEvent) => {
    const screenPt = renderPipeline.canvasToScreen(e);
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    ctx.viewport.zoomAt(screenPt, factor);
    renderPipeline.scheduleRender();
  }, { passive: true });

  // -------------------------------------------------------------------------
  // dblclick → property popup / memory editor / subcircuit nav
  // -------------------------------------------------------------------------

  canvas.addEventListener('dblclick', (e: MouseEvent) => {
    const worldPt = renderPipeline.canvasToWorld(e);
    const elementHit = hitTestElements(worldPt, ctx.circuit.elements);
    if (!elementHit) return;

    // During simulation, don't open properties for togglable components
    if (ctx.isSimActive() && TOGGLABLE_TYPES.has(elementHit.typeId)) return;

    // Memory components: open hex editor (only during simulation)
    if (ctx.isSimActive() && MEMORY_TYPES.has(elementHit.typeId)) {
      void openMemoryEditor(elementHit);
      return;
    }

    // Subcircuit elements: navigate into them on double-click
    if ('definition' in elementHit && (elementHit as any).definition?.circuit) {
      const subDef = (elementHit as any).definition;
      openSubcircuit(subDef.name, subDef.circuit);
      return;
    }

    const def = ctx.registry.get(elementHit.typeId);
    if (!def || def.propertyDefs.length === 0) return;

    closePopup();

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
      propertyPopup.showSimulationModeDropdown(elementHit, def);
    }
    if (hasDigitalModel(def)) {
      const simModel = elementHit.getProperties().has("simulationModel")
        ? elementHit.getProperties().get("simulationModel") as string
        : (def.defaultModel ?? "logical");
      if (simModel === "logical" || simModel === "analog-pins") {
        const family = ctx.circuit.metadata.logicFamily ?? defaultLogicFamily();
        propertyPopup.showPinElectricalOverrides(elementHit, def, family);
      }
    }
    activePopupPanel = propertyPopup;

    const screenPt = renderPipeline.canvasToScreen(e);
    const container = canvas.parentElement!;
    popup.style.left = `${Math.min(screenPt.x + 10, container.clientWidth - 200)}px`;
    popup.style.top = `${Math.min(screenPt.y + 10, container.clientHeight - 200)}px`;

    // --- Drag support via header ---
    {
      let dragOffsetX = 0;
      let dragOffsetY = 0;
      let containerRect: DOMRect | null = null;
      let popupW = 0;
      let popupH = 0;

      const onDragMove = (ev: PointerEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
        const cr = containerRect!;
        let newLeft = ev.clientX - cr.left - dragOffsetX;
        let newTop = ev.clientY - cr.top - dragOffsetY;
        // Clamp within container
        newLeft = Math.max(0, Math.min(newLeft, cr.width - popupW));
        newTop = Math.max(0, Math.min(newTop, cr.height - popupH));
        popup.style.left = `${newLeft}px`;
        popup.style.top = `${newTop}px`;
      };

      const onDragEnd = (ev: PointerEvent) => {
        ev.stopPropagation();
        document.removeEventListener('pointermove', onDragMove, true);
        document.removeEventListener('pointerup', onDragEnd, true);
        containerRect = null;
      };

      header.addEventListener('pointerdown', (ev: PointerEvent) => {
        if ((ev.target as HTMLElement).tagName === 'BUTTON') return;
        // Snapshot geometry once at drag start
        containerRect = container.getBoundingClientRect();
        const popupRect = popup.getBoundingClientRect();
        popupW = popupRect.width;
        popupH = popupRect.height;
        dragOffsetX = ev.clientX - popupRect.left;
        dragOffsetY = ev.clientY - popupRect.top;
        // Use capture phase to intercept before canvas handler fires
        document.addEventListener('pointermove', onDragMove, true);
        document.addEventListener('pointerup', onDragEnd, true);
        ev.stopPropagation();
        ev.preventDefault();
      });
    }

    container.appendChild(popup);
    activePopup = popup;
  });

  // Close popup when clicking elsewhere on canvas (capture phase)
  canvas.addEventListener('pointerdown', () => {
    closePopup();
  }, true);

  // -------------------------------------------------------------------------
  // Expose public interface
  // -------------------------------------------------------------------------

  return {
    closePopup,
    navigateBack,
    openSubcircuit,
    openMemoryEditor,
    get circuitStack() { return circuitStack; },
  };
}
