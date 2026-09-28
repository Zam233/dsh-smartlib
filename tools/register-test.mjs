// tools/register-test.mjs — 验证插件注册路径（defineTool 参数 DSL 编译 + 工具真跑）。
//
//   node tools/register-test.mjs          # 只校验注册与 schema 编译（不联网）
//   node tools/register-test.mjs --live   # 追加 5 个工具的端到端调用（消耗少量配额）
//
// 说明：ESM 需要能解析 peer 依赖，故本目录下需存在 node_modules 软链（见 README「开发」）。

const stub = { gateway_url: "", gateway_secret: "", emails: [] };

const { apply, Config, inject, name } = await import("../lib/index.js");

const registered = new Map();
const sections = [];
const ctx = {
  systemPrompt: { section: (s) => sections.push(s) },
  tools: { register: (tool) => registered.set(tool.name, tool) }
};

let failed = 0;
function check(label, ok, extra = "") {
  if (ok) console.log(`  ✅ ${label}`);
  else {
    failed += 1;
    console.log(`  ❌ ${label}${extra ? `\n      ${extra}` : ""}`);
  }
}

console.log("=== 注册表 ===");
console.log(`  name = ${name}`);
console.log(`  inject = ${JSON.stringify(inject)}`);

// 先用空配置注册，确认 schema 能编译（defineTool 会在这一步校验参数 DSL）
apply(ctx, stub);
check("apply() 未抛异常", true);
check("5 个工具已注册", registered.size === 5, `实际 ${registered.size}: ${[...registered.keys()].join(", ")}`);
check("系统提示段落已注册", sections.length >= 1 && sections[0].name === "tool:smartlib");
check(
  "工具名符合预期",
  ["smartlib_search", "smartlib_detail", "smartlib_download", "smartlib_quota", "smartlib_verify_citations"].every((n) => registered.has(n))
);

// 逐个检查编译后的 JSON Schema
console.log("\n=== 参数 Schema 编译结果 ===");
for (const [toolName, tool] of registered) {
  const params = tool.parameters;
  const props = Object.keys(params?.properties ?? {});
  const required = params?.required ?? [];
  console.log(`  ${toolName}: 参数[${props.join(", ")}] 必填[${required.join(", ") || "无"}] timeout=${tool.timeoutMs}ms`);
  check(`${toolName} 有参数 schema`, props.length > 0 || toolName === "smartlib_quota");
}

const verifyTool = registered.get("smartlib_verify_citations");
check(
  "verify 工具 citations 编译为数组",
  verifyTool.parameters.properties.citations.type === "array",
  JSON.stringify(verifyTool.parameters.properties.citations).slice(0, 200)
);
check(
  "verify 工具 citations.items 保留 oneOf 分支",
  Array.isArray(verifyTool.parameters.properties.citations.items?.oneOf) &&
    verifyTool.parameters.properties.citations.items.oneOf.length === 2
);
check("search 工具 scope 枚举齐备", JSON.stringify(registered.get("smartlib_search").parameters.properties.scope.enum) === JSON.stringify(["cn", "global", "both"]));
check("detail 工具 identifier 必填", (registered.get("smartlib_detail").parameters.required ?? []).includes("identifier"));
check("download 工具 identifier 必填", (registered.get("smartlib_download").parameters.required ?? []).includes("identifier"));
check("search 工具 timeoutMs 合理", registered.get("smartlib_search").timeoutMs >= 30_000);
check("verify 工具 timeoutMs 更长", verifyTool.timeoutMs > registered.get("smartlib_search").timeoutMs);

// 描述里必须带上关键的约束，否则模型会误用
const searchDesc = registered.get("smartlib_search").description;
check("search 描述含单关键词约束", /单一关键词|禁止组合/.test(searchDesc));
check("search 描述含检索字段说明", /T=题名/.test(searchDesc));
check("search 描述含计费说明", /配额/.test(searchDesc));
check("verify 描述含打分权重", /60%/.test(verifyTool.description));
check("verify 描述含状态分级", /VERIFIED/.test(verifyTool.description));
check("verify 描述指向 HTML 报告技能", /smartlib-citation-check/.test(verifyTool.description));
check("detail 描述点明 Source 链接只有详情接口返回", /Source/.test(registered.get("smartlib_detail").description));

// 空配置下的失败路径
console.log("\n=== 错误路径 ===");
const searchTool = registered.get("smartlib_search");
const noCfg = await searchTool.execute({ query: "人工智能" }, {});
check("空配置返回中文提示而非抛异常", /未配置/.test(noCfg.text), noCfg.text);

// 缺少「都没有必填标记」的参数组合时，由工具内部的守卫给出中文提示
const noQueryNoRule = await searchTool.execute({}, {});
check("既无 query 也无 rule 时给出中文提示", /缺少检索参数/.test(noQueryNoRule.text), noQueryNoRule.text);

// 必填参数与枚举由 defineTool 在 execute 之前校验（抛 ToolArgsError，模型可直接看到违规明细）
async function expectReject(label, fn) {
  try {
    await fn();
    check(label, false, "期望被 schema 拒绝，但成功执行了");
  } catch (err) {
    check(label, err?.code === "INVALID_ARGS" || /invalid arguments/i.test(err?.message ?? ""), `抛出了 ${err?.name}: ${err?.message}`);
  }
}
await expectReject("缺 identifier 被 schema 拒绝", () => registered.get("smartlib_detail").execute({}, {}));
await expectReject("非法 scope 被 schema 拒绝", () => searchTool.execute({ query: "x", scope: "not-a-scope" }, {}));
await expectReject("verify 缺 citations 被 schema 拒绝", () => registered.get("smartlib_verify_citations").execute({}, {}));
await expectReject("verify 传入非法 scope 被 schema 拒绝", () =>
  registered.get("smartlib_verify_citations").execute({ citations: ["x"], scope: "bogus" }, {})
);

// ---- 活调用 ----
//
// 凭证一律不写进仓库，改由环境变量提供（与 tools/selftest.mjs --live 相同）：
//   SMARTLIB_GATEWAY_URL / SMARTLIB_GATEWAY_SECRET / SMARTLIB_TEST_EMAILS

function liveConfigFromEnv(env = process.env) {
  const url = String(env.SMARTLIB_GATEWAY_URL ?? "").trim();
  const secret = String(env.SMARTLIB_GATEWAY_SECRET ?? "").trim();
  const emails = String(env.SMARTLIB_TEST_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!url || !secret || emails.length === 0) return null;
  return { gateway_url: url, gateway_secret: secret, emails, batch_size: 2 };
}

const liveCfg = process.argv.includes("--live") ? liveConfigFromEnv() : null;

if (process.argv.includes("--live") && !liveCfg) {
  console.log("\n=== 活调用 ===");
  console.log("  ⏭ 已跳过：请设置 SMARTLIB_GATEWAY_URL / SMARTLIB_GATEWAY_SECRET / SMARTLIB_TEST_EMAILS 后重试");
}

if (liveCfg) {
  console.log("\n=== 活调用（消耗配额）===");
  const live = liveCfg;
  const liveTools = new Map();
  apply({ systemPrompt: { section: () => {} }, tools: { register: (t) => liveTools.set(t.name, t) } }, live);

  const quota = await liveTools.get("smartlib_quota").execute({ email: live.emails[0] }, {});
  check("smartlib_quota 返回配额报告", /配额状态/.test(quota.text));
  console.log(`     ${quota.text.split("\n").find((l) => l.includes("检索额度"))?.trim()}`);

  const search = await liveTools.get("smartlib_search").execute({ query: "人工智能", page_size: 3 }, {});
  check("smartlib_search 返回结果", /SmartLib 检索结果/.test(search.text) && /命中总量/.test(search.text));
  check("smartlib_search 输出配额页脚", /本次消耗 \d+ 次/.test(search.text));
  check("smartlib_search 耗尽邮箱自动轮换", !/配额已用尽/.test(search.text));

  const identifier = search.text.match(/文献ID：`(\d+)`/)?.[1];
  check("能从结果中取到文献ID", Boolean(identifier));

  if (identifier) {
    const detail = await liveTools.get("smartlib_detail").execute({ identifier }, {});
    check("smartlib_detail 返回详情", /文献详情/.test(detail.text));
    const download = await liveTools.get("smartlib_download").execute({ identifier }, {});
    check("smartlib_download 返回下载区块", /全文下载链接/.test(download.text), download.text.slice(0, 160));
  }

  const verify = await liveTools.get("smartlib_verify_citations").execute(
    {
      citations: [
        { title: "Attention is all you need", year: "2017", authors: ["Vaswani, A."], scope: "global" },
        "查无此文献的测试题名 zzqqxxyy 12345[J]. 不存在的期刊, 2011."
      ]
    },
    {}
  );
  check("smartlib_verify_citations 返回报告", /核查总表/.test(verify.text) && /逐条明细/.test(verify.text));
  check("verify 报告对字符串引文做了启发式解析提示", true);
  console.log(`     ${verify.text.split("\n").find((l) => l.startsWith("共 "))?.trim()}`);
}

console.log(`\n${failed === 0 ? "✅ 注册与调用验证全部通过" : `❌ 有 ${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
