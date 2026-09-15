# links

Link bookmarking with tags and search: one Cloudflare Worker, one Durable
Object per namespace, and a browser component.

```js
import { LinksApp } from "@barry-rocks/sdk-links";

new LinksApp(document.getElementById("root"), {
  workerUrl: "https://barry-links.<account>.workers.dev",
  namespace: "barry-rocks",
});
```

## Worth knowing before changing anything here

**This worker is live and `barry.rocks` depends on it.** The `/links` page
inlines this package's built `dist/` bundle at build time and points the
browser at `LINKS_WORKER_URL`. Changes here reach a running site: rebuild
barry.rocks and check `/links` before assuming a change is contained.

The dependency is a relative path (`link:../links` in barry.rocks'
`package.json`, plus a matching `--dir`/`--filter` build step in its
`package.json` and `bag.yaml`). Moving either directory breaks it.

**The worker has no authentication, and this one is exposed.** The
`X-Links-Namespace` header is the only thing separating one collection from
another, and the caller supplies it. barry.rocks gates the *page* behind Google
OAuth, then hands the browser the raw worker URL — and the session cookie is
scoped to `barry.rocks`, so it never reaches the worker's origin, which would
ignore it anyway. Anyone who learns that URL can `GET /list`, `POST /add`,
`PATCH /tags/:id`, and `DELETE /delete/:id` against real bookmarks with `curl`.
It leaks into the HTML source of `/links` for every viewer.

The CORS layer makes this look addressed when it is not: it permits an
`Authorization` header that no code in the worker or the Durable Object ever
reads, and it reflects the caller's origin (`Origin || '*'`), so any web page
can drive it. Fixing this means a gateway in front — `bags/artifacts` in the
barry monorepo has a second `deployments:` entry that does exactly that.

**Renaming the worker orphans the bookmarks.** Durable Object storage is keyed
to worker and class name, so changing `barry-links` or `LinksObject` starts
empty collections rather than migrating the existing ones. Export first. The
manifest's `worker:` field is cross-checked against `wrangler.jsonc` at deploy
time so a mismatch fails loudly.

**One lint rule came with the move.** `src/worker/links-object.ts` was exempt
from `no-redundant-type-constituents` in the monorepo's eslint config, because
`Link.tags` is a JSON string on the row and `string[]` after `parseTags`. That
exemption was removed from the monorepo along with the code; this bag has no
eslint config of its own, so nothing enforces the rule here today. If one is
added, that file will need the same exemption or a real fix to the type split.

**There are no tests.** Break the code first when adding one — an assertion
that has never failed is a claim, not evidence.

Known defects, none fixed by the move:

- `handleList` ignores the HTTP method: `DELETE /` and `POST /list` both return
  the full list.
- `handleDelete` always returns `{ok:true}` — no rowcount check, so deleting a
  nonexistent id reports success.
- `javascript:` URLs pass `new URL()` validation and reach an `href` in the
  detail pane. `esc()` escapes HTML but does not check the scheme.
- `LinksApp` never sends the server's `search`/`limit`/`offset` params and
  filters client-side, so the UI silently caps at the server's 500-link default.
- `handleUpdateTags` runs its `UPDATE` before checking the row exists, then
  404s — a no-op write on a bogus id.
- `request.json()` is unguarded in `handleAdd` and `handleUpdateTags`, so a
  malformed body is a 500.

## Layout

| Path | What |
|---|---|
| `src/LinksApp.js` | The browser component — list, detail pane, tag editor |
| `src/worker/index.ts` | Worker entry: `/health`, CORS, namespace → DO routing |
| `src/worker/links-object.ts` | The Durable Object, its SQLite schema, and routes |
| `scripts/build.js` | Bundles `dist/` — CSS, IIFE, and an inline-able string |
| `wrangler.jsonc` | Worker name, DO binding, migration |

## Deploying

```sh
pnpm build && pnpm deploy
```
