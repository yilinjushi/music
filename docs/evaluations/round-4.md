# 独立验收记录：Round 4

- 候选：`feat/mobile-pwa`，上游基线 `7f91e87` 加未提交工作区
- 独立验收员：`round4_independent_eval`（严格只读，未参与实现）
- 结果：**74/100，较 Round 3 提升 7 分，不得终止**
- Hard Gate：**1 PASS / 3 FAIL / 6 BLOCKED**

## 评分

| 类别                 |    Round 3 |    Round 4 |
| -------------------- | ---------: | ---------: |
| 网易云登录与会话安全 |      14/18 |      14/18 |
| 网易云个人内容       |       6/12 |       6/12 |
| 播放与跨源兜底       |       8/18 |      11/18 |
| 手机 Chrome 交互     |       9/14 |      11/14 |
| PWA 与后台播放       |       9/12 |      10/12 |
| 安全与代理防护       |       9/10 |       9/10 |
| 无广告与隐私         |        6/7 |        6/7 |
| 自动化、性能与稳定性 |        5/7 |        6/7 |
| 可维护性与交付       |        1/2 |        1/2 |
| **总计**             | **67/100** | **74/100** |

## Hard Gate

|   # | 状态    | 主要原因                                                                       |
| --: | ------- | ------------------------------------------------------------------------------ |
|   1 | BLOCKED | 无 Android Chrome 真实 HTTPS 启动证据                                          |
|   2 | BLOCKED | 无同一手机真实扫码、刷新恢复和退出验证                                         |
|   3 | FAIL    | 任意 URL、备份或同步曲目中的敏感赋值仍可能进入 JS 可读 IndexedDB               |
|   4 | BLOCKED | 无真实网易账号个人歌单进入队列/播放证据                                        |
|   5 | BLOCKED | 本地换源证据改善，但无合法冻结的 100 首、≥99% 可播与零错配结果                 |
|   6 | BLOCKED | 无 Android 安装、standalone、后台与更新恢复证据                                |
|   7 | BLOCKED | 静态扫描通过，但无部署环境运行抓包                                             |
|   8 | PASS    | 未发现任意 URL 代理、任意 Origin credentialed CORS、默认管理凭据或 Cookie 回显 |
|   9 | FAIL    | 正式 Playwright JUnit 为 56 skipped、0 executed，且缺 verification JSON        |
|  10 | FAIL    | 无目标 private repo/origin，HEAD 仍为基线且工作树未提交/未推送                 |

## Round 4 已确认

- 严格版本/歌手/专辑/时长匹配与主源失败后正确次源播放的本地实现成立，但 Bilibili 证据仍偏宽。
- 本地 Chromium 诊断 29/29 通过；它明确不是正式 CI 或 Android 真机证据。
- 冻结态完整 CI：67 个 Vitest 文件、462 tests、18 个证据测试；lint 0 error、78 warning（低于 86 基线）；双类型检查、build、PWA/release/license 门禁通过。
- 生产和完整依赖 audit 均为 0；CycloneDX 生产闭包 120/120。
- 六次隔离 Lighthouse：Search 中位 0.91、Settings 中位 0.88，A11y/Best Practices 全 1.00，零 warning/console error；仅证明本地 synthetic delivery。
- 代理已具备逐跳响应头、流空闲、绝对时长和 150 MiB 硬上限。
- evidence manifest 正确拒绝 dirty 工作树和 0-executed Playwright；但尚未把六份原始 LHR 设为必需、强绑定输入。

## Round 5 本地整改

- 曲目 ingress 敏感数据拒绝、旧 IndexedDB 迁移和 URL cache key 摘要化；
- 401/logout/恢复时清理能力 URL 的两层缓存；
- 快速切歌旧请求竞态；
- Bilibili 完整歌手证据；
- `APP_ORIGIN` 生产 fail-closed；
- 六份 raw LHR 与 summary/hash 强绑定；
- 完整 Service Worker 更新恢复 E2E。

## 外部阻断

- 创建并推送 GitHub 私有 `yilinjushi/music`，得到 clean commit 与正式 GitHub CI；
- Cloudflare Pages/Functions、KV、独立 Secrets 与严格同域 HTTPS；
- Android Stable Chrome、真实网易账号及个人内容；
- 合法冻结的至少 100 首样本、≥99% 可播及零错配；
- 安装、standalone、离线、更新、30 分钟后台、锁屏/耳机键；
- 登出后的凭证 canary/能力 URL 扫描与零广告运行抓包；
- 公开或商业分发前的上游授权澄清。

这些外部证据不得用 mock、静态实现、list-only 或加权分数替代。
