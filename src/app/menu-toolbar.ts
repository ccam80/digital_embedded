/**
 * MenuAndToolbar — menus, toolbar, settings, search, presentation mode.
 *
 * Extracted from app-init.ts (Step 10 of modularization plan).
 * Owns: insert menu, context menu, dark mode, zoom display, lock UI,
 * undo/redo toolbar buttons, view menu items, presentation mode,
 * tablet mode, settings dialog, palette toggle/resize, panel resize,
 * color scheme dialog, search bar.
 */

import type { AppContext } from './app-context.js';
import type { SimulationController } from './simulation-controller.js';
import type { ViewerController } from './viewer-controller.js';
import type { CanvasInteraction } from './canvas-interaction.js';
import type { RenderPipeline } from './render-pipeline.js';
import { AppSettings, SettingKey } from '../editor/settings.js';
import { createModal } from './dialog-manager.js';
import { separator } from '../editor/context-menu.js';
import type { MenuItem } from '../editor/context-menu.js';
import { deleteSelection, rotateSelection, mirrorSelection, copyToClipboard } from '../editor/edit-operations.js';
import { analyzeBoundary, insertAsSubcircuit, type PortOverride } from '../editor/insert-subcircuit.js';
import { openSubcircuitDialog } from './subcircuit-dialog.js';
import { storeSubcircuit } from '../io/subcircuit-store.js';
import { serializeCircuitToDig } from '../io/dig-serializer.js';
import { Circuit, Wire } from '../core/circuit.js';
import { resolveModelAssignments, extractConnectivityGroups, stableNetId } from '../compile/extract-connectivity.js';
import type { PinLoadingOverride } from '../compile/extract-connectivity.js';
import { getActiveModelKey, modelKeyToDomain } from '../core/registry.js';
import { darkColorScheme, lightColorScheme, THEME_COLORS } from '../core/renderer-interface.js';
import { buildColorMap } from '../editor/color-scheme.js';
import { hitTestElements, hitTestWires } from '../editor/hit-test.js';
import { snapToGrid } from '../editor/coordinates.js';
import { LOGIC_FAMILY_PRESETS, getLogicFamilyPreset, defaultLogicFamily } from '../core/logic-family.js';
import { PropertyBag } from '../core/properties.js';
import { deriveInterfacePins } from '../components/subcircuit/pin-derivation.js';
import { openSpiceModelLibraryDialog } from './spice-model-library-dialog.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface MenuToolbarController {
  rebuildInsertMenu(): void;
  updateZoomDisplay(): void;
  openSearchBar(): void;
  togglePresentation(): void;
  exitPresentation(): void;
  isPresentationMode(): boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HIT_THRESHOLD = 0.5;

const INSERT_CATEGORY_LABELS: Record<string, string> = {
  LOGIC: "Logic",
  IO: "I/O",
  FLIP_FLOPS: "Flip-Flops",
  MEMORY: "Memory",
  ARITHMETIC: "Arithmetic",
  WIRING: "Wiring",
  SWITCHING: "Switching",
  PLD: "PLD",
  MISC: "Miscellaneous",
  GRAPHICS: "Graphics",
  TERMINAL: "Terminal",
  "74XX": "74xx",
  PASSIVES: "Passives",
  SEMICONDUCTORS: "Semiconductors",
  SOURCES: "Sources",
  ACTIVE: "Active",
};

const INSERT_ORDER_ANALOG = [
  "PASSIVES", "SEMICONDUCTORS", "SOURCES", "ACTIVE",
  "IO", "WIRING", "LOGIC", "SWITCHING", "FLIP_FLOPS", "MEMORY",
  "ARITHMETIC", "PLD", "MISC", "GRAPHICS", "TERMINAL", "74XX",
];

const MEMORY_TYPES = new Set(['RAM', 'ROM', 'EEPROM', 'RegisterFile']);

// ---------------------------------------------------------------------------
// Shared dependencies type
// ---------------------------------------------------------------------------

interface MTDeps {
  simController: SimulationController;
  viewerController: ViewerController;
  canvasInteraction: CanvasInteraction;
  renderPipeline: RenderPipeline;
  appSettings: AppSettings;
}

// ---------------------------------------------------------------------------
// Builder: Insert menu
// ---------------------------------------------------------------------------

function buildInsertMenu(ctx: AppContext, deps: MTDeps): () => void {
  const { placement } = ctx;
  const { renderPipeline: _rp } = deps; // unused but kept for signature consistency
  const insertMenuDropdown = document.getElementById('insert-menu-dropdown');

  function rebuildInsertMenu(): void {
    if (!insertMenuDropdown) return;
    insertMenuDropdown.innerHTML = '';
    const reg = ctx.palette.getRegistry();
    for (const catKey of INSERT_ORDER_ANALOG) {
      const defs = reg.getByCategory(catKey as any);
      if (defs.length === 0) continue;
      const sub = document.createElement('div');
      sub.className = 'menu-submenu';
      const trigger = document.createElement('div');
      trigger.className = 'menu-action';
      trigger.textContent = INSERT_CATEGORY_LABELS[catKey] ?? catKey;
      sub.appendChild(trigger);

      const subDropdown = document.createElement('div');
      subDropdown.className = 'menu-dropdown';
      for (const def of defs) {
        const item = document.createElement('div');
        item.className = 'menu-action';
        item.textContent = def.name;
        item.addEventListener('click', () => {
          placement.start(def);
          document.querySelectorAll('.menu-item.open').forEach(m => m.classList.remove('open'));
        });
        subDropdown.appendChild(item);
      }
      sub.appendChild(subDropdown);
      insertMenuDropdown.appendChild(sub);
    }
  }

  rebuildInsertMenu();
  return rebuildInsertMenu;
}

// ---------------------------------------------------------------------------
// Builder: Context menu
// ---------------------------------------------------------------------------

function buildContextMenu(ctx: AppContext, deps: MTDeps): void {
  const { simController, viewerController, canvasInteraction, renderPipeline } = deps;
  const {
    canvas, selection, placement, undoStack, lockedModeGuard,
    contextMenu, palette, paletteUI, registry, facade,
  } = ctx;

  function _appendInsertItems(items: MenuItem[]): void {
    const QUICK_INSERT: Array<{ label: string; type: string }> = [
      { label: 'Insert Input', type: 'In' },
      { label: 'Insert Output', type: 'Out' },
      { label: 'Insert AND Gate', type: 'And' },
      { label: 'Insert OR Gate', type: 'Or' },
      { label: 'Insert NOT Gate', type: 'Not' },
      { label: 'Insert NAND Gate', type: 'NAnd' },
      { label: 'Insert Clock', type: 'Clock' },
    ];

    const hasAnalogOnlyComponents = ctx.circuit.elements.some(el => {
      const def = registry.get(el.typeId);
      if (def === undefined) return false;
      try {
        return modelKeyToDomain(getActiveModelKey(el, def), def) === 'mna';
      } catch {
        return false;
      }
    });
    if (hasAnalogOnlyComponents) {
      QUICK_INSERT.length = 0;
      QUICK_INSERT.push(
        { label: 'Insert Resistor', type: 'Resistor' },
        { label: 'Insert Capacitor', type: 'Capacitor' },
        { label: 'Insert Inductor', type: 'Inductor' },
        { label: 'Insert DC Voltage Source', type: 'VoltageSource' },
        { label: 'Insert Ground', type: 'Ground' },
        { label: 'Insert Diode', type: 'Diode' },
      );
    }

    for (const qi of QUICK_INSERT) {
      const def = registry.get(qi.type);
      if (!def) continue;
      items.push({
        label: qi.label,
        action: () => placement.start(def),
        enabled: true,
      });
    }
  }

  canvas.addEventListener('contextmenu', (e: MouseEvent) => {
    e.preventDefault();
    contextMenu.hide();
    document.getElementById('wire-context-menu')?.remove();

    const worldPt = renderPipeline.canvasToWorld(e);
    const locked = lockedModeGuard.isLocked();
    const items: MenuItem[] = [];

    const elementHit = hitTestElements(worldPt, ctx.circuit.elements);
    const wireHit = !elementHit ? hitTestWires(worldPt, ctx.circuit.wires, HIT_THRESHOLD) : null;

    if (elementHit) {
      if (!selection.isSelected(elementHit)) {
        selection.select(elementHit);
      }

      if (!locked) {
        items.push(
          { label: 'Properties\u2026', action: () => { selection.select(elementHit); }, enabled: true },
          { label: 'Rotate', shortcut: 'R', action: () => {
            const cmd = rotateSelection([...selection.getSelectedElements()]);
            undoStack.push(cmd);
            ctx.invalidateCompiled();
          }, enabled: true },
          { label: 'Mirror', shortcut: 'M', action: () => {
            const cmd = mirrorSelection([...selection.getSelectedElements()]);
            undoStack.push(cmd);
            ctx.invalidateCompiled();
          }, enabled: true },
          separator(),
          { label: 'Copy', shortcut: 'Ctrl+C', action: () => {
            ctx.clipboard = copyToClipboard(
              [...selection.getSelectedElements()],
              [...selection.getSelectedWires()],
              (typeId: string) => registry.get(typeId),
            );
          }, enabled: true },
          { label: 'Delete', shortcut: 'Del', action: () => {
            const elements = [...selection.getSelectedElements()];
            const wires: Wire[] = [...selection.getSelectedWires()];
            const cmd = deleteSelection(ctx.circuit, elements, wires);
            undoStack.push(cmd);
            selection.clear();
          }, enabled: true },
          separator(),
          {
            label: 'Make Subcircuit\u2026',
            enabled: selection.getSelectedElements().size >= 2 && !ctx.isSimActive(),
            action: () => {
              const selectedElements = [...selection.getSelectedElements()];
              const selectedWires = [...selection.getSelectedWires()];
              const { boundaryPorts } = analyzeBoundary(ctx.circuit, selectedElements, selectedWires);
              void openSubcircuitDialog(boundaryPorts, registry, selectedElements).then((result) => {
                if (!result) return;
                const userPorts: PortOverride[] = result.ports.map(p => ({
                  label: p.label,
                  bitWidth: p.bitWidth,
                  face: p.face,
                }));
                const { subcircuit, command, instance } = insertAsSubcircuit(
                  ctx.circuit,
                  selectedElements,
                  selectedWires,
                  registry,
                  result.name,
                  userPorts,
                );

                // Apply shape mode and chip dimensions from the dialog
                subcircuit.metadata.shapeType = result.shapeMode;
                subcircuit.metadata.chipWidth = result.chipWidth;
                subcircuit.metadata.chipHeight = result.chipHeight;
                (instance.definition as any).shapeMode = result.shapeMode;
                instance.getProperties().set('shapeType', result.shapeMode);

                undoStack.push(command);
                selection.clear();
                ctx.invalidateCompiled();

                // Persist the extracted subcircuit to IndexedDB.
                const xml = serializeCircuitToDig(subcircuit, registry);
                void storeSubcircuit(result.name, xml).catch((err: unknown) => {
                  console.error('Failed to persist subcircuit:', err);
                  ctx.showStatus(`ERROR: Failed to save subcircuit "${result.name}" — it will be lost on reload`);
                });

                // Update the palette so the new subcircuit appears immediately.
                palette.refreshCategories();
                paletteUI.render();

                const portCount = result.ports.length;
                ctx.showStatus(`Created subcircuit "${result.name}" (${portCount} port${portCount !== 1 ? 's' : ''})`);
              });
            },
          },
        );

        // "Edit Symbol..." and "Open Subcircuit" — for SubcircuitElement instances
        if ('definition' in elementHit && (elementHit as any).definition?.circuit) {
          const subDef = (elementHit as any).definition as { name: string; circuit: Circuit; pinLayout: any[] };
          items.push(separator());
          items.push({
            label: 'Open Subcircuit',
            action: () => {
              canvasInteraction.openSubcircuit(subDef.name, subDef.circuit);
            },
            enabled: true,
          });
          items.push({
            label: 'Edit Symbol\u2026',
            action: () => {
              // Collect existing Port elements from the subcircuit definition
              const portElements = [];
              for (const el of subDef.circuit.elements) {
                if (el.typeId === 'Port') portElements.push(el);
              }
              void openSubcircuitDialog([], registry, portElements, subDef.name).then((result) => {
                if (!result) return;
                // Update Port elements in the subcircuit definition to match dialog edits
                const existingPorts = subDef.circuit.elements.filter(el => el.typeId === 'Port');
                for (let i = 0; i < result.ports.length; i++) {
                  const rp = result.ports[i];
                  if (i < existingPorts.length) {
                    const el = existingPorts[i];
                    el.getProperties().set('label', rp.label);
                    el.getProperties().set('bitWidth', rp.bitWidth);
                    el.getProperties().set('face', rp.face);
                  }
                }
                // Re-derive pin layout and update the definition
                (subDef as any).pinLayout = deriveInterfacePins(subDef.circuit);

                // Re-persist
                const xml = serializeCircuitToDig(subDef.circuit, registry);
                void storeSubcircuit(subDef.name, xml).catch(() => {});

                ctx.invalidateCompiled();
                ctx.scheduleRender();
                ctx.showStatus(`Updated symbol for "${subDef.name}"`);
              });
            },
            enabled: !ctx.isSimActive(),
          });
        }

        // "Add Slider" — for components with FLOAT properties during analog sim
        if (simController.activeSliderPanel && simController.isSimActive()) {
          const sliderCoord = facade.getCoordinator();
          if (sliderCoord) {
            const sliderProps = sliderCoord.getSliderProperties(elementHit);
            if (sliderProps.length > 0) {
              items.push(separator());
              for (const sp of sliderProps) {
                items.push({
                  label: `Add Slider: ${sp.label}`,
                  action: () => {
                    simController.activeSliderPanel!.addSlider(sp.elementIndex, sp.key, sp.label, sp.currentValue, { unit: sp.unit, logScale: sp.logScale });
                  },
                  enabled: true,
                });
              }
            }
          }
        }
      }

      // Memory components: "Edit Memory…"
      if (MEMORY_TYPES.has(elementHit.typeId)) {
        if (items.length > 0) items.push(separator());
        items.push({
          label: 'Edit Memory\u2026',
          action: () => void canvasInteraction.openMemoryEditor(elementHit),
          enabled: true,
        });
      }

      // "Add to Traces"
      if (facade.getCoordinator()?.supportsAcSweep() ?? ctx.circuit.elements.some(el => {
        const def = registry.get(el.typeId);
        if (def === undefined) return false;
        try {
          return modelKeyToDomain(getActiveModelKey(el, def), def) === 'mna';
        } catch {
          return false;
        }
      })) {
        const resolverCtx = facade.getCoordinator()?.getCurrentResolverContext() ?? null;
        viewerController.appendComponentTraceItems(items, elementHit, resolverCtx);
      }

    } else if (wireHit) {
      if (!locked) {
        items.push(
          { label: 'Delete Wire', shortcut: 'Del', action: () => {
            selection.select(wireHit);
            const cmd = deleteSelection(ctx.circuit, [...selection.getSelectedElements()], [...selection.getSelectedWires()]);
            undoStack.push(cmd);
            selection.clear();
          }, enabled: true },
        );

        // "Remove Junction" — merge collinear wire pairs at a junction point
        // so that crossing wires pass through without connecting.
        const snappedPt = snapToGrid(worldPt, 1);
        const jKey = `${snappedPt.x},${snappedPt.y}`;
        let junctionCount = 0;
        for (const w of ctx.circuit.wires) {
          if (`${w.start.x},${w.start.y}` === jKey) junctionCount++;
          if (`${w.end.x},${w.end.y}` === jKey) junctionCount++;
        }
        if (junctionCount >= 3) {
          items.push({
            label: 'Remove Junction', action: () => {
              const wiresAtJunction = ctx.circuit.wires.filter(w =>
                `${w.start.x},${w.start.y}` === jKey ||
                `${w.end.x},${w.end.y}` === jKey,
              );
              const horizontal: Wire[] = [];
              const vertical: Wire[] = [];
              for (const w of wiresAtJunction) {
                const other = `${w.start.x},${w.start.y}` === jKey ? w.end : w.start;
                if (other.y === snappedPt.y && other.x !== snappedPt.x) horizontal.push(w);
                else if (other.x === snappedPt.x && other.y !== snappedPt.y) vertical.push(w);
              }
              const removedWires: Wire[] = [];
              const addedWires: Wire[] = [];
              const mergeGroup = (group: Wire[]): void => {
                if (group.length !== 2) return;
                const [w1, w2] = group as [Wire, Wire];
                const end1 = `${w1.start.x},${w1.start.y}` === jKey ? w1.end : w1.start;
                const end2 = `${w2.start.x},${w2.start.y}` === jKey ? w2.end : w2.start;
                removedWires.push(w1, w2);
                addedWires.push(new Wire(end1, end2, Math.max(w1.bitWidth, w2.bitWidth)));
              };
              mergeGroup(horizontal);
              mergeGroup(vertical);
              if (removedWires.length === 0) return;
              const cmd = {
                description: 'Remove Junction',
                execute() {
                  for (const w of removedWires) ctx.circuit.removeWire(w);
                  for (const w of addedWires) ctx.circuit.addWire(w);
                },
                undo() {
                  for (const w of addedWires) ctx.circuit.removeWire(w);
                  for (const w of removedWires) ctx.circuit.addWire(w);
                },
              };
              undoStack.push(cmd);
              ctx.invalidateCompiled();
            }, enabled: true,
          });
        }
      }

      if (!locked) {
        const [modelAssignments] = resolveModelAssignments(ctx.circuit.elements, registry);
        const [groups] = extractConnectivityGroups(
          ctx.circuit.elements,
          ctx.circuit.wires,
          registry,
          modelAssignments,
        );

        const hitGroup = groups.find(g => g.wires.includes(wireHit));
        if (hitGroup !== undefined) {
          const netId = stableNetId(hitGroup, ctx.circuit.elements);
          const anchor = stableNetIdToAnchor(netId);
          const currentOverrides = ctx.circuit.metadata.digitalPinLoadingOverrides ?? [];
          const existing = currentOverrides.find(o => {
            if (o.anchor.type !== anchor.type) return false;
            if (o.anchor.type === 'label' && anchor.type === 'label') return o.anchor.label === anchor.label;
            if (o.anchor.type === 'pin' && anchor.type === 'pin') {
              return o.anchor.instanceId === anchor.instanceId && o.anchor.pinLabel === anchor.pinLabel;
            }
            return false;
          });
          const currentMode: 'loaded' | 'ideal' | 'default' = existing?.loading ?? 'default';

          const makeOverrideCmd = (newMode: 'loaded' | 'ideal' | 'default') => {
            const prevOverrides = [...currentOverrides];
            const nextOverrides = newMode === 'default'
              ? prevOverrides.filter(o => {
                if (o.anchor.type !== anchor.type) return true;
                if (o.anchor.type === 'label' && anchor.type === 'label') return o.anchor.label !== anchor.label;
                if (o.anchor.type === 'pin' && anchor.type === 'pin') {
                  return !(o.anchor.instanceId === anchor.instanceId && o.anchor.pinLabel === anchor.pinLabel);
                }
                return true;
              })
              : [
                ...prevOverrides.filter(o => {
                  if (o.anchor.type !== anchor.type) return true;
                  if (o.anchor.type === 'label' && anchor.type === 'label') return o.anchor.label !== anchor.label;
                  if (o.anchor.type === 'pin' && anchor.type === 'pin') {
                    return !(o.anchor.instanceId === anchor.instanceId && o.anchor.pinLabel === anchor.pinLabel);
                  }
                  return true;
                }),
                { anchor, loading: newMode as 'loaded' | 'ideal' },
              ];
            return {
              description: `Set wire pin loading to ${newMode}`,
              execute() {
                if (nextOverrides.length > 0) {
                  ctx.circuit.metadata.digitalPinLoadingOverrides = nextOverrides;
                } else {
                  delete ctx.circuit.metadata.digitalPinLoadingOverrides;
                }
                refreshOverrideIndicators(ctx);
                simController.invalidateCompiled();
                ctx.scheduleRender();
              },
              undo() {
                if (prevOverrides.length > 0) {
                  ctx.circuit.metadata.digitalPinLoadingOverrides = prevOverrides;
                } else {
                  delete ctx.circuit.metadata.digitalPinLoadingOverrides;
                }
                refreshOverrideIndicators(ctx);
                simController.invalidateCompiled();
                ctx.scheduleRender();
              },
            };
          };

          if (items.length > 0) items.push(separator());
          items.push(
            { label: `${currentMode === 'loaded' ? '\u2713 ' : ''}Pin Loading: Loaded`, action: () => {
              if (currentMode !== 'loaded') undoStack.push(makeOverrideCmd('loaded'));
            }, enabled: true },
            { label: `${currentMode === 'ideal' ? '\u2713 ' : ''}Pin Loading: Ideal`, action: () => {
              if (currentMode !== 'ideal') undoStack.push(makeOverrideCmd('ideal'));
            }, enabled: true },
            { label: `${currentMode === 'default' ? '\u2713 ' : ''}Pin Loading: Default`, action: () => {
              if (currentMode !== 'default') undoStack.push(makeOverrideCmd('default'));
            }, enabled: true },
          );
        }
      }

      if (ctx.isSimActive()) {
        const viewCoordinator = facade.getCoordinator();
        if (viewCoordinator) {
          if (items.length > 0) items.push(separator());
          viewerController.appendWireViewerItems(items, wireHit, viewCoordinator);
        }
      }

    } else {
      // Canvas (empty area)
      if (!locked) {
        _appendInsertItems(items);
        items.push(separator());
        items.push(
          { label: 'Paste', shortcut: 'Ctrl+V', action: () => {
            if (ctx.clipboard.entries.length > 0 || ctx.clipboard.wires.length > 0) {
              placement.startPaste(ctx.clipboard);
            }
          }, enabled: ctx.clipboard.entries.length > 0 || ctx.clipboard.wires.length > 0 },
          { label: 'Select All', shortcut: 'Ctrl+A', action: () => {
            selection.selectAll(ctx.circuit);
          }, enabled: true },
        );
      }

      items.push(separator());
      if (!ctx.isSimActive()) {
        items.push({
          label: 'Start Simulation',
          action: () => document.getElementById('btn-run')?.click(),
          enabled: true,
        });
      } else {
        items.push({
          label: 'Stop Simulation',
          action: () => document.getElementById('btn-stop')?.click(),
          enabled: true,
        });
      }

      items.push(
        { label: 'Speed \u00d710', action: () => {
          facade.getCoordinator()?.adjustSpeed(10);
          simController.updateSpeedDisplay();
        }, enabled: true },
        { label: 'Speed \u00f710', action: () => {
          facade.getCoordinator()?.adjustSpeed(0.1);
          simController.updateSpeedDisplay();
        }, enabled: true },
      );
    }

    if (items.length > 0) {
      contextMenu.showItems(e.clientX, e.clientY, items);
    }
  });
}

// ---------------------------------------------------------------------------
// Builder: Selection onChange — populate analog sliders
// ---------------------------------------------------------------------------

function buildSelectionSliderSync(ctx: AppContext, deps: MTDeps): void {
  const { simController } = deps;
  const { selection, facade } = ctx;

  selection.onChange(() => {
    const selected = selection.getSelectedElements();
    const sliderPanel = simController?.activeSliderPanel;
    if (sliderPanel) {
      sliderPanel.removeUnpinned();
      if (selected.size === 1) {
        const element = selected.values().next().value!;
        const sliderCoordinator = facade.getCoordinator();
        const sliderProps = sliderCoordinator.getSliderProperties(element);
        for (const sp of sliderProps) {
          sliderPanel.addSlider(
            sp.elementIndex,
            sp.key,
            sp.label,
            sp.currentValue,
            { unit: sp.unit, logScale: sp.logScale },
          );
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Builder: Palette setup
// ---------------------------------------------------------------------------

function buildPaletteHandlers(ctx: AppContext, deps: MTDeps): void {
  const { renderPipeline } = deps;
  const { canvas, viewport, paletteUI, placement } = ctx;

  paletteUI.onPlace(async (def) => {
    let activeDef = def;
    if ((def.factory as { __74xxStub?: boolean }).__74xxStub === true) {
      try {
        paletteUI.setLoading(def.name, true);
        const { load74xxComponent } = await import('../components/library-74xx.js');
        activeDef = await load74xxComponent(ctx.registry, def.name);
      } catch (err) {
        console.error(`Failed to load 74xx component "${def.name}":`, err);
        return;
      } finally {
        paletteUI.setLoading(def.name, false);
      }
    }
    placement.start(activeDef);
  });
  paletteUI.onTouchDrop(async (def, worldPt) => {
    let activeDef = def;
    if ((def.factory as { __74xxStub?: boolean }).__74xxStub === true) {
      try {
        paletteUI.setLoading(def.name, true);
        const { load74xxComponent } = await import('../components/library-74xx.js');
        activeDef = await load74xxComponent(ctx.registry, def.name);
      } catch (err) {
        console.error(`Failed to load 74xx component "${def.name}":`, err);
        return;
      } finally {
        paletteUI.setLoading(def.name, false);
      }
    }
    const element = activeDef.factory(new PropertyBag());
    element.position = worldPt;
    ctx.circuit.addElement(element);
    ctx.invalidateCompiled();
    renderPipeline.scheduleRender();
  });
  paletteUI.render();
  paletteUI.setCanvas(canvas, viewport);
}

// ---------------------------------------------------------------------------
// Builder: Dark mode toggle
// ---------------------------------------------------------------------------

function buildDarkModeToggle(ctx: AppContext, deps: MTDeps): void {
  const { appSettings, renderPipeline } = deps;
  const { colorSchemeManager, paletteUI } = ctx;

  const darkModeBtn = document.getElementById('btn-dark-mode');

  function updateDarkModeIcon(): void {
    if (!darkModeBtn) return;
    const isLight = document.documentElement.classList.contains('light');
    darkModeBtn.textContent = isLight ? '\u2600' : '\u263D';
  }

  updateDarkModeIcon();

  darkModeBtn?.addEventListener('click', () => {
    const currentScheme = appSettings.get(SettingKey.COLOR_SCHEME);
    const goingLight = currentScheme === 'default' || currentScheme === 'dark';
    const newScheme = goingLight ? 'light' : 'default';
    appSettings.set(SettingKey.COLOR_SCHEME, newScheme);
    appSettings.save();
    applyColorScheme(!goingLight);
    colorSchemeManager.setActive(goingLight ? 'light' : 'default');
    updateDarkModeIcon();
    paletteUI.setColorScheme(goingLight ? lightColorScheme : darkColorScheme);
    renderPipeline.scheduleRender();
  });
}

// ---------------------------------------------------------------------------
// Builder: Zoom display + controls
// ---------------------------------------------------------------------------

function buildZoomControls(ctx: AppContext, deps: MTDeps): () => void {
  const { renderPipeline } = deps;
  const { viewport } = ctx;

  const zoomPctBtn = document.getElementById('btn-zoom-pct');
  const zoomDropdown = document.getElementById('zoom-dropdown');

  function updateZoomDisplay(): void {
    if (zoomPctBtn) {
      zoomPctBtn.textContent = Math.round(viewport.zoom * 100) + '%';
    }
  }

  updateZoomDisplay();

  zoomPctBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    zoomDropdown?.classList.toggle('open');
  });

  document.addEventListener('click', (e) => {
    if (!(e.target as Element)?.closest('.zoom-dropdown-container')) {
      zoomDropdown?.classList.remove('open');
    }
  });

  document.querySelectorAll('.zoom-preset').forEach((preset) => {
    preset.addEventListener('click', () => {
      const val = (preset as HTMLElement).dataset['zoom'];
      if (val === 'fit') {
        ctx.fitViewport();
      } else if (val !== undefined) {
        viewport.setZoom(parseFloat(val));
      }
      updateZoomDisplay();
      renderPipeline.scheduleRender();
      zoomDropdown?.classList.remove('open');
    });
  });

  document.getElementById('btn-fit-content')?.addEventListener('click', () => {
    ctx.fitViewport();
    updateZoomDisplay();
    renderPipeline.scheduleRender();
  });

  document.getElementById('btn-tb-fit')?.addEventListener('click', () => {
    ctx.fitViewport();
    updateZoomDisplay();
    renderPipeline.scheduleRender();
  });

  return updateZoomDisplay;
}

// ---------------------------------------------------------------------------
// Builder: Lock toggle
// ---------------------------------------------------------------------------

function buildLockToggle(ctx: AppContext, _deps: MTDeps): void {
  const { lockedModeGuard } = ctx;

  const lockBanner = document.getElementById('lock-banner');
  const lockCheck = document.getElementById('lock-check');

  function updateLockUI(): void {
    const locked = lockedModeGuard.isLocked();
    if (lockCheck) {
      lockCheck.textContent = locked ? '\u2713' : '';
    }
    if (lockBanner) {
      lockBanner.classList.toggle('visible', locked);
    }
  }

  updateLockUI();

  document.getElementById('btn-menu-lock')?.addEventListener('click', () => {
    lockedModeGuard.setLocked(!lockedModeGuard.isLocked());
    updateLockUI();
  });
}

// ---------------------------------------------------------------------------
// Builder: Undo/Redo toolbar buttons
// ---------------------------------------------------------------------------

function buildUndoRedoButtons(ctx: AppContext, _deps: MTDeps): void {
  const { undoStack } = ctx;

  const tbUndoBtn = document.getElementById('btn-tb-undo') as HTMLButtonElement | null;
  const tbRedoBtn = document.getElementById('btn-tb-redo') as HTMLButtonElement | null;

  function updateUndoRedoButtons(): void {
    if (tbUndoBtn) tbUndoBtn.disabled = !undoStack.canUndo();
    if (tbRedoBtn) tbRedoBtn.disabled = !undoStack.canRedo();
  }

  updateUndoRedoButtons();

  const _prevAfterMutate = undoStack.afterMutate;
  undoStack.afterMutate = () => {
    _prevAfterMutate?.();
    updateUndoRedoButtons();
  };

  tbUndoBtn?.addEventListener('click', () => {
    undoStack.undo();
    ctx.invalidateCompiled();
    updateUndoRedoButtons();
  });

  tbRedoBtn?.addEventListener('click', () => {
    undoStack.redo();
    ctx.invalidateCompiled();
    updateUndoRedoButtons();
  });
}

// ---------------------------------------------------------------------------
// Builder: View menu items
// ---------------------------------------------------------------------------

function buildViewMenuItems(ctx: AppContext, deps: MTDeps): void {
  const { renderPipeline } = deps;
  const { colorSchemeManager } = ctx;

  const darkModeBtn = document.getElementById('btn-dark-mode');

  document.getElementById('btn-menu-dark-mode')?.addEventListener('click', () => {
    darkModeBtn?.click();
    const isLight = document.documentElement.classList.contains('light');
    const check = document.getElementById('dark-mode-check');
    if (check) check.textContent = isLight ? '' : '✓';
  });

  let gateStyleIec = false;
  document.getElementById('btn-menu-gate-style')?.addEventListener('click', () => {
    gateStyleIec = !gateStyleIec;
    colorSchemeManager.setGateShapeStyle(gateStyleIec ? 'iec' : 'ieee');
    const check = document.getElementById('gate-style-check');
    if (check) check.textContent = gateStyleIec ? '✓' : '';
    renderPipeline.scheduleRender();
  });

  document.getElementById('btn-color-scheme')?.addEventListener('click', () => {
    openColorSchemeDialog(ctx, deps);
  });
}

// ---------------------------------------------------------------------------
// Builder: Color scheme dialog
// ---------------------------------------------------------------------------

function openColorSchemeDialog(ctx: AppContext, deps: MTDeps): void {
  const { renderPipeline } = deps;
  const { colorSchemeManager } = ctx;

  const customColors: Partial<Record<string, string>> = {};

  const { overlay, dialog, body } = createModal({
    title: 'Color Scheme',
    className: 'scheme-dialog',
    overlayClassName: 'scheme-dialog-overlay',
  });

  const selectRow = document.createElement('div');
  selectRow.className = 'scheme-select-row';
  const selectLabel = document.createElement('label');
  selectLabel.textContent = 'Active scheme:';
  const schemeSelect = document.createElement('select');
  colorSchemeManager.getSchemeNames().forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (name === colorSchemeManager.getActiveName()) opt.selected = true;
    schemeSelect.appendChild(opt);
  });
  schemeSelect.addEventListener('change', () => {
    colorSchemeManager.setActive(schemeSelect.value);
    updateColorGrid();
    renderPipeline.scheduleRender();
  });
  selectRow.appendChild(selectLabel);
  selectRow.appendChild(schemeSelect);
  body.appendChild(selectRow);

  const colorGrid = document.createElement('div');
  colorGrid.className = 'color-grid';

  ['Color', 'Preview', 'Custom'].forEach(h => {
    const hdr = document.createElement('div');
    hdr.className = 'color-grid-header';
    hdr.textContent = h;
    colorGrid.appendChild(hdr);
  });

  const pickerMap = new Map<string, { swatch: HTMLDivElement; picker: HTMLInputElement }>();

  function updateColorGrid(): void {
    const activeScheme = colorSchemeManager.getActive();
    for (const color of THEME_COLORS) {
      const entry = pickerMap.get(color);
      if (entry) {
        const resolved = (customColors[color] as string | undefined) ?? activeScheme.resolve(color);
        entry.swatch.style.background = resolved;
        entry.picker.value = /^#[0-9a-fA-F]{6}$/.test(resolved) ? resolved : '#888888';
      }
    }
  }

  for (const color of THEME_COLORS) {
    const nameEl = document.createElement('div');
    nameEl.className = 'color-name';
    nameEl.textContent = color;

    const swatch = document.createElement('div');
    swatch.className = 'color-swatch';

    const picker = document.createElement('input');
    picker.type = 'color';
    picker.className = 'color-picker-input';
    picker.title = 'Override ' + color;
    picker.addEventListener('input', () => {
      customColors[color] = picker.value;
      swatch.style.background = picker.value;
    });

    pickerMap.set(color, { swatch, picker });
    colorGrid.appendChild(nameEl);
    colorGrid.appendChild(swatch);
    colorGrid.appendChild(picker);
  }

  body.appendChild(colorGrid);
  dialog.appendChild(body);
  updateColorGrid();

  const footer = document.createElement('div');
  footer.className = 'scheme-dialog-footer';

  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset to Default';
  resetBtn.addEventListener('click', () => {
    for (const k of Object.keys(customColors)) delete customColors[k];
    colorSchemeManager.setActive('default');
    schemeSelect.value = 'default';
    updateColorGrid();
    renderPipeline.scheduleRender();
  });

  const saveBtn = document.createElement('button');
  saveBtn.className = 'primary';
  saveBtn.textContent = 'Save Custom...';
  saveBtn.addEventListener('click', () => {
    const name = prompt('Custom scheme name:', 'my-scheme');
    if (!name || !name.trim()) return;
    const baseScheme = colorSchemeManager.getActive();
    const fullMap = buildColorMap(baseScheme, customColors as Partial<Record<import('../core/renderer-interface.js').ThemeColor, string>>);
    colorSchemeManager.createCustomScheme(name.trim(), fullMap);
    colorSchemeManager.setActive(name.trim());
    const opt = document.createElement('option');
    opt.value = name.trim();
    opt.textContent = name.trim();
    opt.selected = true;
    schemeSelect.appendChild(opt);
    renderPipeline.scheduleRender();
  });

  footer.appendChild(resetBtn);
  footer.appendChild(saveBtn);
  dialog.appendChild(footer);

  document.body.appendChild(overlay);
}

// ---------------------------------------------------------------------------
// Builder: Presentation mode
// ---------------------------------------------------------------------------

interface PresentationControls {
  togglePresentation(): void;
  exitPresentation(): void;
  isPresentationMode(): boolean;
}

function buildPresentationMode(_ctx: AppContext, deps: MTDeps): PresentationControls {
  const { renderPipeline } = deps;

  const appEl = document.getElementById('app');
  const exitPresentationBtn = document.getElementById('btn-exit-presentation');

  let presentationMode = false;

  function enterPresentation(): void {
    presentationMode = true;
    appEl?.classList.add('presentation-mode');
    renderPipeline.scheduleRender();
  }

  function exitPresentation(): void {
    presentationMode = false;
    appEl?.classList.remove('presentation-mode');
    renderPipeline.scheduleRender();
  }

  function togglePresentation(): void {
    if (presentationMode) {
      exitPresentation();
    } else {
      enterPresentation();
    }
  }

  document.getElementById('btn-presentation-mode')?.addEventListener('click', togglePresentation);
  exitPresentationBtn?.addEventListener('click', exitPresentation);

  return {
    togglePresentation,
    exitPresentation,
    isPresentationMode(): boolean { return presentationMode; },
  };
}

// ---------------------------------------------------------------------------
// Builder: Tablet mode
// ---------------------------------------------------------------------------

function buildTabletMode(_ctx: AppContext, deps: MTDeps): void {
  const { renderPipeline } = deps;

  const appEl = document.getElementById('app');
  let tabletMode = false;
  const tabletModeCheck = document.getElementById('tablet-mode-check');

  function updateTabletModeUI(): void {
    if (tabletModeCheck) tabletModeCheck.textContent = tabletMode ? '\u2713' : '';
    appEl?.classList.toggle('tablet-mode', tabletMode);
    renderPipeline.resizeCanvas();
  }

  document.getElementById('btn-tablet-mode')?.addEventListener('click', () => {
    tabletMode = !tabletMode;
    updateTabletModeUI();
  });
}

// ---------------------------------------------------------------------------
// Builder: Settings dialog
// ---------------------------------------------------------------------------

function buildSettingsDialog(ctx: AppContext, deps: MTDeps): void {
  const { simController } = deps;
  const { facade } = ctx;

  const settingsOverlay = document.getElementById('settings-overlay');
  const snapshotBudgetInput = document.getElementById('setting-snapshot-budget') as HTMLInputElement | null;
  const oscillationLimitInput = document.getElementById('setting-oscillation-limit') as HTMLInputElement | null;
  const currentSpeedInput = document.getElementById('setting-current-speed') as HTMLInputElement | null;
  const currentScaleSelect = document.getElementById('setting-current-scale') as HTMLSelectElement | null;
  const logicFamilySelect = document.getElementById('setting-logic-family') as HTMLSelectElement | null;
  const logicFamilyDetails = document.getElementById('logic-family-details') as HTMLElement | null;

  function updateLogicFamilyDetails(key: string): void {
    if (!logicFamilyDetails) return;
    const preset = getLogicFamilyPreset(key);
    if (!preset) { logicFamilyDetails.textContent = ''; return; }
    logicFamilyDetails.innerHTML =
      `<span>V<sub>OH</sub>: ${preset.vOH}V</span><span>V<sub>OL</sub>: ${preset.vOL}V</span>` +
      `<span>V<sub>IH</sub>: ${preset.vIH}V</span><span>V<sub>IL</sub>: ${preset.vIL}V</span>` +
      `<span>R<sub>out</sub>: ${preset.rOut}Ω</span><span>R<sub>in</sub>: ${(preset.rIn / 1e6).toFixed(0)}MΩ</span>`;
  }

  logicFamilySelect?.addEventListener('change', () => {
    updateLogicFamilyDetails(logicFamilySelect.value);
  });

  function openSettingsDialog(): void {
    const s = simController.loadEngineSettings();
    if (snapshotBudgetInput) snapshotBudgetInput.value = String(s.snapshotBudgetMb);
    if (oscillationLimitInput) oscillationLimitInput.value = String(s.oscillationLimit);
    if (currentSpeedInput) currentSpeedInput.value = String(s.currentSpeedScale);
    if (currentScaleSelect) currentScaleSelect.value = s.currentScaleMode;
    if (logicFamilySelect) {
      const family = ctx.circuit.metadata.logicFamily ?? defaultLogicFamily();
      const matchKey = Object.entries(LOGIC_FAMILY_PRESETS).find(
        ([, v]) => v.name === family.name,
      )?.[0] ?? 'cmos-3v3';
      logicFamilySelect.value = matchKey;
      updateLogicFamilyDetails(matchKey);
    }
    if (settingsOverlay) settingsOverlay.style.display = 'flex';
  }

  function closeSettingsDialog(): void {
    if (settingsOverlay) settingsOverlay.style.display = 'none';
  }

  document.getElementById('btn-settings')?.addEventListener('click', openSettingsDialog);
  document.getElementById('btn-menu-settings')?.addEventListener('click', openSettingsDialog);
  document.getElementById('btn-settings-close')?.addEventListener('click', closeSettingsDialog);
  document.getElementById('btn-settings-cancel')?.addEventListener('click', closeSettingsDialog);

  document.getElementById('btn-settings-save')?.addEventListener('click', () => {
    const budgetMb = Math.max(1, Math.min(256, parseInt(snapshotBudgetInput?.value ?? '64', 10) || 64));
    const oscLimit = Math.max(100, Math.min(100000, parseInt(oscillationLimitInput?.value ?? '1000', 10) || 1000));
    const speedScale = Math.max(0.1, Math.min(100000, parseFloat(currentSpeedInput?.value ?? '200') || 200));
    const scaleMode = (currentScaleSelect?.value === 'logarithmic' ? 'logarithmic' : 'linear') as 'linear' | 'logarithmic';
    const newSettings = { snapshotBudgetMb: budgetMb, oscillationLimit: oscLimit, currentSpeedScale: speedScale, currentScaleMode: scaleMode };
    simController.saveEngineSettings(newSettings);
    (facade.getCoordinator() as unknown as { setSnapshotBudget?(n: number): void } | null)?.setSnapshotBudget?.(budgetMb * 1024 * 1024);
    simController.applyCurrentVizSettings(newSettings);
    if (logicFamilySelect) {
      const preset = getLogicFamilyPreset(logicFamilySelect.value);
      if (preset) {
        const prev = ctx.circuit.metadata.logicFamily;
        const changed = !prev || prev.name !== preset.name;
        ctx.circuit.metadata.logicFamily = preset;
        if (changed) simController.invalidateCompiled();
      }
    }
    closeSettingsDialog();
    ctx.showStatus('Settings saved.');
  });

  settingsOverlay?.addEventListener('click', (e) => {
    if (e.target === settingsOverlay) closeSettingsDialog();
  });
}

// ---------------------------------------------------------------------------
// Builder: Menu undo/redo/delete/select-all
// ---------------------------------------------------------------------------

function buildMenuEditActions(ctx: AppContext, deps: MTDeps): void {
  const { renderPipeline } = deps;
  const { undoStack, selection } = ctx;

  document.getElementById('btn-undo')?.addEventListener('click', () => {
    undoStack.undo();
    ctx.invalidateCompiled();
  });

  document.getElementById('btn-redo')?.addEventListener('click', () => {
    undoStack.redo();
    ctx.invalidateCompiled();
  });

  document.getElementById('btn-delete')?.addEventListener('click', () => {
    if (!selection.isEmpty()) {
      const elements = [...selection.getSelectedElements()];
      const wires: Wire[] = [...selection.getSelectedWires()];
      const cmd = deleteSelection(ctx.circuit, elements, wires);
      undoStack.push(cmd);
      selection.clear();
      ctx.invalidateCompiled();
    }
  });

  document.getElementById('btn-select-all')?.addEventListener('click', () => {
    selection.selectAll(ctx.circuit);
    renderPipeline.scheduleRender();
  });
}

// ---------------------------------------------------------------------------
// Builder: Search bar
// ---------------------------------------------------------------------------

function buildSearchBar(ctx: AppContext, deps: MTDeps): () => void {
  const { renderPipeline } = deps;
  const { viewport, selection } = ctx;

  const searchBar = document.getElementById('search-bar');
  const searchInput = document.getElementById('search-input') as HTMLInputElement | null;
  const searchCount = document.getElementById('search-count');
  const searchPrev = document.getElementById('search-prev');
  const searchNext = document.getElementById('search-next');
  const searchCloseBtn = document.getElementById('search-close');

  type SearchResult = import('../editor/search.js').SearchResult;
  let searchResults: SearchResult[] = [];
  let searchCursor = -1;
  let searchDebounceTimer = -1;
  let circuitSearchInstance: import('../editor/search.js').CircuitSearch | null = null;

  function openSearchBar(): void {
    if (!searchBar || !searchInput) return;
    searchBar.classList.add('open');
    searchInput.focus();
    searchInput.select();
  }

  function closeSearchBar(): void {
    searchBar?.classList.remove('open');
    searchResults = [];
    searchCursor = -1;
    if (searchCount) searchCount.textContent = '';
    renderPipeline.scheduleRender();
  }

  function runSearch(): void {
    if (!searchInput) return;
    const query = searchInput.value.trim();
    if (!circuitSearchInstance) {
      import('../editor/search.js').then(({ CircuitSearch }) => {
        circuitSearchInstance = new CircuitSearch();
        _doSearch(query);
      });
    } else {
      _doSearch(query);
    }
  }

  function _doSearch(query: string): void {
    if (!circuitSearchInstance) return;
    searchResults = circuitSearchInstance.search(ctx.circuit, query);
    searchCursor = searchResults.length > 0 ? 0 : -1;
    if (searchCount) {
      searchCount.textContent = searchResults.length > 0
        ? `${searchResults.length} result${searchResults.length === 1 ? '' : 's'}`
        : query ? 'No results' : '';
    }
    if (searchCursor >= 0) _navigateToResult(searchCursor);
    renderPipeline.scheduleRender();
  }

  function _navigateToResult(idx: number): void {
    if (!circuitSearchInstance || searchResults.length === 0) return;
    searchCursor = ((idx % searchResults.length) + searchResults.length) % searchResults.length;
    const result = searchResults[searchCursor];
    if (result) {
      circuitSearchInstance.navigateTo(result, viewport);
      selection.clear();
      selection.select(result.element);
      renderPipeline.scheduleRender();
    }
    if (searchCount) {
      searchCount.textContent = `${searchCursor + 1} / ${searchResults.length}`;
    }
  }

  searchInput?.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = window.setTimeout(runSearch, 150);
  });

  searchPrev?.addEventListener('click', () => _navigateToResult(searchCursor - 1));
  searchNext?.addEventListener('click', () => _navigateToResult(searchCursor + 1));
  searchCloseBtn?.addEventListener('click', closeSearchBar);

  document.getElementById('btn-find')?.addEventListener('click', () => {
    document.querySelectorAll('.menu-item.open').forEach(m => m.classList.remove('open'));
    openSearchBar();
  });

  return openSearchBar;
}

// ---------------------------------------------------------------------------
// Builder: Palette toggle (narrow screens) + collapse (all breakpoints)
// ---------------------------------------------------------------------------

function buildPaletteToggle(ctx: AppContext, _deps: MTDeps): void {
  const { canvas } = ctx;

  const palettePanel = document.getElementById('palette-panel');
  const paletteToggleBtn = document.getElementById('btn-palette-toggle');
  const paletteCollapseBtn = document.getElementById('btn-palette-collapse');
  const paletteExpandBtn = document.getElementById('btn-palette-expand');

  function togglePalette(): void {
    palettePanel?.classList.toggle('palette-visible');
  }

  function closePaletteOverlay(): void {
    palettePanel?.classList.remove('palette-visible');
  }

  function collapsePalette(): void {
    palettePanel?.classList.add('palette-collapsed');
  }

  function expandPalette(): void {
    palettePanel?.classList.remove('palette-collapsed');
  }

  paletteToggleBtn?.addEventListener('click', togglePalette);
  paletteCollapseBtn?.addEventListener('click', collapsePalette);
  paletteExpandBtn?.addEventListener('click', expandPalette);

  canvas.addEventListener('pointerdown', () => {
    if (window.matchMedia('(max-width: 600px)').matches) {
      closePaletteOverlay();
    }
  });
}

// ---------------------------------------------------------------------------
// Builder: Panel resize handles
// ---------------------------------------------------------------------------

function buildPanelResizeHandles(_ctx: AppContext, deps: MTDeps): void {
  const { renderPipeline } = deps;

  // Palette width resize
  const palettePanel = document.getElementById('palette-panel');
  const paletteResizeHandle = document.getElementById('palette-resize-handle');
  if (paletteResizeHandle && palettePanel) {
    let resizingPalette = false;
    let resizeStartX = 0;
    let resizeStartWidth = 0;

    paletteResizeHandle.addEventListener('pointerdown', (e: PointerEvent) => {
      resizingPalette = true;
      resizeStartX = e.clientX;
      resizeStartWidth = palettePanel.offsetWidth;
      paletteResizeHandle.setPointerCapture(e.pointerId);
      paletteResizeHandle.classList.add('dragging');
      e.preventDefault();
    });

    paletteResizeHandle.addEventListener('pointermove', (e: PointerEvent) => {
      if (!resizingPalette) return;
      const dx = e.clientX - resizeStartX;
      const newWidth = Math.max(120, Math.min(400, resizeStartWidth + dx));
      palettePanel.style.width = `${newWidth}px`;
    });

    const stopPaletteResize = (): void => {
      resizingPalette = false;
      paletteResizeHandle.classList.remove('dragging');
      renderPipeline.scheduleRender();
    };

    paletteResizeHandle.addEventListener('pointerup', stopPaletteResize);
    paletteResizeHandle.addEventListener('pointercancel', stopPaletteResize);
  }

  // Viewer height resize
  const viewerPanel = document.getElementById('viewer-panel');
  const viewerResizeHandle = document.getElementById('viewer-resize-handle');
  if (viewerResizeHandle && viewerPanel) {
    let resizingViewer = false;
    let viewerResizeStartY = 0;
    let viewerResizeStartH = 0;

    const updateViewerHandleVisibility = (): void => {
      const isOpen = viewerPanel.classList.contains('open');
      viewerResizeHandle.classList.toggle('viewer-open', isOpen);
    };

    const viewerObserver = new MutationObserver(updateViewerHandleVisibility);
    viewerObserver.observe(viewerPanel, { attributes: true, attributeFilter: ['class'] });
    updateViewerHandleVisibility();

    viewerResizeHandle.addEventListener('pointerdown', (e: PointerEvent) => {
      if (!viewerPanel.classList.contains('open')) return;
      resizingViewer = true;
      viewerResizeStartY = e.clientY;
      viewerResizeStartH = viewerPanel.offsetHeight;
      viewerResizeHandle.setPointerCapture(e.pointerId);
      viewerResizeHandle.classList.add('dragging');
      e.preventDefault();
    });

    viewerResizeHandle.addEventListener('pointermove', (e: PointerEvent) => {
      if (!resizingViewer) return;
      const dy = viewerResizeStartY - e.clientY;
      const newH = Math.max(80, Math.min(600, viewerResizeStartH + dy));
      viewerPanel.style.height = `${newH}px`;
    });

    const stopViewerResize = (): void => {
      resizingViewer = false;
      viewerResizeHandle.classList.remove('dragging');
      for (const sp of renderPipeline.state.scopePanels) {
        renderPipeline.sizeCanvasInContainer(sp.canvas);
      }
      renderPipeline.scheduleRender();
    };

    viewerResizeHandle.addEventListener('pointerup', stopViewerResize);
    viewerResizeHandle.addEventListener('pointercancel', stopViewerResize);
  }
}

// ---------------------------------------------------------------------------
// Pin loading override helpers
// ---------------------------------------------------------------------------

/**
 * Parse a stableNetId string into a PinLoadingOverride anchor.
 * Strings have the form "label:<label>" or "pin:<instanceId>:<pinLabel>".
 */
function stableNetIdToAnchor(id: string): PinLoadingOverride['anchor'] {
  if (id.startsWith('label:')) {
    return { type: 'label', label: id.slice('label:'.length) };
  }
  const pinPrefix = 'pin:';
  const rest = id.slice(pinPrefix.length);
  const lastColon = rest.lastIndexOf(':');
  return {
    type: 'pin',
    instanceId: rest.slice(0, lastColon),
    pinLabel: rest.slice(lastColon + 1),
  };
}

/**
 * Recompute which wires belong to nets with per-net overrides and push the
 * result to the wireRenderer's override indicator set. Called after any
 * change to circuit.metadata.digitalPinLoadingOverrides.
 */
function refreshOverrideIndicators(ctx: AppContext): void {
  const overrides = ctx.circuit.metadata.digitalPinLoadingOverrides;
  if (!overrides || overrides.length === 0) {
    ctx.wireRenderer.setOverrideIndicators(new Set());
    return;
  }

  const [modelAssignments] = resolveModelAssignments(ctx.circuit.elements, ctx.palette.getRegistry());
  const [groups] = extractConnectivityGroups(
    ctx.circuit.elements,
    ctx.circuit.wires,
    ctx.palette.getRegistry(),
    modelAssignments,
  );

  const overrideNetIdSet = new Set<string>(overrides.map(o => {
    if (o.anchor.type === 'label') return `label:${o.anchor.label}`;
    return `pin:${o.anchor.instanceId}:${o.anchor.pinLabel}`;
  }));

  const overrideWires = new Set<Wire>();
  for (const group of groups) {
    const netId = stableNetId(group, ctx.circuit.elements);
    if (!overrideNetIdSet.has(netId)) continue;
    for (const wire of group.wires) {
      overrideWires.add(wire);
    }
  }

  ctx.wireRenderer.setOverrideIndicators(overrideWires);
}

// ---------------------------------------------------------------------------
// buildSimulationPinLoadingMenu
// ---------------------------------------------------------------------------

function buildSimulationPinLoadingMenu(ctx: AppContext, deps: MTDeps): void {
  const { simController } = deps;
  const { undoStack } = ctx;

  const MODES: Array<{ id: string; checkId: string; value: "cross-domain" | "all" | "none" }> = [
    { id: 'btn-pin-loading-cross-domain', checkId: 'pin-loading-check-cross-domain', value: 'cross-domain' },
    { id: 'btn-pin-loading-all',          checkId: 'pin-loading-check-all',          value: 'all'          },
    { id: 'btn-pin-loading-none',         checkId: 'pin-loading-check-none',         value: 'none'         },
  ];

  function updateCheckmarks(): void {
    const current = ctx.circuit.metadata.digitalPinLoading ?? 'cross-domain';
    for (const mode of MODES) {
      const check = document.getElementById(mode.checkId);
      if (check) check.textContent = current === mode.value ? '\u2713' : '';
    }
  }

  for (const mode of MODES) {
    document.getElementById(mode.id)?.addEventListener('click', () => {
      const prev = ctx.circuit.metadata.digitalPinLoading ?? 'cross-domain';
      if (prev === mode.value) return;
      const next = mode.value;
      const cmd = {
        description: `Set pin loading to ${next}`,
        execute() {
          ctx.circuit.metadata.digitalPinLoading = next;
          updateCheckmarks();
          simController.invalidateCompiled();
        },
        undo() {
          if (prev === 'cross-domain') {
            delete ctx.circuit.metadata.digitalPinLoading;
          } else {
            ctx.circuit.metadata.digitalPinLoading = prev;
          }
          updateCheckmarks();
          simController.invalidateCompiled();
        },
      };
      undoStack.push(cmd);
    });
  }

  updateCheckmarks();
}

// ---------------------------------------------------------------------------
// buildSpiceModelLibrary
// ---------------------------------------------------------------------------

function buildSpiceModelLibrary(ctx: AppContext, _deps: MTDeps): void {
  document.getElementById('btn-spice-models')?.addEventListener('click', () => {
    openSpiceModelLibraryDialog(
      ctx.circuit,
      ctx.canvas.parentElement ?? document.body,
      () => {
        ctx.invalidateCompiled();
        ctx.showStatus('SPICE model library updated');
      },
    );
  });
}

// initMenuAndToolbar
// ---------------------------------------------------------------------------

export function initMenuAndToolbar(
  ctx: AppContext,
  simController: SimulationController,
  viewerController: ViewerController,
  canvasInteraction: CanvasInteraction,
  renderPipeline: RenderPipeline,
  appSettings: AppSettings,
): MenuToolbarController {

  const deps: MTDeps = { simController, viewerController, canvasInteraction, renderPipeline, appSettings };

  const rebuildInsertMenu = buildInsertMenu(ctx, deps);
  buildContextMenu(ctx, deps);
  buildSelectionSliderSync(ctx, deps);
  buildPaletteHandlers(ctx, deps);
  buildDarkModeToggle(ctx, deps);
  const updateZoomDisplay = buildZoomControls(ctx, deps);
  buildLockToggle(ctx, deps);
  buildUndoRedoButtons(ctx, deps);
  buildViewMenuItems(ctx, deps);
  const presentation = buildPresentationMode(ctx, deps);
  buildTabletMode(ctx, deps);
  buildSettingsDialog(ctx, deps);
  buildMenuEditActions(ctx, deps);
  const openSearchBar = buildSearchBar(ctx, deps);
  buildPaletteToggle(ctx, deps);
  buildPanelResizeHandles(ctx, deps);
  buildSimulationPinLoadingMenu(ctx, deps);
  buildSpiceModelLibrary(ctx, deps);

  return {
    rebuildInsertMenu,
    updateZoomDisplay,
    openSearchBar,
    togglePresentation: presentation.togglePresentation,
    exitPresentation: presentation.exitPresentation,
    isPresentationMode: presentation.isPresentationMode,
  };
}

// ---------------------------------------------------------------------------
// D9 fix — single applyColorScheme implementation
// ---------------------------------------------------------------------------

export function applyColorScheme(dark: boolean): void {
  if (typeof document === 'undefined') return;
  if (dark) {
    document.documentElement.classList.add('dark');
    document.documentElement.classList.remove('light');
  } else {
    document.documentElement.classList.add('light');
    document.documentElement.classList.remove('dark');
  }
}
