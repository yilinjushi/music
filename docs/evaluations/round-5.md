# 独立验收记录：Round 5

- 候选：`feat/mobile-pwa`，上游基线 `7f91e87` 加未提交工作区
- 独立验收员：`round5_independent_eval`（严格只读，未参与实现）
- 结果：**74/100，未达到 99，不得终止**
- Hard Gate：**1 PASS / 4 FAIL / 5 BLOCKED**

## 评分

| 类别                 |    Round 4 |    Round 5 |
| -------------------- | ---------: | ---------: |
| 网易云登录与会话安全 |      14/18 |      14/18 |
| 网易云个人内容       |       6/12 |       6/12 |
| 播放与跨源兜底       |      11/18 |      12/18 |
| 手机 Chrome 交互     |      11/14 |      11/14 |
| PWA 与后台播放       |      10/12 |       9/12 |
| 安全与代理防护       |       9/10 |       9/10 |
| 无广告与隐私         |        6/7 |        6/7 |
| 自动化、性能与稳定性 |        6/7 |        6/7 |
| 可维护性与交付       |        1/2 |        1/2 |
| **总计**             | **74/100** | **74/100** |

## Hard Gate

|   # | 状态    | 主要原因                                                                       |
| --: | ------- | ------------------------------------------------------------------------------ |
|   1 | BLOCKED | 无已部署 HTTPS Android Chrome/PWA 启动证据                                     |
|   2 | BLOCKED | 无同一 Android 手机真实网易登录、刷新恢复和退出验证                            |
|   3 | FAIL    | 自定义 API URL、四重编码日志/服务端扫描和能力 URL 仍有敏感数据旁路             |
|   4 | BLOCKED | 无真实账号个人歌单进入队列和播放的证据                                         |
|   5 | FAIL    | 无合法冻结 100 首结果，且 Bilibili 标题与过期自动匹配仍有确定性缺陷            |
|   6 | BLOCKED | 无 Android 安装、standalone、离线、后台和锁屏证据                              |
|   7 | BLOCKED | 静态扫描通过，但无部署运行抓包证明零广告/统计                                  |
|   8 | PASS    | 未发现任意 URL 公共代理、任意 Origin credentialed CORS、默认密钥或 Cookie 回显 |
|   9 | FAIL    | 正式 Playwright JUnit 为 56 skipped、0 executed，且 verification JSON 缺失     |
|  10 | FAIL    | 无目标 private repo/origin/候选 commit/push/正式 GitHub CI                     |

## Round 5 已确认

- 曲目、备份、同步和历史入口已增加敏感值过滤与旧存储迁移；URL 解析缓存已改为内存和匿名键，logout/401 会等待旧 IndexedDB 清除。
- URL resolver 的 A/B 请求所有权、暂停期间不自动恢复、Bilibili 全歌手证据、12 秒 fetch+body deadline、精确 HTTPS `APP_ORIGIN` 已落地。
- 完整本地 CI 通过：76 个 Vitest 文件、551 项测试，lint 0 error/76 warnings；双 typecheck、build、PWA/release/license、两档 audit 与 120/120 SBOM 通过。
- 六份 Lighthouse 原始 LHR 已哈希绑定并交叉核验；Search 中位 0.88、Settings 中位 0.85，A11y/Best Practices 均 1.00，零 warning/console error。
- Chromium 149 隔离诊断为 29/29；其 scope 明确不是正式 Playwright CI，也不是 Android 物理真机证据。
- evidence manifest 正确拒绝 dirty 工作树与 list-only Playwright，并保持 `automatedReleaseCandidateEligible:false`。

## Round 6 本地整改

- 为自动换源增加 AbortSignal 与 track/index/source/url owner 校验，禁止过期请求写 queue、context、playlist、favorites 或 URL cache。
- 收紧 Bilibili 标题身份：完整歌手相同时也必须拒绝 `Song` 到 `Song 2` 等不同曲名。
- 修复同 URL recovery/quality reload，以及终态 `audio.src = ""` 产生的迟到 error 和额外恢复。
- URL cache 增加 generation/write lease，防止 logout/401 后的在途解析重新写回。
- 自定义 API URL、logger、Functions、track/playlist/sync schema 统一至少四轮敏感解码、完整字段表与显式白名单。
- `sync` v1/v2 增加尺寸、数量、深度与解压后上限，并对响应使用 `private, no-store`。
- 禁止签名媒体 capability 进入公共缓存；非流式上游响应增加 body byte hard limit。
- 使用未修改生产生命周期的 Service Worker 更新测试，避免测试夹具替产品补行为。

## 外部阻断

- GitHub 连接器确认当前账号为 `yilinjushi`，安装范围无 `music`，`yilinjushi/music` 为 404；当前工具没有创建仓库或 fork 的能力。
- 仍需 private origin、clean commit/push、正式 GitHub Actions；同域 Cloudflare HTTPS/KV/独立 secrets；真实网易账号与个人内容；合法冻结 100 首；Android Stable 物理真机安装、standalone、离线、更新、后台/锁屏/耳机键/弱网；运行抓包；公开或商用前授权澄清。

这些阻断不能用 mock、localhost、静态实现或加权分数替代。
