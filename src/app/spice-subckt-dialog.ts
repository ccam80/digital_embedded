/**
 * SPICE .SUBCKT import dialog.
 *
 * Triggered from right-click context menu on components with a subcircuitModel
 * in their active MNA model definition.
 *
 * Parses the pasted .SUBCKT block, shows a parse preview (name, port count,
 * element count), and on Apply:
 *   - Builds a Circuit from the parsed subcircuit via buildSpiceSubcircuit()
 *   - Returns the result for the caller to register and apply
 */

import { parseSubcircuit } from '../solver/analog/model-parser.js';
import type { ParsedSubcircuit } from '../solver/analog/model-parser.js';
import { buildSpiceSubcircuit } from '../io/spice-model-builder.js';
import { createModal } from './dialog-manager.js';
import type { CircuitElement } from '../core/element.js';
import type { SpiceSubcktImportResult } from './spice-model-apply.js';

/**
 * Open the .SUBCKT import dialog for the given element.
 *
 * Returns a Promise that resolves with the import result when the user clicks
 * Apply, or resolves with null when the user cancels.
 */
export function openSpiceSubcktDialog(
  _element: CircuitElement,
  container: HTMLElement,
): Promise<SpiceSubcktImportResult | null> {
  return new Promise<SpiceSubcktImportResult | null>((resolve) => {
    let resolved = false;

    function finish(result: SpiceSubcktImportResult | null): void {
      if (resolved) return;
      resolved = true;
      modal.close();
      resolve(result);
    }

    const modal = createModal({
      title: 'Import SPICE Subcircuit',
      className: 'spice-subckt-dialog',
      onClose: () => finish(null),
    });

    const { body } = modal;

    // --- Instruction label ---
    const instruction = document.createElement('p');
    instruction.className = 'spice-import-instruction';
    instruction.textContent = 'Paste a .SUBCKT…ENDS block below or use the file upload button.';
    body.appendChild(instruction);

    // --- Textarea ---
    const textarea = document.createElement('textarea');
    textarea.className = 'spice-import-textarea';
    textarea.rows = 10;
    textarea.placeholder = '.SUBCKT OPAMP IN+ IN- OUT VCC VEE\n* ...\n.ENDS OPAMP';
    body.appendChild(textarea);

    // --- File upload ---
    const uploadRow = document.createElement('div');
    uploadRow.className = 'spice-import-upload-row';
    const uploadLabel = document.createElement('label');
    uploadLabel.className = 'spice-import-upload-label';
    uploadLabel.textContent = 'Or load from file: ';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.lib,.mod,.txt,.sp,.cir,.sub';
    fileInput.className = 'spice-import-file-input';
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        textarea.value = typeof reader.result === 'string' ? reader.result : '';
        updatePreview();
      };
      reader.readAsText(file);
    });
    uploadLabel.appendChild(fileInput);
    uploadRow.appendChild(uploadLabel);
    body.appendChild(uploadRow);

    // --- Preview section ---
    const previewSection = document.createElement('div');
    previewSection.className = 'spice-import-preview';
    body.appendChild(previewSection);

    // --- Button row ---
    const buttonRow = document.createElement('div');
    buttonRow.className = 'spice-import-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.className = 'spice-import-cancel';
    cancelBtn.addEventListener('click', () => finish(null));

    const applyBtn = document.createElement('button');
    applyBtn.textContent = 'Apply';
    applyBtn.className = 'spice-import-apply';
    applyBtn.disabled = true;
    applyBtn.addEventListener('click', () => {
      const result = tryParse(textarea.value);
      if (result.parsed) {
        const circuit = buildSpiceSubcircuit(result.parsed);
        finish({ subcktName: result.parsed.name, circuit });
      }
    });

    buttonRow.appendChild(cancelBtn);
    buttonRow.appendChild(applyBtn);
    body.appendChild(buttonRow);

    // --- Live parse preview ---

    function tryParse(text: string): {
      parsed: ParsedSubcircuit | null;
      error: string | null;
    } {
      const trimmed = text.trim();
      if (!trimmed) return { parsed: null, error: null };
      try {
        const parsed = parseSubcircuit(trimmed);
        return { parsed, error: null };
      } catch (e: unknown) {
        const err = e as { line?: number; message?: string };
        const msg = err.message ?? String(e);
        const line = err.line !== undefined ? ` (line ${err.line})` : '';
        return { parsed: null, error: `Parse error${line}: ${msg}` };
      }
    }

    function updatePreview(): void {
      const { parsed, error } = tryParse(textarea.value);

      previewSection.innerHTML = '';

      if (!textarea.value.trim()) {
        applyBtn.disabled = true;
        return;
      }

      if (error !== null) {
        const errDiv = document.createElement('div');
        errDiv.className = 'spice-import-error';
        errDiv.textContent = error;
        previewSection.appendChild(errDiv);
        applyBtn.disabled = true;
        return;
      }

      if (!parsed) {
        applyBtn.disabled = true;
        return;
      }

      // Success — show summary
      const summaryDiv = document.createElement('div');
      summaryDiv.className = 'spice-import-summary';

      const nameRow = document.createElement('div');
      nameRow.className = 'spice-import-row';
      nameRow.innerHTML = `<span class="spice-import-label">Subcircuit name:</span> <span class="spice-import-value">${escapeHtml(parsed.name)}</span>`;
      summaryDiv.appendChild(nameRow);

      const portsRow = document.createElement('div');
      portsRow.className = 'spice-import-row';
      portsRow.innerHTML = `<span class="spice-import-label">Ports:</span> <span class="spice-import-value">${parsed.ports.length} (${parsed.ports.map(escapeHtml).join(', ')})</span>`;
      summaryDiv.appendChild(portsRow);

      const elemRow = document.createElement('div');
      elemRow.className = 'spice-import-row';
      elemRow.innerHTML = `<span class="spice-import-label">Elements:</span> <span class="spice-import-value">${parsed.elements.length}</span>`;
      summaryDiv.appendChild(elemRow);

      if (parsed.models.length > 0) {
        const modelsRow = document.createElement('div');
        modelsRow.className = 'spice-import-row';
        modelsRow.innerHTML = `<span class="spice-import-label">Inline models:</span> <span class="spice-import-value">${parsed.models.length}</span>`;
        summaryDiv.appendChild(modelsRow);
      }

      previewSection.appendChild(summaryDiv);
      applyBtn.disabled = false;
    }

    textarea.addEventListener('input', updatePreview);

    container.appendChild(modal.overlay);
    textarea.focus();
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
