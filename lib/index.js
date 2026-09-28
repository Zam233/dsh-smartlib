// dsh-smartlib — SmartLib 中英文学术检索 · 文献详情 · 全文下载 · 配额查询 · 参考文献核查工具。
//
// 协议对齐 SmartLib Gateway v52.x（原 Scholar_View smartlib / global-biblio-base /
// smartlib-citation-checker 技能）：register → quota → consume → search 全代理调用，
// 多邮箱配额轮换，任何错误一律返回可读中文文本（不抛异常）。
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

import {
  SmartLibGateway,
  makeSignal,
  mapLimit,
  pickList,
  pickRecord,
  SKILL_BASE,
  DEFAULT_TIMEOUT_MS
} from "./gateway.js";
import {
  formatSearchResult,
  formatDetailResult,
  formatDownloadResult,
  formatQuotaReport,
  formatQuotaExhausted,
  errorText
} from "./format.js";
import {
  normalizeCitations,
  verifyCitations,
  formatVerificationReport
} from "./citations.js";

const name = "dsh-smartlib";
const inject = ["tools", "systemPrompt"];

const VERIFY_TIMEOUT_MS = 240_000;
const MAX_CITATION_BATCH = 16;
const RECOMMENDED_CITATION_LIMIT = 50;

const Config = z.object({
  gateway_url: z.string().default(""),
  gateway_secret: z.string().default(""),
  emails: z.array(z.string()).default([]),
  batch_size: z.number().default(8)
});

// ---- 工具描述 ----

const SEARCH_DESCRIPTION = [
  "中文：通过 SmartLib 检索中外文学术文献（中文期刊 8000 万篇全文 + 12.28 亿条全球文献元数据：期刊/专利/会议/学位论文/标准）。",
  "/ English: Search Chinese and global academic literature via SmartLib.",
  "参数：query=单一关键词（自动构造 K= 表达式，禁止组合词）；rule=高级检索式（T=题名 A=作者 K=主题词 P=出版物名 O=机构 U=全字段，运算符 AND/OR/NOT 须大写且两侧空格）；scope=cn（中文期刊，可下全文）|global（全球文献）|both（并行两库）。",
  "示例 rule：(K=人工智能 OR K=机器学习) AND O=清华大学；T=深度学习 AND Y=2024。",
  "限制：每邮箱免费 100 次/月，每次调用消耗 1 次配额（scope=both 消耗 2 次）；page_size 上限 100。"
].join(" ");

const DETAIL_DESCRIPTION = [
  "中文：查询单篇文献详情（摘要、DOI、核心收录、基金资助、页码、机构、原始数据库来源链接）。",
  "/ English: Fetch full metadata for one record by its SmartLib 文献ID.",
  "参数：identifier=文献ID（来自 smartlib_search 结果）；scope=cn|global（缺省 cn，自动回退试探另一库）。",
  "价值：检索列表的 Source 字段恒为空数组，**只有详情接口才返回 Scopus/WoS/EI/PubMed/CNKI 等 300+ 数据库的原始来源链接**，可用于交叉验证文献真实性。",
  "计费：每次调用消耗 1 次配额（自动回退时可能 2 次）。"
].join(" ");

const DOWNLOAD_DESCRIPTION = [
  "中文：获取授权中文期刊论文的 PDF 全文下载链接。",
  "/ English: Get the PDF download URL for an authorized Chinese journal article.",
  "参数：identifier=文献ID（必须是 scope=cn 检索到的中文期刊文献）；scope 固定 cn。",
  "限制：仅中文期刊（API 1/3）支持全文下载；全球文献接口只返回元数据。下载链接有效期约 10 分钟。每次调用消耗 1 次下载配额。"
].join(" ");

const QUOTA_DESCRIPTION = [
  "中文：查询 SmartLib 账户配额与套餐（检索额度 / 下载额度 / 重置时间 / 邮箱验证状态）。",
  "/ English: Query SmartLib quota and plan.",
  "参数：email 可选；缺省则逐个查询所有已配置邮箱并汇总。",
  "未注册的邮箱会自动调用 /register 完成注册（免费 100 次检索 + 10 次下载/月），无需验证码。配额耗尽时返回可选套餐。本工具不消耗配额。"
].join(" ");

const VERIFY_DESCRIPTION = [
  "中文：批量核查参考文献真实性（防 AI 幻觉），逐条联网检索并输出匹配度、数据库命中记录、逐字段差异清单。",
  "/ English: Verify references against SmartLib's 1.2B-record corpus; returns match scores, matched records and field-level diffs.",
  "输入 citations：推荐传结构化对象 {title, year, authors[], doi, journal, scope}；也接受整条参考文献原文字符串（走启发式解析，精度较低）。",
  "检索策略：优先级1 (T=题名核心词) AND Y=年份 → 命中高质量结果即提前终止；无结果则优先级2 放宽年份；中文题名走 cn 库，外文/带 DOI 走 global 库，不支持时自动换库。8 条并行。",
  "打分：题名相似度 60% + 作者 25% + 年份 15%（DOI 精确命中直接判通过）；状态：VERIFIED(≥0.85) / MISMATCH(≥0.6) / FUZZY_MATCH(≥0.4) / NOT_FOUND。",
  "计费：每条引文消耗 1~4 次配额（含回退与换库）；50 条以内建议一次提交，超 50 条请分批（每次最多 50 条）。",
  "本工具只产出核查事实；请把结果按 smartlib-citation-check 技能规范渲染为 HTML 核查报告（含 GB/T 7714-2015/2025 双列对比、多格式 Tab、统计分析）。"
].join(" ");

// ---- 参数定义 ----

const SCOPE_PARAM = {
  type: "string",
  enum: ["cn", "global", "both"],
  description: "检索库：cn=中文期刊（可下全文）｜global=全球文献｜both=并行两个库（消耗 2 次配额）。默认 cn"
};

const DETAIL_SCOPE_PARAM = {
  type: "string",
  enum: ["cn", "global", "auto"],
  description: "文献库：cn=中文期刊｜global=全球文献｜auto=先 cn 再用 global 试探（缺省，可能多消耗 1 次配额）"
};

const CITATION_ITEM = {
  oneOf: [
    {
      type: "string",
      description: "整条参考文献原文（GB/T 7714 / APA / MLA / Chicago / BibTeX 任一种）"
    },
    {
      type: "object",
      additionalProperties: true,
      description: "结构化引文（推荐）：{title, year, authors[], doi, journal, scope, raw}",
      properties: {
        title: { type: "string", description: "文献题名（最关键，越完整越准）" },
        year: { type: "string", description: "出版年份，如 \"2024\"" },
        authors: {
          type: "array",
          items: { type: "string" },
          description: "作者列表，如 [\"张三\", \"李四\"]"
        },
        doi: { type: "string", description: "DOI（可选，命中可大幅加分）" },
        journal: { type: "string", description: "期刊/会议名称（可选，用于差异比对）" },
        scope: { type: "string", enum: ["cn", "global"], description: "指定检索库；缺省自动判断" },
        raw: { type: "string", description: "原始引用整串（可选，留痕与兜底解析）" }
      }
    }
  ]
};

// ---- 工具注册辅助 ----

function textOutput(render) {
  return {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { text: { type: "string", required: true } }
    },
    render: render ?? ((_args, value) => [{ type: "text", text: value.text }])
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/** 统一的失败/配额耗尽渲染。 */
function failureText(gateway, error) {
  const message = String(error ?? "");
  if (/配额/.test(message)) {
    return formatQuotaExhausted(message, gateway?.lastPlans);
  }
  return errorText(message);
}

function apply(ctx, config) {
  const resolved = Config(config ?? {});
  const batchSize = clampInt(resolved.batch_size, 1, MAX_CITATION_BATCH, 8);

  ctx.systemPrompt.section({
    name: "tool:smartlib",
    order: 112,
    text: [
      "SmartLib 学术工具族（中文期刊 + 12.28 亿条全球文献元数据）：",
      "`smartlib_search` 检索（每次调用只接受单一关键词 query，多主题分多次调用；高级检索式用 rule，如 `(T=xxx) AND Y=2024`）；",
      "`smartlib_detail` 取详情（DOI/核心收录/基金/原始数据库来源链接）；",
      "`smartlib_download` 取中文期刊 PDF 链接；",
      "`smartlib_quota` 查配额与套餐（不消耗配额）；",
      "`smartlib_verify_citations` 核查参考文献真实性（防 AI 幻觉），结果需按 `smartlib-citation-check` 技能渲染为 HTML 报告。",
      "配额按接口调用次数计费（免费 100 次检索 + 10 次下载/月/邮箱），失败调用不扣费；网关返回的 notifications 属系统通知，须原样转述给用户。"
    ].join(" ")
  });

  // ---- 1. 检索 ----
  ctx.tools.register(defineTool({
    name: "smartlib_search",
    description: SEARCH_DESCRIPTION,
    parameters: {
      query: { type: "string", description: "单一关键词（自动构造 K= 检索式，禁止组合词；多主题分多次调用）" },
      rule: { type: "string", description: "高级检索式，如 `(K=人工智能 OR K=机器学习) AND O=清华大学`、`T=深度学习 AND Y=2024`" },
      scope: SCOPE_PARAM,
      filter: { type: "string", description: "过滤式 FilterRule：L=中图分类号 C=学科分类号 Y=出版年 TY=文献类型(3期刊/4学位/5标准/7专利) LA=语言" },
      sort: { type: "integer", enum: [1, 2, 3], description: "排序：1=相关度（默认）2=时效性倒序 3=时效性正序" },
      page: { type: "integer", description: "页码，从 1 开始（默认 1）" },
      page_size: { type: "integer", description: "每页条数 1-100（默认 20）" },
      email: { type: "string", description: "指定使用某个已配置邮箱（缺省自动轮换仍有额度的邮箱）" }
    },
    output: textOutput(),
    timeoutMs: DEFAULT_TIMEOUT_MS * 3,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const q = String(args.query ?? "").trim();
      const ruleArg = String(args.rule ?? "").trim();
      if (!q && !ruleArg) {
        return { text: errorText("缺少检索参数：请提供 query（单一关键词）或 rule（高级检索式）") };
      }
      const rule = ruleArg || `K=${q}`;
      const scope = args.scope === "global" || args.scope === "both" ? args.scope : "cn";
      const sort = clampInt(args.sort, 1, 3, 1);
      const page = clampInt(args.page, 1, 10_000, 1);
      const pageSize = clampInt(args.page_size, 1, 100, 20);
      const filter = String(args.filter ?? "").trim();
      const email = String(args.email ?? "").trim() || undefined;

      const gateway = new SmartLibGateway(resolved, { signal: makeSignal(exec, DEFAULT_TIMEOUT_MS * 3) });
      if (!gateway.configured) return { text: gateway.configError };

      const scopes = scope === "both" ? ["cn", "global"] : [scope];
      try {
        const calls = await Promise.all(
          scopes.map((s) => gateway.search(s, rule, { filter, sort, page, pageSize, skillSource: SKILL_BASE, email }))
        );

        const failed = calls.filter((r) => !r.ok);
        if (failed.length === calls.length) {
          return { text: failureText(gateway, failed[0].error) };
        }

        const blocks = [];
        calls.forEach((res, i) => {
          const s = scopes[i];
          if (!res.ok) {
            blocks.push(`# SmartLib 检索结果（${s === "global" ? "全球文献" : "中文期刊"}）\n\n该库检索失败：${res.error}`);
            return;
          }
          const { list, total } = pickList(res.body);
          blocks.push(formatSearchResult({
            scope: s,
            rule,
            filter,
            sort,
            page,
            pageSize,
            total,
            papers: list,
            footer: false
          }));
        });

        const quotaLine = `📊 本次消耗 ${gateway.spent} 次 | ${gateway.lastRemain != null ? `剩余 ${gateway.lastRemain} 次` : "剩余额度未知"}${gateway.emails.length > 1 ? ` | 邮箱轮换：${gateway.emails.length} 个` : ""}`;
        const notes = gateway.notifications.length
          ? `\n\n---\n**系统通知（原样转述）**\n${gateway.notifications.map((n) => `- ${n.text}${n.url ? `（链接：${n.url}）` : ""}`).join("\n")}`
          : "";
        return { text: `${blocks.join("\n\n---\n\n")}\n\n${quotaLine}${notes}` };
      } catch (err) {
        return { text: failureText(gateway, err?.name === "AbortError" ? "请求超时或已取消" : err?.message ?? String(err)) };
      }
    }
  }));

  // ---- 2. 详情 ----
  ctx.tools.register(defineTool({
    name: "smartlib_detail",
    description: DETAIL_DESCRIPTION,
    parameters: {
      identifier: { type: "string", required: true, description: "文献ID（smartlib_search 结果中的「文献ID」）" },
      scope: DETAIL_SCOPE_PARAM,
      email: { type: "string", description: "指定使用某个已配置邮箱（缺省自动轮换）" }
    },
    output: textOutput(),
    timeoutMs: DEFAULT_TIMEOUT_MS * 3,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const identifier = String(args.identifier ?? "").trim();
      if (!identifier) return { text: errorText("缺少参数 identifier（文献ID）") };
      const scopeArg = args.scope === "global" || args.scope === "cn" ? args.scope : "auto";
      const email = String(args.email ?? "").trim() || undefined;

      const gateway = new SmartLibGateway(resolved, { signal: makeSignal(exec, DEFAULT_TIMEOUT_MS * 3) });
      if (!gateway.configured) return { text: gateway.configError };

      try {
        const order = scopeArg === "cn" ? ["cn"] : scopeArg === "global" ? ["global"] : ["cn", "global"];
        let lastError = "";
        for (const scope of order) {
          const res = await gateway.detail(scope, identifier, { skillSource: SKILL_BASE, email });
          if (res.quotaExhausted) return { text: failureText(gateway, res.error) };
          if (!res.ok) {
            lastError = res.error;
            continue;
          }
          const record = pickRecord(res.body);
          if (!record || Object.keys(record).length === 0) {
            lastError = `${scope === "global" ? "全球文献" : "中文期刊"}库返回空记录`;
            continue;
          }
          return {
            text: formatDetailResult(record, {
              scope,
              spent: gateway.spent,
              remain: gateway.lastRemain,
              emails: gateway.emails,
              notifications: gateway.notifications
            })
          };
        }
        return { text: failureText(gateway, lastError || `未找到文献ID \`${identifier}\` 的详情`) };
      } catch (err) {
        return { text: failureText(gateway, err?.name === "AbortError" ? "请求超时或已取消" : err?.message ?? String(err)) };
      }
    }
  }));

  // ---- 3. 下载 ----
  ctx.tools.register(defineTool({
    name: "smartlib_download",
    description: DOWNLOAD_DESCRIPTION,
    parameters: {
      identifier: { type: "string", required: true, description: "中文期刊文献ID（scope=cn 检索所得）" },
      email: { type: "string", description: "指定使用某个已配置邮箱（缺省自动轮换）" }
    },
    output: textOutput(),
    timeoutMs: DEFAULT_TIMEOUT_MS * 2,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const identifier = String(args.identifier ?? "").trim();
      if (!identifier) return { text: errorText("缺少参数 identifier（文献ID）") };
      const email = String(args.email ?? "").trim() || undefined;

      const gateway = new SmartLibGateway(resolved, { signal: makeSignal(exec, DEFAULT_TIMEOUT_MS * 2) });
      if (!gateway.configured) return { text: gateway.configError };

      try {
        const res = await gateway.downloadCn(identifier, { skillSource: SKILL_BASE, email });
        if (res.quotaExhausted) return { text: failureText(gateway, res.error) };
        if (!res.ok) return { text: failureText(gateway, res.error) };
        const record = pickRecord(res.body);
        const url = String(record?.Url ?? record?.url ?? res.body?.Url ?? "").trim();
        return {
          text: formatDownloadResult({
            identifier,
            url,
            spent: gateway.spent,
            remain: gateway.lastRemain,
            emails: gateway.emails,
            notifications: gateway.notifications
          })
        };
      } catch (err) {
        return { text: failureText(gateway, err?.name === "AbortError" ? "请求超时或已取消" : err?.message ?? String(err)) };
      }
    }
  }));

  // ---- 4. 配额 ----
  ctx.tools.register(defineTool({
    name: "smartlib_quota",
    description: QUOTA_DESCRIPTION,
    parameters: {
      email: { type: "string", description: "要查询的邮箱；缺省查询全部已配置邮箱" }
    },
    output: textOutput(),
    timeoutMs: DEFAULT_TIMEOUT_MS * 2,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const gateway = new SmartLibGateway(resolved, { signal: makeSignal(exec, DEFAULT_TIMEOUT_MS * 2) });
      if (!gateway.configured) return { text: gateway.configError };

      const one = String(args.email ?? "").trim();
      const emails = one ? [one] : gateway.emails;
      if (emails.length === 0) return { text: errorText("未配置邮箱（emails）") };

      try {
        const entries = await mapLimit(emails, 4, async (email) => {
          const res = await gateway.quota(email);
          return res.ok
            ? { ok: true, email, quota: res.quota, registered: res.registered }
            : { ok: false, email, error: res.error, registered: res.registered };
        });
        return {
          text: formatQuotaReport(entries, {
            notifications: gateway.notifications,
            emails: gateway.emails
          })
        };
      } catch (err) {
        return { text: failureText(gateway, err?.name === "AbortError" ? "请求超时或已取消" : err?.message ?? String(err)) };
      }
    }
  }));

  // ---- 5. 参考文献核查 ----
  ctx.tools.register(defineTool({
    name: "smartlib_verify_citations",
    description: VERIFY_DESCRIPTION,
    parameters: {
      citations: {
        type: "array",
        required: true,
        description: "待核查的参考文献列表；元素为结构化对象 {title, year, authors[], doi, journal, scope} 或整条引用原文",
        items: CITATION_ITEM
      },
      scope: {
        type: "string",
        enum: ["auto", "cn", "global"],
        description: "检索库策略：auto=按题名语言自动判断并支持换库（缺省）｜cn=仅中文期刊｜global=仅全球文献"
      },
      max_candidates: { type: "integer", description: "每条引文返回的候选记录数 1-10（默认 3）" },
      email: { type: "string", description: "指定使用某个已配置邮箱（缺省自动轮换）" }
    },
    output: textOutput(),
    timeoutMs: VERIFY_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const rawList = Array.isArray(args.citations) ? args.citations : [];
      if (rawList.length === 0) return { text: errorText("缺少参数 citations（待核查的参考文献列表）") };

      const limited = rawList.slice(0, RECOMMENDED_CITATION_LIMIT);
      const gateway = new SmartLibGateway(resolved, { signal: makeSignal(exec, VERIFY_TIMEOUT_MS) });
      if (!gateway.configured) return { text: gateway.configError };

      const citations = normalizeCitations(limited);
      const missingTitle = citations.filter((c) => !c.title);
      const note = missingTitle.length
        ? `${missingTitle.length} 条引文未能解析出题名（序号：${missingTitle.map((c) => c.index + 1).join("、")}），已尽力用原文关键词检索，建议改为传入结构化 title 后重核。`
        : "";

      try {
        const results = await verifyCitations(gateway, citations, {
          batchSize,
          maxCandidates: clampInt(args.max_candidates, 1, 10, 3),
          scope: args.scope === "cn" || args.scope === "global" ? args.scope : "auto"
        });

        const skipped = results.filter((r) => r.status === "SKIPPED").length;
        const quotaNote = gateway.spent === 0
          ? "⚠️ 本次未产生任何计费调用（可能全部因配额耗尽而中止）。"
          : skipped > 0
            ? `⚠️ 有 ${skipped} 条因配额耗尽或错误未完成核查。`
            : "";

        const text = formatVerificationReport(results, {
          note: [note, quotaNote].filter(Boolean).join(" "),
          spent: gateway.spent,
          remain: gateway.lastRemain,
          emails: gateway.emails,
          notifications: gateway.notifications
        });

        return { text };
      } catch (err) {
        return {
          text: failureText(
            gateway,
            err?.name === "AbortError" ? "请求超时或已取消（可减少 citations 条数后重试）" : err?.message ?? String(err)
          )
        };
      }
    }
  }));
}

export { Config, apply, inject, name };
