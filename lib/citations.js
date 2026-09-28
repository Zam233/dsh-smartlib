// lib/citations.js — 参考文献真实性核查引擎。
//
// 对齐 smartlib-citation-checker（v3.6.3）：
//   Step 1 解析引用（模型负责结构化；纯字符串走启发式兜底解析）
//   Step 2 联网核查（题名核心词 + 年份 → 优先级1；无结果 → 放宽年份 → 优先级2；8 条并行，命中即提前终止）
//   Step 3 匹配打分（题名 60% + 作者 25% + 年份 15%，DOI 命中加分）
//   Step 4 差异比对（逐字段给出「原始引用 → 数据库记录」）
//   Step 5 输出结构化结果，交由模型生成 HTML 核查报告
//
// 本模块只负责 2~4 步的事实产出；格式转换（GB/T 7714-2015/2025、APA、MLA、Chicago、BibTeX）与 HTML 报告由模型完成。

import { mapLimit, pickList, SKILL_CITATION } from "./gateway.js";
import { cleanText, splitList, docType, detailUrl, formatQuotaFooter, formatNotifications } from "./format.js";

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const STOPWORDS = new Set([
  "a", "an", "the", "in", "of", "for", "and", "on", "to", "is", "by", "with", "using", "based", "from",
  "at", "as", "an", "or", "not", "be", "are", "was", "were", "this", "that", "these", "those", "we",
  "our", "it", "its", "can", "via", "into", "under", "over", "between", "study", "research", "analysis"
]);

// ---- 文本归一化与相似度 ----

export function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\[\]【】（）()《》〈〉"'“”‘’`,.;:!?、。，；：！？·—–_/\\|+=*&#@$%^~<>{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 中英混排分词：CJK 取单字 + 二元组，拉丁取词。 */
export function tokenize(value) {
  const text = normalizeText(value);
  const tokens = new Set();
  for (const chunk of text.split(" ")) {
    if (!chunk) continue;
    if (CJK.test(chunk)) {
      const runs = chunk.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) ?? [];
      for (const run of runs) {
        for (let i = 0; i < run.length; i += 1) {
          tokens.add(run[i]);
          if (i + 1 < run.length) tokens.add(run.slice(i, i + 2));
        }
      }
      const latin = chunk.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, " ").trim();
      if (latin) for (const w of latin.split(/\s+/)) if (w.length > 1) tokens.add(w);
    } else if (chunk.length > 1) {
      tokens.add(chunk);
    }
  }
  return tokens;
}

/** 题名相似度：包含度为主 + Jaccard 修正，值域 0~1。 */
export function titleSimilarity(a, b) {
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  const containment = inter / A.size;
  const jaccard = inter / (A.size + B.size - inter);
  return Math.max(0, Math.min(1, containment * 0.7 + jaccard * 0.3));
}

/** 取姓氏/首段用于展示与旧版兼容：中文取前 2 字，外文取逗号前或首词。 */
export function surname(name) {
  const n = String(name ?? "").trim();
  if (!n) return "";
  if (CJK.test(n)) return n.slice(0, 2);
  if (n.includes(",")) return normalizeText(n.split(",")[0]);
  const parts = n.split(/\s+/).filter(Boolean);
  return normalizeText(parts[0] ?? "");
}

/**
 * 姓名 → 有效词元集合。
 *
 * SmartLib 全球库的作者字段是「缩写在前」的西文写法（`S. Band, Shahab`），
 * 中文库是「周圣荃;李以科」，引文侧又常见 `Band, S. S.` / `BAND S`。
 * 因此不比「姓氏」，而比「有效词元集合」——忽略顺序、忽略分隔符差异、忽略单字母缩写。
 */
export function nameTokens(name) {
  const n = String(name ?? "").trim();
  if (!n) return [];
  if (CJK.test(n)) {
    const run = (n.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) ?? []).join("");
    if (!run) return [];
    return run.length > 2 ? [run.slice(0, 2), run] : [run];
  }
  return normalizeText(n)
    .split(" ")
    .map((t) => t.replace(/[^a-z0-9-]/g, ""))
    .filter((t) => t.length > 1 && !/^\d+$/.test(t));
}

/** 作者相似度（0~1）；无法判断（任一侧为空）返回 null。 */
export function authorSimilarity(citeAuthors, creatorRaw) {
  const cited = (Array.isArray(citeAuthors) ? citeAuthors : [])
    .map((a) => nameTokens(a))
    .filter((tokens) => tokens.length > 0);
  const db = new Set();
  for (const chunk of splitList(creatorRaw, /[;；]/)) {
    for (const token of nameTokens(chunk)) db.add(token);
  }
  if (cited.length === 0 || db.size === 0) return null;
  let hit = 0;
  for (const tokens of cited) {
    if (tokens.some((t) => db.has(t))) hit += 1;
  }
  return hit / cited.length;
}

export function normalizeDoi(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
    .replace(/^doi:\s*/, "")
    .replace(/[.。，,;；]+$/, "");
}

/** 加权打分：题名 60% + 作者 25% + 年份 15%（缺失项自动重新归一化权重）。 */
export function scoreRecord(cite, record) {
  const t = titleSimilarity(cite.title || cite.raw, record?.Title ?? record?.Title_Alternative);
  const a = authorSimilarity(cite.authors, record?.Creator);
  const rawYear = cleanText(record?.Date_PublishYear ?? "");
  const y = cite.year ? (rawYear && String(cite.year).trim() === rawYear ? 1 : 0) : null;
  const doiExact = Boolean(
    cite.doi && record?.Identifier_DOI && normalizeDoi(cite.doi) === normalizeDoi(record.Identifier_DOI)
  );

  let sum = 0;
  let weight = 0;
  if (t != null) { sum += t * 0.6; weight += 0.6; }
  if (a != null) { sum += a * 0.25; weight += 0.25; }
  if (y != null) { sum += y * 0.15; weight += 0.15; }
  let score = weight > 0 ? sum / weight : 0;
  if (doiExact) score = Math.max(score, 0.98);
  return { score: Math.round(score * 1000) / 1000, parts: { title: t, author: a, year: y, doiExact } };
}

export function classify(score) {
  if (score >= 0.85) return "VERIFIED";
  if (score >= 0.6) return "MISMATCH";
  if (score >= 0.4) return "FUZZY_MATCH";
  return "NOT_FOUND";
}

export const STATUS_LABEL = {
  VERIFIED: "✅ 验证通过",
  MISMATCH: "⚠️ 存在差异",
  FUZZY_MATCH: "❓ 疑似匹配（需人工确认）",
  NOT_FOUND: "❌ 未找到",
  SKIPPED: "⏸ 未核查（配额/错误）"
};

// ---- 检索式构建 ----

export function coreWords(title, limit = 6) {
  const text = normalizeText(title);
  if (!text) return [];
  if (CJK.test(text)) {
    const compact = text.replace(/\s+/g, "");
    if (!compact) return [];
    return [compact.slice(0, limit <= 4 ? 10 : 24)];
  }
  const words = text.split(" ").filter((w) => w.length > 1 && !STOPWORDS.has(w));
  const seen = new Set();
  const out = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 生成检索式梯队：
 *   优先级1 = (T=核心词) AND Y=年份
 *   优先级2 = T=核心词（放宽年份，提高召回）
 */
export function buildRules(cite) {
  const source = cite.title || "";
  const year = String(cite.year ?? "").trim();
  const rules = [];
  const core = coreWords(source, 6);
  if (core.length) {
    const t = core.join(" ");
    rules.push(year ? `(T=${t}) AND Y=${year}` : `T=${t}`);
    const loose = coreWords(source, 4).join(" ");
    if (loose && loose !== t) rules.push(`T=${loose}`);
  } else if (cite.raw) {
    const core2 = coreWords(cite.raw, 6);
    if (core2.length) rules.push(`U=${core2.join(" ")}`);
  }
  return rules;
}

/** 猜测检索接口：中文题名走中文期刊库（可下全文），外文/带 DOI 走全球库。 */
export function guessScope(cite) {
  if (cite.scope === "cn" || cite.scope === "global") return cite.scope;
  const title = cite.title || cite.raw || "";
  if (cite.doi) return "global";
  if (!title) return "global";
  const cjkCount = (title.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length;
  return cjkCount * 2 >= title.replace(/\s/g, "").length ? "cn" : "global";
}

// ---- 纯字符串引用的启发式解析（模型未结构化时的兜底） ----

export function heuristicParse(text) {
  const raw = String(text ?? "").trim();
  const out = { title: "", year: "", authors: [], doi: "", journal: "", scope: "", raw, parsed: "heuristic" };
  if (!raw) return out;

  const doi = raw.match(/10\.\d{4,9}\/[^\s,;，；]+/);
  if (doi) out.doi = doi[0].replace(/[.。]+$/, "");

  const years = raw.match(/\b(?:19|20)\d{2}\b/g);
  if (years && years.length) {
    const plausible = years.filter((y) => Number(y) >= 1900 && Number(y) <= 2035);
    out.year = plausible[0] ?? "";
  }

  // GB/T 7714 及类似带文献类型标识的写法
  const marker = raw.match(/\[([JMDCNSPRG])(?:\/[A-Z]{2})?\]/);
  if (marker) {
    const before = raw.slice(0, marker.index);
    const segments = before.split(/[.．。]\s*/).map((s) => s.trim()).filter(Boolean);
    if (segments.length) {
      out.title = segments[segments.length - 1];
      if (segments.length >= 2) {
        const authorSeg = segments[0].replace(/^\[?\d+\]?[.\s]*/, "");
        out.authors = authorSeg.split(/[,;，；、]/).map((s) => s.trim()).filter((s) => s && s.length > 1 && !/^\d+$/.test(s));
      }
    }
  }

  if (!out.title) {
    // APA 式：(2024). Title. Journal...
    const apa = raw.match(/\(\s*((?:19|20)\d{2})\s*\)\s*[.:]?\s*([^.]{5,200})/);
    if (apa) {
      out.year = out.year || apa[1];
      out.title = apa[2].trim();
    }
  }

  if (!out.title) {
    // 兜底：取最长的一段（通常是题名）
    const segments = raw
      .replace(/^\[?\d+\]?[.\s]*/, "")
      .split(/[.．。]\s*/)
      .map((s) => s.trim())
      .filter((s) => s.length > 8);
    segments.sort((a, b) => b.length - a.length);
    if (segments.length) out.title = segments[0];
  }

  if (!out.authors.length) {
    const head = raw.replace(/^\[?\d+\]?[.\s]*/, "").split(/[.．。]/)[0] ?? "";
    const parts = head.split(/[,;，；、]/).map((s) => s.trim()).filter((s) => s && s.length > 1 && !/\d/.test(s));
    if (parts.length && parts.length <= 12) out.authors = parts;
  }

  out.title = out.title.replace(/^\[?\d+\]?[.\s]*/, "").trim();
  return out;
}

/** 把工具入参（字符串 / 对象数组）统一成结构化引文。 */
export function normalizeCitations(input) {
  const list = Array.isArray(input) ? input : [];
  return list.map((item, index) => {
    if (typeof item === "string") return { ...heuristicParse(item), index };
    if (item && typeof item === "object") {
      const authors = Array.isArray(item.authors)
        ? item.authors.map((a) => String(a ?? "").trim()).filter(Boolean)
        : item.authors
          ? splitList(item.authors, /[;；,，、]/)
          : [];
      const parsed = {
        title: cleanText(item.title ?? item.Title ?? ""),
        year: String(item.year ?? item.Year ?? "").trim(),
        authors,
        doi: cleanText(item.doi ?? item.DOI ?? ""),
        journal: cleanText(item.journal ?? item.source ?? item.Source_Name ?? ""),
        scope: item.scope === "cn" || item.scope === "global" ? item.scope : "",
        raw: cleanText(item.raw ?? ""),
        index,
        parsed: "structured"
      };
      if (!parsed.title && parsed.raw) {
        const fallback = heuristicParse(parsed.raw);
        parsed.title = fallback.title;
        if (!parsed.year) parsed.year = fallback.year;
        if (parsed.authors.length === 0) parsed.authors = fallback.authors;
        if (!parsed.doi) parsed.doi = fallback.doi;
      }
      return parsed;
    }
    return { title: "", year: "", authors: [], doi: "", journal: "", scope: "", raw: "", index, parsed: "empty" };
  });
}

// ---- 差异比对 ----

/** 逐字段比对：返回 [{field, cited, found, kind}]，kind=error 为实质性差异，info 为可补全信息。 */
export function diffFields(cite, record) {
  const diffs = [];
  const dbTitle = cleanText(record?.Title ?? "");
  if (cite.title && dbTitle) {
    const sim = titleSimilarity(cite.title, dbTitle);
    if (sim < 0.95) diffs.push({ field: "题名", cited: cite.title, found: dbTitle, kind: "error", similarity: Math.round(sim * 100) / 100 });
  }

  const dbYear = cleanText(record?.Date_PublishYear ?? "");
  if (cite.year && dbYear && String(cite.year).trim() !== dbYear) {
    diffs.push({ field: "年份", cited: cite.year, found: dbYear, kind: "error" });
  }

  const citedAuthors = (Array.isArray(cite.authors) ? cite.authors : []).filter(Boolean);
  const dbAuthors = splitList(record?.Creator, /[;；]/);
  if (citedAuthors.length && dbAuthors.length) {
    const sim = authorSimilarity(citedAuthors, record?.Creator);
    if (sim != null && sim < 1) {
      diffs.push({
        field: "作者",
        cited: citedAuthors.join("、"),
        found: dbAuthors.join("、"),
        kind: "error",
        similarity: Math.round(sim * 100) / 100
      });
    } else if (dbAuthors.length !== citedAuthors.length) {
      // 引用常用「等/et al.」或截断作者列表，作者数不一致本身不是错误
      diffs.push({
        field: "作者数量",
        cited: `${citedAuthors.length} 位`,
        found: `${dbAuthors.length} 位：${dbAuthors.join("、")}`,
        kind: "info"
      });
    }
  }

  const dbJournal = cleanText(record?.Source_Name ?? record?.Source_ConfName ?? "");
  if (cite.journal && dbJournal) {
    const a = normalizeText(cite.journal).replace(/\s/g, "");
    const b = normalizeText(dbJournal).replace(/\s/g, "");
    if (a && b && !a.includes(b) && !b.includes(a)) {
      diffs.push({ field: "期刊/来源", cited: cite.journal, found: dbJournal, kind: "error" });
    }
  }

  const dbDoi = cleanText(record?.Identifier_DOI ?? "");
  if (cite.doi && dbDoi && normalizeDoi(cite.doi) !== normalizeDoi(dbDoi)) {
    diffs.push({ field: "DOI", cited: cite.doi, found: dbDoi, kind: "error" });
  } else if (!cite.doi && dbDoi) {
    diffs.push({ field: "DOI", cited: "（原文未给出）", found: dbDoi, kind: "info" });
  }

  return diffs;
}

function candidateOf(record, scored) {
  const vol = cleanText(record?.Source_Volume ?? "");
  const issue = cleanText(record?.Source_Issue ?? "");
  const id = cleanText(record?.Identifier ?? "");
  return {
    title: cleanText(record?.Title ?? ""),
    titleAlternative: cleanText(record?.Title_Alternative ?? ""),
    authors: splitList(record?.Creator, /[;；]/).join("、"),
    source: cleanText(record?.Source_Name ?? record?.Source_ConfName ?? ""),
    year: cleanText(record?.Date_PublishYear ?? ""),
    volume: vol,
    issue,
    pages: cleanText(record?.Description_PageInfo ?? ""),
    doi: cleanText(record?.Identifier_DOI ?? ""),
    docType: docType(record?.Doc_Type),
    language: cleanText(record?.Language ?? ""),
    core: splitList(record?.Description_Core, /[;；]/),
    organization: cleanText(record?.Creator_Organ ?? ""),
    identifier: id,
    detailUrl: cleanText(record?.Identifier_DetailURL ?? "") || detailUrl(id),
    score: scored.score,
    scoreParts: scored.parts
  };
}

// ---- 主流程 ----

export const VERIFY_DEFAULT_BATCH = 8;

/**
 * 批量核查。
 * @param {import('./gateway.js').SmartLibGateway} gateway
 * @param {Array} citations normalizeCitations 的输出
 * @param {object} options { batchSize, maxCandidates, scope, onProgress }
 * @returns {Promise<Array>} 每条引文的核查结果
 */
export async function verifyCitations(gateway, citations, options = {}) {
  const batchSize = Math.max(1, Math.min(Number(options.batchSize) || VERIFY_DEFAULT_BATCH, 16));
  const maxCandidates = Math.max(1, Math.min(Number(options.maxCandidates) || 3, 10));
  const scopeOpt = options.scope === "cn" || options.scope === "global" ? options.scope : "auto";

  return mapLimit(citations, batchSize, async (cite) => {
    const result = {
      index: cite.index,
      input: cite,
      status: "SKIPPED",
      score: 0,
      matched: null,
      candidates: [],
      diffs: [],
      searches: [],
      error: null
    };

    const rules = buildRules(cite);
    if (rules.length === 0) {
      result.error = "无法从引用中提取题名关键词，请提供 title 字段或完整原始引用字符串";
      return result;
    }

    // 上游熔断后不再逐条发起调用（每次都会计费），如实标为「未核查」，
    // 绝不能降级成 NOT_FOUND —— 那会把真实文献误报成幻觉文献。
    if (gateway.aborted) {
      result.status = "SKIPPED";
      result.error = gateway.abortedReason || "上游检索服务异常，未完成核查";
      return result;
    }

    const preferred = scopeOpt === "auto" ? guessScope(cite) : scopeOpt;
    const scopes =
      scopeOpt === "auto" && !cite.scope ? [preferred, preferred === "cn" ? "global" : "cn"] : [preferred];

    let best = null;
    let bestRecord = null;
    const pool = [];

    for (const scope of scopes) {
      for (const rule of rules) {
        const res = await gateway.search(scope, rule, {
          pageSize: 10,
          sort: 1,
          skillSource: SKILL_CITATION
        });
        if (res.quotaExhausted) {
          result.error = "配额已用尽，未完成核查";
          return result;
        }
        if (!res.ok) {
          result.searches.push({ scope, rule, ok: false, error: res.error });
          result.error = res.error;
          continue;
        }

        const { list: records, total } = pickList(res.body);
        result.searches.push({ scope, rule, ok: true, total, candidates: records.length });

        for (const record of records) {
          pool.push(record);
          const scored = scoreRecord(cite, record);
          if (!best || scored.score > best.score) {
            best = scored;
            bestRecord = record;
          }
        }

        // 智能提前终止：优先级 1 命中高质量结果即跳过回退（省配额）
        if (best && best.score >= 0.6) break;
      }
      if (best && best.score >= 0.6) break;
    }

    if (!best || !bestRecord) {
      // 若因上游熔断/配额耗尽而中止，如实标注未核查，不得报成 NOT_FOUND
      if (gateway.aborted || result.error) {
        result.status = "SKIPPED";
        result.error = result.error || gateway.abortedReason || "检索未完成";
        return result;
      }
      result.status = "NOT_FOUND";
      return result;
    }

    result.score = best.score;
    result.status = classify(best.score);
    result.matched = candidateOf(bestRecord, best);

    if (best.score >= 0.4) {
      result.diffs = diffFields(cite, bestRecord);
    }

    // 候选排序复用已抓取的记录，不额外消耗配额
    result.candidates = pool
      .map((record) => ({ record, scored: scoreRecord(cite, record) }))
      .sort((a, b) => b.scored.score - a.scored.score)
      .slice(0, maxCandidates)
      .map(({ record, scored }) => candidateOf(record, scored));
    if (result.candidates.length === 0) {
      result.candidates = [candidateOf(bestRecord, best)];
    }
    return result;
  });
}

// ---- 报告渲染（供模型据此生成 HTML） ----

export function formatVerificationReport(results, meta = {}) {
  const lines = [];
  const counts = { VERIFIED: 0, MISMATCH: 0, FUZZY_MATCH: 0, NOT_FOUND: 0, SKIPPED: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;

  lines.push("# 参考文献核查结果（SmartLib 联网核验）");
  lines.push("");
  lines.push(
    `共 ${results.length} 条：✅ 通过 ${counts.VERIFIED} ｜ ⚠️ 有差异 ${counts.MISMATCH} ｜ ❓ 疑似 ${counts.FUZZY_MATCH} ｜ ❌ 未找到 ${counts.NOT_FOUND}${counts.SKIPPED ? ` ｜ ⏸ 未核查 ${counts.SKIPPED}` : ""}`
  );
  if (meta.note) {
    lines.push("");
    lines.push(`> ${meta.note}`);
  }

  lines.push("");
  lines.push("## 一、核查总表");
  lines.push("");
  lines.push("| # | 状态 | 置信度 | 原始引用（题名） | 数据库命中题名 | 作者 | 来源 | 年 | 核心收录 | 文献ID |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    const m = r.matched;
    const citedTitle = r.input.title || r.input.raw || "（未解析）";
    const cells = [
      r.index + 1,
      STATUS_LABEL[r.status] ?? r.status,
      r.score ? r.score.toFixed(2) : "—",
      mdCell(citedTitle, 60),
      mdCell(m?.title ?? "—", 60),
      mdCell(m?.authors ?? "—", 40),
      mdCell(m?.source ?? "—", 30),
      m?.year ?? "—",
      m?.core?.length ? m.core.join(" ") : "—",
      m?.identifier ? `\`${m.identifier}\`` : "—"
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  }

  lines.push("");
  lines.push("## 二、逐条明细（含差异与候选）");
  for (const r of results) {
    lines.push("");
    lines.push(`### ${r.index + 1}. ${STATUS_LABEL[r.status] ?? r.status}${r.score ? `（置信度 ${r.score.toFixed(2)}）` : ""}`);
    lines.push("");
    lines.push(`- 原始引用题名：${r.input.title || "（未解析，原文：" + (r.input.raw || "").slice(0, 120) + "）"}`);
    if (r.input.authors?.length) lines.push(`- 原始作者：${r.input.authors.join("、")}`);
    if (r.input.year) lines.push(`- 原始年份：${r.input.year}`);
    if (r.input.doi) lines.push(`- 原始 DOI：${r.input.doi}`);
    if (r.input.parsed === "heuristic") lines.push("- ⚠️ 该条由字符串启发式解析，字段可能有偏差，请复核后使用");

    if (r.matched) {
      const m = r.matched;
      lines.push(`- **数据库记录**：${m.title}${m.titleAlternative && m.titleAlternative !== m.title ? `（原题名：${m.titleAlternative}）` : ""}`);
      lines.push(`  - 作者：${m.authors || "—"}`);
      lines.push(`  - 来源：${m.source || "—"}${m.year ? `，${m.year}` : ""}${m.volume ? `，${m.volume}${m.issue ? `(${m.issue})` : ""}` : ""}${m.pages ? `：${m.pages}` : ""}`);
      if (m.doi) lines.push(`  - DOI：${m.doi}`);
      if (m.core?.length) lines.push(`  - 核心收录：${m.core.map((c) => `[${c}]`).join(" ")}`);
      if (m.organization) lines.push(`  - 机构：${m.organization}`);
      if (m.detailUrl) lines.push(`  - SmartLib 详情页：${m.detailUrl}`);
      lines.push(`  - 匹配度构成：题名 ${fmtPart(m.scoreParts.title)} / 作者 ${fmtPart(m.scoreParts.author)} / 年份 ${fmtPart(m.scoreParts.year)}${m.scoreParts.doiExact ? " / DOI 精确命中" : ""}`);
    }

    if (r.diffs.length) {
      lines.push("- **差异清单（用于生成 [删除]/[新增] 标记）**：");
      for (const d of r.diffs) {
        const tag = d.kind === "error" ? "差异" : "补全";
        lines.push(`  - [${tag}] ${d.field}：原始「${d.cited}」 → 数据库「${d.found}」`);
      }
    } else if (r.status === "VERIFIED") {
      lines.push("- 差异清单：未发现实质性差异。");
    }

    if (r.status === "FUZZY_MATCH") {
      lines.push("- ⚠️ 疑似匹配：**不得凭空编造修正内容**，请保留原始引用并标注「存疑，需人工核实」。");
    }
    if (r.status === "NOT_FOUND") {
      lines.push("- 未在 12 亿文献库中命中：可能是 AI 幻觉文献、题名记错、或该文献未被收录。请提示用户核对原始来源。");
    }
    if (r.error) lines.push(`- 错误：${r.error}`);

    if (r.candidates && r.candidates.length > 1) {
      lines.push("- 其它候选：");
      for (const c of r.candidates.slice(1)) {
        lines.push(`  - （${c.score.toFixed(2)}）${c.title}｜${c.authors || "—"}｜${c.source || "—"} ${c.year || ""}${c.identifier ? `｜\`${c.identifier}\`` : ""}`);
      }
    }
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    "下一步：请按 `smartlib-citation-check` 技能的规范，把以上事实渲染为 HTML 核查报告（7 列表格：序号/状态/原始引用(格式名)/GB-T 7714-2015/GB-T 7714-2025 修正/变化说明/验证链接；再附修正后纯文本区块、GB/T 7714-2025|2015|APA|MLA|Chicago|BibTeX 多格式 Tab、文献数≥3 时的统计分析、页脚来源说明）。"
  );

  lines.push("");
  lines.push(formatQuotaFooter({ spent: meta.spent ?? 0, remain: meta.remain ?? null, emails: meta.emails ?? [] }));
  const notes = formatNotifications(meta.notifications ?? []);
  if (notes) lines.push(notes);
  return lines.join("\n").trim();
}

function fmtPart(value) {
  return value == null ? "—" : value.toFixed(2);
}

function mdCell(value, limit) {
  const s = String(value ?? "—").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim() || "—";
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}
