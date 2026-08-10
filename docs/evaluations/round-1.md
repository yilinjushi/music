# 独立验收记录：Round 1

- 候选：`feat/mobile-pwa`，上游基线 `7f91e87` 加未提交工作区
- 独立验收员：`upstream_arch_audit`（仅参与基线与验收，未参与实现）
- 结果：**46/100，不得终止**
- Hard Gate：**0 PASS / 4 FAIL / 6 BLOCKED**

## 开发侧自动证据

Round 1 冻结前由主开发流程执行：

| 门禁                   | 结果                                |
| ---------------------- | ----------------------------------- |
| `npm ci`               | PASS                                |
| 前端 TypeScript        | PASS                                |
| Functions TypeScript   | PASS                                |
| Vitest                 | 58 files / 446 tests PASS           |
| ESLint                 | 0 errors / 126 warnings（基线 134） |
| 生产构建               | PASS                                |
| 发布产物扫描           | 81 files，约 1.43 MB JS，PASS       |
| `npm audit --omit=dev` | 0 vulnerabilities                   |
| `git diff --check`     | PASS                                |

独立验收员保持只读，没有重新安装依赖或重建产物；其结论不把上述自动证据等同于真机证据。

## 评分

| 类别                 |       得分 |
| -------------------- | ---------: |
| 网易云登录与会话安全 |       9/18 |
| 网易云个人内容       |       5/12 |
| 播放与跨源兜底       |       6/18 |
| 手机 Chrome 交互     |       5/14 |
| PWA 与后台播放       |       7/12 |
| 安全与代理防护       |       6/10 |
| 无广告与隐私         |        5/7 |
| 自动化、性能与稳定性 |        2/7 |
| 可维护性与交付       |        1/2 |
| **总计**             | **46/100** |

## Hard Gate

|   # | 状态    | 主要原因                                             |
| --: | ------- | ---------------------------------------------------- |
|   1 | BLOCKED | 无 HTTPS 部署与 Android Chrome 真机证据              |
|   2 | BLOCKED | 无同一手机真实网易登录、刷新恢复和登出证据           |
|   3 | FAIL    | 通用 music 缓存键及字符串错误值仍可能携带凭证 canary |
|   4 | BLOCKED | 无真实账号歌单载入与队列证据                         |
|   5 | BLOCKED | 无冻结 100 首样本及零错配报告                        |
|   6 | BLOCKED | 无真机安装、standalone 与离线深链证据                |
|   7 | BLOCKED | 静态扫描通过，但无线上运行抓包                       |
|   8 | FAIL    | 代理后缀和 CSP 范围仍偏宽                            |
|   9 | FAIL    | 无浏览器 E2E、axe、Lighthouse；CI 仍有 warning 基线  |
|  10 | FAIL    | GitHub 私有派生仓不存在，且缺候选提交/SBOM           |

## Round 2 最小整改集

1. 敏感字段名、字符串值、缓存键和错误日志加入统一 canary 防线。
2. 从源码与发布 bundle 彻底移除 Capacitor、Android、Podcast、AList 首版能力。
3. 增加 PWA 安装状态/引导，并修复核心主路径触控目标与键盘语义。
4. 收紧代理主机与 CSP；发布扫描阻止原生/非核心 chunk 回归。
5. 生成 SBOM、许可证清单和机器可读 Round 2 验证报告。

## 外部阻断

- GitHub 私有仓库创建及推送权限；
- Cloudflare Pages、KV、Secrets 与 HTTPS 域名；
- Android 真机、Chrome 和真实网易账号；
- 合法冻结的 100 首测试样本与足够的测试时段；
- 公开/商业分发前的上游授权澄清。

以上阻断不得用 mock、静态实现或加权总分替代。
