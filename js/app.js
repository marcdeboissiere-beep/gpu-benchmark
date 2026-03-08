// ── STATE ──
let benchmarkData = null;
let gpuPrices = null;
let sortColumn = null;
let sortDirection = 'desc';
let condition = 'used';
let activeModelColumns = new Set();
let activeGpuRows     = new Set();

// Speed simulation state
let simEnabled   = true;
let simTimerId   = null;
let simCharIndex = 0;
let simPausing   = false;

// ── CONSTANTS ──
const DEFAULT_MODEL_COLUMNS = ['llama3.1:8b', 'deepseek-r1:14b', 'mistral-small:24b', 'llama3.3:70b'];

const SPEED_CONTEXT_LABELS = [
  [1,   9,   "Barely usable — slower than reading pace"],
  [10,  19,  "Slow chat — fine for casual use"],
  [20,  39,  "Comfortable chat speed"],
  [40,  79,  "Fast — good for rapid iteration"],
  [80,  149, "Very fast — developer workflow speed"],
  [150, Infinity, "Exceptional — near-instant for most queries"],
];

const MODEL_VRAM_GB = {
  'llama3.2:3b':       2.5,
  'llama3.1:8b':       5.5,
  'deepseek-r1:7b':    5.5,
  'qwen2.5:7b':        5.0,
  'gemma3:4b':         3.5,
  'qwen3.5:4b':        3.5,
  'qwen3.5:9b':        6.5,
  'mistral-nemo:12b':  8.5,
  'deepseek-r1:14b':   10.0,
  'phi4-reasoning:14b': 10.0,
  'qwen2.5:32b':       22.0,
  'deepseek-r1:32b':   22.0,
  'qwen3.5:27b':       18.0,
  'mistral-small:24b': 16.0,
  'llama3.3:70b':      45.0,
  'llama-2-7b-Q4_0':   5.0,
};

const MODEL_SHORTNAMES = {
  'deepseek-r1:7b':     'ds-r1:7b',
  'deepseek-r1:14b':    'ds-r1:14b',
  'deepseek-r1:32b':    'ds-r1:32b',
  'llama3.1:8b':        'llama3:8b',
  'llama3.2:3b':        'llama3:3b',
  'llama3.3:70b':       'llama3:70b',
  'mistral-small:24b':  'mistral:24b',
  'mistral-nemo:12b':   'nemo:12b',
  'qwen2.5:7b':         'qwen2:7b',
  'qwen2.5:32b':        'qwen2:32b',
  'qwen3.5:4b':         'qwen3:4b',
  'qwen3.5:9b':         'qwen3:9b',
  'qwen3.5:27b':        'qwen3:27b',
  'gemma3:4b':          'gemma3:4b',
  'phi4-reasoning:14b': 'phi4:14b',
  'llama-2-7b-Q4_0':   'llama2:7b',
};

// ── INIT ──
async function init() {
  try {
    const [benchResp, priceResp] = await Promise.all([
      fetch('data/benchmark_data.json'),
      fetch('data/gpu_prices.json'),
    ]);
    if (!benchResp.ok) throw new Error('benchmark_data.json: HTTP ' + benchResp.status);
    if (!priceResp.ok) throw new Error('gpu_prices.json: HTTP ' + priceResp.status);
    benchmarkData = await benchResp.json();
    gpuPrices = await priceResp.json();

    try { await loadAffiliateConfig(); } catch (e) { console.warn('Affiliate config failed:', e); }

    // Seed activeModelColumns: DEFAULT_MODEL_COLUMNS that exist in data, else first 4
    const availableModels = (benchmarkData.models || []).map(m => m.name);
    const matching = DEFAULT_MODEL_COLUMNS.filter(m => availableModels.includes(m));
    activeModelColumns = matching.length > 0
      ? new Set(matching)
      : new Set(availableModels.slice(0, 4));

    // Seed activeGpuRows: all GPUs visible by default
    activeGpuRows = new Set((benchmarkData.gpus || []).map(g => g.name));

    populateRecommenderModelSelect();
    updateSpeedContext(20);
    renderRecommendations();
    renderTable();
    populateBreakevenGpuSelect();
    renderBreakeven();
    updateFooterStats();
    bindEvents();
    simStart();

  } catch (err) {
    console.error('Failed to load data:', err);
    const tbody = document.getElementById('table-body');
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="20" class="cell-loading">Failed to load benchmark data: ' + err.message + '</td></tr>';
    }
    const recLoading = document.getElementById('rec-loading');
    if (recLoading) recLoading.textContent = 'Failed to load data.';
  }
}

// ── DATA HELPERS ──

function getBenchmarkSpeed(cell) {
  if (!cell) return null;
  if (typeof cell.median_tokens_per_sec === 'number' && isFinite(cell.median_tokens_per_sec)) {
    return cell.median_tokens_per_sec;
  }
  return null;
}

function getGpuPriceEntry(gpuName) {
  if (!gpuPrices || !gpuPrices.gpus) return null;
  // Exact match first
  if (gpuPrices.gpus[gpuName] !== undefined) return gpuPrices.gpus[gpuName];
  // Substring fallback
  for (const [key, val] of Object.entries(gpuPrices.gpus)) {
    if (gpuName.includes(key) || key.includes(gpuName)) return val;
  }
  return null;
}

function getUsedPrice(gpuName) {
  const entry = getGpuPriceEntry(gpuName);
  if (!entry) return null;
  return entry.used_usd > 0 ? entry.used_usd : null;
}

function getRetailPrice(gpuName) {
  const entry = getGpuPriceEntry(gpuName);
  if (!entry) return null;
  return entry.retail_usd > 0 ? entry.retail_usd : null;
}

function getPlatformCost(gpuName) {
  const entry = getGpuPriceEntry(gpuName);
  if (!entry || entry.platform_build_usd == null) return null;
  return entry.platform_build_usd;
}

function getActivePrice(gpuName) {
  if (condition === 'new') return getRetailPrice(gpuName);
  if (condition === 'build') {
    const usedPrice    = getUsedPrice(gpuName);
    const platformCost = getPlatformCost(gpuName);
    if (usedPrice === null || platformCost === null) return null;
    return usedPrice + platformCost;
  }
  return getUsedPrice(gpuName);
}

function getVramGb(gpuName) {
  const entry = getGpuPriceEntry(gpuName);
  if (entry && entry.vram_gb) return entry.vram_gb;
  // Fallback: check benchmarkData.gpus
  if (benchmarkData && benchmarkData.gpus) {
    const row = benchmarkData.gpus.find(g => g.name === gpuName);
    if (row && row.vram_gb) return row.vram_gb;
  }
  return null;
}

// ── RECOMMENDER ──

function populateRecommenderModelSelect() {
  const sel = document.getElementById('rec-model-select');
  if (!sel || !benchmarkData || !benchmarkData.models) return;

  // Sort by MODEL_VRAM_GB then by name
  const models = [...benchmarkData.models].sort((a, b) => {
    const va = MODEL_VRAM_GB[a.name] || 999;
    const vb = MODEL_VRAM_GB[b.name] || 999;
    if (va !== vb) return va - vb;
    return a.name.localeCompare(b.name);
  });

  sel.innerHTML = '';
  models.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.name;
    opt.textContent = m.name;
    sel.appendChild(opt);
  });

  // Default to first 8b/7b match
  const preferred = models.find(m => /8b|7b/i.test(m.name));
  if (preferred) sel.value = preferred.name;

  updateModelHint();
}

function updateModelHint() {
  const sel = document.getElementById('rec-model-select');
  const hint = document.getElementById('rec-model-hint');
  if (!sel || !hint) return;
  const vram = MODEL_VRAM_GB[sel.value];
  hint.textContent = vram !== undefined ? 'Needs ~' + vram + ' GB VRAM' : '';
}

function updateSpeedContext(value) {
  const el = document.getElementById('rec-speed-context');
  if (!el) return;
  const v = Number(value);
  for (const [lo, hi, label] of SPEED_CONTEXT_LABELS) {
    if (v >= lo && v <= hi) {
      el.textContent = label;
      return;
    }
  }
  el.textContent = '';
}

function renderRecommendations() {
  if (!benchmarkData || !gpuPrices) return;

  const recLoading = document.getElementById('rec-loading');
  const recEmpty   = document.getElementById('rec-empty');
  const recCards   = document.getElementById('rec-cards');
  if (!recCards) return;

  if (recLoading) recLoading.hidden = true;

  const modelSel = document.getElementById('rec-model-select');
  const model    = modelSel ? modelSel.value : null;
  const speedEl  = document.getElementById('rec-speed-range');
  const budgetEl = document.getElementById('rec-budget-range');
  const desiredSpeed = speedEl ? parseFloat(speedEl.value) || 0 : 0;
  const budget       = budgetEl ? parseFloat(budgetEl.value) || Infinity : Infinity;

  if (!model) {
    recEmpty.hidden = false;
    recCards.hidden = true;
    return;
  }

  const candidates = [];
  for (const gpu of benchmarkData.gpus) {
    const bench = gpu.benchmarks[model];
    if (!bench) continue;
    if (bench.inference_type === 'cpu_offload') continue;
    const speed = getBenchmarkSpeed(bench);
    if (speed === null) continue;
    if (speed < desiredSpeed) continue;
    const price = getActivePrice(gpu.name);
    if (price === null || price > budget) continue;

    candidates.push({
      name:     gpu.name,
      speed:    speed,
      price:    price,
      vram:     getVramGb(gpu.name),
      value:    speed / price,
      samples:  bench.samples,
      inferenceType: bench.inference_type || 'gpu_full',
    });
  }

  // Sort by value descending (tok/s per dollar)
  candidates.sort((a, b) => b.value - a.value);

  if (candidates.length === 0) {
    if (recEmpty) recEmpty.hidden = false;
    recCards.hidden = true;
    return;
  }

  if (recEmpty) recEmpty.hidden = true;
  recCards.hidden = false;

  const top = candidates.slice(0, 3);
  recCards.innerHTML = '';

  top.forEach((gpu, i) => {
    const isBest = i === 0;
    const rankLabel = isBest ? 'Best Value' : '#' + (i + 1);
    const cardClass = 'rec-card' + (isBest ? ' rec-card--best' : '');
    const badgeClass = 'rec-rank-badge' + (isBest ? ' rec-rank-badge--best' : '');

    const priceLabel = condition === 'new' ? 'New Price'
                     : condition === 'build' ? 'Build Cost'
                     : 'Used Price';
    const priceFormatted = '$' + gpu.price.toLocaleString('en-US');
    const vramText = gpu.vram !== null ? gpu.vram + ' GB' : '&#8212;';
    const valueText = (gpu.value * 1000).toFixed(0) + ' tok/$K';

    const amazonLink = (typeof getAffiliateLink === 'function') ? getAffiliateLink(gpu.name) : null;
    const priceEntry = getGpuPriceEntry(gpu.name);
    const rentalRate = priceEntry ? priceEntry.vastai_rental_usd_per_hr : undefined;
    const vastaiLink = (typeof getVastaiReferralLink === 'function') ? getVastaiReferralLink() : 'https://vast.ai';

    const buyBtn = amazonLink
      ? '<a href="' + escapeAttr(amazonLink) + '" target="_blank" rel="noopener noreferrer sponsored" class="btn btn--primary">Buy on Amazon</a>'
      : '';
    const rentBtn = (rentalRate !== undefined && rentalRate !== null)
      ? '<a href="' + escapeAttr(vastaiLink) + '" target="_blank" rel="noopener noreferrer sponsored" class="btn btn--rent">Rent on Vast.ai</a>'
      : '';

    const lowConfHidden = (gpu.samples !== 1) ? ' hidden' : '';

    const card = document.createElement('div');
    card.className = cardClass;
    card.innerHTML =
      '<div class="rec-card-header">' +
        '<span class="' + badgeClass + '">' + rankLabel + '</span>' +
        '<h3 class="rec-gpu-name">' + escapeHtml(gpu.name) + '</h3>' +
      '</div>' +
      '<dl class="rec-stats">' +
        '<div class="rec-stat">' +
          '<dt class="rec-stat-label">Speed</dt>' +
          '<dd class="rec-stat-value rec-stat-value--speed">' + gpu.speed.toFixed(1) + ' tok/s</dd>' +
        '</div>' +
        '<div class="rec-stat">' +
          '<dt class="rec-stat-label">' + priceLabel + '</dt>' +
          '<dd class="rec-stat-value rec-stat-value--price">' + priceFormatted + '</dd>' +
        '</div>' +
        '<div class="rec-stat">' +
          '<dt class="rec-stat-label">VRAM</dt>' +
          '<dd class="rec-stat-value">' + vramText + '</dd>' +
        '</div>' +
        '<div class="rec-stat">' +
          '<dt class="rec-stat-label">Value</dt>' +
          '<dd class="rec-stat-value">' + valueText + '</dd>' +
        '</div>' +
      '</dl>' +
      '<div class="rec-card-actions">' +
        buyBtn +
        rentBtn +
      '</div>' +
      '<p class="rec-low-confidence"' + lowConfHidden + '>Single-sample data — treat as estimate.</p>';

    recCards.appendChild(card);
  });
}

// ── BENCHMARK TABLE ──

function renderTable() {
  const thead = document.getElementById('table-head');
  const tbody = document.getElementById('table-body');
  if (!thead || !tbody || !benchmarkData) return;

  // Sync GPU row pills and model column pills before building table
  populateGpuPills();
  populateModelPills();

  const allModels = (benchmarkData.models || []).map(m => m.name);
  let models = allModels.filter(m => activeModelColumns.has(m));
  if (models.length === 0) models = allModels;

  // Filter GPU rows first, then sort the filtered subset
  let gpus = (benchmarkData.gpus || []).filter(g => activeGpuRows.has(g.name));

  // Apply sort
  if (sortColumn === 'gpu') {
    gpus.sort((a, b) => {
      const cmp = a.name.localeCompare(b.name);
      return sortDirection === 'asc' ? cmp : -cmp;
    });
  } else if (sortColumn === 'vram') {
    gpus.sort((a, b) => {
      const va = getVramGb(a.name) || 0;
      const vb = getVramGb(b.name) || 0;
      return sortDirection === 'asc' ? va - vb : vb - va;
    });
  } else if (sortColumn === 'price') {
    gpus.sort((a, b) => {
      const pa = getActivePrice(a.name) || Infinity;
      const pb = getActivePrice(b.name) || Infinity;
      return sortDirection === 'asc' ? pa - pb : pb - pa;
    });
  } else if (sortColumn !== null) {
    // Sort by a model column
    gpus.sort((a, b) => {
      const va = getBenchmarkSpeed(a.benchmarks[sortColumn]) || 0;
      const vb = getBenchmarkSpeed(b.benchmarks[sortColumn]) || 0;
      return sortDirection === 'asc' ? va - vb : vb - va;
    });
  }

  // Collect all speed values for heatmap (all inference types participate)
  const allSpeeds = [];
  for (const gpu of gpus) {
    for (const m of models) {
      const bench = (gpu.benchmarks || {})[m];
      if (!bench) continue;
      const v = getBenchmarkSpeed(bench);
      if (v !== null) allSpeeds.push(v);
    }
  }
  const { p60, p80 } = computeHeatmap(allSpeeds);

  // ── Build thead ──
  const headRow = document.createElement('tr');

  // GPU column header
  const thGpu = document.createElement('th');
  thGpu.className = 'col-gpu' + getSortClass('gpu');
  thGpu.textContent = 'GPU';
  thGpu.dataset.sort = 'gpu';
  headRow.appendChild(thGpu);

  // VRAM column header
  const thVram = document.createElement('th');
  thVram.className = 'col-vram' + getSortClass('vram');
  thVram.textContent = 'VRAM';
  thVram.dataset.sort = 'vram';
  headRow.appendChild(thVram);

  // Price column header
  const thPrice = document.createElement('th');
  thPrice.className = 'col-price' + getSortClass('price');
  thPrice.textContent = condition === 'new' ? 'New Price'
                      : condition === 'build' ? 'Build Cost'
                      : 'Used Price';
  thPrice.dataset.sort = 'price';
  headRow.appendChild(thPrice);

  // Model columns
  models.forEach(m => {
    const th = document.createElement('th');
    th.className = 'col-model' + getSortClass(m);
    th.textContent = MODEL_SHORTNAMES[m] || m;
    th.title = m;
    th.dataset.sort = m;
    headRow.appendChild(th);
  });

  // Attach sort listeners to all th elements
  headRow.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => sortBy(th.dataset.sort));
  });

  thead.innerHTML = '';
  thead.appendChild(headRow);

  // ── Build tbody ──
  const fragment = document.createDocumentFragment();

  for (const gpu of gpus) {
    const tr = document.createElement('tr');

    // GPU name cell
    const tdGpu = document.createElement('td');
    tdGpu.className = 'col-gpu';
    const amazonLink = (typeof getAffiliateLink === 'function') ? getAffiliateLink(gpu.name) : null;
    const nameText = escapeHtml(gpu.name);
    let gpuCellInner = amazonLink
      ? '<a href="' + escapeAttr(amazonLink) + '" target="_blank" rel="noopener noreferrer sponsored">' + nameText + '</a>'
      : nameText;

    // Low confidence badge: show if GPU has data for active models but none has samples > 1
    const activeBenches = models
      .map(m => (gpu.benchmarks || {})[m])
      .filter(b => b !== undefined && b !== null);
    if (activeBenches.length > 0) {
      const hasHighSample = activeBenches.some(b => (b.samples || 0) >= 2);
      if (!hasHighSample) {
        gpuCellInner += ' <span class="badge badge--low">1 sample</span>';
      }
    }
    tdGpu.innerHTML = gpuCellInner;
    tr.appendChild(tdGpu);

    // VRAM cell
    const tdVram = document.createElement('td');
    tdVram.className = 'col-vram';
    const vram = getVramGb(gpu.name);
    tdVram.textContent = vram !== null ? vram + ' GB' : '';
    if (vram === null) tdVram.innerHTML = '&#8212;';
    tr.appendChild(tdVram);

    // Price cell
    const tdPrice = document.createElement('td');
    tdPrice.className = 'col-price';
    const price = getActivePrice(gpu.name);
    tdPrice.textContent = price !== null ? '$' + price.toLocaleString('en-US') : '';
    if (price === null) tdPrice.innerHTML = '&#8212;';
    tr.appendChild(tdPrice);

    // Model benchmark cells
    for (const m of models) {
      const td = document.createElement('td');
      const bench = (gpu.benchmarks || {})[m];
      if (!bench) {
        td.className = 'col-speed col-speed--na';
        td.innerHTML = '&#8212;';
        tr.appendChild(td);
        continue;
      }

      const speed = getBenchmarkSpeed(bench);
      if (speed === null) {
        td.className = 'col-speed col-speed--na';
        td.innerHTML = '&#8212;';
        tr.appendChild(td);
        continue;
      }

      const inferenceType = bench.inference_type || 'gpu_full';
      const cellClass = getCellClass(speed, inferenceType, { p60, p80 });
      td.className = cellClass;

      // Tooltip
      const minTps = typeof bench.min_tokens_per_sec === 'number' ? bench.min_tokens_per_sec.toFixed(1) : '?';
      const maxTps = typeof bench.max_tokens_per_sec === 'number' ? bench.max_tokens_per_sec.toFixed(1) : '?';
      const samples = bench.samples || '?';
      td.title = samples + ' sample' + (samples !== 1 ? 's' : '') + ', range: ' + minTps + '\u2013' + maxTps + ' tok/s';

      let cellInner = speed.toFixed(1);

      // Offload indicator: superscript icon with JS tooltip (avoids CSS overflow clipping)
      if (inferenceType === 'cpu_offload') {
        cellInner += '<span class="offload-icon" tabindex="0" role="img" aria-label="CPU offload warning" data-tooltip="CPU offload: model weights exceed VRAM. Layers run on system RAM \u2014 expect 2\u20135\u00d7 slower than pure GPU.">\u26a0</span>';
      } else if (inferenceType === 'gpu_partial') {
        cellInner += '<span class="offload-icon offload-icon--partial" tabindex="0" role="img" aria-label="Partial offload" data-tooltip="Partial offload: most layers fit in VRAM, a few spill to system RAM. Some speed penalty.">~</span>';
      }

      td.innerHTML = cellInner;
      tr.appendChild(td);
    }

    fragment.appendChild(tr);
  }

  tbody.innerHTML = '';
  if (gpus.length === 0) {
    // activeGpuRows is empty — show a helpful message instead of a blank table
    const colCount = 3 + models.length;
    const tr = document.createElement('tr');
    tr.className = 'row-no-gpus';
    const td = document.createElement('td');
    td.colSpan = colCount;
    td.textContent = 'No GPUs selected. Use the GPU filters above to show results.';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    tbody.appendChild(fragment);
  }
}

function populateModelPills() {
  const container = document.getElementById('model-pills');
  if (!container || !benchmarkData) return;

  const allModels = (benchmarkData.models || []).map(m => m.name);
  container.innerHTML = '';

  allModels.forEach(modelName => {
    const btn = document.createElement('button');
    btn.className = 'model-pill' + (activeModelColumns.has(modelName) ? ' model-pill--active' : '');
    btn.textContent = MODEL_SHORTNAMES[modelName] || modelName;
    btn.title = modelName;
    btn.addEventListener('click', () => {
      if (activeModelColumns.has(modelName)) {
        // Enforce minimum 1 active
        if (activeModelColumns.size <= 1) return;
        activeModelColumns.delete(modelName);
      } else {
        activeModelColumns.add(modelName);
      }
      renderTable();
    });
    container.appendChild(btn);
  });
}

function populateGpuPills() {
  const container = document.getElementById('gpu-pills');
  if (!container || !benchmarkData) return;

  const allGpus = (benchmarkData.gpus || []).map(g => g.name);
  container.innerHTML = '';

  allGpus.forEach(gpuName => {
    const btn = document.createElement('button');
    btn.className = 'gpu-pill' + (activeGpuRows.has(gpuName) ? ' gpu-pill--active' : '');
    btn.textContent = gpuName;
    btn.title = activeGpuRows.has(gpuName) ? 'Hide ' + gpuName : 'Show ' + gpuName;
    btn.addEventListener('click', () => {
      if (activeGpuRows.has(gpuName)) activeGpuRows.delete(gpuName);
      else activeGpuRows.add(gpuName);
      renderTable();
    });
    container.appendChild(btn);
  });
}

function computeHeatmap(speeds) {
  if (!speeds || speeds.length === 0) return { p60: 0, p80: 0 };
  const sorted = [...speeds].sort((a, b) => a - b);
  const n = sorted.length;
  const p60 = sorted[Math.floor(n * 0.60)] || 0;
  const p80 = sorted[Math.floor(n * 0.80)] || 0;
  return { p60, p80 };
}

function getCellClass(speed, inferenceType, pct) {
  // All cells participate in heatmap coloring; offload type shown via .offload-icon superscript
  const { p60, p80 } = pct || { p60: 0, p80: 0 };
  if (p80 > 0 && speed >= p80) return 'col-speed col-speed--hot';
  if (p60 > 0 && speed >= p60) return 'col-speed col-speed--warm';
  return 'col-speed';
}

function getSortClass(col) {
  if (sortColumn !== col) return '';
  return sortDirection === 'asc' ? ' col-sorted-asc' : ' col-sorted-desc';
}

function sortBy(column) {
  if (sortColumn === column) {
    if (sortDirection === 'desc') {
      // Second click: switch to asc
      sortDirection = 'asc';
    } else {
      // Third click: clear sort
      sortColumn = null;
      sortDirection = 'desc';
    }
  } else {
    // First click on new column: desc
    sortColumn = column;
    sortDirection = 'desc';
  }
  renderTable();
}

// ── BREAKEVEN CALCULATOR ──

function populateBreakevenGpuSelect() {
  const sel = document.getElementById('be-gpu-select');
  const resultEl = document.getElementById('breakeven-result');
  if (!sel || !benchmarkData || !gpuPrices) return;

  // Filter: GPUs in benchmarkData that also have vastai_rental_usd_per_hr in gpu_prices
  const qualifying = (benchmarkData.gpus || []).filter(gpu => {
    const entry = getGpuPriceEntry(gpu.name);
    return entry && typeof entry.vastai_rental_usd_per_hr === 'number';
  });

  sel.innerHTML = '';

  if (qualifying.length === 0) {
    if (resultEl) resultEl.textContent = 'Rental price data not yet available. Check back soon.';
    return;
  }

  qualifying.forEach(gpu => {
    const opt = document.createElement('option');
    opt.value = gpu.name;
    opt.textContent = gpu.name;
    sel.appendChild(opt);
  });

  // Pre-fill price input with price of first qualifying GPU
  prefillBreakevenPrice();
}

function prefillBreakevenPrice() {
  const sel        = document.getElementById('be-gpu-select');
  const priceInput = document.getElementById('be-price-input');
  const priceLabel = document.getElementById('be-price-label');
  if (!sel || !priceInput) return;

  if (condition === 'build') {
    const buildPrice = getActivePrice(sel.value);
    if (buildPrice !== null) priceInput.value = buildPrice;
    if (priceLabel) priceLabel.textContent = 'Total Build Cost ($)';
  } else {
    const usedPrice = getUsedPrice(sel.value);
    if (usedPrice !== null) priceInput.value = usedPrice;
    if (priceLabel) priceLabel.textContent = 'GPU Used Price ($)';
  }
}

function renderBreakeven() {
  const resultEl = document.getElementById('breakeven-result');
  if (!resultEl) return;

  const sel = document.getElementById('be-gpu-select');
  const hoursEl = document.getElementById('be-hours-range');
  const priceInputEl = document.getElementById('be-price-input');

  if (!sel || !sel.value || !hoursEl || !priceInputEl) {
    return;
  }

  const gpuName = sel.value;
  const hoursPerDay = parseFloat(hoursEl.value) || 0;
  const purchasePrice = parseFloat(priceInputEl.value) || 0;

  const entry = getGpuPriceEntry(gpuName);
  const rentalRate = entry ? entry.vastai_rental_usd_per_hr : null;

  if (!rentalRate || rentalRate <= 0) {
    resultEl.textContent = 'Rental price data not yet available. Check back soon.';
    return;
  }

  if (hoursPerDay <= 0 || purchasePrice <= 0) {
    resultEl.innerHTML = '<p class="breakeven-verdict">Enter a valid price and usage to calculate breakeven.</p>';
    return;
  }

  const rentalCostPerDay   = hoursPerDay * rentalRate;
  const rentalCostPerMonth = rentalCostPerDay * 30.44;
  const breakevenMonths    = purchasePrice / rentalCostPerMonth;
  const breakevenHours     = purchasePrice / rentalRate;

  // Update Vast.ai referral link
  const vastaiRefLink = document.getElementById('vastai-referral-link');
  if (vastaiRefLink && typeof getVastaiReferralLink === 'function') {
    vastaiRefLink.href = getVastaiReferralLink();
  }

  let verdict;
  if (breakevenMonths < 12) {
    verdict = 'Break even in under 12 months — buying is likely worth it at this usage level.';
  } else if (breakevenMonths <= 36) {
    verdict = 'Break even in 1\u20133 years \u2014 depends on how long you\'ll use it.';
  } else {
    verdict = 'Over 3 years to break even — renting is probably smarter.';
  }

  const purchaseLabel = condition === 'build' ? 'Total Build Cost' : 'Purchase price';

  resultEl.innerHTML =
    '<div class="breakeven-output">' +
      '<div class="breakeven-stat-row">' +
        '<div class="breakeven-stat">' +
          '<span class="breakeven-stat-label">Breakeven</span>' +
          '<span class="breakeven-stat-value breakeven-stat-value--primary">' + breakevenMonths.toFixed(1) + ' months</span>' +
          '<span class="breakeven-stat-sub">at ' + hoursPerDay + ' hr/day usage</span>' +
        '</div>' +
        '<div class="breakeven-stat">' +
          '<span class="breakeven-stat-label">Total hours to break even</span>' +
          '<span class="breakeven-stat-value">' + Math.round(breakevenHours).toLocaleString('en-US') + ' hours</span>' +
        '</div>' +
        '<div class="breakeven-stat">' +
          '<span class="breakeven-stat-label">Monthly rental cost</span>' +
          '<span class="breakeven-stat-value breakeven-stat-value--rent">$' + rentalCostPerMonth.toFixed(2) + '</span>' +
          '<span class="breakeven-stat-sub">$' + rentalRate.toFixed(2) + '/hr \u00d7 ' + hoursPerDay + ' hr/day</span>' +
        '</div>' +
        '<div class="breakeven-stat">' +
          '<span class="breakeven-stat-label">' + purchaseLabel + '</span>' +
          '<span class="breakeven-stat-value">$' + purchasePrice.toLocaleString('en-US') + '</span>' +
        '</div>' +
      '</div>' +
      '<p class="breakeven-verdict">' + escapeHtml(verdict) + '</p>' +
    '</div>';
}

// ── SPEED SIMULATION ──

const SIM_TEXT =
  'The main bottleneck for LLM inference on a single GPU is memory bandwidth, ' +
  'not compute. Each forward pass must stream the entire model weight matrix from ' +
  'VRAM into the shader cores. A 7B model at 4-bit quantization occupies roughly ' +
  '4 GB; generating one token requires reading most of that. An RTX 4090 has 1008 ' +
  'GB/s of bandwidth, which is why it sustains 80\u2013120 tok/s on 7B models that fit ' +
  'in its 24 GB. Halve the bandwidth and you roughly halve throughput. This is also ' +
  'why running a 70B model across two GPUs over PCIe is slower than a single A100 ' +
  '\u2014 the inter-GPU link becomes the bottleneck, not the chips themselves.';

function simGetInterval(tokPerSec) {
  // Minimum 8ms (browser timer floor / ~120fps cap)
  return Math.max(8, 1000 / (tokPerSec * 4));
}

function simGetCharsPerTick(tokPerSec) {
  // Batch multiple chars per tick at high speeds so effective rate stays correct
  const charsPerSec = tokPerSec * 4;
  const intervalMs  = simGetInterval(tokPerSec);
  return Math.max(1, Math.round(charsPerSec * intervalMs / 1000));
}

function simStop() {
  if (simTimerId !== null) {
    clearInterval(simTimerId);
    clearTimeout(simTimerId);
    simTimerId = null;
  }
  simPausing = false;
}

function simStart() {
  simStop();
  if (!simEnabled) return;

  const speedEl   = document.getElementById('rec-speed-range');
  const tokPerSec = speedEl ? Math.max(1, parseFloat(speedEl.value) || 20) : 20;

  const intervalMs   = simGetInterval(tokPerSec);
  const charsPerTick = simGetCharsPerTick(tokPerSec);
  const textEl = document.getElementById('speed-sim-text');
  if (!textEl) return;

  simTimerId = setInterval(() => {
    if (simPausing) return;

    const end = Math.min(simCharIndex + charsPerTick, SIM_TEXT.length);
    textEl.textContent = SIM_TEXT.slice(0, end);
    simCharIndex = end;

    if (simCharIndex >= SIM_TEXT.length) {
      simStop();
      simPausing = true;
      simTimerId = setTimeout(() => {
        simPausing   = false;
        simCharIndex = 0;
        if (simEnabled) simStart();
      }, 1500);
    }
  }, intervalMs);
}

function simRestart() {
  simStop();
  simCharIndex = 0;
  const textEl = document.getElementById('speed-sim-text');
  if (textEl) textEl.textContent = '';
  if (simEnabled) simStart();
}

function simUpdateLabel(tokPerSec) {
  const labelEl = document.getElementById('speed-sim-label');
  if (labelEl) labelEl.textContent = 'At ' + tokPerSec + ' tok/s, a streamed response looks like:';
}

// ── EVENT BINDING ──

function bindEvents() {
  // Recommender: model select
  const recModelSel = document.getElementById('rec-model-select');
  if (recModelSel) {
    recModelSel.addEventListener('change', () => {
      updateModelHint();
      renderRecommendations();
    });
  }

  // Recommender: speed range
  const recSpeedRange = document.getElementById('rec-speed-range');
  const recSpeedVal   = document.getElementById('rec-speed-val');
  if (recSpeedRange) {
    recSpeedRange.addEventListener('input', (e) => {
      if (recSpeedVal) recSpeedVal.textContent = e.target.value + ' tok/s';
      updateSpeedContext(e.target.value);
      renderRecommendations();
    });
    // Speed simulation: sync rate and label with slider
    recSpeedRange.addEventListener('input', (e) => {
      simUpdateLabel(e.target.value);
      simRestart();
    });
  }

  // Speed simulation: toggle button
  const simToggleBtn = document.getElementById('speed-sim-toggle');
  if (simToggleBtn) {
    simToggleBtn.addEventListener('click', () => {
      simEnabled = !simEnabled;
      const simEl = document.getElementById('speed-sim');
      simToggleBtn.textContent = simEnabled ? 'On' : 'Off';
      simToggleBtn.setAttribute('aria-pressed', String(simEnabled));
      simToggleBtn.classList.toggle('is-off', !simEnabled);
      if (simEl) simEl.classList.toggle('is-off', !simEnabled);
      if (simEnabled) simRestart();
      else simStop();
    });
  }

  // Recommender: budget range
  const recBudgetRange = document.getElementById('rec-budget-range');
  const recBudgetVal   = document.getElementById('rec-budget-val');
  if (recBudgetRange) {
    recBudgetRange.addEventListener('input', (e) => {
      if (recBudgetVal) recBudgetVal.textContent = '$' + Number(e.target.value).toLocaleString('en-US');
      renderRecommendations();
    });
  }

  // Condition toggle buttons
  document.querySelectorAll('.toggle-btn[data-condition]').forEach(btn => {
    btn.addEventListener('click', () => {
      condition = btn.dataset.condition;
      // Update active state
      document.querySelectorAll('.toggle-btn[data-condition]').forEach(b => {
        b.classList.toggle('is-active', b.dataset.condition === condition);
      });
      // Show/hide build cost hint
      const buildHint = document.getElementById('build-cost-hint');
      if (buildHint) buildHint.hidden = (condition !== 'build');
      renderRecommendations();
      renderTable();
      prefillBreakevenPrice();
    });
  });

  // Table reset button
  const tableResetBtn = document.getElementById('table-reset-btn');
  if (tableResetBtn) {
    tableResetBtn.addEventListener('click', () => {
      const availableModels = (benchmarkData.models || []).map(m => m.name);
      const matching = DEFAULT_MODEL_COLUMNS.filter(m => availableModels.includes(m));
      activeModelColumns = new Set(
        matching.length > 0 ? matching : availableModels.slice(0, 4)
      );
      activeGpuRows = new Set((benchmarkData.gpus || []).map(g => g.name));
      sortColumn = null;
      sortDirection = 'desc';
      renderTable();
    });
  }

  // GPU filter: All button
  const gpuAllBtn = document.getElementById('gpu-all-btn');
  if (gpuAllBtn) {
    gpuAllBtn.addEventListener('click', () => {
      activeGpuRows = new Set((benchmarkData.gpus || []).map(g => g.name));
      renderTable();
    });
  }

  // GPU filter: None button
  const gpuNoneBtn = document.getElementById('gpu-none-btn');
  if (gpuNoneBtn) {
    gpuNoneBtn.addEventListener('click', () => {
      activeGpuRows = new Set();
      renderTable();
    });
  }

  // Breakeven: GPU select
  const beGpuSel = document.getElementById('be-gpu-select');
  if (beGpuSel) {
    beGpuSel.addEventListener('change', () => {
      prefillBreakevenPrice();
      renderBreakeven();
    });
  }

  // Breakeven: hours range
  const beHoursRange = document.getElementById('be-hours-range');
  const beHoursVal   = document.getElementById('be-hours-val');
  if (beHoursRange) {
    beHoursRange.addEventListener('input', (e) => {
      if (beHoursVal) beHoursVal.textContent = e.target.value + ' hr/day';
      renderBreakeven();
    });
  }

  // Breakeven: price input
  const bePriceInput = document.getElementById('be-price-input');
  if (bePriceInput) {
    bePriceInput.addEventListener('input', () => {
      renderBreakeven();
    });
  }

  // regionchange custom event from links.js
  document.addEventListener('regionchange', () => {
    renderRecommendations();
    renderTable();
  });

  // Offload icon tooltip (position:fixed to fully escape table overflow:auto context)
  document.addEventListener('mouseover', (e) => {
    const icon = e.target.closest('.offload-icon');
    if (!icon || !icon.dataset.tooltip) return;
    let tip = document.getElementById('offload-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'offload-tooltip';
      document.body.appendChild(tip);
    }
    tip.textContent = icon.dataset.tooltip;
    const r = icon.getBoundingClientRect();
    tip.style.left = (r.left + r.width / 2) + 'px';
    tip.style.top  = (r.top - 4) + 'px';
    tip.style.opacity = '1';
  });
  document.addEventListener('mouseout', (e) => {
    if (!e.target.closest('.offload-icon')) return;
    const tip = document.getElementById('offload-tooltip');
    if (tip) tip.style.opacity = '0';
  });
}

// ── FOOTER / METADATA ──

function updateFooterStats() {
  if (!benchmarkData) return;

  const gpuCount   = (benchmarkData.gpus || []).length;
  const modelCount = (benchmarkData.models || []).length;

  // Hero section counts
  const statGpuEl    = document.getElementById('stat-gpu-count');
  const statModelEl  = document.getElementById('stat-model-count');
  if (statGpuEl)   statGpuEl.textContent   = gpuCount;
  if (statModelEl) statModelEl.textContent = modelCount;

  // Footer counts
  const footerGpuEl   = document.getElementById('stat-gpu-count-footer');
  const footerModelEl = document.getElementById('stat-model-count-footer');
  if (footerGpuEl)   footerGpuEl.textContent   = gpuCount;
  if (footerModelEl) footerModelEl.textContent = modelCount;

  // Data date
  const dataDateEl = document.getElementById('data-date');
  if (dataDateEl && benchmarkData.metadata && benchmarkData.metadata.generated_at) {
    const d = new Date(benchmarkData.metadata.generated_at);
    dataDateEl.textContent = d.toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
    });
  }
}

// ── UTILITIES ──

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  if (str == null) return '';
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── BOOTSTRAP ──
document.addEventListener('DOMContentLoaded', init);
