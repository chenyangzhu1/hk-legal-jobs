# hk-legal-jobs — 实施工作项

> 按依赖排序。每个 ticket 独立可验收；`T1` 是所有后续项的前置。
> 规模：S ≈ 半小时内，M ≈ 半天，L ≈ 一天以上。

---

## T1 · 初始化仓库与文档骨架

**目标**：建立 `hk-legal-jobs` public 仓库，把设计文档迁入，Pages 指向
`main` 的 `/docs`。

**验收**
- [ ] 仓库存在且为 **public**（否则 Pages 需付费）
- [ ] 目录骨架按 SPEC §4 建好
- [ ] `SPEC.md` / `TICKETS.md` / `CONTEXT.md` 迁入并提交
- [ ] Settings → Pages 配置为 Deploy from branch: `main` / `/docs`
- [ ] 访问 `https://<owner>.github.io/hk-legal-jobs/` 返回 200（此时是占位页）

**依赖**：无 · **规模**：S

---

## T2 · `src/http.mjs` —— fetch 封装

**目标**：带超时、重试、退避、User-Agent 的取数原语，两个源共用。

**验收**
- [ ] `fetchJson(url, {timeoutMs, retries})` 与 `fetchText(...)` 可用
- [ ] 超时用 `AbortSignal.timeout`，默认 15s
- [ ] 429 / 5xx 退避重试，**指数退避**；4xx（非 429）不重试
- [ ] 请求间隔有下限，避免打爆目标站
- [ ] 浏览器式 User-Agent
- [ ] **重试/退避策略照抄上游 `ai-job-search` 的实现**，不自行发明
      （上游有 `retry-backoff.test.ts` / `request-timeout.test.ts` 覆盖）

**依赖**：T1 · **规模**：S

---

## T3 · `src/sources/jobsdb.mjs` —— JobsDB 抓取

**目标**：从 `career-ops/providers/jobstreet.mjs` 抽取最小重写版。

**验收**
- [ ] 请求 `hk.jobsdb.com/api/jobsearch/v5/search`，`siteKey=HK-Main`
- [ ] **保留 `ALLOWED_JOBSTREET_HOSTS` 白名单**（防止配置写错把请求打到别处）
- [ ] 分页取数；单页失败时**非致命**，返回已收集部分（第 1 页失败才抛错）
- [ ] 页间限速
- [ ] 映射到 SPEC §6.1 的记录结构；`id` 前缀 `jobsdb:`
- [ ] 不引入任何 npm 依赖
- [ ] 对照上游 `parseJobstreetItem` 逐字段核对，避免漏字段

**依赖**：T2 · **规模**：M

---

## T4 · `src/sources/linkedin.mjs` —— LinkedIn 抓取

**目标**：用 Node 重写上游 663 行的 TS CLI，只保留搜索所需的核。

**验收**
- [ ] 请求 `jobs-guest/seeMoreJobPostings/search`，参数含 `keywords` 与地点
- [ ] 解析返回的 HTML 片段，抽取 jobId / 标题 / 公司 / 地点 / 日期
- [ ] `id` 前缀 `linkedin:`
- [ ] **解析失败必须显式抛错**，不能静默返回空数组
      （否则源挂了会被误读成「今天没有新岗位」）
- [ ] 不引入任何 npm 依赖；纯 `fetch` + 正则
- [ ] **不需要 Bun、不需要构建步骤**

**依赖**：T2 · **规模**：M

---

## T5 · `src/tracks.mjs` —— track 归属与标题过滤

**目标**：把一条职位映射到 `tracks[]`（多标签），并执行负面过滤。

**验收**
- [ ] 标题含 trainee 语义 → 打 `trainee` 标签；含 paralegal → 打 `paralegal`
- [ ] **两个都命中则两个标签都打**（多头广告是真实存在的，见 SPEC §6.1）
- [ ] `config.json` 的 `titleFilter.negative` 生效（如排除 `Secretary`、`Intern`）
- [ ] 关键词语义写在 `config.json` 而非硬编码在代码里
- [ ] 单元测试覆盖：多头标题、单头标题、负面词命中

**依赖**：T1 · **规模**：S

---

## T6 · `src/dedupe.mjs` + 主库 upsert

**目标**：两层去重 + 累积主库维护。**这是本项目最容易出错的部分。**

**验收**
- [ ] 按 `id` 跨源、跨关键词去重
- [ ] `fingerprint = sha1(公司 + 归一化标题 + 地点)` 识别 repost
- [ ] **指纹命中时保留原有 `firstSeenAt`，不重新点亮 NEW**；新 `id` 追加到记录
- [ ] `lastSeenAt` 每次见到都更新；连续未见则 `stillListed = false`，
      **记录保留不删**
- [ ] 写 `data/jobs.json`（累积主库）与 `data/history/<日期>.json`（当日增量）
- [ ] 单元测试覆盖：同 id 重复、repost 换 id、跨关键词重叠、消失后再出现
- [ ] 标题归一化规则明确（大小写、全角/半角、多余空格、`/` 分隔）

**依赖**：T3、T4、T5 · **规模**：L

---

## T7 · `src/scan.mjs` —— 入口编排

**目标**：串起全流程，实现失败降级。

**验收**
- [ ] 读 `config.json`，依次调用各源
- [ ] **单个源抛错不中断整体**；成功源结果照常落盘
- [ ] 产出 `meta.sources`（每源 ok/failed）与 `meta.complete`
- [ ] 派生站点载荷 `docs/feed.json`
- [ ] 支持 `--dry-run`（不写盘，打印统计）
- [ ] 支持 `--silent-new`（首次运行静默期：入库但不点亮 NEW 徽章，
      见 SPEC §10.3）
- [ ] 退出码语义：全部源失败 → 非 0；部分失败 → 0 但 `complete: false`

**依赖**：T6 · **规模**：M

---

## T8 · GitHub Actions 定时抓取

**目标**：每天 07:47 HKT 自动抓取并提交。

**验收**
- [ ] `.github/workflows/scan.yml`：`schedule: '47 23 * * *'` + `workflow_dispatch`
- [ ] `permissions: contents: write`，`concurrency` 防重入
- [ ] `actions/setup-node` 指定 Node 22+；**无 `setup-bun`、无 install 步骤**
- [ ] 跑完后 commit `data/` 与 `docs/` 并 push
- [ ] 无变更时不产生空 commit
- [ ] 手动 `workflow_dispatch` 跑通一次
- [ ] 确认该次 push 触发了 Pages 重新发布

**依赖**：T7 · **规模**：M

---

## T9 · 站点：`index.html`（最近 7 天）

**验收**
- [ ] 读 `docs/feed.json`，展示 `postedAt` 在 7 天内的职位
- [ ] 列：公司 · 标题 · 地点 · 薪资 · 发布日期 · 来源 · 链接
- [ ] `NEW` 徽章正确（依据 `firstSeenAt` 而非 `postedAt`）
- [ ] `meta.complete === false` 时顶部显示降级横幅，列出失败源
- [ ] 移动端可读（香港市场手机查阅为主）
- [ ] 无 JS 框架、无构建

**依赖**：T8 · **规模**：M

---

## T10 · 站点：`archive.html`（全部历史）

**验收**
- [ ] 展示主库全部记录，包含 `stillListed: false` 的
- [ ] 已下架职位有视觉区分（如置灰）
- [ ] 分页或虚拟滚动，保证千条量级不卡
- [ ] 与 `index.html` 共享样式与筛选逻辑

**依赖**：T9 · **规模**：M

---

## T11 · 站点：交互

**验收**
- [ ] 关键词搜索（标题 + 公司），即时过滤
- [ ] 按 track 筛选；多标签职位在两个筛选下都出现
- [ ] 按发布日期排序
- [ ] 「已投递」标记，存 `localStorage`，刷新后保留
- [ ] 筛选状态写进 URL query，便于分享/收藏

**依赖**：T9 · **规模**：M

---

## T12 · 上线验证与观测

**验收**
- [ ] 首次全量运行（静默期开启），人工抽查 ~20 条与 JobsDB 原页核对
- [ ] 连续跑 7 天，检查 `data/history/` 增量是否合理
- [ ] 核对 repost 是否被正确识别（同岗位未重复点亮 NEW）
- [ ] 记录每次运行的源失败率；若 LinkedIn 持续失败，评估是否降级为本地手动
- [ ] 一周后复盘：实际命中岗位数、噪点比例、是否需调 `config.json`

**依赖**：T8、T10、T11 · **规模**：M（含等待周期）

---

## T13 · JD 全文（需求变更，见 SPEC §13 与 adr/0004）

**验收**
- [ ] `src/text.mjs`：详情页 HTML → 纯文本，块级标签折成换行、`<li>` 折成 `- `、
      实体解码，且 `&amp;lt;` 不被二次解码成 `<`
- [ ] `src/sources/*.mjs` 各导出 `fetchDescription`，按 div **深度**配对取正文块
      （正文里有嵌套 div 时不能在第一个 `</div>` 处静默截断）
- [ ] 正文短于 100 字符一律当作没抓到（`MIN_DESCRIPTION_LENGTH`）
- [ ] `scan.mjs` 只对主库里还没有全文的职位取详情；请求量不随主库增长
- [ ] 取详情失败只降级：`meta.sources` 仍是 `ok`、`complete` 不变、退出码不变
- [ ] 403 / 451 立刻短路，`meta.descriptions.blocked` 记下被拦的源
- [ ] 记录与 `feed.json` 带 `description`；已有全文不被 null 覆盖，缺全文的会被补上
- [ ] 站点：有全文的行显示「展开全文」，展开状态在重绘（筛选/翻页/标记已投递）后保留
- [ ] 站点：搜索覆盖标题 + 公司 + 全文；全文不进 innerHTML

**依赖**：T3、T4、T6、T7、T11 · **规模**：L

---

## 依赖图

```
T1 ─┬─ T2 ─┬─ T3 ─┐
    │      └─ T4 ─┼─ T6 ─ T7 ─ T8 ─┬─ T9 ─┬─ T10 ─┐
    └─ T5 ────────┘                 │      └─ T11 ─┼─ T12
                                     └──────────────┘
```
