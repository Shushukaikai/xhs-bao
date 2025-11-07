// api/eightk.js
// 拉取 SEC 8-K/8-K-A（近 N 天），抽取条款(Item)要点，返回中文摘要与原文链接
// 需在 Vercel 项目里设置环境变量：UA_EMAIL=你的邮箱（用于 SEC User-Agent 合规）

const SEC_HEADERS = {
  "User-Agent": process.env.UA_EMAIL || "contact@example.com",
  "Accept": "text/html,application/json"
};
const TICKER_MAP_URL = "https://www.sec.gov/files/company_tickers.json";

async function fetchTickerMap() {
  const res = await fetch(TICKER_MAP_URL, { headers: SEC_HEADERS });
  if (!res.ok) throw new Error("Failed to load ticker map from SEC");
  const raw = await res.json();
  const map = {};
  for (const k of Object.keys(raw)) {
    const t = raw[k];
    if (t.ticker) map[t.ticker.toUpperCase()] = String(t.cik_str).padStart(10, "0");
  }
  return map;
}

async function fetchSubmissions(cik) {
  const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
  const res = await fetch(url, { headers: SEC_HEADERS });
  if (!res.ok) throw new Error(`Failed to load submissions for CIK ${cik}`);
  return await res.json();
}

function filterRecent8K(sub, days = 1) {
  const recent = sub?.filings?.recent;
  if (!recent) return [];
  const now = Date.now();
  const cutoff = now - days * 24 * 3600 * 1000;
  const out = [];
  const n = recent.form?.length || 0;
  for (let i = 0; i < n; i++) {
    const form = String(recent.form[i] || "");
    if (!form.toUpperCase().startsWith("8-K")) continue;
    const filingDate = recent.filingDate[i];
    const t = Date.parse(filingDate + "T00:00:00Z");
    if (isNaN(t) || t < cutoff) continue;

    const accession = (recent.accessionNumber[i] || "").replace(/-/g, "");
    const primary = recent.primaryDocument[i];
    if (!accession || !primary) continue;

    const docUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(sub.cik, 10)}/${accession}/${primary}`;
    out.push({
      form,
      filingDate,
      reportDate: recent.reportDate?.[i] || "",
      docUrl
    });
  }
  return out;
}

// —— 把 HTML 转纯文本，便于正则提取 ——
function htmlToText(html) {
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "")
             .replace(/<style[\s\S]*?<\/style>/gi, "");
  html = html.replace(/<br\s*\/?>/gi, "\n")
             .replace(/<\/p>/gi, "\n")
             .replace(/<\/div>/gi, "\n")
             .replace(/<\/li>/gi, "\n");
  const text = html.replace(/<[^>]+>/g, "");
  return text.replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// —— 抽取条款：匹配 “Item 2.02 …” 这种标题，并截取后文片段 ——
const ITEM_REGEX = /item\s+(\d+(?:\.\d+)?)[\s:\-–—]*([^\n]{0,120})/gi;

function itemLabel(code) {
  const m = String(code);
  if (m.startsWith("2.02")) return "经营业绩/财务信息";
  if (m.startsWith("2.03")) return "重大负债/融资安排";
  if (m.startsWith("2.05")) return "减值与重组";
  if (m.startsWith("5.02")) return "关键高管/董事变动";
  if (m.startsWith("5.07")) return "股东大会/投票结果";
  if (m.startsWith("8.01")) return "其他重大事项";
  if (m.startsWith("1")) return "注册/报告事项";
  if (m.startsWith("3")) return "证券与市场";
  if (m.startsWith("4")) return "会计与财务";
  if (m.startsWith("5")) return "治理与其他";
  if (m.startsWith("7.01")) return "Reg FD 披露";
  if (m.startsWith("9.01")) return "财务报表/附件";
  return "其他条款";
}

function extractItems(text) {
  const found = [];
  const seen = new Set();
  let m;
  while ((m = ITEM_REGEX.exec(text)) !== null) {
    const code = (m[1] || "").trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const titleGuess = (m[2] || "").trim();
    const start = Math.max(0, m.index);
    const snippet = text.slice(start, start + 800).split("\n").slice(0, 8).join("\n").trim();
    found.push({ code, titleGuess, label: itemLabel(code), snippet });
  }
  return found;
}

function makeCnSummary(symbol, filing, days) {
  const items = filing.items.map(it =>
    `• Item ${it.code}（${it.label}）：${(it.titleGuess && it.titleGuess.replace(/\s+/g, " ")) || it.snippet.slice(0, 60)}…`
  ).join("\n");

  const tags = ["#美股观察","#SEC8K","#重大事项","#投研速递","#公司公告解析"];
  const title = `【${symbol}】8-K 重大事项速览（${filing.filingDate}）`;
  const body =
`${title}

官方 8-K 披露（近 ${days} 天）要点：
${items || "• 本次 8-K 未识别到典型条款标题，建议点原文查看全文。"}

解读建议：
1) 优先关注 2.02（业绩）、2.03（融资/债务）、5.02（管理层变动）、5.07（投票结果）、8.01（其他重大事项）。
2) 与 10-Q/10-K/Investor Presentation 交叉验证，避免只看摘要。
3) 这不是投资建议，信息以 SEC 原文为准。

原文：${filing.docUrl}

${tags.join(" ")}`;
  return { title, body };
}

// —— HTTP 入口 ——
// 支持 ?symbol=TSLA 或 ?symbol=AAPL,TSLA,NVDA ；?days=1~30
export default async function handler(req, res) {
  try {
    const symbolsRaw = String(req.query.symbol || "AAPL").toUpperCase();
    const days = Math.min(30, Math.max(1, parseInt(req.query.days || "1", 10)));
    const symbols = symbolsRaw.split(",").map(s => s.trim()).filter(Boolean);

    const map = await fetchTickerMap();

    const results = [];
    for (const sym of symbols) {
      const cik = map[sym];
      if (!cik) {
        results.push({ ok: false, symbol: sym, error: `找不到 ${sym} 的 CIK` });
        continue;
      }
      const sub = await fetchSubmissions(cik);
      const filings = filterRecent8K(sub, days);

      const enriched = [];
      for (const f of filings) {
        try {
          const r = await fetch(f.docUrl, { headers: SEC_HEADERS });
          if (!r.ok) continue;
          const html = await r.text();
          const text = htmlToText(html);
          const items = extractItems(text);
          const summary = makeCnSummary(sym, { ...f, items }, days);
          enriched.push({
            ...f,
            items,
            summary
          });
        } catch (e) {
          // 单条失败忽略
        }
      }

      results.push({
        ok: true,
        symbol: sym,
        cik,
        days,
        count: enriched.length,
        filings: enriched
      });
    }

    res.status(200).json({ ok: true, updatedAt: new Date().toISOString(), results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
}
