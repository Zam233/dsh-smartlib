// lib/format.js — 把网关返回的数据渲染成模型可直接使用的 Markdown。
//
// 约定：所有面向模型的文本都是中文 Markdown；末尾统一附「配额状态」与「系统通知」。

import { DETAIL_URL_BASE } from "./gateway.js";

export const DOC_TYPES = {
  1: "图书",
  2: "会议文献",
  3: "期刊文献",
  4: "学位论文",
  5: "标准",
  6: "报告",
  7: "专利",
  8: "年鉴",
  9: "法律法规",
  10: "科技成果"
};

// 检索式字段代码 / 过滤字段代码说明（供工具描述与结果头复用）
export const RULE_FIELDS = "T=题名 A=作者 K=主题词 P=出版物名 O=机构 U=全字段（运算符 AND/OR/NOT 须大写且两侧空格）";
export const FILTER_FIELDS = "L=中图分类号 C=学科分类号 Y=出版年 TY=文献类型(3期刊/4学位/5标准/7专利) LA=语言";

export function detailUrl(identifier) {
  const id = String(identifier ?? "").trim();
  return id ? `${DETAIL_URL_BASE}${encodeURIComponent(id)}` : "";
}

export function docType(code) {
  const n = Number(code);
  return DOC_TYPES[n] ?? (Number.isFinite(n) ? `其他类型(${n})` : "未知类型");
}

export function splitList(raw, sep = /[;；]/) {
  return String(raw ?? "")
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function cleanText(raw) {
  return String(raw ?? "").replace(/\s+/g, " ").trim();
}

/** 截断到 n 字符，超出加省略号。 */
export function truncate(text, n) {
  const s = cleanText(text);
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}

// ---- 通知 / 配额页脚 ----

/** 常驻通知：原样转述，不改写措辞、不合并多条；url 以纯文字呈现，不做强引导。 */
export function formatNotifications(notifications) {
  const list = Array.isArray(notifications) ? notifications : [];
  if (list.length === 0) return "";
  const lines = ["", "---", "**系统通知（原样转述）**"];
  for (const item of list) {
    const text = cleanText(item?.text ?? "");
    const url = cleanText(item?.url ?? "");
    if (text && url) lines.push(`- ${text}（链接：${url}）`);
    else if (text) lines.push(`- ${text}`);
    else if (url) lines.push(`- 链接：${url}`);
  }
  return lines.join("\n");
}

/** 📊 本次消耗 N 次 | 剩余 M 次（共 100 次/月） */
export function formatQuotaFooter({ spent = 0, remain = null, emails = [] } = {}) {
  const parts = [`📊 本次消耗 ${spent} 次`];
  if (remain != null) {
    parts.push(`剩余 ${remain} 次`);
    if (remain <= 5 && remain > 0) parts.push("⚠️ 接近用尽，可说「我要升级」查看套餐");
    else if (remain <= 20 && remain > 5) parts.push("（共 100 次/月）");
  }
  if (emails.length > 1) parts.push(`邮箱轮换：${emails.length} 个`);
  return parts.join(" | ");
}

// ---- 套餐卡片 ----

const PLAN_FALLBACK = [
  { key: "trial_card", name: "体验卡", price: 9.9, search: 1000, download: 20, days: 7 },
  { key: "personal_month", name: "个人版月", price: 39, search: 1000, download: 50, days: 30 },
  { key: "pro_month", name: "专业版月", price: 99, search: 2000, download: 200, days: 30 },
  { key: "single_download", name: "单篇下载", price: 2.5, search: 0, download: 1, days: 0 },
  { key: "download_pack", name: "下载包", price: 20, search: 0, download: 10, days: 30 }
];

/** 配额耗尽/偏低时输出可选套餐（网关返回 plans 优先，缺失时用内置表）。 */
export function formatPlans(plans) {
  const list = Array.isArray(plans) && plans.length > 0 ? plans : PLAN_FALLBACK;
  const lines = ["", "**可用套餐（在对话中回复数字即可下单，或说「我要升级」）**"];
  list.forEach((plan, i) => {
    if (!plan || typeof plan !== "object") return;
    const name = plan.name ?? plan.key ?? "套餐";
    const price = plan.price == null ? "—" : `¥${plan.price}`;
    const search = plan.search ? `${plan.search} 检索` : "";
    const download = plan.download ? `${plan.download} 下载` : "";
    const days = plan.days ? `${plan.days}天` : "";
    const quota = [search, download, days].filter(Boolean).join(" + ");
    lines.push(`${i + 1}. ${name} ${price}${quota ? ` — ${quota}` : ""}`);
  });
  lines.push("企业/机构定制：vipsmart@vipslib.com ｜ 023-63016015 ｜ https://www.vipslib.com/");
  return lines.join("\n");
}

export function formatQuotaExhausted(reason, plans) {
  return [
    `⚠️ ${reason || "您的 SmartLib 配额已用尽"}，暂不支持发起新的检索/核查请求。`,
    formatPlans(plans)
  ].join("\n");
}

// ---- 检索结果 ----

/** 单篇文献（列表项）。 */
export function formatPaper(index, paper, { abstractLimit = 200, showAbstract = true } = {}) {
  const lines = [];
  const title = cleanText(paper?.Title ?? paper?.title) || "（无标题）";
  lines.push(`### ${index}. ${title}`);

  const alt = cleanText(paper?.Title_Alternative ?? "");
  if (alt) lines.push(`- 原题名：${alt}`);

  const creators = splitList(paper?.Creator, /[;；]/);
  if (creators.length) lines.push(`- 作者：${creators.join("、")}`);

  const organs = splitList(paper?.Creator_Organ, /[;；]/);
  if (organs.length) lines.push(`- 机构：${truncate(organs.join("；"), 120)}`);

  const source = cleanText(paper?.Source_Name ?? "");
  const year = cleanText(paper?.Date_PublishYear ?? "");
  const volume = cleanText(paper?.Source_Volume ?? "");
  const issue = cleanText(paper?.Source_Issue ?? "");
  const volIssue = volume ? `${volume}${issue ? `(${issue})` : ""}` : issue ? `(${issue})` : "";
  const conf = cleanText(paper?.Source_ConfName ?? "");
  const sourceParts = [source || conf, year, volIssue].filter(Boolean);
  if (sourceParts.length) lines.push(`- 来源：${sourceParts.join("，")}`);

  const meta = [docType(paper?.Doc_Type)];
  const lang = cleanText(paper?.Language ?? "");
  if (lang) meta.push(`语言 ${lang}`);
  const publishDate = cleanText(paper?.Date_Publish ?? "");
  if (publishDate.length >= 8) meta.push(`出版 ${publishDate.slice(0, 4)}-${publishDate.slice(4, 6)}-${publishDate.slice(6, 8)}`);
  lines.push(`- 类型：${meta.join(" | ")}`);

  const issn = cleanText(paper?.Identifier_ISSN ?? "");
  if (issn) lines.push(`- ISSN：${issn}`);

  const keywords = splitList(paper?.Subject_Keyword);
  if (keywords.length) lines.push(`- 关键词：${keywords.join("；")}`);

  const subjects = splitList(paper?.Subject_CNLIB);
  if (subjects.length) lines.push(`- 中图分类号：${subjects.join("；")}`);

  if (showAbstract) {
    const abstract = cleanText(paper?.Description ?? "");
    if (abstract) lines.push(`- 摘要：${truncate(abstract, abstractLimit)}`);
  }

  const id = cleanText(paper?.Identifier ?? "");
  if (id) {
    lines.push(`- 文献ID：\`${id}\``);
    const link = cleanText(paper?.Identifier_DetailURL ?? "") || detailUrl(id);
    if (link) lines.push(`- SmartLib 详情页：${link}`);
  }
  return lines.join("\n");
}

/**
 * 检索结果整体渲染。
 * @param {object} o { scope, rule, filter, sort, page, pageSize, total, papers, spent, remain, emails, notifications, scopeLabel }
 */
export function formatSearchResult(o) {
  const lines = [];
  const label = o.scopeLabel ?? (o.scope === "global" ? "全球文献" : "中文期刊");
  lines.push(`# SmartLib 检索结果（${label}）`);
  lines.push("");
  lines.push(`- 检索式：\`${o.rule}\``);
  if (o.filter) lines.push(`- 过滤条件：\`${o.filter}\``);
  lines.push(`- 排序：${{ 1: "相关度", 2: "时效性倒序", 3: "时效性正序" }[o.sort] ?? o.sort}｜第 ${o.page} 页｜每页 ${o.pageSize} 条`);
  if (o.total != null) lines.push(`- 命中总量：${o.total} 条`);
  if (o.extraNotes) lines.push(`- 说明：${o.extraNotes}`);

  if (!o.papers || o.papers.length === 0) {
    lines.push("");
    lines.push("未检索到结果。建议：① 去掉 FilterRule 扩大范围；② 用上位词/同义词扩检（如「深度学习」补「神经网络 机器学习」）；③ 中英双检（中文用 scope=cn，英文用 scope=global）；④ 把 T= 改为 U= 扩检。");
  } else {
    lines.push("");
    o.papers.forEach((paper, i) => {
      lines.push(formatPaper(i + 1, paper, { abstractLimit: o.abstractLimit ?? 200 }));
      lines.push("");
    });
    lines.push("> 提示：摘要为截断预览；查看 DOI、核心收录、基金资助与原始数据库来源链接（Scopus/WoS/EI/PubMed/CNKI 等 300+ 库）请用 `smartlib_detail` 传入文献ID。");
  }

  lines.push("");
  if (o.footer !== false) {
    lines.push(formatQuotaFooter({ spent: o.spent, remain: o.remain, emails: o.emails }));
    const notes = formatNotifications(o.notifications);
    if (notes) lines.push(notes);
  }
  return lines.join("\n").trim();
}

// ---- 详情 ----

export function formatDetailResult(record, { scope = "cn", spent = 0, remain = null, emails = [], notifications = [] } = {}) {
  const lines = [];
  const title = cleanText(record?.Title ?? "") || "（无标题）";
  lines.push(`# 文献详情：${title}`);
  lines.push("");

  const alt = cleanText(record?.Title_Alternative ?? "");
  if (alt) lines.push(`- 原题名/英文题名：${alt}`);
  const subhead = cleanText(record?.Title_Subhead ?? "");
  if (subhead) lines.push(`- 副题名：${subhead}`);

  const creators = splitList(record?.Creator);
  if (creators.length) lines.push(`- 作者：${creators.join("、")}`);
  const tutor = cleanText(record?.Contributor_Tutor ?? "");
  if (tutor) lines.push(`- 导师：${tutor}`);
  const organs = splitList(record?.Creator_Organ);
  if (organs.length) lines.push(`- 机构：${organs.join("；")}`);

  const source = cleanText(record?.Source_Name ?? "");
  const sourceAlt = cleanText(record?.Source_Name_Alternative ?? "");
  const year = cleanText(record?.Date_PublishYear ?? "");
  const volume = cleanText(record?.Source_Volume ?? "");
  const issue = cleanText(record?.Source_Issue ?? "");
  const pages = cleanText(record?.Description_PageInfo ?? "");
  const volIssue = volume ? `${volume}${issue ? `(${issue})` : ""}` : issue ? `(${issue})` : "";
  const srcLine = [source || cleanText(record?.Source_ConfName ?? "") || sourceAlt, year, volIssue, pages]
    .filter(Boolean)
    .join("，");
  if (srcLine) lines.push(`- 来源：${srcLine}`);
  if (sourceAlt && source && sourceAlt !== source) lines.push(`- 来源（外文）：${sourceAlt}`);

  const meta = [docType(record?.Doc_Type)];
  const lang = cleanText(record?.Language ?? "");
  if (lang) meta.push(`语言 ${lang}`);
  const country = cleanText(record?.Source_Country ?? "");
  if (country) meta.push(`国家/地区 ${country}`);
  const status = cleanText(record?.Type_Status ?? "");
  if (status) meta.push(`状态 ${status}`);
  lines.push(`- 类型：${meta.join(" | ")}`);

  const core = splitList(record?.Description_Core);
  if (core.length) lines.push(`- 核心收录：${core.map((c) => `[${c}]`).join(" ")}`);

  const doi = cleanText(record?.Identifier_DOI ?? "");
  if (doi) lines.push(`- DOI：${doi}`);
  const issn = cleanText(record?.Identifier_ISSN ?? "");
  if (issn) lines.push(`- ISSN：${issn}`);
  const isbn = cleanText(record?.Identifier_ISBN ?? "");
  if (isbn) lines.push(`- ISBN：${isbn}`);
  const cnNum = cleanText(record?.Identifier_CnNum ?? "");
  if (cnNum) lines.push(`- 国内统一刊号：${cnNum}`);
  const standard = cleanText(record?.Identifier_Standard ?? "");
  if (standard) lines.push(`- 标准号：${standard}`);
  const applyNum = cleanText(record?.Identifier_ApplicationNumber ?? "");
  if (applyNum) lines.push(`- 申请号：${applyNum}`);

  const keywords = splitList(record?.Subject_Keyword);
  if (keywords.length) lines.push(`- 关键词：${keywords.join("；")}`);
  const subjects = splitList(record?.Subject_CNLIB);
  if (subjects.length) lines.push(`- 中图分类号：${subjects.join("；")}`);
  const degree = cleanText(record?.Creator_Degree ?? "");
  if (degree) lines.push(`- 学位：${degree}`);
  const major = cleanText(record?.Creator_Major ?? "");
  if (major) lines.push(`- 专业：${major}`);

  const fund = cleanText(record?.Description_Fund ?? "");
  if (fund) lines.push(`- 基金资助：${fund}`);
  const award = cleanText(record?.Description_Cause ?? "");
  if (award) lines.push(`- 获奖/立项：${award}`);

  const abstract = cleanText(record?.Description ?? "");
  if (abstract) {
    lines.push("");
    lines.push(`**摘要**：${abstract}`);
  }

  const id = cleanText(record?.Identifier ?? "");
  if (id) {
    lines.push("");
    lines.push(`- 文献ID：\`${id}\``);
    const link = cleanText(record?.Identifier_DetailURL ?? "") || detailUrl(id);
    if (link) lines.push(`- SmartLib 详情页：${link}`);
    if (scope === "cn") lines.push(`- 全文下载：可用 \`smartlib_download\` 传入该文献ID获取授权中文期刊 PDF 链接`);
  }

  const sources = Array.isArray(record?.Source) ? record.Source.filter((s) => s && (s.Source_Link || s.Source_DbTitle)) : [];
  lines.push("");
  if (sources.length) {
    lines.push(`**原始数据库来源（可交叉验证真实性，共 ${sources.length} 个）**`);
    for (const s of sources) {
      const name = cleanText(s.Source_DbTitle ?? s.Source_DbId ?? "来源");
      const url = cleanText(s.Source_Link ?? "");
      lines.push(`- ${name}：${url || "（无链接）"}`);
    }
  } else {
    lines.push("**原始数据库来源**：该接口未返回 Source 链接（检索列表的 `Source` 恒为空数组，需详情接口；外文文献若无 DOI 可能为空）。");
  }

  lines.push("");
  lines.push(formatQuotaFooter({ spent, remain, emails }));
  const notes = formatNotifications(notifications);
  if (notes) lines.push(notes);
  return lines.join("\n").trim();
}

// ---- 下载 ----

export function formatDownloadResult({ identifier, url, spent, remain, emails, notifications }) {
  const lines = ["# 中文期刊全文下载链接", ""];
  lines.push(`- 文献ID：\`${identifier}\``);
  if (url) {
    lines.push(`- 下载链接：${url}`);
    lines.push("");
    lines.push("> 链接有效期约 10 分钟（以接口返回为准），过期请重新调用 `smartlib_download`。若在 Windows Git Bash 下 curl 下载失败（中文文件名 URL 编码问题），请改用浏览器直接打开，或用 Python `urllib.request` 拉取。");
  } else {
    lines.push("- 未取到下载链接：该文献可能无授权全文（仅 API 1/3 中文期刊支持全文下载，全球文献接口不提供全文）。");
  }
  lines.push("");
  lines.push(formatQuotaFooter({ spent, remain, emails }));
  const notes = formatNotifications(notifications);
  if (notes) lines.push(notes);
  return lines.join("\n").trim();
}

// ---- 配额 ----

export function formatQuotaReport(entries, { notifications = [], emails = [] } = {}) {
  const lines = ["# SmartLib 配额状态", ""];
  for (const entry of entries) {
    if (!entry.ok) {
      lines.push(`- **${entry.email}**：查询失败 — ${entry.error}${entry.registered ? "（已尝试自动注册）" : ""}`);
      continue;
    }
    const q = entry.quota ?? {};
    const remain = q.total_remain ?? "?";
    const total = q.trial_total != null && q.paid_total != null ? Number(q.trial_total) + Number(q.paid_total) : null;
    lines.push(`## ${entry.email}${entry.registered ? "（本次已自动注册）" : ""}`);
    lines.push("");
    lines.push(`- 检索额度：剩余 **${remain}**${total ? ` / 共 ${total}` : ""}（赠送 ${q.trial_remain ?? "?"} + 充值 ${q.paid_remain ?? "?"}）`);
    lines.push(`- 下载额度：剩余 **${q.download_remain ?? "?"}**（免费 ${q.download_quota_free ?? "?"} + 充值 ${q.download_paid_remain ?? "?"}）`);
    if (q.download_reset_at) lines.push(`- 额度重置时间：${q.download_reset_at}`);
    if (q.paid_expires_at) lines.push(`- 充值额度到期：${q.paid_expires_at}`);
    lines.push(`- 套餐：${q.plan ?? "trial"}｜邮箱已验证：${q.email_verified ? "是" : "否（仅充值时需要验证）"}`);
    const status = q.status ?? (Number(remain) > 0 ? "ok" : "quota_exhausted");
    lines.push(`- 状态：${status}`);
    if (Number(remain) <= 0) {
      lines.push(formatPlans(q.plans));
    } else if (Number(remain) <= 5) {
      lines.push(`- ⚠️ 接近用尽，可说「我要升级」查看套餐。`);
    }
    lines.push("");
  }
  if (emails.length > 1) {
    lines.push(`> 已配置 ${emails.length} 个邮箱，计费调用按顺序轮换使用仍有额度的邮箱。`);
  }
  const notes = formatNotifications(notifications);
  if (notes) lines.push(notes);
  return lines.join("\n").trim();
}

// ---- 静默/错误信封 ----

export function errorText(message) {
  return `SmartLib 操作失败：${message}`;
}
