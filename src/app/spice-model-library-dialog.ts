/**
 * Circuit-level SPICE model library dialog.
 *
 * Opened from the main menu ("SPICE Models...").
 */

import type { Circuit } from '../core/circuit.js';
import { createModal } from './dialog-manager.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open the circuit-level SPICE model library dialog.
 *
 * @param circuit   The active circuit whose metadata holds the model library.
 * @param container The DOM container to attach the overlay to.
 * @param onChange  Called whenever the library is modified (add/remove).
 */
export function openSpiceModelLibraryDialog(
  circuit: Circuit,
  container: HTMLElement,
  onChange: () => void,
): void {
  const modal = createModal({
    title: 'SPICE Model Library',
    className: 'spice-model-library-dialog',
  });

  const { body, overlay } = modal;

  function renderLibrary(): void {
    body.innerHTML = '';

    const models = circuit.metadata.models ?? {};
    const allEntries: Array<{ typeId: string; modelName: string; kind: string }> = [];

    for (const [typeId, typeModels] of Object.entries(models)) {
      for (const [modelName, entry] of Object.entries(typeModels)) {
        allEntries.push({ typeId, modelName, kind: entry.kind });
      }
    }

    const modelEntries = allEntries.filter(e => e.kind === 'inline');
    const netlistEntries = allEntries.filter(e => e.kind === 'netlist');

    // --- .MODEL section ---
    const modelSection = document.createElement('div');
    modelSection.className = 'spice-library-section';

    const modelHeader = document.createElement('h3');
    modelHeader.className = 'spice-library-section-header';
    modelHeader.textContent = '.MODEL entries';
    modelSection.appendChild(modelHeader);

    if (modelEntries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'spice-library-empty';
      empty.textContent = 'No .MODEL entries defined.';
      modelSection.appendChild(empty);
    } else {
      for (const { typeId, modelName } of modelEntries) {
        const row = document.createElement('div');
        row.className = 'spice-library-row';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'spice-library-name';
        nameSpan.textContent = `${modelName} (${typeId})`;
        row.appendChild(nameSpan);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'spice-library-remove';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', () => {
          const typeModels = circuit.metadata.models?.[typeId];
          if (typeModels) {
            delete typeModels[modelName];
            if (Object.keys(typeModels).length === 0) {
              delete circuit.metadata.models![typeId];
            }
          }
          onChange();
          renderLibrary();
        });
        row.appendChild(removeBtn);

        modelSection.appendChild(row);
      }
    }

    body.appendChild(modelSection);

    // --- .SUBCKT section ---
    const subcktSection = document.createElement('div');
    subcktSection.className = 'spice-library-section';

    const subcktHeader = document.createElement('h3');
    subcktHeader.className = 'spice-library-section-header';
    subcktHeader.textContent = '.SUBCKT entries';
    subcktSection.appendChild(subcktHeader);

    if (netlistEntries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'spice-library-empty';
      empty.textContent = 'No .SUBCKT entries defined.';
      subcktSection.appendChild(empty);
    } else {
      for (const { typeId, modelName } of netlistEntries) {
        const row = document.createElement('div');
        row.className = 'spice-library-row';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'spice-library-name';
        nameSpan.textContent = `${modelName} (${typeId})`;
        row.appendChild(nameSpan);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'spice-library-remove';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', () => {
          const typeModels = circuit.metadata.models?.[typeId];
          if (typeModels) {
            delete typeModels[modelName];
            if (Object.keys(typeModels).length === 0) {
              delete circuit.metadata.models![typeId];
            }
          }
          onChange();
          renderLibrary();
        });
        row.appendChild(removeBtn);

        subcktSection.appendChild(row);
      }
    }

    body.appendChild(subcktSection);
  }

  renderLibrary();
  container.appendChild(overlay);
}
