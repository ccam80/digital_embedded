/**
 * Convergence Log Panel -- modal dialog for visualizing convergence step records.
 *
 * Opens on user request (Analysis > Convergence Log...) or automatically when
 * the analog engine hits stagnation. Shows per-step NR iteration data, LTE
 * rejection info, and method switches with expandable per-attempt detail rows.
 */

import type { AppContext } from './app-context.js';
import { createModal } from './dialog-manager.js';
import type { StepRecord } from '../solver/analog/convergence-log.js';
import type { SimulationCoordinator } from '../solver/coordinator-types.js';

// ---------------------------------------------------------------------------
// Module-level logging state — persists across recompiles
// ---------------------------------------------------------------------------

let _loggingDesired = false;

// ---------------------------------------------------------------------------
// CSV export helpers
// ---------------------------------------------------------------------------

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

function buildCsv(records: StepRecord[]): string {
  const headers = [
    'stepNumber', 'simTime_s', 'entryDt_s', 'acceptedDt_s',
    'entryMethod', 'exitMethod', 'totalNRIters',
    'lteWorstRatio', 'lteProposedDt_s', 'lteRejected', 'outcome',
    'attemptIndex', 'attemptTrigger', 'attemptDt_s', 'attemptMethod',
    'attemptIterations', 'attemptConverged', 'attemptBlameElement', 'attemptBlameNode',
  ];
  const rows: string[] = [headers.join(',')];

  for (const rec of records) {
    const totalIters = rec.attempts.reduce((sum, a) => sum + a.iterations, 0);
    const base = [
      String(rec.stepNumber),
      String(rec.simTime),
      String(rec.entryDt),
      String(rec.acceptedDt),
      rec.entryMethod,
      rec.exitMethod,
      String(totalIters),
      String(rec.lteWorstRatio),
      String(rec.lteProposedDt),
      rec.lteRejected ? 'true' : 'false',
      rec.outcome,
    ];

    if (rec.attempts.length === 0) {
      rows.push([...base, '', '', '', '', '', '', '', ''].map(csvEscape).join(','));
    } else {
      for (let i = 0; i < rec.attempts.length; i++) {
        const att = rec.attempts[i]!;
        const attCells = [
          String(i),
          att.trigger,
          String(att.dt),
          att.method,
          String(att.iterations),
          att.converged ? 'true' : 'false',
          String(att.blameElement),
          String(att.blameNode),
        ];
        rows.push([...base, ...attCells].map(csvEscape).join(','));
      }
    }
  }

  return rows.join('\r\n');
}

function downloadTextFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function makeTimestampedFilename(ext: string): string {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  const datePart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `convergence-log-${datePart}-${timePart}.${ext}`;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatSimTime(t: number): string {
  const abs = Math.abs(t);
  if (abs === 0) return '0s';
  if (abs < 1e-9) return (t * 1e12).toPrecision(4) + 'ps';
  if (abs < 1e-6) return (t * 1e9).toPrecision(4) + 'ns';
  if (abs < 1e-3) return (t * 1e6).toPrecision(4) + '\u00b5s';
  if (abs < 1) return (t * 1e3).toPrecision(4) + 'ms';
  return t.toPrecision(4) + 's';
}

function formatMethod(m: string): string {
  switch (m) {
    case 'trapezoidal': return 'Trap';
    case 'bdf1': return 'BDF-1';
    case 'bdf2': return 'BDF-2';
    default: return m;
  }
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

function renderTable(container: HTMLElement, records: StepRecord[], coord: SimulationCoordinator): void {
  container.innerHTML = '';

  if (records.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'conv-empty';
    empty.textContent = 'No convergence records yet. Enable logging and run the simulation.';
    container.appendChild(empty);
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'overflow:auto;flex:1;';

  const table = document.createElement('table');
  table.className = 'conv-table';

  const thead = document.createElement('thead');
  const hRow = document.createElement('tr');
  for (const col of ['#', 'simTime', 'dt', 'Method', 'NR Iters', 'LTE', 'Outcome']) {
    const th = document.createElement('th');
    th.textContent = col;
    hRow.appendChild(th);
  }
  thead.appendChild(hRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  for (const rec of records) {
    const isError = rec.outcome === 'error';
    const isRetried = rec.attempts.length > 1 && rec.outcome === 'accepted';
    const totalIters = rec.attempts.reduce((sum, a) => sum + a.iterations, 0);
    const methodLabel = rec.entryMethod === rec.exitMethod
      ? formatMethod(rec.entryMethod)
      : formatMethod(rec.entryMethod) + '\u2192' + formatMethod(rec.exitMethod);

    const tr = document.createElement('tr');
    tr.className = 'conv-row-expandable';
    if (isError) tr.classList.add('conv-row-error');
    else if (isRetried) tr.classList.add('conv-row-retry');

    const cells = [
      String(rec.stepNumber),
      formatSimTime(rec.simTime),
      formatSimTime(rec.entryDt),
      methodLabel,
      String(totalIters),
      rec.lteWorstRatio > 0 ? rec.lteWorstRatio.toFixed(3) : '\u2014',
      rec.outcome,
    ];

    for (let i = 0; i < cells.length; i++) {
      const td = document.createElement('td');
      td.textContent = cells[i]!;
      if (i === 6) {
        td.className = isError ? 'conv-outcome-error' : 'conv-outcome-ok';
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);

    const detailRows: HTMLTableRowElement[] = [];
    let expanded = false;

    for (const attempt of rec.attempts) {
      const atr = document.createElement('tr');
      atr.className = 'conv-attempt-row';
      if (!attempt.converged) atr.classList.add('conv-attempt-failed');
      atr.style.display = 'none';

      const triggerCell = document.createElement('td');
      triggerCell.colSpan = 7;
      const blameLabel = attempt.blameElement >= 0 ? coord.getElementLabel?.(attempt.blameElement) : undefined;
      const blameStr = blameLabel ? ' blame=' + blameLabel : (attempt.blameElement >= 0 ? ' blame=el[' + attempt.blameElement + ']' : '');
      triggerCell.textContent =
        '  \u25b8 ' + attempt.trigger + ': dt=' + formatSimTime(attempt.dt) +
        ' method=' + formatMethod(attempt.method) +
        ' iters=' + attempt.iterations +
        ' ' + (attempt.converged ? 'converged' : 'failed') + blameStr;
      atr.appendChild(triggerCell);
      tbody.appendChild(atr);
      detailRows.push(atr);
    }

    if (rec.lteRejected) {
      const ltr = document.createElement('tr');
      ltr.className = 'conv-attempt-row';
      ltr.style.display = 'none';
      const lteTd = document.createElement('td');
      lteTd.colSpan = 7;
      lteTd.textContent =
        '  \u25b8 LTE rejected: ratio=' + rec.lteWorstRatio.toFixed(3) +
        ' proposedDt=' + formatSimTime(rec.lteProposedDt);
      ltr.appendChild(lteTd);
      tbody.appendChild(ltr);
      detailRows.push(ltr);
    }

    if (detailRows.length > 0) {
      tr.addEventListener('click', () => {
        expanded = !expanded;
        for (const dr of detailRows) {
          dr.style.display = expanded ? '' : 'none';
        }
      });
    }
  }

  table.appendChild(tbody);
  wrapper.appendChild(table);
  container.appendChild(wrapper);
}

// ---------------------------------------------------------------------------
// openConvergenceLogPanel
// ---------------------------------------------------------------------------

export function openConvergenceLogPanel(ctx: AppContext): void {
  function getCoord() { return ctx.facade.getCoordinator(); }

  // Auto-enable logging when panel opens
  if (getCoord().supportsConvergenceLog()) {
    _loggingDesired = true;
    getCoord().setConvergenceLogEnabled(true);
  }

  let _logEnabled = getCoord().supportsConvergenceLog() && _loggingDesired;
  let refreshInterval = -1;

  const { overlay, body } = createModal({
    title: 'Convergence Log',
    className: 'convergence-log-dialog',
    overlayClassName: 'convergence-log-dialog-overlay',
    onClose: () => {
      if (refreshInterval !== -1) {
        clearInterval(refreshInterval);
        refreshInterval = -1;
      }
    },
  });

  let _noticeTimer = -1;
  const noticeEl = document.createElement('div');
  noticeEl.className = 'conv-notice';
  noticeEl.style.cssText = 'display:none;padding:4px 8px;background:#fffbe6;border:1px solid #e6c700;color:#5a4a00;font-size:0.85em;';

  function showPanelNotification(msg: string): void {
    noticeEl.textContent = msg;
    noticeEl.style.display = '';
    if (_noticeTimer !== -1) clearTimeout(_noticeTimer);
    _noticeTimer = window.setTimeout(() => {
      noticeEl.style.display = 'none';
      _noticeTimer = -1;
    }, 6000);
  }

  function tryDisableLog(): void {
    try {
      getCoord().setConvergenceLogEnabled(false);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("comparison harness")) {
        showPanelNotification(
          "Convergence log cannot be disabled while a comparison harness is running. " +
          "The log will remain enabled until the harness session ends."
        );
        return;
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Toolbar
  // -------------------------------------------------------------------------

  const toolbar = document.createElement('div');
  toolbar.className = 'conv-toolbar';

  const toggleBtn = document.createElement('button');

  function updateToggleBtn(): void {
    toggleBtn.textContent = _logEnabled ? 'Disable' : 'Enable';
    if (_logEnabled) {
      toggleBtn.classList.add('active');
    } else {
      toggleBtn.classList.remove('active');
    }
  }

  updateToggleBtn();
  toggleBtn.addEventListener('click', () => {
    _logEnabled = !_logEnabled;
    _loggingDesired = _logEnabled;
    if (getCoord().supportsConvergenceLog()) {
      if (_logEnabled) {
        getCoord().setConvergenceLogEnabled(true);
      } else {
        tryDisableLog();
      }
    }
    updateToggleBtn();
    refreshRecords();
  });

  const refreshBtn = document.createElement('button');
  refreshBtn.textContent = 'Refresh';
  refreshBtn.addEventListener('click', () => refreshRecords());

  const clearBtn = document.createElement('button');
  clearBtn.textContent = 'Clear';
  clearBtn.addEventListener('click', () => {
    if (getCoord().supportsConvergenceLog()) {
      getCoord().clearConvergenceLog();
    }
    refreshRecords();
  });

  const lastNLabel = document.createElement('span');
  lastNLabel.textContent = 'Show last:';
  lastNLabel.style.marginLeft = '8px';

  const lastNSelect = document.createElement('select');
  for (const entry of [['20', '20'], ['50', '50'], ['100', '100'], ['All', '0']] as [string, string][]) {
    const opt = document.createElement('option');
    opt.value = entry[1];
    opt.textContent = entry[0];
    if (entry[1] === '50') opt.selected = true;
    lastNSelect.appendChild(opt);
  }
  lastNSelect.addEventListener('change', () => refreshRecords());

  const saveLogBtn = document.createElement('button');
  saveLogBtn.textContent = 'Save Log';
  saveLogBtn.title = 'Save all visible log entries as CSV';
  saveLogBtn.addEventListener('click', () => {
    const coord = getCoord();
    if (!coord.supportsConvergenceLog()) return;
    const lastN = parseInt(lastNSelect.value, 10);
    const records = lastN > 0
      ? (coord.getConvergenceLog(lastN) ?? [])
      : (coord.getConvergenceLog() ?? []);
    if (records.length === 0) return;
    const csv = buildCsv(records);
    downloadTextFile(csv, makeTimestampedFilename('csv'), 'text/csv;charset=utf-8;');
  });

  toolbar.appendChild(toggleBtn);
  toolbar.appendChild(refreshBtn);
  toolbar.appendChild(clearBtn);
  toolbar.appendChild(saveLogBtn);
  toolbar.appendChild(lastNLabel);
  toolbar.appendChild(lastNSelect);
  toolbar.appendChild(noticeEl);

  // -------------------------------------------------------------------------
  // Table container
  // -------------------------------------------------------------------------

  const tableContainer = document.createElement('div');
  tableContainer.style.cssText = 'flex:1;overflow:auto;display:flex;flex-direction:column;';

  // -------------------------------------------------------------------------
  // Refresh logic
  // -------------------------------------------------------------------------

  function refreshRecords(): void {
    const coord = getCoord();

    // Re-apply desired logging state to the live coordinator (catches recompiles)
    if (coord.supportsConvergenceLog()) {
      if (_loggingDesired) {
        coord.setConvergenceLogEnabled(true);
      } else {
        tryDisableLog();
      }
      _logEnabled = _loggingDesired;
      updateToggleBtn();
    }

    if (!coord.supportsConvergenceLog()) {
      tableContainer.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'conv-empty';
      empty.textContent = 'Convergence logging requires an analog circuit.';
      tableContainer.appendChild(empty);
      return;
    }

    const lastN = parseInt(lastNSelect.value, 10);
    const records = lastN > 0
      ? (coord.getConvergenceLog(lastN) ?? [])
      : (coord.getConvergenceLog() ?? []);

    renderTable(tableContainer, records, coord);
  }

  // -------------------------------------------------------------------------
  // Auto-refresh interval
  // -------------------------------------------------------------------------

  function startAutoRefresh(): void {
    if (refreshInterval !== -1) return;
    refreshInterval = window.setInterval(() => {
      if (!ctx.isSimActive()) return;
      refreshRecords();
    }, 500);
  }

  // -------------------------------------------------------------------------
  // Assemble and show
  // -------------------------------------------------------------------------

  body.style.cssText = 'display:flex;flex-direction:column;flex:1;overflow:hidden;padding:0;';
  body.appendChild(toolbar);
  body.appendChild(tableContainer);

  document.body.appendChild(overlay);

  refreshRecords();
  startAutoRefresh();
}

// ---------------------------------------------------------------------------
// applyLoggingDesired -- apply persisted logging state to a new coordinator
// ---------------------------------------------------------------------------

/** Apply the persisted logging state to a newly-compiled coordinator. */
export function applyLoggingDesired(coordinator: { supportsConvergenceLog(): boolean; setConvergenceLogEnabled(enabled: boolean): void }): void {
  if (_loggingDesired && coordinator.supportsConvergenceLog()) {
    coordinator.setConvergenceLogEnabled(true);
  }
}

// ---------------------------------------------------------------------------
// autoOpenConvergenceLog -- called on stagnation
// ---------------------------------------------------------------------------

export function autoOpenConvergenceLog(ctx: AppContext): void {
  const coord = ctx.facade.getCoordinator();
  if (coord.supportsConvergenceLog()) {
    _loggingDesired = true;
    coord.setConvergenceLogEnabled(true);
  }
  openConvergenceLogPanel(ctx);
}
