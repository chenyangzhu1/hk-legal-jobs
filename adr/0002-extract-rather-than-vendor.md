# 自行抽取抓取代码，而非 vendor career-ops

`career-ops` 已经实现了 JobsDB 抓取，直接 vendor 或 `git clone` 后调用是
最短路径。我们仍选择只抽取所需的最小闭包并自行维护（JobsDB 侧约 220 行，
LinkedIn 侧约 200 行，均零 npm 依赖）。

理由：`scan.mjs` 单文件 4,086 行，闭包里带进 20 余个模块、需要 `js-yaml`、
可选 Playwright，并会写四份我们不需要的状态文件。我们只需要两个写死的
公开端点，而代价是每天在 CI 里拖着一个通用求职 agent 的全部重量，
并承受其 updater 在流水线里做出意外动作的风险。

**考虑过的替代方案**：逐字复制 provider 的完整依赖闭包（6 文件 / 1,435 行），
保留其中的 DNS 缓存与私网地址防护。予以否决 —— 那些防护是为「多 provider
框架扫描任意公司 ATS 域名」而存在的，单一可信端点用不上。但
**保留了 `ALLOWED_JOBSTREET_HOSTS` 白名单**，因为它是唯一防止配置写错
把请求打到别处的东西。

**后果**：上游修 bug 我们收不到，LinkedIn 或 JobsDB 改结构需自行跟进。
这是用维护成本换取可读性与零依赖的自觉取舍。
