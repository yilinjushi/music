# Security policy

This repository is a private, non-commercial derivative of Otter Music. Do not
publish secrets, NetEase cookies, production traces, or account data in an
issue, commit, build artifact, or screenshot.

## Required production configuration

Production must fail closed unless all required values are configured:

- `APP_ORIGIN`: the exact HTTPS origin serving the PWA;
- `NETEASE_SESSION_HMAC_SECRET` and `NETEASE_CREDENTIAL_ENC_KEY`, each at least
  32 random characters and never equal to one another, plus the `SESSION_KV`
  binding listed in the deployment documentation.

Secrets must be Worker/Pages secrets. Never expose them through a `VITE_`
variable or commit them to the repository.

## Backend boundaries

- Credentialed CORS is same-origin or the exact `APP_ORIGIN`; arbitrary Origin
  reflection is forbidden.
- Unsafe credentialed browser requests require an approved Origin.
- The media proxy accepts only HTTPS targets on the reviewed provider/CDN
  allowlist, validates every redirect, removes sensitive request headers, and
  enforces response type and size limits. A missing or unapproved upstream
  `Content-Type` fails closed. Each redirect hop has a 20-second response-header
  deadline; the accepted response stream has a 30-second upstream-read idle
  deadline, a 10-minute absolute lifetime, and a 150 MiB cumulative byte cap.
  Timeout and size failures abort/cancel the upstream and reject the downstream
  body instead of returning a silently truncated success.
- Arbitrary RSS fetching is disabled in the PWA edition.
- Authentication errors never echo Cookie headers or tokens.
- Remote sync is retired: `/sync` and `/sync/v2` return a fixed private `410`
  and never touch KV because the configured storage has no atomic merge
  primitive.
- Application logs redact URLs, encoded or plain credential assignments,
  authorization values, session IDs and query parameters before console,
  storage or export. Functions may emit only reviewed fixed event codes; raw
  errors, responses and request URLs are not logger arguments.

## Reporting

Report a vulnerability privately to the repository owner. Include a minimal
reproduction with synthetic values only. Rotate any credential that may have
been exposed before continuing investigation.
