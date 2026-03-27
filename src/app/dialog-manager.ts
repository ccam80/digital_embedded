/**
 * Shared modal dialog scaffolding utility.
 *
 * Creates the overlay + dialog + header + body structure used by all modal
 * dialogs in app-init.ts. Callers append the overlay to document.body and
 * populate the body div with dialog-specific content.
 */

export interface ModalResult {
  overlay: HTMLDivElement;
  dialog: HTMLDivElement;
  header: HTMLDivElement;
  body: HTMLDivElement;
  close: () => void;
}

export function createModal(opts: {
  title: string;
  className?: string;
  overlayClassName?: string;
  onClose?: () => void;
}): ModalResult {
  const { title, onClose } = opts;
  const className = opts.className ?? 'modal-dialog';
  const overlayClassName = opts.overlayClassName ?? `${className}-overlay`;

  const overlay = document.createElement('div');
  overlay.className = overlayClassName;

  const dialog = document.createElement('div');
  dialog.className = className;

  const header = document.createElement('div');
  header.className = `${className}-header`;

  const titleSpan = document.createElement('span');
  titleSpan.textContent = title;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'prop-popup-close';
  closeBtn.textContent = '\u00d7';
  closeBtn.addEventListener('click', close);

  header.appendChild(titleSpan);
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = `${className}-body`;

  dialog.appendChild(header);
  dialog.appendChild(body);
  overlay.appendChild(dialog);

  overlay.addEventListener('pointerdown', (ev) => {
    if (ev.target === overlay) close();
  });

  // --- Drag support: header acts as drag handle ---
  header.style.cursor = 'move';
  header.style.userSelect = 'none';
  let dragStartX = 0;
  let dragStartY = 0;
  let dialogStartX = 0;
  let dialogStartY = 0;
  let dragging = false;

  header.addEventListener('pointerdown', (ev: PointerEvent) => {
    // Don't start drag if clicking the close button
    if ((ev.target as HTMLElement).tagName === 'BUTTON') return;
    dragging = true;
    dragStartX = ev.clientX;
    dragStartY = ev.clientY;
    const rect = dialog.getBoundingClientRect();
    dialogStartX = rect.left;
    dialogStartY = rect.top;
    // Switch to absolute positioning on first drag
    if (!dialog.style.position || dialog.style.position !== 'absolute') {
      dialog.style.position = 'absolute';
      dialog.style.left = `${dialogStartX}px`;
      dialog.style.top = `${dialogStartY}px`;
      dialog.style.margin = '0';
    }
    header.setPointerCapture(ev.pointerId);
  });

  header.addEventListener('pointermove', (ev: PointerEvent) => {
    if (!dragging) return;
    const dx = ev.clientX - dragStartX;
    const dy = ev.clientY - dragStartY;
    dialog.style.left = `${dialogStartX + dx}px`;
    dialog.style.top = `${dialogStartY + dy}px`;
  });

  header.addEventListener('pointerup', () => {
    dragging = false;
  });

  // --- Edge-resize support ---
  const EDGE_ZONE = 8; // px from edge that triggers resize cursor
  type ResizeEdge = '' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
  let resizeEdge: ResizeEdge = '';
  let resizing = false;
  let resizeStartX = 0;
  let resizeStartY = 0;
  let resizeStartRect = { left: 0, top: 0, width: 0, height: 0 };

  function hitEdge(ev: PointerEvent): ResizeEdge {
    const rect = dialog.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const w = rect.width;
    const h = rect.height;

    const left = x < EDGE_ZONE;
    const right = x > w - EDGE_ZONE;
    const top = y < EDGE_ZONE;
    const bottom = y > h - EDGE_ZONE;

    if (top && left) return 'nw';
    if (top && right) return 'ne';
    if (bottom && left) return 'sw';
    if (bottom && right) return 'se';
    if (top) return 'n';
    if (bottom) return 's';
    if (left) return 'w';
    if (right) return 'e';
    return '';
  }

  const cursorMap: Record<ResizeEdge, string> = {
    '': '', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
    ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
  };

  function ensureAbsolutePositioning(): void {
    if (!dialog.style.position || dialog.style.position !== 'absolute') {
      const rect = dialog.getBoundingClientRect();
      dialog.style.position = 'absolute';
      dialog.style.left = `${rect.left}px`;
      dialog.style.top = `${rect.top}px`;
      dialog.style.margin = '0';
    }
  }

  dialog.addEventListener('pointermove', (ev: PointerEvent) => {
    if (resizing || dragging) return;
    const edge = hitEdge(ev);
    dialog.style.cursor = cursorMap[edge] || '';
  });

  dialog.addEventListener('pointerdown', (ev: PointerEvent) => {
    const edge = hitEdge(ev);
    if (!edge) return;
    ev.stopPropagation();
    resizing = true;
    resizeEdge = edge;
    resizeStartX = ev.clientX;
    resizeStartY = ev.clientY;
    ensureAbsolutePositioning();
    const rect = dialog.getBoundingClientRect();
    resizeStartRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    dialog.setPointerCapture(ev.pointerId);
  });

  dialog.addEventListener('pointermove', (ev: PointerEvent) => {
    if (!resizing) return;
    const dx = ev.clientX - resizeStartX;
    const dy = ev.clientY - resizeStartY;
    const MIN_W = 200;
    const MIN_H = 120;

    let { left, top, width, height } = resizeStartRect;

    if (resizeEdge.includes('e')) width = Math.max(MIN_W, width + dx);
    if (resizeEdge.includes('w')) {
      const newW = Math.max(MIN_W, width - dx);
      left = left + (width - newW);
      width = newW;
    }
    if (resizeEdge.includes('s')) height = Math.max(MIN_H, height + dy);
    if (resizeEdge.includes('n')) {
      const newH = Math.max(MIN_H, height - dy);
      top = top + (height - newH);
      height = newH;
    }

    dialog.style.left = `${left}px`;
    dialog.style.top = `${top}px`;
    dialog.style.width = `${width}px`;
    dialog.style.height = `${height}px`;
  });

  dialog.addEventListener('pointerup', () => {
    resizing = false;
    resizeEdge = '';
  });

  function close(): void {
    overlay.remove();
    onClose?.();
  }

  return { overlay, dialog, header, body, close };
}
