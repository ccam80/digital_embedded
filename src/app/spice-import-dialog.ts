/**
 * SPICE import dialog — handles both .MODEL and .SUBCKT formats.
 *
 * Triggered from right-click context menu on semiconductor components.
 * Auto-detects the format from the first non-blank line of pasted text:
 *   - Lines starting with .SUBCKT → parse as subcircuit
 *   - Otherwise → parse as .MODEL card
 * Shows a parse preview and on Apply returns the appropriate result type.
 */

import { parseModelCard, parseSubcircuit } from '../solver/analog/model-parser.js';
import type { ParsedModel, ParseError, ParsedSubcircuit } from '../solver/analog/model-parser.js';
import { createModal } from './dialog-manager.js';
import type { CircuitElement } from '../core/element.js';
import type { ComponentDefinition } from '../core/registry.js';
import type { SpiceImportResult, SpiceSubcktImportResult } from './spice-model-apply.js';
import { buildNetConnectivity } from '../core/mna-subcircuit-netlist.js';
import type { SubcircuitElement, MnaSubcircuitNetlist } from '../core/mna-subcircuit-netlist.js';

// ---------------------------------------------------------------------------
// Auto-detect
// ---------------------------------------------------------------------------

/**
 * Inspect the first non-blank line of `text` to decide which parser to use.
 * Returns "subckt" if the first non-blank line starts with .SUBCKT (case-insensitive),
 * or "model" otherwise.
 */
function detectFormat(text: string): "subckt" | "model" {
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (/^\.subckt\b/i.test(trimmed)) return "subckt";
    return "model";
  }
  return "model";
}

// ---------------------------------------------------------------------------
// Local validation helper (returns an array of diagnostic summaries)
// ---------------------------------------------------------------------------

function validateModel(_model: {
  name: string;
  type: string;
  level: number;
  params: Record<string, number>;
}): Array<{ summary: string }> {
  return [];
}

// ---------------------------------------------------------------------------
// openSpiceImportDialog
// ---------------------------------------------------------------------------

/**
 * Open the unified SPICE import dialog for the given element.
 *
 * Returns a Promise that resolves with the import result when the user
 * clicks Apply, or resolves with null when the user cancels.
 * The result type depends on the detected format:
 *   - .MODEL input → SpiceImportResult
 *   - .SUBCKT input → SpiceSubcktImportResult
 */
export function openSpiceImportDialog(
  _element: CircuitElement,
  container: HTMLElement,
  definition?: ComponentDefinition,
): Promise<SpiceImportResult | SpiceSubcktImportResult | null> {
  return new Promise<SpiceImportResult | SpiceSubcktImportResult | null>((resolve) => {
    let resolved = false;

    function finish(result: SpiceImportResult | SpiceSubcktImportResult | null): void {
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
    instruction.textContent = 'Paste a .MODEL or .SUBCKT statement below, or use the file upload button.';
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
      const result = parseAndValidate(textarea.value);
      if (result.kind === "model" && result.parsed && !('message' in result.parsed)) {
        finish({
          overrides: result.parsed.params,
          modelName: result.parsed.name,
          deviceType: result.parsed.deviceType,
        });
      } else if (result.kind === "subckt" && result.subckt) {
        const sc = result.subckt;
        const elementNodes = sc.elements.map((el) => el.nodes);
        const { internalNetCount, netlist: netlistConnectivity } = buildNetConnectivity(sc.ports, elementNodes);
        const subcktElements = sc.elements.map((el) => {
          let params: Record<string, number | string> | undefined;
          if (el.value !== undefined) {
            params = { ...(el.params as Record<string, number | string> | undefined), value: el.value };
          } else if (el.params !== undefined) {
            params = el.params as Record<string, number | string>;
          }
          const entry: SubcircuitElement = {
            typeId: elementTypeId(el.type),
          };
          if (el.modelName !== undefined) entry.modelRef = el.modelName;
          if (params !== undefined) entry.params = params;
          return entry;
        });
        const mnaNetlist: MnaSubcircuitNetlist = {
          ports: sc.ports,
          elements: subcktElements,
          internalNetCount,
          netlist: netlistConnectivity,
        };
        if (Object.keys(sc.params).length > 0) mnaNetlist.params = sc.params;
        finish({
          subcktName: sc.name,
          netlist: mnaNetlist,
        });
      }
    });

    buttonRow.appendChild(cancelBtn);
    buttonRow.appendChild(applyBtn);
    body.appendChild(buttonRow);

    // ---------------------------------------------------------------------------
    // Parse + validate
    // ---------------------------------------------------------------------------

    type ParseResult =
      | { kind: "model"; parsed: ParsedModel | ParseError | null; warnings: string[] }
      | { kind: "subckt"; subckt: ParsedSubcircuit | null; error: string | null };

    function parseAndValidate(text: string): ParseResult {
      const trimmed = text.trim();
      if (!trimmed) return { kind: "model", parsed: null, warnings: [] };

      const fmt = detectFormat(trimmed);

      if (fmt === "subckt") {
        try {
          const subckt = parseSubcircuit(trimmed);
          return { kind: "subckt", subckt, error: null };
        } catch (e: unknown) {
          const err = e as { line?: number; message?: string };
          const msg = err.message
            ? (err.line ? `Parse error (line ${err.line}): ${err.message}` : err.message)
            : String(e);
          return { kind: "subckt", subckt: null, error: msg };
        }
      }

      // .MODEL path
      const parsed = parseModelCard(trimmed);
      const warnings: string[] = [];
      if (!('message' in parsed)) {
        const diags = validateModel({ name: parsed.name, type: parsed.deviceType, level: parsed.level, params: parsed.params });
        for (const d of diags) {
          warnings.push(d.summary);
        }
      }
      return { kind: "model", parsed, warnings };
    }

    function updatePreview(): void {
      const result = parseAndValidate(textarea.value);

      previewSection.innerHTML = '';

      if (!textarea.value.trim()) {
        applyBtn.disabled = true;
        return;
      }

      if (result.kind === "subckt") {
        if (result.error !== null) {
          const errDiv = document.createElement('div');
          errDiv.className = 'spice-import-error';
          errDiv.textContent = result.error;
          previewSection.appendChild(errDiv);
          applyBtn.disabled = true;
          return;
        }

        if (result.subckt !== null) {
          const summaryDiv = document.createElement('div');
          summaryDiv.className = 'spice-import-summary';

          const nameRow = document.createElement('div');
          nameRow.className = 'spice-import-row';
          nameRow.innerHTML = `<span class="spice-import-label">Subcircuit name:</span> <span class="spice-import-value">${escapeHtml(result.subckt.name)}</span>`;
          summaryDiv.appendChild(nameRow);

          const portRow = document.createElement('div');
          portRow.className = 'spice-import-row';
          portRow.innerHTML = `<span class="spice-import-label">Ports:</span> <span class="spice-import-value">${result.subckt.ports.length}</span>`;
          summaryDiv.appendChild(portRow);

          const elemRow = document.createElement('div');
          elemRow.className = 'spice-import-row';
          elemRow.innerHTML = `<span class="spice-import-label">Elements:</span> <span class="spice-import-value">${result.subckt.elements.length}</span>`;
          summaryDiv.appendChild(elemRow);

          previewSection.appendChild(summaryDiv);
          applyBtn.disabled = false;
        }
        return;
      }

      // .MODEL path
      const { parsed, warnings } = result;

      if (parsed === null) {
        applyBtn.disabled = true;
        return;
      }

      if ('message' in parsed) {
        const errDiv = document.createElement('div');
        errDiv.className = 'spice-import-error';
        errDiv.textContent = `Parse error (line ${parsed.line}): ${parsed.message}`;
        previewSection.appendChild(errDiv);
        applyBtn.disabled = true;
        return;
      }

      // Success — show .MODEL summary
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

    // Pre-populate placeholder with component device type if known
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

/**
 * Map a ParsedElement type character to a component typeId string.
 */
function elementTypeId(type: string): string {
  switch (type) {
    case "R": return "Resistor";
    case "C": return "Capacitor";
    case "L": return "Inductor";
    case "D": return "Diode";
    case "Q": return "NpnBJT";
    case "M": return "NMOS";
    case "J": return "NJFET";
    case "V": return "DcVoltageSource";
    case "I": return "CurrentSource";
    case "X": return "SubcircuitInstance";
    default:  return type;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Attempt to infer the device type from the component definition's model registry.
 * Used only for pre-populating the textarea placeholder.
 */
function resolveSpiceTypeFromDefinition(def?: ComponentDefinition): string | null {
  if (!def?.modelRegistry) return null;
  for (const entry of Object.values(def.modelRegistry)) {
    if ('deviceType' in entry && typeof entry.deviceType === 'string') return entry.deviceType;
  }
  return null;
}
