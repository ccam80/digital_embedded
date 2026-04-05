/**
 * ViewerController — scope panels, signal viewers, and trace management.
 *
 * Extracted from app-init.ts (Step 6 of modularization plan).
 * Owns: WatchedSignal[], ScopePanelEntry management, DataTablePanel lifecycle,
 * disposeViewers/rebuildViewers, viewer tab/open/close, context menu helpers
 * for wire viewer and component trace items, scope panel context menu.
 */

import type { AppContext } from './app-context.js';
import type { RenderPipeline } from './render-pipeline.js';
import { ScopePanel } from '../runtime/analog-scope-panel.js';
import type { OverlayKind } from '../runtime/analog-scope-panel.js';
import { DataTablePanel } from '../runtime/data-table.js';
import type { SignalDescriptor, SignalGroup } from '../runtime/data-table.js';
import type { Wire } from '../core/circuit.js';
import type { SavedTrace } from '../core/circuit.js';
import type { MenuItem } from '../editor/context-menu.js';
import { separator } from '../editor/context-menu.js';
import type { CircuitElement } from '../core/element.js';
import type { SignalAddress } from '../compile/types.js';
import type { SimulationCoordinator, CurrentResolverContext } from '../solver/coordinator-types.js';
import { pinWorldPosition } from '../core/pin.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WatchedSignal {
  name: string;
  addr: SignalAddress;
  width: number;
  group: SignalGroup;
  panelIndex: number;
  /** 'voltage' (default) or 'current' — determines which scope channel type is created. */
  kind?: 'voltage' | 'current';
  /** For current signals: the element label used to re-resolve the element index after recompile. */
  elementLabel?: string;
  /** For current signals: the resolved element index in the compiled analog circuit. */
  elementIndex?: number;
}

export interface ViewerController {
  disposeViewers(): void;
  rebuildViewers(): void;
  addWireToViewer(wire: Wire, panelIndex?: number): void;
  removeSignalFromViewer(netId: number): void;
  openViewer(tabName: string): void;
  closeViewer(): void;
  showViewerTab(tabName: string): void;
  appendWireViewerItems(items: MenuItem[], wire: Wire, coordinator: SimulationCoordinator): void;
  appendComponentTraceItems(items: MenuItem[], element: CircuitElement, resolverCtx: CurrentResolverContext | null): void;
  attachScopeContextMenu(cvs: HTMLCanvasElement, panel: ScopePanel): void;
  readonly watchedSignals: WatchedSignal[];
  /** Re-resolve signal addresses after recompilation, then rebuild panels if viewer is open. */
  resolveWatchedSignalAddresses(unified: { labelSignalMap: ReadonlyMap<string, SignalAddress>; pinSignalMap?: ReadonlyMap<string, SignalAddress> }): void;
  /** Restore watched signals from persisted trace metadata after a load/compile cycle. */
  restoreTraces(traces: SavedTrace[] | undefined): void;
}

// ---------------------------------------------------------------------------
// D5 fix — shared signal name resolution utility
// ---------------------------------------------------------------------------

/**
 * Resolve a human-readable name for a signal address from the labelSignalMap.
 * Falls back to "node<id>" or "net<id>" if no label is found.
 */
export function resolveSignalName(
  labelSignalMap: ReadonlyMap<string, SignalAddress>,
  addr: SignalAddress,
): string {
  if (addr.domain === 'analog') {
    for (const [label, a] of labelSignalMap) {
      if (a.domain === 'analog' && a.nodeId === addr.nodeId) return label;
    }
    return `node${addr.nodeId}`;
  } else {
    for (const [label, a] of labelSignalMap) {
      if (a.domain === 'digital' && a.netId === addr.netId) return label;
    }
    return `net${addr.netId}`;
  }
}

// ---------------------------------------------------------------------------
// initViewerController
// ---------------------------------------------------------------------------

export function initViewerController(ctx: AppContext, renderPipeline: RenderPipeline): ViewerController {
  const { facade, contextMenu } = ctx;

  // -------------------------------------------------------------------------
  // DOM references
  // -------------------------------------------------------------------------

  const viewerPanel = document.getElementById('viewer-panel');
  const viewerTimingContainer = document.getElementById('viewer-timing-container');
  const viewerValuesContainer = document.getElementById('viewer-values');
  const viewerTabs = viewerPanel?.querySelectorAll('.viewer-tab');

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  let activeDataTable: DataTablePanel | null = null;
  const watchedSignals: WatchedSignal[] = [];

  function _syncTracesToMetadata(): void {
    const circuit = ctx.getCircuit();
    if (!circuit) return;
    circuit.metadata.traces = watchedSignals.map(sig => ({
      name: sig.name,
      domain: sig.addr.domain,
      panelIndex: sig.panelIndex,
      group: sig.group,
      ...(sig.kind === 'current' ? { kind: 'current' as const, elementLabel: sig.elementLabel } : {}),
    }));
  }

  // -------------------------------------------------------------------------
  // Core viewer lifecycle
  // -------------------------------------------------------------------------

  function disposeViewers(): void {
    const coordinator = facade.getCoordinator();
    for (const entry of renderPipeline.state.scopePanels) {
      entry.panel.dispose();
      // Canvas may be inside a .scope-panel-wrapper div
      const wrapper = entry.canvas.parentElement;
      if (wrapper?.classList.contains('scope-panel-wrapper')) {
        wrapper.remove();
      } else {
        entry.canvas.remove();
      }
    }
    renderPipeline.state.scopePanels.length = 0;
    if (activeDataTable) {
      coordinator.removeMeasurementObserver(activeDataTable);
      activeDataTable.dispose();
      activeDataTable = null;
    }
  }

  function rebuildViewers(): void {
    disposeViewers();
    const coordinator = facade.getCoordinator();
    if (watchedSignals.length === 0) return;

    if (viewerTimingContainer) {
      // Group signals by panelIndex for multi-panel scope view
      const panelGroups = new Map<number, WatchedSignal[]>();
      for (const s of watchedSignals) {
        const idx = s.panelIndex ?? 0;
        if (!panelGroups.has(idx)) panelGroups.set(idx, []);
        panelGroups.get(idx)!.push(s);
      }

      // Create a canvas + ScopePanel per panel group
      const sortedIndices = [...panelGroups.keys()].sort((a, b) => a - b);
      const wrappers: HTMLElement[] = [];
      for (const idx of sortedIndices) {
        const signals = panelGroups.get(idx)!;

        // Wrapper div with close button
        const wrapper = document.createElement('div');
        wrapper.className = 'scope-panel-wrapper';
        wrapper.style.cssText = 'flex:1 1 0;min-width:50px;position:relative;overflow:hidden;display:flex;';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'scope-panel-close';
        closeBtn.textContent = '\u00d7';
        closeBtn.title = 'Close panel';
        closeBtn.style.cssText = 'position:absolute;top:2px;right:4px;z-index:10;background:rgba(0,0,0,0.5);color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:14px;line-height:1;padding:1px 5px;';
        closeBtn.addEventListener('click', () => {
          // Remove all signals belonging to this panel group
          for (let i = watchedSignals.length - 1; i >= 0; i--) {
            if ((watchedSignals[i].panelIndex ?? 0) === idx) {
              watchedSignals.splice(i, 1);
            }
          }
          if (watchedSignals.length === 0) {
            closeViewer();
          } else {
            rebuildViewers();
          }
        });

        const cvs = document.createElement('canvas');
        cvs.style.cssText = 'flex:1;min-width:0;height:100%;';
        wrapper.appendChild(closeBtn);
        wrapper.appendChild(cvs);
        viewerTimingContainer.appendChild(wrapper);
        wrappers.push(wrapper);
        // Size after DOM insertion so clientWidth/Height are available
        requestAnimationFrame(() => renderPipeline.sizeCanvasInContainer(cvs));
        const panel = new ScopePanel(cvs, coordinator);
        for (const s of signals) {
          if (s.kind === 'current' && s.elementIndex !== undefined) {
            panel.addElementCurrentChannel(s.elementIndex, s.name);
          } else if (s.addr.domain === 'analog') {
            panel.addVoltageChannel(s.addr, s.name);
          } else {
            panel.addDigitalChannel(s.addr, s.name);
          }
        }
        attachScopeContextMenu(cvs, panel);
        renderPipeline.state.scopePanels.push({ canvas: cvs, panel });
      }

      // Insert draggable splitters between panel wrappers
      for (let i = 0; i < wrappers.length - 1; i++) {
        const splitter = document.createElement('div');
        splitter.className = 'panel-splitter';
        splitter.style.cssText = 'width:4px;flex-shrink:0;cursor:col-resize;background:#333;';
        wrappers[i].after(splitter);

        const leftW = wrappers[i];
        const rightW = wrappers[i + 1];
        splitter.addEventListener('mousedown', (e: MouseEvent) => {
          e.preventDefault();
          const startX = e.clientX;
          const leftRect = leftW.getBoundingClientRect();
          const rightRect = rightW.getBoundingClientRect();

          const onMove = (ev: MouseEvent) => {
            const dx = ev.clientX - startX;
            const newLeftPx = Math.max(50, leftRect.width + dx);
            const newRightPx = Math.max(50, rightRect.width - dx);
            leftW.style.flexGrow = String(newLeftPx);
            rightW.style.flexGrow = String(newRightPx);
            // Re-size canvases on next frame
            requestAnimationFrame(() => {
              for (const sp of renderPipeline.state.scopePanels) {
                renderPipeline.sizeCanvasInContainer(sp.canvas);
                sp.panel.render();
              }
            });
          };

          const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        });
      }
    }

    if (viewerValuesContainer) {
      const signals: SignalDescriptor[] = watchedSignals.map(s => ({
        name: s.name,
        addr: s.addr,
        width: s.width,
        group: s.group,
      }));
      activeDataTable = new DataTablePanel(viewerValuesContainer, coordinator, signals);
      coordinator.addMeasurementObserver(activeDataTable);
    }

    _syncTracesToMetadata();
  }

  // -------------------------------------------------------------------------
  // Panel index helpers
  // -------------------------------------------------------------------------

  function nextPanelIndex(): number {
    let max = -1;
    for (const s of watchedSignals) if (s.panelIndex > max) max = s.panelIndex;
    return max + 1;
  }

  function getPanelList(): Array<{ index: number; label: string }> {
    const panels = new Map<number, string[]>();
    for (const s of watchedSignals) {
      if (!panels.has(s.panelIndex)) panels.set(s.panelIndex, []);
      panels.get(s.panelIndex)!.push(s.name);
    }
    const result: Array<{ index: number; label: string }> = [];
    for (const [idx, names] of [...panels.entries()].sort((a, b) => a[0] - b[0])) {
      result.push({ index: idx, label: `Panel ${idx + 1}: ${names.join(', ')}` });
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Signal add/remove
  // -------------------------------------------------------------------------

  function addWireToViewer(wire: Wire, panelIndex?: number): void {
    const coordinator = facade.getCoordinator();
    const addr = coordinator.compiled.wireSignalMap.get(wire);
    if (addr === undefined) return;

    if (addr.domain === 'analog') {
      const nodeId = addr.nodeId;
      if (watchedSignals.some(s => s.addr.domain === 'analog' && s.addr.nodeId === nodeId)) return;
      const name = resolveSignalName(coordinator.compiled.labelSignalMap, addr);
      const idx = panelIndex ?? (watchedSignals.length === 0 ? 0 : watchedSignals[watchedSignals.length - 1].panelIndex);
      watchedSignals.push({ name, addr: { domain: 'analog', nodeId }, width: 1, group: 'probe', panelIndex: idx });
    } else {
      const netId = addr.netId;
      if (watchedSignals.some(s => s.addr.domain === 'digital' && s.addr.netId === netId)) return;
      const name = resolveSignalName(coordinator.compiled.labelSignalMap, addr);
      const width = addr.bitWidth;
      const group: SignalGroup = 'probe';
      const idx = panelIndex ?? (watchedSignals.length === 0 ? 0 : watchedSignals[watchedSignals.length - 1].panelIndex);
      watchedSignals.push({ name, addr: { domain: 'digital', netId, bitWidth: width, direction: addr.direction }, width, group, panelIndex: idx });
    }

    viewerPanel?.classList.add('open');
    showViewerTab('timing');
    rebuildViewers();
  }

  function removeSignalFromViewer(netId: number): void {
    const idx = watchedSignals.findIndex(s => s.addr.domain === 'digital' && s.addr.netId === netId);
    if (idx >= 0) watchedSignals.splice(idx, 1);
    if (watchedSignals.length === 0) {
      closeViewer();
    } else {
      rebuildViewers();
    }
  }

  // -------------------------------------------------------------------------
  // Tab / open / close
  // -------------------------------------------------------------------------

  function showViewerTab(tabName: string): void {
    viewerTabs?.forEach(t => {
      t.classList.toggle('active', (t as HTMLElement).dataset['viewer'] === tabName);
    });
    viewerTimingContainer?.classList.toggle('active', tabName === 'timing');
    viewerValuesContainer?.classList.toggle('active', tabName === 'values');
  }

  function openViewer(tabName: string): void {
    if (!ctx.ensureCompiled()) return;
    viewerPanel?.classList.add('open');
    showViewerTab(tabName);
    if (watchedSignals.length > 0 && renderPipeline.state.scopePanels.length === 0 && !activeDataTable) {
      rebuildViewers();
    }
  }

  function closeViewer(): void {
    viewerPanel?.classList.remove('open');
    disposeViewers();
    _syncTracesToMetadata();
  }

  // -------------------------------------------------------------------------
  // DOM event listeners
  // -------------------------------------------------------------------------

  // Tab clicks
  viewerTabs?.forEach(tab => {
    tab.addEventListener('click', () => {
      const name = (tab as HTMLElement).dataset['viewer'];
      if (name) showViewerTab(name);
    });
  });

  // Close button
  document.getElementById('btn-viewer-close')?.addEventListener('click', closeViewer);

  // Toolbar buttons
  document.getElementById('btn-tb-timing')?.addEventListener('click', () => openViewer('timing'));
  document.getElementById('btn-tb-values')?.addEventListener('click', () => openViewer('values'));

  // Menu items
  document.getElementById('btn-menu-timing')?.addEventListener('click', () => openViewer('timing'));
  document.getElementById('btn-menu-values')?.addEventListener('click', () => openViewer('values'));

  // -------------------------------------------------------------------------
  // Context menu helpers
  // -------------------------------------------------------------------------

  function _elementLabel(element: CircuitElement): string {
    const props = element.getProperties();
    const lbl = props.has('label') ? String(props.get('label')) : '';
    return lbl || element.typeId;
  }

  function appendWireViewerItems(
    items: MenuItem[],
    wire: Wire,
    coordinator: SimulationCoordinator,
  ): void {
    const addr = coordinator.compiled.wireSignalMap.get(wire);
    if (addr === undefined) return;

    const netId = addr.domain === 'analog' ? addr.nodeId : addr.netId;
    const signalName = resolveSignalName(coordinator.compiled.labelSignalMap, addr);

    const isWatched = watchedSignals.some(s => s.addr.domain === 'digital' && s.addr.netId === netId);
    const capturedNetId = netId;

    if (!isWatched) {
      const existingPanels = getPanelList();
      for (const p of existingPanels) {
        items.push({
          label: `Add "${signalName}" to ${p.label}`,
          action: () => addWireToViewer(wire, p.index),
          enabled: true,
        });
      }
      items.push({
        label: existingPanels.length > 0 ? `Add "${signalName}" to New Panel` : `Add "${signalName}" to Viewer`,
        action: () => addWireToViewer(wire, nextPanelIndex()),
        enabled: true,
      });
    } else {
      items.push({
        label: `Remove "${signalName}" from Viewer`,
        action: () => removeSignalFromViewer(capturedNetId),
        enabled: true,
      });
    }
  }

  function appendComponentTraceItems(
    items: MenuItem[],
    element: CircuitElement,
    resolverCtx: CurrentResolverContext | null,
  ): void {
    const label = _elementLabel(element);
    const pins = element.getPins();

    if (resolverCtx) {
      let elementIndex = -1;
      for (const [idx, ce] of resolverCtx.elementToCircuitElement) {
        if (ce === element) { elementIndex = idx; break; }
      }
      if (elementIndex < 0) return;

      const analogEl = resolverCtx.elements[elementIndex];
      if (!analogEl) return;

      if (items.length > 0) items.push(separator());

      // Resolve pin node IDs by world position (not by indexing pinNodeIds,
      // which may differ in order from pins, e.g. FET pinNodeIds = [D,G,S]
      // but pins = [G,S,D]).
      const pinNodeMap: { pinLabel: string; nodeId: number }[] = [];
      for (const pin of pins) {
        const wp = pinWorldPosition(element, pin);
        for (const [wire, nid] of resolverCtx.wireToNodeId) {
          if (
            (Math.abs(wire.start.x - wp.x) < 0.5 && Math.abs(wire.start.y - wp.y) < 0.5) ||
            (Math.abs(wire.end.x - wp.x) < 0.5 && Math.abs(wire.end.y - wp.y) < 0.5)
          ) {
            pinNodeMap.push({ pinLabel: pin.label, nodeId: nid });
            break;
          }
        }
      }

      const existingPanels = getPanelList();
      const pinNodeIds = (analogEl as unknown as { pinNodeIds: number[] }).pinNodeIds ?? [];
      const firstNodeAddr: SignalAddress = pinNodeIds.length > 0
        ? { domain: 'analog' as const, nodeId: pinNodeIds[0]! }
        : { domain: 'analog' as const, nodeId: 0 };

      // Helper: add a voltage trace to a specific panel
      const addVoltageTrace = (pinLabel: string, nodeId: number, panelIdx: number) => {
        const name = `${label}.${pinLabel}`;
        const addr: SignalAddress = { domain: 'analog' as const, nodeId };
        if (!watchedSignals.some(s => s.name === name)) {
          watchedSignals.push({ name, addr, width: 1, group: 'probe', panelIndex: panelIdx });
        }
        rebuildViewers();
        viewerPanel?.classList.add('open');
        showViewerTab('timing');
      };

      // Helper: add a current trace to a specific panel
      const addCurrentTrace = (panelIdx: number) => {
        const name = `${label} I`;
        if (!watchedSignals.some(s => s.name === name)) {
          watchedSignals.push({
            name, addr: firstNodeAddr, width: 1, group: 'probe',
            panelIndex: panelIdx, kind: 'current',
            elementLabel: label, elementIndex: elementIndex,
          });
        }
        rebuildViewers();
        viewerPanel?.classList.add('open');
        showViewerTab('timing');
      };

      // For 2-terminal components: "Trace Voltage: Label" (across the component)
      // For 3+ terminal: per-pin "Trace Voltage: Label.Pin"
      if (pinNodeMap.length <= 2 && pinNodeMap.length > 0) {
        // Use first pin for the voltage trace
        const { pinLabel, nodeId } = pinNodeMap[0];
        items.push({
          label: `Trace Voltage: ${label}`,
          action: () => addVoltageTrace(pinLabel, nodeId, existingPanels[0]?.index ?? nextPanelIndex()),
          enabled: true,
        });
        if (existingPanels.length > 0) {
          items.push({
            label: `Trace Voltage: ${label} (New Panel)`,
            action: () => addVoltageTrace(pinLabel, nodeId, nextPanelIndex()),
            enabled: true,
          });
        }
      } else {
        for (const { pinLabel, nodeId } of pinNodeMap) {
          items.push({
            label: `Trace Voltage: ${label}.${pinLabel}`,
            action: () => addVoltageTrace(pinLabel, nodeId, existingPanels[0]?.index ?? nextPanelIndex()),
            enabled: true,
          });
        }
        if (existingPanels.length > 0 && pinNodeMap.length > 0) {
          items.push(separator());
          for (const { pinLabel, nodeId } of pinNodeMap) {
            items.push({
              label: `Trace Voltage: ${label}.${pinLabel} (New Panel)`,
              action: () => addVoltageTrace(pinLabel, nodeId, nextPanelIndex()),
              enabled: true,
            });
          }
        }
      }

      // Element current trace
      items.push(separator());
      items.push({
        label: `Trace Current: ${label}`,
        action: () => addCurrentTrace(existingPanels[0]?.index ?? nextPanelIndex()),
        enabled: true,
      });
      if (existingPanels.length > 0) {
        items.push({
          label: `Trace Current: ${label} (New Panel)`,
          action: () => addCurrentTrace(nextPanelIndex()),
          enabled: true,
        });
      }
    } else {
      if (pins.length === 0) return;
      if (items.length > 0) items.push(separator());

      items.push({
        label: `Trace Voltages: ${label} (starts on Run)`,
        action: () => {
          ctx.showStatus(`Probe queued — start simulation to view traces`, false);
        },
        enabled: true,
      });
    }
  }

  function attachScopeContextMenu(
    cvs: HTMLCanvasElement,
    panel: ScopePanel,
  ): void {
    cvs.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      contextMenu.hide();

      const items: MenuItem[] = [];
      const channels = panel.getChannelDescriptors();

      // Remove channels
      for (const ch of channels) {
        items.push({
          label: `Remove "${ch.label}"`,
          action: () => {
            panel.removeChannel(ch.label);
            const sigIdx = watchedSignals.findIndex(s => s.name === ch.label);
            if (sigIdx >= 0) watchedSignals.splice(sigIdx, 1);
            _syncTracesToMetadata();
            const remaining = panel.getChannelDescriptors();
            if (remaining.length === 0 && watchedSignals.length === 0) {
              closeViewer();
            } else {
              panel.render();
            }
          },
          enabled: true,
        });
      }

      // Trace Properties modal
      if (channels.length > 0) {
        items.push(separator());
        items.push({
          label: 'Trace Properties\u2026',
          action: () => _showTracePropertiesModal(panel),
          enabled: true,
        });
      }

      if (items.length > 0) {
        contextMenu.showItems(e.clientX, e.clientY, items);
      }
    });
  }

  // -----------------------------------------------------------------------
  // Trace Properties modal (replaces browser prompt for Y-range etc.)
  // -----------------------------------------------------------------------

  function _showTracePropertiesModal(panel: ScopePanel): void {
    const channels = panel.getChannelDescriptors();
    const fftOn = panel.isFftEnabled();

    // --- Overlay ---
    const overlay = document.createElement('div');
    overlay.className = 'scheme-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'scheme-dialog';
    dialog.style.width = '380px';

    // Header
    const header = document.createElement('div');
    header.className = 'scheme-dialog-header';
    header.innerHTML = 'Trace Properties';
    const closeX = document.createElement('button');
    closeX.className = 'scheme-dialog-close';
    closeX.textContent = '\u00d7';
    closeX.style.cssText = 'background:none;border:none;color:var(--fg);font-size:18px;cursor:pointer;padding:0 4px;';
    closeX.addEventListener('click', () => overlay.remove());
    header.appendChild(closeX);

    // Body
    const body = document.createElement('div');
    body.className = 'scheme-dialog-body';

    // --- Per-channel Y-range sections (analog only) ---
    interface ChannelSection { label: string; autoCheck: HTMLInputElement; yMinInput: HTMLInputElement; yMaxInput: HTMLInputElement }
    const channelSections: ChannelSection[] = [];

    for (const ch of channels) {
      if (ch.kind === 'digital') continue;

      const section = document.createElement('div');
      section.style.cssText = 'border:1px solid var(--panel-border);border-radius:4px;padding:8px;';

      const title = document.createElement('div');
      title.style.cssText = 'font-weight:600;font-size:12px;margin-bottom:6px;';
      title.textContent = ch.label;
      section.appendChild(title);

      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;';

      const yLabel = document.createElement('span');
      yLabel.style.cssText = 'font-size:11px;opacity:0.7;';
      yLabel.textContent = 'Y Range';

      const autoLabel = document.createElement('label');
      autoLabel.style.cssText = 'font-size:11px;display:flex;align-items:center;gap:3px;';
      const autoCheck = document.createElement('input');
      autoCheck.type = 'checkbox';
      autoCheck.checked = ch.autoRange;
      autoLabel.appendChild(autoCheck);
      autoLabel.appendChild(document.createTextNode('Auto'));

      const inputCss = 'width:68px;padding:2px 4px;background:var(--bg);border:1px solid var(--panel-border);color:var(--fg);border-radius:2px;font-size:11px;font-family:monospace;';
      const yMinInput = document.createElement('input');
      yMinInput.type = 'number';
      yMinInput.step = 'any';
      yMinInput.style.cssText = inputCss;
      yMinInput.value = ch.yMin.toPrecision(3);
      yMinInput.disabled = ch.autoRange;

      const toSpan = document.createElement('span');
      toSpan.style.cssText = 'font-size:11px;opacity:0.7;';
      toSpan.textContent = 'to';

      const yMaxInput = document.createElement('input');
      yMaxInput.type = 'number';
      yMaxInput.step = 'any';
      yMaxInput.style.cssText = inputCss;
      yMaxInput.value = ch.yMax.toPrecision(3);
      yMaxInput.disabled = ch.autoRange;

      autoCheck.addEventListener('change', () => {
        yMinInput.disabled = autoCheck.checked;
        yMaxInput.disabled = autoCheck.checked;
      });

      row.append(yLabel, autoLabel, yMinInput, toSpan, yMaxInput);
      section.appendChild(row);
      body.appendChild(section);

      channelSections.push({ label: ch.label, autoCheck, yMinInput, yMaxInput });
    }

    // --- Spectrum toggle ---
    const specRow = document.createElement('label');
    specRow.style.cssText = 'font-size:12px;display:flex;align-items:center;gap:6px;';
    const specCheck = document.createElement('input');
    specCheck.type = 'checkbox';
    specCheck.checked = fftOn;
    specRow.appendChild(specCheck);
    specRow.appendChild(document.createTextNode('Show Spectrum (FFT)'));
    body.appendChild(specRow);

    // --- Overlay checkboxes ---
    const overlayDiv = document.createElement('div');
    const overlayTitle = document.createElement('div');
    overlayTitle.style.cssText = 'font-size:11px;opacity:0.7;margin-bottom:4px;';
    overlayTitle.textContent = 'Stat Overlays';
    overlayDiv.appendChild(overlayTitle);

    const overlayKinds: Array<{ kind: OverlayKind; label: string }> = [
      { kind: 'min', label: 'Min' },
      { kind: 'max', label: 'Max' },
      { kind: 'mean', label: 'Mean' },
      { kind: 'rms', label: 'RMS' },
    ];
    const overlayChecks = new Map<OverlayKind, HTMLInputElement>();
    for (const ov of overlayKinds) {
      const anyActive = channels.some(ch => ch.overlays.has(ov.kind));
      const lbl = document.createElement('label');
      lbl.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:12px;margin-bottom:2px;';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = anyActive;
      lbl.appendChild(chk);
      lbl.appendChild(document.createTextNode(ov.label));
      overlayDiv.appendChild(lbl);
      overlayChecks.set(ov.kind, chk);
    }
    body.appendChild(overlayDiv);

    // --- Footer ---
    const footer = document.createElement('div');
    footer.className = 'scheme-dialog-footer';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => overlay.remove());

    const okBtn = document.createElement('button');
    okBtn.textContent = 'OK';
    okBtn.className = 'primary';
    okBtn.addEventListener('click', () => {
      // Apply Y-range
      for (const sec of channelSections) {
        if (sec.autoCheck.checked) {
          panel.setAutoYRange(sec.label);
        } else {
          const mn = parseFloat(sec.yMinInput.value);
          const mx = parseFloat(sec.yMaxInput.value);
          if (isFinite(mn) && isFinite(mx) && mn < mx) {
            panel.setYRange(sec.label, mn, mx);
          }
        }
      }
      // Spectrum
      panel.setFftEnabled(specCheck.checked);
      if (specCheck.checked) {
        const descs = panel.getChannelDescriptors();
        if (descs.length > 0) panel.setFftChannel(descs[0].label);
      }
      // Overlays
      for (const [kind, chk] of overlayChecks) {
        const wasActive = channels.some(ch => ch.overlays.has(kind));
        if (chk.checked !== wasActive) {
          for (const ch of channels) panel.toggleOverlay(ch.label, kind);
        }
      }
      panel.render();
      overlay.remove();
    });

    footer.append(cancelBtn, okBtn);

    dialog.append(header, body, footer);
    overlay.appendChild(dialog);

    // Dismiss on backdrop click or Escape
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onEsc); }
    };
    document.addEventListener('keydown', onEsc);

    document.body.appendChild(overlay);
  }

  // -------------------------------------------------------------------------
  // Signal address re-resolution after recompile
  // -------------------------------------------------------------------------

  function resolveWatchedSignalAddresses(unified: { labelSignalMap: ReadonlyMap<string, SignalAddress>; pinSignalMap?: ReadonlyMap<string, SignalAddress> }): void {
    if (viewerPanel?.classList.contains('open') && watchedSignals.length > 0) {
      const resolverCtx = facade.getCoordinator()?.getCurrentResolverContext() ?? null;
      for (const sig of watchedSignals) {
        if (sig.kind === 'current' && sig.elementLabel && resolverCtx) {
          // Re-resolve element index by label after recompile
          for (let i = 0; i < resolverCtx.elements.length; i++) {
            const ce = resolverCtx.elementToCircuitElement.get(i);
            if (ce && _elementLabel(ce) === sig.elementLabel) {
              sig.elementIndex = i;
              // Also refresh the addr anchor from the element's pin nodes
              const pinNodeIds = resolverCtx.elements[i].pinNodeIds ?? [];
              if (pinNodeIds.length > 0) {
                sig.addr = { domain: 'analog', nodeId: pinNodeIds[0]! };
              }
              break;
            }
          }
        } else {
          let addr = unified.labelSignalMap.get(sig.name);
          if (!addr) addr = unified.pinSignalMap?.get(sig.name);
          if (addr !== undefined) {
            sig.addr = addr;
            sig.width = addr.domain === 'digital' ? addr.bitWidth : 1;
          }
        }
      }
      rebuildViewers();
    }
  }

  let tracesHydrated = false;

  function restoreTraces(traces: SavedTrace[] | undefined): void {
    if (tracesHydrated || !traces?.length) return;
    tracesHydrated = true;

    const coordinator = facade.getCoordinator();
    if (!coordinator) return;
    const compiledFull = coordinator.compiled as typeof coordinator.compiled & { pinSignalMap?: ReadonlyMap<string, SignalAddress> };
    const labelSignalMap = compiledFull.labelSignalMap;
    const pinSignalMap = compiledFull.pinSignalMap;

    const resolverCtx = coordinator.getCurrentResolverContext?.() ?? null;

    for (const trace of traces) {
      if (trace.kind === 'current' && trace.elementLabel) {
        // Resolve element index by label
        let elementIndex: number | undefined;
        let addr: SignalAddress = { domain: 'analog', nodeId: 0 };
        if (resolverCtx) {
          for (let i = 0; i < resolverCtx.elements.length; i++) {
            const ce = resolverCtx.elementToCircuitElement.get(i);
            if (ce && _elementLabel(ce) === trace.elementLabel) {
              elementIndex = i;
              const pinNodeIds = resolverCtx.elements[i].pinNodeIds ?? [];
              if (pinNodeIds.length > 0) {
                addr = { domain: 'analog', nodeId: pinNodeIds[0]! };
              }
              break;
            }
          }
        }
        if (elementIndex === undefined) {
          console.warn(`[trace-restore] Current element "${trace.elementLabel}" not found, skipping`);
          continue;
        }
        watchedSignals.push({
          name: trace.name,
          addr,
          width: 1,
          group: trace.group as SignalGroup,
          panelIndex: trace.panelIndex,
          kind: 'current',
          elementLabel: trace.elementLabel,
          elementIndex,
        });
      } else {
        let addr = labelSignalMap.get(trace.name);
        if (!addr) addr = pinSignalMap?.get(trace.name);
        if (!addr) {
          console.warn(`[trace-restore] Signal "${trace.name}" not found, skipping`);
          continue;
        }
        watchedSignals.push({
          name: trace.name,
          addr,
          width: addr.domain === 'digital' ? addr.bitWidth : 1,
          group: trace.group as SignalGroup,
          panelIndex: trace.panelIndex,
        });
      }
    }

    if (watchedSignals.length > 0) {
      rebuildViewers();
    }
  }

  // -------------------------------------------------------------------------
  // Return controller interface
  // -------------------------------------------------------------------------

  return {
    disposeViewers,
    rebuildViewers,
    addWireToViewer,
    removeSignalFromViewer,
    openViewer,
    closeViewer,
    showViewerTab,
    appendWireViewerItems,
    appendComponentTraceItems,
    attachScopeContextMenu,
    get watchedSignals() { return watchedSignals; },
    resolveWatchedSignalAddresses,
    restoreTraces,
  };
}
