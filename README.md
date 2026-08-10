# Music PWA

面向 Android 手机 Chrome 的无广告网页音乐播放器。它可以直接作为网站使用，也可以从 Chrome 添加到主屏幕；不提供 APK/AAB，也不依赖应用商店。

当前项目处于私人、非商业改造阶段，目标是保留网易云登录、个人歌单和熟悉的移动播放体验，同时允许已配置的其他音源在原曲不可播放时进行匹配回退。

## 主要能力

- 网易云账号登录、个人资料与歌单浏览；
- 多音源搜索、播放失败回退和歌单导入；
- 播放队列、收藏、歌词、音质、倍速和睡眠定时；
- 收藏与歌单可本地导出/导入；远程密钥同步因 KV 不具备原子合并能力而停用；
- 手机优先布局，适配动态视口与屏幕安全区；
- 可安装 PWA，支持离线打开应用壳和离线深链；
- 使用浏览器标准 Media Session API 提供锁屏元数据、播放/暂停、切歌和进度控制；
- Service Worker 更新由用户确认，播放过程中不会自动刷新；
- 不集成广告、推广弹窗或用户行为分析 SDK。

> 无广告不等于绕过付费、VIP、地区或版权限制。本项目不承诺任意歌曲都存在可用的替代音源。

## 本地开发

需要 Node.js 22.19 或更新版本，以及 npm 11.9。

```bash
npm ci
npm run dev
```

`npm run dev` 只启动 Vite 前端，不再转发网易云 Cookie。需要验证完整登录、个人歌单或会话续期时，请使用 Cloudflare Pages/Workers 的本地开发方式同时运行 `functions/`；不要在浏览器可控请求头中传递账号 Cookie。

本地无浏览器门禁（lint、类型、Vitest、构建、发行策略、许可证、审计、SBOM 与证据清单）：

```bash
npm run ci-test
```

候选版本还必须在已安装 Chromium 的环境执行：

```bash
npx playwright install chromium
npm run test:e2e
npm run lighthouse
```

`ci-test` 通过不代表 Playwright、Lighthouse、HTTPS 或 Android 真机已经通过；这些结果分别保存并在最终验收时与同一候选哈希绑定。

## PWA 部署

生产环境需要 HTTPS。Cloudflare Pages 的基本构建配置：

- Build command：`npm run build`
- Build output directory：`dist`
- Pages Functions：仓库中的 `functions/`

前端与 Functions 应部署在同一站点，以便登录会话、歌单接口和媒体代理保持同源。直接运行 `vite preview` 只会预览静态前端，不能完整模拟 Pages Functions。

## 项目结构

```text
src/components/   页面、播放器与移动交互
src/hooks/        播放控制、音频事件与 Media Session
src/lib/          音乐 Provider、换源、缓存与通用逻辑
src/store/        Zustand 状态与浏览器持久化
src/sw.ts         PWA 应用壳、离线深链与更新策略
functions/        Cloudflare Pages Functions / BFF
shared/           前后端共享类型与逻辑
```

## 来源与许可

本项目基于 [DJChanahCJD/otter-music](https://github.com/DJChanahCJD/otter-music) 的 `7f91e87` 提交改造，保留上游 Git 历史和署名，便于审计改动及同步安全修复。

上游仓库同时包含 MIT License 和 README 中的“严禁商业用途”说明，两者存在解释上的冲突。在获得作者书面澄清之前，本派生项目保持私有且仅用于非商业用途。音乐内容和第三方接口的版权、服务条款及可用性需要分别遵守。

本项目不存储或提供音频资源，不以技术手段绕过付费、VIP、地区或版权限制。
