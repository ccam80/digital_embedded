/**
 * Memory editor overlay — hex editor for RAM/ROM/EEPROM/RegisterFile elements.
 *
 * Opens a modal dialog with a live-updating hex editor when the user
 * double-clicks a memory component during simulation.
 */

import type { AppContext } from './app-context.js';
import { EngineState } from '../core/engine-interface.js';
import { createModal } from './dialog-manager.js';
import type { CircuitElement } from '../core/element.js';

// ---------------------------------------------------------------------------
// MemoryEditorController
// ---------------------------------------------------------------------------

export interface MemoryEditorController {
  openMemoryEditor(element: CircuitElement): Promise<void>;
  closeMemoryEditor(): void;
}

export function createMemoryEditorController(
  ctx: AppContext,
): MemoryEditorController {
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
    const width = Number(
      props.has('bitWidth') ? props.get('bitWidth') :
      props.has('dataBits') ? props.get('dataBits') : 8,
    );
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

  return { openMemoryEditor, closeMemoryEditor };
}
