/**
 * FileIOController — file open/save, folder management, and export.
 *
 * Extracted from app-init.ts (Step 7 of modularization plan).
 * Owns: file open/save/save-as, circuit name, format toggle, folder open/browse/close/
 * IndexedDB restore, circuit picker dialog, export (SVG/PNG/GIF/ZIP), and
 * the applyLoadedCircuit + loadCircuitFromXml entry points.
 *
 * Fix D8: shared downloadExport() helper eliminates duplicate .catch() blocks.
 */

import type { AppContext } from './app-context.js';
import { createModal } from './dialog-manager.js';
import { Circuit } from '../core/circuit.js';
import { HttpResolver, EmbeddedResolver, ChainResolver } from '../io/file-resolver.js';
import { loadWithSubcircuits } from '../io/subcircuit-loader.js';
import { deserializeCircuit } from '../io/load.js';
import { parseCtzCircuitFromText } from '../io/ctz-parser.js';
import { deserializeDts } from '../io/dts-deserializer.js';
import { serializeCircuit } from '../io/save.js';
import { serializeCircuitToDig } from '../io/dig-serializer.js';
import { storeFolder, loadFolder, clearFolder } from '../io/folder-store.js';
import { exportSvg } from '../export/svg.js';
import { exportPng } from '../export/png.js';
import { exportGif } from '../export/gif.js';
import { exportZip } from '../export/zip.js';
import { EngineState } from '../core/engine-interface.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface FileIOController {
  applyLoadedCircuit(loaded: Circuit): void;
  loadCircuitFromXml(xml: string): Promise<void>;
  updateCircuitName(): void;
  updateGifMenuState(): void;
  readonly httpResolver: HttpResolver;
  readonly saveFormat: 'dig' | 'digj';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** A directory tree node: files at this level + child directories. */
interface DirNode {
  files: string[];          // base names (no extension) of .dig files here
  children: Map<string, DirNode>;
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

export interface FileIOControllerOptions {
  /** Called after a circuit is loaded and applied (e.g. to rebuild insert menu). */
  onCircuitLoaded?(): void;
}

export function initFileIOController(ctx: AppContext, opts: FileIOControllerOptions = {}): FileIOController {
  const { registry, facade, paletteUI, viewport, canvas, selection, params, isIframe } = ctx;

  // -------------------------------------------------------------------------
  // HTTP resolver
  // -------------------------------------------------------------------------

  const httpResolver = new HttpResolver(params.base || './');

  // -------------------------------------------------------------------------
  // Save format
  // -------------------------------------------------------------------------

  let saveFormat: 'dig' | 'digj' = 'dig';

  // -------------------------------------------------------------------------
  // applyLoadedCircuit
  // -------------------------------------------------------------------------

  function applyLoadedCircuit(loaded: Circuit): void {
    const circuit = ctx.getCircuit();
    circuit.elements.length = 0;
    circuit.wires.length = 0;
    for (const el of loaded.elements) circuit.addElement(el);
    for (const w of loaded.wires) circuit.addWire(w);
    circuit.metadata = loaded.metadata;
    paletteUI.render();
    opts.onCircuitLoaded?.();
    selection.clear();
    viewport.fitToContent(circuit.elements, {
      width: canvas.clientWidth,
      height: canvas.clientHeight,
    });
    ctx.invalidateCompiled();
    updateCircuitName();
  }

  // Update AppContext.applyLoadedCircuit to delegate here
  (ctx as { applyLoadedCircuit: (loaded: Circuit) => void }).applyLoadedCircuit = applyLoadedCircuit;

  // -------------------------------------------------------------------------
  // loadCircuitFromXml
  // -------------------------------------------------------------------------

  async function loadCircuitFromXml(xml: string): Promise<void> {
    const loaded = await loadWithSubcircuits(xml, httpResolver, registry);
    applyLoadedCircuit(loaded);
    facade.compile(ctx.getCircuit());
  }

  // -------------------------------------------------------------------------
  // Circuit name
  // -------------------------------------------------------------------------

  const circuitNameInput = document.getElementById('circuit-name') as HTMLInputElement | null;

  function updateCircuitName(): void {
    if (circuitNameInput) {
      circuitNameInput.value = ctx.getCircuit().metadata.name || 'Untitled';
    }
  }

  circuitNameInput?.addEventListener('change', () => {
    ctx.getCircuit().metadata.name = circuitNameInput!.value.trim() || 'Untitled';
  });

  // -------------------------------------------------------------------------
  // File open
  // -------------------------------------------------------------------------

  const fileInput = document.getElementById('file-input') as HTMLInputElement | null;

  document.getElementById('btn-open')?.addEventListener('click', () => {
    fileInput?.click();
  });

  document.getElementById('btn-import-ctz')?.addEventListener('click', () => {
    if (fileInput) {
      fileInput.accept = '.ctz';
      fileInput.click();
      fileInput.addEventListener('change', () => {
        fileInput.accept = '.dig,.dts,.json,.digj,.ctz';
      }, { once: true });
    }
  });

  fileInput?.addEventListener('change', () => {
    const file = fileInput?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const text = reader.result as string;
        let loaded: Circuit;
        if (file.name.endsWith('.ctz')) {
          loaded = parseCtzCircuitFromText(text, registry);
        } else {
          const firstChar = text.replace(/^\s+/, '').charAt(0);
          if (firstChar === '{' || firstChar === '[') {
            const parsed = JSON.parse(text);
            if (parsed.format === 'dts' || parsed.format === 'digb') {
              const result = deserializeDts(text, registry);
              loaded = result.circuit;
            } else {
              loaded = deserializeCircuit(text, registry);
            }
          } else {
            loaded = await loadWithSubcircuits(text, httpResolver, registry);
          }
        }
        applyLoadedCircuit(loaded);
        if (isIframe) {
          window.parent.postMessage({ type: 'digital-loaded' }, '*');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('Failed to load circuit:', msg);
        ctx.showStatus(`Load error: ${msg}`, true);
        if (isIframe) {
          window.parent.postMessage({ type: 'digital-error', error: msg }, '*');
        }
      }
    };
    reader.readAsText(file);
  });

  // -------------------------------------------------------------------------
  // File save
  // -------------------------------------------------------------------------

  document.getElementById('btn-save')?.addEventListener('click', () => {
    const circuit = ctx.getCircuit();
    try {
      let content: string;
      let mimeType: string;
      let ext: string;
      if (saveFormat === 'dig') {
        content = serializeCircuitToDig(circuit, registry);
        mimeType = 'application/xml';
        ext = '.dig';
      } else {
        content = serializeCircuit(circuit);
        mimeType = 'application/json';
        ext = '.digj';
      }
      const blob = new Blob([content], { type: mimeType });
      downloadBlob(blob, (circuit.metadata.name || 'circuit') + ext);
    } catch (err) {
      console.error('Failed to save:', err);
    }
  });

  // -------------------------------------------------------------------------
  // Save As
  // -------------------------------------------------------------------------

  document.getElementById('btn-save-as')?.addEventListener('click', () => {
    const circuit = ctx.getCircuit();
    const suggested = circuit.metadata.name || 'circuit';
    const name = prompt('Save as:', suggested);
    if (name !== null && name.trim() !== '') {
      circuit.metadata.name = name.trim();
      updateCircuitName();
      document.getElementById('btn-save')?.click();
    }
  });

  // -------------------------------------------------------------------------
  // New circuit
  // -------------------------------------------------------------------------

  document.getElementById('btn-new')?.addEventListener('click', () => {
    const circuit = ctx.getCircuit();
    circuit.elements.length = 0;
    circuit.wires.length = 0;
    circuit.metadata = { ...circuit.metadata, name: 'Untitled' };
    selection.clear();
    ctx.invalidateCompiled();
    updateCircuitName();
  });

  // -------------------------------------------------------------------------
  // Save format toggle
  // -------------------------------------------------------------------------

  const formatDigBtn = document.getElementById('btn-format-dig');
  const formatDigjBtn = document.getElementById('btn-format-digj');

  function updateFormatChecks(): void {
    const digCheck = formatDigBtn?.querySelector('.format-check');
    const digjCheck = formatDigjBtn?.querySelector('.format-check');
    if (digCheck) digCheck.textContent = saveFormat === 'dig' ? '\u2713' : '';
    if (digjCheck) digjCheck.textContent = saveFormat === 'digj' ? '\u2713' : '';
  }

  formatDigBtn?.addEventListener('click', () => {
    saveFormat = 'dig';
    updateFormatChecks();
  });

  formatDigjBtn?.addEventListener('click', () => {
    saveFormat = 'digj';
    updateFormatChecks();
  });

  // -------------------------------------------------------------------------
  // Open Folder — read all .dig files from a directory
  // -------------------------------------------------------------------------

  const folderInput = document.getElementById('folder-input') as HTMLInputElement | null;

  document.getElementById('btn-open-folder')?.addEventListener('click', () => {
    folderInput?.click();
  });

  let currentFolderFiles: Map<string, string> | null = null;

  const browseFolderMenu = document.getElementById('browse-folder-menu');
  const folderSubmenu = document.getElementById('folder-submenu');
  const closeFolderBtn = document.getElementById('btn-close-folder');

  function buildFolderSubmenu(files: Map<string, string>): void {
    if (!folderSubmenu || !browseFolderMenu || !closeFolderBtn) return;
    folderSubmenu.innerHTML = '';

    const root: DirNode = { files: [], children: new Map() };
    for (const key of files.keys()) {
      if (key.endsWith('.dig')) continue;
      const parts = key.split('/');
      const fileName = parts.pop()!;
      let node = root;
      for (const segment of parts) {
        if (!node.children.has(segment)) {
          node.children.set(segment, { files: [], children: new Map() });
        }
        node = node.children.get(segment)!;
      }
      node.files.push(fileName);
    }

    function populateDropdown(container: HTMLElement, node: DirNode, pathPrefix: string): void {
      const sortedDirs = [...node.children.keys()].sort();
      for (const dirName of sortedDirs) {
        const childNode = node.children.get(dirName)!;
        const sub = document.createElement('div');
        sub.className = 'menu-submenu';

        const label = document.createElement('div');
        label.className = 'menu-action';
        label.textContent = dirName;
        sub.appendChild(label);

        const dropdown = document.createElement('div');
        dropdown.className = 'menu-dropdown';
        populateDropdown(dropdown, childNode, pathPrefix ? `${pathPrefix}/${dirName}` : dirName);
        sub.appendChild(dropdown);

        sub.addEventListener('pointerenter', () => sub.classList.add('open'));
        sub.addEventListener('pointerleave', () => sub.classList.remove('open'));

        container.appendChild(sub);
      }

      const sortedFiles = [...node.files].sort();
      if (sortedDirs.length > 0 && sortedFiles.length > 0) {
        const sep = document.createElement('div');
        sep.className = 'menu-separator';
        container.appendChild(sep);
      }
      for (const name of sortedFiles) {
        const fullKey = pathPrefix ? `${pathPrefix}/${name}` : name;
        const item = document.createElement('div');
        item.className = 'menu-action';
        item.textContent = name + '.dig';
        item.addEventListener('click', () => {
          openFromStoredFolder(fullKey);
        });
        container.appendChild(item);
      }
    }

    populateDropdown(folderSubmenu, root, '');

    browseFolderMenu.style.display = '';
    closeFolderBtn.style.display = '';
  }

  function hideFolderSubmenu(): void {
    if (browseFolderMenu) browseFolderMenu.style.display = 'none';
    if (closeFolderBtn) closeFolderBtn.style.display = 'none';
    if (folderSubmenu) folderSubmenu.innerHTML = '';
    currentFolderFiles = null;
  }

  async function openFromStoredFolder(name: string): Promise<void> {
    if (!currentFolderFiles) return;
    const xml = currentFolderFiles.get(name);
    if (!xml) {
      ctx.showStatus(`File "${name}.dig" not found in folder`, true);
      return;
    }
    try {
      const siblingMap = new Map<string, string>();
      for (const [k, v] of currentFolderFiles) {
        if (k !== name) {
          siblingMap.set(k, v);
          if (!k.endsWith('.dig')) siblingMap.set(k + '.dig', v);
        }
      }
      const folderResolver = new ChainResolver([
        new EmbeddedResolver(siblingMap),
        httpResolver,
      ]);
      const loaded = await loadWithSubcircuits(xml, folderResolver, registry);
      applyLoadedCircuit(loaded);
      ctx.getCircuit().metadata.name = name.split('/').pop() || name;
      updateCircuitName();
      const scCount = siblingMap.size / 2;
      ctx.showStatus(`Loaded ${name}.dig (${scCount} subcircuit file${scCount !== 1 ? 's' : ''} available)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Failed to load circuit from folder:', msg);
      ctx.showStatus(`Load error: ${msg}`, true);
    }
  }

  function showCircuitPickerDialog(files: Map<string, string>, folderName: string): void {
    const sortedKeys = [...files.keys()].sort();

    const { overlay, body: list } = createModal({
      title: `Open circuit — ${folderName}`,
      className: 'circuit-picker',
      overlayClassName: 'circuit-picker-overlay',
    });
    list.className = 'circuit-picker-list';

    let lastDir = '';
    for (const key of sortedKeys) {
      const parts = key.split('/');
      const fileName = parts.pop()!;
      const dir = parts.join('/');

      if (dir !== lastDir) {
        if (dir) {
          const dirLabel = document.createElement('div');
          dirLabel.className = 'circuit-picker-dir';
          dirLabel.textContent = dir;
          list.appendChild(dirLabel);
        }
        lastDir = dir;
      }

      const item = document.createElement('div');
      item.className = 'circuit-picker-item';
      item.textContent = fileName + '.dig';
      item.addEventListener('click', () => {
        overlay.remove();
        openFromStoredFolder(key);
      });
      list.appendChild(item);
    }

    document.body.appendChild(overlay);
  }

  folderInput?.addEventListener('change', async () => {
    const files = folderInput?.files;
    if (!files || files.length === 0) return;

    const digFiles = new Map<string, string>();
    let folderName = '';
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f.name.endsWith('.dig')) {
        const name = f.name.replace(/\.dig$/, '');
        const relPath = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
        if (relPath && !folderName) {
          folderName = relPath.split('/')[0] || name;
        }
        const content = await f.text();
        digFiles.set(name, content);
      }
    }

    if (digFiles.size === 0) {
      ctx.showStatus('No .dig files found in selected folder', true);
      return;
    }

    if (!folderName) folderName = 'Folder';

    try {
      await storeFolder(folderName, digFiles);
    } catch (e) {
      console.warn('Failed to persist folder to IndexedDB:', e);
    }

    currentFolderFiles = digFiles;
    buildFolderSubmenu(digFiles);

    if (digFiles.size === 1) {
      const [name] = [...digFiles.keys()];
      await openFromStoredFolder(name);
    } else {
      showCircuitPickerDialog(digFiles, folderName);
    }
  });

  closeFolderBtn?.addEventListener('click', async () => {
    hideFolderSubmenu();
    try {
      await clearFolder();
    } catch (e) {
      console.warn('Failed to clear folder from IndexedDB:', e);
    }
    ctx.showStatus('Folder closed');
  });

  // Restore folder from IndexedDB on startup
  loadFolder().then((stored) => {
    if (!stored) return;
    const files = new Map(Object.entries(stored.files));
    currentFolderFiles = files;
    buildFolderSubmenu(files);
    ctx.showStatus(`Folder "${stored.name}" restored (${files.size} .dig files). Use File → Browse Folder to open a circuit.`);
  }).catch((e) => {
    console.warn('Failed to restore folder from IndexedDB:', e);
  });

  // -------------------------------------------------------------------------
  // Export menu — D8 fix: shared downloadExport() helper
  // -------------------------------------------------------------------------

  function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadExport(promise: Promise<Blob>, filename: string, label: string): void {
    promise.then(blob => {
      downloadBlob(blob, filename);
    }).catch((err: unknown) => {
      ctx.showStatus(`${label} export failed: ${err instanceof Error ? err.message : String(err)}`, true);
    });
  }

  function circuitBaseName(): string {
    return (ctx.getCircuit().metadata.name || 'circuit').replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  document.getElementById('btn-export-svg')?.addEventListener('click', () => {
    const circuit = ctx.getCircuit();
    const svg = exportSvg(circuit);
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    downloadBlob(blob, `${circuitBaseName()}.svg`);
  });

  document.getElementById('btn-export-png')?.addEventListener('click', () => {
    downloadExport(exportPng(ctx.getCircuit()), `${circuitBaseName()}.png`, 'PNG');
  });

  document.getElementById('btn-export-png2x')?.addEventListener('click', () => {
    downloadExport(exportPng(ctx.getCircuit(), { scale: 2 }), `${circuitBaseName()}@2x.png`, 'PNG');
  });

  const gifMenuItem = document.getElementById('btn-export-gif');
  gifMenuItem?.addEventListener('click', () => {
    const gifEng = facade.getCoordinator();
    if (!gifEng || gifEng.getState() === EngineState.STOPPED) return;
    downloadExport(exportGif(ctx.getCircuit(), gifEng), `${circuitBaseName()}.gif`, 'GIF');
  });

  function updateGifMenuState(): void {
    if (gifMenuItem) {
      const gifEng = facade.getCoordinator();
      const stopped = !gifEng || gifEng.getState() === EngineState.STOPPED;
      gifMenuItem.style.opacity = stopped ? '0.4' : '';
      gifMenuItem.style.pointerEvents = stopped ? 'none' : '';
    }
  }
  document.querySelector('.menu-item[data-menu="file"]')?.addEventListener('click', updateGifMenuState);
  updateGifMenuState();

  document.getElementById('btn-export-zip')?.addEventListener('click', () => {
    downloadExport(exportZip(ctx.getCircuit(), new Map()), `${circuitBaseName()}.zip`, 'ZIP');
  });

  // -------------------------------------------------------------------------
  // Return public interface
  // -------------------------------------------------------------------------

  return {
    applyLoadedCircuit,
    loadCircuitFromXml,
    updateCircuitName,
    updateGifMenuState,
    get httpResolver() { return httpResolver; },
    get saveFormat() { return saveFormat; },
  };
}
