# 香港法律职位抓取

一个定时抓取香港 Trainee Solicitor 与 Paralegal 职位、并发布为静态网页的
系统。本文件只定义这套系统使用的语言。

## Language

**Trainee Solicitor**:
香港律所通过两年 Training Contract 培养的见习律师职位。
_Avoid_: training solicitor、实习律师

**Training Contract**:
律所与 Trainee Solicitor 之间的两年培养合约。
_Avoid_: 拿这个词做职位搜索 —— SEEK 按字面分词，返回的是 HR/L&D/教育局的合约岗

**Paralegal**:
与 Trainee Solicitor 平行、但申请路径与招聘周期都不同的独立岗位。
_Avoid_: 把两者当作同一批职位

**Track**:
本系统的职位分类维度，目前有两条：trainee、paralegal。一条职位可同时属于多条。
_Avoid_: 类别、category

**Listing**:
某个来源上的一条招聘信息，在来源内拥有唯一 ID。
_Avoid_: posting、ad、岗位

**Repost**:
同一 Listing 在来源上重新发布，因而获得新 ID。它的发布日期会变新，但职位本身不是新的。
_Avoid_: 把它当作新职位

**NEW**:
一种徽章状态，表示该 Listing 首次被本系统见到的时间落在最近 7 天内。
由「首次见到」而非「发布日期」决定。
_Avoid_: 新发布、新上市

**Source**:
Listing 的提供方。目前两个：JobsDB、LinkedIn。
_Avoid_: 爬虫、站点

**首次见到（first seen）**:
本系统第一次抓到某条 Listing 的时刻。与「发布日期」是两个不同的时间，不可互相替代。

**发布日期（posted date）**:
来源声称的发布日。Repost 会让它变新，因此不能用来判断职位是否新鲜。

**指纹（fingerprint）**:
`sha1(公司 + 归一化标题 + 地点)`，用来识别 Repost。归一化对大小写、全角/半角、
标点、单复数、以及 `/` 分隔的头序不敏感。
_Avoid_: 把指纹当成「同一条职位」的判据跨源使用 —— 它按源隔离

**静默期**:
系统首次运行时的入库窗口。此期间抓到的 Listing 只入库、不点亮 NEW 徽章，
以免第一天页面上全部是 NEW 而失去意义。

**半程抓取（partial）**:
某个 Source 本次只抓到了部分页就失败。它的结果会被采用，但**不能**用来判定
下架，也**不能**算作 complete —— 否则没抓到的 Listing 会被误判成已下架。
_Avoid_: 把 partial 当作 failed（会丢掉已抓到的数据）或当作 ok（会误判下架）
