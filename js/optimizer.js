(function(){
  const state = {
    catalogs: [],
    summary: [],
    detail: [],
    initialized: false,
    latestRows: [],
    summaryFiltered: [],
    detailFiltered: []
  };

  const AUDIT_DIFF_PCT_MAX = 20;
  const els = {};

  function $(id){ return document.getElementById(id); }
  function num(v){
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    const s = String(v ?? '').replace(/[$,\s]/g,'').trim();
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }
  function round2(v){ return Math.round((num(v) + Number.EPSILON) * 100) / 100; }
  function money(v){
    const n = num(v);
    return n.toLocaleString('es-MX',{style:'currency',currency:'MXN',minimumFractionDigits:2,maximumFractionDigits:2});
  }
  function pct(v){ return `${round2(v).toFixed(1)}%`; }
  function esc(v){ return String(v ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
  function normalizeText(value){
    return String(value ?? '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .toUpperCase()
      .replace(/\([^)]*\)/g,' ')
      .replace(/[^A-Z0-9]+/g,' ')
      .replace(/\b(CAJ|CJA|AMP|AMPOLLA|SOL|INY|INYECTABLE|TAB|COMP|CAPS|FRASCO|ML|MG|G|MCG|X\d+|C\/\d+|PZA|PZAS|VIAL|VLS|SUSP|ORAL|IV|SC|IM|SUBCUTANEO|INFUSION|INF)\b/g,' ')
      .replace(/\s+/g,' ')
      .trim();
  }
  function tokens(value){ return normalizeText(value).split(' ').filter(t => t.length >= 4); }

  async function loadCatalogs(){
    const manifestResp = await fetch('data/manifest.json');
    const manifest = await manifestResp.json();
    const sources = Array.isArray(manifest.sources) ? manifest.sources : [];
    const loaded = await Promise.all(sources.map(async src => {
      const fileRef = String(src.file || '').trim();
      const normalizedFile = fileRef.replace(/^\.\//, '');
      const fetchPath = /^(data\/)/i.test(normalizedFile) ? normalizedFile : `data/${normalizedFile}`;
      const resp = await fetch(fetchPath);
      if (!resp.ok) throw new Error(`No se pudo cargar ${fetchPath} (${resp.status})`);
      const json = await resp.json();
      return { source: json.source || src.label || normalizedFile, file: normalizedFile, rows: Array.isArray(json.rows) ? json.rows : [] };
    }));
    state.catalogs = loaded.map(cat => ({
      ...cat,
      rows: cat.rows.map(r => ({
        ...r,
        articuloNorm: normalizeText(r.articulo || ''),
        eanNorm: String(r.ean || '').replace(/\D/g,''),
        costoNum: num(r.costo),
        pmpNum: num(r.pmp)
      })).filter(r => r.articuloNorm || r.eanNorm)
    }));
  }


  function parsePrimitiveNumber(text){
    const cleaned = String(text ?? '').replace(/[^0-9.-]+/g,'');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  }

  function coerceList(value){
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return Object.values(value);
    if (typeof value === 'string') return parseMixedList(value, 'coerced');
    return [];
  }

  function parseTextLineChunk(chunk, idx, prefix){
    const raw = String(chunk || '').trim();
    if (!raw) return null;
    const parts = raw.split('|').map(p => p.trim()).filter(Boolean);
    const name = (parts[0] || '').replace(/^[-–•\s]+/, '').trim();
    const find = (label) => {
      const rx = new RegExp(`\\b${label}\\s*:\s*([^|]+)`, 'i');
      const m = raw.match(rx);
      return m ? m[1].trim() : '';
    };
    const codigo = find('cod(?:igo)?');
    const cantidad = parsePrimitiveNumber(find('cant(?:idad)?'));
    const subtotal = parsePrimitiveNumber(find('sub(?:total)?'));
    let unitario = parsePrimitiveNumber(find('pu|precio(?:\s*unitario)?|unitario'));
    if (!unitario && cantidad > 0 && subtotal > 0) unitario = subtotal / cantidad;
    if (!name || cantidad <= 0 || subtotal <= 0) return null;
    return {
      key: `${prefix || 'line'}_${idx}`,
      nombre: name,
      codigo,
      cantidad: round2(cantidad),
      unitario: round2(unitario),
      subtotal: round2(subtotal),
      original: raw,
      parsedFrom: 'string'
    };
  }

  function parseMixedList(value, prefix){
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return Object.values(value);
    if (typeof value !== 'string') return [];
    return value.split(/\|\|/g).map((chunk, idx) => parseTextLineChunk(chunk, idx, prefix)).filter(Boolean);
  }

  function initDom(){
    els.btnCsv = $('btnExportCsvOptimizacion');
    els.scenario = $('optScenario');
    els.minMargin = $('optMinMargin');
    els.maxRows = $('optMaxRows');
    els.monthFilter = $('optMonthFilter');
    els.summarySearch = $('optSummarySearch');
    els.detailSearch = $('optDetailSearch');
    els.kpiQuotes = $('optCountQuotes');
    els.kpiItems = $('optCountItems');
    els.kpiSales = $('optSales');
    els.kpiCost = $('optCost');
    els.kpiProfit = $('optProfit');
    els.kpiMargin = $('optMargin');
    els.summaryBody = $('optSummaryBody');
    els.detailBody = $('optDetailBody');
    els.btnCsv?.addEventListener('click', exportCsv);
    [els.scenario, els.minMargin, els.maxRows, els.monthFilter].forEach(el => el && el.addEventListener('input', rerender));
    [els.summarySearch, els.detailSearch].forEach(el => el && el.addEventListener('input', rerender));
    state.initialized = true;
  }

  function getScenario(){ return els.scenario?.value || 'balanceado'; }
  function getMinMargin(){ return Math.max(0, num(els.minMargin?.value || 25)); }
  function getMaxRows(){ return Math.max(1, Math.floor(num(els.maxRows?.value || 60))); }

  function getSelectedMonth(){
    return String(els.monthFilter?.value || '').trim();
  }

  function extractRowMonth(row){
    const raw = String(row?.fechaEmision || row?.fecha || row?.createdAt || '').trim();
    const iso = raw.match(/^(\d{4})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}`;
    const slash = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (slash) return `${slash[3]}-${slash[2]}`;
    const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (compact) return `${compact[1]}-${compact[2]}`;
    return '';
  }

  function applyMonthFilter(rows){
    const month = getSelectedMonth();
    if (!month) return rows.slice();
    return rows.filter(r => extractRowMonth(r) === month);
  }

  function cotizacionId(row){
    const id = String(row?.idFirestore || row?.id || '').trim();
    if (id) return id.toUpperCase();
    const fecha = String(row?.fechaEmision || '').trim();
    const folio = String(row?.folio || '').trim();
    return [folio, fecha].filter(Boolean).join(' · ') || 'SIN-ID';
  }

  function extractMedicationLines(row){
    const meds = coerceList(row.medicamentos);
    const lines = [];
    meds.forEach((item, idx) => {
      if (!item) return;
      if (item.parsedFrom === 'string') { lines.push(item); return; }
      const name = item.nombre || item.descripcion || item.articulo || item.medicamento || item.concepto || item.producto || item.claveDescripcion || item.prueba || item.texto || '';
      const code = item.codigo || item.ean || item.clave || item.sku || item.cod || '';
      const qtyRaw = item.cantidad ?? item.qty ?? item.cant;
      const subtotalRaw = item.subtotal ?? item.importe ?? item.total ?? item.monto ?? item.precio;
      const unitRaw = item.unitario ?? item.precioUnitario ?? item.precio ?? item.pu;
      const qty = num(qtyRaw);
      const subtotal = num(subtotalRaw);
      let unitario = num(unitRaw);
      const hasExplicitQty = !(qtyRaw === '' || qtyRaw === null || typeof qtyRaw === 'undefined');
      const hasExplicitSubtotal = !(subtotalRaw === '' || subtotalRaw === null || typeof subtotalRaw === 'undefined');
      if (!name || !hasExplicitQty || !hasExplicitSubtotal || qty <= 0 || subtotal <= 0) return;
      if (!unitario && qty > 0 && subtotal > 0) unitario = subtotal / qty;
      lines.push({
        key: `${row.idFirestore || row.folio || 'row'}_${idx}`,
        nombre: String(name).trim(),
        codigo: String(code || '').trim(),
        cantidad: round2(qty),
        unitario: round2(unitario),
        subtotal: round2(subtotal),
        original: item,
        parsedFrom: 'array'
      });
    });
    return lines;
  }

  function extractServiceLines(row){
    const services = coerceList(row.servicios);
    return services.map((item, idx) => {
      if (!item) return null;
      if (item.parsedFrom === 'string') return item;
      const name = item.nombre || item.descripcion || item.concepto || `Servicio ${idx+1}`;
      const qty = num(item.cantidad ?? item.qty ?? item.cant ?? 1) || 1;
      const subtotal = num(item.subtotal ?? item.importe ?? item.total ?? item.monto ?? item.precio);
      let unitario = num(item.unitario ?? item.precioUnitario ?? item.precio ?? item.pu);
      if (!unitario && subtotal && qty) unitario = subtotal / qty;
      return { nombre: name, cantidad: round2(qty), unitario: round2(unitario), subtotal: round2(subtotal || unitario * qty), descuento: num(item.descuento || 0), parsedFrom: 'array' };
    }).filter(s => s && s.subtotal > 0);
  }

  function chooseMatches(line){
    const ean = String(line.codigo || '').replace(/\D/g,'');
    const norm = normalizeText(line.nombre);
    const toks = tokens(line.nombre);
    const matches = [];
    state.catalogs.forEach(cat => {
      cat.rows.forEach(r => {
        let score = 0;
        const rowCode = String(r.ean || r.codigo || r.clave || '').replace(/\D/g,'');
        if (ean && rowCode && ean === rowCode) score += 120;
        if (ean && r.eanNorm && ean === r.eanNorm) score += 100;
        if (norm && r.articuloNorm === norm) score += 95;
        if (norm && r.articuloNorm.includes(norm)) score += 70;
        if (norm && norm.includes(r.articuloNorm) && r.articuloNorm.length >= 8) score += 60;
        if (!score && toks.length) {
          const hit = toks.filter(t => r.articuloNorm.includes(t));
          if (hit.length >= Math.max(2, Math.min(3, toks.length))) score += hit.length * 15;
        }
        if (score > 0) matches.push({ source: cat.source, row: r, score, costo: r.costoNum || r.pmpNum || 0 });
      });
    });
    matches.sort((a,b) => b.score - a.score || a.costo - b.costo);
    const top = matches.filter(m => m.costo > 0).slice(0, 12);
    if (!top.length) return [];
    const bestScore = top[0].score;
    return top.filter(m => m.score >= Math.max(30, bestScore - 20));
  }

  function buildSuggestedPrice(cost, currentSale, scenario, minMargin){
    const safeCost = Math.max(0, num(cost));
    const current = Math.max(0, num(currentSale));
    const targetByMargin = safeCost / Math.max(0.0001, 1 - (minMargin / 100));
    let suggested = targetByMargin;
    if (scenario === 'utilidad') suggested = Math.max(current, targetByMargin);
    else if (scenario === 'competitivo') suggested = current > 0 ? Math.min(current, targetByMargin) : targetByMargin;
    else suggested = current > 0 ? Math.max(targetByMargin, current * 0.92) : targetByMargin;
    return round2(suggested);
  }

  function buildAuditAdjustment(amount, label){
    const value = round2(amount);
    if (value <= 0) return null;
    return {
      nombre: label || 'Conceptos no optimizables / no auditados',
      codigo: '',
      cantidad: 1,
      unitario: value,
      subtotal: value,
      synthetic: true
    };
  }

  function analyzeRows(rows){
    const sanare = rows.filter(r => String(r.marca || '').toUpperCase() === 'SANARE');
    const detail = [];
    const summary = [];
    sanare.forEach(row => {
      const meds = extractMedicationLines(row);
      const services = extractServiceLines(row);
      const purchaseMap = new Map();
      const matchedDetails = [];
      let detectedSale = 0;
      let costSuggested = 0;
      let suggestedOptimizable = 0;

      meds.forEach(line => {
        const matches = chooseMatches(line);
        if (!matches.length) return;
        const cheapest = [...matches].sort((a,b) => a.costo - b.costo)[0];
        const alternatives = [...matches].sort((a,b) => a.costo - b.costo).slice(0,3);
        const bestCost = round2(cheapest.costo * line.cantidad);
        const sale = round2(line.subtotal);
        const suggestedSale = buildSuggestedPrice(bestCost, sale, getScenario(), getMinMargin());
        const estimatedProfit = round2(suggestedSale - bestCost);
        const estimatedMargin = suggestedSale > 0 ? round2((estimatedProfit / suggestedSale) * 100) : 0;
        detectedSale += sale;
        costSuggested += bestCost;
        suggestedOptimizable += suggestedSale;
        purchaseMap.set(cheapest.source, round2((purchaseMap.get(cheapest.source) || 0) + bestCost));
        matchedDetails.push({
          rowId: row.idFirestore,
          cotizacionId: cotizacionId(row),
          folio: row.folio,
          paciente: row.paciente,
          medicamento: line.nombre,
          cantidad: line.cantidad,
          venta: sale,
          mejorCosto: bestCost,
          utilidadEstimada: estimatedProfit,
          margen: estimatedMargin,
          proveedorSugerido: cheapest.source,
          alternativas: alternatives,
          suggestedSale,
          currentLine: line,
          row,
          services
        });
      });

      if (!matchedDetails.length) return;

      detectedSale = round2(detectedSale);
      costSuggested = round2(costSuggested);
      suggestedOptimizable = round2(suggestedOptimizable);
      const totalDashboard = round2(row.total || 0);
      const totalServicios = round2(services.reduce((a,b)=>a + num(b.subtotal), 0));
      const totalDetalleReal = round2(totalServicios + meds.reduce((a,b)=>a + num(b.subtotal), 0));
      const totalMedsReal = round2(meds.reduce((a,b)=>a + num(b.subtotal), 0));
      const nonOptimizable = round2(totalDashboard - detectedSale);
      const diffVsReal = round2(totalDashboard - totalDetalleReal);
      const diffPct = totalDashboard > 0 ? Math.abs(diffVsReal) / totalDashboard * 100 : 0;
      const totalSuggested = round2(Math.max(0, totalDashboard - detectedSale) + suggestedOptimizable);
      const marginOptimizable = suggestedOptimizable > 0 ? round2(((suggestedOptimizable - costSuggested) / suggestedOptimizable) * 100) : 0;
      const compra = [...purchaseMap.entries()].sort((a,b) => b[1]-a[1]);
      const auditStatus = `Detalle real meds ${money(totalMedsReal)} · servicios ${money(totalServicios)} · diferencia vs total ${money(diffVsReal)} (${pct(diffPct)})`;
      const adjustmentCurrent = buildAuditAdjustment(Math.max(0, totalDashboard - detectedSale), 'Conceptos no optimizables');
      const adjustmentSuggested = buildAuditAdjustment(Math.max(0, totalDashboard - detectedSale), 'Conceptos no optimizables (sin cambio)');
      const summaryRow = {
        rowId: row.idFirestore,
        cotizacionId: cotizacionId(row),
        row,
        folio: row.folio,
        paciente: row.paciente,
        partidas: matchedDetails.length,
        totalDashboard,
        totalMedicamentosReal: totalMedsReal,
        totalServiciosReal: totalServicios,
        totalDetalleReal,
        totalOptimizable: detectedSale,
        diferenciaNoOptimizable: round2(Math.max(0, nonOptimizable)),
        costoSugerido: costSuggested,
        ahorroPotencial: round2(Math.max(0, detectedSale - costSuggested)),
        cotizacionSugerida: totalSuggested,
        margenSugerido: marginOptimizable,
        compraRecomendada: compra,
        servicios: services,
        detalles: matchedDetails,
        auditStatus,
        adjustmentCurrent,
        adjustmentSuggested
      };
      matchedDetails.forEach(d => {
        d.auditStatus = auditStatus;
        d.nonOptimizable = summaryRow.diferenciaNoOptimizable;
      });
      summary.push(summaryRow);
      detail.push(...matchedDetails);
    });
    // Mantener análisis por cotización individual y en orden estable.
    summary.sort((a,b) => String(a.folio||'').localeCompare(String(b.folio||'')) || String(a.rowId||'').localeCompare(String(b.rowId||'')));
    detail.sort((a,b) => String(a.folio||'').localeCompare(String(b.folio||'')) || String(a.rowId||'').localeCompare(String(b.rowId||'')) || String(a.medicamento||'').localeCompare(String(b.medicamento||'')));
    return { summary, detail };
  }


  function filterSummaryRows(rows){
    const q = String(els.summarySearch?.value || '').trim().toLowerCase();
    if (!q) return rows.slice(0, getMaxRows());
    return rows.filter(r => [
      r.cotizacionId, r.folio, r.paciente, r.row?.medico, r.row?.kam, r.row?.aseguradora, r.row?.sede
    ].some(v => String(v || '').toLowerCase().includes(q))).slice(0, getMaxRows());
  }

  function filterDetailRows(rows){
    const q = String(els.detailSearch?.value || '').trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r => [
      r.cotizacionId, r.folio, r.paciente, r.medicamento, r.currentLine?.codigo, r.proveedorSugerido, ...(r.alternativas || []).map(a => a.source)
    ].some(v => String(v || '').toLowerCase().includes(q)));
  }

  function recommendationsForSummary(summary){
    const topSavings = [...summary.detalles].sort((a,b) => b.utilidadEstimada - a.utilidadEstimada).slice(0,3);
    const providerLines = (summary.compraRecomendada || []).slice(0,3).map(([prov, monto]) => `${prov} ${money(monto)}`);
    const scenarioLabel = getScenario() === 'utilidad' ? 'más utilidad' : getScenario() === 'competitivo' ? 'más competitivo' : 'balanceado';
    const recs = [];
    recs.push(`Escenario recomendado: ${scenarioLabel}.`);
    if (providerLines.length) recs.push(`Compra sugerida concentrada en: ${providerLines.join(', ')}.`);
    if (topSavings.length) recs.push(`Medicamentos con mejor aporte potencial: ${topSavings.map(d => `${d.medicamento} (${money(d.utilidadEstimada)})`).join(', ')}.`);
    recs.push(`Utilidad actual estimada de referencia: ${money(estimatedCurrentUtility(summary))} (${pct(estimatedCurrentMargin(summary))}).`);
    recs.push(`Utilidad potencial con mejor compra: ${money(potentialUtility(summary))} (${pct(potentialMargin(summary))}). Mejora potencial: ${money(utilityImprovement(summary))}.`);
    return recs;
  }

  function estimatedCurrentCost(summary){
    return round2((summary.detalles || []).reduce((acc, d) => {
      const qty = Math.max(1, num(d.cantidad));
      const alt = Array.isArray(d.alternativas) ? d.alternativas : [];
      const ref = alt.length > 1 ? num(alt[1].costo) : (alt.length ? num(alt[0].costo) : num(d.mejorCosto) / qty);
      return acc + (ref * qty);
    }, 0));
  }
  function estimatedCurrentUtility(summary){
    return round2(num(summary.totalOptimizable) - estimatedCurrentCost(summary));
  }
  function estimatedCurrentMargin(summary){
    const sale = num(summary.totalOptimizable);
    return sale > 0 ? round2((estimatedCurrentUtility(summary) / sale) * 100) : 0;
  }
  function utilityImprovement(summary){
    return round2(potentialUtility(summary) - estimatedCurrentUtility(summary));
  }
  function currentUtilityText(summary){
    return `Con la información disponible sí se respeta el total real de la cotización y los subtotales reales de medicamentos/servicios. La utilidad histórica exacta no puede conocerse desde Firebase si no está guardado el costo de compra original; por eso aquí se muestra una utilidad actual estimada de referencia usando el siguiente mejor costo de mercado detectado por medicamento, y una utilidad potencial usando el mejor costo encontrado.`;
  }


  function potentialUtility(summary){
    return round2(num(summary.totalOptimizable) - num(summary.costoSugerido));
  }
  function potentialMargin(summary){
    const sale = num(summary.totalOptimizable);
    return sale > 0 ? round2((potentialUtility(summary) / sale) * 100) : 0;
  }
  function utilityNarrative(summary){
    const sale = num(summary.totalOptimizable);
    const currentUtility = estimatedCurrentUtility(summary);
    const currentMargin = estimatedCurrentMargin(summary);
    const utility = potentialUtility(summary);
    const margin = potentialMargin(summary);
    const improvement = utilityImprovement(summary);
    return `En esta cotización, la venta real auditada de medicamentos es ${money(sale)}. Bajo una referencia conservadora de mercado, la utilidad actual estimada sería ${money(currentUtility)} (${pct(currentMargin)}). Si esos mismos medicamentos se hubieran surtido al mejor costo detectado en catálogos, la utilidad potencial habría sido ${money(utility)} (${pct(margin)}), es decir ${money(improvement)} adicionales de ganancia potencial.`;
  }
  function executiveComparisonText(summary){
    return `Ganabas aprox. ${money(estimatedCurrentUtility(summary))} → podrías ganar ${money(potentialUtility(summary))} → mejora ${money(utilityImprovement(summary))}.`;
  }

  function executiveUtilityLines(summary, mode){
    const sale = num(summary.totalOptimizable);
    const currentCost = estimatedCurrentCost(summary);
    const currentUtility = estimatedCurrentUtility(summary);
    const currentMargin = estimatedCurrentMargin(summary);
    const bestCost = num(summary.costoSugerido);
    const utility = potentialUtility(summary);
    const margin = potentialMargin(summary);
    const improvement = utilityImprovement(summary);
    if (mode === 'current') {
      return [
        ['Venta real de medicamentos', sale],
        ['Costo base de referencia', currentCost],
        ['Utilidad actual estimada', currentUtility],
        ['Margen actual estimado', `${pct(currentMargin)}`]
      ];
    }
    return [
      ['Venta real de medicamentos', sale],
      ['Mejor costo detectado', bestCost],
      ['Utilidad potencial', utility],
      ['Mejora potencial', improvement]
    ];
  }

  function render(){
    const rows = applyMonthFilter(state.latestRows || []);
    const { summary, detail } = analyzeRows(rows);
    state.summary = summary;
    state.detail = detail;
    state.summaryFiltered = filterSummaryRows(summary);
    state.detailFiltered = filterDetailRows(detail);
    renderKpis(summary, detail);
    renderSummary(state.summaryFiltered);
    renderDetail(state.detailFiltered);
  }

  function rerender(){
    if (!state.initialized) return;
    render();
  }

  function renderKpis(summary, detail){
    const sales = summary.reduce((a,b)=>a + b.totalOptimizable, 0);
    const cost = summary.reduce((a,b)=>a + b.costoSugerido, 0);
    const profit = summary.reduce((a,b)=>a + b.ahorroPotencial, 0);
    const margin = sales > 0 ? (profit / sales) * 100 : 0;
    if (els.kpiQuotes) els.kpiQuotes.textContent = String(summary.length);
    if (els.kpiItems) els.kpiItems.textContent = String(detail.length);
    if (els.kpiSales) els.kpiSales.textContent = money(sales);
    if (els.kpiCost) els.kpiCost.textContent = money(cost);
    if (els.kpiProfit) els.kpiProfit.textContent = money(profit);
    if (els.kpiMargin) els.kpiMargin.textContent = pct(margin);
  }

  function renderSummary(rows){
    if (!els.summaryBody) return;
    if (!rows.length) {
      els.summaryBody.innerHTML = '<tr class="empty-row"><td colspan="14">No hay cotizaciones Sanaré con medicamentos que hagan match con los catálogos para los filtros actuales. Si esperabas ver datos, revisa si en Firebase la cotización guarda medicamentos como texto; esta versión ya intenta leer arrays, objetos y texto.</td></tr>';
      return;
    }
    els.summaryBody.innerHTML = rows.map(r => {
      const compraHtml = r.compraRecomendada.slice(0,4).map(([prov, monto]) => `<span>${esc(prov)}: ${money(monto)}</span>`).join('');
      return `<tr>
        <td>${esc(r.cotizacionId)}</td>
        <td>${esc(r.folio)}</td>
        <td>${esc(r.paciente)}</td>
        <td>${r.partidas}</td>
        <td>${money(r.totalDashboard)}</td>
        <td>${money(r.totalMedicamentosReal)}</td>
        <td>${money(r.totalServiciosReal)}</td>
        <td>${money(r.totalOptimizable)}</td>
        <td>${money(r.totalDashboard - (r.totalMedicamentosReal + r.totalServiciosReal))}</td>
        <td>${money(r.costoSugerido)}</td>
        <td>${money(r.cotizacionSugerida)}</td>
        <td>${pct(r.margenSugerido)}</td>
        <td><div class="purchase-lines">${compraHtml}</div><small>${esc(r.auditStatus)}</small></td>
        <td><button class="btn secondary pdf-compare-btn" data-pdf-row="${esc(r.rowId)}">PDF comparativo</button></td>
      </tr>`;
    }).join('');
    els.summaryBody.querySelectorAll('[data-pdf-row]').forEach(btn => btn.addEventListener('click', () => exportPdf(btn.getAttribute('data-pdf-row'))));
  }

  function renderDetail(rows){
    if (!els.detailBody) return;
    if (!rows.length) {
      els.detailBody.innerHTML = '<tr class="empty-row"><td colspan="11">No hay partidas con coincidencia confiable en los catálogos para los filtros actuales. Esta versión intenta leer arrays, objetos y texto del campo medicamentos.</td></tr>';
      return;
    }
    els.detailBody.innerHTML = rows.map(r => `
      <tr>
        <td>${esc(r.cotizacionId)}</td>
        <td>${esc(r.folio)}</td>
        <td>${esc(r.paciente)}</td>
        <td>${esc(r.medicamento)}</td>
        <td>${r.cantidad}</td>
        <td>${money(r.venta)}</td>
        <td>${money(r.mejorCosto)}</td>
        <td>${money(r.utilidadEstimada)}</td>
        <td>${pct(r.margen)}</td>
        <td>${esc(r.proveedorSugerido)}</td>
        <td>${r.alternativas.map(a => `${esc(a.source)} (${money(a.costo * r.cantidad)})`).join('<br>')}<br><small>${esc(r.auditStatus)}</small></td>
      </tr>`).join('');
  }

  function exportCsv(){
    const rows = state.detailFiltered.length ? state.detailFiltered : state.detail;
    const headers = ['Cotización','Folio','Paciente','Medicamento','Cantidad real','Venta auditada','Mejor costo','Utilidad estimada','Margen %','Proveedor sugerido','Auditoría'];
    let csv = '\uFEFFsep=;\n' + headers.join(';') + '\n';
    rows.forEach(r => {
      const vals = [cotizacionId(r.row),r.folio,r.paciente,r.medicamento,r.cantidad,r.venta,r.mejorCosto,r.utilidadEstimada,r.margen,r.proveedorSugerido,r.auditStatus];
      csv += vals.map(v => {
        const s = String(v ?? '').replace(/"/g,'""');
        return s.includes(';') || s.includes('\n') ? `"${s}"` : s;
      }).join(';') + '\n';
    });
    const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sanare_optimizacion_auditada.csv';
    document.body.appendChild(a); a.click(); a.remove();
  }

  function findSummaryById(rowId){ return state.summary.find(s => s.rowId === rowId); }

  function buildCurrentPdfLines(summary){
    const base = summary.detalles.map(d => ({ nombre: d.medicamento, codigo: d.currentLine.codigo || '', cantidad: d.cantidad, unitario: d.currentLine.unitario || 0, subtotal: d.venta, proveedor: 'Cotización actual', ahorro: 0 }));
    if (summary.adjustmentCurrent) base.push({ ...summary.adjustmentCurrent, proveedor: 'Sin optimizar', ahorro: 0 });
    return base;
  }
  function buildSuggestedPdfLines(summary){
    const base = summary.detalles.map(d => ({ nombre: d.medicamento, codigo: d.currentLine.codigo || '', cantidad: d.cantidad, unitario: d.suggestedSale / Math.max(1, d.cantidad), subtotal: d.suggestedSale, proveedor: d.proveedorSugerido, ahorro: round2(d.venta - d.mejorCosto), mejorCosto: d.mejorCosto }));
    if (summary.adjustmentSuggested) base.push({ ...summary.adjustmentSuggested, proveedor: 'Sin cambio', ahorro: 0, mejorCosto: summary.adjustmentSuggested.subtotal });
    return base;
  }

  function addHeader(doc, summary, title, subtitle){
    const w = doc.internal.pageSize.getWidth();
    doc.setFillColor(16, 44, 110);
    doc.rect(0,0,w,34,'F');
    doc.setTextColor(255,255,255);
    doc.setFont('helvetica','bold');
    doc.setFontSize(18);
    doc.text('SANARÉ · COTIZACIÓN AUDITADA', 14, 14);
    doc.setFontSize(10);
    doc.setFont('helvetica','normal');
    doc.text(title, 14, 21);
    doc.text(subtitle, 14, 27);
    doc.setTextColor(35,35,35);
    doc.setDrawColor(205,212,224);
    doc.setFillColor(247,249,252);
    const box = (x,y,wid,hei,label,val) => {
      doc.setFillColor(255,255,255);
      doc.setDrawColor(205,212,224);
      doc.roundedRect(x,y,wid,hei,2,2,'FD');
      doc.setTextColor(31,41,55);
      doc.setFont('helvetica','bold'); doc.setFontSize(8); doc.text(label, x+3, y+5);
      doc.setFont('helvetica','normal'); doc.setFontSize(10);
      const lines = doc.splitTextToSize(String(val || ''), wid-6);
      doc.text(lines.slice(0,2), x+3, y+10);
    };
    box(14, 40, 56, 16, 'Paciente', summary.paciente || '');
    box(74, 40, 56, 16, 'Médico', summary.row.medico || '');
    box(134, 40, 56, 16, 'Aseguradora', summary.row.aseguradora || '');
    box(14, 60, 40, 14, 'Folio', summary.folio || '');
    box(58, 60, 40, 14, 'Fecha emisión', summary.row.fechaEmision || '');
    box(102, 60, 40, 14, 'KAM', summary.row.kam || '');
    box(146, 60, 44, 14, 'Sede', summary.row.sede || '');
    box(14, 78, 86, 14, 'Total dashboard', money(summary.totalDashboard));
    box(104, 78, 86, 14, 'Auditoría', summary.auditStatus);
  }

  function pdfTotals(doc, summary, meds, mode){
    const utility = potentialUtility(summary);
    const margin = potentialMargin(summary);
    const y = Math.min((doc.lastAutoTable?.finalY || 220) + 8, 238);
    const labels = mode === 'current'
      ? [ ['Total dashboard', summary.totalDashboard], ['Subtotal meds real', summary.totalOptimizable], ['Subtotal servicios', summary.totalServiciosReal] ]
      : [ ['Venta real de medicamentos', summary.totalOptimizable], ['Mejor costo detectado', summary.costoSugerido], ['Nueva cotización total', summary.cotizacionSugerida] ];
    labels.forEach((it, idx) => {
      const x = 14 + (idx * 60);
      doc.roundedRect(x, y, 54, 12, 2, 2);
      doc.setFont('helvetica','bold'); doc.setFontSize(8); doc.text(it[0], x+3, y+5);
      doc.setFontSize(10); doc.text(typeof it[1] === 'string' ? it[1] : money(it[1]), x+51, y+8.5, { align:'right' });
    });

    const compY = y + 15;
    const compLines = doc.splitTextToSize(executiveComparisonText(summary), 166);
    const compHeight = Math.max(12, 8 + (compLines.length * 4.5));
    doc.roundedRect(14, compY, 174, compHeight, 2, 2);
    doc.setFont('helvetica','bold'); doc.setFontSize(9);
    doc.text(mode === 'current' ? 'Bloque comparativo de utilidad' : 'Ganancia comparativa por mejor compra', 17, compY + 5);
    doc.setFont('helvetica','normal'); doc.setFontSize(9.5);
    doc.text(compLines, 17, compY + 13);

    const statY = compY + compHeight + 3;
    const stats = executiveUtilityLines(summary, mode);
    stats.forEach((it, idx) => {
      const x = 14 + (idx * 44);
      doc.roundedRect(x, statY, 40, 14, 2, 2);
      doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.text(it[0], x+2.5, statY+4.5);
      doc.setFont('helvetica','normal'); doc.setFontSize(9.5); doc.text(typeof it[1] === 'string' ? it[1] : money(it[1]), x+37.5, statY+10, { align:'right' });
    });

    // Se retira el cuadro inferior de lectura ejecutiva para evitar texto amontonado en el PDF.
  }

  function renderPdfPage(doc, summary, meds, title, subtitle, mode){
    addHeader(doc, summary, title, subtitle);
    const recommendations = recommendationsForSummary(summary);
    doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.text(mode === 'current' ? 'Lectura detallada de la cotización real' : 'Recomendación detallada de la cotización sugerida', 14, 102);
    doc.setFont('helvetica','normal'); doc.setFontSize(9);
    const intro = mode === 'current'
      ? `Esta cotización se generó con ${summary.partidas} medicamento(s) auditado(s), subtotal real de medicamentos ${money(summary.totalMedicamentosReal)} y subtotal real de servicios ${money(summary.totalServiciosReal)}. ${currentUtilityText(summary)}`
      : `Mejor escenario recomendado: ${getScenario() === 'utilidad' ? 'más utilidad' : getScenario() === 'competitivo' ? 'más competitivo' : 'balanceado'}. Se conserva el total real de servicios y solo se optimizan los medicamentos con match confiable. ${utilityNarrative(summary)}`;
    const introLines = doc.splitTextToSize(intro, 178);
    doc.text(introLines, 14, 108);
    const analysisY = 110 + (introLines.length * 4.2) + 6;
    const bullets = (mode === 'current'
      ? [
          `Total real dashboard: ${money(summary.totalDashboard)}.`,
          `Medicamentos reales detectados: ${money(summary.totalMedicamentosReal)}. Servicios reales: ${money(summary.totalServiciosReal)}.`,
          `Ganabas aprox. ${money(estimatedCurrentUtility(summary))} con un margen estimado de ${pct(estimatedCurrentMargin(summary))} sobre medicamentos.`,
          `Con mejor compra podrías ganar ${money(potentialUtility(summary))} (${pct(potentialMargin(summary))}). Mejora potencial: ${money(utilityImprovement(summary))}.`
        ]
      : recommendations
    );
    const bulletLines = bullets.slice(0,5).flatMap(t => doc.splitTextToSize('• ' + t, 166));
    const boxHeight = Math.max(24, 10 + (bulletLines.length * 4.2));
    doc.roundedRect(14, analysisY, 174, boxHeight, 2, 2);
    doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.text(mode === 'current' ? 'Resumen interpretativo' : 'Recomendaciones por cotización', 17, analysisY + 6);
    doc.setFont('helvetica','normal'); doc.setFontSize(8.5);
    let bulletY = analysisY + 11;
    bulletLines.forEach(line => {
      doc.text(line, 18, bulletY);
      bulletY += 4.2;
    });
    const conceptsY = analysisY + boxHeight + 8;
    doc.setFont('helvetica','bold'); doc.setFontSize(13); doc.text('Conceptos auditados', 14, conceptsY);
    doc.autoTable({
      startY: conceptsY + 4,
      head: mode === 'current'
        ? [['Concepto','Código','Cantidad','P. unitario','Subtotal']]
        : [['Concepto','Código','Cantidad','Proveedor','Mejor costo','Venta sugerida','Ahorro']],
      body: (meds.length ? meds : [{nombre:'Sin conceptos auditados',codigo:'',cantidad:'',unitario:'',subtotal:''}]).map(m => mode === 'current'
        ? [m.nombre || '', m.codigo || '', String(m.cantidad || ''), money(m.unitario || 0), money(m.subtotal || 0)]
        : [m.nombre || '', m.codigo || '', String(m.cantidad || ''), m.proveedor || '', money(m.mejorCosto || 0), money(m.subtotal || 0), money(m.ahorro || 0)]),
      margin: {left:14,right:14},
      styles: {fontSize:8,cellPadding:2},
      headStyles: {fillColor:[230,235,244], textColor:[30,30,30]},
      theme: 'grid'
    });
    pdfTotals(doc, summary, meds, mode);
    doc.setFont('helvetica','normal'); doc.setFontSize(8);
    const note = mode === 'current'
      ? 'Vista auditada real: el PDF replica la cotización con subtotales reales de medicamentos y servicios guardados en Firebase. No infla cantidades ni reagrupa folios.'
      : 'Vista sugerida: las recomendaciones se basan en los mejores costos detectados en catálogos cargados. El ahorro y la utilidad son potenciales y aplican solo a medicamentos auditados con match.';
    const noteY = Math.min((doc.lastAutoTable?.finalY || (conceptsY + 40)) + 62, 285);
    doc.text(doc.splitTextToSize(note, 180), 14, noteY);
  }

  function exportPdf(rowId){
    const summary = findSummaryById(rowId);
    if (!summary) return;
    const jsPDFCtor = window.jspdf?.jsPDF;
    if (!jsPDFCtor) { alert('No se pudo cargar el generador PDF.'); return; }
    const doc = new jsPDFCtor({orientation:'portrait', unit:'mm', format:'a4'});
    renderPdfPage(doc, summary, buildCurrentPdfLines(summary), 'Página 1 · Cotización auditada actual', 'Replica únicamente conceptos confiables y separa servicios/no optimizables sin alterar el total real.', 'current');
    doc.addPage();
    renderPdfPage(doc, summary, buildSuggestedPdfLines(summary), 'Página 2 · Cotización auditada sugerida', `Propuesta ${getScenario()} con margen meta ${getMinMargin()}% solo sobre conceptos auditados y con recomendaciones por proveedor.`, 'suggested');
    const safe = String((summary.cotizacionId || summary.folio || 'cotizacion')).replace(/[^a-z0-9_-]+/gi,'_');
    doc.save(`${safe}_auditada_actual_vs_sugerida.pdf`);
  }

  function onData(detail){
    state.latestRows = Array.isArray(detail?.filteredRows) ? detail.filteredRows : (window.__innvidaDashboard?.filteredRows || []);
    if (state.initialized) render();
  }

  async function bootstrap(){
    initDom();
    try { await loadCatalogs(); }
    catch (err) { console.error('No se pudieron cargar catálogos:', err); }
    const initial = window.__innvidaDashboard?.filteredRows || [];
    state.latestRows = initial;
    render();
    window.addEventListener('dashboard:data-updated', e => onData(e.detail));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap);
  else bootstrap();
})();