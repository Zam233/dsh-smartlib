// tools/selftest.mjs — dsh-smartlib 自检。
//
//   node tools/selftest.mjs            # 纯离线单测（不联网、不消耗配额）
//   node tools/selftest.mjs --live     # 追加活网关集成测试（会消耗少量配额）
//
// 离线部分覆盖：引文启发式解析、分词/相似度、打分与分级、检索式构建、差异比对、格式化输出。

import {
  SmartLibGateway,
  API_PATH,
  pickList,
  pickRecord,
  mapLimit,
  SKILL_BASE,
  SKILL_CITATION
} from "../lib/gateway.js";
import {
  formatSearchResult,
  formatDetailResult,
  formatQuotaReport,
  formatPlans,
  docType,
  detailUrl
} from "../lib/format.js";
import {
  heuristicParse,
  normalizeCitations,
  coreWords,
  buildRules,
  titleSimilarity,
  authorSimilarity,
  scoreRecord,
  classify,
  diffFields,
  guessScope,
  verifyCitations,
  formatVerificationReport,
  nameTokens
} from "../lib/citations.js";

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = typeof expected === "function" ? expected(actual) : JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${label}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${label}\n      实际：${JSON.stringify(actual)}\n      期望：${typeof expected === "function" ? "(谓词)" : JSON.stringify(expected)}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

// ---- 1. 启发式解析 ----

section("1. 引用启发式解析");
{
  const gbt = heuristicParse(
    "[1] 张三, 李四. 深度学习综述[J]. 计算机学报, 2024, 45(3): 123-145."
  );
  check("GB/T 7714 题名", gbt.title, "深度学习综述");
  check("GB/T 7714 年份", gbt.year, "2024");
  check("GB/T 7714 作者", gbt.authors, ["张三", "李四"]);

  const apa = heuristicParse(
    "Band, S. S., Qasem, S. N., & Mosavi, A. (2026). Hybrid machine learning models for river sediment forecasting. Engineering Applications of Computational Fluid Mechanics, 20(1), 2591799."
  );
  check("APA 年份", apa.year, "2026");
  check("APA 题名含 hybrid", apa.title, (t) => /hybrid machine learning/i.test(t) && !/Band/.test(t));

  const book = heuristicParse("[2] 张伯伟. 全唐五代诗格汇考[M]. 南京: 江苏古籍出版社, 2002: 288.");
  check("图书 [M] 题名", book.title, "全唐五代诗格汇考");
  check("图书年份", book.year, "2002");

  const bib = heuristicParse("@article{zhang2024deep, author={Zhang, San}, title={Deep learning}, year={2024}}");
  check("BibTeX 兜底能取到年份", bib.year, "2024");

  const empty = heuristicParse("");
  check("空输入不炸", empty.title, "");
}

// ---- 2. 分词 / 相似度 ----

section("2. 题名相似度与作者比对");
{
  check(
    "完全相同的英文题名 = 1",
    titleSimilarity("deep learning for medical imaging", "Deep Learning for Medical Imaging"),
    (v) => v > 0.99
  );
  check(
    "高度相似的英文题名 > 0.7",
    titleSimilarity(
      "Hybrid machine learning and deep learning models for river suspended sediment load forecasting",
      "Hybrid machine learning and deep learning models for river suspended sediment load forecasting"
    ),
    (v) => v > 0.9
  );
  check(
    "不相关题名 < 0.2",
    titleSimilarity("deep learning for medical imaging", "soil moisture retrieval using GNSS-R"),
    (v) => v < 0.2
  );
  check(
    "中文题名相似度高",
    titleSimilarity("生成式AI技术在地学研究中的应用现状及发展趋势", "生成式AI技术在地学研究中的应用现状及发展趋势"),
    (v) => v > 0.9
  );
  check(
    "中文题名部分重合在 0.3~0.9",
    titleSimilarity("生成式AI技术在地学研究中的应用", "生成式AI技术在地学研究中的应用现状及发展趋势"),
    (v) => v > 0.3 && v < 1
  );
  check("无 token 返回 0", titleSimilarity("", "abc"), 0);

  check("全作者命中 = 1", authorSimilarity(["张三", "李四"], "张三;李四"), 1);
  check("半数作者命中 = 0.5", authorSimilarity(["张三", "王五"], "张三;李四"), 0.5);
  check("外文姓氏可比对", authorSimilarity(["Band, S. S.", "Mosavi, A."], "Band SS;Qasem SN;Mosavi A"), 1);
  check("缺作者返回 null", authorSimilarity([], "张三"), null);

  // 回归：SmartLib 全球库作者字段为「缩写在前」写法（S. Band, Shahab），
  // 引文侧多为 APA（Band, S. S.），必须仍能判为同一人。
  const globalStyle = "S. Band, Shahab;Qasem, Sultan Noman;Mansor, Zulkefli;Pai, Hao-Ting;Mehdizadeh, Saeid;Gupta, Brij B.;Mosavi, Amir";
  check("缩写在前格式：单片作者命中", authorSimilarity(["Band, S. S."], globalStyle), 1);
  check("缩写在前格式：多作者命中", authorSimilarity(["Band, S. S.", "Mosavi, A."], globalStyle), 1);
  check("缩写在前格式：不存在的作者 = 0", authorSimilarity(["Nonexistent, Q."], globalStyle), 0);
  check("全大写姓氏可比对", authorSimilarity(["BAND S"], "S. Band, Shahab"), 1);
  check("不因词元子串误判", authorSimilarity(["Li, Y."], "Zulkefli Mansor;Saeid Mehdizadeh"), 0);
  check("nameTokens 丢掉单字母缩写", nameTokens("S. Band, Shahab"), ["band", "shahab"]);
}

// ---- 3. 检索式构建 ----

section("3. 检索式构建");
{
  const en = buildRules({ title: "Hybrid machine learning and deep learning models for river sediment load", year: "2026" });
  check("优先级1 带年份", en[0], (r) => /^\(T=.*\) AND Y=2026$/.test(r));
  check("去停用词", en[0], (r) => !/\b(for|the|and)\b/.test(r));
  check("优先级2 无年份", en[1], (r) => /^T=/.test(r) && !/Y=/.test(r));

  const cnCite = buildRules({ title: "生成式AI技术在地学研究中的应用现状及发展趋势", year: "2025" });
  check("中文题名走 T= 且带年份", cnCite[0], (r) => /^\(T=.+\) AND Y=2025$/.test(r));
  check("中文回退式更短", cnCite[1].length, (v) => v < cnCite[0].length);

  check("无年份时只有 T=", buildRules({ title: "deep learning models" })[0], "T=deep learning models");
  check("题名缺失时退化为 U=", buildRules({ title: "", raw: "some reference text here" })[0], (r) => r.startsWith("U="));

  check("coreWords 上限", coreWords("a an the one two three four five six seven eight", 3).length, (v) => v <= 3);

  check("中文猜测 cn 库", guessScope({ title: "深度学习在医学影像中的应用" }), "cn");
  check("英文猜测 global 库", guessScope({ title: "Deep learning for medical imaging" }), "global");
  check("带 DOI 猜测 global 库", guessScope({ title: "深度学习", doi: "10.1/x" }), "global");
}

// ---- 4. 打分与分级 ----

section("4. 打分与分级");
{
  const cite = { title: "Hybrid machine learning models for river sediment load", year: "2026", authors: ["Band, S. S.", "Mosavi, A."] };
  const record = {
    Title: "Hybrid machine learning and deep learning models for river suspended sediment load forecasting",
    Creator: "Band SS;Qasem SN;Mansor Z;Mosavi A",
    Date_PublishYear: "2026",
    Source_Name: "Engineering Applications of Computational Fluid Mechanics",
    Identifier: "999"
  };
  const scored = scoreRecord(cite, record);
  check("高分匹配 >= 0.85", scored.score, (v) => v >= 0.85);
  check("分级为 VERIFIED", classify(scored.score), "VERIFIED");
  check("年份分项 = 1", scored.parts.year, 1);

  const wrongYear = scoreRecord(cite, { ...record, Date_PublishYear: "2019" });
  check("年份错位后分数下降", wrongYear.score, (v) => v < scored.score);
  check("年份错位分项 = 0", wrongYear.parts.year, 0);

  const doiCite = { title: "完全不同的题名", doi: "10.1234/abc.2024.001" };
  const doiRec = { Title: "另一个题名", Identifier_DOI: "https://doi.org/10.1234/ABC.2024.001" };
  check("DOI 精确命中直接判通过", scoreRecord(doiCite, doiRec).score, (v) => v >= 0.98);

  check("分级 MISMATCH", classify(0.7), "MISMATCH");
  check("分级 FUZZY_MATCH", classify(0.5), "FUZZY_MATCH");
  check("分级 NOT_FOUND", classify(0.2), "NOT_FOUND");
}

// ---- 5. 差异比对 ----

section("5. 差异比对");
{
  const cite = {
    title: "Deep learning for medical imaging",
    year: "2023",
    authors: ["Zhang, S.", "Wang, L."],
    journal: "Journal of Medical Imaging",
    doi: "10.1111/wrong"
  };
  const record = {
    Title: "Deep learning for medical image analysis",
    Date_PublishYear: "2024",
    Creator: "Zhang S;Li Y",
    Source_Name: "Journal of Medical Imaging Research",
    Identifier_DOI: "10.1111/right"
  };
  const diffs = diffFields(cite, record);
  const fields = diffs.map((d) => d.field);
  check("检出年份差异", fields.includes("年份"), true);
  check("检出作者差异", fields.includes("作者"), true);
  check("检出 DOI 差异", fields.includes("DOI"), true);
  check("期刊名互相包含时不报差异", fields.includes("期刊/来源"), false);
  check("年份差异标记为 error", diffs.find((d) => d.field === "年份")?.kind, "error");

  const infoDiff = diffFields({ title: record.Title, year: "2024" }, record);
  check("缺失 DOI 记为 info（仅补全提示）", infoDiff.find((d) => d.field === "DOI")?.kind, "info");

  const cleanRecord = { ...record, Identifier_DOI: "" };
  check(
    "完全一致时无差异",
    diffFields({ title: record.Title, year: "2024", authors: ["Zhang S", "Li Y"] }, cleanRecord).length,
    0
  );
  check(
    "仅缺 DOI 时只产生 1 条 info 差异",
    diffFields({ title: record.Title, year: "2024", authors: ["Zhang S", "Li Y"] }, record).length,
    1
  );
}

// ---- 6. 入参归一化 ----

section("6. 引文入参归一化");
{
  const mixed = normalizeCitations([
    "张三. 深度学习综述[J]. 计算机学报, 2024, 45(3): 123-145.",
    { title: "Attention is all you need", year: 2017, authors: "Vaswani A;Shazeer N", doi: "10.5555/3295222" }
  ]);
  check("字符串被启发式解析", mixed[0].title, "深度学习综述");
  check("对象被结构化", mixed[1].title, "Attention is all you need");
  check("数字年份转字符串", mixed[1].year, "2017");
  check("分号作者串被拆分", mixed[1].authors, ["Vaswani A", "Shazeer N"]);
  check("索引保序", mixed.map((c) => c.index), [0, 1]);
  check("未知元素不炸", normalizeCitations([null, 42]).length, 2);
}

// ---- 7. 响应解析与格式化 ----

section("7. 响应解析与格式化");
{
  const semantic = { succeeded: true, data: { list: [{ Title: "A" }], total: 5 } };
  const proxy = { StatusCode: 200, Succeeded: true, Data: { Total: 7, List: [{ Title: "B" }] } };
  check("语义化端点小写解析", pickList(semantic).total, 5);
  check("代理模式 PascalCase 解析", pickList(proxy).total, 7);
  check("空响应不炸", pickList(null).list, []);
  check("详情记录兼容 data 外壳", pickRecord({ data: { Title: "x" } }).Title, "x");
  check("详情记录兼容 Data 外壳", pickRecord({ Data: { Title: "y" } }).Title, "y");

  check("文献类型映射", docType(3), "期刊文献");
  check("未知文献类型不炸", docType(99), (v) => typeof v === "string");
  check("详情页 URL 构造", detailUrl("42031597892446"), (v) => v.includes("42031597892446"));

  const searchText = formatSearchResult({
    scope: "cn",
    rule: "K=人工智能",
    sort: 1,
    page: 1,
    pageSize: 20,
    total: 186425,
    papers: [
      {
        Title: "生成式AI技术在地学研究中的应用现状及发展趋势",
        Creator: "周圣荃;李以科",
        Source_Name: "地学前缘",
        Date_PublishYear: "2025",
        Source_Volume: "32",
        Source_Issue: "4",
        Doc_Type: 3,
        Language: "ZH",
        Description: "摘要正文",
        Subject_Keyword: "人工智能;ChatGPT",
        Identifier: "42031597892446"
      }
    ],
    spent: 1,
    remain: 40,
    emails: ["a@b.c"]
  });
  check("检索结果含标题", searchText, (t) => t.includes("生成式AI技术"));
  check("检索结果含配额页脚", searchText, (t) => t.includes("本次消耗 1 次") && t.includes("剩余 40 次"));
  check("检索结果含详情页链接", searchText, (t) => t.includes("web_searchingDetail"));
  check("空结果给出扩检建议", formatSearchResult({ scope: "cn", rule: "K=x", sort: 1, page: 1, pageSize: 20, papers: [], total: 0 }), (t) => t.includes("未检索到结果"));

  const detailText = formatDetailResult(
    {
      Title: "生成式AI技术在地学研究中的应用现状及发展趋势",
      Creator: "周圣荃;李以科",
      Source_Name: "地学前缘",
      Date_PublishYear: "2025",
      Identifier_DOI: "10.13745/j.esf.sf.2025.4.68",
      Description_Core: "EI;CSCD",
      Identifier: "42031597892446",
      Source: [{ Source_DbTitle: "Scopus", Source_Link: "https://www.scopus.com/x" }]
    },
    { scope: "cn", spent: 1, remain: 39, emails: [] }
  );
  check("详情含 DOI", detailText, (t) => t.includes("10.13745/j.esf.sf.2025.4.68"));
  check("详情含核心收录", detailText, (t) => t.includes("[EI]") && t.includes("[CSCD]"));
  check("详情含原始数据库链接", detailText, (t) => t.includes("Scopus") && t.includes("https://www.scopus.com/x"));
  check("详情提示可下载全文", detailText, (t) => t.includes("smartlib_download"));

  const quotaText = formatQuotaReport([
    {
      ok: true,
      email: "a@b.c",
      quota: { total_remain: 0, trial_total: 100, paid_total: 0, trial_remain: 0, paid_remain: 0, download_remain: 10, plan: "trial", status: "quota_exhausted", plans: [{ key: "trial_card", name: "体验卡", price: 9.9, search: 1000, download: 20, days: 7 }] }
    }
  ]);
  check("配额报告含剩余额度", quotaText, (t) => t.includes("剩余 **0**"));
  check("配额耗尽时给出套餐", quotaText, (t) => t.includes("体验卡"));
  check("套餐表可单独渲染", formatPlans(null), (t) => t.includes("个人版月"));
}

// ---- 8. 并发批次保序 ----

section("8. mapLimit 保序与限流");
{
  let active = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9], 3, async (n) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
    return n * 2;
  });
  check("结果保序", out, [2, 4, 6, 8, 10, 12, 14, 16, 18]);
  check("并发不超限", peak, (v) => v <= 3);
  check("空数组安全", await mapLimit([], 8, async () => 1), []);
}

// ---- 9. 网关客户端（离线行为） ----

section("9. 网关客户端离线行为");
{
  const unconfigured = new SmartLibGateway({ gateway_url: "", gateway_secret: "", emails: [] });
  check("未配置时 configured=false", unconfigured.configured, false);
  check("未配置时给出中文错误", unconfigured.configError, (t) => /未配置/.test(t));

  const noEmail = new SmartLibGateway({ gateway_url: "https://x", gateway_secret: "s", emails: [] });
  check("缺邮箱时提示配置邮箱", noEmail.configError, (t) => t.includes("邮箱"));

  const gw = new SmartLibGateway({ gateway_url: "https://x/", gateway_secret: "s", emails: ["a@b.c"] });
  check("网关地址去掉尾斜杠", gw.gateway, "https://x");
  check("API 路径常量齐全", Object.keys(API_PATH).length, 5);
  check("中文详情路径", API_PATH.detailCn, "/openapi/t/data0011/doccenter/Articledetail");
  check("全球详情路径", API_PATH.detailGlobal, "/openapi/t/skrs1/doccenter/Articledetail");
  check("下载路径", API_PATH.downloadCn, "/openapi/t/data0013/doccenter/GetArticleFile");
  check("技能来源常量", [SKILL_BASE, SKILL_CITATION], ["global-biblio-base", "smartlib-citation-checker"]);
}

// ---- 10. HTTP 200 业务失败识别（mock fetch，不消耗配额） ----

section("10. 网关业务失败与外壳兼容（mock fetch）");
{
  const realFetch = globalThis.fetch;
  const GW = "https://gw.test";

  /** 用一组路由 stub 掉 fetch；返回记录到的请求数组。 */
  function stubFetch(routes) {
    const seen = [];
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      let body;
      try {
        body = opts?.body ? JSON.parse(opts.body) : undefined;
      } catch {
        body = undefined;
      }
      seen.push({ url: u, body });
      for (const [fragment, handler] of routes) {
        if (u.includes(fragment)) {
          const out = typeof handler === "function" ? handler(body, seen.length) : handler;
          return { status: out.status, text: async () => JSON.stringify(out.json) };
        }
      }
      return { status: 404, text: async () => JSON.stringify({ error: "not_found" }) };
    };
    return seen;
  }
  const okConsume = { status: 200, json: { consume_token: "tok", total_remain: 42 } };
  const gwWith = (routes) => {
    stubFetch([["/consume", okConsume], ...routes]);
    return new SmartLibGateway({ gateway_url: GW, gateway_secret: "s", emails: ["a@b.c"] });
  };

  // 正常的 PascalCase 代理响应
  let gw = gwWith([["/search", { status: 200, json: { StatusCode: 200, Succeeded: true, Data: { Total: 3, List: [{ Title: "A" }] }, notifications: [] } }]]);
  let r = await gw.search("cn", "K=人工智能", { pageSize: 2 });
  check("正常 PascalCase 响应判为成功", r.ok, true);
  check("正常响应解析出命中数", pickList(r.body).total, 3);
  check("正常响应计入消耗 1 次", gw.spent, 1);

  // 小写外壳（旧版语义化端点）仍应判成功
  gw = gwWith([["/search", { status: 200, json: { succeeded: true, data: { list: [{ Title: "B" }], total: 7 }, msg: null } }]]);
  r = await gw.search("cn", "K=人工智能", { pageSize: 2 });
  check("小写外壳仍判为成功", r.ok, true);
  check("小写外壳解析出命中数", pickList(r.body).total, 7);

  // ★ 关键回归：HTTP 200 + Succeeded:false（上游故障）必须报错，不能当成「无结果」
  gw = gwWith([["/search", { status: 200, json: { StatusCode: 200, Succeeded: false, Errors: "系统异常，请联系管理员", Data: null, notifications: [] } }]]);
  r = await gw.search("cn", "K=人工智能", { pageSize: 2 });
  check("HTTP200+Succeeded:false 判为失败", r.ok, false);
  check("失败原因透传网关原文", r.error, (e) => /系统异常/.test(e));
  check("给出上游故障提示", r.error, (e) => /上游检索服务/.test(e));
  check("标记为 upstreamError", r.upstreamError, true);
  check("业务失败仍如实计入消耗", gw.spent, 1);
  console.log(`     故障时的报错文案：${r.error}`);

  // 小写外壳的业务失败同样要报出来
  gw = gwWith([["/search", { status: 200, json: { succeeded: false, msg: "请输入正确的检索表达式" } }]]);
  r = await gw.search("cn", "K=", { pageSize: 2 });
  check("小写外壳业务失败判为失败", r.ok, false);
  check("透传 msg 原文", r.error, (e) => /请输入正确的检索表达式/.test(e));
  check("语法类错误不误加故障提示", r.error, (e) => !/上游检索服务/.test(e));

  // Errors 为数组时也要能读出来
  gw = gwWith([["/search", { status: 200, json: { Succeeded: false, Errors: ["字段 T 非法", "缺少 Rule"] } }]]);
  r = await gw.search("cn", "T=", { pageSize: 2 });
  check("Errors 数组可解析", r.error, (e) => /字段 T 非法/.test(e) && /缺少 Rule/.test(e));

  // 全部邮箱配额耗尽
  stubFetch([["/consume", { status: 429, json: { status: "quota_exhausted", message: "赠送额度和充值额度均已用完", plans: [{ key: "trial_card", name: "体验卡", price: 9.9 }] } }]]);
  gw = new SmartLibGateway({ gateway_url: GW, gateway_secret: "s", emails: ["a@b.c", "d@e.f"] });
  r = await gw.search("cn", "K=x", { pageSize: 2 });
  check("全部邮箱耗尽判为 quotaExhausted", r.quotaExhausted, true);
  check("耗尽时保留套餐列表", gw.lastPlans, (v) => Array.isArray(v) && v.length === 1);

  // 401 后自动重新 consume 再试一次
  let searchHits = 0;
  stubFetch([
    ["/consume", okConsume],
    ["/search", () => {
      searchHits += 1;
      return searchHits === 1
        ? { status: 401, json: { error: "missing_token" } }
        : { status: 200, json: { Succeeded: true, Data: { Total: 1, List: [{ Title: "C" }] } } };
    }]
  ]);
  gw = new SmartLibGateway({ gateway_url: GW, gateway_secret: "s", emails: ["a@b.c"] });
  r = await gw.search("cn", "K=x", { pageSize: 2 });
  check("401 后自动重试成功", r.ok, true);
  check("确实重发了 search", searchHits, 2);
  check("重试成功只计 1 次消耗", gw.spent, 1);

  // 未注册邮箱：/quota 404 → 自动注册 → 重查
  let registered = false;
  stubFetch([
    ["/register", () => {
      registered = true;
      return { status: 201, json: { ok: true } };
    }],
    ["/quota", (body, n) => (registered
      ? { status: 200, json: { total_remain: 100, download_remain: 10, plan: "trial" } }
      : { status: 404, json: { error: "not_registered" } })]
  ]);
  gw = new SmartLibGateway({ gateway_url: GW, gateway_secret: "s", emails: ["new@user.com"] });
  const q = await gw.quota("new@user.com");
  check("404 时自动注册并重查", q.ok, true);
  check("标记为本次已注册", q.registered, true);
  check("拿到注册后额度", q.quota.total_remain, 100);

  // 通知收集去重
  gw = gwWith([["/search", { status: 200, json: { Succeeded: true, Data: { Total: 0, List: [] }, notifications: [{ text: "系统维护通知", url: "https://x" }] } }]]);
  await gw.search("cn", "K=x", { pageSize: 2 });
  await gw.search("cn", "K=y", { pageSize: 2 });
  check("通知去重后仅一条", gw.notifications.length, 1);
  check("通知文本保留", gw.notifications[0].text, "系统维护通知");

  // ★ 熔断：上游故障后同批次后续调用直接跳过，不再联网、不再计费
  let upstreamCalls = 0;
  stubFetch([
    ["/consume", okConsume],
    ["/search", () => {
      upstreamCalls += 1;
      return { status: 200, json: { Succeeded: false, Errors: "系统异常，请联系管理员" } };
    }]
  ]);
  gw = new SmartLibGateway({ gateway_url: GW, gateway_secret: "s", emails: ["a@b.c", "d@e.f"] });
  const first = await gw.search("cn", "K=第一条", { pageSize: 2 });
  check("首次上游故障判为失败", first.ok, false);
  check("故障后触发熔断", gw.aborted, true);
  check("熔断后消耗 1 次", gw.spent, 1);
  const second = await gw.search("cn", "K=第二条", { pageSize: 2 });
  check("熔断后第二次调用直接跳过", second.aborted, true);
  check("熔断后不再发起网络请求", upstreamCalls, 1);
  check("熔断后不再增加消耗", gw.spent, 1);
  check("跳过原因含中止说明", second.error, (e) => /已跳过/.test(e));

  // 同样是失败，但属于「检索式非法」时不应熔断（换检索式仍可能成功）
  stubFetch([
    ["/consume", okConsume],
    ["/search", { status: 200, json: { Succeeded: false, Errors: "请输入正确的检索表达式" } }]
  ]);
  gw = new SmartLibGateway({ gateway_url: GW, gateway_secret: "s", emails: ["a@b.c"] });
  await gw.search("cn", "K=", { pageSize: 2 });
  check("检索式非法不熔断", gw.aborted, false);

  globalThis.fetch = realFetch;
}

// ---- 11. 核查状态判定：上游故障 ≠ 文献造假（stub 网关，不消耗配额） ----

section("11. 核查状态判定（上游故障 vs 真未找到）");
{
  // 上游故障：第一次调用后熔断
  const failingGateway = {
    aborted: false,
    abortedReason: "",
    calls: 0,
    async search() {
      this.calls += 1;
      this.aborted = true;
      this.abortedReason = "SmartLib 上游检索服务异常（系统异常，请联系管理员）";
      return { ok: false, upstreamError: true, aborted: true, error: "SmartLib 返回业务失败：系统异常，请联系管理员" };
    }
  };
  const res = await verifyCitations(
    failingGateway,
    normalizeCitations([{ title: "Attention is all you need", year: "2017" }]),
    { batchSize: 1 }
  );
  check("上游故障时判为 SKIPPED", res[0].status, "SKIPPED");
  check("绝不误判为 NOT_FOUND", res[0].status === "NOT_FOUND", false);
  check("SKIPPED 保留失败原因", res[0].error, (e) => /系统异常/.test(e ?? ""));

  // 已熔断的网关：后续引文直接跳过，连一次网络调用都不发
  const alreadyAborted = {
    aborted: true,
    abortedReason: "上游检索服务异常",
    calls: 0,
    async search() {
      this.calls += 1;
      throw new Error("熔断后不应再发起检索");
    }
  };
  const res2 = await verifyCitations(
    alreadyAborted,
    normalizeCitations([{ title: "Another paper", year: "2020" }, { title: "Yet another", year: "2021" }]),
    { batchSize: 2 }
  );
  check("已熔断时全部标为 SKIPPED", res2.map((r) => r.status), ["SKIPPED", "SKIPPED"]);
  check("已熔断时零次检索调用", alreadyAborted.calls, 0);

  // 真正的空结果：才应判 NOT_FOUND
  const emptyGateway = {
    aborted: false,
    async search() {
      return { ok: true, body: { Succeeded: true, Data: { Total: 0, List: [] } } };
    }
  };
  const res3 = await verifyCitations(
    emptyGateway,
    normalizeCitations([{ title: "zzqqxx nonexistent fabricated title 12345", year: "2011" }]),
    { batchSize: 1 }
  );
  check("真正无结果才判 NOT_FOUND", res3[0].status, "NOT_FOUND");
  check("NOT_FOUND 不带错误信息", res3[0].error, null);

  // 命中：判 VERIFIED 并产出差异/候选
  const hitGateway = {
    aborted: false,
    async search() {
      return {
        ok: true,
        body: {
          Succeeded: true,
          Data: {
            Total: 1,
            List: [
              {
                Title: "Deep learning for medical image analysis",
                Creator: "Zhang S;Li Y",
                Date_PublishYear: "2024",
                Source_Name: "Journal of Medical Imaging",
                Identifier: "12345"
              }
            ]
          }
        }
      };
    }
  };
  const res4 = await verifyCitations(
    hitGateway,
    normalizeCitations([{ title: "Deep learning for medical image analysis", year: "2023", authors: ["Zhang, S."] }]),
    { batchSize: 1 }
  );
  check("命中时判 VERIFIED/MISMATCH", res4[0].status, (s) => s === "VERIFIED" || s === "MISMATCH");
  check("命中时给出数据库记录", res4[0].matched.title, "Deep learning for medical image analysis");
  check("命中时给出差异清单", res4[0].diffs.length, (n) => n >= 1);
  check("候选列表已填充", res4[0].candidates.length, (n) => n >= 1);
}

// ---- 12. 活网关集成（--live） ----
//
// 凭证一律不写进仓库，改由环境变量提供：
//   SMARTLIB_GATEWAY_URL     例 https://<gateway-host>
//   SMARTLIB_GATEWAY_SECRET  网关 Bearer 密钥（sk-...）
//   SMARTLIB_TEST_EMAILS     逗号分隔的测试邮箱列表

function liveConfigFromEnv(env = process.env) {
  const url = String(env.SMARTLIB_GATEWAY_URL ?? "").trim();
  const secret = String(env.SMARTLIB_GATEWAY_SECRET ?? "").trim();
  const emails = String(env.SMARTLIB_TEST_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!url || !secret || emails.length === 0) return null;
  return { gateway_url: url, gateway_secret: secret, emails };
}

const liveCfg = process.argv.includes("--live") ? liveConfigFromEnv() : null;

if (process.argv.includes("--live") && !liveCfg) {
  section("12. 活网关集成测试");
  console.log("  ⏭ 已跳过：请设置 SMARTLIB_GATEWAY_URL / SMARTLIB_GATEWAY_SECRET / SMARTLIB_TEST_EMAILS 后重试");
}

if (liveCfg) {
  section("12. 活网关集成测试（消耗配额）");
  const cfg = liveCfg;
  const gateway = new SmartLibGateway(cfg);

  const q = await gateway.quota(cfg.emails[0]);
  check("配额查询成功", q.ok, true);
  console.log(`     剩余检索 ${q.quota?.total_remain} 次 / 下载 ${q.quota?.download_remain} 次`);

  const search = await gateway.search("cn", "K=人工智能", { pageSize: 3, skillSource: SKILL_BASE });
  check("中文检索成功", search.ok, true);
  const parsed = pickList(search.body);
  console.log(`     命中 ${parsed.total} 条，返回 ${parsed.list.length} 条`);
  check("命中数 > 0", parsed.total, (v) => v > 0);

  const globalSearch = await gateway.search("global", "T=deep learning", { pageSize: 3, skillSource: SKILL_BASE });
  check("全球检索成功", globalSearch.ok, true);

  if (parsed.list.length) {
    const id = parsed.list[0].Identifier;
    const detail = await gateway.detail("cn", id, { skillSource: SKILL_BASE });
    check("详情查询成功", detail.ok, true);
    const record = pickRecord(detail.body);
    check("详情含 DOI 或核心收录字段", Boolean(record.Identifier_DOI || record.Description_Core), true);
    console.log(`     原始数据库来源 ${Array.isArray(record.Source) ? record.Source.length : 0} 个`);
  }

  const verify = await verifyCitations(
    gateway,
    normalizeCitations([
      {
        title: "Hybrid machine learning and deep learning models for river suspended sediment load forecasting",
        year: "2026",
        authors: ["Band, S. S."],
        scope: "global"
      },
      { title: "完全不存在的题名用于测试未找到分支 zzqqxxyy12345", year: "2011", scope: "global" },
      {
        title: "生成式AI技术在地学研究中的应用现状及发展趋势",
        year: "2025",
        authors: ["周圣荃", "李以科"],
        scope: "cn"
      }
    ]),
    { batchSize: 3, maxCandidates: 3 }
  );
  check("核查返回三条结果", verify.length, 3);
  check("真实外文文献判为 VERIFIED/MISMATCH", verify[0].status, (s) => s === "VERIFIED" || s === "MISMATCH");
  check("虚假文献判为 NOT_FOUND/FUZZY", verify[1].status, (s) => s === "NOT_FOUND" || s === "FUZZY_MATCH");
  check("中文题名检索式链路可用", verify[2].status, (s) => s !== "SKIPPED");
  console.log(
    `     条目1 ${verify[0].status} (${verify[0].score}) ｜ 条目2 ${verify[1].status} (${verify[1].score}) ｜ 条目3(中文) ${verify[2].status} (${verify[2].score})`
  );

  const report = formatVerificationReport(verify, { spent: gateway.spent, remain: gateway.lastRemain, emails: gateway.emails });
  check("报告含总表", report, (t) => t.includes("核查总表"));
  check("报告含配额页脚", report, (t) => t.includes("本次消耗"));
  console.log(`\n     本次共消耗 ${gateway.spent} 次配额，剩余 ${gateway.lastRemain} 次`);
}

console.log(`\n${failed === 0 ? "✅ 全部通过" : "❌ 存在失败"}：${passed} 通过，${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
