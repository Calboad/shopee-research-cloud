import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 国内访问 Gemini 必须走代理。如果 .env 里设了 HTTPS_PROXY，第一次调用前
// 用 undici 的 ProxyAgent 配成全局 dispatcher，让 @google/genai 内部 fetch 走代理。
let proxyConfigured = false;
async function ensureProxyDispatcher() {
  if (proxyConfigured) return;
  proxyConfigured = true;
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (!proxyUrl) return;
  try {
    const { ProxyAgent, setGlobalDispatcher } = await import('undici');
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    console.log(`[research-analyzer] HTTPS_PROXY 已生效：${proxyUrl}`);
  } catch (e) {
    console.warn(`[research-analyzer] 配置代理失败：${e.message}`);
  }
}

const toNum = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// "10.00 ~ 50.00" → 中间值；纯数字直接用
const parsePrice = (raw) => {
  if (raw == null || raw === '') return null;
  const s = String(raw);
  if (s.includes('~')) {
    const [a, b] = s.split('~').map((x) => toNum(x.trim()));
    if (a != null && b != null) return (a + b) / 2;
    return a ?? b;
  }
  return toNum(s);
};

// 5 个价格段：min ~ max 等分
function bucketByPrice(items) {
  const priced = items
    .map((it) => ({ ...it, _p: parsePrice(it.price), _m: toNum(it.monthlySold) ?? 0 }))
    .filter((it) => it._p != null);
  if (!priced.length) return { buckets: [], unpriced: items.length };

  const min = Math.min(...priced.map((x) => x._p));
  const max = Math.max(...priced.map((x) => x._p));
  if (min === max) {
    return {
      buckets: [{
        range: `${min.toFixed(2)}`,
        itemCount: priced.length,
        monthlyTotal: priced.reduce((s, x) => s + x._m, 0),
        sampleTitles: priced.slice(0, 3).map((x) => x.title),
      }],
      unpriced: items.length - priced.length,
    };
  }

  const step = (max - min) / 5;
  const buckets = [];
  for (let i = 0; i < 5; i++) {
    const lo = min + step * i;
    const hi = i === 4 ? max + 0.01 : min + step * (i + 1);
    const inBucket = priced.filter((x) => x._p >= lo && x._p < hi);
    buckets.push({
      range: `${lo.toFixed(2)} ~ ${hi.toFixed(2)}`,
      itemCount: inBucket.length,
      monthlyTotal: inBucket.reduce((s, x) => s + x._m, 0),
      avgRating: inBucket.length
        ? (inBucket.reduce((s, x) => s + (toNum(x.ratingStar) ?? 0), 0) / inBucket.length).toFixed(2)
        : '',
      sampleTitles: inBucket
        .sort((a, b) => b._m - a._m)
        .slice(0, 3)
        .map((x) => x.title),
    });
  }
  return { buckets, unpriced: items.length - priced.length };
}

function topSellers(items, n = 10) {
  return items
    .map((it) => ({ ...it, _m: toNum(it.monthlySold) ?? 0, _p: parsePrice(it.price) }))
    .sort((a, b) => b._m - a._m)
    .slice(0, n)
    .map((it) => ({
      title: it.title,
      monthlySold: it._m,
      price: it._p != null ? it._p.toFixed(2) : (it.price || ''),
      ratingStar: it.ratingStar || '',
      ratingCount: it.ratingCount || '',
      url: it.url,
    }));
}

function ratingDistribution(items) {
  let total = 0;
  let weighted = 0;
  let count = 0;
  for (const it of items) {
    const r = toNum(it.ratingStar);
    const c = toNum(it.ratingCount) ?? 0;
    if (r != null) {
      weighted += r * c;
      total += c;
      count++;
    }
  }
  return {
    商品数: count,
    评论总数: total,
    加权平均评分: total > 0 ? (weighted / total).toFixed(2) : '',
  };
}

// SKU 名通常是 "颜色 / 尺寸"，按 ' / ' 拆开各算频次
function skuVariantFreq(skus, topN = 15) {
  const freq = new Map();
  for (const s of skus) {
    if (!s.skuName) continue;
    const parts = s.skuName.split(/\s*\/\s*/).map((x) => x.trim()).filter(Boolean);
    for (const p of parts) {
      freq.set(p, (freq.get(p) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([variant, count]) => ({ variant, count }));
}

// 店铺集中度：Top3/Top10 占总月销 %，识别"寡头 / 碎片化 / 单店统治"格局
function shopConcentration(items) {
  const map = new Map();
  let totalSold = 0;
  let totalItems = 0;
  for (const it of items) {
    const shop = (it.shopName || '').trim();
    if (!shop) continue;
    const sold = toNum(it.monthlySold) ?? 0;
    const cur = map.get(shop) || { shop, monthlyTotal: 0, itemCount: 0 };
    cur.monthlyTotal += sold;
    cur.itemCount += 1;
    map.set(shop, cur);
    totalSold += sold;
    totalItems += 1;
  }
  const ranked = [...map.values()].sort((a, b) => b.monthlyTotal - a.monthlyTotal);
  const pct = (n) => (totalSold > 0 ? ((n / totalSold) * 100).toFixed(1) + '%' : 'N/A');
  const sumTop = (k) => ranked.slice(0, k).reduce((s, x) => s + x.monthlyTotal, 0);

  let pattern = '数据不足';
  const top1Pct = totalSold > 0 ? sumTop(1) / totalSold : 0;
  const top3Pct = totalSold > 0 ? sumTop(3) / totalSold : 0;
  const top10Pct = totalSold > 0 ? sumTop(10) / totalSold : 0;
  if (ranked.length >= 3) {
    if (top1Pct >= 0.4) pattern = '单店统治（Top1 ≥40%）— 警惕品牌护城河 / 平台扶持';
    else if (top3Pct >= 0.7) pattern = '寡头垄断（Top3 ≥70%）— 新进入需强差异化或打价格战';
    else if (top10Pct <= 0.3) pattern = '碎片化（Top10 ≤30%）— 白牌 / 工厂货可切入';
    else pattern = '中度集中 — 有头部品牌但仍有切入空间';
  }
  return {
    totalShops: map.size,
    totalItems,
    top3Pct: pct(sumTop(3)),
    top10Pct: pct(sumTop(10)),
    pattern,
    topShops: ranked.slice(0, 10).map((x) => ({
      shop: x.shop,
      monthlyTotal: x.monthlyTotal,
      itemCount: x.itemCount,
      sharePct: pct(x.monthlyTotal),
    })),
  };
}

// 评论时间分布：近 30 天每日评论数 + 近 7d / 前 7d 比值
function commentTimeDistribution(ratings) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const buckets = new Map();
  // 初始化最近 30 天的桶（确保零样本日也出现）
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    buckets.set(key, 0);
  }

  let parsed = 0;
  for (const r of ratings) {
    if (!r.ctime) continue;
    // ctime 格式为 "YYYY-MM-DD HH:mm"
    const m = String(r.ctime).match(/^(\d{4}-\d{2}-\d{2})/);
    if (!m) continue;
    const key = m[1];
    if (buckets.has(key)) {
      buckets.set(key, buckets.get(key) + 1);
      parsed++;
    }
  }

  const series = [...buckets.entries()].map(([date, count]) => ({ date, count }));
  const last7 = series.slice(-7).reduce((s, x) => s + x.count, 0);
  const prev7 = series.slice(-14, -7).reduce((s, x) => s + x.count, 0);
  let trend = '样本不足';
  let growthPct = '';
  if (prev7 > 0) {
    const r = last7 / prev7;
    growthPct = `${((r - 1) * 100).toFixed(0)}%`;
    if (r >= 1.5) trend = '加速增长（近 7d 是前 7d 的 1.5×+，热度上升）';
    else if (r >= 1.1) trend = '稳步增长';
    else if (r >= 0.9) trend = '平稳';
    else if (r >= 0.5) trend = '降温';
    else trend = '快速降温（近 7d 不及前 7d 一半，警惕过气）';
  } else if (last7 > 0) {
    trend = '近期才有评论，无历史可比';
  }

  return {
    series,
    parsedCount: parsed,
    last7Days: last7,
    prev7Days: prev7,
    growthPct,
    trend,
  };
}

// 商品标题 N-gram：清洗后切词，2-gram + 3-gram 频次 Top20
// 不做语言分词（中/英/泰混合处理不来），按空格 + 标点切，对中/英标题够用
function titleNgrams(items, n = 2, topN = 20) {
  const STOP = new Set([
    'and', 'or', 'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'with',
    'free', 'new', 'hot', 'sale', 'shopee', '商品', '正品', '包邮',
  ]);
  const freq = new Map();
  for (const it of items) {
    const t = (it.title || '').toLowerCase();
    if (!t) continue;
    // 切词：保留泰文/中文/英文/数字片段
    const tokens = t
      .split(/[\s\-_/|()\[\]{},.;:!?'"，。；：！？""''（）【】、]+/)
      .map((x) => x.trim())
      .filter((x) => x.length >= 2 && !STOP.has(x));
    if (tokens.length < n) continue;
    for (let i = 0; i <= tokens.length - n; i++) {
      const gram = tokens.slice(i, i + n).join(' ');
      freq.set(gram, (freq.get(gram) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([phrase, count]) => ({ phrase, count }));
}

// 评论分桶 + 截断，控制喂给模型的体积
function pickReviewsForLLM(ratings, perBucket = 60) {
  const good = [];
  const bad = [];
  for (const r of ratings) {
    const star = toNum(r.ratingStar);
    if (star == null || !r.comment || r.comment.length < 4) continue;
    const c = r.comment.slice(0, 200);
    if (star >= 4) good.push(c);
    else if (star <= 3) bad.push(c);
  }
  // 长评论更可能含真实信息，按长度倒排取前 N
  const pick = (arr) => arr.sort((a, b) => b.length - a.length).slice(0, perBucket);
  return { good: pick(good), bad: pick(bad) };
}

// ============ 纯 JS 评论高频主题聚类（不依赖 LLM）============
// 思路：在每条评论上抽"特征短语"（中/泰用字符 4-gram，英用词 2-gram），
// 按 DF（多少条评论提到）排序，贪心地把含同一短语的评论归到一类。
// 一条评论可能含多个高频短语 → 归到 DF 最高的那一类。

const REVIEW_STOP_PHRASES = new Set([
  // 通用废词
  '商品', '产品', '宝贝', '购买', '购物', '收到', '看看', '一下', '所有',
  'product', 'item', 'order', 'received', 'delivery',
  // 泰文常见高频虚词（沿用空白/标点跨界后剩下的小字符串）
  'มาก', 'ครับ', 'ค่ะ', 'แล้ว', 'จะ', 'ของ', 'ให้',
]);

function isMostlyAscii(s) {
  let ascii = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 128) ascii++;
  return ascii / s.length > 0.6;
}

function normalizeForFeature(s) {
  return String(s)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\d]+/g, ' ')
    .trim();
}

function extractFeatures(comment) {
  const norm = normalizeForFeature(comment);
  const feats = new Set();
  if (!norm) return feats;

  if (isMostlyAscii(norm)) {
    // 英文为主：词级 2-gram
    const tokens = norm
      .split(/[\s\-_/|()\[\]{},.;:!?'"，。；：！？""''（）【】、]+/)
      .filter((t) => t.length >= 3 && !REVIEW_STOP_PHRASES.has(t));
    for (let i = 0; i < tokens.length - 1; i++) {
      feats.add(`${tokens[i]} ${tokens[i + 1]}`);
    }
  } else {
    // 中/泰为主：字符 4-gram，跳过含空格/标点的窗口
    const cleaned = norm.replace(/[\s\-_/|()\[\]{},.;:!?'"，。；：！？""''（）【】、]+/g, ' ');
    for (let i = 0; i <= cleaned.length - 4; i++) {
      const gram = cleaned.slice(i, i + 4);
      if (/\s/.test(gram)) continue;
      if (!/[฀-๿一-鿿]/.test(gram)) continue; // 必含泰/中字符
      if (REVIEW_STOP_PHRASES.has(gram)) continue;
      feats.add(gram);
    }
  }
  return feats;
}

// 按 DF 贪心聚类，输出 Top N 主题。每个主题给频次 + 代表原文（短的优先，更易读）。
function clusterReviewsByPhrase(comments, topN = 5) {
  if (!comments.length) return [];

  const docFeatures = comments.map((c) => extractFeatures(c));
  const df = new Map();
  for (const feats of docFeatures) {
    for (const f of feats) df.set(f, (df.get(f) || 0) + 1);
  }

  const minDF = Math.max(2, Math.ceil(comments.length * 0.05));
  const candidates = [...df.entries()]
    .filter(([, n]) => n >= minDF)
    .sort((a, b) => b[1] - a[1]);

  const used = new Array(comments.length).fill(false);
  const themes = [];

  for (const [phrase] of candidates) {
    if (themes.length >= topN) break;
    const memberIdx = [];
    for (let i = 0; i < comments.length; i++) {
      if (used[i]) continue;
      if (docFeatures[i].has(phrase)) memberIdx.push(i);
    }
    if (memberIdx.length < minDF) continue;

    const quotes = memberIdx
      .map((i) => comments[i])
      .sort((a, b) => a.length - b.length)
      .slice(0, 3);

    themes.push({
      phrase,
      frequency: memberIdx.length,
      quotes,
    });
    for (const i of memberIdx) used[i] = true;
  }

  return themes;
}

function pureJsReviewClusters(ratings) {
  const good = [];
  const bad = [];
  for (const r of ratings) {
    const star = toNum(r.ratingStar);
    if (star == null || !r.comment) continue;
    const c = String(r.comment).trim();
    if (c.length < 4) continue;
    if (star >= 4) good.push(c);
    else if (star <= 3) bad.push(c);
  }
  return {
    goodTotal: good.length,
    badTotal: bad.length,
    goodThemes: clusterReviewsByPhrase(good, 5),
    badThemes: clusterReviewsByPhrase(bad, 5),
  };
}

// ============ 国家/货币识别 ============
// 从商品 URL 的 host 推 Shopee 站点 → 国家中文名 + 货币代码 + 货币中文名 + 符号
const MARKETS = {
  'shopee.co.th':  { country: '泰国',     currency: 'THB', currencyCN: '泰铢',     symbol: '฿' },
  'shopee.sg':     { country: '新加坡',   currency: 'SGD', currencyCN: '新加坡元', symbol: 'S$' },
  'shopee.com.my': { country: '马来西亚', currency: 'MYR', currencyCN: '马币',     symbol: 'RM' },
  'shopee.vn':     { country: '越南',     currency: 'VND', currencyCN: '越南盾',   symbol: '₫' },
  'shopee.ph':     { country: '菲律宾',   currency: 'PHP', currencyCN: '菲律宾比索', symbol: '₱' },
  'shopee.co.id':  { country: '印尼',     currency: 'IDR', currencyCN: '印尼盾',   symbol: 'Rp' },
  'shopee.com.br': { country: '巴西',     currency: 'BRL', currencyCN: '雷亚尔',   symbol: 'R$' },
  'shopee.tw':     { country: '台湾',     currency: 'TWD', currencyCN: '新台币',   symbol: 'NT$' },
};

function detectMarket(items) {
  const counts = new Map();
  for (const it of items) {
    if (!it.url) continue;
    try {
      const host = new URL(it.url).host.toLowerCase().replace(/^www\./, '');
      if (MARKETS[host]) counts.set(host, (counts.get(host) || 0) + 1);
    } catch (e) {}
  }
  if (!counts.size) {
    return { host: '', ...MARKETS['shopee.co.th'], detected: false };
  }
  const [topHost] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return { host: topHost, ...MARKETS[topHost], detected: true };
}

async function llmThemesAndAdvice({ keyword, market, topSellers, priceBuckets, ratingSummary, skuFreq, shopConc, commentTrend, titlePhrases, reviews }) {
  await ensureProxyDispatcher();

  const prompt = `你是跨境电商 Shopee 选品分析师。基于以下 ${market.country} Shopee "${keyword || '未指定关键词'}" 类目的真实采集数据，输出一份给新品开发团队看的中文调研报告。

# 重要：货币 / 站点说明
- 本次数据采自 **${market.country}** 站点（${market.host || 'shopee.' + market.currency.toLowerCase()}）
- 所有价格、月销金额的货币单位均为 **${market.currencyCN}（${market.currency}，符号 ${market.symbol}）**
- 输出报告中如需提及金额，**必须使用 ${market.currencyCN}（${market.currency}）**，不要换算成人民币，也不要误用其他国家货币

# 一、销量结构（已统计，价格单位 ${market.currency}）
价格分布：
${priceBuckets.map((b, i) => `  价格段${i + 1} ${b.range}：${b.itemCount} 个商品，月销合计 ${b.monthlyTotal}，平均评分 ${b.avgRating || 'N/A'}`).join('\n')}

Top10 月销商品：
${topSellers.map((t, i) => `  ${i + 1}. ${t.title}｜价 ${t.price}｜月销 ${t.monthlySold}｜评分 ${t.ratingStar}（${t.ratingCount} 评）`).join('\n')}

整体评分：${JSON.stringify(ratingSummary)}

热门 SKU 变体（颜色/规格出现次数）：
${skuFreq.slice(0, 10).map((s) => `  ${s.variant}：${s.count} 次`).join('\n')}

店铺集中度：${shopConc.pattern}（共 ${shopConc.totalShops} 店，Top3 占 ${shopConc.top3Pct}，Top10 占 ${shopConc.top10Pct}）
头部店铺：
${shopConc.topShops.slice(0, 5).map((s) => `  ${s.shop}：月销 ${s.monthlyTotal}（${s.sharePct}），${s.itemCount} 个 SKU`).join('\n')}

近 30 天评论热度：${commentTrend.trend}（近 7d ${commentTrend.last7Days} 条 vs 前 7d ${commentTrend.prev7Days} 条，环比 ${commentTrend.growthPct || 'N/A'}）

商品标题高频短语 Top10（卖家在标题里堆什么词 = 平台搜索流量入口）：
${titlePhrases.slice(0, 10).map((p) => `  "${p.phrase}"：${p.count} 次`).join('\n')}

# 二、评论原文（4-5 星好评 ${reviews.good.length} 条 + 1-3 星差评 ${reviews.bad.length} 条）

【好评】
${reviews.good.map((c, i) => `${i + 1}. ${c}`).join('\n')}

【差评】
${reviews.bad.map((c, i) => `${i + 1}. ${c}`).join('\n')}

# 三、输出要求

返回严格 JSON，结构如下（字段名必须完全一致，不要加 markdown 围栏）：

{
  "marketSummary": "200 字内总结：客单价主要集中在哪段（用 ${market.currencyCN} ${market.symbol}）、月销集中度、评分整体水平、品类成熟度判断",
  "priceInsight": "100 字内：哪个价格段是甜蜜带（量大且评分稳），哪个价格段是高风险/高利润。金额一律用 ${market.currencyCN}",
  "competitionInsight": "100 字内：结合店铺集中度和搜索词热度，判断新进入难度，给一句话定位（如：碎片化 + 热度上升 = 蓝海窗口期）",
  "topPraise": [
    {"theme": "主题（如：性价比高）", "frequency": 出现条数估算, "quotes": ["1-2 句代表原文（保留原语种）"]}
  ],
  "topComplaint": [
    {"theme": "主题（如：尺寸偏小）", "frequency": 出现条数估算, "quotes": ["1-2 句代表原文"]}
  ],
  "skuPreference": "100 字内：客户偏好的颜色/规格组合，是否有未被满足的变体",
  "trafficKeywords": "100 字内：从标题高频短语看，哪些词是必抢流量入口，哪些是可避开的红海词",
  "newProductOpportunities": [
    {"angle": "改进角度（产品/包装/卖点/价格）", "rationale": "依据哪条差评或哪个空白", "expectedImpact": "预计能击中的需求"}
  ],
  "risks": ["新进入此品类要注意的 2-3 个风险点"]
}

要求：
- topPraise / topComplaint 各给 6-10 条，按 frequency 降序
- newProductOpportunities 给 4-6 条，越具体越好（不要"提升质量"这种空话）
- 所有结论必须可在上面提供的数据里找到依据
- 引用原文不要翻译，保留泰文/英文/中文原貌`;

  const callWithTimeout = async (ms) => {
    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`Gemini 调用超时（${ms}ms）`)), ms);
    });
    try {
      return await Promise.race([
        ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: [{ text: prompt }],
        }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  let response;
  try {
    response = await callWithTimeout(60_000);
  } catch (e) {
    // fetch failed 时 cause 通常带有更具体原因（ECONNREFUSED/ENOTFOUND/CERT 等）
    const cause = e?.cause;
    const causeStr = cause ? ` | cause: ${cause.code || cause.message || String(cause)}` : '';
    const msg = e?.message || String(e);
    let hint = '';
    if (/fetch failed|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN/i.test(msg + causeStr)) {
      hint = '（网络层失败：国内访问 Gemini 必须走代理。请在 server/.env 加 HTTPS_PROXY=http://127.0.0.1:7890 或对应代理端口；如已设置，确认代理已启动且监听该端口。）';
    } else if (/API key|PERMISSION|UNAUTHENTICATED|401|403/i.test(msg)) {
      hint = '（鉴权失败：检查 GEMINI_API_KEY 是否正确、是否开通对应模型）';
    } else if (/quota|RESOURCE_EXHAUSTED|429/i.test(msg)) {
      hint = '（配额用尽：Gemini 免费额度被打满）';
    }
    throw new Error(`${msg}${causeStr}${hint}`);
  }

  const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : text.trim();
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    return { _raw: text, _parseError: e.message };
  }
}

// ============ 竞品视觉拆解（多模态，opt-in）============
// 拉竞品主图/详情图 → 喂 Gemini 2.5 Flash 一次看完一个竞品的图，输出结构化卖点拆解。
// 成本敏感：只取月销 Top N，每个竞品 ≤6 张图，并发受限。

async function fetchImageAsBase64(url, timeoutMs = 15000) {
  let timer;
  const ac = new AbortController();
  timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//i.test(ct)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 6 * 1024 * 1024) return null; // 跳过空图/超 6MB
    return { mimeType: ct.split(';')[0], data: buf.toString('base64') };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 一个竞品：按 has_long_image 分流取图（有长图=主3+长图前2末1；没长图=主3 + 喂文字详情）
function pickVisualSources(it) {
  const mains = (Array.isArray(it.mainImages) ? it.mainImages : []).slice(0, 3);
  const longs = Array.isArray(it.longImages) ? it.longImages : [];
  let detailImgs = [];
  if (it.hasLongImage && longs.length) {
    if (longs.length <= 3) detailImgs = longs.slice();
    else detailImgs = [longs[0], longs[1], longs[longs.length - 1]]; // 前2末1
  }
  return { mains, detailImgs, descText: it.hasLongImage ? '' : (it.descText || '') };
}

async function analyzeOneCompetitor(it, market) {
  const { mains, detailImgs, descText } = pickVisualSources(it);
  const urls = [...mains, ...detailImgs];
  if (!urls.length) return null;

  const imgs = (await Promise.all(urls.map((u) => fetchImageAsBase64(u)))).filter(Boolean);
  if (!imgs.length) return { itemid: it.itemid, title: it.title, error: '图片全部拉取失败' };

  const labelLines = [];
  let idx = 0;
  for (let i = 0; i < mains.length && idx < imgs.length; i++, idx++) labelLines.push(`图${idx + 1}=主图${i + 1}`);
  for (let i = 0; i < detailImgs.length && idx < imgs.length; i++, idx++) labelLines.push(`图${idx + 1}=详情长图`);

  const prompt = `你是跨境电商视觉营销分析师。下面是 ${market.country} Shopee 一个竞品"${it.title || ''}"（月销 ${it.monthlySold ?? '未知'}）的商品图片，按顺序：
${labelLines.join('；')}
${descText ? `\n该商品详情为纯文字（无长图），文字详情如下（截断）：\n${descText.slice(0, 1500)}` : ''}

请只基于图片（和提供的文字）拆解这个竞品的视觉打法，返回严格 JSON（不要 markdown 围栏，字段名完全一致）：
{
  "mainImageSellingPoints": "主图（轮播首图+前几张）打的核心卖点是什么：放了哪些利益点文案/参数/场景，第一张主图靠什么抓眼球",
  "sceneAndProps": "侧图/场景图呈现的使用场景、人物、道具、拍摄风格（如纯白底/场景实拍/模特佩戴）",
  "detailFocus": "详情部分（长图或文字）重点讲了什么：功能演示、参数对比、痛点解决、信任背书等",
  "visualStrengths": ["这个竞品视觉上做得好的 2-3 点（可借鉴）"],
  "visualGaps": ["视觉上的薄弱/空白点 1-2 点（我方可差异化突破）"]
}`;

  const parts = [{ text: prompt }, ...imgs.map((im) => ({ inlineData: { mimeType: im.mimeType, data: im.data } }))];

  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('Gemini 视觉调用超时')), 90_000); });
  let response;
  try {
    response = await Promise.race([
      ai.models.generateContent({ model: 'gemini-2.5-flash', contents: [{ role: 'user', parts }] }),
      timeout,
    ]);
  } catch (e) {
    return { itemid: it.itemid, title: it.title, imgCount: imgs.length, error: e.message };
  } finally {
    clearTimeout(timer);
  }

  const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = m ? m[1].trim() : text.trim();
  let parsed;
  try { parsed = JSON.parse(jsonStr); } catch (e) { parsed = { _raw: text.slice(0, 1500) }; }
  return { itemid: it.itemid, title: it.title, monthlySold: it.monthlySold, imgCount: imgs.length, ...parsed };
}

// 并发受限跑一批
async function analyzeCompetitorVisuals(items, market, { topN = 8, concurrency = 3 } = {}) {
  await ensureProxyDispatcher();
  // 只挑有主图、按月销排序的 Top N
  const withImg = items
    .filter((it) => Array.isArray(it.mainImages) && it.mainImages.length)
    .map((it) => ({ ...it, _m: toNum(it.monthlySold) ?? 0 }))
    .sort((a, b) => b._m - a._m)
    .slice(0, topN);
  if (!withImg.length) return { analyzed: [], note: '没有采到带主图的竞品（需在 Shopee 商品详情页停留让扩展抓到 product_images）' };

  const tasks = withImg.map((it) => () => analyzeOneCompetitor(it, market));
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const i = cursor++;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return { analyzed: results.filter(Boolean), sampledCount: withImg.length };
}

export async function generateResearchReport({ keyword, items, skus, ratings, analyzeVisuals = false }) {
  const market = detectMarket(items);
  const priceBucket = bucketByPrice(items);
  const top = topSellers(items, 10);
  const ratingSum = ratingDistribution(items);
  const skuFreq = skuVariantFreq(skus, 15);
  const shopConc = shopConcentration(items);
  const commentTrend = commentTimeDistribution(ratings);
  const titlePhrases2 = titleNgrams(items, 2, 20);
  const titlePhrases3 = titleNgrams(items, 3, 15);
  const picked = pickReviewsForLLM(ratings, 60);
  // 纯 JS 聚类必跑：LLM 失败时是主力，成功时是数据校验
  const reviewClusters = pureJsReviewClusters(ratings);

  let llmReport = null;
  let llmError = null;
  if (picked.good.length + picked.bad.length >= 4) {
    try {
      llmReport = await llmThemesAndAdvice({
        keyword,
        market,
        topSellers: top,
        priceBuckets: priceBucket.buckets,
        ratingSummary: ratingSum,
        skuFreq,
        shopConc,
        commentTrend,
        titlePhrases: titlePhrases2,
        reviews: picked,
      });
    } catch (e) {
      llmError = e.message;
    }
  } else {
    llmError = `评论样本太少（好评 ${picked.good.length} + 差评 ${picked.bad.length}），跳过 LLM 主题聚类。继续浏览更多商品评论页可改善。`;
  }

  // 竞品视觉拆解：opt-in 才跑（多模态调用烧额度，只取月销 Top6）
  let visualAnalysis = null;
  let visualError = null;
  if (analyzeVisuals) {
    try {
      visualAnalysis = await analyzeCompetitorVisuals(items, market, { topN: 6, concurrency: 3 });
    } catch (e) {
      visualError = e.message;
    }
  }

  return {
    keyword: keyword || '',
    generatedAt: new Date().toISOString(),
    market,
    stats: {
      itemCount: items.length,
      skuCount: skus.length,
      ratingSampleCount: ratings.length,
      goodReviewSent: picked.good.length,
      badReviewSent: picked.bad.length,
    },
    priceBuckets: priceBucket.buckets,
    unpricedItemCount: priceBucket.unpriced,
    topSellers: top,
    ratingSummary: ratingSum,
    skuVariantFrequency: skuFreq,
    shopConcentration: shopConc,
    commentTrend,
    titlePhrases2,
    titlePhrases3,
    reviewClusters,
    llmReport,
    llmError,
    visualAnalysis,
    visualError,
  };
}
