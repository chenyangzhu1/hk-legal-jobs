# hk-legal-jobs

每日自动抓取香港的 **Trainee Solicitor** 与 **Paralegal** 职位，去重后落盘为 JSON，
并发布为可搜索、可筛选的静态页面：

- **最近 7 天** → <https://chenyangzhu1.github.io/hk-legal-jobs/>
- **全部历史** → <https://chenyangzhu1.github.io/hk-legal-jobs/archive.html>

从发布到出现在页面上全自动，无人值守。

---

## 怎么跑

需要 **Node 22+**。没有依赖，没有构建步骤，不需要 `npm install`。

```bash
node src/scan.mjs                  # 抓取并写盘
node src/scan.mjs --dry-run        # 只看统计，不写任何文件
node src/scan.mjs --silent-new     # 入库但不点亮 NEW 徽章
node --test                        # 跑全部测试
```

本地看页面（Pages 是纯静态的，任何静态服务器都行）：

```bash
cd docs && python3 -m http.server 8000   # 然后打开 http://localhost:8000
```

## 怎么改

**`config.json` 是唯一需要改的文件。**

| 想改什么 | 改哪里 |
|---|---|
| 搜索关键词 | `tracks.<track>.searchKeywords` |
| 什么样的标题算这个 track | `tracks.<track>.titlePatterns`（**全部**命中才算） |
| 排除哪些标题 | `titleFilter.negative` |
| 抓多少页 | `sources.<源>.maxPages` / `pageSize` |
| 请求节奏 | `sources.<源>.pageDelayMs`、`http.minIntervalMs` |
| NEW 徽章 / 最近列表的天数 | `site.newBadgeDays` / `site.recentDays` |

`titlePatterns` 与 `titleFilter.negative` 都是**正则**（大小写不敏感），所以
`\\bsecretary\\b` 只匹配独立单词，不会误伤 `Internal`。

### 两个需要知道的取舍

**1. `trainee` 要求 `trainee` 与 `solicitor` 同时出现。** 这样
`Paralegal Trainee` 只会拿到 `paralegal`，不会被误标成见习律师岗。

**2. `titleFilter.negative` 是无条件生效的。** 命中即整条丢弃，
`Paralegal / Legal Secretary` 这类多头广告也会被丢掉 —— 在港市场这类广告
实质是秘书岗。想保留它们，把词从 `negative` 里删掉即可。

## 数据

```
data/jobs.json                 累积主库（每条的真相）
data/history/YYYY-MM-DD.json   当天新增的增量快照
docs/feed.json                 站点载荷（由主库派生，裁掉页面不用的字段）
```

主库只增不删。职位消失时置 `stillListed: false`，记录保留 —— 历史页需要它，
而且它下次再出现时能认出来，不会被当成新职位。

**去重有两层**（这是本项目最容易出错的地方）：

1. **按 `id`** —— 跨关键词、跨页的重复。
2. **按 `fingerprint`** —— `sha1(公司 + 归一化标题 + 地点)`。JobsDB 上同一职位
   repost 会拿到新 job id，中介也会重复发同一职位。指纹命中时**保留首次的
   `firstSeenAt`、不重新点亮 NEW**，新 id 追加到 `repostIds`。

标题归一化对大小写、全角/半角、标点、单复数、以及 `/` 分隔的头序都不敏感，
所以 `Paralegal / Trainee Solicitor` 与 `Trainee Solicitor/Paralegal` 是同一个指纹。
公司名**只**做大小写与标点归一化，不消除 `Co` / `Company` / `Ltd` 之类的后缀 ——
误合两家名字相近的所会让一条真实职位消失，比少识别一次 repost 更糟。

指纹**按源隔离**：不同来源的同名职位是两条记录，各自保留各自可点的原始链接。

## 自动化

`.github/workflows/scan.yml` 每天 **07:47 HKT** 跑一次（UTC 23:47 —— 整点会被
GitHub 排队甚至跳过，所以错开 `:00`），也可以手动 `workflow_dispatch`。

**一个源失败不会导致整体失败。** 成功源的数据照常提交，`feed.json` 的
`meta.sources` 如实记录各源状态，页面顶部显示降级横幅 —— 宁可显式暴露降级，
也不要静默地少显示数据。

源只抓了一半（第 2 页起失败）会记成 `partial`：它没有「下架判定权」，
也不能算 `complete`，否则会把没抓到的职位误判成已下架。

退出码：全部源失败 → 1（workflow 会失败并给 owner 发邮件，这个告警是特意保留的）；
部分失败 → 0，但 `complete: false`。

## 关于 LinkedIn 与 curl

LinkedIn 的公开 `jobs-guest` 端点是**无鉴权**的，但它的服务条款将访问限定为
**personal use only**（见 [adr/0001](adr/0001-linkedin-scraping-in-ci.md)）。
本项目以低频率、单一关键词、每日一次的方式用它 —— 这是有意识的取舍。

**实测（2026-10-12）：LinkedIn 对 Node 自带的 `fetch` 一律回
`HTTP 451 Unavailable For Legal Reasons`**，换任何 User-Agent / Accept 组合都一样；
同样的 URL 用 `curl` 拿 200。这是按 TLS 指纹做的机器流量拦截，不是内容协商。

所以 LinkedIn 走 `curl` 传输（`config.json` 里 `sources.linkedin.transport: "curl"`）。
**curl 不是 npm 依赖**，"零依赖"依然成立。详见
[adr/0003](adr/0003-curl-transport-for-linkedin.md)。

如果哪天 LinkedIn 从 CI 里也被挡死，把它 `enabled: false` 即可 —— JobsDB 是主力源
（实测约占七成职位），单独跑完全可用。

## 明确不做

- ❌ 不做匹配度评分、不做简历/求职信定制、不做投递 —— 只做「看见」
- ❌ 不覆盖香港以外地区
- ❌ 不做后端、不做账号系统
- ❌ 不存 JD 全文（只存 ~300 字符摘要，页面提供跳转原始职位页的链接）
- ❌ 「已投递」标记只存浏览器 `localStorage`，换设备或清缓存会丢失。这是明确接受的
  取舍：为它引入后端会让复杂度跳一个量级

页面**只含原始职位数据**，不含任何个人意向 / 备注 / 短名单。

## 已知限制

| 限制 | 说明 |
|---|---|
| LinkedIn 职位没有摘要 | 搜索结果卡片不带 JD 文本。逐条取详情页会把请求量翻十倍，与 ADR 0001 的低频承诺冲突，所以留空 |
| 中文职位标题可能漏掉 | 两条 track 的模式是英文 (`trainee`+`solicitor` / `paralegal`)，纯中文标题如「法务专员」本就不属于这两类 |
| `data/jobs.json` 会持续增长 | 预估每年数千条；到 ~1 万条时按年分片 |
| 目标站改结构就断 | 解析失败会显式抛错而不是静默返回空，`meta.sources` 里会看到 |

## 文档

- [SPEC.md](SPEC.md) —— 规格说明（含落成时对设计的修正）
- [TICKETS.md](TICKETS.md) —— 实施工作项与验收
- [CONTEXT.md](CONTEXT.md) —— 术语表
- [adr/](adr/) —— 决策记录
