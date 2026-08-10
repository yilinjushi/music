# 独立验收记录：Round 2

- 候选：`feat/mobile-pwa`，上游基线 `7f91e87` 加未提交工作区
- 独立验收员：`upstream_arch_audit`（只读，未参与实现）
- 结果：**61/100，较 Round 1 提升 15 分，不得终止**
- Hard Gate：**1 PASS / 2 FAIL / 7 BLOCKED**

## 评分

| 类别                 |    Round 1 |    Round 2 |
| -------------------- | ---------: | ---------: |
| 网易云登录与会话安全 |       9/18 |      12/18 |
| 网易云个人内容       |       5/12 |       5/12 |
| 播放与跨源兜底       |       6/18 |       8/18 |
| 手机 Chrome 交互     |       5/14 |       8/14 |
| PWA 与后台播放       |       7/12 |       9/12 |
| 安全与代理防护       |       6/10 |       8/10 |
| 无广告与隐私         |        5/7 |        6/7 |
| 自动化、性能与稳定性 |        2/7 |        4/7 |
| 可维护性与交付       |        1/2 |        1/2 |
| **总计**             | **46/100** | **61/100** |

## Hard Gate

|   # | 状态    | 主要原因                                                        |
| --: | ------- | --------------------------------------------------------------- |
|   1 | BLOCKED | 无 HTTPS 部署、Android Chrome 或 PWA 启动记录                   |
|   2 | BLOCKED | 无同机真实网易登录、刷新恢复与登出记录                          |
|   3 | FAIL    | 普通文本日志和若干 Functions 原始异常仍可能泄漏凭证             |
|   4 | BLOCKED | 无真实账号歌单进入队列证据                                      |
|   5 | BLOCKED | 无真实冻结 100 首结果；验证器过度信任手填字段                   |
|   6 | BLOCKED | 无真机安装、standalone 与离线深链证据                           |
|   7 | BLOCKED | 无线上抓包，发行扫描未覆盖源码、lockfile 与 Functions           |
|   8 | PASS    | 当前代理、CORS、默认密钥与 Cookie 回显明确条件通过静态/单测复核 |
|   9 | BLOCKED | Playwright 未实际执行且场景不足；无 Lighthouse 结果             |
|  10 | FAIL    | `yilinjushi/music` 不存在；无 `origin`、候选提交或推送          |

## Round 3 本地整改集

1. 封死纯文本、编码文本、旧持久化日志与 Functions 原始异常的凭证泄漏路径；会话 HMAC 与加密 Secret 必须不同。
2. 扩充移动浏览器测试至会话、歌单、队列、失败换源、更新、缩放、控制台与网络错误；触点检查覆盖所有交互控件。
3. 用等效静态/浏览器断言补足现代 Lighthouse 已移除的 PWA 类别；增强 100 首证据格式与自动身份比较。
4. 删除 APK/Capacitor/RSS/Apple 残留；发行策略覆盖源码、Functions、生产依赖和 dist。
5. 使用 workspace-aware CycloneDX 生成器并验证完整性；许可证策略拒绝未知/专有声明。
6. 证据记录候选状态、diff、lock 与 dist 哈希；保存 audit、license、SBOM、浏览器与 Lighthouse 原始结果。

## 外部阻断

- 创建并推送 GitHub 私有仓库；
- Cloudflare Pages、KV、Secrets、同域 HTTPS；
- Android 真机、真实 Chrome 与真实网易账号；
- 合法冻结的 100 首样本及完整测试时段；
- 真实安装、同机登录、后台/锁屏、离线恢复与运行抓包；
- 公开或商业分发前的上游授权澄清。

以上外部证据不得用 mock、静态实现或加权总分替代。
