# dsh-smartlib

DeepSeek Harness 插件：接入 SmartLib 学术检索平台，提供**中英文文献检索、文献详情、中文期刊全文下载、配额查询，以及参考文献真实性核查（防 AI 幻觉）**。

协议对齐 SmartLib Gateway v52.x，与 `global-biblio-base`（检索）和 `smartlib-citation-checker`（引用核查，v3.6.3）技能同源：共享凭证与统一钱包配额。

由原 Scholar_View `smartlib` 插件（仅中文检索）扩展而来。

## 提供的工具

| 工具 | 说明 | 计费 |
| --- | --- | --- |
| `smartlib_search` | 检索：`query` 单一关键词，或 `rule` 高级检索式；`scope=cn\|global\|both`；支持 `filter`/`sort`/分页 | 1 次（both 为 2 次） |
| `smartlib_detail` | 单篇文献详情：DOI、核心收录、基金资助、页码、**原始数据库来源链接** | 1 次（auto 回退可能 2 次） |
| `smartlib_download` | 中文期刊 PDF 全文下载链接（链接约 10 分钟有效） | 1 次下载额度 |
| `smartlib_quota` | 查询配额/套餐/邮箱验证状态；未注册自动注册 | 免费 |
| `smartlib_verify_citations` | 批量核查参考文献真实性：匹配打分、数据库命中记录、逐字段差异清单 | 每条 1~4 次 |

## 数据规模与来源

- 中文期刊授权全文 **8000 万篇**（API 1/2/3，支持全文下载）
- 全球文献元数据 **12.28 亿条**（API 4/5：期刊 7.19 亿 / 专利 2.15 亿 / 会议 7155 万 / 学位论文 2473 万 / 标准 268 万）
- 检索结果每条附带 SmartLib 详情页链接；**详情接口额外返回 300+ 数据库的原始来源链接**（Scopus / WoS / EI / PubMed / CNKI / 万方 / 维普 …），可用于交叉验证文献真实性

## 配额与计费

- 每个邮箱免费 **100 次检索 + 10 次下载 / 月**；未注册邮箱首次调用自动 `/register`（无需验证码）
- **按计费接口调用次数扣费**，共 5 个计费接口：中文期刊检索、全球文献检索、中文期刊详情、全球文献详情、中文期刊全文下载；每次调用消耗 1 次
- `/consume` 只校验额度并签发 token（单次使用、60 秒有效），**不预扣**；实际调用成功后才扣减，**失败调用不消耗配额**
- 配额耗尽时网关返回 429，工具会输出可选套餐（体验卡 / 个人版月 / 专业版月 / 单篇下载 / 下载包）
- 多邮箱按顺序轮换：某个邮箱额度耗尽自动切下一个

## 参考文献核查（核心能力）

`smartlib_verify_citations` 实现 `smartlib-citation-checker` 的核查链路：

1. **解析**：推荐传结构化对象 `{title, year, authors[], doi, journal, scope}`；也可直接传整条引用原文（GB/T 7714 / APA / MLA / Chicago / BibTeX），由插件启发式解析（会在结果中标注，精度较低）
2. **联网核查**：优先级 1 `(T=题名核心词) AND Y=年份` → 命中高质量结果即提前终止；无结果则优先级 2 放宽年份；中文题名走中文库、外文/带 DOI 走全球库，必要时自动换库；**8 条并行**
3. **匹配打分**：题名相似度 60% + 作者 25% + 年份 15%（DOI 精确命中直接判通过）
4. **判定**：`VERIFIED`(≥0.85) / `MISMATCH`(≥0.6) / `FUZZY_MATCH`(≥0.4) / `NOT_FOUND`
5. **差异比对**：逐字段给出「原始引用 → 数据库记录」，标记 `error`（实质差异）与 `info`（可补全，如原文缺 DOI）
6. **输出**：结构化 Markdown（核查总表 + 逐条明细 + 候选记录 + 差异清单），由模型按 `smartlib-citation-check` 技能渲染为 HTML 核查报告

> 作者比对做了格式兼容：SmartLib 全球库作者字段是**缩写在前**的西文写法（`S. Band, Shahab`），中文库是 `周圣荃;李以科`，引文侧又常见 `Band, S. S.`。因此不比姓氏而比**有效词元集合**（忽略顺序、分隔符与单字母缩写），避免把同一作者误判为不同人。

## 配置

> ⚠️ **仓库内的 `cordis.patch.yml` 只含空占位值**，真实网关密钥与邮箱**不提交进仓库**。
> 请在自己的 profile 层配置（该文件不在仓库内）：

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- id: dsh-smartlib
  config:
    gateway_url: https://<your-gateway-host>   # 网关地址
    gateway_secret: <your-gateway-secret>      # 网关 Bearer 密钥（仅后端使用，不会输出到对话）
    emails:                                    # 邮箱列表，按顺序轮换仍有额度的邮箱
      - you@example.com
    batch_size: 8                              # 核查时的并行条数（1-16，默认 8）
```

插件自带的 bundle patch 负责**挂载**，profile 层负责**配置**——同 id 覆盖由 DSH loader 保证。
可用 `dsh --profile web --dump-config` 查看组合结果（该命令只打印配置、不启动服务）。

字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `gateway_url` | ✅ | SmartLib 网关地址 |
| `gateway_secret` | ✅ | 网关 Bearer 密钥 |
| `emails` | ✅ | 邮箱列表，按顺序轮换仍有额度的邮箱 |
| `batch_size` | — | 核查并行条数，1-16，默认 8 |

未配置时各工具返回「未配置网关（gateway_url / gateway_secret）」，不会抛异常。

> 与原技能的一处差异：原技能要求「每次必须先向用户索取邮箱、禁止使用预填邮箱」。本插件面向单机自用，采用**配置文件内的自有邮箱列表轮换**；如需临时指定邮箱，各工具都支持 `email` 参数覆盖。

## 安装

```bash
dsh plugin --profile web add link:C:/Users/<you>/.dsh/plugins/dsh-smartlib
```

装好后需**重启 `dsh web`**（宿主插件在启动时加载，改动不会热更新）。

## 开发与自测

`tools/` 下有两个测试脚本。ESM 解析 peer 依赖需要本目录存在 `node_modules` 软链（仅开发时需要，安装到 profile 后由 profile 的 `node_modules` 提供）：

```powershell
# 一次性建立软链（指向 dsh 安装目录内的 peer 依赖）
New-Item -ItemType Directory -Force -Path node_modules\@deepseek-ai
cmd /c mklink /J node_modules\@deepseek-ai\dsh-tools "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-tools"
cmd /c mklink /J node_modules\@deepseek-ai\schemastery "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\schemastery"

node tools/selftest.mjs             # 133 项离线单测（mock fetch，不联网、不消耗配额）
node tools/register-test.mjs        # 校验插件注册与参数 schema 编译（不联网）
```

加权（`--live`）测试会真实调用网关、消耗配额，凭证**只从环境变量读取**（仓库内不含任何密钥）：

```powershell
$env:SMARTLIB_GATEWAY_URL    = 'https://<your-gateway-host>'
$env:SMARTLIB_GATEWAY_SECRET = '<your-gateway-secret>'
$env:SMARTLIB_TEST_EMAILS    = 'a@example.com,b@example.com'
node tools/selftest.mjs --live       # 追加活网关集成测试
node tools/register-test.mjs --live  # 追加 5 个工具的端到端调用
```

未设置上述变量时，`--live` 会打印跳过提示并正常退出（退出码 0）。
```

## 模块结构

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | 插件入口：工具注册、系统提示、参数定义 |
| `lib/gateway.js` | 网关客户端：register/quota/consume/search 代理、重试退避、多邮箱轮换、通知收集 |
| `lib/format.js` | Markdown 渲染：检索结果、详情、下载、配额、套餐卡片、系统通知 |
| `lib/citations.js` | 核查引擎：引文解析、检索式构建、匹配打分、差异比对、报告渲染 |

## 备注

- 网关响应中的 `notifications` 属系统通知，工具会原样转述（不改写措辞、不合并），其中的 `url` 以纯文字呈现
- 外文文献全文下载（十级 OA 渠道探测）不在本插件范围内；`smartlib_download` 仅覆盖授权中文期刊
- 检索列表中的 `Source` 字段恒为空数组，**原始数据库来源链接只有详情接口才返回**

## 网关异常行为与应对（重要）

- **`Succeeded:false` 必须当失败处理**：网关在 HTTP 200 的同时可能返回业务失败
  （`Succeeded:false` + `Errors:"系统异常，请联系管理员"`，或小写外壳的 `succeeded:false` + `msg`）。
  只判断 HTTP 状态码会把它误当成「未检索到结果」。本插件会透传网关原文并给出提示。
- **业务失败也会被计费**：实测 `Succeeded:false` 的响应仍会扣减配额（与技能文档「失败不扣费」的说法不符）。
  因此**上游故障期间不要循环重试**。
- **熔断保护**：识别到疑似上游服务故障（含「系统异常 / 请联系管理员 / 服务不可用 / 超时」等关键字）后，
  同批次后续调用直接跳过、不再联网也不再计费；而「检索式非法」这类错误**不**熔断（换检索式仍可能成功）。
- **核查状态不降级**：上游故障或配额耗尽导致的未完成核查，一律标记为 `SKIPPED`（未核查），
  **绝不会降级成 `NOT_FOUND`** —— 否则会把真实文献误报成 AI 幻觉文献。
- **两种响应外壳**：语义化端点模式历史上返回小写 `succeeded`/`data.list`，新版会回 PascalCase
  `Succeeded`/`Data.List`；解析统一走 `data.list → Data.List → List` 回退，两种都能处理。
  （旧版插件只认小写 `succeeded`，网关改版后会**每次**都报「search 返回失败状态」。）

## 许可证与出处

本项目代码以 **GNU GPL-3.0-or-later** 发布，见 [`LICENSE`](./LICENSE)。

功能规格参考了 SmartLib 官方发布的技能包，出处与许可详见
[`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md)：

- `smartlib-citation-checker`（作者 **张亚东 / 重庆维普智图**，GitHub [J-levee](https://github.com/J-levee)）— **MIT**，
  本项目按 MIT 要求保留其署名与许可全文；
- `global-biblio-base`（同一作者）— **发布时未声明许可**，本项目仅引用其公开的接口事实（端点、字段、规则），
  未复制其文档原文，并已署名。

**重要**：本项目的 GPL 授权**不包含** SmartLib API / 网关的任何使用授权。
该服务为第三方运营，「商用 API 需授权」，请自行与服务方确认。
