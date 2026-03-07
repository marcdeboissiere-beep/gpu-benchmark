// ========== AFFILIATE LINK SYSTEM (Amazon + B&H Photo + Vast.ai) ==========

let affiliateConfig = null;
let currentRegion = 'US';

async function loadAffiliateConfig() {
  const resp = await fetch('data/gpu_asins.json');
  if (!resp.ok) throw new Error(`gpu_asins.json: HTTP ${resp.status}`);
  affiliateConfig = await resp.json();
  detectRegion();
}

function detectRegion() {
  const lang = navigator.language || navigator.languages?.[0] || 'en-US';
  const regionMap = {
    'en-US': 'US', 'en-GB': 'UK', 'de': 'DE', 'fr': 'FR',
    'it': 'IT', 'es': 'ES', 'en-CA': 'CA', 'fr-CA': 'CA', 'ja': 'JP',
  };

  // Check full locale first, then language prefix
  currentRegion = regionMap[lang] || regionMap[lang.split('-')[0]] || 'US';

  // Update the region selector if it exists
  const sel = document.getElementById('regionSelect');
  if (sel) sel.value = currentRegion;
}

function setRegion(region) {
  currentRegion = region;
  // Re-render any affiliate links on the page
  if (typeof renderRecommendations === 'function') renderRecommendations();
  if (typeof renderTable === 'function') renderTable();
}

// ---- Amazon ----

function getAmazonLink(gpuName) {
  if (!affiliateConfig) return null;

  const amazonDomains = {
    'US': 'amazon.com', 'UK': 'amazon.co.uk', 'DE': 'amazon.de',
    'FR': 'amazon.fr', 'IT': 'amazon.it', 'ES': 'amazon.es',
    'CA': 'amazon.ca', 'JP': 'amazon.co.jp'
  };

  const domain = amazonDomains[currentRegion] || 'amazon.com';
  const tags = affiliateConfig.affiliate_tags.amazon;
  const tag = (tags && tags[currentRegion]) || (tags && tags['US']) || '';
  const gpuData = affiliateConfig.gpus[gpuName];

  if (!gpuData) {
    const query = encodeURIComponent(`NVIDIA ${gpuName} GPU`);
    return `https://www.${domain}/s?k=${query}&tag=${tag}`;
  }

  // Check for a direct ASIN for this region
  if (gpuData.amazon_asin && gpuData.amazon_asin[currentRegion]) {
    return `https://www.${domain}/dp/${gpuData.amazon_asin[currentRegion]}?tag=${tag}`;
  }

  // Fallback to search term
  const searchTerm = (gpuData.search_terms && gpuData.search_terms.amazon)
    || `NVIDIA ${gpuName} GPU`;
  return `https://www.${domain}/s?k=${encodeURIComponent(searchTerm)}&tag=${tag}`;
}

// ---- B&H Photo ----

function getBHPhotoLink(gpuName) {
  if (!affiliateConfig) return null;

  const tags = affiliateConfig.affiliate_tags.bhphoto;
  const tag = (tags && tags['US']) || '';
  const gpuData = affiliateConfig.gpus[gpuName];

  if (!gpuData) {
    const query = encodeURIComponent(gpuName);
    return `https://www.bhphotovideo.com/c/search?Ntt=${query}&BI=${tag}`;
  }

  const searchTerm = (gpuData.search_terms && gpuData.search_terms.bhphoto)
    || gpuName;
  return `https://www.bhphotovideo.com/c/search?Ntt=${encodeURIComponent(searchTerm)}&BI=${tag}`;
}

// ---- Vast.ai Referral ----

function getVastaiReferralLink() {
  if (!affiliateConfig) return 'https://vast.ai';

  const code = affiliateConfig.affiliate_tags.vastai_referral || '';
  if (!code || code.startsWith('REPLACE_')) {
    return 'https://vast.ai';
  }
  return `https://vast.ai/?ref=${encodeURIComponent(code)}`;
}

// ---- Primary entry point ----

function getAffiliateLink(gpuName, region) {
  if (region) currentRegion = region;
  if (!affiliateConfig) return null;

  const gpuData = affiliateConfig.gpus[gpuName];
  const priorityStore = gpuData && gpuData.priority_store;

  // Use B&H when it is the priority store AND a B&H tag is configured
  if (priorityStore === 'bhphoto') {
    const bhTags = affiliateConfig.affiliate_tags.bhphoto;
    const bhTag = bhTags && bhTags['US'];
    if (bhTag && !bhTag.startsWith('REPLACE_')) {
      return getBHPhotoLink(gpuName);
    }
  }

  // Default: Amazon
  return getAmazonLink(gpuName);
}

// getVastaiReferralLink is a global function — accessible from app.js without export
