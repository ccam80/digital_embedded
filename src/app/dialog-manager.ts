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

  function close(): void {
    overlay.remove();
    onClose?.();
  }

  return { overlay, dialog, header, body, close };
}
