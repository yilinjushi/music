# Repository Guidelines

Otter Music 是面向手机 Chrome 的纯 Web/PWA 音乐播放器。生产运行时由 React 前端、Service Worker 和同源 Cloudflare Functions 组成；仓库不维护原生应用工程，也不接受依赖设备文件系统或原生插件的新功能。

## 架构

| 目录             | 职责                                                         |
| ---------------- | ------------------------------------------------------------ |
| `src/components` | 页面、播放器与 UI 原语                                       |
| `src/hooks`      | 播放、媒体会话和交互行为                                     |
| `src/lib`        | 浏览器 API 客户端、音乐 Provider、缓存与工具函数             |
| `src/store`      | Zustand 状态；只持久化明确列入 `partialize` 的数据           |
| `src/routes`     | React Router 路由与懒加载边界                                |
| `shared`         | 前端与 Functions 共用的类型、解析和转换逻辑                  |
| `functions`      | Hono/Cloudflare Functions，同源认证、音乐 BFF 与受限媒体代理 |
| `e2e`            | Playwright 手机视口、PWA、无障碍与关键用户流程               |

`shared` 和 `functions` 是 npm workspaces；共享模块通过 `@otter-music/shared` 导入。

## 常用命令

- 安装：`npm ci`
- 开发：`npm run dev`
- 类型检查：`npm run typecheck`、`npm run typecheck:functions`
- 单元测试：`npm run test:run`
- E2E 清单：`npm run test:e2e -- --list`
- E2E：`npm run test:e2e`
- 代码检查：`npm run lint`
- 生产构建：`npm run build`
- 发布验证：`npm run verify:release`
- 生产依赖审计：`npm run audit:prod`

## Web/PWA 约束

- 音乐元数据、搜索、登录和歌单请求默认只访问同源 `/music-api/*` BFF。不要在浏览器新增第三方 API 直连或凭据转发。
- 第三方媒体 URL 仅用于合法播放、封面和下载；需要代理时复用受限同源代理及其 allowlist，不扩展为任意网页抓取器。
- 网易账号凭据只存在于 HttpOnly 服务端会话。前端不得读取、拼接、存储或记录 Cookie/令牌。
- PWA 安装与更新必须保持可选、可关闭，更新提示不得打断正在播放的音频。
- Service Worker 只缓存应用壳和公开静态资源；账号响应、远程音频和带敏感参数的请求不得进入离线缓存。
- 旧设备本地文件或离线记录可以显示明确的“不再可用”迁移提示，但不得尝试读取原设备路径。

## UI 与可访问性

- 手机优先，核心交互触点的可点击区域至少为 44×44 CSS px，包括按钮、链接、输入、开关、滑块和标签页。
- 图标按钮必须有可访问名称；状态型控件使用正确的 `aria-pressed`、`aria-checked` 或对应语义。
- 200% 页面缩放、360px 窄屏和横屏下不得出现页面级水平溢出，主要操作不得被固定播放条或安全区遮挡。
- 使用 Tailwind CSS 4 和 `src/components/ui` 中的原语。通用修复应优先落在原语层，并补充组件单测。
- dnd-kit 拖拽区域使用 `touch-none select-none`，同时保留键盘可操作路径。

## 统一退出栈

Esc 由 `RootLayout` 转发给 `useExitLayerStore`。Drawer、全屏播放器、封面预览等占屏浮层通过 `useExitLayer` 加入 LIFO 栈，最后打开的层最先关闭。

```ts
useEffect(() => {
  if (!isOpen) return;
  const id = push({ close: () => setOpen(false) });
  return () => pop(id);
}, [isOpen, push, pop]);
```

不要用优先级数字或硬编码链条模拟退出顺序；主动路由跳转也不属于退出栈。

## Provider 规范

`IMusicProvider` 的核心能力是 `search`、`getUrl`、`getPic` 和 `getLyric`。新增或修改 Provider 时：

- `searchArtist`、`searchAlbum` 至少委托给 `search`；
- 只有确有独立详情页的来源才实现详情能力；
- 请求必须可取消并设置有限超时/重试，播放失败的换源或代理兜底必须有明确上限；
- 不把完整 URL query、认证信息或原始异常写入持久日志。

## 测试与改动纪律

- 修改播放、同步、Store、路由、PWA 或认证逻辑时补充相应 Vitest/Playwright 覆盖。
- E2E 使用稳定的同源 mock；测试会话仅代表模拟状态，不得描述成真实账号。
- E2E 需监控未处理页面错误、非预期 console error、失败请求和 5xx 响应。
- 保留用户未提交的修改，避免覆盖并行任务。

## 发布流程（个人测试项目）

- 直接在 `main` 上开发、提交并推送，不开 PR、不需要人工审核。
- 推送到 `main` 即自动部署到 Cloudflare Pages（部署不等待质量检查，检查并行运行只做报告）；部署期间短暂中断可以接受。
- 推送前至少跑 `npm run typecheck`、`npm run typecheck:functions` 和相关单元测试；禁止 force push。
