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

### YouTube playback without a YouTube account

The browser build never asks for a YouTube sign-in. Audio is resolved through
the clients that hand direct stream urls to anonymous callers (`VISIONOS`,
`IOS`, `ANDROID_VR`) and fetched through `/__media`. `visitorData` is what
keeps those calls out of YouTube's "confirm you're not a bot" check:
`src/shared/youtube/session/visitorSession.ts` reads it from `sw.js_data` and
falls back to `/youtubei/v1/visitor_id` when that document omits it.

A bot check that still reaches the player is retried as another upload of the
same recording (`src/features/player/engine/playbackAlternates.ts`): YouTube
refuses individual videos, not songs, and a re-upload is often accepted while
the original is not. When the address itself is refused for every video, the
player asks a second catalog instead: `soundcloudFallback.ts` searches
SoundCloud for the same recording (same song words, the artist and a length
within ten seconds, never another mix, edit, tribute or karaoke) and plays the
closest upload, so a flagged network still plays the track rather than skipping
it. The search runs next to the re-upload probes instead of after them, and it
asks for fifty hits: the playable upload is rarely the first one.

The matcher also checks who published an upload, because a cover quotes the
artist in its title and keeps the original length: a release the catalog credits
to a different artist in `publisher_metadata.artist` is never played, a verified
account that is not this artist is a cover artist's own page, a bracketed part
the release does not have (`(Full Step Down)`, `(The Arabic Version/Rendition)`)
is another version, and an upload nobody credits to the artist may only add one
word to the release title. A channel that calls itself a cover, tribute or
karaoke act counts against an upload; a channel name that merely contains an
instrument or the word "live" ("Bass Nation", "Live Nation") does not, since
those are ordinary account names. Every candidate the SoundCloud fallback
rejects is logged with the rule that rejected it. A song whose only playable SoundCloud copy is a
re-performance now reports itself unavailable instead of playing the wrong
recording.

SoundCloud's API sends no CORS headers, so `/__yt` forwards
`api-v2.soundcloud.com` and the page its client id is scraped from. A worker
deployed before that allowlist refuses the route; `soundcloudTransport.ts` then
switches to `/__media`, which every playable deployment already pipes any
host on the desktop CORS allowlist. SoundCloud's HLS media answers
`access-control-allow-origin: *` and streams straight to the page. Monetized
tracks only expose DRM (FairPlay/Widevine) transcodings, so search hits without
one clear stream are dropped before they can become a candidate. Only when
every catalog is out of options does the track become a normal "track
unavailable" error and the queue skips. The YouTube sign-in prompt is
desktop-only, where the TV device flow can actually finish; a tab cannot.

### Starting a track

A resolved stream is attached and played immediately: the element used to be
waited on for `HAVE_FUTURE_DATA` (three seconds at worst) before `play()` was
even called, which is a fixed delay in front of every slow source and does not
make the start any more reliable. `play()` already resolves when playback
begins. What it needs is a deadline — a stalled source leaves the promise
pending forever (`START_TIMEOUT_MS`) — and one clean reload when the element
rejects or never starts the source, instead of reporting the song as
unplayable and skipping it.

A refused player call also used to rotate `visitorData` for every client the
resolve retried, so one bot check cost several relayed `sw.js_data` round trips
before the fallback could run; the refresh is now debounced to once per resolve.

The relays also strip the browser's client hints (`sec-ch-ua`, `sec-fetch-*`) and
run `x-liner-user-agent` into the real `user-agent`, the way the desktop main
process swaps it. Forwarding a Chromium fingerprint next to `x-youtube-client-name`
is itself enough for YouTube to answer 403 or "confirm you're not a bot" on
requests that play fine without it.

When YouTube flagging is decided by the address the request leaves from, and
that address is a shared Worker, no client or visitor id helps: every profile
answers `LOGIN_REQUIRED` while the same relay from another Cloudflare colo
plays. The browser therefore mints its own PO tokens (`src/web/youtube/webMinter.ts`
through BotGuard, challenge and `GenerateIT` relayed by `/__yt`) so WEB_REMIX can
resolve with `serviceIntegrityDimensions.poToken`. Minting is best effort: if the
challenge run yields no minter it is parked for ten minutes and playback falls
back to the direct-url profiles.

### Deploying

`dist-web/` is static, but the app is **not** functional without the proxies.
Any deployment must forward `/__liner/*` to the API _and_ sign the forwarded
request, otherwise sign-in fails. It must also forward `/__media` and `/__yt`
to the hosts above (no signing needed, keep `Range` and the status), or nothing
plays. Do not expose the signing key to the client, and do not point
`VITE_API_URL` at the API host directly.

A static host alone cannot run this app. GitHub Pages and a static Vercel
deployment have no server half, so `/__liner/*` returns their HTML page and the
app can only report that the deployment is not connected. The working
deployment is the Cloudflare Worker (`worker/index.template.mjs`, emitted by
`scripts/emit-sites-worker.mjs`, smoke-tested by `scripts/test-sites-worker.mjs`)
behind Freebuff Sites. Any other host needs an equivalent Node/edge function
that reuses `createApiProxy` and `createMediaRelay`.

### Cloudflare Workers

`wrangler.deploy.jsonc` deploys the same worker and `dist-web/` assets to a
`*.workers.dev` hostname on the Workers free plan (no credit card, 100,000
requests/day, static asset requests unlimited). Connect the repository with
Workers Builds in the dashboard (Workers & Pages -> Create -> Connect to Git)
and use:

```sh
# build command
corepack enable && pnpm install --frozen-lockfile && pnpm build:web
# deploy command
npx wrangler deploy
```

Wrangler runs `npm run build:web` itself before packaging, so the dashboard's
build command can stay at its default (even one that builds Electron).

The generated `worker/index.mjs` and `worker/signer.wasm` are committed, so the
deploy always has an entry point even if the host's build command does not run
the emitter; `pnpm build:web` regenerates both.

The free plan allows 10 ms of CPU per request, so the media relay is the tight
part: it streams upstream audio in 256 KiB chunks. If playback is terminated on
the free plan, that limit (not the code) is the cause.

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
today), so in `--mode web` `api.streamLyrics` delegates to the public sources
in `src/web/lyrics`:

- `resolveLyrics.ts` / `streamLyrics.ts` race every provider at once and emit
  the same `provider` + `done` events, so `playerEngine`, the cache, the
  offsets and the lyrics canvas work unchanged. The first answer is painted as
  soon as it lands; the race settles by timing tier, waiting a short grace
  window for a possible richer answer before aborting the requests still in
  flight.
- `ranking.ts` scores each candidate (recording match 35%, text 25%, timing
  25%, source trust 15%) and ranks by timing depth first, so syllable > word >
  line > plain. `isDecisiveCandidate` is the early-exit rule used by the race.
- `lrcmuxLyrics.ts` — LRCMUX (`GET https://api.lrcmux.dev/get?format=json`)
  aggregates Deezer, KuGou and YouTube Music. Word-level results are converted
  to the richsync JSON the parser already understands (it keeps each word's
  own end time, which LRC text cannot express), line-level results to LRC,
  everything else to plain text. LRCMUX answers `429` with `Retry-After` at 60
  requests a minute; the client parks itself for that window and the request
  falls through to LRCLIB. A timed result whose track length differs from the
  playing track by more than 8 s (or 5%) is thrown away as a different
  recording, because its timings would be seconds out of sync.
- `lrclibLyrics.ts` — LRCLIB (`GET https://lrclib.net/api/get`, then
  `/api/search` with the synced result closest to the track length).
- `lyricsOvh.ts` — Lyrics.ovh, plain text only. It is registered with
  `tier: "plain"`, so it is asked only when no synced source found anything.

The best racing candidate wins: syllable-level beats word-level, which beats
line-level, which beats plain text from either of the two synced sources. Plain
results that arrive during the race are kept as the fallback instead of ending
it. If nobody has lyrics, Lyrics.ovh supplies unsynced text; if that misses too
the UI reports none. All three APIs answer with
`access-control-allow-origin: *`, so no relay is involved. Titles are cleaned
first (`(Official Video)`, `[Remastered]`, `- Official Audio`) because YouTube
titles carry release noise the databases do not index. The desktop build keeps
using the API stream. The server's SSE frames are read with the shared
`src/shared/media/sse.ts` parser, which also accepts CRLF and multi-line data.
See `docs/LYRICS_PIPELINE.md` for the data flow and how to add a provider.

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

| Data                           | Endpoint                                           |
| ------------------------------ | -------------------------------------------------- |
| Profile                        | `GET /v1/me`                                       |
| Playlists                      | `GET /v1/me/playlists`, `GET /v1/me/playlists/:id` |
| Liked songs                    | `GET /v1/me/library/tracks`                        |
| Saved albums/artists/playlists | `GET /v1/me/library/{albums,artists,playlists}`    |
| History                        | `GET /v1/me/history`                               |

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

| Path       | Why a browser cannot replace it                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `/__liner` | API requests are HMAC-signed with a key that lives in the main process; `api.tryliner.fun` sends no CORS headers |
| `/__yt`    | Innertube answers the CORS preflight with 403                                                                    |
| `/__media` | googlevideo sends no CORS headers and 403s ranges over 256 KiB                                                   |

So Pages alone renders the shell, guest mode, the locally stored library, local
files and LRCLIB lyrics, but sign-in, the online catalog and YouTube playback
will fail. Deploy `dist-web` behind the Node server (any Node host running
`pnpm preview:web`), or port those three endpoints to a Worker/Functions runtime
before treating a purely static host as a full deployment.

## Cloudflare cannot reach the API

`api.tryliner.fun` tarpits requests from Cloudflare Workers and other
datacenter IPs: the relay's signed fetch hangs until its 30 s timeout and
returns `502 API_PROXY_UNREACHABLE`. The page, assets and the Innertube/media
relays work, but sign-in, the cloud library and anything else under
`/__liner` do not work on Workers.

This is upstream bot protection, not a bug here: the same signed request
succeeds from a desktop machine, and plain `curl` gets an instant Cloudflare
403. The desktop build talks to the API directly and is unaffected.
