# 独立验收记录：Round 7

- 候选：`feat/mobile-pwa`，上游基线 `7f91e87` 加未提交工作区
- 独立验收员：`round7_independent_eval`（严格只读，未参与实现）
- 结果：**77/100，未达到 99，不得终止**
- Hard Gates：**1 PASS / 4 FAIL / 5 BLOCKED**
- 说明：仓库不存在 Round 6 独立报告，因此不虚构 Round 6 分数或增量；本轮只与 Round 5 的 74/100 比较。

## 评分

| 类别                 |    Round 5 |    Round 7 |   变化 |
| -------------------- | ---------: | ---------: | -----: |
| 网易云登录与会话安全 |      14/18 |      14/18 |      0 |
| 网易云个人内容       |       6/12 |       6/12 |      0 |
| 播放与跨源兜底       |      12/18 |      14/18 |     +2 |
| 手机 Chrome 交互     |      11/14 |      12/14 |     +1 |
| PWA 与后台播放       |       9/12 |      10/12 |     +1 |
| 安全与代理防护       |       9/10 |       8/10 |     -1 |
| 无广告与隐私         |        6/7 |        6/7 |      0 |
| 自动化、性能与稳定性 |        6/7 |        6/7 |      0 |
| 可维护性与交付       |        1/2 |        1/2 |      0 |
| **总计**             | **74/100** | **77/100** | **+3** |

## Hard Gates

|   # | 状态    | 类型             | 主要原因                                                                    |
| --: | ------- | ---------------- | --------------------------------------------------------------------------- |
|   1 | BLOCKED | EXTERNAL         | 无已部署 HTTPS Android Chrome/PWA 启动证据                                  |
|   2 | BLOCKED | EXTERNAL         | 无同一 Android 手机真实网易登录、刷新恢复和退出验证                         |
|   3 | FAIL    | LOCAL            | capability 响应可回显账号凭证；播放器仍接受外层 credential-bearing URL      |
|   4 | BLOCKED | EXTERNAL         | 无真实账号个人歌单进入队列和播放的证据                                      |
|   5 | FAIL    | LOCAL + EXTERNAL | 新曲可继承旧自动换源上下文；无合法冻结 100 首、≥99% 且零错配结果            |
|   6 | BLOCKED | EXTERNAL         | 无 Android 真机安装、standalone、离线、更新、后台和锁屏证据                 |
|   7 | BLOCKED | EXTERNAL         | 静态无广告扫描通过，但无部署运行抓包                                        |
|   8 | FAIL    | LOCAL            | generic capability 路由仍可能回显 Cookie/credential                         |
|   9 | PASS    | LOCAL ONLY       | 本地类型、lint、691 项 Vitest、构建、安全测试及 Playwright 29/29 执行项通过 |
|  10 | FAIL    | DELIVERY         | 无 private `origin`、候选 commit/push、正式 GitHub CI；工作区仍 dirty       |

## Round 7 已确认

- Fresh 播放 URL 规范化、foreign `/proxy` 重包、auto/manual owner、AbortController 与局部 CAS 已实现。
- 浏览器、Functions 和 sync 共用窄入口 canonical sensitive-field policy，并统一四轮解码。
- Bilibili 浏览器只持有同源 `bvid/cid` 请求；服务端解析签名 URL。QQ `type=url` 强制 `private, no-store`。
- LX 客户端 discovery/playback fail closed，并从默认聚合来源移除。
- 敏感 helper bundle 回归门禁通过，当前相关 chunk 为 7,068 bytes，未包含 provider crypto。
- 本地 CI 通过：85 个 Vitest 文件、691 项测试；双 typecheck、lint、build、PWA/release/license、audit 与 SBOM 门禁通过。
- Playwright 发现 56 项，实际执行并通过 29 项，27 项按 viewport 矩阵有意跳过，0 failure/error。
- 六份 Lighthouse：Search 三次 0.86；Settings 为 0.87/0.93/0.93；A11y/Best Practices 均为 1.00，零 warning/console error。
- 上述浏览器证据来自本地 Linux Chromium 149，不等同 Android 真机或 GitHub Actions。

## 已确认的本地 P1

1. capability 路由把“允许签名能力字段”错误等同于“允许任何敏感字段”，上游 JSON 可回显 `MUSIC_U`、Cookie 或 Authorization。
2. direct/current-proxy 播放 URL 未完整拒绝外层 userinfo、fragment、账号凭证和 capability 参数。
3. `AutoMatchContext` 只绑定索引，播放上下文更换后同索引新曲可继承旧曲的 `tried` 集合。
4. 曲目身份在多个 store、helper、历史与 sync merge 中仍只使用 `id`，跨来源同 ID 会误删、误选或覆盖。
5. 分享在没有 canonical 页面 URL 时回退到 `currentAudioUrl`，可把 QQ `vkey` 等 bearer capability 写入剪贴板。
6. 网易账号/私有歌单响应虽由服务端声明 `private, no-store`，前端仍会通过 generic `cachedFetch` 写入 Cache Storage 一小时。
7. sync-v2 的 KV read/check/write 不是 CAS，并发 push 或 pull 后台 GC 回写可覆盖新数据。
8. Playwright verifier 未绑定 Git/source diff、浏览器二进制/version 与 dist 前后快照；final manifest 也可能接受旧 commit 的忽略目录证据。

## Round 8 最小整改集

1. capability 与 account credential 递归分类分离；任何 endpoint 都无条件拒绝 Cookie、`MUSIC_U`、Authorization 和账户 token 回显。
2. 所有播放器 URL 对 protocol、userinfo、fragment、credential 与 capability 做 fail-closed 校验，只允许受控同源媒体端点。
3. 统一 `source + id + url_id` 曲目身份，覆盖 store、历史、选择、删除、DnD、收藏、歌单与同步合并。
4. `AutoMatchContext` 绑定完整曲目 identity/context generation；分享仅允许 canonical 页面 URL。
5. 网易账号派生响应完全绕过持久 Cache Storage。
6. sync 使用真正原子存储；若当前部署模型无法证明 CAS，则安全退役写同步和 UI 入口，不以进程内锁伪装。
7. 全部证据绑定同一候选源码摘要、Git 状态、lock、dist 和实际浏览器；加入旧源码、旧 dist、缺失 browser context 等负向测试。

## 外部阻断

- 当前仅有只读 `upstream`，没有 private `origin`、clean candidate commit/push 或正式 GitHub Actions。
- 没有同域 Cloudflare HTTPS、KV/独立 secrets 与边缘响应头证据。
- 没有真实网易账号、个人资料/歌单、冻结 100 首及错误匹配为零的结果。
- 没有 Android Stable 物理真机安装、standalone、离线/更新、后台 30 分钟、锁屏/耳机键/弱网证据。
- 没有部署环境 credential canary、无广告/统计运行抓包；公开或商用仍需上游授权澄清。

这些外部阻断不能由 mock、localhost、静态实现或加权分数替代。
