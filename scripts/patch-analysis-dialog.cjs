// Patch app-init.ts: replace openAnalysisDialog with multi-tab version
const fs = require('fs');
let ts = fs.readFileSync('src/app/app-init.ts', 'utf8');
const nl = ts.includes('\r\n') ? '\r\n' : '\n';

// Find bounds of existing openAnalysisDialog function
const SECTION_HEADER = '  // -------------------------------------------------------------------------\n  // Analysis menu: Analyse Circuit';
const SECTION_HEADER_CRLF = '  // -------------------------------------------------------------------------\r\n  // Analysis menu: Analyse Circuit';
const LISTENER_LINE = "  document.getElementById('btn-analyse-circuit')?.addEventListener('click', openAnalysisDialog);";

const funcStart = ts.includes(SECTION_HEADER_CRLF)
  ? ts.indexOf(SECTION_HEADER_CRLF)
  : ts.indexOf(SECTION_HEADER);

const funcEnd = ts.indexOf(LISTENER_LINE);
if (funcStart === -1) { console.error('funcStart NOT FOUND'); process.exit(1); }
if (funcEnd === -1) { console.error('funcEnd NOT FOUND'); process.exit(1); }

// afterFunc: position after the listener line and its newline
const afterFunc = ts.indexOf(nl, funcEnd + LISTENER_LINE.length) + nl.length;

console.log('funcStart:', funcStart, 'funcEnd:', funcEnd, 'afterFunc:', afterFunc);

const newFunc = `  // -------------------------------------------------------------------------
  // Analysis menu: Analyse Circuit
  // -------------------------------------------------------------------------

  function openAnalysisDialog(): void {
    const flipFlopDefs = registry.getByCategory('FLIP_FLOPS' as any);
    const flipFlopNames = new Set(flipFlopDefs.map((d: { name: string }) => d.name));
    const hasFlipFlop = circuit.elements.some(el => flipFlopNames.has(el.typeId));

    const overlay = document.createElement('div');
    overlay.className = 'analysis-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'analysis-dialog';

    // Header
    const header = document.createElement('div');
    header.className = 'analysis-dialog-header';
    const titleSpan = document.createElement('span');
    titleSpan.textContent = 'Circuit Analysis';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'prop-popup-close';
    closeBtn.textContent = '\\u00d7';
    closeBtn.addEventListener('click', () => overlay.remove());
    header.appendChild(titleSpan);
    header.appendChild(closeBtn);
    dialog.appendChild(header);

    if (hasFlipFlop) {
      const errDiv = document.createElement('div');
      errDiv.className = 'analysis-error';
      errDiv.style.margin = '16px';
      errDiv.textContent = 'This circuit contains sequential elements (flip-flops). ' +
        'Truth table analysis requires a purely combinational circuit. ' +
        'Use State Transition Analysis for sequential circuits.';
      dialog.appendChild(errDiv);
    } else {
      // Run analysis once; share result across tabs
      let ttModel: TruthTable | null = null;
      let analysisError: string | null = null;
      try {
        const runner = new SimulationRunner(registry);
        const result = analyseCircuit(runner as unknown as import('../headless/facade.js').SimulatorFacade, circuit);
        const inputSpecs = result.inputs.map(s => ({ name: s.name, bitWidth: s.bitWidth }));
        const outputSpecs = result.outputs.map(s => ({ name: s.name, bitWidth: s.bitWidth }));
        const outCount = outputSpecs.length;
        const data: import('../analysis/truth-table.js').TernaryValue[] = [];
        for (const row of result.rows) {
          for (let o = 0; o < outCount; o++) {
            const v = row.outputValues[o] ?? 0n;
            data.push(v === 0n ? 0n : 1n);
          }
        }
        ttModel = new TruthTable(inputSpecs, outputSpecs, data);
      } catch (err) {
        analysisError = err instanceof Error ? err.message : String(err);
      }

      // Build tab bar
      const tabBar = document.createElement('div');
      tabBar.className = 'analysis-tabs';
      const TAB_NAMES = ['Truth Table', 'K-Map', 'Expressions', 'Expression Editor'];
      const tabBtns: HTMLButtonElement[] = [];
      for (const name of TAB_NAMES) {
        const btn = document.createElement('button');
        btn.className = 'analysis-tab';
        btn.textContent = name;
        tabBar.appendChild(btn);
        tabBtns.push(btn);
      }
      dialog.appendChild(tabBar);

      const contentArea = document.createElement('div');
      contentArea.className = 'analysis-tab-content';
      dialog.appendChild(contentArea);

      function showAnalysisTab(idx: number): void {
        tabBtns.forEach((b, i) => b.classList.toggle('active', i === idx));
        contentArea.innerHTML = '';

        if (analysisError && idx !== 3) {
          const errDiv = document.createElement('div');
          errDiv.className = 'analysis-error';
          errDiv.textContent = analysisError;
          contentArea.appendChild(errDiv);
          return;
        }

        if (idx === 0 && ttModel) {
          const ttTab = new TruthTableTab(ttModel);
          ttTab.render(contentArea);
        } else if (idx === 1 && ttModel) {
          renderKMapTab(contentArea, ttModel);
        } else if (idx === 2 && ttModel) {
          renderExpressionsTab(contentArea, ttModel);
        } else if (idx === 3) {
          renderExpressionEditorTab(contentArea);
        }
      }

      tabBtns.forEach((btn, i) => btn.addEventListener('click', () => showAnalysisTab(i)));
      showAnalysisTab(0);
    }

    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  function renderKMapTab(container: HTMLElement, ttModel: TruthTable): void {
    const numVars = ttModel.totalInputBits;
    if (numVars < 2 || numVars > 6) {
      const errDiv = document.createElement('div');
      errDiv.className = 'analysis-error';
      errDiv.textContent = 'K-Map requires 2\\u20136 input variables. This circuit has ' + numVars + '.';
      container.appendChild(errDiv);
      return;
    }

    let selectedOutput = 0;
    if (ttModel.outputs.length > 1) {
      const row = document.createElement('div');
      row.style.cssText = 'margin-bottom:8px;display:flex;align-items:center;gap:8px;font-size:12px;';
      const lbl = document.createElement('label');
      lbl.textContent = 'Output: ';
      const sel = document.createElement('select');
      sel.style.cssText = 'background:var(--bg);color:var(--fg);border:1px solid var(--panel-border);border-radius:3px;padding:2px 4px;font-size:12px;';
      for (let i = 0; i < ttModel.outputs.length; i++) {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = ttModel.outputs[i]!.name;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () => { selectedOutput = parseInt(sel.value, 10); renderKMapCanvas(); });
      row.appendChild(lbl);
      row.appendChild(sel);
      container.appendChild(row);
    }

    const kmapTab = new KarnaughMapTab(ttModel);
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;max-width:100%;';
    container.appendChild(canvas);

    function renderKMapCanvas(): void {
      const CELL = 44;
      const layout = kmapTab.kmap.layout;
      const subMaps = kmapTab.subMapCount;
      const labelOff = CELL;
      const mapW = (layout.cols + 1) * CELL;
      const totalW = labelOff + subMaps * mapW + 16;
      const totalH = labelOff + layout.rows * CELL + 16;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = totalW * dpr;
      canvas.height = totalH * dpr;
      canvas.style.width = totalW + 'px';
      canvas.style.height = totalH + 'px';
      const ctx2 = canvas.getContext('2d')!;
      ctx2.scale(dpr, dpr);

      const cs = getComputedStyle(document.documentElement);
      const fg = cs.getPropertyValue('--fg').trim() || '#d4d4d4';
      const border = cs.getPropertyValue('--panel-border').trim() || '#3c3c3c';
      const LOOP_COLORS = ['#e84a4a88','#4ae84a88','#4a9ee888','#e8e84a88','#e84ae888','#4ae8e888','#ff8c0088','#8888ff88'];

      ctx2.clearRect(0, 0, totalW, totalH);
      ctx2.font = Math.round(CELL * 0.4) + 'px monospace';
      ctx2.textAlign = 'center';
      ctx2.textBaseline = 'middle';

      try {
        const minResult = minimize(ttModel, selectedOutput);
        kmapTab.setImplicants(minResult.primeImplicants);
      } catch (_e) { /* ignore */ }

      const kctx = {
        drawRect(x: number, y: number, w: number, h: number) {
          ctx2.strokeStyle = border;
          ctx2.lineWidth = 1;
          ctx2.strokeRect(x, y, w, h);
        },
        drawText(text: string, x: number, y: number) {
          ctx2.fillStyle = fg;
          ctx2.fillText(text, x, y);
        },
        drawLoop(x: number, y: number, w: number, h: number, colorIdx: number) {
          const c = LOOP_COLORS[colorIdx % LOOP_COLORS.length]!;
          ctx2.fillStyle = c;
          ctx2.strokeStyle = c.replace('88', 'ff');
          ctx2.lineWidth = 2;
          ctx2.beginPath();
          ctx2.roundRect(x + 2, y + 2, w - 4, h - 4, 6);
          ctx2.fill();
          ctx2.stroke();
          ctx2.lineWidth = 1;
        },
      };

      kmapTab.render(kctx, CELL, selectedOutput);
    }

    renderKMapCanvas();
  }

  function renderExpressionsTab(container: HTMLElement, ttModel: TruthTable): void {
    const tbl = document.createElement('table');
    tbl.style.cssText = 'border-collapse:collapse;width:100%;font-size:12px;font-family:monospace;';
    const thead = document.createElement('thead');
    const hRow = document.createElement('tr');
    for (const h of ['Output', 'Minimized (SOP)', 'Canonical SOP', 'Canonical POS']) {
      const th = document.createElement('th');
      th.textContent = h;
      th.style.cssText = 'text-align:left;padding:4px 10px;border-bottom:1px solid var(--panel-border);opacity:0.7;font-size:11px;text-transform:uppercase;';
      hRow.appendChild(th);
    }
    thead.appendChild(hRow);
    tbl.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (let i = 0; i < ttModel.outputs.length; i++) {
      const tr = document.createElement('tr');
      const nameCell = document.createElement('td');
      nameCell.textContent = ttModel.outputs[i]!.name;
      nameCell.style.cssText = 'padding:4px 10px;font-weight:600;border-bottom:1px solid rgba(128,128,128,0.15);';
      tr.appendChild(nameCell);

      let minExpr = '', sopExpr = '', posExpr = '';
      try { const m = minimize(ttModel, i); minExpr = exprToString(m.selectedCover); } catch (e) { minExpr = 'Error'; }
      try { sopExpr = exprToString(generateSOP(ttModel, i)); } catch (_e) { sopExpr = 'Error'; }
      try { posExpr = exprToString(generatePOS(ttModel, i)); } catch (_e) { posExpr = 'Error'; }

      for (const val of [minExpr, sopExpr, posExpr]) {
        const td = document.createElement('td');
        td.textContent = val;
        td.style.cssText = 'padding:4px 10px;border-bottom:1px solid rgba(128,128,128,0.15);word-break:break-all;';
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    container.appendChild(tbl);
  }

  function renderExpressionEditorTab(container: HTMLElement): void {
    const editorCtrl = new ExpressionEditorTab();

    const lbl = document.createElement('div');
    lbl.style.cssText = 'font-size:11px;opacity:0.7;margin-bottom:6px;';
    lbl.textContent = 'Enter a boolean expression (e.g. A AND B OR NOT C). Press Parse or Enter.';
    container.appendChild(lbl);

    const inputRow = document.createElement('div');
    inputRow.style.cssText = 'display:flex;gap:6px;margin-bottom:8px;';
    const exprInput = document.createElement('input');
    exprInput.type = 'text';
    exprInput.placeholder = 'A AND B OR NOT C';
    exprInput.style.cssText = 'flex:1;padding:4px 8px;background:var(--bg);border:1px solid var(--panel-border);color:var(--fg);border-radius:3px;font-family:monospace;font-size:13px;';
    const parseBtn = document.createElement('button');
    parseBtn.textContent = 'Parse';
    parseBtn.style.cssText = 'padding:4px 12px;background:var(--toolbar-bg);border:1px solid var(--panel-border);color:var(--fg);border-radius:3px;cursor:pointer;font-size:12px;';
    inputRow.appendChild(exprInput);
    inputRow.appendChild(parseBtn);
    container.appendChild(inputRow);

    const statusEl = document.createElement('div');
    statusEl.style.cssText = 'font-size:11px;margin-bottom:8px;min-height:16px;';
    container.appendChild(statusEl);

    const ttWrapper = document.createElement('div');
    ttWrapper.style.cssText = 'margin-bottom:12px;overflow:auto;';
    container.appendChild(ttWrapper);

    const synthBtn = document.createElement('button');
    synthBtn.textContent = 'Generate Circuit from Expression';
    synthBtn.disabled = true;
    synthBtn.style.cssText = 'padding:5px 16px;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;';
    synthBtn.addEventListener('click', () => {
      const pr = editorCtrl.lastResult;
      if (!pr.expr) return;
      const vars = editorCtrl.detectVariables();
      const exprMap = new Map<string, import('../analysis/expression.js').BoolExpr>([['Y', pr.expr]]);
      try {
        const synth = synthesizeCircuit(exprMap, vars, registry);
        applyLoadedCircuit(synth);
        container.closest('.analysis-overlay')?.remove();
        showStatus('Circuit synthesized (' + synth.elements.length + ' components)');
      } catch (e) {
        showStatus('Synthesis error: ' + (e instanceof Error ? e.message : String(e)), true);
      }
    });
    container.appendChild(synthBtn);

    function doParse(): void {
      editorCtrl.setText(exprInput.value);
      const pr = editorCtrl.parse();
      ttWrapper.innerHTML = '';
      if (pr.error) {
        statusEl.style.color = '#ffaaaa';
        statusEl.textContent = 'Parse error: ' + pr.error;
        synthBtn.disabled = true;
      } else {
        statusEl.style.color = '#4ae84a';
        statusEl.textContent = 'Valid: ' + exprToString(pr.expr!);
        synthBtn.disabled = false;
        try {
          const tt = editorCtrl.toTruthTable('Y');
          const ttTab = new TruthTableTab(tt);
          ttTab.render(ttWrapper);
        } catch (e) {
          ttWrapper.textContent = 'Table error: ' + (e instanceof Error ? e.message : String(e));
        }
      }
    }

    parseBtn.addEventListener('click', doParse);
    exprInput.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') doParse(); });
  }

  document.getElementById('btn-analyse-circuit')?.addEventListener('click', openAnalysisDialog);
  document.getElementById('btn-synthesise-circuit')?.addEventListener('click', openAnalysisDialog);`;

ts = ts.slice(0, funcStart) + newFunc + nl + ts.slice(afterFunc);
fs.writeFileSync('src/app/app-init.ts', ts);
console.log('Done. Checks:');
console.log('renderKMapTab:', ts.includes('renderKMapTab'));
console.log('renderExpressionsTab:', ts.includes('renderExpressionsTab'));
console.log('renderExpressionEditorTab:', ts.includes('renderExpressionEditorTab'));
console.log('KarnaughMapTab:', ts.includes('new KarnaughMapTab'));
console.log('minimize:', ts.includes('minimize(ttModel'));
console.log('generateSOP:', ts.includes('generateSOP(ttModel'));
console.log('synthesizeCircuit:', ts.includes('synthesizeCircuit('));
