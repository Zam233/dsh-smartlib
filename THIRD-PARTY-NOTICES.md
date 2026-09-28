# 第三方组件与出处说明 / Third-Party Notices

本项目的 **源代码**（`lib/`、`tools/`、`README.md`、`package.json` 等）由本仓库作者编写，
以 **GNU GPL-3.0-or-later** 发布（见 `LICENSE`）。

本项目的**功能规格**参考了 SmartLib 官方在 SkillHub 上发布的技能包。
以下逐项说明出处、许可与再分发条件。

---

## 1. 运行时依赖（未捆绑，仅声明 peerDependencies）

本插件通过 `peerDependencies` 使用 DSH 自身的包，**不复制、不打包**其代码；
它们由 DSH 安装提供，各自遵循其原始许可：

| 包 | 许可 | 版权 |
| --- | --- | --- |
| `@deepseek-ai/dsh-tools` | MIT | Copyright (c) 2026 DeepSeek |
| `@deepseek-ai/schemastery` | MIT | Copyright (c) 2021-present Shigma |
| `@deepseek-ai/dsh`（宿主） | MIT | Copyright (c) 2026 DeepSeek |

MIT 与 GPL-3.0 兼容：MIT 许可的库可被 GPL 程序使用，不改变本项目的 GPL 授权。

---

## 2. 功能规格与文档参考（无代码复制）

| 技能包 | 出处 | 声明的许可 |
| --- | --- | --- |
| `smartlib-citation-checker` v3.6.3 | SkillHub `@user_164f4c1f/smartlib-citation-checker`（作者：张亚东 / 重庆维普智图，GitHub [J-levee](https://github.com/J-levee)，仓库 https://github.com/J-levee/smartlib-citation-checker） | **MIT**（`plugin.json` 的 `license` 字段；README「许可」章节写明「MIT License — 代码开源，商用 API 需授权」） |
| `global-biblio-base` v3.10.2 | SkillHub `@user_164f4c1f/global-biblio-base`（同一作者） | **未声明许可**（包内无 LICENSE/COPYING，README 与元数据中均无 license 字段） |

### 2.1 本项目如何使用它们

- 两个技能包**只包含 Markdown 文档与示例 HTML**，不含可被复用的源代码；
  本项目**没有复制任何一行技能包代码**（Bash/JS/Python 皆无）。
- 本项目从它们取得的是**接口事实与功能规格**：网关端点路径（`/register`、`/quota`、
  `/consume`、`/search`）、上游 API 路径（`Articlesearch` / `Articledetail` /
  `GetArticleFile`）、请求与响应字段名、计费与配额规则、检索式语法（`T=`/`A=`/`K=`…）、
  匹配打分权重、以及 GB/T 7714-2025 的著录规则等。
  这些属于**事实、方法与接口规范**，不构成受版权保护的表达。
- 文档中的表格、字段清单等叙述性内容，本仓库均以**自己的措辞**重新表述。
- `lib/citations.js`、`lib/gateway.js`、`lib/format.js`、`lib/index.js`、`tools/*`
  为本项目独立实现，未基于任何技能包代码改写。

### 2.2 MIT 合规声明（针对 `smartlib-citation-checker`）

凡涉及该 MIT 技能包的规格引用，均保留其署名与许可：

```
smartlib-citation-checker
Copyright (c) 张亚东 (Yadong Zhang), 重庆维普智图 (VIP Smart)
Licensed under the MIT License.
Source: https://github.com/J-levee/smartlib-citation-checker

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 2.3 关于 `global-biblio-base` 的说明与保留事项

该技能包在发布时**未附任何许可声明**。按著作权法默认规则，未授权即保留全部权利。
本项目据此采取以下谨慎做法：

- 仅把它当作**接口事实**来源（上文 2.1 所列内容），不复制、不改写、不再分发其文档原文；
- 明确署名原作者（张亚东 / 重庆维普智图）；
- 若原作者或权利人认为本项目的表述触及权利，请在仓库提 Issue，作者将立即调整或移除相关内容。

> 📌 **给使用者的提示**：如果你希望彻底消除这方面的不确定性，可以向原作者确认
> `global-biblio-base` 的授权条款（SkillHub 页面 / 作者 GitHub），
> 或与 `vipsmart@vipslib.com` 联系。

---

## 3. 服务与商标（不属于代码许可范围）

- **SmartLib API / 网关是作者运营的第三方服务**，不是本项目的组成部分。
  本项目只是它的客户端。使用该服务须遵守其自身条款；
  `smartlib-citation-checker` 的 README 特别注明「**商用 API 需授权**」——
  本项目的 GPL 授权**不包含**任何 SmartLib API 的商业使用授权。
- GPL 只覆盖本项目代码，不授予 SmartLib、维普、DeepSeek 等任何商标或服务的使用权。
- 本项目不附带任何网关密钥：仓库内的 `cordis.patch.yml` 为空占位值，
  需使用者自行向服务方获取配置。
