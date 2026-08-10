# 网易云安全会话部署

网页版的网易登录必须让 PWA 与 Cloudflare Functions 使用同一来源（相同协议、主机和端口）。浏览器只保存 `__Host-otter_netease_session` 这一枚随机、签名且不可由 JavaScript 读取的会话 Cookie；网易 `MUSIC_U` 只会以 AES-GCM 密文存在 KV 中。

## Cloudflare 绑定与机密

在 Pages 项目的 `Settings → Bindings` 中创建并绑定专用 KV：

| 类型             | 名称                          | 要求                                                                                                  |
| ---------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| Variable         | `APP_ORIGIN`                  | PWA 与 Functions 共用的精确 HTTPS origin；不得带尾斜杠、路径、查询或片段，缺失/格式错误时服务返回 503 |
| KV Namespace     | `SESSION_KV`                  | 单独命名空间，不要与同步、缓存等公开数据共用                                                          |
| Secret           | `NETEASE_SESSION_HMAC_SECRET` | 至少 32 个随机字符，用于签名随机会话 ID                                                               |
| Secret           | `NETEASE_CREDENTIAL_ENC_KEY`  | 至少 32 个随机字符，用于派生 AES-256-GCM 密钥，且不得与 HMAC Secret 相同                              |
| Variable（可选） | `NETEASE_SESSION_TTL_SECONDS` | 默认 2,592,000 秒（30 天）；代码会限制在 1 小时至 90 天                                               |

为 Production 和 Preview 环境分别配置。代码会拒绝两把 Secret 相同的配置。推荐在本机生成两个互不相同的随机值：

```bash
openssl rand -base64 48
openssl rand -base64 48
```

不要把输出写入仓库、构建日志或前端环境变量。Cloudflare 中应使用加密的 Secret，而不是普通明文变量。

## 部署后验证

1. 打开部署域名，扫码登录；二维码状态 `803` 的 JSON 只能包含 `code`、`message`、`authenticated` 与 `profile`，不能包含 `cookie` 或 `MUSIC_U`。
2. 浏览器 DevTools 的 Application → Cookies 中只能看到 `__Host-otter_netease_session`，并带有 `Secure`、`HttpOnly`、`SameSite=Strict` 和 `Path=/`。
3. `GET /music-api/netease/session/me` 应返回用户资料与 `Cache-Control: private, no-store, max-age=0`。
4. 在请求体加入 `cookie`、`MUSIC_U` 或 `x-real-cookie` 字段时，接口必须返回 400。
5. 调用 `POST /music-api/netease/logout` 后，原会话访问 `session/me` 必须返回 401。
6. 在 KV 控制台抽查记录：内容应只有 `iv`、`ciphertext`、用户资料和时间字段，不能搜索到 `MUSIC_U` 的明文值。

## 轮换与失效

- 轮换 `NETEASE_SESSION_HMAC_SECRET` 会使全部现有浏览器会话立即失效。
- 轮换 `NETEASE_CREDENTIAL_ENC_KEY` 后旧记录无法解密；读取时会被自动删除，用户需要重新扫码。
- 注销会同时删除 KV 记录并清除浏览器会话 Cookie。
- KV 记录具有 `expirationTtl`，即使用户不主动注销也会自动过期。
