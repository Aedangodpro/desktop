# Web port

The browser build reuses the Electron renderer as-is. Everything that talks to
the main process goes through optional `window.linerElectron` lookups, so in a
browser the app takes its existing web code paths instead of a shim.

```sh
pnpm dev:web      # http://localhost:3000
pnpm build:web    # -> dist-web/
pnpm preview:web  # serve the build
```

The desktop entry (`index.html`, `src/main.tsx`, `vite.config.ts`) is untouched.

## Why there is a server in front of the API

Two things are true at the same time:

1. `api.tryliner.fun` sends no CORS headers, so a browser cannot call it
   cross-origin.
2. Every API request is signed (`x-liner-signature`, `x-liner-timestamp`,
   `x-liner-nonce`) with a canonical HMAC over `method`, `path`, `timestamp`,
   `nonce` and the SHA-256 of the body. The key lives inside a Wasm module that
   the Electron **main** process loads; the renderer reaches it over IPC.

A page cannot have that key, and putting it in the bundle would hand it to every
visitor. So the web build talks to a same-origin path and a small server-side
proxy adds the signature:

```
browser ──/__liner/v1/me──▶ proxy (Node) ──signed /v1/me──▶ api.tryliner.fun
```

- `src/web/server/apiProxy.ts` — the proxy. It strips any signature headers the
  browser sent (a page must never be able to forge one), signs with the same
  Wasm signer the desktop uses, forwards the body byte-for-byte, drops
  `Origin`/`Referer`, and normalises cookies.
- `vite.config.web.ts` — mounts it in both `dev:web` and `preview:web`, and
  reads `LINER_DEV_SIGNING_SECRET` for a local API that uses a shared secret
  instead of the packaged key.
- `VITE_API_URL` is pinned to `/__liner` so the shared resolver picks the
  proxy path in every mode.

## Why there is a media relay too

Electron makes YouTube reachable by rewriting CORS in the main process
(`electron/cors.ts`, `withOpenCors`): every host on its allowlist answers with
`access-control-allow-origin: *`, including the preflight. The browser build
never had that layer, and both halves of playback need it:

- `music.youtube.com/youtubei/v1/*` and `www.youtube.com/youtubei/v1/*` answer
  an `OPTIONS` preflight from a page origin with **`403` and no
  `access-control-*` headers**, so every search, browse and player lookup dies
  as a CORS error. `sw.js_data` (visitor data) is the same.
- `*.googlevideo.com` sends no CORS headers at all, so the reachability probe
  and `<audio crossorigin="anonymous">` (the element the Web Audio effects
  graph is built on) cannot load a stream.

`src/web/server/mediaRelay.ts` restores the desktop contract on the server:

```
GET  /__media?url=<encoded url>    -> the media host, range and status intact
POST /__yt/<host>/<path>?<query>   -> https://<host>/<path>
```

Only hosts on the desktop allowlist are reachable (`needsOpenCors`), Innertube
is limited to `www.youtube.com`, `music.youtube.com` and
`youtubei.googleapis.com`, page identity headers (`origin`, `referer`, `cookie`)
are dropped, and the relay is a byte pipe with no cache. It is mounted in
`dev:web` and `preview:web` next to the API proxy.

The renderer only rewrites URLs under `--mode web` (`src/web/proxyUrls.ts`), so
the desktop keeps calling these hosts directly. In the browser, WEB_REMIX and
the profiles that need the YouTube player script are skipped: WEB_REMIX needs a
PO token minted by the main process, and the player script cannot be loaded
cross-origin. Playback falls through to the profiles that hand out direct audio
URLs, which the relay then serves.

### Deploying

`dist-web/` is static, but the app is **not** functional without the proxies.
Any deployment must forward `/__liner/*` to the API *and* sign the forwarded
request, otherwise sign-in fails. It must also forward `/__media` and `/__yt`
to the hosts above (no signing needed, keep `Range` and the status), or nothing
plays. Do not expose the signing key to the client, and do not point
`VITE_API_URL` at the API host directly.

## Sessions

- Tokens are stored under `liner_auth_session` in `localStorage`, written by
  `setAuthSession`, and re-read on boot, so a reload keeps the account.
- A stored value without both tokens is discarded rather than adopted; a
  half-written session used to cause a 401 on every request while the UI still
  claimed to be signed in.
- Access tokens refresh 120 s before expiry, once per tab, and a refresh token
  the server calls dead (`INVALID_REFRESH_TOKEN`) is the only thing that clears
  the session. Transient failures and signature rejections keep it.
- Cookies from the upstream are rewritten to `Path=/` with `Domain` removed:
  upstream issues them for `/v1/...` while the browser requests
  `/__liner/v1/...`, so an unrewritten cookie is never sent back.

## Using the app without an account

Sign-in needs the API, so the app no longer forces every signed-out visitor to
`/login`. The login screen offers **Use without an account**, which sets
`liner_guest_mode`; `AuthLock` then lets anonymous visitors through and signing
in clears the flag again.

In that mode playlists and likes live on the device:

- `src/features/library/local-account/store/localLibrary.ts` — the persisted
  store (`liner_local_library_v1` in `localStorage`). It holds the playlist
  records, their items and the liked tracks, validates everything it reads, and
  is the only writer.
- `usePlaylists`, `usePlaylist`, `useLikedTracks` read it whenever
  `getAuthSession()?.accessToken` is absent; otherwise they keep using the API.
- The mutations in `useLibraryMutations` branch the same way: create, delete,
  add/remove/move items and like/unlike write locally when signed out.

Nothing is merged: local items are not uploaded when a session appears, and
server data is not copied down when one disappears. Local playlist ids are
prefixed `local_` so they can never collide with server ids.

## Lyrics in the browser

Lyrics normally stream from `/v1/tracks/:id/lyrics` as SSE. That path is part
of the API and unreachable for a browser (and refuses every call with `403`
today), so in `--mode web` `api.streamLyrics` delegates to
`src/web/lyrics/lrclibLyrics.ts` instead:

- `GET https://lrclib.net/api/get` with the cleaned title, artist and duration,
- fall back to `/api/search` and pick the synced result closest to the track
  length,
- emit the same `provider` + `done` events, so `playerEngine`, the cache, the
  offsets and the lyrics canvas work unchanged.

LRCLIB answers with `access-control-allow-origin: *`, so no relay is involved.
Titles are cleaned first (`(Official Video)`, `[Remastered]`, `- Official Audio`)
because YouTube titles carry release noise LRCLIB does not index. The desktop
build keeps using the API stream.

## Web-only UI

The browser build trims the parts of the desktop shell that cannot work in a
tab: window controls (minimise / maximise / close) are not rendered, and the
Settings integrations group (Discord RPC, YouTube account playback) is hidden
because neither has a bridge in a browser. A **Themes** tab holds the
light/dark/system choice plus six accent palettes (`src/shared/utils/accentTheme.ts`),
persisted under `liner_accent_theme`.

## Account data

All account data is server-side and authenticated by the bearer token, so it
restores automatically once sign-in works:

| Data | Endpoint |
| --- | --- |
| Profile | `GET /v1/me` |
| Playlists | `GET /v1/me/playlists`, `GET /v1/me/playlists/:id` |
| Liked songs | `GET /v1/me/library/tracks` |
| Saved albums/artists/playlists | `GET /v1/me/library/{albums,artists,playlists}` |
| History | `GET /v1/me/history` |

Nothing is cached per-account in the browser beyond playlist covers and query
caches, both keyed by content and cleared on sign-out.

Desktop-only by design (there is no bridge to fake): device downloads
(`savedTracks*` → `"unavailable"` in the browser), local files, native updates,
Discord presence, window controls and the overlay player.

## Verification

```sh
pnpm exec tsc -b
pnpm exec vitest run src/web
pnpm build:web
```

`src/web/server/apiProxy.test.ts` runs the proxy against a mock upstream that
recomputes the HMAC, which is the only way to assert the signature is correct
without the production key.

## The bare `403 Forbidden`

`api.tryliner.fun` answers a request it refuses with a bare `403 Forbidden`:
9 bytes, no `content-type`, no JSON error code, no `x-request-id`. `GET /health`
always answers `200` and needs no signature, so the host is reachable and this
is the API's own gate — it fires before the request reaches application logic.
It appears when the HMAC signature is missing or not accepted, and when the
caller is being throttled.

The proxy passes that status through unchanged. An earlier version rewrote it
into `502 API_EDGE_BLOCKED` on the theory that a Cloudflare edge rule was
blocking the deployment; that was wrong and it hid which of the two causes was
in play. Every forwarded call is logged as `[api-proxy] METHOD /path -> status`
in the dev terminal, which is the quickest way to see what the API actually
returned.

Diagnose from the deployment host with:

```sh
# reachability: always 200, signature not required
curl -si https://api.tryliner.fun/health | head -3

# a signed endpoint without a signature: 403 Forbidden is expected
curl -si -X POST https://api.tryliner.fun/v1/auth/challenge \
  -H 'content-type: application/json' \
  -d '{"purpose":"login","email":"you@example.com"}' | head -5
```

If `/health` is 200 and the signed path through `/__liner` is also 403, the
signature is being rejected or the caller is throttled; a 502 with
`API_PROXY_UNREACHABLE` means the host could not be reached at all.

## Human check

When a challenge asks for a Turnstile token, the client renders the API's
`/v1/auth/verify?action=…` page in an iframe and reads the token from a
`postMessage`. On web that URL is `/__liner/v1/auth/verify?action=…`, i.e. a
same-origin path, so `humanCheckOrigin()` resolves it against
`window.location.origin` before comparing message origins. A bare
`new URL("/__liner")` throws `TypeError: Invalid URL`, which used to crash the
check frame and leave sign-in awaiting a token forever.

## Static hosting (GitHub Pages)

`pnpm build:web` emits a fully static `dist-web/`. Set the base path to the
repository name so hashed assets resolve on a project site:

```bash
VITE_BASE_PATH=/<repo>/ pnpm build:web
# upload dist-web/ (or publish it with actions/deploy-pages)
```

Routing needs no rewrite rules: the app uses `HashRouter`, and the build emits
`dist-web/index.html` from `index.web.html`.

**The static build cannot sign API requests or reach YouTube.** `dist-web/`
depends on three same-origin endpoints supplied by the Node server in
`src/web/server` (development and `pnpm preview:web`):

| Path | Why a browser cannot replace it |
| --- | --- |
| `/__liner` | API requests are HMAC-signed with a key that lives in the main process; `api.tryliner.fun` sends no CORS headers |
| `/__yt` | Innertube answers the CORS preflight with 403 |
| `/__media` | googlevideo sends no CORS headers and 403s ranges over 256 KiB |

So Pages alone renders the shell, guest mode, the locally stored library, local
files and LRCLIB lyrics, but sign-in, the online catalog and YouTube playback
will fail. Deploy `dist-web` behind the Node server (any Node host running
`pnpm preview:web`), or port those three endpoints to a Worker/Functions runtime
before treating a purely static host as a full deployment.
