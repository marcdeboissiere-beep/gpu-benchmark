// ========== GPU INFERENCE BENCHMARK - MAIN APP ==========

let benchmarkData = null;
let gpuPrices = null;
let currentModel = null;
let sortColumn = null;
let sortDirection = 'desc';
let condition = 'used'; // 'new' or 'used'

// Visualizer state
let vizRunning = false;
let vizAnimationIds = [];
let vizCompareMode = false;

// ========== POWER EFFICIENCY DATA ==========
// GPU TDP reference values (max power draw in watts)
const GPU_TDP_WATTS = {
  'RTX 5090': 575, 'RTX 5080': 360, 'RTX 5070 Ti': 300, 'RTX 5070': 250,
  'RTX 4090': 450, 'RTX 4080 Super': 320, 'RTX 4080': 320,
  'RTX 4070 Ti Super': 285, 'RTX 4070 Ti': 285, 'RTX 4070 Super': 220, 'RTX 4070': 200,
  'RTX 4060 Ti 16GB': 165, 'RTX 4060 Ti': 160, 'RTX 4060': 115,
  'RTX 3090': 350, 'RTX 3080 Ti': 350, 'RTX 3080': 320, 'RTX 3070': 220, 'RTX 3060': 170,
  'RX 9070 XT': 304, 'RX 7900 XTX': 355, 'RX 7900 XT': 300,
  'Arc B580': 190
};

function getGpuTdp(gpuName) {
  if (GPU_TDP_WATTS[gpuName]) return GPU_TDP_WATTS[gpuName];
  for (const [key, val] of Object.entries(GPU_TDP_WATTS)) {
    if (gpuName.includes(key) || key.includes(gpuName)) return val;
  }
  return null;
}

function getEfficiencyScore(gpuName, toksPerSec) {
  // No measured gpu_power_avg_w in current benchmark data — use TDP reference
  const tdp = getGpuTdp(gpuName);
  if (!tdp || !toksPerSec || toksPerSec < 5) return null;
  return (toksPerSec / tdp).toFixed(3);
}

// ========== CPU OFFLOAD HELPERS ==========
function getOffloadNote(vramGb, modelVramRequired) {
  if (modelVramRequired <= vramGb) return null;
  const gpuPct = Math.round((vramGb / modelVramRequired) * 100);
  return `~${gpuPct}% on GPU, rest on CPU RAM. Speed mainly limited by RAM bandwidth.`;
}

// ========== VRAM CALCULATOR DATA ==========
// VRAM requirements for models (in GB, for Q4_K_M quantization, comfortable inference)
const MODEL_VRAM_REQUIREMENTS = {
  'llama3.2:1b':       { vram: 1.5,  size: '1B',  quant: 'Q4_K_M' },
  'llama3.2:3b':       { vram: 2.5,  size: '3B',  quant: 'Q4_K_M' },
  'llama3.1:8b':       { vram: 5.5,  size: '8B',  quant: 'Q4_K_M' },
  'mistral:7b':        { vram: 5.0,  size: '7B',  quant: 'Q4_K_M' },
  'gemma2:9b':         { vram: 6.5,  size: '9B',  quant: 'Q4_K_M' },
  'qwen2.5:7b':        { vram: 5.0,  size: '7B',  quant: 'Q4_K_M' },
  'qwen2.5:14b':       { vram: 10.0, size: '14B', quant: 'Q4_K_M' },
  'deepseek-r1:7b':    { vram: 5.5,  size: '7B',  quant: 'Q4_K_M' },
  'deepseek-r1:14b':   { vram: 10.0, size: '14B', quant: 'Q4_K_M' },
  'mistral-small:24b': { vram: 16.0, size: '24B', quant: 'Q4_K_M' },
  'qwen2.5:32b':       { vram: 22.0, size: '32B', quant: 'Q4_K_M' },
  'deepseek-r1:32b':   { vram: 22.0, size: '32B', quant: 'Q4_K_M' },
  'llama3.3:70b':      { vram: 45.0, size: '70B', quant: 'Q4_K_M' },
  'qwen2.5:72b':       { vram: 47.0, size: '72B', quant: 'Q4_K_M' }
};

let selectedVram = null;

function setVramFilter(vramGb) {
  selectedVram = vramGb;

  // Update button states
  document.querySelectorAll('.vram-btn').forEach(btn => {
    btn.classList.toggle('selected', parseInt(btn.dataset.vram) === vramGb);
  });

  // Show results section
  const resultsDiv = document.getElementById('vram-calculator-results');
  resultsDiv.style.display = 'block';

  document.getElementById('vram-summary-title').textContent =
    `Models that fit in ${vramGb}GB VRAM (run at full GPU speed)`;

  const compatibleDiv = document.getElementById('vram-compatible-models');
  const incompatibleDiv = document.getElementById('vram-incompatible-models');

  compatibleDiv.innerHTML = '';
  incompatibleDiv.innerHTML = '';

  // Build a map of best median tok/s per model from benchmark data
  const modelSpeeds = {};
  if (benchmarkData && benchmarkData.gpus) {
    for (const gpu of benchmarkData.gpus) {
      for (const [modelName, bench] of Object.entries(gpu.benchmarks || {})) {
        const spd = getBenchmarkSpeed(bench);
        if (spd !== null && (modelSpeeds[modelName] === undefined || spd > modelSpeeds[modelName])) {
          modelSpeeds[modelName] = spd;
        }
      }
    }
  }

  Object.entries(MODEL_VRAM_REQUIREMENTS)
    .sort((a, b) => a[1].vram - b[1].vram)
    .forEach(([modelName, req]) => {
      const fits = req.vram <= vramGb;
      const card = document.createElement('div');
      card.className = `model-card ${fits ? 'compatible' : 'incompatible'}`;

      const spd = modelSpeeds[modelName];
      const speedText = spd
        ? `<div class="model-speed">~${spd.toFixed(0)} tok/s</div>`
        : '';

      const offloadNote = fits ? null : getOffloadNote(vramGb, req.vram);
      card.innerHTML = `
        <div class="model-name">${modelName}</div>
        <div class="model-vram-needed">Needs ~${req.vram}GB VRAM</div>
        ${speedText}
        ${fits
          ? '<div style="color:#16a34a; font-size:0.75rem; margin-top:4px;">&#10003; Fits in VRAM</div>'
          : `<div style="color:#ef4444; font-size:0.75rem; margin-top:4px;">&#10007; Needs more VRAM</div>
             <div style="color:#d97706; font-size:0.75rem; margin-top:4px;">
               &#9889; Can run with CPU offloading
               <span class="badge badge-offload">Slower</span>
             </div>
             ${offloadNote ? `<div style="color:#94a3b8; font-size:0.7rem;">${offloadNote}</div>` : ''}
             <div style="color:#94a3b8; font-size:0.7rem;">Speed depends on RAM bandwidth &amp; PCIe</div>`}
      `;

      (fits ? compatibleDiv : incompatibleDiv).appendChild(card);
    });

  // Smooth scroll to results
  resultsDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ========== DATA LOADING ==========
async function init() {
  try {
    const [benchResp, priceResp] = await Promise.all([
      fetch('data/benchmark_data.json'),
      fetch('data/gpu_prices.json'),
    ]);
    if (!benchResp.ok) throw new Error(`benchmark_data.json: HTTP ${benchResp.status}`);
    if (!priceResp.ok) throw new Error(`gpu_prices.json: HTTP ${priceResp.status}`);
    benchmarkData = await benchResp.json();
    gpuPrices = await priceResp.json();

    try { await loadAffiliateConfig(); } catch (e) { console.warn('Affiliate config failed:', e); }

    // Seed active columns: use DEFAULT_MODELS that exist, else first 5
    const availableModels = benchmarkData.models.map(m => m.name);
    const matching = DEFAULT_MODELS.filter(m => availableModels.includes(m));
    activeModelColumns = matching.length > 0
      ? new Set(matching)
      : new Set(availableModels.slice(0, 5));

    populateModelSelect();
    populateVisualizerSelects();
    renderRecommendations();
    renderTable();
    try { renderCharts(); } catch (e) { console.warn('Charts failed (Chart.js may not be loaded):', e); }
    setupScrollAnimations();
    updateMetadata();
  } catch (err) {
    console.error('Failed to load data:', err);
    document.querySelector('.main').innerHTML =
      '<div class="card"><p class="no-results">Failed to load benchmark data: ' + err.message + '</p></div>';
  }
}

function updateMetadata() {
  const el = document.getElementById('dataDate');
  if (el && benchmarkData?.metadata?.generated_at) {
    const d = new Date(benchmarkData.metadata.generated_at);
    el.textContent = d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  }
  const gpuCount = document.getElementById('gpuCount');
  const modelCount = document.getElementById('modelCount');
  if (gpuCount) gpuCount.textContent = benchmarkData?.gpus?.length || 0;
  if (modelCount) modelCount.textContent = benchmarkData?.models?.length || 0;
}

// ========== MODEL SELECT ==========
function populateModelSelect() {
  const selects = document.querySelectorAll('.model-select');
  if (!benchmarkData?.models) return;

  selects.forEach(sel => {
    sel.innerHTML = '';
    benchmarkData.models
      .sort((a, b) => {
        const pa = parseFloat(a.params) || 0;
        const pb = parseFloat(b.params) || 0;
        return pa - pb;
      })
      .forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.name;
        opt.textContent = `${m.name} (${m.params})`;
        sel.appendChild(opt);
      });
    // Default to a mid-size model if available
    const mid = benchmarkData.models.find(m => m.name.includes('7b') || m.name.includes('8b'));
    if (mid) sel.value = mid.name;
  });

  currentModel = document.getElementById('modelSelect')?.value;
}

// ========== GPU PRICE HELPERS ==========
function getGpuPrice(gpuName) {
  if (!gpuPrices?.gpus) return null;

  // Try exact match first
  if (gpuPrices.gpus[gpuName]) {
    return gpuPrices.gpus[gpuName];
  }

  // Try fuzzy match (e.g., "RTX 3080" matches "RTX 3080")
  for (const [key, val] of Object.entries(gpuPrices.gpus)) {
    if (gpuName.includes(key) || key.includes(gpuName)) {
      return val;
    }
  }
  return null;
}

function getPrice(gpuName) {
  const info = getGpuPrice(gpuName);
  if (!info) return null;
  const p = condition === 'new' ? info.retail_usd : info.used_usd;
  return p > 0 ? p : null;
}

function getVram(gpuName) {
  const info = getGpuPrice(gpuName);
  return info?.vram_gb || null;
}

function getBenchmarkSpeed(bench) {
  if (!bench) return null;
  if (typeof bench.median_tokens_per_sec === 'number') return bench.median_tokens_per_sec;
  return null;
}

// ========== RECOMMENDER ==========
function renderRecommendations() {
  const container = document.getElementById('recommendations');
  if (!container || !benchmarkData || !gpuPrices) return;

  const model = document.getElementById('modelSelect')?.value;
  const desiredSpeed = parseFloat(document.getElementById('speedRange')?.value) || 0;
  const budget = parseFloat(document.getElementById('budgetRange')?.value) || 99999;

  if (!model) {
    container.innerHTML = '<p class="no-results">Select a model to get recommendations</p>';
    return;
  }

  // Find GPUs that meet criteria
  const reliableCandidates = [];
  const fallbackCandidates = [];
  for (const gpu of benchmarkData.gpus) {
    const bench = gpu.benchmarks[model];
    if (!bench || bench.inference_type === 'cpu_offload') continue;
    const speed = getBenchmarkSpeed(bench);
    if (speed == null) continue;
    if (speed < desiredSpeed) continue;
    const price = getPrice(gpu.name);
    if (!price || price > budget) continue;

    const candidate = {
      name: gpu.name,
      speed: speed,
      price: price,
      vram: getVram(gpu.name),
      value: speed / price, // tok/s per dollar
      samples: bench.samples,
      noisy: !!bench.noisy,
      successRate: typeof bench.success_rate_pct === 'number' ? bench.success_rate_pct : null,
    };

    const hasEnoughSamples = (bench.samples || 0) >= 2;
    if (!bench.noisy && hasEnoughSamples) {
      reliableCandidates.push(candidate);
    } else {
      fallbackCandidates.push(candidate);
    }
  }

  const candidates = reliableCandidates.length ? reliableCandidates : fallbackCandidates;

  // Sort by value (best first)
  candidates.sort((a, b) => b.value - a.value);

  if (candidates.length === 0) {
    container.innerHTML = '<p class="no-results">No GPU matches your criteria. Try adjusting the budget or speed requirement.</p>';
    return;
  }

  // Show top 3
  const top = candidates.slice(0, 3);
  const lowConfidenceBanner = reliableCandidates.length
    ? ''
    : '<p class="no-results" style="padding:0 0 12px 0;text-align:left">Only low-confidence datapoints are available for this filter (single-sample or noisy).</p>';

  container.innerHTML = lowConfidenceBanner + top.map((gpu, i) => {
    const link = getAmazonLink(gpu.name);
    const isBest = i === 0;
    return `
      <div class="rec-card ${isBest ? 'best' : ''}">
        ${isBest ? '<span class="rec-badge">Best Value</span>' : `<span class="rec-badge" style="background:var(--text-muted)">#${i + 1}</span>`}
        <div class="rec-gpu-name">${gpu.name}</div>
        <div class="rec-stats">
          <div class="rec-stat">
            <span class="rec-stat-label">Speed</span>
            <span class="rec-stat-value speed">${gpu.speed.toFixed(1)} tok/s</span>
          </div>
          <div class="rec-stat">
            <span class="rec-stat-label">${condition === 'new' ? 'New' : 'Used'} Price</span>
            <span class="rec-stat-value price">$${gpu.price}</span>
          </div>
          <div class="rec-stat">
            <span class="rec-stat-label">VRAM</span>
            <span class="rec-stat-value vram">${gpu.vram ? gpu.vram + ' GB' : 'N/A'}</span>
          </div>
          <div class="rec-stat">
            <span class="rec-stat-label">Value</span>
            <span class="rec-stat-value">${gpu.value.toFixed(2)} tok/s/$</span>
          </div>
          <div class="rec-stat">
            <span class="rec-stat-label">Reliability</span>
            <span class="rec-stat-value">${gpu.successRate !== null ? gpu.successRate.toFixed(1) + '% ok' : (gpu.noisy ? 'Noisy' : 'N/A')}</span>
          </div>
        </div>
        ${link ? `<a href="${link}" target="_blank" rel="noopener noreferrer" class="buy-btn">View on Amazon &rarr;</a>` : ''}
      </div>
    `;
  }).join('');
}

// ========== COLUMN TOGGLE ==========
const DEFAULT_MODELS = ['llama3.1:8b', 'mistral:7b', 'gemma2:9b', 'qwen2.5:7b', 'llama3.2:3b'];
let activeModelColumns = new Set(DEFAULT_MODELS);

function populateColumnToggles() {
  const container = document.getElementById('model-column-toggles');
  if (!container || !benchmarkData) return;

  const models = benchmarkData.models.map(m => m.name);
  container.innerHTML = '';

  models.forEach(modelName => {
    const pill = document.createElement('span');
    pill.className = 'model-toggle-pill' + (activeModelColumns.has(modelName) ? ' active' : '');
    pill.textContent = modelName;
    pill.dataset.model = modelName;
    pill.onclick = function() {
      if (activeModelColumns.has(modelName)) {
        if (activeModelColumns.size > 1) {
          activeModelColumns.delete(modelName);
        }
      } else {
        activeModelColumns.add(modelName);
      }
      renderTable();
    };
    container.appendChild(pill);
  });
}

function showTopModels() {
  activeModelColumns = new Set(DEFAULT_MODELS);
  renderTable();
}

// ========== BENCHMARK TABLE ==========
function renderTable() {
  const thead = document.getElementById('tableHead');
  const tbody = document.getElementById('tableBody');
  if (!thead || !tbody || !benchmarkData) return;

  // Sync toggle pills
  populateColumnToggles();

  const allModels = benchmarkData.models.map(m => m.name);
  // Filter to only active columns; fall back to all if none match active
  let models = allModels.filter(m => activeModelColumns.has(m));
  if (models.length === 0) models = allModels;
  const gpus = [...benchmarkData.gpus];

  // Sort GPUs
  if (sortColumn === 'gpu') {
    gpus.sort((a, b) => {
      const cmp = a.name.localeCompare(b.name);
      return sortDirection === 'asc' ? cmp : -cmp;
    });
  } else if (sortColumn === 'vram') {
    gpus.sort((a, b) => {
      const va = getVram(a.name) || 0;
      const vb = getVram(b.name) || 0;
      return sortDirection === 'asc' ? va - vb : vb - va;
    });
  } else if (sortColumn === 'price') {
    gpus.sort((a, b) => {
      const pa = getPrice(a.name) || 99999;
      const pb = getPrice(b.name) || 99999;
      return sortDirection === 'asc' ? pa - pb : pb - pa;
    });
  } else if (sortColumn) {
    // Sort by a model column
    gpus.sort((a, b) => {
      const va = getBenchmarkSpeed(a.benchmarks[sortColumn]) || 0;
      const vb = getBenchmarkSpeed(b.benchmarks[sortColumn]) || 0;
      return sortDirection === 'asc' ? va - vb : vb - va;
    });
  }

  // Collect all speed values for heatmap scaling
  const allSpeeds = [];
  for (const gpu of gpus) {
    for (const m of models) {
      const v = getBenchmarkSpeed(gpu.benchmarks[m]);
      if (v) allSpeeds.push(v);
    }
  }

  // Build header
  const sortClass = (col) => {
    if (sortColumn !== col) return '';
    return sortDirection === 'asc' ? 'sorted-asc' : 'sorted-desc';
  };

  // Use first active model as efficiency reference
  const efficiencyRefModel = models[0] || null;

  thead.innerHTML = `<tr>
    <th class="${sortClass('gpu')}" onclick="sortBy('gpu')">GPU</th>
    <th class="${sortClass('vram')}" onclick="sortBy('vram')">VRAM</th>
    <th class="${sortClass('price')}" onclick="sortBy('price')">Price</th>
    <th title="Tokens per second divided by GPU power draw (higher = more efficient). Based on ${efficiencyRefModel || 'first model'} speed vs TDP reference.">Efficiency<br><small style="font-weight:normal; color:#94a3b8;">tok/s/W</small></th>
    ${models.map(m => {
      const short = m.replace('deepseek-r1:', 'ds-r1:').replace('mistral-small:', 'mis:');
      return `<th class="${sortClass(m)}" onclick="sortBy('${m}')" title="${m}">${short}</th>`;
    }).join('')}
  </tr>`;

  // Build body
  tbody.innerHTML = gpus.map(gpu => {
    const price = getPrice(gpu.name);
    const vram = getVram(gpu.name);
    const link = getAmazonLink(gpu.name);
    const gpuCell = link
      ? `<a href="${link}" target="_blank" rel="noopener noreferrer">${gpu.name}</a>`
      : gpu.name;

    // Efficiency cell: use reference model speed / TDP
    let efficiencyCell = '<td class="na-cell">--</td>';
    if (efficiencyRefModel) {
      const refSpeed = getBenchmarkSpeed(gpu.benchmarks[efficiencyRefModel]);
      const eff = getEfficiencyScore(gpu.name, refSpeed);
      if (eff !== null) {
        efficiencyCell = `<td class="speed-cell" title="Based on ${efficiencyRefModel} speed (${refSpeed ? refSpeed.toFixed(1) : '--'} tok/s) / TDP reference (est.)" style="color:#a78bfa;">${eff} <small style="color:#94a3b8; font-size:0.7rem;">(est.)</small></td>`;
      }
    }

    const cells = models.map(m => {
      const bench = gpu.benchmarks[m];
      if (!bench) return '<td class="na-cell">--</td>';
      const v = getBenchmarkSpeed(bench);
      if (v == null) return '<td class="na-cell">--</td>';
      const inferenceType = bench.inference_type || 'gpu_full';
      const isOffload = inferenceType === 'cpu_offload';
      const isPartial = inferenceType === 'gpu_partial';
      const heat = getHeatClass(v, allSpeeds);
      const reliability = typeof bench.success_rate_pct === 'number'
        ? `${bench.success_rate_pct.toFixed(1)}% ok`
        : (bench.noisy ? 'noisy' : 'n/a');

      let offloadBadge = '';
      let cellClass = `speed-cell ${heat}`;
      let tooltipExtra = '';
      if (isOffload) {
        cellClass = 'speed-cell cell-offload';
        offloadBadge = ' <span class="badge-offload">CPU&#8593;</span>';
        tooltipExtra = ' | Partial GPU offload — RAM bandwidth and PCIe bandwidth are key bottlenecks. Not all layers fit in VRAM.';
        if (bench.offload_ratio != null) {
          tooltipExtra += ` (${Math.round(bench.offload_ratio * 100)}% on CPU)`;
        }
      } else if (isPartial) {
        cellClass = 'speed-cell cell-partial';
        offloadBadge = ' <span class="badge-partial">~CPU</span>';
        tooltipExtra = ' | Minor GPU offload — most layers on GPU.';
      }

      const title = `${bench.samples} samples, min: ${bench.min_tokens_per_sec}, max: ${bench.max_tokens_per_sec}, reliability: ${reliability}${tooltipExtra}`;
      return `<td class="${cellClass}" title="${title}">${v.toFixed(1)}${offloadBadge}</td>`;
    }).join('');

    return `<tr>
      <td class="gpu-cell">${gpuCell}</td>
      <td class="vram-cell">${vram ? vram + ' GB' : '--'}</td>
      <td class="speed-cell">${price ? '$' + price : '--'}</td>
      ${efficiencyCell}
      ${cells}
    </tr>`;
  }).join('');
}

function getHeatClass(value, allValues) {
  if (!allValues.length) return '';
  const sorted = [...allValues].sort((a, b) => a - b);
  const idx = sorted.findIndex(v => v >= value);
  const pct = idx / sorted.length;
  if (pct < 0.2) return 'heat-1';
  if (pct < 0.4) return 'heat-2';
  if (pct < 0.6) return 'heat-3';
  if (pct < 0.8) return 'heat-4';
  return 'heat-5';
}

function sortBy(column) {
  if (sortColumn === column) {
    sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
  } else {
    sortColumn = column;
    sortDirection = 'desc';
  }
  renderTable();
}

// ========== CHARTS ==========
let barChart = null;
let scatterChart = null;

function renderCharts() {
  const model = document.getElementById('chartModelSelect')?.value || currentModel;
  if (!model || !benchmarkData) return;

  renderBarChart(model);
  renderScatterChart(model);
}

function renderBarChart(model) {
  const ctx = document.getElementById('barChart')?.getContext('2d');
  if (!ctx) return;

  const items = benchmarkData.gpus
    .filter(g => g.benchmarks[model])
    .map(g => ({ name: g.name, speed: getBenchmarkSpeed(g.benchmarks[model]) }))
    .filter(g => g.speed !== null)
    .sort((a, b) => b.speed - a.speed);

  if (barChart) barChart.destroy();

  barChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: items.map(i => i.name),
      datasets: [{
        label: 'Tokens/s',
        data: items.map(i => i.speed),
        backgroundColor: items.map((_, idx) => {
          const pct = idx / items.length;
          if (pct < 0.33) return 'rgba(34, 197, 94, 0.7)';
          if (pct < 0.66) return 'rgba(234, 179, 8, 0.7)';
          return 'rgba(239, 68, 68, 0.7)';
        }),
        borderColor: 'transparent',
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: `Tokens/s by GPU - ${model}`,
          color: '#e8eaed',
          font: { size: 14, family: 'Inter' },
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: '#9aa0a6' },
        },
        y: {
          grid: { display: false },
          ticks: { color: '#e8eaed', font: { size: 11 } },
        },
      },
    },
  });
}

function renderScatterChart(model) {
  const ctx = document.getElementById('scatterChart')?.getContext('2d');
  if (!ctx) return;

  const items = benchmarkData.gpus
    .filter(g => g.benchmarks[model] && getPrice(g.name))
    .map(g => ({
      name: g.name,
      speed: getBenchmarkSpeed(g.benchmarks[model]),
      price: getPrice(g.name),
    }))
    .filter(g => g.speed !== null);

  if (scatterChart) scatterChart.destroy();

  scatterChart = new Chart(ctx, {
    type: 'scatter',
    data: {
      datasets: [{
        label: 'GPU',
        data: items.map(i => ({ x: i.price, y: i.speed, name: i.name })),
        backgroundColor: 'rgba(59, 130, 246, 0.7)',
        borderColor: 'rgba(59, 130, 246, 1)',
        pointRadius: 8,
        pointHoverRadius: 12,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: `Price vs Performance - ${model}`,
          color: '#e8eaed',
          font: { size: 14, family: 'Inter' },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const d = ctx.raw;
              return `${d.name}: ${d.y.toFixed(1)} tok/s @ $${d.x}`;
            },
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: `Price (${condition === 'new' ? 'New' : 'Used'})`, color: '#9aa0a6' },
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: '#9aa0a6', callback: v => '$' + v },
        },
        y: {
          title: { display: true, text: 'Tokens/s', color: '#9aa0a6' },
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: '#9aa0a6' },
        },
      },
    },
  });
}

// ========== TOKEN/S VISUALIZER ==========
const sampleText = "The fascinating world of artificial intelligence continues to evolve at a remarkable pace, with large language models becoming increasingly capable of understanding and generating human-like text across a wide range of topics and tasks. These models, trained on vast amounts of data, can now assist with everything from creative writing and code generation to complex reasoning and scientific analysis. As the technology matures, the question of how to deploy these models efficiently becomes more important than ever, with hardware choices playing a crucial role in determining both the speed and cost of inference.";

function populateVisualizerSelects() {
  const gpu1 = document.getElementById('vizGpu1');
  const gpu2 = document.getElementById('vizGpu2');
  if (!gpu1 || !benchmarkData) return;

  [gpu1, gpu2].forEach((sel, idx) => {
    sel.innerHTML = '';
    benchmarkData.gpus.forEach((g, i) => {
      const opt = document.createElement('option');
      opt.value = g.name;
      opt.textContent = g.name;
      sel.appendChild(opt);
    });
    // Default: first GPU for panel 1, second for panel 2
    if (benchmarkData.gpus.length > idx) {
      sel.value = benchmarkData.gpus[idx].name;
    }
  });
}

function startVisualizer() {
  stopVisualizer();
  vizRunning = true;

  const model = document.getElementById('vizModelSelect')?.value;
  if (!model) return;

  const gpu1Name = document.getElementById('vizGpu1')?.value;
  const gpu2Name = document.getElementById('vizGpu2')?.value;

  // Get speed for GPU 1
  const gpu1Data = benchmarkData.gpus.find(g => g.name === gpu1Name);
  const speed1 = getBenchmarkSpeed(gpu1Data?.benchmarks[model]) || 0;

  updateVizHeader('vizPanel1', gpu1Name, speed1);
  animateText('vizOutput1', speed1);

  if (vizCompareMode && gpu2Name) {
    const gpu2Data = benchmarkData.gpus.find(g => g.name === gpu2Name);
    const speed2 = getBenchmarkSpeed(gpu2Data?.benchmarks[model]) || 0;
    updateVizHeader('vizPanel2', gpu2Name, speed2);
    animateText('vizOutput2', speed2);
  }

  document.getElementById('vizStartBtn').textContent = 'Stop';
  document.getElementById('vizStartBtn').classList.add('active');
}

function stopVisualizer() {
  vizRunning = false;
  vizAnimationIds.forEach(id => cancelAnimationFrame(id));
  vizAnimationIds = [];
  document.getElementById('vizStartBtn').textContent = 'Start';
  document.getElementById('vizStartBtn').classList.remove('active');
}

function toggleVisualizer() {
  if (vizRunning) stopVisualizer();
  else startVisualizer();
}

function updateVizHeader(panelId, gpuName, speed) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  panel.querySelector('.gpu-label').textContent = gpuName;
  panel.querySelector('.speed-label').textContent = speed > 0 ? speed.toFixed(1) + ' tok/s' : 'N/A';
}

function animateText(outputId, tokensPerSec) {
  const output = document.getElementById(outputId);
  if (!output) return;

  output.innerHTML = '<span class="cursor"></span>';
  const words = sampleText.split(' ');
  let wordIdx = 0;
  let lastTime = null;

  // Roughly 1.3 tokens per word on average
  const wordsPerSec = tokensPerSec / 1.3;
  const msPerWord = wordsPerSec > 0 ? 1000 / wordsPerSec : 99999;

  function step(timestamp) {
    if (!vizRunning) return;
    if (!lastTime) lastTime = timestamp;

    if (timestamp - lastTime >= msPerWord && wordIdx < words.length) {
      // Remove cursor, add word, add cursor back
      const cursor = output.querySelector('.cursor');
      if (cursor) cursor.remove();

      const span = document.createElement('span');
      span.textContent = words[wordIdx] + ' ';
      output.appendChild(span);

      const newCursor = document.createElement('span');
      newCursor.className = 'cursor';
      output.appendChild(newCursor);

      output.scrollTop = output.scrollHeight;
      wordIdx++;
      lastTime = timestamp;
    }

    if (wordIdx < words.length) {
      const id = requestAnimationFrame(step);
      vizAnimationIds.push(id);
    }
  }

  const id = requestAnimationFrame(step);
  vizAnimationIds.push(id);
}

function toggleCompare() {
  vizCompareMode = !vizCompareMode;
  const display = document.getElementById('vizDisplay');
  const panel2 = document.getElementById('vizPanel2');
  const gpu2Group = document.getElementById('vizGpu2Group');
  const compareBtn = document.getElementById('compareBtn');

  if (vizCompareMode) {
    display.classList.add('compare');
    panel2.style.display = 'block';
    gpu2Group.style.display = 'block';
    compareBtn.classList.add('active');
  } else {
    display.classList.remove('compare');
    panel2.style.display = 'none';
    gpu2Group.style.display = 'none';
    compareBtn.classList.remove('active');
  }

  if (vizRunning) startVisualizer();
}

// ========== CONDITION TOGGLE ==========
function setCondition(c) {
  condition = c;
  document.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.condition === c);
  });
  renderRecommendations();
  renderTable();
  renderCharts();
}

// ========== SCROLL ANIMATIONS ==========
function setupScrollAnimations() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
      }
    });
  }, { threshold: 0.1 });

  document.querySelectorAll('.fade-in').forEach(el => observer.observe(el));
}

// ========== EVENT LISTENERS ==========
document.addEventListener('DOMContentLoaded', () => {
  init();

  // Recommender controls
  document.getElementById('modelSelect')?.addEventListener('change', () => {
    currentModel = document.getElementById('modelSelect').value;
    renderRecommendations();
  });

  document.getElementById('speedRange')?.addEventListener('input', (e) => {
    document.getElementById('speedVal').textContent = e.target.value + ' tok/s';
    renderRecommendations();
  });

  document.getElementById('budgetRange')?.addEventListener('input', (e) => {
    document.getElementById('budgetVal').textContent = '$' + e.target.value;
    renderRecommendations();
  });

  // Chart model select
  document.getElementById('chartModelSelect')?.addEventListener('change', () => {
    renderCharts();
  });

  // Region select
  document.getElementById('regionSelect')?.addEventListener('change', (e) => {
    setRegion(e.target.value);
  });
});
