# Privacy and network use

This private, non-commercial PWA contains no advertising, affiliate placement,
behavioural analytics, fingerprinting, crash-reporting SDK, or marketing pixel.
It does not sell or share a listening profile.

“No tracking” does not mean “no third-party network traffic.” Searching and
playing music necessarily contacts the selected music providers and their
media or artwork CDNs through the same-origin backend or, where browser media
playback requires it, directly. Those providers receive the normal technical
information inherent in an HTTPS request and apply their own policies.

## NetEase account session

- The browser must never receive or persist the NetEase `MUSIC_U` credential.
- The backend exchanges a successful QR login for a random, first-party,
  `HttpOnly`, `Secure`, `SameSite=Strict` session cookie.
- NetEase credentials are encrypted at rest in the session KV namespace.
- Account-specific responses use `Cache-Control: no-store`.
- Browser NetEase requests also use `cache: no-store`; parsed NetEase
  responses are excluded from Cache Storage and SWR, and startup migration
  removes entries written by older releases.
- Logout revokes the backend session and clears account-related browser state.

Do not attach production network traces, HAR files, storage exports, or real
account credentials to issues or CI artifacts.

## Approved external purposes

External requests are limited to music metadata, audio, lyrics, covers, and
the user's explicitly selected account operation. The exact production domain
allowlist is enforced in the proxy and Content Security Policy. Adding a new
domain requires a code review and an update to this document.

## Advertising and analytics regression rule

The release gate scans the browser source, Functions source, production
dependency names and production build. Runtime requests are captured separately
on the accepted HTTPS deployment; a local static scan is never reported as a
replacement for that capture. A new advertising, analytics, fingerprinting,
marketing, or undisclosed telemetry dependency is a release blocker.

Application diagnostics remove URL query strings and plain or encoded
credential assignments before console output, persistence and export. Logs
written by older releases are sanitized again when loaded. Do not treat this as
permission to place account data in a diagnostic message.
