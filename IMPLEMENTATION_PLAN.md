# Music PWA 实施与循环验收计划

状态：Round 8 执行中；Round 7 独立验收 77/100，任务不得终止
基线：`DJChanahCJD/otter-music@7f91e87`
目标仓库：`yilinjushi/simpsons`（私有仓库；以当前音乐 PWA 替换原仓库内容，同时保留 Git 历史）
目标平台：Android 手机 Chrome 与可安装 PWA；不发布 APK，不进入应用商店

## 1. 最终目标

交付一个无广告、无统计埋点、适合手机 Chrome 日常使用的音乐播放器：

- 可通过网易云账号登录并恢复会话；
- 可读取本人网易云歌单、收藏和推荐内容；
- 可把网易云歌单作为曲目目录，网易不可播时允许其他合法配置的音源匹配播放；
- 支持搜索、队列、收藏、歌词、播放进度、后台播放和 Media Session；
- 可从 Chrome 安装到主屏幕，但本质仍是网站/PWA；
- 网易云凭证不进入 JavaScript 可读存储、日志、缓存键或 API 响应；
- 不包含广告、推广弹窗、用户分析、行为追踪或广告 SDK；
- 有可重复的自动验收，并由未参与当轮开发的独立 subagent 复核。

## 2. 范围与边界

### 本轮必须完成

1. 以 Otter Music 为代码底座建立私有派生仓，保留来源、提交历史和上游同步方式。
2. 将支持目标收敛到 Web/PWA，移除或隐藏 Android 原生专属入口和发布流程。
3. 把网易云 Cookie 改为同域 BFF 管理的安全会话。
4. 补全移动 Chrome/PWA 安装、离线应用壳、安全区、缩放、键盘和 Media Session。
5. 收紧 CORS、管理认证、代理目标、重定向、缓存与安全响应头。
6. 建立单元、集成、移动端 E2E、PWA、隐私/广告扫描和质量门禁。
7. 完成真实 HTTPS 部署后的 Android Chrome 与真实网易账号验收。

### 明确不做

- 不绕过 VIP、付费、地区或版权限制；
- 不承诺每首网易歌曲都能从第三方源获得；
- 不发布 APK、AAB、iOS 包，也不处理应用商店上架；
- 不把 RSS 播客、AList、Bilibili 或任意 URL 公共代理作为首版核心能力；
- 在原作者授权条款澄清前，不公开或商业化分发；当前仅按私人、非商业项目实施。

## 3. 目标架构

```text
Android Chrome / 安装后的 PWA
  ├─ React UI、队列、歌词、非敏感偏好（IndexedDB）
  ├─ 同域 /api 与 /music-api 请求
  └─ 仅持有本站 opaque HttpOnly 会话 Cookie
                 ↓ HTTPS + SameSite + CSRF/Origin 校验
Cloudflare Pages Functions / Hono BFF
  ├─ 网易云二维码登录、个人资料与歌单
  ├─ 加密保存网易凭证；永不返回 MUSIC_U 给前端
  ├─ 网易直连与多音源匹配编排
  ├─ 严格域名白名单的媒体代理
  └─ 安全头、限流、日志脱敏与缓存隔离
                 ↓
网易云及明确列入清单的音乐/CDN 服务
```

会话模型：

- 二维码轮询返回 `803` 时，BFF 接收上游 Cookie，验证用户资料后加密保存；
- 浏览器只接收随机会话标识，属性至少为 `HttpOnly; Secure; SameSite=Strict; Path=/`；
- 所有个人网易接口从服务端会话解析凭证，不再接受前端 JSON 中的 `cookie`；
- 登出撤销服务端会话，同时清理账号相关 Cache Storage、SWR/内存缓存和前端资料；
- `NETEASE_SESSION_HMAC_SECRET`、`NETEASE_CREDENTIAL_ENC_KEY`、`APP_ORIGIN` 仅作为服务端 Secret，禁止 `VITE_` 前缀；
- 缺少 Secret 时生产环境必须 fail closed。

## 4. 实施阶段

### 阶段 A：仓库与可复现基线

- 在 GitHub 建立私有 `music` 仓库，将上游历史导入；
- `origin` 指向 `yilinjushi/music`，`upstream` 指向 `DJChanahCJD/otter-music`；
- 创建功能分支，主分支只接收通过门禁的提交；
- 固化 Node 版本、可信 npm registry、lockfile、CI 命令与基线报告；
- 保存来源、修改说明、第三方 NOTICE/SBOM 和非商业限制。

### 阶段 B：Web/PWA 收口

- 删除 Android 构建/更新说明和脚本，不产生 APK/AAB；
- 移除 Web bundle 中的 Capacitor Media Session/GPL 直接依赖，改用 `navigator.mediaSession`；
- 不在手机 Chrome 显示仅原生可用的全盘扫描、原生目录、App 更新等入口；
- 保留真正可在浏览器运行的本地文件选择、下载和剪贴板能力；
- 修复 Media Session 的 duration、position、playbackRate 边界。

### 阶段 C：网易云安全登录与个人内容

- 新建会话层、加密凭证库、登录恢复和登出接口；
- 改写二维码成功流程，移除 Cookie 明文持久化、复制按钮和请求体透传；
- 登录 UI 支持同手机流程：将二维码可靠保存为 PNG，并提供经真机验证的操作引导；
- 刷新后通过 `/session/me` 恢复资料；失效时明确回到未登录状态；
- 验证本人歌单、收藏歌单、推荐歌单、详情和分页；
- 私人接口一律 `Cache-Control: no-store`，缓存不含账号凭证片段。

### 阶段 D：播放、换源和缓存可靠性

- 固定 Provider 优先级与匹配规则，网易歌单曲目可由其他启用音源兜底；
- 建立确定性曲目夹具和人工抽检集，分别统计“可播放”“错误匹配”“无可用源”；
- 不把“跳到错误歌曲”计为成功；错误匹配必须为零；
- 修复 200/206 Range 缓存混用，不把不完整分段伪装成离线完整歌曲；
- 应用壳离线可打开；音频离线只对已确认完整缓存的曲目标记可用；
- 播放失败有清晰提示、有限重试和下一首策略，不形成代理/换源死循环。

### 阶段 E：移动 Chrome 体验

- 适配 360×640、390×844、412×915、平板窄屏和横屏；
- 无水平溢出，地址栏变化、虚拟键盘和安全区不遮挡控件；
- 删除 `maximum-scale=1`，关键触点至少 44×44 CSS px；
- 支持 `prefers-reduced-motion`、可见焦点、语义标签与合理对比度；
- 完整 manifest：稳定 `id`、192/512、maskable 图标、主题色、启动 URL；
- 支持安装状态/安装引导、离线深链应用壳、可恢复的更新提示；
- 后台与锁屏支持播放/暂停、上一首、下一首、进度和元数据。

### 阶段 F：安全、隐私与无广告

- CORS 仅同源或精确 `APP_ORIGIN`，携带凭证时禁止反射任意 Origin；
- 管理密码/会话 Secret 缺失时拒绝启动或拒绝认证，不使用默认 `secret`；
- JWT/会话令牌不进入 JSON，401 不回显 Cookie；登录接口限流；
- 通用代理改为协议、域名、方法、响应类型、大小和超时白名单；逐跳验证重定向；
- 删除或关闭首版非核心的任意 RSS/URL 代理；
- 添加 CSP、HSTS、`X-Content-Type-Options`、`Referrer-Policy`、`Permissions-Policy`、`frame-ancestors`；
- 移除上游 GitHub 更新检查；记录必需的第三方音乐请求域名；
- CI 同时扫描源码、lockfile 和 `dist`，阻止广告/统计 SDK、跟踪域名和敏感 Cookie 字样泄漏；
- 编写隐私说明：无广告/无行为分析不等于没有访问音乐服务所必需的第三方网络请求。

### 阶段 G：部署与真实设备验收

- 部署同域静态 PWA + Functions 到 HTTPS 预览环境；
- 正确配置 KV/会话存储、生产 Secret、域名和安全头；
- 用真实 Android Chrome 完成安装、独立窗口、同机登录、刷新恢复、歌单、播放、锁屏和登出；
- 弱网、离线、进程回收、Service Worker 更新后重新验证；
- 记录浏览器版本、设备、时间、测试账号脱敏标识和结果，不记录凭证。

## 5. 一票否决门槛

下列任意一项失败，即使加权总分超过 99，也不得终止：

1. **真实使用门槛**：HTTPS 环境中的 Android Chrome/PWA 能启动，无阻断崩溃；
2. **登录门槛**：一部 Android 手机可完成网易云登录，刷新恢复、退出失效均通过；
3. **凭证门槛**：`MUSIC_U` 不出现在 JS 可读存储、前端响应/请求、URL、日志、缓存键和构建物；
4. **核心数据门槛**：真实账号至少一个网易歌单能加载并进入播放队列；
5. **播放门槛**：核心播放、暂停、切歌和进度可用；存在可用兜底源时能正确换源；错误匹配为零；
6. **PWA 门槛**：Chrome 可安装、standalone 启动、应用壳可离线重载；
7. **无广告门槛**：源码、构建物和运行抓包无广告、推广、统计或行为分析代码/请求；
8. **安全门槛**：无公开任意 URL 代理、任意 Origin 凭证 CORS、默认管理密钥或 Cookie 回显；
9. **质量门槛**：类型检查、单测、构建、E2E 与安全测试全部通过，无新增 lint warning；
10. **分发门槛**：保持私有、非商业；若要公开或商用，必须先取得授权澄清，此项不允许用技术分数替代。

## 6. 100 分验收量表

| 类别                 |    分值 | 满分证据                                                                                                                                                                            |
| -------------------- | ------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 网易云登录与会话安全 |      18 | 真实同机登录、HttpOnly 会话、刷新恢复、登出撤销、凭证泄漏扫描全部通过                                                                                                               |
| 网易云个人内容       |      12 | 用户资料、本人/收藏/推荐歌单、详情、分页和导入队列在真实账号通过                                                                                                                    |
| 播放与跨源兜底       |      18 | 队列/歌词/进度/切歌/失败恢复通过；固定抽检集可播放率 ≥99%，错误匹配 0                                                                                                               |
| 手机 Chrome 交互     |      14 | 规定 viewport 与横屏无溢出；键盘/安全区/缩放/触点/焦点/抽屉通过                                                                                                                     |
| PWA 与后台播放       |      12 | 安装、图标、standalone、离线壳、更新恢复、30 分钟后台和锁屏控制通过                                                                                                                 |
| 安全与代理防护       |      10 | CORS、CSRF、认证 fail-closed、SSRF/重定向/大小/限流、安全头测试通过                                                                                                                 |
| 无广告与隐私         |       7 | 源码/依赖/dist/运行请求扫描通过；无更新跟踪；隐私说明完整                                                                                                                           |
| 自动化、性能与稳定性 |       7 | 类型/lint/单测/集成/E2E/构建通过；移动 Lighthouse 性能 ≥85、A11y/Best Practices ≥95；用 manifest、SW、离线深链和真实安装证据替代新版 Lighthouse 已移除的 PWA 类别；无严重控制台错误 |
| 可维护性与交付       |       2 | 计划、架构、部署、回滚、上游同步、NOTICE/SBOM 和验收报告齐全                                                                                                                        |
| **总计**             | **100** | **总分 ≥99，且所有一票否决门槛通过**                                                                                                                                                |

说明：外部音源会受版权、地区和风控影响。“可播放率 ≥99%”只针对预先冻结、可合法访问并记录时间的验收样本，不声称覆盖网易云全部曲库。

## 7. 自动测试矩阵

### 每次提交必跑

- `typecheck`
- ESLint（0 error；不允许新增 warning）
- Vitest 单元/组件测试
- Functions 会话、CORS、CSRF、代理白名单、重定向和日志脱敏测试
- 生产构建与 manifest/service worker 静态检查
- 广告/统计/敏感凭证扫描
- 依赖漏洞与许可证报告

### 每轮候选版本必跑

- Playwright：360×640、390×844、412×915 和横屏；
- 未登录、模拟登录、会话过期、退出、歌单、队列、播放失败与换源；
- 离线首页、离线深链、Service Worker 更新；
- axe/键盘导航与页面缩放；
- Lighthouse 移动配置；
- 构建物体积和控制台/网络错误检查；
- HTTPS 预览环境的响应头与代理滥用测试。

### 最终版本必须人工/真机补跑

- Android Chrome 安装及 standalone；
- 同一手机完成网易云登录；
- 真实歌单载入、播放与跨源兜底；
- 屏幕关闭/切后台连续播放 30 分钟；
- 锁屏与耳机键控制；
- 断网重载、恢复网络、更新版本；
- 登出后确认浏览器存储、缓存、日志和网络请求均无网易凭证。

## 8. 独立评估循环

每一轮严格执行：

1. **实现**：只处理上一轮阻断项和最高扣分项；
2. **自测**：运行完整自动测试矩阵，保存机器可读结果；
3. **冻结候选**：记录 commit/diff、环境、测试时间和已知限制；
4. **独立评估**：派出一个未参与该轮开发的 subagent，只给目标、量表、代码和证据；
5. **评估输出**：评估者必须给出逐项分数、硬门槛状态、可复现证据、缺陷级别和下一轮最小整改集；
6. **判定**：
   - 总分 ≥99 且全部硬门槛通过：终止循环；
   - 否则：将所有 P0/P1 和扣分项转为下一轮任务，继续实现；
   - 需要真实账号、用户确认、外部授权或部署权限时：标为外部阻断并暂停，不得虚报 99%；
7. **重新评估**：整改后必须使用新的独立评估轮次和当轮新证据，旧分数不得沿用。

评估者不得：参与被评估轮的代码实现、仅依据 README 打分、把 mock 当真实登录、把“能构建”当“手机可用”、把错误匹配算播放成功，或用总分掩盖一票否决失败。

## 9. 初始基线

上游基线检查结果：

- TypeScript：通过；
- Vitest：44 个文件、389 个测试通过；
- ESLint：0 error、134 warning；
- 已存在移动布局、Service Worker、manifest、Media Session、网易登录与多源回退；
- 尚无 Playwright、Lighthouse、axe 或真实移动 E2E；
- 现有网易 Cookie 明文进入 localStorage/请求体，属于 P0；
- manifest 仅 SVG 图标，音频 Range 缓存和同机登录未验证；
- CORS、通用代理、管理默认密钥和隐私缓存存在 P0/P1；
- 静态源码未发现广告、GA、百度统计、Sentry、PostHog 或 Firebase；
- README 的 MIT 与“严禁商业用途”冲突，且存在 GPL 原生 Media Session 依赖；因此本项目先保持私有、非商业。

## 10. 完成定义

只有以下条件同时成立，才可声明开发完成：

- 独立评估总分 ≥99/100；
- 10 项一票否决门槛全部通过；
- 当轮自动测试证据完整；
- HTTPS 预览与 Android Chrome 真机证据完整；
- GitHub 私有仓库中的候选提交与被评估提交完全一致；
- 没有用“理论可行”“mock 通过”或“等待部署”替代真实核心验收。

## 11. Round 5 本地整改集

Round 4 独立验收发现的本地阻断必须先于外部部署处理：

1. 所有曲目写入入口统一拒绝明文、URL 编码和多重 URL 编码的敏感赋值；覆盖直接 URL、备份、同步、歌单导入、store 恢复与既有 IndexedDB 迁移。
2. URL 缓存键不再包含原始 URL；401、登出和播放 URL 恢复必须同时失效 IndexedDB 与 Cache Storage 中的能力 URL。
3. 快速切歌时，旧异步解析、ready 事件或 play Promise 不得覆盖新曲的 URL、状态或播放动作。
4. Bilibili 自动匹配必须验证完整歌手集合证据，不能因同名且仅命中一位歌手接受合作/翻唱/串烧候选。
5. `APP_ORIGIN` 的生产配置必须 fail closed，并严格要求无 path/query/fragment 的 HTTPS origin。
6. Lighthouse 门禁必须强制绑定六份原始 LHR，逐份交叉核对 URL、分数、warnings、console、版本和 summary，而非只信任摘要。
7. Service Worker 更新 E2E 补齐暂停后确认更新、`controllerchange`/reload 以及队列与播放状态恢复。

修复后重新执行完整 CI、正式结构化 E2E、本地浏览器诊断和 Lighthouse，再交由未参与 Round 5 实现的新验收员评分。

Round 5 已完成上述主要整改，但独立验收仍为 **74/100**，Hard Gates 为 **1 PASS / 4 FAIL / 5 BLOCKED**。详见 `docs/evaluations/round-5.md`。

## 12. Round 6 本地整改集

1. 自动换源贯穿 AbortSignal 和请求 owner，任何过期搜索不得写入当前队列、歌单、收藏、上下文或缓存。
2. Bilibili 标题使用完整身份边界，拒绝同歌手的 `Song` / `Song 2` 等子串误配。
3. 修复同 URL reload、终态主动清空产生的迟到 error，以及 logout/401 后在途 URL 重新写回。
4. 自定义 API URL、日志、Functions 与所有持久化 schema 统一四轮解码、完整敏感字段和显式字段白名单。
5. 收紧 sync v1/v2 的输入、解压、数量、深度和响应缓存边界。
6. 签名 capability 不得进入共享/公共缓存；非流式上游响应增加明确 byte hard limit。
7. Service Worker 更新证据必须测试生产自身的生命周期，夹具不得额外补 `clients.claim()`。

Round 6 完成后必须重新生成全部自动证据并由新的独立验收员评分；外部 GitHub、部署、真实账号和 Android 真机门槛仍不得折算。

## 13. Round 8 本地整改集

Round 7 独立验收为 **77/100**，Hard Gates 为 **1 PASS / 4 FAIL / 5 BLOCKED**。详见 `docs/evaluations/round-7.md`。本轮必须先关闭以下本地 P1：

1. capability 与账号凭证分开分类，任何 endpoint 都不得回显 Cookie、`MUSIC_U`、Authorization 或账号 token。
2. 所有 direct/current-proxy 播放 URL 严格检查 protocol、userinfo、fragment、credential 与 capability。
3. 全局曲目身份统一为 `source + id + url_id`，覆盖 store、历史、选择、删除、收藏、歌单和同步。
4. `AutoMatchContext` 绑定曲目身份或 context generation；分享不得回退到播放能力 URL。
5. 网易账号与私有歌单响应不得进入前端持久 Cache Storage。
6. sync-v2 必须使用可证明的原子写入；若当前平台没有 CAS，则退役该功能和对应 UI，而不是用单进程锁伪装。
7. Playwright、Lighthouse、release、CI 与最终 manifest 必须绑定同一 Git/source diff、lock、dist 和实际浏览器环境，并用旧候选证据负测证明 fail closed。

整改后重新执行完整 CI、正式 Playwright、六次 Lighthouse 与 evidence manifest，再冻结候选并交由未参与 Round 8 实现的独立验收员评分。只要总分不足 99 或任一 Hard Gate 未通过，循环继续。
