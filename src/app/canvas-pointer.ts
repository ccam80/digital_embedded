/**
 * Pointer event handlers (pointerdown, pointermove, pointerup, pointercancel)
 * for the canvas interaction layer.
 *
 * Owns the drag state machine, touch gesture delegation, long-press context
 * menu, wire drawing/completion, element selection, and box-select.
 */

import type { AppContext } from './app-context.js';
import type { RenderPipeline } from './render-pipeline.js';
import type { CanvasInteractionDeps } from './canvas-interaction.js';
import type { CanvasState } from './canvas-shared-state.js';
import { LONG_PRESS_MS, LONG_PRESS_MOVE_THRESHOLD } from './canvas-shared-state.js';
import { snapToGrid } from '../editor/coordinates.js';
import { hitTestElements, hitTestWires, hitTestPins } from '../editor/hit-test.js';
import { splitWiresAtPoint, isWireEndpoint } from '../editor/wire-drawing.js';
import { pasteFromClipboard, placeComponent } from '../editor/edit-operations.js';
import { pinWorldPosition } from '../core/pin.js';
import { BitVector } from '../core/signal.js';
import { EngineState } from '../core/engine-interface.js';
import type { Wire } from '../core/circuit.js';
import { Circuit } from '../core/circuit.js';

// ---------------------------------------------------------------------------
// Wire-completion helper (fixes D6)
// ---------------------------------------------------------------------------

function removeDeadEndStubs(newWires: Wire[], circuit: Circuit): void {
  const endpointCounts = new Map<string, number>();
  const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;

  for (const w of circuit.wires) {
    const sk = key(w.start);
    const ek = key(w.end);
    endpointCounts.set(sk, (endpointCounts.get(sk) ?? 0) + 1);
    endpointCounts.set(ek, (endpointCounts.get(ek) ?? 0) + 1);
  }

  for (const w of newWires) {
    if (w.start.x === w.end.x && w.start.y === w.end.y) {
      circuit.removeWire(w);
    }
  }

  for (const w of newWires) {
    if (w.start.x === w.end.x && w.start.y === w.end.y) continue;

    for (const pt of [w.start, w.end]) {
      const k = key(pt);
      const count = endpointCounts.get(k) ?? 0;
      if (count <= 1) {
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

function tryCompleteWire(
  fn: () => Wire[],
  ctx: AppContext,
): void {
  try {
    const wires = fn();
    removeDeadEndStubs(wires, ctx.circuit);
    ctx.hotRecompile();
  } catch (err) {
    ctx.showStatus(err instanceof Error ? err.message : 'Wire connection failed', true);
    ctx.wireDrawing.cancel();
  }
}

// ---------------------------------------------------------------------------
// finishPointerDrag
// ---------------------------------------------------------------------------

function finishPointerDrag(
  state: CanvasState,
  ctx: AppContext,
  renderPipeline: RenderPipeline,
): void {
  if (state.dragMode === 'wire-drag') {
    ctx.wireDrag.finish(ctx.circuit);
    ctx.hotRecompile();
    renderPipeline.scheduleRender();
  }

  if (state.dragMode === 'box-select') {
    const canvas = ctx.canvas;
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

  state.dragMode = 'none';
}

// ---------------------------------------------------------------------------
// registerPointerHandlers
// ---------------------------------------------------------------------------

export function registerPointerHandlers(
  ctx: AppContext,
  renderPipeline: RenderPipeline,
  _deps: CanvasInteractionDeps,
  state: CanvasState,
  closePopup: () => void,
): void {
  const canvas = ctx.canvas;
  const HIT_THRESHOLD = 0.5;
  const TOUCH_HIT_THRESHOLD = 1.5;
  const TOUCH_HIT_MARGIN = 0.5;

  // Snapshot of wire endpoints connected to selected elements at drag start.
  // Only these wires follow during drag- prevents picking up unrelated wires.
  let dragConnectedWires: Map<Wire, Array<'start' | 'end'>> = new Map();

  function cancelLongPress(): void {
    if (state.longPressTimer !== null) {
      clearTimeout(state.longPressTimer);
      state.longPressTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // pointerdown
  // -------------------------------------------------------------------------

  canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    state.pointerType = e.pointerType;

    if (e.pointerType === 'touch') {
      const worldPt = renderPipeline.canvasToWorld(e);
      const pinHit = hitTestPins(worldPt, ctx.circuit.elements, TOUCH_HIT_THRESHOLD);
      const elementHit = !pinHit ? hitTestElements(worldPt, ctx.circuit.elements, TOUCH_HIT_MARGIN) : undefined;
      const hitEmpty = !pinHit && !elementHit;
      state.touchGestures.onPointerDown(e, hitEmpty);

      cancelLongPress();
      state.longPressStartX = e.clientX;
      state.longPressStartY = e.clientY;
      state.longPressClientX = e.clientX;
      state.longPressClientY = e.clientY;
      state.longPressTimer = setTimeout(() => {
        state.longPressTimer = null;
        const synth = new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true,
          clientX: state.longPressClientX, clientY: state.longPressClientY,
        });
        canvas.dispatchEvent(synth);
      }, LONG_PRESS_MS);

      if (state.touchGestures.isActive) return;
      if (!hitEmpty) {
        // Let normal logic handle taps on elements/pins below
      } else {
        return;
      }
    }

    if (e.pointerType !== 'touch') {
      if (state.activePointerId !== null && e.pointerId !== state.activePointerId) return;
      state.activePointerId = e.pointerId;
    }

    const worldPt = renderPipeline.canvasToWorld(e);
    const screenPt = renderPipeline.canvasToScreen(e);
    const isTouch = e.pointerType === 'touch';
    const hitThreshold = isTouch ? TOUCH_HIT_THRESHOLD : HIT_THRESHOLD;
    const hitMargin = isTouch ? TOUCH_HIT_MARGIN : 0;

    if (e.button === 1) {
      state.dragMode = 'pan';
      state.dragStartScreen = screenPt;
      e.preventDefault();
      return;
    }

    if (e.button !== 0 && e.pointerType !== 'touch') return;

    if (ctx.placement.isActive() && ctx.placement.isPasteMode()) {
      ctx.hotRecompile();
      ctx.placement.updateCursor(worldPt);
      const transformed = ctx.placement.getTransformedClipboard();
      const cmd = pasteFromClipboard(ctx.circuit, transformed, worldPt);
      ctx.undoStack.push(cmd);
      ctx.placement.cancel();
      return;
    }

    if (ctx.placement.isActive()) {
      const lastPlaced = ctx.placement.getLastPlaced();
      if (lastPlaced) {
        const pinHit = hitTestPins(worldPt, [lastPlaced], hitThreshold);
        const elemHit = !pinHit && hitTestElements(worldPt, [lastPlaced]);
        if (pinHit || elemHit) {
          ctx.placement.cancel();
          ctx.hotRecompile();
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
      ctx.hotRecompile();
      ctx.placement.updateCursor(worldPt);
      const placed = ctx.placement.place(ctx.circuit);
      ctx.undoStack.push(placeComponent(ctx.circuit, placed));
      return;
    }

    if (ctx.isSimActive()) {
      const elementHit = hitTestElements(worldPt, ctx.circuit.elements, hitMargin);
      if (elementHit) {
        ctx.selection.clear();
        ctx.selection.select(elementHit);

        const eng = ctx.facade.getCoordinator();

        if (elementHit.typeId === 'Switch' || elementHit.typeId === 'SwitchDT') {
          // Hot-load switch state via setComponentProperty (analog: setParam→setClosed,
          // digital: layout.setProperty). No recompile needed.
          const toggleSwitch = (closed: boolean): void => {
            elementHit.setAttribute('closed', closed);
            eng.setComponentProperty(elementHit, 'closed', closed ? 1 : 0);
            if (eng.getState() !== EngineState.RUNNING) {
              ctx.facade.step(eng, { clockAdvance: false });
            }
            renderPipeline.scheduleRender();
          };
          const momentary = (elementHit.getAttribute('momentary') as boolean | undefined) ?? false;
          if (momentary) {
            toggleSwitch(true);
            document.addEventListener('pointerup', () => toggleSwitch(false), { once: true });
          } else {
            const current = (elementHit.getAttribute('closed') as boolean | undefined) ?? false;
            toggleSwitch(!current);
          }
        } else if (elementHit.typeId === 'In' || elementHit.typeId === 'Clock' || elementHit.typeId === 'Port') {
          // Hot-load digital input via binding.setInput (writes directly to signal
          // array, equivalent to analog setParam). No recompile needed.
          const bitWidth = (elementHit.getAttribute('bitWidth') as number | undefined) ?? 1;
          const current = ctx.binding.isBound
            ? ctx.binding.getPinValue(elementHit, 'out')
            : ((elementHit.getAttribute('defaultValue') as number | undefined) ?? 0);
          const newVal = bitWidth === 1
            ? (current === 0 ? 1 : 0)
            : ((current + 1) & ((1 << bitWidth) - 1));
          elementHit.setAttribute('defaultValue', newVal);
          ctx.binding.setInput(elementHit, 'out', BitVector.fromNumber(newVal, bitWidth));
          if (eng.getState() !== EngineState.RUNNING) {
            ctx.facade.step(eng, { clockAdvance: elementHit.typeId !== 'Clock' && elementHit.typeId !== 'Port' });
          }
        }
      } else {
        ctx.selection.clear();
      }
      renderPipeline.scheduleRender();
      return;
    }

    if (ctx.wireDrawing.isActive()) {
      const pinHit = hitTestPins(worldPt, ctx.circuit.elements, hitThreshold);
      if (pinHit) {
        tryCompleteWire(() => ctx.wireDrawing.completeToPin(pinHit.element, pinHit.pin, ctx.circuit, ctx.analogTypeIds), ctx);
      } else {
        const snappedPt = snapToGrid(worldPt, 1);
        // Only auto-complete to a wire if the user actually clicked near it
        // (hit-test on raw worldPt), not just because the grid-snapped point
        // coincidentally lands on a wire's geometry.
        const wireUnderClick = hitTestWires(worldPt, ctx.circuit.wires, hitThreshold);
        if (wireUnderClick) {
          const tappedPoint = splitWiresAtPoint(snappedPt, ctx.circuit);
          if (tappedPoint !== undefined) {
            tryCompleteWire(() => ctx.wireDrawing.completeToPoint(tappedPoint, ctx.circuit, ctx.analogTypeIds), ctx);
          } else if (isWireEndpoint(snappedPt, ctx.circuit)) {
            tryCompleteWire(() => ctx.wireDrawing.completeToPoint(snappedPt, ctx.circuit, ctx.analogTypeIds), ctx);
          } else {
            ctx.wireDrawing.addWaypoint();
          }
        } else if (ctx.wireDrawing.isSameAsLastWaypoint(snappedPt)) {
          tryCompleteWire(() => ctx.wireDrawing.completeToPoint(snappedPt, ctx.circuit, ctx.analogTypeIds), ctx);
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
      state.dragMode = 'select-drag';
      state.dragStart = worldPt;
      // Snapshot which wire endpoints are connected to selected elements' pins
      // at drag start. Only these wires should follow during drag- prevents
      // unrelated wires from being picked up as pins sweep through other joins.
      dragConnectedWires = new Map();
      const selectedElements = ctx.selection.getSelectedElements();
      const pinPosSet = new Set<string>();
      for (const el of selectedElements) {
        for (const pin of el.getPins()) {
          const wp = pinWorldPosition(el, pin);
          pinPosSet.add(`${wp.x},${wp.y}`);
        }
      }
      const selectedWires = ctx.selection.getSelectedWires();
      for (const wire of ctx.circuit.wires) {
        if (selectedWires.has(wire)) continue;
        const sk = `${wire.start.x},${wire.start.y}`;
        const ek = `${wire.end.x},${wire.end.y}`;
        const ends: Array<'start' | 'end'> = [];
        if (pinPosSet.has(sk)) ends.push('start');
        if (pinPosSet.has(ek)) ends.push('end');
        if (ends.length > 0) dragConnectedWires.set(wire, ends);
      }
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
      const snappedPt = snapToGrid(worldPt, 1);
      if (isWireEndpoint(snappedPt, ctx.circuit)) {
        ctx.wireDrawing.startFromPoint(snappedPt);
        renderPipeline.scheduleRender();
        return;
      }
      if (!ctx.selection.isSelected(wireHit)) {
        ctx.selection.select(wireHit);
      }
      const selectedWires = ctx.selection.getSelectedWires();
      ctx.wireDrag.start(
        selectedWires.size > 1 ? selectedWires : wireHit,
        worldPt, ctx.circuit, ctx.circuit.elements,
      );
      state.dragMode = 'wire-drag';
      state.dragStart = worldPt;
      renderPipeline.scheduleRender();
      return;
    }

    if (!e.shiftKey) {
      ctx.selection.clear();
    }
    state.dragMode = 'box-select';
    renderPipeline.state.boxSelect.active = true;
    renderPipeline.state.boxSelect.startScreen = screenPt;
    renderPipeline.state.boxSelect.currentScreen = screenPt;
    renderPipeline.scheduleRender();
  });

  // -------------------------------------------------------------------------
  // pointermove
  // -------------------------------------------------------------------------

  canvas.addEventListener('pointermove', (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      if (state.longPressTimer !== null) {
        const dx = e.clientX - state.longPressStartX;
        const dy = e.clientY - state.longPressStartY;
        if (Math.sqrt(dx * dx + dy * dy) > LONG_PRESS_MOVE_THRESHOLD) {
          cancelLongPress();
        } else {
          state.longPressClientX = e.clientX;
          state.longPressClientY = e.clientY;
        }
      }
      if (state.touchGestures.onPointerMove(e, canvas, ctx.viewport, () => renderPipeline.scheduleRender())) return;
    } else {
      if (state.activePointerId !== null && e.pointerId !== state.activePointerId) return;
    }

    const worldPt = renderPipeline.canvasToWorld(e);
    const screenPt = renderPipeline.canvasToScreen(e);
    ctx.lastWorldPt = worldPt;

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

    if (state.dragMode === 'pan') {
      const dx = screenPt.x - state.dragStartScreen.x;
      const dy = screenPt.y - state.dragStartScreen.y;
      ctx.viewport.panBy({ x: dx, y: dy });
      state.dragStartScreen = screenPt;
      renderPipeline.scheduleRender();
      return;
    }

    if (state.dragMode === 'select-drag') {
      const snappedWorld = snapToGrid(worldPt, 1);
      const snappedStart = snapToGrid(state.dragStart, 1);
      const dx = snappedWorld.x - snappedStart.x;
      const dy = snappedWorld.y - snappedStart.y;
      if (dx !== 0 || dy !== 0) {
        const selectedElements = ctx.selection.getSelectedElements();
        const selectedWires = ctx.selection.getSelectedWires();

        for (const el of selectedElements) {
          el.position = { x: el.position.x + dx, y: el.position.y + dy };
        }

        // Move only wires that were connected at drag start (snapshot),
        // not wires that happen to be at the current pin position.
        for (const [wire, ends] of dragConnectedWires) {
          for (const which of ends) {
            if (which === 'start') {
              wire.start = { x: wire.start.x + dx, y: wire.start.y + dy };
            } else {
              wire.end = { x: wire.end.x + dx, y: wire.end.y + dy };
            }
          }
        }

        for (const wire of selectedWires) {
          wire.start = { x: wire.start.x + dx, y: wire.start.y + dy };
          wire.end = { x: wire.end.x + dx, y: wire.end.y + dy };
        }

        state.dragStart = snappedWorld;
        ctx.hotRecompile();
      }
      return;
    }

    if (state.dragMode === 'wire-drag') {
      if (ctx.wireDrag.update(worldPt)) {
        ctx.hotRecompile();
      }
      return;
    }

    if (state.dragMode === 'box-select') {
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
      state.touchGestures.onPointerUp(e);
      if (state.touchGestures.state === 'IDLE' || !state.touchGestures.isActive) {
        finishPointerDrag(state, ctx, renderPipeline);
      }
      return;
    }
    if (state.activePointerId !== null && e.pointerId !== state.activePointerId) return;
    state.activePointerId = null;
    finishPointerDrag(state, ctx, renderPipeline);
  });

  // -------------------------------------------------------------------------
  // pointercancel
  // -------------------------------------------------------------------------

  canvas.addEventListener('pointercancel', (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      cancelLongPress();
      state.touchGestures.onPointerUp(e);
      state.touchGestures.reset();
      state.dragMode = 'none';
      renderPipeline.state.boxSelect.active = false;
      renderPipeline.scheduleRender();
      return;
    }
    if (state.activePointerId !== null && e.pointerId !== state.activePointerId) return;
    state.activePointerId = null;
    state.dragMode = 'none';
    ctx.wireDrawing.cancel();
    renderPipeline.state.boxSelect.active = false;
    ctx.wireDrag.cancel();
    renderPipeline.scheduleRender();
  });

  // Close popup on any canvas pointerdown (capture phase)
  canvas.addEventListener('pointerdown', () => {
    closePopup();
  }, true);
}
