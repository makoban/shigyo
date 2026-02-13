// ========================================
// AI士業エリア分析 v1.0 — 士業特化版
// Cloudflare Workers Proxy経由でGemini API + e-Stat API
// URL入力 + エリア名入力（都道府県・市区町村）対応
// ========================================

var WORKER_BASE = 'https://house-search-proxy.ai-fudosan.workers.dev';
var CORS_PROXIES = [
  { name: 'corsproxy.io', build: function(u) { return 'https://corsproxy.io/?' + encodeURIComponent(u); } },
  { name: 'allorigins', build: function(u) { return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u); } },
  { name: 'codetabs', build: function(u) { return 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u); } }
];
var _crawledAddresses = [];
var _crawlDebugInfo = { pages: [], scoredLinks: [], addresses: [] };
var _activeProxy = '';

// ---- 士業専用設定 ----
var SHIGYO_CONFIG = {
  name: '士業（税理士・弁護士・社労士・行政書士等）',
  icon: '⚖️',
  color: '#8b5cf6',
  estatDataSets: [
    { id: '0004040078', name: '事業所数・従業者数（産業中分類・2024基礎調査）', key: 'establishments' },
    { id: '0004005659', name: '存続・新設・廃業（産業大分類・2021活動調査）', key: 'turnover' },
    { id: '0004005661', name: '従業者規模別事業所数（産業中分類・2021活動調査）', key: 'scale' }
  ],
  kpis: ['事業所数', '従業者数', '開業率', '廃業率', '士業事務所密度', '潜在顧客数/士業'],
  marketJsonTemplate: {
    business_establishments: { total_establishments: 0, total_employees: 0, corporations: 0, sole_proprietors: 0, small_scale_1_4: 0, medium_scale_5_29: 0, large_scale_30_plus: 0, source: '推計' },
    turnover: { new_establishments_1yr: 0, closed_establishments_1yr: 0, opening_rate_pct: 0, closure_rate_pct: 0, net_increase: 0, new_corporations_1yr: 0, bankruptcy_count: 0 },
    shigyo_competition: { tax_accountant_offices: 0, lawyer_offices: 0, judicial_scrivener_offices: 0, labor_consultant_offices: 0, administrative_scrivener_offices: 0, other_professional_offices: 0, total_shigyo_offices: 0, shigyo_per_1000_establishments: 0 },
    potential: { target_establishments: 0, target_sole_proprietors: 0, potential_clients_per_shigyo: 0, market_size_estimate: 0, growth_index: 0, ai_insight: '' }
  }
};

// ---- Prefecture Codes ----
var PREFECTURE_CODES = {
  '北海道':'01','青森県':'02','岩手県':'03','宮城県':'04','秋田県':'05',
  '山形県':'06','福島県':'07','茨城県':'08','栃木県':'09','群馬県':'10',
  '埼玉県':'11','千葉県':'12','東京都':'13','神奈川県':'14','新潟県':'15',
  '富山県':'16','石川県':'17','福井県':'18','山梨県':'19','長野県':'20',
  '岐阜県':'21','静岡県':'22','愛知県':'23','三重県':'24','滋賀県':'25',
  '京都府':'26','大阪府':'27','兵庫県':'28','奈良県':'29','和歌山県':'30',
  '鳥取県':'31','島根県':'32','岡山県':'33','広島県':'34','山口県':'35',
  '徳島県':'36','香川県':'37','愛媛県':'38','高知県':'39','福岡県':'40',
  '佐賀県':'41','長崎県':'42','熊本県':'43','大分県':'44','宮崎県':'45',
  '鹿児島県':'46','沖縄県':'47'
};

// ---- State ----
var analysisData = null;

// ---- DOM References ----
var urlInput = document.getElementById('url-input');
var analyzeBtn = document.getElementById('analyze-btn');
var errorMsg = document.getElementById('error-msg');
var progressSection = document.getElementById('progress-section');
var resultsSection = document.getElementById('results-section');
var resultsContent = document.getElementById('results-content');
var progressLogContent = document.getElementById('progress-log-content');
var settingsModal = document.getElementById('settings-modal');

// ---- Gemini API ----
var _lastGeminiCall = 0;
var _geminiMinInterval = 6000;

async function callGemini(prompt) {
  var now = Date.now();
  var elapsed = now - _lastGeminiCall;
  if (_lastGeminiCall > 0 && elapsed < _geminiMinInterval) {
    var waitMs = _geminiMinInterval - elapsed;
    addLog('  ⏳ API間隔調整 ' + Math.ceil(waitMs/1000) + '秒...', 'info');
    await new Promise(function(r) { setTimeout(r, waitMs); });
  }
  _lastGeminiCall = Date.now();

  var maxRetries = 5;
  for (var attempt = 0; attempt <= maxRetries; attempt++) {
    var res = await fetch(WORKER_BASE + '/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt })
    });

    if (res.status === 429 && attempt < maxRetries) {
      var waitSec = 10 * (attempt + 1);
      addLog('  API制限検知、' + waitSec + '秒後にリトライ... (' + (attempt + 1) + '/' + maxRetries + ')', 'info');
      await new Promise(function(r) { setTimeout(r, waitSec * 1000); });
      _lastGeminiCall = Date.now();
      continue;
    }

    var data = await res.json();
    if (!res.ok) {
      var errMessage = (data.error && typeof data.error === 'string') ? data.error : (data.error && data.error.message) || ('API Error: ' + res.status);
      throw new Error(errMessage);
    }
    return data.text || '';
  }
}

// ---- e-Stat API ----
async function fetchEstatPopulation(prefecture, city) {
  var prefCode = PREFECTURE_CODES[prefecture];
  if (!prefCode) return null;
  addLog('e-Stat APIから人口データを取得中...', 'info');
  try {
    var url = WORKER_BASE + '/api/estat/population?statsDataId=0003448233&cdArea=' + prefCode + '000&limit=100';
    var res = await fetch(url);
    if (!res.ok) throw new Error('e-Stat API HTTP ' + res.status);
    var data = await res.json();
    var result = data.GET_STATS_DATA && data.GET_STATS_DATA.STATISTICAL_DATA;
    if (!result || !result.DATA_INF || !result.DATA_INF.VALUE) {
      url = WORKER_BASE + '/api/estat/population?statsDataId=0003448233&cdArea=' + prefCode + '&limit=100';
      res = await fetch(url);
      data = await res.json();
      result = data.GET_STATS_DATA && data.GET_STATS_DATA.STATISTICAL_DATA;
    }
    if (!result || !result.DATA_INF || !result.DATA_INF.VALUE) {
      addLog('e-Stat: 該当データがありません。AI推計に切り替えます。', 'info');
      return null;
    }
    var values = result.DATA_INF.VALUE;
    var population = null, households = null;
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      var val = parseInt(v.$, 10);
      if (isNaN(val)) continue;
      if (v['@tab'] === '020' || (v['@cat01'] && v['@cat01'].indexOf('0010') >= 0)) {
        if (!population || val > 100) population = val;
      }
      if (v['@tab'] === '040' || (v['@cat01'] && v['@cat01'].indexOf('0020') >= 0)) {
        if (!households || val > 100) households = val;
      }
    }
    if (population) {
      addLog('e-Stat: 人口データ取得成功 (' + formatNumber(population) + '人)', 'success');
      return { total_population: population, households: households || Math.round(population / 2.3), source: 'e-Stat 国勢調査', from_estat: true };
    }
    return null;
  } catch (e) {
    console.warn('[e-Stat] Error:', e);
    addLog('e-Stat API接続エラー: ' + e.message + '。AI推計に切り替えます。', 'info');
    return null;
  }
}

async function fetchEstatGeneric(statsDataId, cdArea, limit) {
  if (!statsDataId) return null;
  try {
    var url = WORKER_BASE + '/api/estat/query?statsDataId=' + statsDataId + '&cdArea=' + (cdArea || '') + '&limit=' + (limit || '100');
    var res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    var data = await res.json();
    var result = data.GET_STATS_DATA && data.GET_STATS_DATA.STATISTICAL_DATA;
    if (!result || !result.DATA_INF || !result.DATA_INF.VALUE) return null;
    return result.DATA_INF.VALUE;
  } catch (e) {
    console.warn('[e-Stat Generic] Error:', e);
    return null;
  }
}

// 士業用e-Statデータを一括取得
async function fetchEstatForShigyo(prefCode, cityCode) {
  var results = {};

  // 人口・世帯
  var pref = null;
  for (var p in PREFECTURE_CODES) {
    if (PREFECTURE_CODES[p] === prefCode) { pref = p; break; }
  }
  if (pref) {
    results.population = await fetchEstatPopulation(pref, cityCode || '');
  }

  // 士業専用データ
  var estatDataSets = SHIGYO_CONFIG.estatDataSets;
  for (var i = 0; i < estatDataSets.length; i++) {
    var ds = estatDataSets[i];
    addLog('  e-Stat: ' + ds.name + ' を取得中...', 'info');
    var rawValues = await fetchEstatGeneric(ds.id, prefCode + '000');
    if (rawValues) {
      results[ds.key] = rawValues;
      addLog('  e-Stat: ' + ds.name + ' 取得成功 (' + rawValues.length + '件)', 'success');
    } else {
      addLog('  e-Stat: ' + ds.name + ' データなし', 'info');
    }
  }

  return results;
}

// ---- Fetch Page via CORS Proxy ----
var IMPORTANT_PATH_KEYWORDS = [
  'company', 'about', 'corporate', 'profile', 'access', 'overview',
  'summary', 'gaiyou', 'kaisya', 'info', 'office',
  '会社概要', '会社案内', '企業情報', '事業所', 'greeting',
  'service', 'staff', 'member', 'lawyer', 'attorney',
  'tax', 'labor', 'zeirishi', 'bengoshi', 'shihou',
  '業務案内', '事務所概要', '弁護士紹介', '税理士', '代表挨拶',
  '取扱業務', '料金', '費用', 'fee', 'price'
];

var _stickyProxyIdx = -1;

async function fetchSinglePage(url) {
  var order = [];
  if (_stickyProxyIdx >= 0) {
    order.push(_stickyProxyIdx);
    for (var i = 0; i < CORS_PROXIES.length; i++) { if (i !== _stickyProxyIdx) order.push(i); }
  } else {
    for (var i = 0; i < CORS_PROXIES.length; i++) order.push(i);
  }
  for (var oi = 0; oi < order.length; oi++) {
    var p = order[oi];
    var proxy = CORS_PROXIES[p];
    try {
      var proxyUrl = proxy.build(url);
      var timeout = (oi === 0 && _stickyProxyIdx >= 0) ? 15000 : 10000;
      var res = await fetch(proxyUrl, { signal: AbortSignal.timeout(timeout) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var html = await res.text();
      if (html && html.length > 100) {
        _stickyProxyIdx = p;
        _activeProxy = proxy.name;
        return html;
      }
    } catch (e) {
      console.warn('[Fetch/' + proxy.name + '] Failed: ' + url + ' - ' + e.message);
      if (oi === 0 && _stickyProxyIdx >= 0) { _stickyProxyIdx = -1; }
    }
  }
  return null;
}

function extractTextFromHtml(html) {
  var parser = new DOMParser();
  var doc = parser.parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, noscript, iframe, svg').forEach(function(el) { el.remove(); });
  var text = (doc.body && doc.body.textContent) || '';
  return text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
}

function extractLinks(html, baseUrl) {
  var links = [];
  var seen = {};
  var base;
  try { base = new URL(baseUrl); } catch(e) { return []; }
  var linkRegex = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  var m;
  while ((m = linkRegex.exec(html)) !== null) {
    try {
      var href = m[1];
      if (!href || href.charAt(0) === '#' || href.indexOf('mailto:') === 0 || href.indexOf('tel:') === 0) continue;
      var resolved = new URL(href, baseUrl);
      if (resolved.hostname !== base.hostname) continue;
      var path = resolved.pathname.toLowerCase();
      if (/\.(jpg|jpeg|png|gif|svg|pdf|zip|doc|mp4|mp3)$/i.test(path)) continue;
      var key = resolved.origin + resolved.pathname;
      if (seen[key]) continue;
      seen[key] = true;
      var linkText = m[2].replace(/<[^>]+>/g, '').trim();
      links.push({ url: key, path: path, text: linkText.slice(0, 50) });
    } catch(e) {}
  }
  return links;
}

function scoreLink(link) {
  var score = 0;
  var path = link.path;
  var text = link.text;
  for (var i = 0; i < IMPORTANT_PATH_KEYWORDS.length; i++) {
    if (path.indexOf(IMPORTANT_PATH_KEYWORDS[i]) >= 0) score += 10;
    if (text.indexOf(IMPORTANT_PATH_KEYWORDS[i]) >= 0) score += 5;
  }
  if (text.indexOf('事務所概要') >= 0 || text.indexOf('会社概要') >= 0) score += 20;
  if (text.indexOf('弁護士') >= 0 || text.indexOf('税理士') >= 0) score += 20;
  if (text.indexOf('社労士') >= 0 || text.indexOf('行政書士') >= 0) score += 18;
  if (text.indexOf('業務案内') >= 0 || text.indexOf('取扱業務') >= 0) score += 15;
  if (text.indexOf('料金') >= 0 || text.indexOf('費用') >= 0) score += 12;
  if (text.indexOf('アクセス') >= 0 || text.indexOf('所在地') >= 0) score += 15;
  if (text.indexOf('代表') >= 0 || text.indexOf('スタッフ') >= 0) score += 10;
  var depth = (path.match(/\//g) || []).length;
  if (depth > 4) score -= 3;
  return score;
}

async function crawlSite(url) {
  addLog('トップページを取得中...', 'info');
  var topHtml = await fetchSinglePage(url);
  if (!topHtml) {
    _crawlDebugInfo = { pages: [{ url: url, status: 'FAILED', size: 0, text: 'トップページ' }], scoredLinks: [], addresses: [] };
    addLog('トップページの取得に失敗しました', 'info');
    return null;
  }
  var topText = extractTextFromHtml(topHtml);
  addLog('トップページ取得完了 (' + topText.length + '文字)', 'success');
  _crawlDebugInfo = { pages: [{ url: url, status: 'OK (' + _activeProxy + ')', size: topHtml.length, text: 'トップページ' }], scoredLinks: [], addresses: [] };
  var allHtmlSources = [topHtml];
  var links = extractLinks(topHtml, url);
  addLog('内部リンク ' + links.length + '件を検出', 'info');
  var allLinks = links.map(function(link) {
    return { url: link.url, path: link.path, text: link.text, score: scoreLink(link) };
  }).filter(function(link) {
    return link.url !== url && link.url !== url + '/';
  }).sort(function(a, b) { return b.score - a.score; });
  var maxSubPages = Math.min(allLinks.length, 100);
  var allTexts = ['【トップページ】\n' + topText.slice(0, 3000)];
  var _crawledPages = [{ name: 'トップページ', url: url, chars: topText.length, status: 'OK' }];
  addLog('巡回対象: ' + maxSubPages + 'ページ', 'info');
  for (var i = 0; i < maxSubPages; i++) {
    var subLink = allLinks[i];
    addLog('[' + (i+1) + '/' + maxSubPages + '] ' + (subLink.text || subLink.path));
    var subHtml = await fetchSinglePage(subLink.url);
    if (subHtml) {
      allHtmlSources.push(subHtml);
      var subText = extractTextFromHtml(subHtml);
      if (subText.length > 50) {
        var pageName = subLink.text || subLink.path;
        var summary = extractPageSummary(subHtml);
        allTexts.push('【' + pageName + '】\n' + subText.slice(0, 2000));
        _crawledPages.push({ name: pageName, url: subLink.url, chars: subText.length, status: 'OK', summary: summary });
      }
      _crawlDebugInfo.pages.push({ url: subLink.url, status: 'OK', size: subHtml.length, text: subLink.text });
    } else {
      _crawledPages.push({ name: subLink.text || subLink.path, url: subLink.url, chars: 0, status: 'FAILED' });
    }
  }
  _crawlDebugInfo.crawledPages = _crawledPages;
  addLog('合計 ' + _crawledPages.filter(function(p) { return p.status === 'OK'; }).length + '/' + (maxSubPages + 1) + ' ページ取得完了', 'success');

  var allAddrs = [];
  var seenZips = {};
  var topAddrs = extractAddressesFromHtml(topHtml, 'トップページ');
  topAddrs.forEach(function(a) { if (!seenZips[a.zip]) { seenZips[a.zip] = true; allAddrs.push(a); } });
  allHtmlSources.forEach(function(srcHtml, idx) {
    if (idx === 0) return;
    var pName = (_crawledPages[idx] && _crawledPages[idx].name) || 'ページ' + idx;
    var pageAddrs = extractAddressesFromHtml(srcHtml, pName);
    pageAddrs.forEach(function(a) { if (!seenZips[a.zip]) { seenZips[a.zip] = true; allAddrs.push(a); } });
  });
  _crawledAddresses = allAddrs;
  addLog('HTMLソースから住所 ' + _crawledAddresses.length + '件を直接検出', _crawledAddresses.length > 0 ? 'success' : 'info');

  var combined = allTexts.join('\n\n---\n\n');
  if (combined.length > 15000) combined = combined.slice(0, 15000);
  return combined;
}

function extractAddressesFromHtml(html, pageName) {
  if (!html) return [];
  var results = [];
  var seen = {};
  var plainText = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  var regex = /〒(\d{3}-?\d{4})\s*([^〒]{5,120})/g;
  var m;
  while ((m = regex.exec(plainText)) !== null) {
    var zip = m[1].trim();
    if (seen[zip]) continue;
    seen[zip] = true;
    var rawAddr = m[2].trim();
    var addrMatch = rawAddr.match(/^(.+?)(?:\s*(?:TEL|FAX|tel|fax|電話))/i);
    var address = addrMatch ? addrMatch[1].trim() : rawAddr;
    var telMatch = rawAddr.match(/(?:TEL|tel|電話)[\s:]*(\d[\d\-]+\d)/i);
    var tel = telMatch ? telMatch[1] : '';
    address = address.replace(/\s+/g, ' ').replace(/[\n\r]/g, '').trim();
    if (address.length < 5 || address.length > 100) continue;
    if (!address.match(/[都道府県市区町村郡]/)) continue;
    var matchPos = m.index;
    var ctxStart = Math.max(0, matchPos - 40);
    var ctxEnd = Math.min(plainText.length, matchPos + m[0].length + 40);
    var context = plainText.slice(ctxStart, ctxEnd).replace(/\s+/g, ' ').trim();
    results.push({ zip: '〒' + zip, address: address, tel: tel, page: pageName || '', context: context });
  }
  return results;
}

// ---- Progress Log ----
function addLog(message, type) {
  if (!type) type = 'normal';
  if (!progressLogContent) return;
  var div = document.createElement('div');
  div.className = 'log-item ' + type;
  div.textContent = '[' + new Date().toLocaleTimeString() + '] ' + message;
  progressLogContent.appendChild(div);
  progressLogContent.scrollTop = progressLogContent.scrollHeight;
}

function clearLogs() { if (progressLogContent) progressLogContent.innerHTML = ''; }

// ---- Main Analysis Flow ----
async function startAnalysis() {
  var input = urlInput.value.trim();
  if (!input) { showError('URLまたはエリア名を入力してください'); return; }
  if (isValidUrl(input)) return startUrlAnalysis(input);
  hideError();
  if (typeof searchArea === 'undefined') {
    showError('エリアデータベースが読み込まれていません。URLを入力してください。');
    return;
  }
  var candidates = searchArea(input);
  if (candidates.length === 0) {
    showError('「' + input + '」に一致するエリアが見つかりません。都道府県名や市区町村名を入力してください。');
    return;
  }
  if (candidates.length === 1) { startAreaOnlyAnalysis(candidates[0]); return; }
  showAreaSelectModal(candidates, input);
}

function showAreaSelectModal(candidates, inputText) {
  var listEl = document.getElementById('area-select-list');
  listEl.innerHTML = '';
  candidates.slice(0, 20).forEach(function(area) {
    var btn = document.createElement('button');
    btn.style.cssText = 'display:flex; align-items:center; gap:10px; padding:14px 18px; border:1px solid rgba(139,92,246,0.3); border-radius:12px; background:rgba(30,41,59,0.6); color:#fff; cursor:pointer; font-size:14px; transition:all 0.2s; text-align:left;';
    btn.innerHTML = '<span style="font-size:20px;">📍</span><div><div style="font-weight:700;">' + escapeHtml(area.fullLabel) + '</div><div style="font-size:11px; color:var(--text-muted);">' + (area.type === 'prefecture' ? '都道府県' : '市区町村') + '</div></div>';
    btn.addEventListener('mouseover', function() { btn.style.borderColor = 'rgba(139,92,246,0.6)'; btn.style.background = 'rgba(139,92,246,0.1)'; });
    btn.addEventListener('mouseout', function() { btn.style.borderColor = 'rgba(139,92,246,0.3)'; btn.style.background = 'rgba(30,41,59,0.6)'; });
    btn.addEventListener('click', function() {
      document.getElementById('area-select-modal').classList.remove('active');
      startAreaOnlyAnalysis(area);
    });
    listEl.appendChild(btn);
  });
  document.getElementById('area-select-modal').classList.add('active');
}

// ---- エリア名のみ分析 ----
async function startAreaOnlyAnalysis(area) {
  hideError(); hideResults(); showProgress(); setLoading(true); clearLogs();
  addLog('⚖️ 士業エリア分析を開始します...', 'info');
  addLog('対象エリア: ' + area.fullLabel, 'info');
  addLog('モード: エリア直接指定（URL巡回スキップ）', 'info');
  try {
    completeStep('step-crawl');
    completeStep('step-analyze');
    activateStep('step-market');

    var prefCode = PREFECTURE_CODES[area.prefecture];
    var estatDataForArea = {};
    if (prefCode) { estatDataForArea = await fetchEstatForShigyo(prefCode, area.city); }

    var areaForPrompt = { label: area.fullLabel, prefecture: area.prefecture, city: area.city, isHQ: true };
    var dummyAnalysis = {
      company: { name: area.fullLabel + ' 士業市場分析', business_type: '士業（全般）', specialty: '全般', staff_count: '不明' }
    };

    addLog('士業市場データを取得中: ' + area.fullLabel);
    var marketPrompt = buildShigyoMarketPrompt(dummyAnalysis, estatDataForArea, areaForPrompt);
    var marketRaw = await callGemini(marketPrompt);
    var marketData = normalizeMarketData(parseJSON(marketRaw));

    var areaEstatPop = estatDataForArea.population;
    if (areaEstatPop && areaEstatPop.from_estat) {
      if (!marketData.population) marketData.population = {};
      marketData.population.total_population = areaEstatPop.total_population;
      marketData.population.households = areaEstatPop.households;
      marketData.population.source = areaEstatPop.source;
    }

    addLog('士業市場データ取得完了', 'success');
    completeStep('step-market');
    activateStep('step-report');
    addLog('士業分析レポート生成中...');
    await sleep(300);

    analysisData = {
      url: '', isAreaOnly: true,
      company: { name: area.fullLabel + ' 士業市場分析', business_type: '士業（エリア分析）', main_services: '—', specialty: '—', staff_count: '—', address: area.fullLabel, strengths: '', weaknesses: '', keywords: [] },
      industry: { id: 'shigyo', name: '士業（税理士・弁護士・社労士・行政書士等）', confidence: 1.0 },
      industryId: 'shigyo',
      industryConfig: SHIGYO_CONFIG,
      location: { prefecture: area.prefecture, city: area.city },
      markets: [{ area: areaForPrompt, data: marketData }],
      market: marketData,
      crossAreaInsight: null,
      timestamp: new Date().toISOString(),
      data_source: 'e-Stat + Gemini',
      extracted_addresses: []
    };

    renderResults(analysisData);
    addLog('士業分析レポート作成完了！', 'success');
    completeStep('step-report');
    await sleep(300);
    hideProgress(); showResults();
  } catch (err) {
    console.error('Area analysis error:', err);
    addLog('エラー: ' + err.message, 'error');
    showError(err.message);
  } finally { setLoading(false); }
}

// ---- URL分析フロー ----
async function startUrlAnalysis(url) {
  hideError(); hideResults(); showProgress(); setLoading(true); clearLogs();
  addLog('⚖️ 士業エリア分析を開始します...', 'info');
  addLog('APIプロキシ経由でGemini + e-Statを使用', 'info');
  try {
    activateStep('step-crawl');
    addLog('Webサイトを巡回中: ' + url);
    var pageContent = await crawlSite(url);
    if (pageContent) {
      addLog('サイト内容の取得完了 (合計 ' + pageContent.length + '文字)', 'success');
    } else {
      addLog('CORSプロキシ経由の取得に失敗。URLのみでAI分析を実行します。', 'info');
      pageContent = '';
    }
    completeStep('step-crawl');

    activateStep('step-analyze');
    addLog('Gemini 2.0 Flash で事務所情報を分析中...');
    var analysisPrompt = buildAnalysisPrompt(url, pageContent);
    var analysisRaw = await callGemini(analysisPrompt);
    var analysis = parseJSON(analysisRaw);
    addLog('分析完了: ' + ((analysis.company && analysis.company.name) || '事務所情報取得'), 'success');
    addLog('業種: ⚖️ 士業（税理士・弁護士・社労士・行政書士等）（固定）', 'success');
    completeStep('step-analyze');

    // 住所フィルタリング
    var rawAddresses = _crawledAddresses || [];
    var extractedAddresses = rawAddresses;
    if (rawAddresses.length > 1) {
      addLog('抽出住所 ' + rawAddresses.length + '件をAIで事務所判定中...');
      try {
        var companyName = (analysis.company && analysis.company.name) || '';
        var addrList = rawAddresses.map(function(a, i) {
          return (i+1) + '. ' + a.zip + ' ' + a.address + (a.tel ? ' TEL:' + a.tel : '') + '\n   出現ページ: ' + (a.page || '不明') + '\n   前後テキスト: 「' + (a.context || '').slice(0, 80) + '」';
        }).join('\n\n');
        var filterPrompt = '■ 事務所名: ' + companyName + '\n■ 業種: 士業\n\n以下はこの士業事務所のWebサイトから抽出された住所一覧です。\n' + addrList + '\n\n【判定基準】\n✅ 採用: 本所・支所・系列事務所の住所、代表事務所住所\n❌ 除外: 裁判所の住所、顧客の住所、広告の住所\n\n{"offices":[{"no":1,"is_office":true,"reason":"本所住所"},...]}\nで回答してください。';
        var filterRaw = await callGemini(filterPrompt);
        var filterResult = parseJSON(filterRaw);
        if (filterResult && filterResult.offices) {
          extractedAddresses = [];
          filterResult.offices.forEach(function(item) {
            var idx = item.no - 1;
            if (item.is_office && rawAddresses[idx]) {
              extractedAddresses.push(rawAddresses[idx]);
              addLog('  ✅ ' + rawAddresses[idx].address + ' → ' + (item.reason || '事務所'), 'success');
            }
          });
        }
      } catch (e) { addLog('AI事務所判定スキップ: ' + e.message, 'info'); }
    }

    // 市場データ取得
    activateStep('step-market');
    var uniqueAreas = [];
    var seenAreaKeys = {};
    var hqLocation = analysis.location || {};
    if (hqLocation.prefecture) {
      var hqKey = hqLocation.prefecture + ' ' + (hqLocation.city || '');
      seenAreaKeys[hqKey] = true;
      uniqueAreas.push({ prefecture: hqLocation.prefecture, city: hqLocation.city || '', label: hqKey, isHQ: true });
    }
    extractedAddresses.forEach(function(addr) {
      var area = extractAreaFromAddress(addr.address);
      if (area && !seenAreaKeys[area.label]) {
        seenAreaKeys[area.label] = true;
        uniqueAreas.push(area);
      }
    });
    addLog('分析対象エリア: ' + uniqueAreas.length + '件', 'info');

    var markets = [];
    for (var aIdx = 0; aIdx < uniqueAreas.length; aIdx++) {
      var area = uniqueAreas[aIdx];
      addLog('[' + (aIdx+1) + '/' + uniqueAreas.length + '] 士業市場データ取得: ' + area.label);
      var prefCode = PREFECTURE_CODES[area.prefecture];
      var estatDataForArea = {};
      if (prefCode) { estatDataForArea = await fetchEstatForShigyo(prefCode, area.city); }
      var marketPrompt = buildShigyoMarketPrompt(analysis, estatDataForArea, area);
      var marketRaw = await callGemini(marketPrompt);
      var marketData = normalizeMarketData(parseJSON(marketRaw));
      var areaEstatPop = estatDataForArea.population;
      if (areaEstatPop && areaEstatPop.from_estat) {
        if (!marketData.population) marketData.population = {};
        marketData.population.total_population = areaEstatPop.total_population;
        marketData.population.households = areaEstatPop.households;
        marketData.population.source = areaEstatPop.source;
      }
      markets.push({ area: area, data: marketData });
      addLog('  → ' + area.label + ' 完了', 'success');
    }

    // 横断分析
    var crossAreaInsight = null;
    if (markets.length >= 2) {
      addLog('全エリア横断分析（士業向け）を実行中...');
      try {
        var summaryForAI = markets.map(function(mkt) {
          var d = mkt.data || {};
          var pop = d.population || {};
          var summary = { area: mkt.area.label, isHQ: mkt.area.isHQ || false, population: pop.total_population || 0 };
          for (var key in d) {
            if (key === 'area_name' || key === 'population') continue;
            if (typeof d[key] === 'object') { for (var subKey in d[key]) { summary[key + '_' + subKey] = d[key][subKey]; } }
          }
          return summary;
        });
        var crossPrompt = buildShigyoCrossAreaPrompt(analysis, summaryForAI);
        var crossRaw = await callGemini(crossPrompt);
        crossAreaInsight = parseJSON(crossRaw);
        addLog('横断分析完了', 'success');
      } catch (e) { addLog('横断分析スキップ: ' + e.message, 'info'); }
    }

    completeStep('step-market');
    activateStep('step-report');
    addLog('士業分析レポート生成中...');
    await sleep(300);

    analysisData = {
      url: url,
      company: analysis.company || {},
      industry: { id: 'shigyo', name: '士業（税理士・弁護士・社労士・行政書士等）', confidence: 1.0 },
      industryId: 'shigyo',
      industryConfig: SHIGYO_CONFIG,
      location: analysis.location || {},
      markets: markets,
      market: markets.length > 0 ? markets[0].data : {},
      crossAreaInsight: crossAreaInsight,
      timestamp: new Date().toISOString(),
      data_source: 'e-Stat + Gemini',
      extracted_addresses: extractedAddresses
    };

    renderResults(analysisData);
    addLog('士業分析レポート作成完了！', 'success');
    completeStep('step-report');
    await sleep(300);
    hideProgress(); showResults();
  } catch (err) {
    console.error('Analysis error:', err);
    addLog('エラー: ' + err.message, 'error');
    showError(err.message);
  } finally { setLoading(false); }
}

// ---- Prompt Builders (士業特化) ----
function buildAnalysisPrompt(url, content) {
  var contentSection = content
    ? '\n以下はWebサイトから取得したテキストの一部です:\n---\n' + content + '\n---'
    : '\nWebサイトの内容は取得できませんでしたが、URLから推測してください。';
  return 'あなたは士業（法律・税務・労務・行政手続き）の事務所分析と市場調査の専門家です。\n以下のURLの士業事務所について分析してください。\n\nURL: ' + url + '\n' + contentSection + '\n\n' +
    '重要: 住所は必ずWebサイトの情報から特定してください。\n複数の事務所がある場合、本所の住所を"address"に記載してください。\n\n' +
    '以下のJSON形式で回答してください。マークダウンのコードブロックで囲まず、純粋JSONのみ返してください:\n' +
    '{\n' +
    '  "company": {\n' +
    '    "name": "事務所名・法人名",\n' +
    '    "address": "事務所の住所（〒XXX-XXXX 都道府県市区町村以降）",\n' +
    '    "branches": [{"name": "支所名", "address": "住所"}],\n' +
    '    "business_type": "士業分類（例: 税理士事務所、弁護士法人、社会保険労務士法人、行政書士事務所、司法書士事務所、公認会計士事務所等）",\n' +
    '    "main_services": "主力業務・得意分野（例: 法人税務顧問、相続対策、会社設立、労務管理、許認可申請等）",\n' +
    '    "specialty": "専門分野・特化領域（例: 医療法人、IT企業、飲食業、不動産、建設業等）",\n' +
    '    "staff_count": "所員数・有資格者数（わかれば）",\n' +
    '    "fee_range": "料金帯（例: 月額顧問料3万〜10万円）",\n' +
    '    "strengths": "強み・特徴（100文字以内）",\n' +
    '    "weaknesses": "改善余地・課題（100文字以内）",\n' +
    '    "keywords": ["キーワード1", "キーワード2", "キーワード3"]\n' +
    '  },\n' +
    '  "location": { "prefecture": "都道府県", "city": "市区町村" }\n' +
    '}';
}

function buildShigyoMarketPrompt(analysis, estatData, area) {
  var company = analysis.company || {};
  var pref = area.prefecture || '不明';
  var city = area.city || '';

  var estatInfo = '';
  if (estatData && estatData.population && estatData.population.from_estat) {
    var pop = estatData.population;
    estatInfo = '\n\n【参考: e-Stat政府統計データ】\n・総人口: ' + formatNumber(pop.total_population) + '人\n・世帯数: ' + formatNumber(pop.households) + '世帯\n';
    for (var key in estatData) {
      if (key === 'population') continue;
      var d = estatData[key];
      if (d && typeof d === 'object') { estatInfo += '・' + key + ': データあり\n'; }
    }
    estatInfo += 'これらの実データを基準にして、他の項目も整合性のある値を推定してください。\n';
  }

  return 'あなたは日本の士業（税理士・弁護士・社労士・行政書士・司法書士等）市場分析の専門家です。\n以下の地域の士業市場データを推定・提供してください。\n\n' +
    '■ 分析の目的: 士業事務所がこのエリアで潜在顧客（事業者・法人・個人事業主）を見つけるための市場分析\n\n' +
    '対象エリア: ' + pref + ' ' + city + '\n' +
    '事務所タイプ: ' + (company.business_type || '士業全般') + '\n' +
    '主力業務: ' + (company.main_services || '不明') + '\n' +
    '専門分野: ' + (company.specialty || '不明') + '\n' +
    estatInfo + '\n\n' +
    '【重要: 数値の単位ルール】\n' +
    '- 事業所数・法人数・人数: 実数（例: 23000）。万単位にしないこと。\n' +
    '- 金額: 万円単位（例: 平均年商500万円→500）\n' +
    '- 比率・パーセント: 0〜100の数値（例: 開業率5.2%→5.2）\n' +
    '- total_establishments: エリア内全事業所数（実数）\n' +
    '- total_employees: エリア内全従業者数（実数）\n' +
    '- corporations: 法人数（実数）\n' +
    '- sole_proprietors: 個人事業主数（実数）\n' +
    '- opening_rate_pct: 開業率（%）例: 5.2\n' +
    '- closure_rate_pct: 廃業率（%）例: 3.8\n' +
    '- new_establishments_1yr: 直近1年の新設事業所数（実数）\n' +
    '- market_size_estimate: 士業市場規模推計（万円）\n' +
    '- potential_clients_per_shigyo: 士業1事務所あたり潜在顧客数（実数）\n\n' +
    '【士業の潜在顧客の定義】\n' +
    '- 法人: 税務顧問、労務管理、法務相談、許認可申請等のニーズがある企業\n' +
    '- 個人事業主: 確定申告、開業届、各種届出のニーズがある事業者\n' +
    '- 新設法人: 設立登記、税務届出、社会保険手続き等で士業需要が高い\n' +
    '- 相続案件: 高齢者人口に比例して相続関連の需要が発生\n\n' +
    '以下のJSON形式で回答してください。マークダウンのコードブロックで囲まず、純粋JSONのみ返してください:\n' +
    '{\n' +
    '  "area_name": "' + pref + ' ' + city + '",\n' +
    '  "population": { "total_population": "実数(人)", "households": "実数(世帯)", "working_age_pct": "%(20-64歳の割合)", "elderly_pct": "%(65歳以上)", "source": "" },\n' +
    '  "business_establishments": {\n' +
    '    "total_establishments": "全事業所数(実数)",\n' +
    '    "total_employees": "全従業者数(実数)",\n' +
    '    "corporations": "法人数(実数)",\n' +
    '    "sole_proprietors": "個人事業主数(実数)",\n' +
    '    "small_scale_1_4": "従業者1-4人の事業所数(実数)",\n' +
    '    "medium_scale_5_29": "従業者5-29人の事業所数(実数)",\n' +
    '    "large_scale_30_plus": "従業者30人以上の事業所数(実数)",\n' +
    '    "top_industries": "事業所数が多い上位3業種とその数（例: 小売業3200、建設業2100、飲食業1800）",\n' +
    '    "source": "推計"\n' +
    '  },\n' +
    '  "turnover": {\n' +
    '    "new_establishments_1yr": "直近1年の新設事業所数(実数)",\n' +
    '    "closed_establishments_1yr": "直近1年の廃業事業所数(実数)",\n' +
    '    "opening_rate_pct": "開業率(%)",\n' +
    '    "closure_rate_pct": "廃業率(%)",\n' +
    '    "net_increase": "純増減数(実数、正=増加)",\n' +
    '    "new_corporations_1yr": "直近1年の新設法人数(実数)",\n' +
    '    "bankruptcy_count": "直近1年の倒産件数(実数)"\n' +
    '  },\n' +
    '  "shigyo_competition": {\n' +
    '    "tax_accountant_offices": "税理士事務所数(実数)",\n' +
    '    "lawyer_offices": "弁護士事務所数(実数)",\n' +
    '    "judicial_scrivener_offices": "司法書士事務所数(実数)",\n' +
    '    "labor_consultant_offices": "社会保険労務士事務所数(実数)",\n' +
    '    "administrative_scrivener_offices": "行政書士事務所数(実数)",\n' +
    '    "cpa_offices": "公認会計士事務所数(実数)",\n' +
    '    "other_professional_offices": "その他士業事務所数(実数)",\n' +
    '    "total_shigyo_offices": "士業事務所合計(実数)",\n' +
    '    "shigyo_per_1000_establishments": "事業所1000あたり士業数"\n' +
    '  },\n' +
    '  "potential": {\n' +
    '    "target_establishments": "ターゲット事業所数(実数・法人+個人事業主の合計)",\n' +
    '    "target_sole_proprietors": "ターゲット個人事業主数(実数)",\n' +
    '    "potential_clients_per_shigyo": "士業1事務所あたり潜在顧客数(実数)",\n' +
    '    "inheritance_demand_index": "相続需要指数(65歳以上人口比率ベース、全国平均=100)",\n' +
    '    "startup_demand_index": "創業支援需要指数(開業率ベース、全国平均=100)",\n' +
    '    "market_size_estimate": "エリア内士業市場規模推計(万円)",\n' +
    '    "growth_index": "成長性指数(全国平均=100)",\n' +
    '    "ai_insight": "このエリアでの士業事務所の営業戦略に関する具体的な提言。潜在顧客の特徴、ターゲット業種、開拓手法を含め、数値データを引用しながら250字以内で述べてください。"\n' +
    '  }\n' +
    '}';
}

function buildShigyoCrossAreaPrompt(analysis, marketsData) {
  return '以下は士業事務所の各エリアの商圏データです。経営層向けに出店・営業戦略を分析してください。\n' +
    '特に以下の観点で分析してください:\n' +
    '- 事業所数と士業事務所の競合密度のバランス\n' +
    '- 開業率と新設法人数（＝新規顧客獲得チャンス）\n' +
    '- 個人事業主数（＝確定申告等の顧客ボリューム）\n' +
    '- 相続需要（高齢者比率との相関）\n' +
    '- 事業所規模分布（中小企業の多さ＝士業ニーズ）\n\n' +
    '【データの単位】\n' +
    '- 事業所数・法人数・人数: 実数\n' +
    '- 開業率・廃業率: %\n' +
    '- 市場規模: 万円\n' +
    '- 指数: 全国平均=100\n\n' +
    JSON.stringify(marketsData, null, 2) + '\n\n' +
    '以下のJSON形式で回答してください:\n' +
    '{\n' +
    '  "opportunity_ranking": [{"rank":1,"area":"エリア名","reason":"具体的な数値を引用した理由(80字以内)","score":85},...],\n' +
    '  "strategic_summary": "具体的な数値データを引用しながら全体の出店・営業戦略を述べる(300字以内)",\n' +
    '  "sales_advice": "数値に基づく顧客獲得・営業アドバイス(200字以内)",\n' +
    '  "risk_areas": "リスクのあるエリアと数値的根拠(150字以内)",\n' +
    '  "growth_areas": "成長が見込めるエリアと数値的根拠(150字以内)"\n' +
    '}';
}

// ---- 数値正規化 ----
function normalizeMarketData(data) {
  if (!data || typeof data !== 'object') return data;
  var pop = data.population;
  if (pop) {
    if (pop.total_population && pop.total_population > 0 && pop.total_population < 500) {
      pop.total_population = Math.round(pop.total_population * 10000);
    }
    if (pop.households && pop.households > 0 && pop.households < 300) {
      pop.households = Math.round(pop.households * 10000);
    }
  }
  var be = data.business_establishments;
  if (be) {
    // 事業所数: 万単位で来た場合を補正（一般的な市区町村で数千〜数万）
    if (be.total_establishments && be.total_establishments > 0 && be.total_establishments < 50) {
      be.total_establishments = Math.round(be.total_establishments * 10000);
    }
    if (be.total_employees && be.total_employees > 0 && be.total_employees < 100) {
      be.total_employees = Math.round(be.total_employees * 10000);
    }
    if (be.corporations && be.corporations > 0 && be.corporations < 30) {
      be.corporations = Math.round(be.corporations * 10000);
    }
    if (be.sole_proprietors && be.sole_proprietors > 0 && be.sole_proprietors < 30) {
      be.sole_proprietors = Math.round(be.sole_proprietors * 10000);
    }
    // 規模別: 万単位補正（閾値を小さめに）
    if (be.small_scale_1_4 && be.small_scale_1_4 > 0 && be.small_scale_1_4 < 20) {
      be.small_scale_1_4 = Math.round(be.small_scale_1_4 * 10000);
    }
    if (be.medium_scale_5_29 && be.medium_scale_5_29 > 0 && be.medium_scale_5_29 < 20) {
      be.medium_scale_5_29 = Math.round(be.medium_scale_5_29 * 10000);
    }
  }
  var tn = data.turnover;
  if (tn) {
    // 新設事業所: 万単位で来た場合を補正
    if (tn.new_establishments_1yr && tn.new_establishments_1yr > 0 && tn.new_establishments_1yr < 10) {
      tn.new_establishments_1yr = Math.round(tn.new_establishments_1yr * 10000);
    }
    if (tn.closed_establishments_1yr && tn.closed_establishments_1yr > 0 && tn.closed_establishments_1yr < 10) {
      tn.closed_establishments_1yr = Math.round(tn.closed_establishments_1yr * 10000);
    }
  }
  var pt = data.potential;
  if (pt) {
    if (pt.target_establishments && pt.target_establishments > 0 && pt.target_establishments < 50) {
      pt.target_establishments = Math.round(pt.target_establishments * 10000);
    }
    if (pt.target_sole_proprietors && pt.target_sole_proprietors > 0 && pt.target_sole_proprietors < 30) {
      pt.target_sole_proprietors = Math.round(pt.target_sole_proprietors * 10000);
    }
    // 市場規模: 万円単位のはずだが、億単位で来た場合を補正
    if (pt.market_size_estimate && pt.market_size_estimate > 100000000) {
      pt.market_size_estimate = Math.round(pt.market_size_estimate / 10000);
    }
  }
  return data;
}

// ---- 住所→エリア変換 ----
var CITY_TO_PREF = {
  '札幌市':'北海道','仙台市':'宮城県','さいたま市':'埼玉県','千葉市':'千葉県',
  '横浜市':'神奈川県','川崎市':'神奈川県','相模原市':'神奈川県','新潟市':'新潟県',
  '静岡市':'静岡県','浜松市':'静岡県','名古屋市':'愛知県','京都市':'京都府',
  '大阪市':'大阪府','堺市':'大阪府','神戸市':'兵庫県','岡山市':'岡山県',
  '広島市':'広島県','北九州市':'福岡県','福岡市':'福岡県','熊本市':'熊本県'
};

function extractAreaFromAddress(address) {
  if (!address) return null;
  var prefMatch = address.match(/(北海道|東京都|大阪府|京都府|.{2,3}県)/);
  if (prefMatch) {
    var pref = prefMatch[1];
    var rest = address.slice(address.indexOf(pref) + pref.length);
    var city = '';
    if (pref === '東京都') {
      var wardMatch = rest.match(/^(.+?区)/);
      city = wardMatch ? wardMatch[1] : '';
    } else {
      var cityMatch = rest.match(/^(.+?市)(.+?区)?/) || rest.match(/^(.+?郡)(.+?[町村])/);
      if (cityMatch) { city = cityMatch[1] + (cityMatch[2] || ''); }
      else { var kuMatch = rest.match(/^(.+?区)/); city = kuMatch ? kuMatch[1] : ''; }
    }
    return { prefecture: pref, city: city, label: pref + ' ' + city };
  }
  for (var cName in CITY_TO_PREF) {
    if (address.indexOf(cName) >= 0) {
      var cPref = CITY_TO_PREF[cName];
      var cRest = address.slice(address.indexOf(cName));
      var cMatch = cRest.match(/^(.+?市)(.+?区)?/);
      var cCity = cMatch ? cMatch[1] + (cMatch[2] || '') : cName;
      return { prefecture: cPref, city: cCity, label: cPref + ' ' + cCity };
    }
  }
  return null;
}

function extractPageSummary(html) {
  try {
    var parser = new DOMParser();
    var doc = parser.parseFromString(html, 'text/html');
    doc.querySelectorAll('header, nav, footer, aside, script, style, noscript, iframe, svg, form').forEach(function(el) { el.remove(); });
    var mainEl = doc.querySelector('main, article, .main, .content, #main, #content');
    var text = (mainEl || doc.body || doc).textContent || '';
    var lines = text.split(/[\n\r]+/);
    var meaningful = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/\s+/g, ' ').trim();
      if (line.length < 20) continue;
      if (/^(TOP|HOME|MENU|Cookie|©|Copyright)/.test(line)) continue;
      meaningful.push(line);
      if (meaningful.length >= 2) break;
    }
    return meaningful.join(' ').slice(0, 200);
  } catch(e) { return ''; }
}

// ---- JSON Parser ----
function parseJSON(text) {
  var cleaned = text.trim();
  var codeBlockStart = /^```(?:json)?\s*\n?/;
  var codeBlockEnd = /\n?```\s*$/;
  if (cleaned.match(codeBlockStart)) {
    cleaned = cleaned.replace(codeBlockStart, '').replace(codeBlockEnd, '');
  }
  try { return JSON.parse(cleaned); } catch (e) {
    var match = cleaned.match(/\{[\s\S]*\}/);
    if (match) { try { return JSON.parse(match[0]); } catch (e2) {} }
    throw new Error('AIの応答をパースできませんでした。再度お試しください。');
  }
}

// ---- 比較テーブル ----
function buildComparisonTable(markets) {
  if (!markets || markets.length === 0) return '';
  var html = '<div style="overflow-x:auto; margin-bottom:20px;"><table class="data-table" style="font-size:11px; width:100%; min-width:1000px;">' +
    '<thead><tr style="background:rgba(139,92,246,0.1);">' +
    '<th style="text-align:left;">エリア</th><th>人口(人)</th><th>事業所数</th><th>法人数</th><th>個人事業主</th><th>開業率(%)</th><th>廃業率(%)</th><th>士業事務所数</th><th>潜在顧客/士業</th>' +
    '</tr></thead><tbody>';
  var totPop=0, totEst=0, totCorp=0, totSole=0, totOpen=0, totClose=0, totShigyo=0, totPot=0, cnt=0;
  markets.forEach(function(mkt) {
    var d = mkt.data || {};
    var pop = (d.population || {}).total_population || 0;
    var est = (d.business_establishments || {}).total_establishments || 0;
    var corp = (d.business_establishments || {}).corporations || 0;
    var sole = (d.business_establishments || {}).sole_proprietors || 0;
    var openRate = (d.turnover || {}).opening_rate_pct || 0;
    var closeRate = (d.turnover || {}).closure_rate_pct || 0;
    var shigyoTotal = (d.shigyo_competition || {}).total_shigyo_offices || 0;
    var potPerShigyo = (d.potential || {}).potential_clients_per_shigyo || 0;
    totPop+=pop; totEst+=est; totCorp+=corp; totSole+=sole; totOpen+=openRate; totClose+=closeRate; totShigyo+=shigyoTotal; totPot+=potPerShigyo; cnt++;
    var icon = (mkt.area && mkt.area.isHQ) ? '🏢' : '📍';
    var label = mkt.area ? mkt.area.label : 'エリア';
    html += '<tr><td style="font-weight:600; white-space:nowrap;">' + icon + ' ' + escapeHtml(label) + '</td>' +
      '<td style="text-align:right;">' + formatNumber(pop) + '</td>' +
      '<td style="text-align:right;">' + formatNumber(est) + '</td>' +
      '<td style="text-align:right;">' + formatNumber(corp) + '</td>' +
      '<td style="text-align:right;">' + formatNumber(sole) + '</td>' +
      '<td style="text-align:right;">' + openRate + '%</td>' +
      '<td style="text-align:right;">' + closeRate + '%</td>' +
      '<td style="text-align:right;">' + formatNumber(shigyoTotal) + '</td>' +
      '<td style="text-align:right;">' + formatNumber(potPerShigyo) + '</td></tr>';
  });
  var n = cnt || 1;
  html += '<tr style="background:rgba(16,185,129,0.08); font-weight:700;"><td>平均</td>' +
    '<td style="text-align:right;">' + formatNumber(Math.round(totPop/n)) + '</td>' +
    '<td style="text-align:right;">' + formatNumber(Math.round(totEst/n)) + '</td>' +
    '<td style="text-align:right;">' + formatNumber(Math.round(totCorp/n)) + '</td>' +
    '<td style="text-align:right;">' + formatNumber(Math.round(totSole/n)) + '</td>' +
    '<td style="text-align:right;">' + (totOpen/n).toFixed(1) + '%</td>' +
    '<td style="text-align:right;">' + (totClose/n).toFixed(1) + '%</td>' +
    '<td style="text-align:right;">' + formatNumber(Math.round(totShigyo/n)) + '</td>' +
    '<td style="text-align:right;">' + formatNumber(Math.round(totPot/n)) + '</td></tr>';
  html += '</tbody></table></div>';
  return html;
}

// ---- 士業データセクション ----
function renderShigyoDataSections(marketData) {
  var html = '';

  if (marketData.business_establishments) {
    var be = marketData.business_establishments;
    html += '<div style="margin-bottom:16px;"><div style="font-size:14px; font-weight:700; margin-bottom:8px;">🏢 事業所データ</div><div class="stat-grid">' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(be.total_establishments) + '<span style="font-size:14px">件</span></div><div class="stat-box__label">全事業所数</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(be.total_employees) + '<span style="font-size:14px">人</span></div><div class="stat-box__label">全従業者数</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(be.corporations) + '<span style="font-size:14px">社</span></div><div class="stat-box__label">法人数</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(be.sole_proprietors) + '<span style="font-size:14px">人</span></div><div class="stat-box__label">個人事業主数</div></div>' +
      '</div><div class="stat-grid" style="margin-top:8px;">' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(be.small_scale_1_4) + '<span style="font-size:14px">件</span></div><div class="stat-box__label">小規模(1-4人)</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(be.medium_scale_5_29) + '<span style="font-size:14px">件</span></div><div class="stat-box__label">中規模(5-29人)</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(be.large_scale_30_plus) + '<span style="font-size:14px">件</span></div><div class="stat-box__label">大規模(30人以上)</div></div>' +
      '</div>';
    if (be.top_industries) {
      html += '<div style="margin-top:8px; padding:10px 14px; background:rgba(139,92,246,0.05); border-radius:8px; border:1px solid rgba(139,92,246,0.1); font-size:12px; color:var(--text-secondary);">📊 主要業種: ' + escapeHtml(be.top_industries) + '</div>';
    }
    html += '</div>';
  }

  if (marketData.turnover) {
    var tn = marketData.turnover;
    html += '<div style="margin-bottom:16px;"><div style="font-size:14px; font-weight:700; margin-bottom:8px;">📈 開廃業動向</div><div class="stat-grid">' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(tn.new_establishments_1yr) + '<span style="font-size:14px">件/年</span></div><div class="stat-box__label">新設事業所数</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(tn.closed_establishments_1yr) + '<span style="font-size:14px">件/年</span></div><div class="stat-box__label">廃業事業所数</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (tn.opening_rate_pct || '—') + '<span style="font-size:14px">%</span></div><div class="stat-box__label">開業率</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (tn.closure_rate_pct || '—') + '<span style="font-size:14px">%</span></div><div class="stat-box__label">廃業率</div></div>' +
      '</div><div class="stat-grid" style="margin-top:8px;">' +
      '<div class="stat-box"><div class="stat-box__value" style="color:' + (tn.net_increase >= 0 ? '#10b981' : '#f43f5e') + ';">' + (tn.net_increase >= 0 ? '+' : '') + formatNumber(tn.net_increase) + '<span style="font-size:14px">件</span></div><div class="stat-box__label">純増減数</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(tn.new_corporations_1yr) + '<span style="font-size:14px">社/年</span></div><div class="stat-box__label">新設法人数</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(tn.bankruptcy_count) + '<span style="font-size:14px">件/年</span></div><div class="stat-box__label">倒産件数</div></div>' +
      '</div></div>';
  }

  if (marketData.shigyo_competition) {
    var sc = marketData.shigyo_competition;
    html += '<div style="margin-bottom:16px;"><div style="font-size:14px; font-weight:700; margin-bottom:8px;">⚖️ 競合士業分析</div><div class="stat-grid">' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(sc.tax_accountant_offices) + '<span style="font-size:14px">件</span></div><div class="stat-box__label">税理士事務所</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(sc.lawyer_offices) + '<span style="font-size:14px">件</span></div><div class="stat-box__label">弁護士事務所</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(sc.judicial_scrivener_offices) + '<span style="font-size:14px">件</span></div><div class="stat-box__label">司法書士事務所</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(sc.labor_consultant_offices) + '<span style="font-size:14px">件</span></div><div class="stat-box__label">社労士事務所</div></div>' +
      '</div><div class="stat-grid" style="margin-top:8px;">' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(sc.administrative_scrivener_offices) + '<span style="font-size:14px">件</span></div><div class="stat-box__label">行政書士事務所</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(sc.cpa_offices || 0) + '<span style="font-size:14px">件</span></div><div class="stat-box__label">公認会計士事務所</div></div>' +
      '<div class="stat-box" style="border:2px solid rgba(139,92,246,0.3);"><div class="stat-box__value" style="color:#8b5cf6;">' + formatNumber(sc.total_shigyo_offices) + '<span style="font-size:14px">件</span></div><div class="stat-box__label">士業事務所合計</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (sc.shigyo_per_1000_establishments || '—') + '</div><div class="stat-box__label">事業所1000あたり士業数</div></div>' +
      '</div></div>';
  }

  if (marketData.potential) {
    var pot = marketData.potential;
    html += '<div style="margin-bottom:16px;"><div style="font-size:14px; font-weight:700; margin-bottom:8px;">🎯 潜在顧客・市場ポテンシャル</div><div class="stat-grid">' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(pot.target_establishments) + '<span style="font-size:14px">件</span></div><div class="stat-box__label">ターゲット事業所数</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(pot.target_sole_proprietors) + '<span style="font-size:14px">人</span></div><div class="stat-box__label">ターゲット個人事業主</div></div>' +
      '<div class="stat-box" style="border:2px solid rgba(16,185,129,0.3);"><div class="stat-box__value" style="color:#10b981;">' + formatNumber(pot.potential_clients_per_shigyo) + '<span style="font-size:14px">件/事務所</span></div><div class="stat-box__label">士業1事務所あたり潜在顧客</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(pot.market_size_estimate) + '<span style="font-size:14px">万円</span></div><div class="stat-box__label">士業市場規模推計</div></div>' +
      '</div><div class="stat-grid" style="margin-top:8px;">' +
      '<div class="stat-box"><div class="stat-box__value">' + (pot.inheritance_demand_index || '—') + '</div><div class="stat-box__label">相続需要指数</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (pot.startup_demand_index || '—') + '</div><div class="stat-box__label">創業支援需要指数</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (pot.growth_index || '—') + '</div><div class="stat-box__label">成長性指数</div></div>' +
      '</div>';
    if (pot.ai_insight) {
      html += '<div class="summary-box" style="margin-top:10px"><div class="summary-box__title">📌 AIからの営業戦略提言</div><div class="summary-box__text">' + escapeHtml(pot.ai_insight) + '</div></div>';
    }
    html += '</div>';
  }
  return html;
}

// ---- Render Results ----
function renderResults(data) {
  var company = data.company;
  var html = '';
  var sourceBadge = data.data_source === 'e-Stat + Gemini'
    ? '<span style="background: linear-gradient(135deg, #10b981, #8b5cf6); color:#fff; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700;">📊 e-Stat実データ + AI分析</span>'
    : '<span style="background: var(--accent-gradient); color:#fff; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700;">🤖 AI推計モード</span>';

  html += '<div class="result-card result-card--company"><div class="result-card__header"><div class="result-card__icon">⚖️</div><div><div class="result-card__title">' + escapeHtml(company.name || '事務所分析') + '</div><div class="result-card__subtitle">Gemini 2.0 Flash による士業事務所分析 ' + sourceBadge + '</div></div></div>' +
    '<div class="result-card__body"><table class="data-table">' +
    '<tr><th>事務所名</th><td>' + escapeHtml(company.name || '—') + '</td></tr>' +
    '<tr><th>所在地</th><td>' + escapeHtml(company.address || '—') + '</td></tr>' +
    '<tr><th>事務所タイプ</th><td>' + escapeHtml(company.business_type || '—') + '</td></tr>' +
    '<tr><th>主力業務</th><td>' + escapeHtml(company.main_services || '—') + '</td></tr>' +
    '<tr><th>専門分野</th><td>' + escapeHtml(company.specialty || '—') + '</td></tr>' +
    '<tr><th>所員数</th><td>' + escapeHtml(company.staff_count || '—') + '</td></tr>' +
    '<tr><th>料金帯</th><td>' + escapeHtml(company.fee_range || '—') + '</td></tr>' +
    '<tr><th>業種</th><td><span class="industry-badge" style="background:#8b5cf6;">⚖️ 士業</span></td></tr>' +
    '</table>';

  if (company.strengths) html += '<div class="summary-box" style="margin-top:16px"><div class="summary-box__title">💪 強み・特徴</div><div class="summary-box__text">' + escapeHtml(company.strengths) + '</div></div>';
  if (company.weaknesses) html += '<div class="summary-box" style="margin-top:12px; background: linear-gradient(135deg, rgba(244,63,94,0.1), rgba(249,115,22,0.1)); border-color: rgba(244,63,94,0.2);"><div class="summary-box__title" style="color:var(--accent-rose)">⚠️ 改善余地</div><div class="summary-box__text">' + escapeHtml(company.weaknesses) + '</div></div>';
  if (company.keywords && company.keywords.length) {
    html += '<div class="tag-list" style="margin-top:16px">';
    company.keywords.forEach(function(k) { html += '<span class="tag">' + escapeHtml(k) + '</span>'; });
    html += '</div>';
  }
  html += '</div></div>';

  // サマリーダッシュボード
  var markets = data.markets || [];
  var cross = data.crossAreaInsight || {};
  if (markets.length > 0) {
    html += '<div class="result-card" style="border:2px solid rgba(139,92,246,0.3); background:linear-gradient(135deg,rgba(139,92,246,0.05),rgba(99,102,241,0.05));"><div class="result-card__header"><div class="result-card__icon">📊</div><div><div class="result-card__title">全エリア比較サマリー</div><div class="result-card__subtitle">' + markets.length + 'エリアの横断比較 — 士業市場ダッシュボード</div></div></div><div class="result-card__body">';
    html += buildComparisonTable(markets);

    html += '<div class="chart-grid"><div style="background:rgba(30,41,59,0.5); border-radius:12px; padding:16px; border:1px solid rgba(139,92,246,0.1);"><div style="font-size:13px; font-weight:700; margin-bottom:8px;">📈 事業所数 × 開業率</div><div style="position:relative; height:220px;"><canvas id="chart-est-opening"></canvas></div></div>' +
      '<div style="background:rgba(30,41,59,0.5); border-radius:12px; padding:16px; border:1px solid rgba(139,92,246,0.1);"><div style="font-size:13px; font-weight:700; margin-bottom:8px;">📊 士業事務所数 × 潜在顧客/士業</div><div style="position:relative; height:220px;"><canvas id="chart-shigyo-potential"></canvas></div></div></div>';

    if (cross.opportunity_ranking && cross.opportunity_ranking.length > 0) {
      html += '<div style="margin-bottom:20px;"><div style="font-size:15px; font-weight:700; margin-bottom:12px;">🏆 出店チャンスランキング</div>';
      var colors = ['#8b5cf6','#6366f1','#10b981','#f59e0b','#f97316','#3b82f6'];
      cross.opportunity_ranking.forEach(function(r, i) {
        var c = colors[i % colors.length];
        html += '<div style="margin-bottom:10px; padding:10px 14px; background:rgba(30,41,59,0.4); border-radius:10px; border:1px solid rgba(139,92,246,0.08);"><div style="display:flex; align-items:center; gap:10px; margin-bottom:6px;"><span style="font-size:18px; font-weight:800; color:' + c + ';">#' + (r.rank||i+1) + '</span><span style="font-size:14px; font-weight:700;">' + escapeHtml(r.area||'') + '</span><span style="margin-left:auto; font-size:20px; font-weight:800; color:' + c + ';">' + (r.score||0) + '<span style="font-size:11px; color:var(--text-muted);">点</span></span></div><div style="background:rgba(255,255,255,0.05); border-radius:6px; height:8px; overflow:hidden;"><div style="width:' + (r.score||50) + '%; height:100%; background:' + c + '; border-radius:6px;"></div></div><div style="font-size:11px; color:var(--text-secondary); margin-top:6px;">' + escapeHtml(r.reason||'') + '</div></div>';
      });
      html += '</div>';
    }

    var insightCards = [];
    if (cross.strategic_summary) insightCards.push({icon:'🎯',title:'出店・営業戦略サマリー',text:cross.strategic_summary,color:'#8b5cf6'});
    if (cross.sales_advice) insightCards.push({icon:'💼',title:'顧客獲得アドバイス',text:cross.sales_advice,color:'#10b981'});
    if (cross.growth_areas) insightCards.push({icon:'📈',title:'成長が見込めるエリア',text:cross.growth_areas,color:'#6366f1'});
    if (cross.risk_areas) insightCards.push({icon:'⚠️',title:'リスク・注意エリア',text:cross.risk_areas,color:'#f59e0b'});
    if (insightCards.length > 0) {
      html += '<div class="insight-grid">';
      insightCards.forEach(function(card) {
        html += '<div style="background:rgba(30,41,59,0.5); border-radius:12px; padding:16px; border-left:4px solid ' + card.color + ';"><div style="font-size:13px; font-weight:700; margin-bottom:8px; color:' + card.color + ';">' + card.icon + ' ' + card.title + '</div><div style="font-size:12px; color:var(--text-secondary); line-height:1.6;">' + escapeHtml(card.text) + '</div></div>';
      });
      html += '</div>';
    }
    html += '</div></div>';
  }

  // エリア別詳細
  if (markets.length > 0) {
    html += '<div class="result-card" style="border: 1px solid rgba(139,92,246,0.15); padding: 0;"><div class="result-card__header" style="padding:16px 20px 0"><div class="result-card__icon">⚖️</div><div><div class="result-card__title">エリア別士業市場データ</div><div class="result-card__subtitle">' + markets.length + 'エリアの詳細データ</div></div></div>' +
      '<div class="area-tab-btns" style="display:flex; flex-wrap:wrap; gap:6px; padding:12px 20px; border-bottom:1px solid rgba(139,92,246,0.1);">';
    markets.forEach(function(mkt, idx) {
      var isHQ = mkt.area && mkt.area.isHQ;
      var label = isHQ ? '🏢 ' + (mkt.area.label || '本所') : '📍 ' + (mkt.area.label || 'エリア' + (idx+1));
      var activeStyle = idx === 0 ? 'background:var(--accent-gradient); color:#fff; border-color:transparent;' : 'background:var(--bg-tertiary); color:var(--text-secondary); border-color:rgba(139,92,246,0.15);';
      html += '<button class="area-tab-btn" data-area-idx="' + idx + '" onclick="switchAreaTab(' + idx + ')" style="padding:6px 14px; border-radius:20px; border:1px solid; font-size:11px; font-weight:600; cursor:pointer; transition:all 0.2s; white-space:nowrap; ' + activeStyle + '">' + escapeHtml(label) + '</button>';
    });
    html += '</div>';

    markets.forEach(function(mkt, idx) {
      var m = mkt.data || {};
      var areaLabel = m.area_name || (mkt.area && mkt.area.label) || 'エリア';
      var display = idx === 0 ? 'block' : 'none';
      html += '<div class="area-tab-content" id="area-tab-' + idx + '" style="display:' + display + '; padding:16px 20px;">';
      if (m.population) {
        var pop = m.population;
        var popSource = pop.source ? ' <span style="font-size:11px; color:var(--text-muted);">(' + escapeHtml(pop.source) + ')</span>' : '';
        html += '<div style="margin-bottom:16px;"><div style="font-size:14px; font-weight:700; margin-bottom:8px;">👥 人口・世帯データ' + popSource + '</div><div class="stat-grid">' +
          '<div class="stat-box"><div class="stat-box__value">' + formatNumber(pop.total_population) + '<span style="font-size:14px">人</span></div><div class="stat-box__label">総人口</div></div>' +
          '<div class="stat-box"><div class="stat-box__value">' + formatNumber(pop.households) + '<span style="font-size:14px">世帯</span></div><div class="stat-box__label">世帯数</div></div>' +
          '<div class="stat-box"><div class="stat-box__value">' + (pop.working_age_pct || '—') + '%</div><div class="stat-box__label">生産年齢(20-64歳)</div></div>' +
          '<div class="stat-box"><div class="stat-box__value">' + (pop.elderly_pct || '—') + '%</div><div class="stat-box__label">65歳以上</div></div></div></div>';
      }
      html += renderShigyoDataSections(m);
      html += '</div>';
    });
    html += '</div>';
  }

  resultsContent.innerHTML = html;
  if (markets.length > 0 && typeof Chart !== 'undefined') {
    setTimeout(function() { renderSummaryCharts(markets); }, 100);
  }
}

// ---- Charts ----
function renderSummaryCharts(markets) {
  var labels = markets.map(function(mkt) { return mkt.area ? mkt.area.label : 'エリア'; });
  var estData = markets.map(function(mkt) { return ((mkt.data||{}).business_establishments||{}).total_establishments||0; });
  var openData = markets.map(function(mkt) { return ((mkt.data||{}).turnover||{}).opening_rate_pct||0; });
  var shigyoData = markets.map(function(mkt) { return ((mkt.data||{}).shigyo_competition||{}).total_shigyo_offices||0; });
  var potData = markets.map(function(mkt) { return ((mkt.data||{}).potential||{}).potential_clients_per_shigyo||0; });
  var chartFont = { color: '#94a3b8' };
  var gridColor = 'rgba(148,163,184,0.1)';

  var ctx1 = document.getElementById('chart-est-opening');
  if (ctx1) {
    new Chart(ctx1, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          { label: '事業所数', data: estData, backgroundColor: 'rgba(139,92,246,0.6)', borderRadius: 6, yAxisID: 'y', order: 2 },
          { label: '開業率(%)', data: openData, type: 'line', borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.15)', pointBackgroundColor: '#10b981', pointRadius: 5, borderWidth: 3, fill: true, yAxisID: 'y1', order: 1 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: chartFont.color, font: { size: 11 } } } },
        scales: {
          x: { ticks: { color: chartFont.color, font: { size: 10 } }, grid: { color: gridColor } },
          y: { position: 'left', ticks: { color: chartFont.color, font: { size: 10 }, callback: function(v) { return v >= 10000 ? (v/10000).toFixed(0)+'万' : v; } }, grid: { color: gridColor } },
          y1: { position: 'right', min: 0, max: 15, ticks: { color: '#10b981', font: { size: 10 }, callback: function(v) { return v+'%'; } }, grid: { display: false } }
        }
      }
    });
  }

  var ctx2 = document.getElementById('chart-shigyo-potential');
  if (ctx2) {
    new Chart(ctx2, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          { label: '士業事務所数', data: shigyoData, backgroundColor: 'rgba(139,92,246,0.6)', borderRadius: 6, yAxisID: 'y', order: 2 },
          { label: '潜在顧客/士業', data: potData, type: 'line', borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.15)', pointBackgroundColor: '#f59e0b', pointRadius: 5, borderWidth: 3, fill: true, yAxisID: 'y1', order: 1 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: chartFont.color, font: { size: 11 } } } },
        scales: {
          x: { ticks: { color: chartFont.color, font: { size: 10 } }, grid: { color: gridColor } },
          y: { position: 'left', ticks: { color: chartFont.color, font: { size: 10 } }, grid: { color: gridColor } },
          y1: { position: 'right', ticks: { color: '#f59e0b', font: { size: 10 } }, grid: { display: false } }
        }
      }
    });
  }
}

function switchAreaTab(idx) {
  var contents = document.querySelectorAll('.area-tab-content');
  contents.forEach(function(el) { el.style.display = 'none'; });
  var target = document.getElementById('area-tab-' + idx);
  if (target) target.style.display = 'block';
  var btns = document.querySelectorAll('.area-tab-btn');
  btns.forEach(function(btn) {
    var btnIdx = parseInt(btn.getAttribute('data-area-idx'));
    if (btnIdx === idx) { btn.style.background = 'var(--accent-gradient)'; btn.style.color = '#fff'; btn.style.borderColor = 'transparent'; }
    else { btn.style.background = 'var(--bg-tertiary)'; btn.style.color = 'var(--text-secondary)'; btn.style.borderColor = 'rgba(139,92,246,0.15)'; }
  });
}

// ---- Excel Export ----
function exportExcel() {
  if (!analysisData) return;
  var wb = XLSX.utils.book_new();
  var company = analysisData.company || {};
  var markets = analysisData.markets || [];
  var cross = analysisData.crossAreaInsight || {};

  // Sheet 1: 全エリアサマリー
  var s0 = [];
  s0.push(['士業エリア比較サマリー — ' + (company.name || '事務所名')]);
  s0.push(['出力日: ' + new Date().toLocaleDateString('ja-JP'), '', '', '', '', '', '', '', '', '分析URL: ' + (analysisData.url || '')]);
  s0.push([]);
  if (markets.length > 0) {
    s0.push(['No', 'エリア名', '人口(人)', '事業所数', '法人数', '個人事業主数', '開業率(%)', '廃業率(%)', '士業事務所数', '潜在顧客/士業']);
    markets.forEach(function(mkt, idx) {
      var d = mkt.data || {};
      var label = (mkt.area.isHQ ? '🏢 ' : '📍 ') + mkt.area.label;
      s0.push([idx+1, label,
        (d.population||{}).total_population||0,
        (d.business_establishments||{}).total_establishments||0,
        (d.business_establishments||{}).corporations||0,
        (d.business_establishments||{}).sole_proprietors||0,
        (d.turnover||{}).opening_rate_pct||0,
        (d.turnover||{}).closure_rate_pct||0,
        (d.shigyo_competition||{}).total_shigyo_offices||0,
        (d.potential||{}).potential_clients_per_shigyo||0
      ]);
    });
    s0.push([]);
    if (cross.strategic_summary) { s0.push(['▼ 営業戦略サマリー']); s0.push([cross.strategic_summary]); s0.push([]); }
    if (cross.sales_advice) { s0.push(['▼ 顧客獲得アドバイス']); s0.push([cross.sales_advice]); s0.push([]); }
    if (cross.growth_areas) { s0.push(['▼ 成長エリア']); s0.push([cross.growth_areas]); s0.push([]); }
    if (cross.risk_areas) { s0.push(['▼ リスクエリア']); s0.push([cross.risk_areas]); }
  }
  var ws0 = XLSX.utils.aoa_to_sheet(s0);
  ws0['!cols'] = [{wch:5},{wch:24},{wch:12},{wch:12},{wch:10},{wch:12},{wch:10},{wch:10},{wch:12},{wch:14}];
  XLSX.utils.book_append_sheet(wb, ws0, '全エリアサマリー');

  // Sheet 2: 事務所概要
  var s1 = [
    ['事務所概要 — ' + (company.name || '')], ['出力日: ' + new Date().toLocaleDateString('ja-JP')], [],
    ['■ 基本情報'],
    ['事務所名', company.name || '—'], ['所在地', company.address || '—'],
    ['事務所タイプ', company.business_type || '—'],
    ['主力業務', company.main_services || '—'], ['専門分野', company.specialty || '—'],
    ['所員数', company.staff_count || '—'], ['料金帯', company.fee_range || '—'],
    [], ['■ 強み'], [company.strengths || '—'], [], ['■ 改善余地'], [company.weaknesses || '—']
  ];
  var ws1 = XLSX.utils.aoa_to_sheet(s1);
  ws1['!cols'] = [{wch:18},{wch:50}];
  XLSX.utils.book_append_sheet(wb, ws1, '事務所概要');

  // Sheet 3+: エリア別詳細
  markets.forEach(function(mkt, idx) {
    var m = mkt.data || {};
    var areaLabel = m.area_name || (mkt.area && mkt.area.label) || 'エリア' + (idx+1);
    var rows = [['士業市場エリア詳細: ' + areaLabel], []];
    if (m.population) {
      rows.push(['① 人口データ', '', 'ソース:', (m.population.source||'推計')]);
      rows.push(['総人口(人)', m.population.total_population||0]); rows.push(['世帯数', m.population.households||0]); rows.push([]);
    }
    if (m.business_establishments) {
      var be = m.business_establishments;
      rows.push(['② 事業所データ']);
      rows.push(['全事業所数', be.total_establishments||0]);
      rows.push(['全従業者数(人)', be.total_employees||0]);
      rows.push(['法人数', be.corporations||0]);
      rows.push(['個人事業主数', be.sole_proprietors||0]);
      rows.push(['小規模(1-4人)', be.small_scale_1_4||0]);
      rows.push(['中規模(5-29人)', be.medium_scale_5_29||0]);
      rows.push(['大規模(30人以上)', be.large_scale_30_plus||0]);
      if (be.top_industries) rows.push(['主要業種', be.top_industries]);
      rows.push([]);
    }
    if (m.turnover) {
      var tn = m.turnover;
      rows.push(['③ 開廃業動向']);
      rows.push(['新設事業所数(件/年)', tn.new_establishments_1yr||0]);
      rows.push(['廃業事業所数(件/年)', tn.closed_establishments_1yr||0]);
      rows.push(['開業率(%)', tn.opening_rate_pct||0]);
      rows.push(['廃業率(%)', tn.closure_rate_pct||0]);
      rows.push(['純増減数', tn.net_increase||0]);
      rows.push(['新設法人数(社/年)', tn.new_corporations_1yr||0]);
      rows.push(['倒産件数(件/年)', tn.bankruptcy_count||0]);
      rows.push([]);
    }
    if (m.shigyo_competition) {
      var sc = m.shigyo_competition;
      rows.push(['④ 競合士業分析']);
      rows.push(['税理士事務所', sc.tax_accountant_offices||0]);
      rows.push(['弁護士事務所', sc.lawyer_offices||0]);
      rows.push(['司法書士事務所', sc.judicial_scrivener_offices||0]);
      rows.push(['社労士事務所', sc.labor_consultant_offices||0]);
      rows.push(['行政書士事務所', sc.administrative_scrivener_offices||0]);
      rows.push(['公認会計士事務所', sc.cpa_offices||0]);
      rows.push(['士業事務所合計', sc.total_shigyo_offices||0]);
      rows.push(['事業所1000あたり士業数', sc.shigyo_per_1000_establishments||0]);
      rows.push([]);
    }
    if (m.potential) {
      var pot = m.potential;
      rows.push(['⑤ 潜在顧客・市場ポテンシャル']);
      rows.push(['ターゲット事業所数', pot.target_establishments||0]);
      rows.push(['ターゲット個人事業主数', pot.target_sole_proprietors||0]);
      rows.push(['士業1事務所あたり潜在顧客', pot.potential_clients_per_shigyo||0]);
      rows.push(['相続需要指数', pot.inheritance_demand_index||0]);
      rows.push(['創業支援需要指数', pot.startup_demand_index||0]);
      rows.push(['士業市場規模推計(万円)', pot.market_size_estimate||0]);
      rows.push(['成長性指数', pot.growth_index||0]);
      rows.push([]);
    }
    if (m.potential && m.potential.ai_insight) {
      rows.push(['⑥ AIコメント']); rows.push([m.potential.ai_insight]);
    }
    var ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{wch:28},{wch:35},{wch:12},{wch:20}];
    XLSX.utils.book_append_sheet(wb, ws, areaLabel.slice(0,28));
  });

  var fileName = '士業市場分析_' + (company.name || 'report') + '_' + new Date().toISOString().slice(0,10) + '.xlsx';
  XLSX.writeFile(wb, fileName);
}

// ---- Reset ----
function resetAll() {
  analysisData = null; urlInput.value = '';
  hideResults(); hideProgress(); hideError(); resultsContent.innerHTML = '';
}

// ---- UI Helpers ----
function setLoading(isLoading) { analyzeBtn.disabled = isLoading; analyzeBtn.classList.toggle('is-loading', isLoading); }
function showProgress() { progressSection.classList.add('is-active'); document.querySelectorAll('.progress__step').forEach(function(s) { s.classList.remove('is-active', 'is-done'); }); }
function hideProgress() { progressSection.classList.remove('is-active'); }
function activateStep(id) { var step = document.getElementById(id); if (step) { step.classList.add('is-active'); step.classList.remove('is-done'); } }
function completeStep(id) { var step = document.getElementById(id); if (step) { step.classList.remove('is-active'); step.classList.add('is-done'); } }
function showResults() { resultsSection.classList.add('is-active'); resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
function hideResults() { resultsSection.classList.remove('is-active'); }
function showError(msg) { errorMsg.textContent = msg; errorMsg.classList.add('is-active'); }
function hideError() { errorMsg.classList.remove('is-active'); }
function isValidUrl(string) { try { var url = new URL(string); return url.protocol === 'http:' || url.protocol === 'https:'; } catch (e) { return false; } }
function escapeHtml(str) { if (!str) return ''; var div = document.createElement('div'); div.appendChild(document.createTextNode(str)); return div.innerHTML; }
function formatNumber(num) { if (num == null || num === '') return '—'; return Number(num).toLocaleString('ja-JP'); }
function sleep(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }

urlInput.addEventListener('keypress', function(e) { if (e.key === 'Enter') startAnalysis(); });
