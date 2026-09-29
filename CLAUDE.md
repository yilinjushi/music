# music

个人测试项目。

**语言规则（owner 2026-09-28 再次强调）：对 owner 的所有回复、说明、进度提示一律用简体中文，简单易懂；只有代码、命令、提交信息可以用英文。**

## 开发与部署（owner 2026-09-27）

- 直接在 `main` 上开发、提交、push，**不开 PR、不等审核**。
- 改完即部署，不需要再问 owner；部署期间服务中断可以接受。
- 部署方式（走 GitHub Actions，不在本地部署）：push 到 `main` 后，`.github/workflows/ci.yml` 先跑检查，通过后用 `cloudflare/wrangler-action` 发布到 Cloudflare Pages。
  - 部署用的 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` 存在 GitHub 仓库 Secrets 里，云端会话里没有令牌，本地 `wrangler` 无法部署。
  - Pages 设置里的环境变量与密钥保持不变。
- 提交前至少跑 `npm run typecheck`；部署后打开生产地址确认能正常加载。
- 仍须遵守 `AGENTS.md` / `SECURITY.md`：不提交密钥、HAR、真实账号数据。
