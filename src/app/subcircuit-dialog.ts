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
import { drawDefaultShape, drawDILShape, drawLayoutShape } from '../components/subcircuit/shape-renderer.js';
import { CanvasRenderer } from '../editor/canvas-renderer.js';
import { lightColorScheme } from '../core/renderer-interface.js';
import { PinDirection } from '../core/pin.js';
import type { PinDeclaration } from '../core/pin.js';
import type { ComponentRegistry } from '../core/registry.js';
import { GRID_SPACING } from '../editor/coordinates.js';

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
  shapeMode: 'DIL' | 'LAYOUT';
  chipWidth: number;
  chipHeight: number;
}

// ---------------------------------------------------------------------------
// Preview rendering
// ---------------------------------------------------------------------------

const PREVIEW_CANVAS_SIZE = 240;

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
 * Compute chip width and height (in grid units) for the given shape mode.
 *
 * DEFAULT/SIMPLE/DIL: width = chipWidth, height = max side pin count.
 * LAYOUT: width/height are at least chipWidth/chipHeight, expanded if pins need more room.
 */
function computePreviewDimensions(
  pins: PinDeclaration[],
  shapeMode: string,
  chipWidth: number,
  chipHeight: number,
): { width: number; height: number } {
  const counts = countPinsByFace(pins);
  if (shapeMode === 'LAYOUT') {
    return {
      width: Math.max(counts.top + 1, counts.bottom + 1, chipWidth),
      height: Math.max(counts.left + 1, counts.right + 1, chipHeight),
    };
  }
  // DEFAULT / SIMPLE / DIL — non-right pins go on the left side in the preview
  const leftSide = counts.left + counts.top + counts.bottom;
  const sideH = Math.max(leftSide, counts.right, 1);
  return { width: chipWidth, height: sideH };
}

/**
 * Assign x/y positions to pins based on shape mode.
 *
 * DEFAULT/SIMPLE/DIL: inputs on left (x=0), outputs on right (x=width).
 * LAYOUT: pins distributed evenly across their declared face (all 4 faces).
 */
function positionPreviewPins(
  pins: PinDeclaration[],
  width: number,
  height: number,
  shapeMode: string,
): PinDeclaration[] {
  if (shapeMode === 'LAYOUT') {
    return positionLayoutPins(pins, width, height);
  }
  // DEFAULT / SIMPLE / DIL — left/right only
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
 * Distribute pins across all four faces for LAYOUT mode.
 * Matches Digital's LayoutShape.PinList.createPosition() algorithm.
 */
function positionLayoutPins(
  pins: PinDeclaration[],
  width: number,
  height: number,
): PinDeclaration[] {
  type FaceKey = 'left' | 'right' | 'top' | 'bottom';
  const groups: Record<FaceKey, PinDeclaration[]> = {
    left: [], right: [], top: [], bottom: [],
  };
  for (const pin of pins) {
    const face: FaceKey = (pin.face as FaceKey) ??
      (pin.direction === PinDirection.INPUT ? 'left' : 'right');
    groups[face].push(pin);
  }

  function distribute(n: number, length: number): number[] {
    if (n === 0) return [];
    if (n === 1) return [Math.floor(length / 2)];
    const delta = Math.floor((length + 2) / (n + 1));
    const span = delta * (n - 1);
    const start = Math.floor((length - span) / 2);
    return Array.from({ length: n }, (_, i) => start + i * delta);
  }

  const positioned: PinDeclaration[] = [];

  const leftY = distribute(groups.left.length, height);
  groups.left.forEach((p, i) => {
    positioned.push({ ...p, position: { x: 0, y: leftY[i] } });
  });

  const rightY = distribute(groups.right.length, height);
  groups.right.forEach((p, i) => {
    positioned.push({ ...p, position: { x: width, y: rightY[i] } });
  });

  const topX = distribute(groups.top.length, width);
  groups.top.forEach((p, i) => {
    positioned.push({ ...p, face: 'top', position: { x: topX[i], y: 0 } });
  });

  const bottomX = distribute(groups.bottom.length, width);
  groups.bottom.forEach((p, i) => {
    positioned.push({ ...p, face: 'bottom', position: { x: bottomX[i], y: height } });
  });

  return positioned;
}

/** Transform state from the last renderPreview call, used for hit-testing pin drags. */
interface PreviewTransform {
  offsetX: number;
  offsetY: number;
  scale: number;
  chipWidth: number;
  chipHeight: number;
  positionedPins: PinDeclaration[];
}

/**
 * Render a chip preview onto the offscreen canvas using the selected shape mode.
 * Returns the transform state for hit-testing.
 */
function renderPreview(
  canvas: HTMLCanvasElement,
  name: string,
  ports: SubcircuitDialogPort[],
  shapeMode: string,
  chipWidth: number,
  chipHeight: number,
): PreviewTransform {
  const ctx2d = canvas.getContext('2d');
  const empty: PreviewTransform = { offsetX: 0, offsetY: 0, scale: 1, chipWidth: 0, chipHeight: 0, positionedPins: [] };
  if (!ctx2d) return empty;

  ctx2d.clearRect(0, 0, canvas.width, canvas.height);

  const pins = buildPreviewPins(ports);
  const { width, height } = computePreviewDimensions(pins, shapeMode, chipWidth, chipHeight);
  const positionedPins = positionPreviewPins(pins, width, height, shapeMode);

  const renderer = new CanvasRenderer(ctx2d, lightColorScheme);

  // Scale and center: fit (width+2) x (height+2) grid units into the canvas
  const padX = 2;
  const padY = shapeMode === 'LAYOUT' ? 2 : 1;
  const scaleX = canvas.width / ((width + padX) * GRID_SPACING);
  const scaleY = canvas.height / ((height + padY) * GRID_SPACING);
  const scale = Math.min(scaleX, scaleY, 1) * GRID_SPACING;

  const totalW = (width + padX) * scale;
  const totalH = (height + padY) * scale;
  const offsetX = (canvas.width - totalW) / 2 + (padX / 2) * scale;
  const offsetY = (canvas.height - totalH) / 2 + (padY / 2) * scale;

  ctx2d.save();
  ctx2d.translate(offsetX, offsetY);
  ctx2d.scale(scale, scale);
  renderer.setGridScale(scale);

  const displayName = name || 'Subcircuit';
  switch (shapeMode) {
    case 'DIL':
      drawDILShape(renderer, displayName, positionedPins, width, height, 0);
      break;
    case 'LAYOUT':
      drawLayoutShape(renderer, displayName, positionedPins, width, height, 0);
      break;
    default:
      drawDefaultShape(renderer, displayName, positionedPins, width, height, 0);
      break;
  }

  ctx2d.restore();

  return { offsetX, offsetY, scale, chipWidth: width, chipHeight: height, positionedPins };
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
 * Generate the next available subcircuit name like "subcircuit_1", "subcircuit_2", etc.
 */
function generateAutoName(registry: ComponentRegistry): string {
  let n = 1;
  while (registry.get(`subcircuit_${n}`) !== undefined) {
    n++;
  }
  return `subcircuit_${n}`;
}

/**
 * Open the "Create Subcircuit" modal dialog.
 *
 * @param boundaryPorts     Auto-derived boundary ports from analyzeBoundary().
 * @param registry          Registry for checking name uniqueness.
 * @param selectedElements  Selected elements — Port elements found here are added to the port table.
 * @param existingName      If provided, pre-fills the name (for editing existing subcircuits).
 * @returns                 Promise resolving to the confirmed result or null.
 */
export function openSubcircuitDialog(
  boundaryPorts: BoundaryPort[],
  registry: ComponentRegistry,
  selectedElements?: import('../core/element.js').CircuitElement[],
  existingName?: string,
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
    nameInput.value = existingName ?? generateAutoName(registry);
    nameInput.placeholder = 'MySubcircuit';
    nameInput.style.flex = '1';
    nameInput.style.padding = '4px 6px';

    const nameError = document.createElement('span');
    nameError.style.color = '#c00';
    nameError.style.fontSize = '0.85em';
    nameError.style.display = 'none';

    nameRow.appendChild(nameLabel);
    nameRow.appendChild(nameInput);
    body.appendChild(nameRow);
    body.appendChild(nameError);

    // -----------------------------------------------------------------------
    // Symbol shape and size controls
    // -----------------------------------------------------------------------

    const symbolSection = document.createElement('div');
    symbolSection.style.display = 'flex';
    symbolSection.style.gap = '12px';
    symbolSection.style.alignItems = 'center';
    symbolSection.style.flexWrap = 'wrap';

    // Shape mode
    const shapeLabel = document.createElement('label');
    shapeLabel.textContent = 'Shape:';
    shapeLabel.style.fontWeight = 'bold';
    shapeLabel.style.minWidth = '60px';
    const shapeSelect = document.createElement('select');
    shapeSelect.style.padding = '4px 6px';
    for (const mode of ['LAYOUT', 'DIL'] as const) {
      const opt = document.createElement('option');
      opt.value = mode;
      opt.textContent = mode.charAt(0) + mode.slice(1).toLowerCase();
      shapeSelect.appendChild(opt);
    }
    shapeSelect.value = 'LAYOUT';
    shapeSelect.addEventListener('change', validateAndUpdate);
    symbolSection.appendChild(shapeLabel);
    symbolSection.appendChild(shapeSelect);

    // Chip width
    const widthLabel = document.createElement('label');
    widthLabel.textContent = 'W:';
    widthLabel.title = 'Chip width in grid units';
    const chipWidthInput = document.createElement('input');
    chipWidthInput.type = 'number';
    chipWidthInput.min = '2';
    chipWidthInput.max = '20';
    chipWidthInput.value = '3';
    chipWidthInput.style.width = '45px';
    chipWidthInput.style.padding = '4px 6px';
    chipWidthInput.title = 'Chip width in grid units';
    chipWidthInput.addEventListener('input', validateAndUpdate);
    symbolSection.appendChild(widthLabel);
    symbolSection.appendChild(chipWidthInput);

    // Chip height
    const heightLabel = document.createElement('label');
    heightLabel.textContent = 'H:';
    heightLabel.title = 'Chip height in grid units';
    const chipHeightInput = document.createElement('input');
    chipHeightInput.type = 'number';
    chipHeightInput.min = '1';
    chipHeightInput.max = '40';
    chipHeightInput.value = '3';
    chipHeightInput.style.width = '45px';
    chipHeightInput.style.padding = '4px 6px';
    chipHeightInput.title = 'Chip height in grid units';
    chipHeightInput.addEventListener('input', validateAndUpdate);
    symbolSection.appendChild(heightLabel);
    symbolSection.appendChild(chipHeightInput);

    body.appendChild(symbolSection);

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
    for (const col of ['Label', 'Bits', 'Face']) {
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

    // Transform state for pin drag hit-testing (assigned by validateAndUpdate)
    let lastTransform: PreviewTransform = {
      offsetX: 0, offsetY: 0, scale: 1, chipWidth: 0, chipHeight: 0, positionedPins: [],
    };

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
      } else if (name !== existingName && registry.get(name) !== undefined) {
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

      // Sync width/height inputs to match the pin-derived minimum dimensions
      const mode = shapeSelect.value;
      const pins = buildPreviewPins(ports);
      const counts = countPinsByFace(pins);
      if (mode === 'LAYOUT') {
        const minW = Math.max(counts.top + 1, counts.bottom + 1, 2);
        const minH = Math.max(counts.left + 1, counts.right + 1, 1);
        const curW = parseInt(chipWidthInput.value, 10) || 2;
        const curH = parseInt(chipHeightInput.value, 10) || 1;
        if (curW < minW) chipWidthInput.value = String(minW);
        if (curH < minH) chipHeightInput.value = String(minH);
      } else {
        const minH = Math.max(counts.left, counts.right, 1);
        chipHeightInput.value = String(minH);
      }

      // Update preview with current shape settings
      const cw = Math.max(2, parseInt(chipWidthInput.value, 10) || 3);
      const ch = Math.max(1, parseInt(chipHeightInput.value, 10) || 3);
      lastTransform = renderPreview(previewCanvas, name, ports, mode, cw, ch);

      return nameValid && portsValid;
    }

    // Collect Port elements from the selection that aren't already represented
    // in the boundary ports (boundary ports come from wires crossing the boundary;
    // Port elements IN the selection need to be included separately).
    type PortEntry = { label: string; bitWidth: number; face: Face };
    const allPorts: PortEntry[] = [];

    const portCentroid = computeCentroid(boundaryPorts);

    for (const bp of boundaryPorts) {
      const initialFace = computeFaceFromPosition(bp.position, portCentroid);
      allPorts.push({ label: bp.label, bitWidth: bp.bitWidth, face: initialFace });
    }

    // Add Port elements from the selection
    if (selectedElements) {
      const boundaryLabels = new Set(boundaryPorts.map(bp => bp.label));
      for (const el of selectedElements) {
        if (el.typeId === 'Port') {
          const label = el.getProperties().getOrDefault<string>('label', '');
          if (label && !boundaryLabels.has(label)) {
            const bitWidth = el.getProperties().getOrDefault<number>('bitWidth', 1);
            const face = el.getProperties().getOrDefault<string>('face', 'left') as Face;
            allPorts.push({ label, bitWidth, face });
          }
        }
      }
    }

    for (const portEntry of allPorts) {
      const tr = document.createElement('tr');

      const tdLabel = document.createElement('td');
      tdLabel.style.padding = '2px 6px';
      const labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.value = portEntry.label;
      labelInput.style.width = '100%';
      labelInput.style.padding = '2px 4px';
      labelInput.addEventListener('input', validateAndUpdate);
      tdLabel.appendChild(labelInput);

      const tdWidth = document.createElement('td');
      tdWidth.style.padding = '2px 6px';
      const widthInput = document.createElement('input');
      widthInput.type = 'number';
      widthInput.min = '1';
      widthInput.max = '32';
      widthInput.value = String(portEntry.bitWidth);
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
      faceSelect.value = portEntry.face;
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
    // Pin drag interaction on preview canvas
    // -----------------------------------------------------------------------

    let dragPinIndex = -1;
    let pinDragging = false;

    /** Convert canvas pixel coords to grid coords using the current preview transform. */
    function canvasToGrid(canvasX: number, canvasY: number): { gx: number; gy: number } {
      const { offsetX, offsetY, scale } = lastTransform;
      return {
        gx: (canvasX - offsetX) / scale,
        gy: (canvasY - offsetY) / scale,
      };
    }

    /** Find the nearest pin index within a hit radius (in grid units). */
    function hitTestPin(gx: number, gy: number): number {
      const HIT_RADIUS = 0.8;
      let bestDist = HIT_RADIUS;
      let bestIdx = -1;
      for (let i = 0; i < lastTransform.positionedPins.length; i++) {
        const pin = lastTransform.positionedPins[i];
        const dx = gx - pin.position.x;
        const dy = gy - pin.position.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }
      return bestIdx;
    }

    /** Determine which face a grid point is closest to on the chip rectangle. */
    function faceFromGridPos(gx: number, gy: number): Face {
      const { chipWidth: w, chipHeight: h } = lastTransform;
      // Distances to each edge
      const dLeft = gx;
      const dRight = w - gx;
      const dTop = gy;
      const dBottom = h - gy;
      const min = Math.min(dLeft, dRight, dTop, dBottom);
      if (min === dLeft) return 'left';
      if (min === dRight) return 'right';
      if (min === dTop) return 'top';
      return 'bottom';
    }

    previewCanvas.style.cursor = 'default';
    previewCanvas.style.touchAction = 'none';

    previewCanvas.addEventListener('pointerdown', (ev: PointerEvent) => {
      const rect = previewCanvas.getBoundingClientRect();
      const cx = (ev.clientX - rect.left) * (previewCanvas.width / rect.width);
      const cy = (ev.clientY - rect.top) * (previewCanvas.height / rect.height);
      const { gx, gy } = canvasToGrid(cx, cy);

      const idx = hitTestPin(gx, gy);
      if (idx < 0) return;

      pinDragging = true;
      dragPinIndex = idx;
      previewCanvas.setPointerCapture(ev.pointerId);
      previewCanvas.style.cursor = 'grabbing';
    });

    previewCanvas.addEventListener('pointermove', (ev: PointerEvent) => {
      const rect = previewCanvas.getBoundingClientRect();
      const cx = (ev.clientX - rect.left) * (previewCanvas.width / rect.width);
      const cy = (ev.clientY - rect.top) * (previewCanvas.height / rect.height);
      const { gx, gy } = canvasToGrid(cx, cy);

      if (!pinDragging) {
        // Hover cursor
        previewCanvas.style.cursor = hitTestPin(gx, gy) >= 0 ? 'grab' : 'default';
        return;
      }

      // Update the face select for the dragged pin
      if (dragPinIndex >= 0 && dragPinIndex < portRows.length) {
        const newFace = faceFromGridPos(gx, gy);
        const row = portRows[dragPinIndex];
        if (row.faceSelect.value !== newFace) {
          row.faceSelect.value = newFace;
          validateAndUpdate();
        }
      }
    });

    previewCanvas.addEventListener('pointerup', () => {
      pinDragging = false;
      dragPinIndex = -1;
      previewCanvas.style.cursor = 'default';
    });

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
      const shapeMode = shapeSelect.value as 'DIL' | 'LAYOUT';
      const chipWidth = Math.max(2, parseInt(chipWidthInput.value, 10) || 3);
      const chipHeight = Math.max(1, parseInt(chipHeightInput.value, 10) || 3);
      finish({ name, ports, shapeMode, chipWidth, chipHeight });
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
