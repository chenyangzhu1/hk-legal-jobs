# LinkedIn 走 curl 传输，因为 Node fetch 被 451 硬挡

LinkedIn 的 `jobs-guest` 端点对 Node 自带的 `fetch`（undici）一律返回
**HTTP 451 Unavailable For Legal Reasons**；同一个 URL 用系统 `curl` 返回 200。

实测（2026-10-12）：

| 客户端 | 结果 |
|---|---|
| `curl`（macOS / SecureTransport） | 200，一整页 10 张职位卡片 |
| `curl`（不带 Accept-Language） | 429 —— 限流，但**不是** 451 |
| Node `fetch`，浏览器 UA | 451，正文 0 字节 |
| Node `fetch`，浏览器 UA + `X-Requested-With` + `Accept` | 451 |
| Node `fetch`，上游用的 `compatible; ...` UA | 451 |

三种完全不同的请求头得到同一个 451，而 curl 用同一组头拿 200 —— 所以这不是
内容协商或 UA 黑名单，是**按 TLS 指纹识别的机器流量拦截**。改请求头解决不了。

**决定**：给 LinkedIn 这一源加一个 curl 传输层（`src/http.mjs` 的
`createCurlTransport`），`config.json` 里写 `sources.linkedin.transport: "curl"`。
重试、退避、限速、超时策略仍然只有一份 —— 传输只是 `createHttp` 的一个可插拔件。

**考虑过的替代方案**：

- **放弃 LinkedIn，只留 JobsDB** —— 否决。ADR 0001 已经明确论证过「手动补抓会
  迅速退化为不做」；而技术上它还没被逼到这一步。
- **引入 Playwright / Puppeteer** —— 否决。为了一个公开端点，把"零 npm 依赖、
  无构建步骤"这条整个仓库的立身之本赔进去，代价远大于收益。
- **把 curl 的 TLS 指纹模拟进 undici** —— 否决。等于自己维护一份 TLS 指纹伪装，
  脆弱且明确越界。

**后果**：

1. 系统里多了一个外部依赖 `curl`。它不是 npm 依赖（macOS 与 `ubuntu-latest` 都
   自带），但如果哪天 CI 镜像里没有 curl，LinkedIn 这一源会显式失败 ——
   降级横幅会显示出来，不会静默少数据。
2. 这是绕过一道**按指纹做的**拦截，而不是解除一道授权限制。ADR 0001 的合规取舍
   （低频、个人使用）不变，本文不改变它的适用条件。
3. 若 LinkedIn 连 curl 也挡，正确做法是 `enabled: false` 降级为 JobsDB 单源，
   而不是继续加码伪装。
