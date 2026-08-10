# 独立验收记录：Round 3

- 候选：`feat/mobile-pwa`，上游基线 `7f91e87` 加未提交工作区
- 独立验收员：`upstream_arch_audit`（严格只读，未参与任何实现）
- 结果：**67/100，较 Round 2 提升 6 分，不得终止**
- Hard Gate：**1 PASS / 2 FAIL / 7 BLOCKED**

## 评分

| 类别                 |    Round 2 |    Round 3 |
| -------------------- | ---------: | ---------: |
| 网易云登录与会话安全 |      12/18 |      14/18 |
| 网易云个人内容       |       5/12 |       6/12 |
| 播放与跨源兜底       |       8/18 |       8/18 |
| 手机 Chrome 交互     |       8/14 |       9/14 |
| PWA 与后台播放       |       9/12 |       9/12 |
| 安全与代理防护       |       8/10 |       9/10 |
| 无广告与隐私         |        6/7 |        6/7 |
| 自动化、性能与稳定性 |        4/7 |        5/7 |
| 可维护性与交付       |        1/2 |        1/2 |
| **总计**             | **61/100** | **67/100** |

## Hard Gate

|   # | 状态    | 主要原因                                                               |
| --: | ------- | ---------------------------------------------------------------------- |
|   1 | BLOCKED | 无 HTTPS 部署、Android Chrome 启动或严重错误记录                       |
|   2 | BLOCKED | 无同机真实网易登录、刷新恢复与登出记录                                 |
|   3 | BLOCKED | 本地凭证路径已加固，但无真实登录后的 Storage、Cache、日志与网络扫描    |
|   4 | BLOCKED | 分页实现已有测试，但无真实账号歌单进入队列证据                         |
|   5 | FAIL    | 无真实 100 首结果，且运行时换源仍可能接受 Live/合作版等错误版本        |
|   6 | BLOCKED | 静态 PWA 合同通过，但无安装、standalone 或真机离线证据                 |
|   7 | BLOCKED | 源码、依赖与 dist 扫描通过，但无接受环境运行抓包                       |
|   8 | PASS    | 未发现任意 URL 代理、任意 Origin 凭证 CORS、默认管理密钥或 Cookie 回显 |
|   9 | BLOCKED | Playwright 52/52 skipped、0 executed；Lighthouse 0 measurements        |
|  10 | FAIL    | 目标私有仓不存在、无 `origin`，候选未提交且 manifest 不可发布          |

## Round 3 已确认

- 生产日志全部经脱敏 logger，Functions 仅接受固定事件码；会话 HMAC 与凭证加密 Secret 强制独立。
- 代理对缺失/非法 Content-Type 默认拒绝；CORS、认证、重定向、限流与安全头测试成立。
- Web 发行源码及 dist 已无 Capacitor、Android、Podcast、AList 与 Apple Music 入口。
- 网易用户歌单实现 `limit/offset/more` 分页。
- 本地门禁：63 个 Vitest 文件、427 tests、7 个证据测试；release 扫描覆盖 283 个运行源码、117 个生产依赖、50 个 dist 文件；两类 audit 均为 0；CycloneDX 生产闭包 120/120。
- Playwright 证据门禁正确拒绝 list-only JUnit；Lighthouse 无 Chrome 时正确失败，没有误报。

## Round 4 本地整改集

1. 换源身份判断加入完整歌手集合、版本标记、专辑和时长约束；只有 Live/伴唱/合作等错误候选时必须拒绝。
2. 增加主源失败、正确次源成功并实际播放的确定性 E2E；JUnit 门禁强制该场景执行。
3. 将代理响应头超时与流式空闲超时分开，合法慢速分块可继续，停滞流会中止，总字节上限不变。
4. 最终证据清单哈希绑定 `ci-summary.json`、Playwright 与 Lighthouse；只允许干净候选获得发布资格。

## 外部阻断

- 创建并推送 GitHub 私有 `yilinjushi/music`；
- Cloudflare Pages/Functions、KV、独立 Secrets 与同域 HTTPS；
- Android 真机、稳定版 Chrome、真实网易账号与真实个人内容；
- 合法冻结的至少 100 首样本及独立真机/网络佐证；
- 安装、standalone、离线、更新、30 分钟后台、锁屏/耳机键；
- 登录/登出后的凭证 canary 扫描与无广告运行抓包；
- 公开或商业分发前的上游授权澄清。

以上外部证据不得用 mock、静态实现、list-only 或加权分数替代。
