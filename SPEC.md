# hk-legal-jobs — 规格说明

> 状态：设计已定稿，**尚未动工**。
> 本文件与 `TICKETS.md`、`CONTEXT.md`、`docs/adr/` 一并暂存在工作区
> `training_contract`，待新仓库 `hk-legal-jobs` 建立后整体迁入。

---

## 1. 目标

每天定时抓取香港的 **Trainee Solicitor** 与 **Paralegal** 职位，去重后落盘为
JSON，并通过 GitHub Pages 呈现为可搜索、可筛选的静态页面。**每新增一条职位，
从发布到出现在页面上，全自动，无人值守。**

## 2. 非目标（明确不做）

- ❌ 不做匹配度评分、不做简历/求职信定制、不做投递 —— 只做「看见」
- ❌ 不覆盖香港以外地区
- ❌ 不做后端、不做账号系统、不做跨设备的「已投递」同步
- ❌ 不存 JD 全文（只存截断摘要，见 §6.2）
- ❌ 不复用 `career-ops` 的 `scan.mjs`（见 ADR 0002）

---

## 3. 为什么新起一个仓库

现工作区 `training_contract` 里 vendored 的两个框架（`career-ops/`、
`ai-job-search/`）各自 200+ 文件，面向「通用求职 agent」，我们只需要其中
**两个抓取端点**。同时该工作区是 **private**，而 GitHub Pages 免费计划
只在 **public** 仓库可用。

因此：新建 public 仓库 `hk-legal-jobs`，只包含我们自己拥有的、约
**500 行**的抓取代码 + 数据 + 站点。工作区保持 private 不动。

---

## 4. 架构总览

```
hk-legal-jobs/                    (public)
├── .github/workflows/scan.yml    定时抓取 + 提交
├── src/
│   ├── scan.mjs                  入口：编排 → 去重 → 落盘
│   ├── http.mjs                  fetch 封装：超时 / 重试 / 退避 / UA
│   ├── sources/
│   │   ├── jobsdb.mjs            JobsDB (SEEK v5)
│   │   └── linkedin.mjs          LinkedIn jobs-guest
│   ├── tracks.mjs                标题 → track 归属（多标签）
│   └── dedupe.mjs                jobId 归一 + repost 指纹
├── config.json                   关键词、track 定义、过滤规则 —— 唯一需要改的文件
├── data/                         抓取程序拥有的真相
│   ├── jobs.json                 累积主库（含 firstSeenAt / lastSeenAt）
│   └── history/YYYY-MM-DD.json   每日增量快照
├── docs/                         ← GitHub Pages 根
│   ├── index.html                最近 7 天
│   ├── archive.html              全部历史
│   ├── app.js / style.css
│   └── feed.json                 站点载荷（由 data/jobs.json 派生）
├── CONTEXT.md                    术语表
└── docs/adr/                     决策记录
```

**运行时**：Node 22+，**零 npm 依赖**，无构建步骤。

### 与 grill 结论的一处修正

第二轮 Q4 定的是三个文件：`seen.json` / `current.json` / `history/`。
落成文档时发现 `seen.json`（`jobId → firstSeenAt`）**与主库完全冗余** ——
`firstSeenAt` 本来就是 `jobs.json` 每条记录的字段。故合并为
`data/jobs.json` 一个累积主库，`current.json` 亦并入（「当前在列」由
`stillListed` 字段表达）。文件数 3 → 2，语义不变。**这是简化，不是变更
需求**；若你希望保留独立状态文件，说一声即可拆回。

---

## 5. 数据源

| 源 | 端点 | 鉴权 | 备注 |
|---|---|---|---|
| JobsDB HK | `hk.jobsdb.com/api/jobsearch/v5/search`，`siteKey=HK-Main` | 无 | SEEK v5，公开 JSON |
| LinkedIn | `www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search` | 无 | **仅个人使用**，见 ADR 0001 |

freehire **不纳入** —— 实测法律岗近乎零命中，且多国标注噪声严重。

### 5.1 关键词（实测定档，2026-10-12）

| track | 关键词 | 实测 totalCount | 精度 |
|---|---|---|---|
| trainee | `trainee solicitor` | 159 | 高 |
| paralegal | `paralegal` | 335 | 高 |

**弃用词（重要）**：

- `training contract` —— 4,598 条，几乎全是 HR/L&D/教育局的 contract 岗。
  SEEK 按字面分词，法律含量≈0。**这个词是陷阱**，尽管它正是本项目旧仓库的名字。
- `training solicitor` —— 109 条，比 `trainee solicitor` 少 30%，且是同一批岗位
  被模糊匹配重新捞出 + 混入法务招聘中介。
- `solicitor` / `legal executive` —— 前者主要是 PQE/in-house，后者被非法律
  "executive" 灌水约 3 倍。

### 5.2 地域

`siteKey=HK-Main` 已把范围锁死在香港，实测 `locations[].label` 全部为香港区份。
**不要**再加 location 过滤 —— provider 取的是区（如 `Kwun Tong, Kwun Tong
District`），加了会误杀真实岗位。

---

## 6. 数据契约

### 6.1 单条职位记录

```json
{
  "id": "jobsdb:87345123",
  "source": "jobsdb",
  "tracks": ["trainee", "paralegal"],
  "title": "Trainee Solicitor / Paralegal",
  "company": "Example & Co. Solicitors",
  "location": "Wan Chai, Wan Chai District",
  "salary": null,
  "postedAt": "2026-10-08",
  "firstSeenAt": "2026-10-09T23:47:12Z",
  "lastSeenAt": "2026-10-13T23:47:31Z",
  "url": "https://hk.jobsdb.com/job/87345123",
  "excerpt": "……前 300 字符……",
  "fingerprint": "sha1(company|normalizedTitle|location)",
  "stillListed": true
}
```

字段语义要点：

- **`tracks` 是多标签数组**。多头广告（`Paralegal / Legal Executive / Trainee
  Solicitor`）同时属于两轨，**是同一条记录**，不是两条。
- **`postedAt` 与 `firstSeenAt` 用途不同**：页面排序用 `postedAt`，
  `NEW` 徽章用 `firstSeenAt`。理由见 §6.3。
- **`stillListed`**：本次扫描还见到 = `true`；连续未见到则置 `false`，
  记录**保留**不删（历史页需要）。

### 6.2 excerpt —— 为什么不存全文

只存 ~300 字符摘要，页面提供跳转原始职位页的链接。

理由有二：(1) repo 每天新增数百条，全文会让仓库持续膨胀；
(2) 整篇复制第三方内容进一个**公开**仓库，版权边界不清。

### 6.3 去重与「新」的判定

这是本设计最容易出错的地方，因为 **JobsDB 上同一岗位 repost 会拿到新 job id**，
中介也会重复发同一岗位。

**两层去重**：

1. **按 `id` 去重** —— 跨关键词、跨源的重复。
   实测两个关键词的结果重叠极重，这是主要风险点而非量级问题。
2. **按 `fingerprint` 识别 repost** —— `sha1(公司 + 归一化标题 + 地点)`。
   指纹命中已有记录时：**保留首次的 `firstSeenAt`，不重新点亮 NEW 徽章**，
   仅追加新的 `id` 到该记录。

**NEW 徽章的判定**：首次被我们扫到（`firstSeenAt`）在最近 7 天内。

> 为什么不用 `postedAt` 判定新旧：一个半年前的岗位 repost 后 `postedAt`
> 看起来是新的。用它会持续产生假 NEW。

**7 天窗口的判定**：按 `postedAt` —— 语义是「最近发布的岗位」。

### 6.4 落盘

- `data/jobs.json` —— 累积主库，扫描时 **upsert**（不重写历史记录的
  `firstSeenAt`）
- `data/history/YYYY-MM-DD.json` —— 当天**新增**的增量快照，便于回溯
  「那天看到了什么」
- `docs/feed.json` —— 站点载荷，由主库派生，裁剪掉站点不用的字段

---

## 7. 定时与自动化

### 7.1 调度

```yaml
on:
  schedule:
    - cron: '47 23 * * *'   # UTC 23:47 = 香港 07:47
  workflow_dispatch:
```

- 用户的原始诉求是「早上 8 点」；GitHub 的 scheduled workflow 在整点会排队，
  通常延迟 5–30 分钟，极端情况**直接跳过**。故取 07:47 起跑，避开 `:00`。
- Actions 侧全部按 UTC 理解，代码里不做时区假设。

### 7.2 权限

```yaml
permissions:
  contents: write      # 提交数据与站点
concurrency:
  group: scan
  cancel-in-progress: false
```

### 7.3 失败降级

**一个源失败不应导致整体失败。** 成功源的结果照常提交，并在
`docs/feed.json` 的 `meta` 里记录本次运行不完整：

```json
{ "meta": { "ranAt": "...", "sources": { "jobsdb": "ok", "linkedin": "failed: timeout" }, "complete": false } }
```

站点在 `complete: false` 时显示一条横幅，提示这次数据不完整。
GitHub 默认会在 workflow 失败时给仓库 owner 发邮件 —— 保留该告警。

> 注：仓库连续 60 天无活动，GitHub 会自动停用 scheduled workflow。
> 本方案的 Action 每天都 commit，因此不会触发。

---

## 8. 站点

### 8.1 技术选型

**零构建。** 纯静态 HTML + 原生 JS，直接 `fetch('feed.json')`。
几百条职位的规模用不上 Astro/Vite，且能少一个失败点 —— Actions 因此只需
干两件事：跑脚本、commit。Pages 设置指向 `main` 分支的 `/docs` 目录即可，
不需要 `actions/deploy-pages` 那套。

### 8.2 页面

| 页面 | 内容 |
|---|---|
| `index.html` | 最近 7 天发布的职位（按 `postedAt`） |
| `archive.html` | 全部历史记录 |

### 8.3 功能

- 关键词搜索（标题 + 公司）
- 按 track 筛选（trainee / paralegal）—— 多标签职位在两个筛选下都出现
- 按发布日期排序
- `NEW` 徽章（仅最近 7 天首次见到）
- 点击跳转原始职位页
- 展示：公司 · 地点 · 薪资 · 发布日期 · 来源
- **「已投递」标记 —— 存 `localStorage`**，不上服务器

> 「已投递」标记换设备/清缓存会丢失。这是明确接受的取舍：为它引入后端会
> 让复杂度跳一个量级。若将来需要跨设备，再单独立项。

### 8.4 数据不完整时的表现

`feed.json` 的 `meta.complete === false` 时，页面顶部显示横幅，列出哪个源
失败。**宁可显式暴露降级，也不要静默地少显示数据。**

---

## 9. 已知风险

| 风险 | 影响 | 应对 |
|---|---|---|
| LinkedIn ToS 为 personal use only | 合规 | 见 ADR 0001；低频、个人使用、不上量 |
| LinkedIn HTML 结构变更 | 解析中断 | 我们自行重写（ADR 0002），需自己修；解析失败要显式报错而非静默返回空 |
| JobsDB 端点变更 | 抓取中断 | 同上；provider 层隔离，改动集中在一处 |
| GitHub Actions IP 被目标站限流/封禁 | 抓取失败 | 目前未观察到；观察 `meta.sources` 的失败率，连续失败则考虑换执行环境 |
| `data/jobs.json` 随时间无限增长 | 仓库膨胀 | 目前预估 350 条/轨；达到 ~1 万条时按年分片 |
| 站点公开爬取结果 | 隐私 | 页面**只含原始职位数据**，不含任何个人意向/备注/shortlist |

---

## 10. 未决项

1. **文档语言**：新仓库是 public 的。代码注释与 README 用中文、英文还是双语？
   （工作区现有 README 是中文；公开仓库通常英文更合适。）
2. **`docs/adr/` 是否随站点一起发布** —— ADR 在 `docs/` 下会被 Pages 一起
   发布出去。若不想公开，需移到 `adr/`。
3. **首次全量回溯**：首次运行时主库为空，所有岗位都会被标成 `NEW`。
   是否要在首次运行时给一个「静默期」（只入库、不点亮徽章）？
   —— 建议：**要**，否则第一天页面上全是 NEW 徽章，徽章失去意义。

---

## 11. 参考

- `TICKETS.md` —— 实施工作项，按依赖排序
- `CONTEXT.md` —— 术语表
- `docs/adr/0001-linkedin-scraping-in-ci.md`
- `docs/adr/0002-extract-rather-than-vendor.md`

---

## 12. 落成时的修正（2026-10-13）

实施过程中实测到的、与本文档原描述不同的地方。**需求未变，只是事实和文档对不齐了。**

### 12.1 §10 未决项的三项决定

1. **文档与注释用中文** —— 与迁移过来的 SPEC/TICKETS/CONTEXT 一致。
2. **`docs/adr/` 移到仓库根目录 `adr/`** —— ADR 含 ToS 取舍等内部分析，
   不随站点一起公开发布。Pages 只发布 `docs/`。
3. **静默期采纳建议，并且是自动的** —— 首次运行（主库为空）自动进入静默期，
   `--no-silent-new` 可强制关闭。入库照记 `firstSeenAt`，只是用 `suppressNew`
   标记不打徽章，字段语义不撒谎。

### 12.2 §6.1 记录增加 `repostIds`（只在与 §6.3 冲突处）

§6.1 的单条记录只列了 `id`，但 §6.3 要求 repost 时「追加新的 `id` 到该记录」——
记录必须能装下第二个 id。新增 `repostIds: [...]`（无 repost 时字段不出现，
§6.1 的形状对绝大多数记录保持不变）。`id` 与 `url` 始终是首次见到的那条，
指向的原始职位页因此永远可点。

### 12.3 §6.3 指纹按源隔离

原文说「指纹命中已有记录」，未限定来源。落成时把指纹匹配**限定在同一源内**：
不同来源的同名岗位是两条记录，各自保留各自的 URL。跨源合并会丢掉一个可点的
原始职位页，代价大于收益。§6.3 的动机（JobsDB repost）本身也是单源问题。

### 12.4 §5 LinkedIn 需要 curl 传输

实测（2026-10-12）：LinkedIn 对 Node `fetch` 一律回 `HTTP 451`，对同一 URL 的
`curl` 回 200 —— 是按 TLS 指纹做的机器流量拦截。故 LinkedIn 走 curl 传输。
curl 不是 npm 依赖，「零 npm 依赖」仍成立。详见 `adr/0003`。

### 12.5 §7.3 增加第三种源状态 `partial`

§7.3 只有 `ok` / `failed`。但 T3 要求「单页失败非致命，返回已收集部分」——
这种半程结果既不是 ok 也不是 failed：拿它判下架会把没抓到的岗位误判成已下架。
故引入 `partial: <原因>`：不计入 `complete`，也没有下架判定权。

### 12.6 负面过滤是无条件的

T5 要求 `titleFilter.negative` 生效。落成时定为**命中即整条丢弃**。
实测代价是 3 条多头广告（如 `Paralegal / Legal Secretary`）会被一并丢掉 ——
在港市场这类广告实质是秘书岗，代价可接受，且改 `config.json` 一行即可放宽。
