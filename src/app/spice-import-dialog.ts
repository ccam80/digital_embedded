/**
 * SPICE .MODEL import dialog.
 *
 * Triggered from right-click context menu on semiconductor components.
 * Parses a pasted .MODEL card, shows a parse preview, and on Apply stores
 * the parsed params via the unified model system.
 */

import { parseModelCard } from '../solver/analog/model-parser.js';
import type { ParsedModel, ParseError } from '../solver/analog/model-parser.js';
import { createModal } from './dialog-manager.js';
import type { CircuitElement } from '../core/element.js';
import type { ComponentDefinition } from '../core/registry.js';
import type { SpiceImportResult } from './spice-model-apply.js';

/**
 * Open the .MODEL import dialog for the given element.
 *
 * Returns a Promise that resolves with the import result when the user
 * clicks Apply, or resolves with null when the user cancels.
 */
export function openSpiceImportDialog(
  element: CircuitElement,
  container: HTMLElement,
  definition?: ComponentDefinition,
): Promise<SpiceImportResult | null> {
  return new Promise<SpiceImportResult | null>((resolve) => {
    let resolved = false;

    function finish(result: SpiceImportResult | null): void {
      if (resolved) return;
      resolved = true;
      modal.close();
      resolve(result);
    }

    const modal = createModal({
      title: 'Import SPICE Model',
      className: 'spice-import-dialog',
      onClose: () => finish(null),
    });

    const { body } = modal;

    // --- Instruction label ---
    const instruction = document.createElement('p');
    instruction.className = 'spice-import-instruction';
    instruction.textContent = 'Paste a .MODEL statement below or use the file upload button.';
    body.appendChild(instruction);

    // --- Textarea ---
    const textarea = document.createElement('textarea');
    textarea.className = 'spice-import-textarea';
    textarea.rows = 6;
    textarea.placeholder = '.MODEL 2N2222 NPN(IS=1e-14 BF=200 NF=1)';
    body.appendChild(textarea);

    // --- File upload ---
    const uploadRow = document.createElement('div');
    uploadRow.className = 'spice-import-upload-row';
    const uploadLabel = document.createElement('label');
    uploadLabel.className = 'spice-import-upload-label';
    uploadLabel.textContent = 'Or load from file: ';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.lib,.mod,.txt,.sp,.cir';
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
      const result = parseAndValidate(textarea.value);
      if (result.parsed && !('message' in result.parsed)) {
        finish({
          overrides: result.parsed.params,
          modelName: result.parsed.name,
          deviceType: result.parsed.deviceType,
        });
      }
    });

    buttonRow.appendChild(cancelBtn);
    buttonRow.appendChild(applyBtn);
    body.appendChild(buttonRow);

    // --- Live parse preview ---
    let lastParsed: ParsedModel | ParseError | null = null;

    function parseAndValidate(text: string): {
      parsed: ParsedModel | ParseError | null;
      warnings: string[];
    } {
      const trimmed = text.trim();
      if (!trimmed) return { parsed: null, warnings: [] };
      const parsed = parseModelCard(trimmed);
      const warnings: string[] = [];
      if (!('message' in parsed)) {
        const diags = validateModel({ name: parsed.name, type: parsed.deviceType, level: parsed.level, params: parsed.params });
        for (const d of diags) {
          warnings.push(d.summary);
        }
      }
      return { parsed, warnings };
    }

    function updatePreview(): void {
      const { parsed, warnings } = parseAndValidate(textarea.value);
      lastParsed = parsed;

      previewSection.innerHTML = '';

      if (!textarea.value.trim()) {
        applyBtn.disabled = true;
        return;
      }

      if (parsed === null) {
        applyBtn.disabled = true;
        return;
      }

      if ('message' in parsed) {
        // Parse error
        const errDiv = document.createElement('div');
        errDiv.className = 'spice-import-error';
        errDiv.textContent = `Parse error (line ${parsed.line}): ${parsed.message}`;
        previewSection.appendChild(errDiv);
        applyBtn.disabled = true;
        return;
      }

      // Success — show summary
      const summaryDiv = document.createElement('div');
      summaryDiv.className = 'spice-import-summary';

      const nameRow = document.createElement('div');
      nameRow.className = 'spice-import-row';
      nameRow.innerHTML = `<span class="spice-import-label">Model name:</span> <span class="spice-import-value">${escapeHtml(parsed.name)}</span>`;
      summaryDiv.appendChild(nameRow);

      const typeRow = document.createElement('div');
      typeRow.className = 'spice-import-row';
      typeRow.innerHTML = `<span class="spice-import-label">Device type:</span> <span class="spice-import-value">${escapeHtml(parsed.deviceType)}</span>`;
      summaryDiv.appendChild(typeRow);

      const paramCount = Object.keys(parsed.params).length;
      const paramRow = document.createElement('div');
      paramRow.className = 'spice-import-row';
      paramRow.innerHTML = `<span class="spice-import-label">Parameters:</span> <span class="spice-import-value">${paramCount}</span>`;
      summaryDiv.appendChild(paramRow);

      previewSection.appendChild(summaryDiv);

      for (const warn of warnings) {
        const warnDiv = document.createElement('div');
        warnDiv.className = 'spice-import-warning';
        warnDiv.textContent = `Warning: ${warn}`;
        previewSection.appendChild(warnDiv);
      }

      applyBtn.disabled = false;
    }

    textarea.addEventListener('input', updatePreview);

    // Pre-populate with existing model params if any
    {
      const deviceType = resolveSpiceTypeFromDefinition(definition);
      if (deviceType) {
        textarea.placeholder = `.MODEL MYMODEL ${deviceType}(IS=1e-14 BF=200)`;
        updatePreview();
      }
    }

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

/**
 * Attempt to infer the device type from the component definition's model registry.
 * Used only for pre-populating the textarea with existing overrides.
 */
function resolveSpiceTypeFromDefinition(def?: ComponentDefinition): string | null {
  if (!def?.modelRegistry) return null;
  for (const entry of Object.values(def.modelRegistry)) {
    if ('deviceType' in entry && typeof entry.deviceType === 'string') return entry.deviceType;
  }
  return null;
}

