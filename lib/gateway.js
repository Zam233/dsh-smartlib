// lib/gateway.js — SmartLib 智能网关客户端。
//
// 协议（对齐 SmartLib Gateway v52.x + global-biblio-base / smartlib-citation-checker）：
//   register  POST /register                  {email}
//   quota     GET  /quota?email=...           → 额度、套餐、notifications
//   consume   POST /consume                   {email, skill_source}      → consume_token（单次、60s）
//   proxy     POST /search                    {email, consume_token, skill_source, api_path, api_body}
//   semantic  POST /search                    {email, consume_token, skill_source, endpoint, rule, ...}
//
// 计费：按「计费接口调用次数」计。5 个计费接口——
//   检索 中文期刊 data0012/Articlesearch   检索 全球文献 skrs2/Articlesearch
//   详情 中文期刊 data0011/Articledetail   详情 全球文献 skrs1/Articledetail
//   下载 中文期刊 data0013/GetArticleFile
// /consume 不预扣；仅实际调用且返回成功后才扣减，失败不消耗。

export const SKILL_BASE = "global-biblio-base";
export const SKILL_CITATION = "smartlib-citation-checker";

export const API_PATH = {
  searchCn: "/openapi/t/data0012/doccenter/Articlesearch",
  detailCn: "/openapi/t/data0011/doccenter/Articledetail",
  downloadCn: "/openapi/t/data0013/doccenter/GetArticleFile",
  searchGlobal: "/openapi/t/skrs2/doccenter/Articlesearch",
  detailGlobal: "/openapi/t/skrs1/doccenter/Articledetail"
};

export const DETAIL_URL_BASE =
  "https://data.smart.vipslib.com/articlesearch/web_searchingDetail?id=";

export const DEFAULT_TIMEOUT_MS = 30_000;
const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000];
const RATE_LIMIT_WAIT_MS = 5_000;
const RATE_LIMIT_RETRIES = 2;

// ---- 基础工具 ----

export function makeSignal(exec, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const outer = exec?.signal;
  if (!outer) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([outer, timeout]);
  return timeout;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function backoffDelay(ms, signal) {
  // 允许被调用方取消的等待；失败（取消）时抛出 AbortError。
  return sleep(ms, signal);
}

async function httpRequest(url, { method = "POST", headers, body, signal }) {
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal
  });
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, json, text };
}

function isRetryableStatus(status) {
  return status === 500 || status === 502 || status === 503 || status === 504;
}

/** 单次请求 + 服务端错误指数退避重试（1s/2s/4s）。 */
async function requestWithRetry(url, options) {
  let lastResult = null;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt += 1) {
    let result;
    try {
      result = await httpRequest(url, options);
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      if (attempt >= RETRY_BACKOFF_MS.length) {
        const wrapped = new Error(`网络错误：${err?.message ?? String(err)}`);
        wrapped.kind = "network";
        throw wrapped;
      }
      await backoffDelay(RETRY_BACKOFF_MS[attempt], options.signal);
      continue;
    }
    if (isRetryableStatus(result.status) && attempt < RETRY_BACKOFF_MS.length) {
      lastResult = result;
      await backoffDelay(RETRY_BACKOFF_MS[attempt], options.signal);
      continue;
    }
    return result;
  }
  return lastResult;
}

// ---- 响应解析 ----

/** 兼容语义化端点（小写 data.list）与全代理模式（PascalCase Data.List）。 */
export function pickList(body) {
  const inner = body?.data ?? body?.Data ?? body ?? {};
  const list = inner?.list ?? inner?.List ?? [];
  const total = inner?.total ?? inner?.Total ?? null;
  return {
    list: Array.isArray(list) ? list : [],
    total: total == null || total === "" ? null : Number(total)
  };
}

/** 详情记录：兼容 Data / data 两种外壳。 */
export function pickRecord(body) {
  const inner = body?.data ?? body?.Data ?? body ?? {};
  return inner && typeof inner === "object" ? inner : {};
}

/**
 * 识别「HTTP 200 但业务失败」的响应。
 *
 * 网关存在两种外壳：全代理模式 PascalCase（`Succeeded`/`Errors`）与
 * 语义化端点模式（历史上是小写 `succeeded`/`msg`，新版也会回 PascalCase）。
 * 上游检索服务故障时会返回 `Succeeded:false` + `Errors:"系统异常，请联系管理员"`，
 * HTTP 状态仍是 200——只判断状态码会把它误当成「未检索到结果」。
 *
 * @returns {string|null} 失败原因；正常响应返回 null
 */
export function gatewayFailure(body) {
  if (!body || typeof body !== "object") return null;
  const detail = (value) => {
    if (value == null || value === "") return "";
    if (typeof value === "string") return value.trim();
    if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join("；");
    return JSON.stringify(value);
  };
  if (body.Succeeded === false) {
    return detail(body.Errors) || detail(body.Error) || detail(body.Message) || "网关返回 Succeeded=false";
  }
  if (body.succeeded === false) {
    return detail(body.msg) || detail(body.message) || detail(body.error) || "网关返回 succeeded=false";
  }
  return null;
}

function extractNotifications(body) {
  const raw = body?.notifications ?? body?.Notifications;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === "string") return { text: item.trim(), url: "" };
      if (!item || typeof item !== "object") return null;
      const text = String(item.text ?? item.Text ?? "").trim();
      const url = String(item.url ?? item.Url ?? "").trim();
      if (!text && !url) return null;
      return { text, url };
    })
    .filter(Boolean);
}

function httpMessage(status, body) {
  const detail =
    body?.message ?? body?.error ?? body?.msg ?? (body?.text ? String(body.text).slice(0, 200) : "");
  const suffix = detail ? `：${detail}` : "";
  switch (status) {
    case 400:
      return `参数错误（HTTP 400）${suffix}；请检查检索式语法：运算符须大写且两侧有空格，字段代码用 T/A/K/P/O/U`;
    case 401:
      return `consume_token 无效或已过期（HTTP 401）${suffix}`;
    case 403:
      return `当前凭证无此接口权限（HTTP 403）${suffix}`;
    case 404:
      return `接口或资源不存在（HTTP 404）${suffix}`;
    case 429:
      return `请求过于频繁（HTTP 429）${suffix}`;
    case 500:
    case 502:
    case 503:
    case 504:
      return `SmartLib 服务暂时不可用（HTTP ${status}）${suffix}，通常 5 分钟内恢复`;
    default:
      return `SmartLib 返回 HTTP ${status}${suffix}`;
  }
}

// ---- 网关客户端 ----

export class SmartLibGateway {
  /**
   * @param {object} config 插件配置（gateway_url / gateway_secret / emails / batch_size）
   * @param {object} [options] { signal }
   */
  constructor(config, options = {}) {
    this.gateway = String(config?.gateway_url ?? "").trim().replace(/\/+$/, "");
    this.secret = String(config?.gateway_secret ?? "").trim();
    this.emails = (Array.isArray(config?.emails) ? config.emails : [])
      .map((e) => String(e ?? "").trim())
      .filter(Boolean);
    this.signal = options.signal;

    this.dead = new Set(); // 配额耗尽的邮箱下标
    this.cursor = 0; // 首选邮箱下标（粘性，避免每篇都从头轮询）
    this.spent = 0; // 本次调用已消耗的计费次数
    this.notifications = []; // 网关常驻通知（原样转述）
    this.lastRemain = null; // 最近一次 consume 返回的 total_remain
    this.lastEmail = null;
    this.lastPlans = null; // 配额耗尽时网关返回的套餐列表
    this.aborted = false; // 上游业务故障后熔断，避免继续消耗配额
    this.abortedReason = "";
  }

  get configured() {
    return Boolean(this.gateway && this.secret) && this.emails.length > 0;
  }

  get configError() {
    if (!this.gateway || !this.secret) return "SmartLib 检索失败：未配置网关（gateway_url / gateway_secret）";
    if (this.emails.length === 0) return "SmartLib 检索失败：未配置邮箱（emails）";
    return null;
  }

  _headers() {
    return {
      Authorization: `Bearer ${this.secret}`,
      "Content-Type": "application/json"
    };
  }

  _collectNotifications(body) {
    for (const item of extractNotifications(body)) {
      const dup = this.notifications.some((n) => n.text === item.text && n.url === item.url);
      if (!dup) this.notifications.push(item);
    }
  }

  /** 选一个仍有额度的邮箱下标；全部耗尽返回 -1。 */
  _pick() {
    const len = this.emails.length;
    for (let k = 0; k < len; k += 1) {
      const idx = (this.cursor + k) % len;
      if (!this.dead.has(idx)) return idx;
    }
    return -1;
  }

  _prefer(idx) {
    this.cursor = idx;
  }

  // ---- 基础端点 ----

  async register(email) {
    const res = await requestWithRetry(`${this.gateway}/register`, {
      method: "POST",
      headers: this._headers(),
      body: { email },
      signal: this.signal
    });
    return res.status === 200 || res.status === 201;
  }

  /** GET /quota；未注册时自动注册并重查。返回 {ok, status, quota, registered, error}。 */
  async quota(email) {
    const url = `${this.gateway}/quota?email=${encodeURIComponent(email)}`;
    let res = await requestWithRetry(url, { method: "GET", headers: this._headers(), signal: this.signal });
    let registered = false;
    if (res.status === 404) {
      registered = await this.register(email);
      if (registered) {
        res = await requestWithRetry(url, { method: "GET", headers: this._headers(), signal: this.signal });
      }
    }
    this._collectNotifications(res.json);
    if (res.status !== 200) {
      return {
        ok: false,
        status: res.status,
        registered,
        error: res.status === 404
          ? `邮箱 ${email} 未注册，且自动注册失败`
          : httpMessage(res.status, res.json)
      };
    }
    return { ok: true, status: 200, registered, quota: res.json ?? {} };
  }

  /** POST /consume → token。status: "ok" | "exhausted" | "error"。 */
  async consume(email, skillSource) {
    const res = await requestWithRetry(`${this.gateway}/consume`, {
      method: "POST",
      headers: this._headers(),
      body: { email, skill_source: skillSource },
      signal: this.signal
    });
    this._collectNotifications(res.json);
    const body = res.json ?? {};
    if (res.status === 404) {
      const registered = await this.register(email);
      if (registered) return this.consume(email, skillSource);
      return { status: "error", error: `邮箱 ${email} 未注册，自动注册失败` };
    }
    if (res.status === 429) {
      if (Array.isArray(body.plans) && body.plans.length) this.lastPlans = body.plans;
      return {
        status: "exhausted",
        body,
        error: body.message ?? "赠送额度和充值额度均已用完"
      };
    }
    if (res.status !== 200) {
      return { status: "error", error: httpMessage(res.status, body) };
    }
    const token = body.consume_token ?? body.token;
    if (!token) return { status: "error", error: "网关未返回 consume_token" };
    const remain = body.total_remain == null ? null : Number(body.total_remain);
    if (remain != null) this.lastRemain = remain;
    return { status: "ok", token: String(token), remain, body };
  }

  /** POST /search（全代理模式）。 */
  async _proxy(email, token, { apiPath, apiBody }, skillSource) {
    return requestWithRetry(`${this.gateway}/search`, {
      method: "POST",
      headers: this._headers(),
      body: {
        email,
        consume_token: token,
        skill_source: skillSource,
        api_path: apiPath,
        api_body: apiBody ?? {}
      },
      signal: this.signal
    });
  }

  /** POST /search（语义化端点模式）。 */
  async _semantic(email, token, params, skillSource) {
    return requestWithRetry(`${this.gateway}/search`, {
      method: "POST",
      headers: this._headers(),
      body: { email, consume_token: token, skill_source: skillSource, ...params },
      signal: this.signal
    });
  }

  /**
   * 一次计费接口调用：自动选邮箱 → /consume → /search，401 自动重新 consume 重试一次，
   * 429 先等 5s 重试，仍失败则换下一个邮箱；某邮箱配额耗尽即标记为 dead。
   *
   * @returns {Promise<{ok:boolean, body?:object, email?:string, remain?:number,
   *                    quotaExhausted?:boolean, error?:string}>}
   */
  async call(apiPath, apiBody, { skillSource = SKILL_BASE, email } = {}) {
    // 熔断：上游业务故障（如「系统异常，请联系管理员」）与检索式无关，换邮箱/换检索式
    // 都不会成功，而每次调用仍会被计费——因此直接中止本批次后续调用。
    if (this.aborted) {
      return {
        ok: false,
        upstreamError: true,
        aborted: true,
        error: `已跳过：${this.abortedReason}`
      };
    }

    const pinned = email ? this.emails.indexOf(email) : -1;
    const attempts = email && pinned < 0 ? [email] : null;
    let lastError = "";
    let sawExhausted = false;
    const maxAttempts = attempts ? attempts.length : this.emails.length + 1;

    for (let round = 0; round < maxAttempts; round += 1) {
      let targetEmail;
      if (attempts) {
        targetEmail = attempts[round];
      } else {
        const idx = this._pick();
        if (idx < 0) break;
        targetEmail = this.emails[idx];
      }

      const consumed = await this.consume(targetEmail, skillSource);
      if (consumed.status === "exhausted") {
        sawExhausted = true;
        if (!attempts) {
          const idx = this.emails.indexOf(targetEmail);
          if (idx >= 0) this.dead.add(idx);
        }
        lastError = `邮箱 ${targetEmail}：${consumed.error}`;
        continue;
      }
      if (consumed.status === "error") {
        lastError = `邮箱 ${targetEmail}：${consumed.error}`;
        continue;
      }

      if (!attempts) {
        const idx = this.emails.indexOf(targetEmail);
        if (idx >= 0) this._prefer(idx);
      }

      let res = await this._proxy(targetEmail, consumed.token, { apiPath, apiBody }, skillSource);

      // token 失效：重新 consume 一次
      if (res.status === 401) {
        const again = await this.consume(targetEmail, skillSource);
        if (again.status === "ok") {
          res = await this._proxy(targetEmail, again.token, { apiPath, apiBody }, skillSource);
        }
      }

      // 频率超限：等 5s 重试
      for (let r = 0; r < RATE_LIMIT_RETRIES && res.status === 429; r += 1) {
        const body = res.json ?? {};
        if (body.status === "quota_exhausted") break;
        await backoffDelay(RATE_LIMIT_WAIT_MS, this.signal);
        const again = await this.consume(targetEmail, skillSource);
        if (again.status !== "ok") break;
        res = await this._proxy(targetEmail, again.token, { apiPath, apiBody }, skillSource);
      }

      this._collectNotifications(res.json);

      if (res.status === 200) {
        // HTTP 200 但业务失败（上游故障 / 检索式非法）：必须把网关原文报出来，
        // 否则会被当成「未检索到结果」，用户拿不到真正的原因。
        const failure = gatewayFailure(res.json);
        if (failure) {
          // 实测：这类响应网关仍会计费，故如实计入消耗
          this.spent += 1;
          // 熔断：疑似上游服务故障（而非本次检索式的问题）时中止本批次后续调用
          if (/系统异常|请联系管理员|内部错误|服务不可用|timeout|超时/i.test(failure)) {
            this.aborted = true;
            this.abortedReason = `SmartLib 上游检索服务异常（${failure}），已中止后续调用以避免继续消耗配额`;
          }
          const hint = this.aborted
            ? "（上游检索服务可能临时故障，稍后重试；若持续出现请联系服务方）"
            : "";
          return {
            ok: false,
            status: 200,
            upstreamError: true,
            aborted: this.aborted,
            error: `SmartLib 返回业务失败：${failure}${hint}｜本次调用已被计费`
          };
        }
        this.spent += 1;
        this.lastEmail = targetEmail;
        return { ok: true, body: res.json ?? {}, email: targetEmail, remain: this.lastRemain };
      }

      if (res.status === 429) {
        const isExhausted = (res.json ?? {}).status === "quota_exhausted";
        if (isExhausted) {
          sawExhausted = true;
          if (!attempts) {
            const idx = this.emails.indexOf(targetEmail);
            if (idx >= 0) this.dead.add(idx);
          }
        }
        lastError = `邮箱 ${targetEmail}：${httpMessage(429, res.json)}`;
        continue;
      }

      // 其它错误：不换邮箱（换邮箱也不会成功），直接返回
      return { ok: false, error: httpMessage(res.status, res.json), status: res.status };
    }

    if (sawExhausted) {
      return {
        ok: false,
        quotaExhausted: true,
        error: `SmartLib 配额已用尽（${lastError || "所有邮箱额度为 0"}）`
      };
    }
    return { ok: false, error: lastError || "SmartLib 请求失败：无可用的邮箱配额" };
  }

  /** 便捷封装：中文期刊检索 */
  searchCn(rule, options = {}) {
    return this.search("cn", rule, options);
  }

  /** 便捷封装：按 scope 检索。 */
  search(scope, rule, { filter, sort = 1, page = 1, pageSize = 20, skillSource = SKILL_BASE, email } = {}) {
    const apiPath = scope === "global" ? API_PATH.searchGlobal : API_PATH.searchCn;
    const apiBody = { Rule: rule, PageIndex: page, PageSize: pageSize, Sort: sort };
    if (filter) apiBody.FilterRule = filter;
    return this.call(apiPath, apiBody, { skillSource, email });
  }

  detail(scope, identifier, options = {}) {
    const apiPath = scope === "global" ? API_PATH.detailGlobal : API_PATH.detailCn;
    return this.call(apiPath, { Identifier: identifier }, options);
  }

  downloadCn(identifier, options = {}) {
    return this.call(API_PATH.downloadCn, { Identifier: identifier }, options);
  }
}

// ---- 并发批次 ----

/**
 * 并发受控的 map（保序）。
 * @param {Array} items
 * @param {number} limit
 * @param {(item:any, index:number)=>Promise<any>} worker
 */
export async function mapLimit(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
  const results = new Array(list.length);
  let next = 0;
  async function runner() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  }
  await Promise.all(Array.from({ length: size }, () => runner()));
  return results;
}
