/**
 * Digital-in-Browser: browser-based digital logic circuit simulator.
 * Entry point — initializes the application, wires together the editor,
 * engine, file resolver, and postMessage API.
 */

import { initApp } from './app/app-init.js';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const ctx = initApp();

// ---------------------------------------------------------------------------
// Apply panel visibility
// ---------------------------------------------------------------------------

if (ctx.params.panels === 'none') {
  document.getElementById('app')?.classList.add('panels-none');
}

// ---------------------------------------------------------------------------
// postMessage listener
// ---------------------------------------------------------------------------

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as Record<string, unknown>;
  if (typeof data !== 'object' || data === null) return;

  try {
    handleMessage(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    window.parent.postMessage({ type: 'digital-error', error: message }, '*');
  }
});

function handleMessage(data: Record<string, unknown>): void {
  switch (data['type']) {
    case 'digital-load-url': {
      const url = String(data['url'] ?? '');
      if (!url) {
        window.parent.postMessage({ type: 'digital-error', error: 'No URL provided' }, '*');
        return;
      }
      fetch(url)
        .then((res) => {
          if (!res.ok) throw new Error(`Failed to fetch: ${url}`);
          return res.text();
        })
        .then(() => {
          window.parent.postMessage({ type: 'digital-loaded' }, '*');
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          window.parent.postMessage({ type: 'digital-error', error: msg }, '*');
        });
      break;
    }

    case 'digital-load-data': {
      const encoded = String(data['data'] ?? '');
      if (!encoded) {
        window.parent.postMessage({ type: 'digital-error', error: 'No data provided' }, '*');
        return;
      }
      try {
        atob(encoded);
        window.parent.postMessage({ type: 'digital-loaded' }, '*');
      } catch {
        window.parent.postMessage({ type: 'digital-error', error: 'Invalid base64 data' }, '*');
      }
      break;
    }

    case 'digital-set-base': {
      const basePath = String(data['basePath'] ?? './');
      ctx.params.base = basePath;
      window.parent.postMessage({ type: 'digital-loaded' }, '*');
      break;
    }

    case 'digital-set-locked': {
      const locked = Boolean(data['locked']);
      ctx.params.locked = locked;
      break;
    }

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Speed control UI
// ---------------------------------------------------------------------------

const speedInput = document.getElementById('speed-input') as HTMLInputElement | null;
let currentSpeed = 1000;

const SPEED_MIN = 1;
const SPEED_MAX = 10_000_000;

function clampSpeed(v: number): number {
  return Math.max(SPEED_MIN, Math.min(SPEED_MAX, v));
}

function updateSpeedDisplay(): void {
  if (speedInput) speedInput.value = String(currentSpeed);
}

document.getElementById('btn-speed-div10')?.addEventListener('click', () => {
  currentSpeed = clampSpeed(Math.floor(currentSpeed / 10));
  updateSpeedDisplay();
});

document.getElementById('btn-speed-div2')?.addEventListener('click', () => {
  currentSpeed = clampSpeed(Math.floor(currentSpeed / 2));
  updateSpeedDisplay();
});

document.getElementById('btn-speed-mul2')?.addEventListener('click', () => {
  currentSpeed = clampSpeed(currentSpeed * 2);
  updateSpeedDisplay();
});

document.getElementById('btn-speed-mul10')?.addEventListener('click', () => {
  currentSpeed = clampSpeed(currentSpeed * 10);
  updateSpeedDisplay();
});

speedInput?.addEventListener('change', () => {
  const parsed = Number(speedInput.value);
  if (Number.isFinite(parsed) && parsed > 0) {
    currentSpeed = clampSpeed(parsed);
  }
  updateSpeedDisplay();
});

// ---------------------------------------------------------------------------
// File I/O (standalone mode)
// ---------------------------------------------------------------------------

const fileInput = document.getElementById('file-input') as HTMLInputElement | null;

document.getElementById('btn-open')?.addEventListener('click', () => {
  fileInput?.click();
});

fileInput?.addEventListener('change', () => {
  const file = fileInput?.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    // File loaded into reader.result — future phases wire this to the loader.
  };
  reader.readAsText(file);
});

document.getElementById('btn-save')?.addEventListener('click', () => {
  // Future phases wire serialization here.
});

// ---------------------------------------------------------------------------
// Announce ready
// ---------------------------------------------------------------------------

if (ctx.isIframe) {
  window.parent.postMessage({ type: 'digital-ready' }, '*');
} else {
  window.parent.postMessage({ type: 'digital-ready' }, '*');
}

// ---------------------------------------------------------------------------
// Auto-load circuit from URL parameter
// ---------------------------------------------------------------------------

if (ctx.params.file) {
  const fileUrl = `${ctx.params.base}${ctx.params.file}`;
  fetch(fileUrl)
    .then((res) => {
      if (!res.ok) throw new Error(`Failed to fetch: ${fileUrl}`);
      return res.text();
    })
    .then(() => {
      window.parent.postMessage({ type: 'digital-loaded' }, '*');
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      window.parent.postMessage({ type: 'digital-error', error: msg }, '*');
    });
}
