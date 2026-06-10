import { Router } from 'express';
import ExcelJS from 'exceljs';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { generateResearchReport } from '../services/research-analyzer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXPORTS_DIR = path.join(__dirname, '..', 'exports');

if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });

const router = Router();

// 健康检查走 auth 之前，永远公开 — popup 测试连接需要先确认 server 在线
// 同时回报 token 是否有效，让"测试连接"能区分 server 在线 vs token 正确
router.get('/health', (req, res) => {
  const expected = process.env.AUTH_TOKEN;
  const got = req.header('X-Auth-Token') || req.query.token;
  let tokenValid = null;
  if (expected) tokenValid = !!got && got === expected;
  res.json({
    ok: true,
    version: '0.2',
    authRequired: !!expected,
    tokenValid,
    geminiConfigured: !!process.env.GEMINI_API_KEY,
    timestamp: new Date().toISOString(),
  });
});

// Token 鉴权中间件：环境变量 AUTH_TOKEN 没设 → 跳过（本机方便）；
// 设了 → 请求必须带 X-Auth-Token 且匹配。同事远程访问时强烈建议在 server .env 里设。
router.use((req, res, next) => {
  const expected = process.env.AUTH_TOKEN;
  if (!expected) return next();
  const got = req.header('X-Auth-Token') || req.query.token;
  if (got === expected) return next();
  return res.status(401).json({ ok: false, error: 'Auth token missing or invalid' });
});

router.post('/export', async (req, res) => {
  try {
    const { items: rawItems = [], skus: rawSkus = [], ratings: rawRatings = [], keyword = '', filters = null, analyzeVisuals = false } = req.body || {};

    if (!rawItems.length && !rawSkus.length && !rawRatings.length) {
      return res.json({ ok: false, error: '没有采集到数据，先在站斧浏览器里浏览 Shopee 商品页' });
    }

    // OR 过滤：任一阈值达标就保留。三个阈值都为空 → 不过滤。
    // 字段缺失（空串/null/undefined）的商品对该维度算"未达标"，但仍可能因别的维度被保留。
    const f = filters || {};
    const hasMonthly = Number.isFinite(f.monthlySoldMin);
    const hasHistorical = Number.isFinite(f.historicalSoldMin);
    const hasRatingCnt = Number.isFinite(f.ratingCountMin);
    const filterActive = hasMonthly || hasHistorical || hasRatingCnt;

    const toNum = (v) => {
      if (v == null || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    let items = rawItems;
    let skus = rawSkus;
    let ratings = rawRatings;
    let filteredFromTotal = 0;

    if (filterActive) {
      filteredFromTotal = rawItems.length;
      const itemKeyOf = (it) => `${it.shopid}_${it.itemid}`;
      const allowed = new Set();
      items = rawItems.filter((it) => {
        const m = toNum(it.monthlySold);
        const h = toNum(it.historicalSold);
        const rc = toNum(it.ratingCount);
        const pass =
          (hasMonthly && m != null && m >= f.monthlySoldMin) ||
          (hasHistorical && h != null && h >= f.historicalSoldMin) ||
          (hasRatingCnt && rc != null && rc >= f.ratingCountMin);
        if (pass) allowed.add(itemKeyOf(it));
        return pass;
      });
      skus = rawSkus.filter((s) => allowed.has(s.itemKey));
      ratings = rawRatings.filter((r) => allowed.has(r.itemKey));
    }

    if (filterActive && !items.length) {
      return res.json({
        ok: false,
        error: `过滤后没有符合条件的商品（原始 ${filteredFromTotal} 个）。请放宽阈值再试。`,
      });
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Shopee Research Helper';
    wb.created = new Date();

    // Sheet 1 — 商品总览 (11 columns)
    const ws1 = wb.addWorksheet('商品总览');
    ws1.columns = [
      { header: '商品 ID', key: 'itemid', width: 16 },
      { header: '商品标题', key: 'title', width: 50 },
      { header: '商品 URL', key: 'url', width: 40 },
      { header: '当前价', key: 'price', width: 14 },
      { header: '历史销量', key: 'historicalSold', width: 12 },
      { header: '月销', key: 'monthlySold', width: 10 },
      { header: '评分', key: 'ratingStar', width: 8 },
      { header: '评价数', key: 'ratingCount', width: 10 },
      { header: '店铺名', key: 'shopName', width: 24 },
      { header: '抓取时间', key: 'capturedAt', width: 18 },
      { header: '来源（搜索词）', key: 'keyword', width: 18 },
    ];
    for (const it of items) {
      ws1.addRow({
        itemid: it.itemid,
        title: it.title || '',
        url: it.url || '',
        price: it.price || '',
        historicalSold: it.historicalSold ?? '',
        monthlySold: it.monthlySold ?? '',
        ratingStar: typeof it.ratingStar === 'number' ? it.ratingStar.toFixed(2) : (it.ratingStar || ''),
        ratingCount: it.ratingCount ?? '',
        shopName: it.shopName || '',
        capturedAt: it.capturedAt ? new Date(it.capturedAt).toLocaleString('zh-CN', { hour12: false }) : '',
        keyword: it.keyword || keyword || '',
      });
    }
    ws1.getRow(1).font = { bold: true };
    ws1.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFEE4D2D' },
    };
    ws1.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    // Sheet 2 — SKU 明细 (3 columns)
    const ws2 = wb.addWorksheet('SKU 明细');
    ws2.columns = [
      { header: '商品 ID', key: 'itemid', width: 16 },
      { header: 'SKU 名称', key: 'skuName', width: 40 },
      { header: 'SKU 当前价', key: 'skuPrice', width: 14 },
    ];
    for (const s of skus) {
      // itemKey is `${shopid}_${itemid}` — split to get itemid
      const itemid = s.itemKey ? s.itemKey.split('_').pop() : '';
      ws2.addRow({
        itemid,
        skuName: s.skuName || '',
        skuPrice: s.skuPrice || '',
      });
    }
    ws2.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFEE4D2D' },
    };
    ws2.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    // Sheet 3 — 评论 (7 columns)
    const ws3 = wb.addWorksheet('评论');
    ws3.columns = [
      { header: '商品 ID', key: 'itemid', width: 16 },
      { header: '评论时间', key: 'ctime', width: 18 },
      { header: '星级', key: 'ratingStar', width: 8 },
      { header: '评论内容', key: 'comment', width: 60 },
      { header: '购买 SKU', key: 'skuLabel', width: 24 },
      { header: '评论图 URL', key: 'imageUrls', width: 40 },
      { header: '评论点赞数', key: 'likeCount', width: 12 },
    ];
    for (const r of ratings) {
      const itemid = r.itemKey ? r.itemKey.split('_').pop() : '';
      ws3.addRow({
        itemid,
        ctime: r.ctime || '',
        ratingStar: r.ratingStar ?? '',
        comment: r.comment || '',
        skuLabel: r.skuLabel || '',
        imageUrls: r.imageUrls || '',
        likeCount: r.likeCount ?? 0,
      });
    }
    ws3.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFEE4D2D' },
    };
    ws3.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws3.getColumn('comment').alignment = { wrapText: true, vertical: 'top' };

    // Sheet 4 — 竞品图片（主图可点击 URL + 详情长图 + 文字详情）
    const ws4img = wb.addWorksheet('竞品图片');
    ws4img.columns = [
      { header: '商品 ID', key: 'itemid', width: 16 },
      { header: '商品标题', key: 'title', width: 44 },
      { header: '月销', key: 'monthlySold', width: 8 },
      { header: '主图1', key: 'main1', width: 16 },
      { header: '主图2', key: 'main2', width: 16 },
      { header: '主图3', key: 'main3', width: 16 },
      { header: '有长图', key: 'hasLong', width: 8 },
      { header: '详情长图链接（| 分隔）', key: 'longImages', width: 40 },
      { header: '文字详情（截断）', key: 'descText', width: 60 },
    ];
    const linkCell = (url) => (url ? { text: '点击查看', hyperlink: url } : '');
    for (const it of items) {
      const mains = Array.isArray(it.mainImages) ? it.mainImages : [];
      const longs = Array.isArray(it.longImages) ? it.longImages : [];
      const row = ws4img.addRow({
        itemid: it.itemid,
        title: it.title || '',
        monthlySold: it.monthlySold ?? '',
        main1: linkCell(mains[0]),
        main2: linkCell(mains[1]),
        main3: linkCell(mains[2]),
        hasLong: it.hasLongImage ? '是' : '否',
        longImages: longs.join(' | '),
        descText: it.descText || '',
      });
      // 超链接单元格上蓝色下划线
      ['main1', 'main2', 'main3'].forEach((k) => {
        const c = row.getCell(k);
        if (c.value && typeof c.value === 'object') c.font = { color: { argb: 'FF0563C1' }, underline: true };
      });
    }
    ws4img.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEE4D2D' } };
    ws4img.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws4img.getColumn('descText').alignment = { wrapText: true, vertical: 'top' };

    // Sheet 5 — 调研报告（统计 + LLM 主题聚类）
    let reportError = null;
    try {
      const report = await generateResearchReport({ keyword, items, skus, ratings, analyzeVisuals });
      const ws4 = wb.addWorksheet('调研报告');
      ws4.columns = [
        { header: '维度', key: 'k', width: 22 },
        { header: '内容', key: 'v', width: 100 },
      ];
      ws4.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEE4D2D' } };
      ws4.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws4.getColumn('v').alignment = { wrapText: true, vertical: 'top' };

      const addSection = (title) => {
        const row = ws4.addRow({ k: title, v: '' });
        row.font = { bold: true };
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF5F0' } };
      };

      addSection('━━ 基本信息 ━━');
      ws4.addRow({ k: '搜索词', v: report.keyword || '（未填）' });
      ws4.addRow({ k: '生成时间', v: new Date(report.generatedAt).toLocaleString('zh-CN', { hour12: false }) });
      if (report.market) {
        const m = report.market;
        ws4.addRow({
          k: '采集站点 / 货币',
          v: `${m.country}（${m.host || '未识别'}）｜价格单位：${m.currencyCN} ${m.currency}（${m.symbol}）${m.detected ? '' : '｜⚠ 未从 URL 识别到，已默认按泰国处理，请检查商品 URL 列'}`,
        });
      }
      ws4.addRow({ k: '商品数 / SKU 数', v: `${report.stats.itemCount} / ${report.stats.skuCount}` });
      ws4.addRow({ k: '评论样本', v: `共 ${report.stats.ratingSampleCount} 条（送 LLM 分析：好评 ${report.stats.goodReviewSent} + 差评 ${report.stats.badReviewSent}）` });

      addSection('━━ 价格段分布（按月销） ━━');
      report.priceBuckets.forEach((b, i) => {
        ws4.addRow({
          k: `价格段 ${i + 1}：${b.range}`,
          v: `${b.itemCount} 个商品｜月销合计 ${b.monthlyTotal}｜均评分 ${b.avgRating || 'N/A'}\n代表商品：${(b.sampleTitles || []).slice(0, 3).join(' / ') || '—'}`,
        });
      });
      if (report.unpricedItemCount) {
        ws4.addRow({ k: '未识别价格', v: `${report.unpricedItemCount} 个商品` });
      }

      addSection('━━ Top10 月销商品 ━━');
      report.topSellers.forEach((t, i) => {
        ws4.addRow({
          k: `#${i + 1}（月销 ${t.monthlySold}）`,
          v: `${t.title}\n价 ${t.price}｜评分 ${t.ratingStar}（${t.ratingCount} 评）\n${t.url || ''}`,
        });
      });

      addSection('━━ 整体评分 ━━');
      Object.entries(report.ratingSummary).forEach(([k, v]) => {
        ws4.addRow({ k, v: String(v) });
      });

      addSection('━━ 热门 SKU 变体 ━━');
      report.skuVariantFrequency.slice(0, 15).forEach((s) => {
        ws4.addRow({ k: s.variant, v: `出现 ${s.count} 次` });
      });

      addSection('━━ 店铺集中度 ━━');
      ws4.addRow({ k: '市场格局', v: report.shopConcentration.pattern });
      ws4.addRow({
        k: '集中度指标',
        v: `共 ${report.shopConcentration.totalShops} 家店铺｜Top3 占 ${report.shopConcentration.top3Pct}｜Top10 占 ${report.shopConcentration.top10Pct}`,
      });
      report.shopConcentration.topShops.forEach((s, i) => {
        ws4.addRow({
          k: `头部店铺#${i + 1}：${s.shop}`,
          v: `月销合计 ${s.monthlyTotal}（占 ${s.sharePct}）｜${s.itemCount} 个 SKU`,
        });
      });

      addSection('━━ 近 30 天评论热度 ━━');
      ws4.addRow({ k: '趋势判断', v: report.commentTrend.trend });
      ws4.addRow({
        k: '环比数据',
        v: `近 7d：${report.commentTrend.last7Days} 条 vs 前 7d：${report.commentTrend.prev7Days} 条｜环比 ${report.commentTrend.growthPct || 'N/A'}（基于 ${report.commentTrend.parsedCount} 条带时间戳的评论）`,
      });
      // 30 天日序列以紧凑字符串呈现，避免 30 行刷屏
      const seriesStr = report.commentTrend.series
        .map((d) => `${d.date.slice(5)}=${d.count}`)
        .join(' | ');
      ws4.addRow({ k: '日评论数（30 天）', v: seriesStr });

      addSection('━━ 标题高频短语（流量入口） ━━');
      ws4.addRow({ k: '说明', v: '卖家在标题里堆什么词 = 平台搜索流量被哪些词吃了。频次 ≥2 才显示。' });
      report.titlePhrases2.slice(0, 20).forEach((p, i) => {
        ws4.addRow({ k: `2-gram#${i + 1}`, v: `"${p.phrase}"｜${p.count} 次` });
      });
      if (report.titlePhrases3.length) {
        report.titlePhrases3.slice(0, 10).forEach((p, i) => {
          ws4.addRow({ k: `3-gram#${i + 1}`, v: `"${p.phrase}"｜${p.count} 次` });
        });
      }

      // 纯 JS 评论聚类：永不依赖 LLM，必显示。给选品/产品开发当差评清单兜底。
      const rc = report.reviewClusters || { goodThemes: [], badThemes: [], goodTotal: 0, badTotal: 0 };
      addSection('━━ 评论高频主题（纯算法聚类，不依赖 LLM） ━━');
      ws4.addRow({
        k: '说明',
        v: `按"含相同短语的评论数"聚类，最少 5% 占比才成一类。好评样本 ${rc.goodTotal} 条 / 差评样本 ${rc.badTotal} 条。中/泰用字符 4-gram，英文用词级 2-gram。`,
      });
      if (rc.goodThemes.length) {
        ws4.addRow({ k: '好评 Top 主题', v: '' }).font = { bold: true };
        rc.goodThemes.forEach((t, i) => {
          ws4.addRow({
            k: `好评#${i + 1}：「${t.phrase}」（${t.frequency} 条）`,
            v: (t.quotes || []).map((q) => `· ${q}`).join('\n'),
          });
        });
      } else {
        ws4.addRow({ k: '好评 Top 主题', v: '样本不足或无明显高频短语' });
      }
      if (rc.badThemes.length) {
        ws4.addRow({ k: '差评 Top 主题', v: '' }).font = { bold: true };
        rc.badThemes.forEach((t, i) => {
          ws4.addRow({
            k: `差评#${i + 1}：「${t.phrase}」（${t.frequency} 条）`,
            v: (t.quotes || []).map((q) => `· ${q}`).join('\n'),
          });
        });
      } else {
        ws4.addRow({ k: '差评 Top 主题', v: '样本不足或无明显高频短语' });
      }

      if (report.llmReport && !report.llmReport._parseError) {
        const r = report.llmReport;
        addSection('━━ 市场总结 ━━');
        ws4.addRow({ k: '市场概况', v: r.marketSummary || '' });
        ws4.addRow({ k: '价格策略洞察', v: r.priceInsight || '' });
        ws4.addRow({ k: '竞争格局判断', v: r.competitionInsight || '' });
        ws4.addRow({ k: 'SKU 偏好', v: r.skuPreference || '' });
        ws4.addRow({ k: '流量关键词建议', v: r.trafficKeywords || '' });

        addSection('━━ 好评 Top 主题 ━━');
        (r.topPraise || []).forEach((p, i) => {
          ws4.addRow({
            k: `好评#${i + 1}：${p.theme}（约 ${p.frequency} 条）`,
            v: (p.quotes || []).map((q) => `· ${q}`).join('\n'),
          });
        });

        addSection('━━ 差评 Top 主题 ━━');
        (r.topComplaint || []).forEach((c, i) => {
          ws4.addRow({
            k: `差评#${i + 1}：${c.theme}（约 ${c.frequency} 条）`,
            v: (c.quotes || []).map((q) => `· ${q}`).join('\n'),
          });
        });

        addSection('━━ 新品开发机会 ━━');
        (r.newProductOpportunities || []).forEach((o, i) => {
          ws4.addRow({
            k: `机会#${i + 1}：${o.angle}`,
            v: `依据：${o.rationale || ''}\n预期：${o.expectedImpact || ''}`,
          });
        });

        addSection('━━ 入场风险 ━━');
        (r.risks || []).forEach((rk, i) => {
          ws4.addRow({ k: `风险 ${i + 1}`, v: rk });
        });
      } else if (report.llmError) {
        addSection('━━ LLM 分析未生成 ━━');
        ws4.addRow({ k: '原因', v: report.llmError });
      } else if (report.llmReport?._parseError) {
        addSection('━━ LLM 输出解析失败 ━━');
        ws4.addRow({ k: '原始输出（截断）', v: (report.llmReport._raw || '').slice(0, 4000) });
      }

      // Sheet 6 — 竞品视觉卖点拆解（仅当 analyzeVisuals 开启时生成）
      if (analyzeVisuals) {
        const ws6 = wb.addWorksheet('竞品视觉卖点拆解');
        ws6.columns = [
          { header: '维度', key: 'k', width: 22 },
          { header: '内容', key: 'v', width: 100 },
        ];
        ws6.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEE4D2D' } };
        ws6.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        ws6.getColumn('v').alignment = { wrapText: true, vertical: 'top' };
        const addSec6 = (title) => {
          const row = ws6.addRow({ k: title, v: '' });
          row.font = { bold: true };
          row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF5F0' } };
        };
        const va = report.visualAnalysis;
        if (report.visualError) {
          addSec6('━━ 视觉拆解失败 ━━');
          ws6.addRow({ k: '原因', v: report.visualError });
        } else if (!va || !va.analyzed?.length) {
          addSec6('━━ 未生成视觉拆解 ━━');
          ws6.addRow({ k: '说明', v: va?.note || '没有采到带主图的竞品。需在 Shopee 商品详情页停留，让扩展抓到 product_images 后再导出。' });
        } else {
          ws6.addRow({ k: '说明', v: `按月销取 Top${va.sampledCount} 竞品，喂 Gemini 2.5 Flash 多模态分析主图+详情图。每个竞品 ≤6 张图。${va.note ? '\n⚠ ' + va.note : ''}` }).font = { italic: true };
          va.analyzed.forEach((c, i) => {
            addSec6(`━━ 竞品#${i + 1}：${c.title || c.itemid}（月销 ${c.monthlySold ?? '?'}｜${c.imgCount ?? 0} 图） ━━`);
            if (c.error) {
              ws6.addRow({ k: '分析失败', v: c.error });
              return;
            }
            if (c._raw) {
              ws6.addRow({ k: '原始输出（解析失败）', v: c._raw });
              return;
            }
            ws6.addRow({ k: '主图卖点', v: c.mainImageSellingPoints || '' });
            ws6.addRow({ k: '场景/道具', v: c.sceneAndProps || '' });
            ws6.addRow({ k: '详情重点', v: c.detailFocus || '' });
            ws6.addRow({ k: '视觉亮点（可借鉴）', v: (c.visualStrengths || []).map((x) => `· ${x}`).join('\n') });
            ws6.addRow({ k: '视觉空白（可差异化）', v: (c.visualGaps || []).map((x) => `· ${x}`).join('\n') });
          });
        }
      }
    } catch (e) {
      console.error('Research report generation error:', e);
      reportError = e.message;
      const ws4 = wb.addWorksheet('调研报告');
      ws4.addRow(['报告生成失败', e.message]);
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeKw = (keyword || 'shopee').replace(/[^\w一-龥-]+/g, '_').slice(0, 30);
    const filterTag = filterActive ? '_filtered' : '';
    const filename = `shopee-research_${safeKw}${filterTag}_${stamp}_${uuidv4().slice(0, 6)}.xlsx`;
    const filePath = path.join(EXPORTS_DIR, filename);
    await wb.xlsx.writeFile(filePath);

    // 同时返回 base64 + 下载 URL：
    // - base64：扩展端 decode 成 Blob 直接下载（站斧白名单拦截绕开）
    // - url：本机/不受拦截环境下兜底 + 服务器留档备查
    const fileBuf = await fs.promises.readFile(filePath);
    const fileBase64 = fileBuf.toString('base64');

    const proto = req.header('x-forwarded-proto') || req.protocol || 'http';
    const host = req.header('x-forwarded-host') || req.header('host') || `127.0.0.1:${process.env.PORT || 3001}`;
    const downloadUrl = `${proto}://${host}/exports/${filename}`;
    res.json({
      ok: true,
      url: downloadUrl,
      filename,
      fileBase64,
      itemCount: items.length,
      skuCount: skus.length,
      ratingCount: ratings.length,
      filteredFromTotal: filterActive ? filteredFromTotal : 0,
      reportError,
    });
  } catch (err) {
    console.error('Research export error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
