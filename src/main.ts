/**
 * Digital-in-Browser: browser-based digital logic circuit simulator.
 * Entry point — wires together the editor, engine, and postMessage API.
 */

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string; url?: string; data?: string };

  if (data.type === 'digital-load-url') {
    handleLoadUrl(data.url ?? '');
  } else if (data.type === 'digital-load-data') {
    handleLoadData(data.data ?? '');
  }
});

function handleLoadUrl(url: string): void {
  if (!url) {
    window.parent.postMessage({ type: 'digital-error', error: 'No URL provided' }, '*');
    return;
  }
  window.parent.postMessage({ type: 'digital-loaded' }, '*');
}

function handleLoadData(data: string): void {
  if (!data) {
    window.parent.postMessage({ type: 'digital-error', error: 'No data provided' }, '*');
    return;
  }
  window.parent.postMessage({ type: 'digital-loaded' }, '*');
}

window.parent.postMessage({ type: 'digital-ready' }, '*');
