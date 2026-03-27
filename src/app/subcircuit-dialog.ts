/**
 * Create Subcircuit modal dialog.
 *
 * Presents the user with a form to name a subcircuit and review/edit the
 * auto-derived port table before extraction. A live chip preview updates
 * as the user changes name, port labels, and face assignments.
 *
 * Returns { name, ports } when the user confirms, or null on cancel.
 */

import { createModal } from './dialog-manager.js';
import type { BoundaryPort } from '../editor/insert-subcircuit.js';
import { countPinsByFace } from '../components/subcircuit/pin-derivation.js';
import { drawDefaultShape } from '../components/subcircuit/shape-renderer.js';
import { CanvasRenderer } from '../editor/canvas-renderer.js';
import { lightColorScheme } from '../core/renderer-interface.js';
import { PinDirection } from '../core/pin.js';
import type { PinDeclaration } from '../core/pin.js';
import type { ComponentRegistry } from '../core/registry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubcircuitDialogPort {
  label: string;
  bitWidth: number;
  face: 'left' | 'right' | 'top' | 'bottom';
}

export interface SubcircuitDialogResult {
  name: string;
  ports: SubcircuitDialogPort[];
}

// ---------------------------------------------------------------------------
// Preview rendering
// ---------------------------------------------------------------------------

const PREVIEW_CANVAS_SIZE = 240;
const PREVIEW_GRID = 20; // pixels per grid unit

/**
 * Build PinDeclaration[] from the dialog's current port rows for preview.
 *
 * Since Port elements are BIDIRECTIONAL but the DEFAULT shape renderer groups
 * pins as INPUT (left) or OUTPUT (right), we map face to direction for preview:
 *   left  → INPUT
 *   right → OUTPUT
 *   top / bottom → INPUT (rendered on closest logical side)
 */
function buildPreviewPins(ports: SubcircuitDialogPort[]): PinDeclaration[] {
  return ports.map((p): PinDeclaration => ({
    direction: (p.face === 'right') ? PinDirection.OUTPUT : PinDirection.INPUT,
    label: p.label || '?',
    defaultBitWidth: p.bitWidth,
    position: { x: 0, y: 0 },
    isNegatable: false,
    isClockCapable: false,
    face: p.face,
  }));
}

/**
 * Compute chip width and height (in grid units) from the port face counts.
 */
function computePreviewDimensions(pins: PinDeclaration[]): { width: number; height: number } {
  const counts = countPinsByFace(pins);
  const sideH = Math.max(counts.left, counts.right, 1);
  const width = 3;
  const height = sideH;
  return { width, height };
}

/**
 * Assign x/y positions to pins for DEFAULT shape rendering.
 *
 * Left-face pins are placed at x=0, right-face at x=width.
 * Top/bottom pins are placed on the sides for simplicity in the preview.
 */
function positionPreviewPins(
  pins: PinDeclaration[],
  width: number,
  _height: number,
): PinDeclaration[] {
  const leftPins = pins.filter(p => p.face !== 'right');
  const rightPins = pins.filter(p => p.face === 'right');

  const positioned: PinDeclaration[] = [];

  leftPins.forEach((p, i) => {
    positioned.push({ ...p, position: { x: 0, y: i } });
  });
  rightPins.forEach((p, i) => {
    positioned.push({ ...p, position: { x: width, y: i } });
  });

  return positioned;
}

/**
 * Render a chip preview onto the offscreen canvas.
 */
function renderPreview(
  canvas: HTMLCanvasElement,
  name: string,
  ports: SubcircuitDialogPort[],
): void {
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) return;

  ctx2d.clearRect(0, 0, canvas.width, canvas.height);

  const pins = buildPreviewPins(ports);
  const { width, height } = computePreviewDimensions(pins);
  const positionedPins = positionPreviewPins(pins, width, height);

  const renderer = new CanvasRenderer(ctx2d, lightColorScheme);

  // Scale and center: fit (width+2) x (height+1) grid units into the canvas
  const scaleX = canvas.width / ((width + 2) * PREVIEW_GRID);
  const scaleY = canvas.height / ((height + 1) * PREVIEW_GRID);
  const scale = Math.min(scaleX, scaleY, 1) * PREVIEW_GRID;

  const totalW = (width + 2) * scale;
  const totalH = (height + 1) * scale;
  const offsetX = (canvas.width - totalW) / 2 + scale;
  const offsetY = (canvas.height - totalH) / 2 + 0.5 * scale;

  ctx2d.save();
  ctx2d.translate(offsetX, offsetY);
  ctx2d.scale(scale, scale);
  renderer.setGridScale(scale);

  drawDefaultShape(renderer, name || 'Subcircuit', positionedPins, width, height, 0);

  ctx2d.restore();
}

// ---------------------------------------------------------------------------
// Face assignment from port positions
// ---------------------------------------------------------------------------

type Face = 'left' | 'right' | 'top' | 'bottom';

function computeFaceFromPosition(
  position: { x: number; y: number },
  centroid: { x: number; y: number },
): Face {
  const dx = position.x - centroid.x;
  const dy = position.y - centroid.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? 'right' : 'left';
  }
  return dy >= 0 ? 'bottom' : 'top';
}

function computeCentroid(ports: BoundaryPort[]): { x: number; y: number } {
  if (ports.length === 0) return { x: 0, y: 0 };
  let sumX = 0;
  let sumY = 0;
  for (const bp of ports) {
    sumX += bp.position.x;
    sumY += bp.position.y;
  }
  return { x: sumX / ports.length, y: sumY / ports.length };
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

/**
 * Open the "Create Subcircuit" modal dialog.
 *
 * @param boundaryPorts   Auto-derived boundary ports from analyzeBoundary().
 * @param registry        Registry for checking name uniqueness.
 * @returns               Promise resolving to the confirmed result or null.
 */
export function openSubcircuitDialog(
  boundaryPorts: BoundaryPort[],
  registry: ComponentRegistry,
): Promise<SubcircuitDialogResult | null> {
  return new Promise<SubcircuitDialogResult | null>((resolve) => {
    let resolved = false;

    function finish(result: SubcircuitDialogResult | null): void {
      if (resolved) return;
      resolved = true;
      modal.close();
      resolve(result);
    }

    const modal = createModal({
      title: 'Create Subcircuit',
      className: 'subcircuit-dialog',
      onClose: () => finish(null),
    });

    const body = modal.body;
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.style.gap = '12px';
    body.style.minWidth = '420px';

    // -----------------------------------------------------------------------
    // Name field
    // -----------------------------------------------------------------------

    const nameRow = document.createElement('div');
    nameRow.style.display = 'flex';
    nameRow.style.alignItems = 'center';
    nameRow.style.gap = '8px';

    const nameLabel = document.createElement('label');
    nameLabel.textContent = 'Name:';
    nameLabel.style.minWidth = '60px';
    nameLabel.style.fontWeight = 'bold';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'MySubcircuit';
    nameInput.style.flex = '1';
    nameInput.style.padding = '4px 6px';
    nameInput.style.border = '1px solid #ccc';
    nameInput.style.borderRadius = '3px';

    const nameError = document.createElement('span');
    nameError.style.color = '#c00';
    nameError.style.fontSize = '0.85em';
    nameError.style.display = 'none';

    nameRow.appendChild(nameLabel);
    nameRow.appendChild(nameInput);
    body.appendChild(nameRow);
    body.appendChild(nameError);

    // -----------------------------------------------------------------------
    // Ports table
    // -----------------------------------------------------------------------

    const portsSection = document.createElement('div');

    const portsTitle = document.createElement('div');
    portsTitle.textContent = 'Ports:';
    portsTitle.style.fontWeight = 'bold';
    portsTitle.style.marginBottom = '4px';

    portsSection.appendChild(portsTitle);

    const table = document.createElement('table');
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    table.style.fontSize = '0.9em';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const col of ['Label', 'Width', 'Face']) {
      const th = document.createElement('th');
      th.textContent = col;
      th.style.textAlign = 'left';
      th.style.padding = '2px 6px';
      th.style.borderBottom = '1px solid #ccc';
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    portsSection.appendChild(table);
    body.appendChild(portsSection);

    // Build initial port rows from boundary ports
    const portRows: {
      labelInput: HTMLInputElement;
      widthInput: HTMLInputElement;
      faceSelect: HTMLSelectElement;
      tr: HTMLTableRowElement;
    }[] = [];

    function getCurrentPorts(): SubcircuitDialogPort[] {
      return portRows.map(r => ({
        label: r.labelInput.value.trim(),
        bitWidth: Math.max(1, parseInt(r.widthInput.value, 10) || 1),
        face: r.faceSelect.value as 'left' | 'right' | 'top' | 'bottom',
      }));
    }

    function validateAndUpdate(): boolean {
      const ports = getCurrentPorts();

      // Validate name
      const name = nameInput.value.trim();
      let nameValid = true;
      if (!name) {
        nameError.textContent = 'Name is required.';
        nameError.style.display = '';
        nameInput.style.borderColor = '#c00';
        nameValid = false;
      } else if (registry.get(`Subcircuit:${name}`) !== undefined) {
        nameError.textContent = `A subcircuit named "${name}" already exists.`;
        nameError.style.display = '';
        nameInput.style.borderColor = '#c00';
        nameValid = false;
      } else {
        nameError.style.display = 'none';
        nameInput.style.borderColor = '';
      }

      // Validate port labels — must be non-empty and unique
      const labelCounts = new Map<string, number>();
      for (const p of ports) {
        const k = p.label.toLowerCase();
        labelCounts.set(k, (labelCounts.get(k) ?? 0) + 1);
      }

      let portsValid = true;
      for (let i = 0; i < portRows.length; i++) {
        const row = portRows[i];
        const p = ports[i];
        const k = p.label.toLowerCase();
        const empty = p.label.length === 0;
        const dup = !empty && (labelCounts.get(k) ?? 0) > 1;
        if (empty || dup) {
          row.labelInput.style.borderColor = '#c00';
          portsValid = false;
        } else {
          row.labelInput.style.borderColor = '';
        }
      }

      // Update preview
      renderPreview(previewCanvas, name, ports);

      return nameValid && portsValid;
    }

    const portCentroid = computeCentroid(boundaryPorts);

    for (const bp of boundaryPorts) {
      const initialFace = computeFaceFromPosition(bp.position, portCentroid);
      const tr = document.createElement('tr');

      const tdLabel = document.createElement('td');
      tdLabel.style.padding = '2px 6px';
      const labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.value = bp.label;
      labelInput.style.width = '100%';
      labelInput.style.padding = '2px 4px';
      labelInput.style.border = '1px solid #ccc';
      labelInput.style.borderRadius = '2px';
      labelInput.addEventListener('input', validateAndUpdate);
      tdLabel.appendChild(labelInput);

      const tdWidth = document.createElement('td');
      tdWidth.style.padding = '2px 6px';
      const widthInput = document.createElement('input');
      widthInput.type = 'number';
      widthInput.min = '1';
      widthInput.max = '32';
      widthInput.value = String(bp.bitWidth);
      widthInput.style.width = '50px';
      widthInput.style.padding = '2px 4px';
      widthInput.style.border = '1px solid #ccc';
      widthInput.style.borderRadius = '2px';
      widthInput.addEventListener('input', validateAndUpdate);
      tdWidth.appendChild(widthInput);

      const tdFace = document.createElement('td');
      tdFace.style.padding = '2px 6px';
      const faceSelect = document.createElement('select');
      faceSelect.style.padding = '2px 4px';
      faceSelect.style.border = '1px solid #ccc';
      faceSelect.style.borderRadius = '2px';
      for (const face of ['left', 'right', 'top', 'bottom'] as const) {
        const opt = document.createElement('option');
        opt.value = face;
        opt.textContent = face;
        faceSelect.appendChild(opt);
      }
      // Assign initial face from position relative to centroid (already computed in BoundaryPort via extractSubcircuit)
      // We use 'left' as default — the caller sets the face via the BoundaryPort's original position
      faceSelect.value = 'left';
      faceSelect.addEventListener('change', validateAndUpdate);
      tdFace.appendChild(faceSelect);

      tr.appendChild(tdLabel);
      tr.appendChild(tdWidth);
      tr.appendChild(tdFace);
      tbody.appendChild(tr);

      portRows.push({ labelInput, widthInput, faceSelect, tr });
    }

    // -----------------------------------------------------------------------
    // Preview canvas
    // -----------------------------------------------------------------------

    const previewWrapper = document.createElement('div');
    previewWrapper.style.border = '1px solid #ccc';
    previewWrapper.style.borderRadius = '3px';
    previewWrapper.style.padding = '4px';
    previewWrapper.style.textAlign = 'center';
    previewWrapper.style.background = '#f8f8f8';

    const previewLabel = document.createElement('div');
    previewLabel.textContent = 'Preview';
    previewLabel.style.fontSize = '0.8em';
    previewLabel.style.color = '#666';
    previewLabel.style.marginBottom = '4px';

    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = PREVIEW_CANVAS_SIZE;
    previewCanvas.height = PREVIEW_CANVAS_SIZE;
    previewCanvas.style.display = 'block';
    previewCanvas.style.margin = '0 auto';
    previewCanvas.style.maxWidth = '100%';

    previewWrapper.appendChild(previewLabel);
    previewWrapper.appendChild(previewCanvas);
    body.appendChild(previewWrapper);

    // -----------------------------------------------------------------------
    // Buttons
    // -----------------------------------------------------------------------

    const buttonRow = document.createElement('div');
    buttonRow.style.display = 'flex';
    buttonRow.style.justifyContent = 'flex-end';
    buttonRow.style.gap = '8px';
    buttonRow.style.marginTop = '4px';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.padding = '6px 14px';
    cancelBtn.addEventListener('click', () => finish(null));

    const createBtn = document.createElement('button');
    createBtn.textContent = 'Create';
    createBtn.style.padding = '6px 14px';
    createBtn.style.fontWeight = 'bold';
    createBtn.addEventListener('click', () => {
      const valid = validateAndUpdate();
      if (!valid) return;
      const name = nameInput.value.trim();
      const ports = getCurrentPorts();
      finish({ name, ports });
    });

    buttonRow.appendChild(cancelBtn);
    buttonRow.appendChild(createBtn);
    body.appendChild(buttonRow);

    // -----------------------------------------------------------------------
    // Mount and initialize
    // -----------------------------------------------------------------------

    document.body.appendChild(modal.overlay);

    // Initial render (must happen after canvas is in DOM so size is set)
    validateAndUpdate();

    nameInput.focus();

    // Allow Enter to confirm
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') createBtn.click();
      if (e.key === 'Escape') finish(null);
    });
  });
}
