# html-share-workers

A Cloudflare Worker that hosts shared HTML pages from R2 storage. Each page is
public, secured (password), or gated (limited to the IP ranges of a named
gate). Pages are published through an HTTP upload API, or with the `htmlshare`
command-line client in `cli/`.

## Layout

| Path | What it is |
|---|---|
| `src/index.ts` | Hono app. Mounts the API at `/api` and serving at everything else. |
| `src/api/index.ts` | Upload API (Hono sub-app, routes relative to `/api`). |
| `src/serve/index.ts` | Serving (Hono sub-app): artifacts, index, redirects. |
| `src/env.ts` | `Env` bindings type and `machineTokens()` for `TOKEN_<MACHINE>` secrets. |
| `src/lib/artifacts.ts` | Storage contract: scopes, R2 key layout, slug rules, metadata, listing. |
| `src/lib/gates.ts` | `parseGates()` for the `IP_GATES` config. |
| `src/lib/cidr.ts` | IPv4 and IPv6 CIDR matching. |
| `src/lib/password.ts` | PBKDF2-SHA256 password hashing for secured artifacts. |
| `test/` | Vitest tests, run inside workerd with `@cloudflare/vitest-plugin`. |

The API and serving only meet through `src/env.ts` and `src/lib/`; `src/index.ts`
should not need changing.

### Storage

| Visibility | URL | R2 key |
|---|---|---|
| public | `/<slug>/<path>` | `<slug>/<path>` |
| secured | `/_/<slug>/<path>` | `_/<slug>/<path>` |
| gated | `/<gate>/<slug>/<path>` | `gated/<gate>/<slug>/<path>` |

An empty path means `index.html`. An artifact's metadata (`visibility`,
`created`, `updated`, `listed`, `title`, `pwhash` for secured, and `gate` for
gated) is stored as R2 custom metadata on its own `index.html`. Code passes an
artifact's place around as a `Scope`: `{visibility: 'public'}`,
`{visibility: 'secured'}` or `{visibility: 'gated', gate: '<name>'}`.

Gated keys sit under the fixed `gated/` prefix rather than mirroring the URL,
so a public lookup can never reach a gated object, whatever `IP_GATES` says.
Only gated slugs may have several segments (`pr/some-repo/123`).

While a PUT or DELETE runs, it holds a lock for its slug: a small object at
`.locks/<R2 key prefix><slug>` (for example `.locks/gated/acme/pr/x`), created
with a conditional put so only one request gets it. No slug can start with
`.`, so the lock is never served or listed. The lock records an expiry five
minutes ahead; after that another request may take it over, so a crashed
upload does not block the slug for long. The upload body is read before the
lock is taken.

## Serving

`src/serve/index.ts` handles every request outside `/api`.

| Request | Response |
|---|---|
| `/` | Index generated from artifacts with `listed` set, newest first. Secured and gated entries are links only. Gated entries whose gate is not configured are left out. |
| `/robots.txt` | `User-agent: *` / `Disallow: /` |
| `/<slug>` | 308 to `/<slug>/` (the same for `/_/<slug>` and `/<gate>/<slug>`). |
| `/<slug>/<path>` | The R2 object. A folder path serves its `index.html`; a folder without a trailing slash 308s to the slash form. |
| `/<slug>/...` where slug is in `REDIRECTS` | 308 to the target, keeping the sub-path and query. Checked before the public lookup. |
| An exact path in `REDIRECTS` (a key starting with `/`) | 308 to the target, keeping the query but not matching sub-paths. Checked first, before secured, gated and public lookups. |
| `/_/<slug>/...` | The object if the request has a valid cookie, otherwise a password form (401). |
| `/<gate>/<slug>/...` | For each gate in `IP_GATES`: the object if `CF-Connecting-IP` is in that gate's ranges, otherwise 403. Checked before redirects and public artifacts. |

`REDIRECTS` is a JSON object of key to target. A key without a slash is a
top-level slug: `/<slug>/...` redirects with its sub-path kept. A key starting
with `/` is an exact path, which can have several segments and can be a gate
root, matched against the decoded path. A trailing slash on the key or the
request does not matter. An entry whose target is its own path is dropped
when parsed (see Configuration). A full URL to the serving host at the same
path cannot be caught then, so it is skipped on each request instead. A
target must be an absolute path (`/...`) or a full URL with a scheme. The
Location is the target's path, then the request sub-path for a slug key, then
the target's query and the request query joined with `&`, then the target's
fragment: `{"old":"/acme/old/?ref=x"}` sends `/old/page?a=1` to
`/acme/old/page?ref=x&a=1`. Exact-path redirects run before the IP check, so anyone can see where a gate root points;
they reveal a path, not content, and the target is still gated. For example, to send `/lhv/` to the
listing at `/lhv/index/`:

```json
{"/lhv/": "/lhv/index/"}
```

Content type comes from the object's stored `Content-Type`, then its file
extension. Responses carry an `ETag` and answer `If-None-Match` with 304, and
`HEAD` works. Every response has `X-Robots-Tag: noindex`. Public files are
cached for 5 minutes; secured and gated files get `Cache-Control: private,
no-store`.

### Secured cookies

The form posts the password to the same URL. On a match the Worker sets
`share_auth` with `Path=/_/<slug>/; HttpOnly; Secure; SameSite=Lax` for 7 days
and redirects back with a 303. The cookie value is `<expiry>.<signature>`,
where the signature is HMAC-SHA256 with `COOKIE_SECRET` over the slug, the
expiry and a SHA-256 of the artifact's current `pwhash`. Changing the
password invalidates old cookies. Replacing an artifact without a password
keeps its hash, so old cookies stay valid; giving or regenerating a password
changes the hash and invalidates them. If `COOKIE_SECRET` is unset, secured pages return 500.

Password attempts are limited to 10 a minute per client IP
(`CF-Connecting-IP`; an IPv6 client counts as its /64), counted across all
secured pages. Over the limit the
Worker answers 429 with the login form and a "too many attempts" message,
without looking up the artifact or checking the password. Page views are
not counted. The limit is the `LOGIN_LIMIT` rate-limit binding in
`wrangler.toml`; Cloudflare counts per location and approximately, so treat
it as a brake on guessing, not an exact cap.

### IP gates

`IP_GATES` is a JSON object mapping each gate name to a list of IPv4 and IPv6
CIDRs; a bare address means one host. There can be any number of gates,
including none. A request to `/<gate>/...` is checked against that gate's
ranges only, so an address allowed for one gate gets a 403 from another. Only
`CF-Connecting-IP` is read, never `X-Forwarded-For`. A request without it is
refused. The 403 page does not name the gate.

A gate name is one lowercase kebab-case segment and cannot be `_`, `api`,
`assets`, `gated`, `index.html`, `robots.txt`, `favicon.ico`, `public` or
`secured`.

When the config is wrong, gated content stays closed and public and secured
pages keep working:

- A bad entry (an invalid gate name, a value that is not a list of strings, or
  a CIDR that does not parse) makes every gate return 403, and is logged.
- JSON that does not parse, or is not an object, means no gates are known, so
  `/<gate>/...` is an ordinary public miss (404). This is logged.
- A gate that is removed from the config behaves the same way: its URLs 404
  and its objects stay in R2, unreachable, until the gate is added back. The
  API returns 400 for it.

#### Adding a gate

Add the gate to `IP_GATES` at deploy time; no code change is needed. For
example:

```json
{"acme":["192.0.2.0/24","2001:db8::/32"],"example":["198.51.100.0/24"]}
```

Then upload with `htmlshare ./build report --gate acme`, which serves at
`/acme/report/`. A configured gate name is reserved as a public slug, so new
public uploads with that name are refused. A public artifact uploaded with that
name before the gate was added is shadowed: the gate is served instead.

### Analytics

When `ANALYTICS_SNIPPET` is set, it is appended to `<head>` on every HTML
response, including the generated pages. The ETag of a rewritten page is
weak and includes a hash of the snippet, so changing the snippet changes it.

## Configuration

Everything except the R2 bucket and the `LOGIN_LIMIT` rate limit (both in
`wrangler.toml`, see "Secured cookies") is a Worker secret: `COOKIE_SECRET`,
`TOKEN_<MACHINE>`, `IP_GATES`, `REDIRECTS` and `ANALYTICS_SNIPPET`. The last
three are optional. `wrangler.toml` has no `[vars]` block. `IP_GATES` and
`REDIRECTS` are parsed once per Worker isolate, so a bad value is logged once
rather than on every request. Bad `REDIRECTS` entries are dropped and logged:
a target that is not a non-empty string, a target that is neither `/...` nor a
full URL, a slug key containing `/`, the key `/`, a key ending in more than one
slash, an exact key that does not percent-decode (keys are decoded, so
`/caf%C3%A9/` and `/café/` are the same), a target that points back at the
key's own path (including with a query or fragment), and every exact key in a
loop of exact keys (`/a/` to `/b/` to `/a/`). For local runs,
copy `.dev.vars.example` to `.dev.vars` (git-ignored) and edit it:

```sh
cp .dev.vars.example .dev.vars
```

## Deploying

Set each secret once with `wrangler secret put <NAME>`. It prompts for the
value, or reads standard input, so JSON can come from a file:

```sh
wrangler secret put COOKIE_SECRET
wrangler secret put TOKEN_M5P
wrangler secret put IP_GATES < gates.json
wrangler secret put REDIRECTS < redirects.json
wrangler secret put ANALYTICS_SNIPPET < snippet.html
```

`gates.json` maps each gate name to its CIDRs, and `redirects.json` maps a
slug to a target path:

```json
{"acme":["192.0.2.0/24","2001:db8::/32"],"example":["198.51.100.0/24"]}
```

```json
{"old-overview":"/acme/old-overview/"}
```

Secrets survive `wrangler deploy`. Values in a `[vars]` block do not: a deploy
replaces the deployed vars with the file's, so real values would be lost and
gated pages would 404 until someone noticed. Keep the gate ranges and
redirects out of the repository; only `.dev.vars.example` holds placeholders.

Putting or deleting a secret takes effect without a separate deploy.

When moving a Worker that still has these as plain vars: run `wrangler secret
put` for each one before the first `wrangler deploy` of this version, and check
the gated URLs afterwards. If a secret put is refused because a var of the same
name exists, delete the var in the dashboard first and put the secret straight
away; gated pages 404 in between.

### Machine tokens

To add a machine, pick a name and generate a token, then store it as
`TOKEN_<NAME>` (upper case; the uploader shows as the lower-case name):

```sh
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > ~/token.txt
wrangler secret put TOKEN_WORKLAPTOP < ~/token.txt
```

Move `~/token.txt` to that machine as `~/.config/htmlshare/token` and delete
the other copy. To revoke a
machine, run `wrangler secret delete TOKEN_WORKLAPTOP`.

## Running locally

```sh
npm ci --ignore-scripts
npm test               # vitest in workerd
npx tsc --noEmit       # type-check
npx wrangler dev --local
```

## Publishing with the CLI

`cli/htmlshare` is a bash script that uploads from disk through the API. It
needs bash and curl; `jq` is optional and gives `ls` more columns.

```sh
htmlshare ./report.html                     # public, random slug
htmlshare ./report.html q1-deck             # public, named
htmlshare ./report.html q1-deck --secured   # password generated by the server
htmlshare ./report.html q1-deck --pw hunter2
htmlshare ./build pr/some-repo/123 --gate acme  # a directory: uploads the whole tree
htmlshare ./report.html q1-deck --listed --title "Q1 deck"
htmlshare ./report.html q1-deck --force     # replace an existing slug
htmlshare ./report.html q1-deck --secured --force --new-pw  # replace and change the password
htmlshare ./report.html q1-deck --force --unlisted --title ""  # replace, unlist, clear the title
htmlshare ls [--public|--secured|--gate acme]
htmlshare rm q1-deck [--secured|--gate acme]
```

- `--gate <name>` must name a gate the server has configured. There is no
  default gate.
- It reads the server from `HTMLSHARE_URL` (default `https://share.rlew.io`)
  and the token from `HTMLSHARE_TOKEN`, or from `~/.config/htmlshare/token`.
- Each machine has its own token: the Worker secret `TOKEN_<MACHINE>`.
  Removing or blanking that secret revokes that machine only. The machine name
  is stored on each artifact as `uploadedBy`.
- The server refuses to replace an existing slug unless `--force` is given
  (the CLI then sends `overwrite=true`). Replacing an artifact removes all of
  its old files.
- A replace keeps the old password, title and listed setting unless you set
  them: `--pw <x>` or `--new-pw` for the password, `--title <t>` (`--title ""`
  clears it), `--listed` or `--unlisted`. A secured replace that kept its
  password prints `Password: unchanged`. A replace must say `--secured` (or
  `--gate`) again, as the scope is part of the slug.
- A directory must contain `index.html`. Dotfiles and dot-folders are skipped;
  symlinks are followed.
- Secured: the password is printed once. Only a PBKDF2 hash is stored. A
  generated password is 24 characters of base64url.
- The URL is copied to the clipboard (pbcopy, wl-copy or xclip) unless
  `HTMLSHARE_NO_CLIPBOARD` is set.

### API

All routes need `Authorization: Bearer <token>`. Bodies are limited to 25 MB.

| Route | What it does |
|---|---|
| `PUT /api/artifacts/<scope>/<slug>` | Upload. Body is `text/html` (one page) or `multipart/form-data` (field name = path, must include `index.html`). Query `listed=true|false`, `title=...` (or headers `X-Share-Listed`, `X-Share-Title`). On a replace, a setting that is not sent keeps its old value; `listed=false` unlists and an empty `title=` clears the title. A new artifact is unlisted with no title. Secured: password in `X-Share-Password`, else generated and returned as `password`. Replacing a secured artifact without `X-Share-Password` keeps its password and returns `passwordUnchanged: true`; send `regenerate=true` (or header `X-Share-Password-Regenerate: 1`) to get a new generated one, which cannot be combined with `X-Share-Password`. `created` is kept and `updated` is set on a replace. An existing artifact is only replaced when the request sends `overwrite=true` (or header `X-Share-Overwrite: 1`); without it the PUT is a 409 and nothing changes. An empty `overwrite` is a 400. 201 when new, 200 when replaced, 409 when the artifact exists and `overwrite` is not set, when another PUT or DELETE of the same slug is in progress, or when a gated slug would nest inside another artifact of the same gate or contain one. |
| `GET /api/artifacts[?visibility=<scope>]` | List artifacts, all or one scope. Lists gated artifacts whose gate is no longer configured, too. |
| `GET /api/artifacts/<scope>/<slug>` | Metadata, or 404. |
| `DELETE /api/artifacts/<scope>/<slug>` | Delete every file of the artifact. 409 when another PUT or DELETE of the same slug is in progress. |

`<scope>` is `public`, `secured` or a configured gate name; anything else is a
400. Responses carry `visibility` (`public`, `secured` or `gated`) and, for
gated artifacts, `gate`. Uploading a public slug equal to a configured gate name is a 400; GET and
DELETE still work on one, so a shadowed artifact can be removed.

Errors are JSON: `{"error": "..."}`.

Breaking change: before `overwrite`, a PUT to an existing slug replaced it.
Clients that replace artifacts must now send `overwrite=true`. Deploy the
Worker before updating the CLI: the CLI no longer checks for an existing
slug itself, so against an older Worker it replaces one without `--force`.

`cli/test.sh` runs the CLI against `wrangler dev --local` with a dummy token.
