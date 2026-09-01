# Cloudflare Pages deployment and acceptance

This project is deployed as one HTTPS origin: Vite's `dist/` output plus the
Hono handlers in `functions/`. A static-only host is insufficient because the
NetEase credential boundary lives in Pages Functions.

## Repository setup

GitHub public forks cannot be made private. For the intended private,
non-commercial deployment, create a new private repository, import this Git
history, and preserve the upstream remote:

```bash
git remote add origin https://github.com/yilinjushi/music.git
git remote set-url --push upstream DISABLED
git push -u origin main
git push -u origin feat/mobile-pwa
```

Do not push to `DJChanahCJD/otter-music`. Before either push, review the staged
commit and confirm that no secret, HAR, browser profile, credential, or real
account fixture is present.

## Pages configuration

- Build command: `npm ci && npm run build`
- Build output directory: `dist`
- Node version: Node.js `22.19.0`, matching CI
- Functions directory: `functions/` (discovered by Cloudflare Pages)
- Pages project name: `music`
- Wrangler config: `wrangler.jsonc`

GitHub Actions deploys `main` to Cloudflare Pages after the CI quality gate
passes. Configure these repository secrets before enabling that workflow:

- `CLOUDFLARE_API_TOKEN`: API token that can deploy Cloudflare Pages for this
  account;
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account ID that owns the `music` Pages
  project.

This repository does not contain a Vercel workflow. If pushes still trigger
Vercel builds, disable the GitHub integration for the old Vercel project in
Vercel's dashboard; it is external to this repository's Actions.

Create separate preview and production KV namespaces. Bind them as:

- `oh_file_url`: non-secret request rate-limit records only;
- `SESSION_KV`: encrypted NetEase session records only.

Remote sync is deliberately unavailable. The configured Workers KV binding
does not expose compare-and-swap or transactions, so it cannot prove that a
concurrent read/merge/write protocol is lossless. Legacy `/sync` and `/sync/v2`
requests return a private, non-cacheable `410` without reading or writing KV.
Use the local data export/import feature for backup and transfer.

Configure the following values in Pages/Workers settings. Secret values must
be random, unique per environment, and entered as encrypted secrets rather
than plaintext build variables:

| Name                          | Kind     | Requirement                                                                       |
| ----------------------------- | -------- | --------------------------------------------------------------------------------- |
| `APP_ORIGIN`                  | variable | Exact production HTTPS origin, with no path                                       |
| `NETEASE_SESSION_HMAC_SECRET` | secret   | At least 32 random characters                                                     |
| `NETEASE_CREDENTIAL_ENC_KEY`  | secret   | Independent key, at least 32 random characters and different from the HMAC secret |
| `NETEASE_SESSION_TTL_SECONDS` | variable | Optional, 3600–7776000; default 2592000                                           |
| `QINIU_ACCESS_KEY`            | secret   | Access key for the dedicated private `music-cache-overseas` bucket              |
| `QINIU_SECRET_KEY`            | secret   | Secret key paired with `QINIU_ACCESS_KEY`                                       |

The PWA edition does not need `GITHUB_TOKEN`; the upstream APK update endpoint
is not mounted. Never use a `VITE_` prefix for any secret.

The dedicated audio cache uses the private Qiniu bucket
`music-cache-overseas` in the Singapore region (`as0`) and the DNS-only CDN
domain `music-cache.80007001.xyz`. Keep the bucket separate from `gmp001`.
The Qiniu access and secret keys are Pages secrets only; they must never be
placed in `wrangler.jsonc`, the repository, or browser code. If the Qiniu
configuration is missing or unavailable, the cache endpoints fail closed and
normal provider URL resolution continues.

`APP_ORIGIN` is mandatory at runtime and is parsed fail-closed. It must be the
literal HTTPS origin (for example `https://music.example`, not a URL with a
trailing slash, path, query, fragment, credentials, surrounding whitespace, or
an `http:` scheme). A missing or malformed value makes every Functions route
return `503` before CORS or application routing, so verify this binding in both
Preview and Production rather than relying on URL canonicalisation.

## Release checks

Run the repository quality gate from a clean dependency install. Archive
`artifacts/` and require its evidence manifest to identify the exact Git HEAD,
lockfile hash and production `dist/` hash. A manifest that says the worktree was
dirty is diagnostic evidence only, not a release candidate. Then verify
the deployed origin (shown below as `$APP_URL`) without placing any secret in
shell history or checked-in files:

`npm run ci-test` first seals `artifacts/ci-summary.json`; that summary covers
lint, both typechecks, Vitest, build, static PWA/release policy, licenses, both
dependency audits, and the workspace-aware production SBOM. It explicitly does
not claim browser success. CI then runs the complete Playwright mobile matrix
and Lighthouse, verifies their exact executed counts and hashes, and finally
regenerates `artifacts/evidence-manifest.json` as the last artifact-writing
step. The automated candidate flag remains false if the checkout is dirty, any
evidence is missing or stale, no browser test actually ran, or any required
gate failed. Android real-device acceptance remains a separate mandatory gate
even when every automated flag is true.

```bash
curl -fsSI "$APP_URL/"
curl -fsS "$APP_URL/health"
curl -i -X OPTIONS "$APP_URL/music-api/netease/session/me" \
  -H 'Origin: https://attacker.invalid'
curl -i "$APP_URL/proxy?url=http%3A%2F%2F127.0.0.1%2Fsecret"
```

The Lighthouse runner's gzip and immutable-cache report describes its local
synthetic server only; it deliberately records
`productionDeploymentProven: false`. After deployment, copy one current
content-hashed JavaScript path from the deployed `index.html` into
`$HASHED_ASSET` and verify the actual edge response separately:

```bash
HASHED_ASSET='/assets/index-REPLACE_WITH_CURRENT_HASH.js'
curl -fsSI --compressed "$APP_URL$HASHED_ASSET"
curl -fsS --compressed -o /dev/null \
  -w 'status=%{http_code} bytes=%{size_download}\n' \
  "$APP_URL$HASHED_ASSET"
```

The hashed asset must return `200`, a non-zero body, `Content-Encoding: br` or
`gzip` when the client advertises compression, `Vary: Accept-Encoding`, and
`Cache-Control: public, max-age=31536000, immutable`. Do not substitute a local
preview response or an unhashed HTML/service-worker response for this check;
HTML and `sw.js` must remain revalidatable so updates are discoverable.

Expected results:

- the document has CSP, HSTS, nosniff, frame, referrer and permissions headers;
- a deployed hashed JavaScript asset is compressed and immutable while HTML
  and `sw.js` are not immutable;
- `/health` returns `OK`;
- an arbitrary CORS origin receives `403` and no allow-origin header;
- private, local, unapproved and redirect-to-unapproved proxy targets fail;
- NetEase account responses are `private, no-store`;
- no JSON response contains an upstream Cookie or a session token.

## Android Chrome acceptance

Record device model, Android/Chrome versions, deployed commit and time, but no
account identifier or credential. On one physical phone:

1. Open the HTTPS site, install it, and start it in standalone mode.
2. Save the NetEase QR image and select it from the NetEase scanner's album.
3. Confirm login, reload, load a personal playlist, enqueue and play a track.
4. Exercise pause, seek, next/previous, lock-screen controls and 30 minutes of
   background playback.
5. Reload a previously visited deep link offline, then restore the network.
6. Trigger a service-worker update while playing; it must wait for a pause and
   explicit confirmation.
7. Log out, reload, and confirm the session is rejected and account state is
   gone from browser-readable storage/cache.

Mocks and a desktop-plus-phone scan do not satisfy this gate.

## Rollback

Keep the previously accepted Pages deployment. If a release fails a hard
gate, route production back to that deployment, rotate any potentially exposed
secret, revoke affected sessions by replacing/clearing `SESSION_KV`, and only
then investigate with synthetic test data.
