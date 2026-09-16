# links

Link bookmarking with tags and search: one Cloudflare Worker, one Durable
Object per namespace, and a browser component.

```js
import { LinksApp } from "@barry-rocks/sdk-links";

new LinksApp(document.getElementById("root"), {
  // A path on your own origin, not the worker's address. The worker has no
  // auth of its own, so the page in front of it should proxy — see below.
  workerUrl: "/api/links",
  namespace: "my-collection",
});
```

## Worth knowing before changing anything here

**This worker is live and `barry.rocks` depends on it.** The `/links` page
inlines this package's built `dist/` bundle at build time and calls the worker
through its own authenticated `/api/links/*` proxy. Changes here reach a
running site: rebuild barry.rocks and check `/links` before assuming a change
is contained.

The dependency is a relative path (`link:../links` in barry.rocks'
`package.json`, plus a matching `--dir`/`--filter` build step in its
`package.json` and `bag.yaml`). Moving either directory breaks it.

**The worker authenticates nothing — it relies on having no public
hostname.** The `X-Links-Namespace` header is the only thing separating one
collection from another, and the caller supplies it. Nothing in the worker or
the Durable Object reads a credential, and the CORS block advertises an
`Authorization` header that no code path checks, which makes it look guarded
when it is not.

That is survivable only because `wrangler.jsonc` sets `workers_dev: false`, so
there is no public URL to reach it at. Consumers reach it through a service
binding from an authenticated worker — barry.rocks does this for its `/links`
page, whose `/api/links/*` route checks the session and injects the namespace
server-side, so the browser never learns a worker address.

This was not always true. The worker answered on `workers.dev` and barry.rocks
shipped that hostname to every browser that loaded `/links`, which put a
read-write bookmark store on the open internet; an anonymous `curl` returned
the whole collection. If you deploy this yourself, either keep `workers_dev`
off and use a binding, or put real auth in the worker first. Re-enabling it
without one restores the hole exactly.

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

**The tests pin the defects below rather than hiding them.** Each known-bad
behavior has a test asserting what the code actually does, marked as a defect
in a comment. That means fixing one turns its test red on purpose — the red is
the signal to update the test and delete the entry here, not a regression.

Run them with `pnpm test`. They stub `cloudflare:workers` and fake SqlStorage,
so they cover routing, validation and response shapes but never real SQL or DO
persistence.

One test earns its comment: the two URL guards in `handleAdd` cannot be told
apart by status code, because `new URL()` throws on `undefined`, on `42` and on
`"not a url"` exactly as the typeof check rejects them. Deleting the first
guard leaves every status unchanged — found by trying it and watching nothing
go red. The tests assert on the error MESSAGE for that reason.

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
- Non-string tags are stringified rather than dropped: the coercion is
  `String(t).trim()`, so `7` is stored as `"7"`, `true` as `"true"` and an
  object as `"[object Object]"`. Found by the tests, not by reading.
- The `typeof linkUrl !== 'string'` guard is redundant with the `new URL()`
  parse below it — every input the first rejects, the second also rejects.
  Harmless, but it reads as two checks where there is one.

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
