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
import { DataTablePanel } from '../runtime/data-table.js';
import type { SignalDescriptor, SignalGroup } from '../runtime/data-table.js';
import type { Wire } from '../core/circuit.js';
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
  attachScopeContextMenu(cvs: HTMLCanvasElement, panel: ScopePanel, signals: WatchedSignal[]): void;
  readonly watchedSignals: WatchedSignal[];
  /** Re-resolve signal addresses after recompilation, then rebuild panels if viewer is open. */
  resolveWatchedSignalAddresses(unified: { labelSignalMap: Map<string, SignalAddress> }): void;
}

// ---------------------------------------------------------------------------
// D5 fix — shared signal name resolution utility
// ---------------------------------------------------------------------------

/**
 * Resolve a human-readable name for a signal address from the labelSignalMap.
 * Falls back to "node<id>" or "net<id>" if no label is found.
 */
export function resolveSignalName(
  labelSignalMap: Map<string, SignalAddress>,
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

  // -------------------------------------------------------------------------
  // Core viewer lifecycle
  // -------------------------------------------------------------------------

  function disposeViewers(): void {
    const coordinator = facade.getCoordinator();
    for (const entry of renderPipeline.state.scopePanels) {
      entry.panel.dispose();
      entry.canvas.remove();
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
      for (const idx of sortedIndices) {
        const signals = panelGroups.get(idx)!;
        const cvs = document.createElement('canvas');
        viewerTimingContainer.appendChild(cvs);
        // Size after DOM insertion so clientWidth/Height are available
        requestAnimationFrame(() => renderPipeline.sizeCanvasInContainer(cvs));
        const panel = new ScopePanel(cvs, coordinator);
        for (const s of signals) {
          if (s.addr.domain === 'analog') {
            panel.addVoltageChannel(s.addr, s.name);
          } else {
            panel.addDigitalChannel(s.addr, s.name);
          }
        }
        attachScopeContextMenu(cvs, panel, signals);
        renderPipeline.state.scopePanels.push({ canvas: cvs, panel });
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
      watchedSignals.push({ name, addr: { domain: 'digital', netId, bitWidth: width }, width, group, panelIndex: idx });
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

      // Per-pin voltage traces — resolve node IDs by pin world position,
      // not by indexing pinNodeIds (which may differ in order from pins,
      // e.g. FET pinNodeIds = [D,G,S] but pins = [G,S,D]).
      for (const pin of pins) {
        const pinLabel = pin.label;
        const wp = pinWorldPosition(element, pin);
        let nodeId: number | undefined;
        for (const [wire, nid] of resolverCtx.wireToNodeId) {
          if (
            (Math.abs(wire.start.x - wp.x) < 0.5 && Math.abs(wire.start.y - wp.y) < 0.5) ||
            (Math.abs(wire.end.x - wp.x) < 0.5 && Math.abs(wire.end.y - wp.y) < 0.5)
          ) {
            nodeId = nid;
            break;
          }
        }
        if (nodeId === undefined) continue;
        items.push({
          label: `Trace Voltage: ${label}.${pinLabel}`,
          action: () => {
            const panelIdx = nextPanelIndex();
            if (renderPipeline.state.scopePanels.length > 0) {
              renderPipeline.state.scopePanels[0].panel.addVoltageChannel(
                { domain: 'analog' as const, nodeId: nodeId! },
                `${label}.${pinLabel}`,
              );
              renderPipeline.state.scopePanels[0].panel.render();
            } else {
              watchedSignals.push({ name: `${label}.${pinLabel}`, addr: { domain: 'analog', nodeId: nodeId! }, width: 1, group: 'probe', panelIndex: panelIdx });
              rebuildViewers();
            }
            viewerPanel?.classList.add('open');
            showViewerTab('timing');
          },
          enabled: true,
        });
      }

      // Element current trace
      items.push({
        label: `Trace Current: ${label}`,
        action: () => {
          if (renderPipeline.state.scopePanels.length > 0) {
            renderPipeline.state.scopePanels[0].panel.addElementCurrentChannel(elementIndex, `${label} I`);
            renderPipeline.state.scopePanels[0].panel.render();
          } else {
            const panelIdx = nextPanelIndex();
            const pinNodeIds = (analogEl as unknown as { pinNodeIds: number[] }).pinNodeIds ?? [];
            if (pinNodeIds.length > 0) {
              watchedSignals.push({ name: `${label}.${pins[0]?.label ?? 'pin0'}`, addr: { domain: 'analog', nodeId: pinNodeIds[0]! }, width: 1, group: 'probe', panelIndex: panelIdx });
              rebuildViewers();
              if (renderPipeline.state.scopePanels.length > 0) {
                renderPipeline.state.scopePanels[0].panel.addElementCurrentChannel(elementIndex, `${label} I`);
              }
            }
          }
          viewerPanel?.classList.add('open');
          showViewerTab('timing');
        },
        enabled: true,
      });
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
    signals: WatchedSignal[],
  ): void {
    cvs.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      contextMenu.hide();

      const items: MenuItem[] = [];
      const channels = panel.getChannelDescriptors();
      const fftOn = panel.isFftEnabled();

      // Toggle FFT / time-domain view
      items.push({
        label: fftOn ? 'Switch to Time Domain' : 'Switch to Spectrum (FFT)',
        action: () => {
          panel.setFftEnabled(!fftOn);
          if (!fftOn && channels.length > 0) {
            panel.setFftChannel(channels[0].label);
          }
          panel.render();
        },
        enabled: true,
      });

      // Stat overlays — toggle for all channels at once
      items.push(separator());
      const overlayOpts: Array<{ kind: import('../runtime/analog-scope-panel.js').OverlayKind; label: string }> = [
        { kind: 'mean', label: 'Mean' },
        { kind: 'max', label: 'Max' },
        { kind: 'min', label: 'Min' },
        { kind: 'rms', label: 'RMS' },
      ];
      for (const ov of overlayOpts) {
        // Check if any channel has this overlay active
        const anyActive = channels.some(ch => ch.overlays.has(ov.kind));
        items.push({
          label: `${anyActive ? '\u2713 ' : ''}Overlay ${ov.label}`,
          action: () => {
            for (const ch of channels) { panel.toggleOverlay(ch.label, ov.kind); }
            panel.render();
          },
          enabled: channels.length > 0,
        });
      }

      // Per-channel Y range
      if (channels.length > 0) {
        items.push(separator());
        for (const ch of channels) {
          items.push({
            label: ch.autoRange ? `${ch.label}: Fix Y Range` : `${ch.label}: Auto Y Range`,
            action: () => {
              if (ch.autoRange) panel.setYRange(ch.label, ch.yMin, ch.yMax);
              else panel.setAutoYRange(ch.label);
              panel.render();
            },
            enabled: true,
          });
        }
      }

      // Add current for elements connected to viewed signals
      const resolverCtx = facade.getCoordinator()?.getCurrentResolverContext() ?? null;
      if (resolverCtx) {
        const currentItems: MenuItem[] = [];
        const seen = new Set<number>();
        for (const sig of signals) {
          for (let idx = 0; idx < resolverCtx.elements.length; idx++) {
            if (seen.has(idx)) continue;
            const analogEl = resolverCtx.elements[idx];
            if (sig.addr.domain !== 'analog' || !analogEl.pinNodeIds.includes(sig.addr.nodeId)) continue;
            seen.add(idx);
            const ce = resolverCtx.elementToCircuitElement.get(idx);
            const elLabel = ce ? _elementLabel(ce) : `element${idx}`;
            const alreadyHas = channels.some(c => (c.kind === 'current' || c.kind === 'elementCurrent') && c.label === `${elLabel} I`);
            if (!alreadyHas) {
              currentItems.push({
                label: `Add Current: ${elLabel}`,
                action: () => { panel.addElementCurrentChannel(idx, `${elLabel} I`); panel.render(); },
                enabled: true,
              });
            }
          }
        }
        if (currentItems.length > 0) {
          items.push(separator());
          items.push(...currentItems);
        }
      }

      // Remove channels
      if (channels.length > 0) {
        items.push(separator());
        for (const ch of channels) {
          items.push({
            label: `Remove "${ch.label}"`,
            action: () => {
              panel.removeChannel(ch.label);
              // Also remove from watchedSignals if it's a voltage channel
              const sig = signals.find(s => s.name === ch.label);
              if (sig) {
                const sigIdx = watchedSignals.indexOf(sig);
                if (sigIdx >= 0) watchedSignals.splice(sigIdx, 1);
                if (watchedSignals.length === 0) closeViewer(); else rebuildViewers();
              }
            },
            enabled: true,
          });
        }
      }

      if (items.length > 0) {
        contextMenu.showItems(e.clientX, e.clientY, items);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Signal address re-resolution after recompile
  // -------------------------------------------------------------------------

  function resolveWatchedSignalAddresses(unified: { labelSignalMap: Map<string, SignalAddress> }): void {
    if (viewerPanel?.classList.contains('open') && watchedSignals.length > 0) {
      for (const sig of watchedSignals) {
        const addr = unified.labelSignalMap.get(sig.name);
        if (addr !== undefined) {
          sig.addr = addr;
          sig.width = addr.domain === 'digital' ? addr.bitWidth : 1;
        }
      }
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
  };
}
