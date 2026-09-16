import { DurableObject } from 'cloudflare:workers';
import type { Env, Link } from './types.js';

/** Shape of client-supplied JSON bodies; fields are validated below, not trusted. */
interface AddLinkBody {
  url?: unknown;
  title?: string;
  description?: string;
  tags?: unknown[];
}

export class LinksObject extends DurableObject<Env> {
  private schemaReady = false;

  private ensureSchema() {
    if (this.schemaReady) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS links (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        title TEXT,
        description TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.schemaReady = true;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    this.ensureSchema();

    // GET /list
    if (path === '/' || path === '/list') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json({ ok: false, error: 'Method not allowed' }, 405);
      }
      return this.handleList(url);
    }

    // POST /add
    if (path === '/add' && request.method === 'POST') {
      return this.handleAdd(request);
    }

    // DELETE /delete/:id
    const deleteMatch = path.match(/^\/delete\/(.+)$/);
    if (deleteMatch && request.method === 'DELETE') {
      return this.handleDelete(deleteMatch[1]);
    }

    // PATCH /tags/:id
    const tagsMatch = path.match(/^\/tags\/(.+)$/);
    if (tagsMatch && request.method === 'PATCH') {
      return this.handleUpdateTags(tagsMatch[1], request);
    }

    return json({ error: 'Not found' }, 404);
  }

  private handleList(url: URL): Response {
    const search = (url.searchParams.get('search') || '').trim().toLowerCase();
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '500', 10), 1000);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    let rows: Link[];
    if (search) {
      const like = `%${search}%`;
      rows = this.ctx.storage.sql.exec<Link>(
        `SELECT * FROM links
         WHERE url LIKE ?1 OR title LIKE ?1 OR description LIKE ?1 OR tags LIKE ?1
         ORDER BY created_at DESC LIMIT ?2 OFFSET ?3`,
        like, limit, offset,
      ).toArray();
    } else {
      rows = this.ctx.storage.sql.exec<Link>(
        `SELECT * FROM links ORDER BY created_at DESC LIMIT ?1 OFFSET ?2`,
        limit, offset,
      ).toArray();
    }

    const links = rows.map(parseTags);
    return json({ ok: true, links });
  }

  private async handleAdd(request: Request): Promise<Response> {
    let body: AddLinkBody;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'Invalid JSON body' }, 400);
    }
    const { url: linkUrl, title, description } = body;

    if (typeof linkUrl !== 'string' || !linkUrl) {
      return json({ ok: false, error: 'url is required' }, 400);
    }

    let parsed: URL;
    try { parsed = new URL(linkUrl); } catch {
      return json({ ok: false, error: 'Invalid URL' }, 400);
    }

    // Scheme allowlist. `new URL()` accepts javascript:, data: and vbscript:
    // as perfectly valid URLs, and LinksApp renders a stored url straight into
    // an href — so without this a stored bookmark is a stored click-to-execute.
    // Allow only the two schemes a bookmark can sensibly be.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return json({ ok: false, error: 'Only http and https URLs are allowed' }, 400);
    }

    // Only strings become tags. This was `String(t).trim()`, which has an
    // answer for every input — a number became "7", an object became
    // "[object Object]" — so non-strings were stored rather than rejected.
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((t): t is string => typeof t === 'string').map(t => t.trim()).filter(Boolean)
      : [];

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.ctx.storage.sql.exec(
      `INSERT INTO links (id, url, title, description, tags, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      id, linkUrl, title || null, description || null, JSON.stringify(tags), now, now,
    );

    const link = parseTags({
      id, url: linkUrl, title: title || null, description: description || null,
      tags: JSON.stringify(tags), created_at: now, updated_at: now,
    });

    return json({ ok: true, link });
  }

  private handleDelete(id: string): Response {
    // Check the row exists first: SqlStorage exposes no rowcount on exec, and
    // reporting ok:true for an id that was never there means a client cannot
    // tell a real delete from a no-op.
    const existing = this.ctx.storage.sql
      .exec(`SELECT id FROM links WHERE id = ?`, id)
      .toArray();
    if (existing.length === 0) {
      return json({ ok: false, error: 'Not found' }, 404);
    }
    this.ctx.storage.sql.exec(`DELETE FROM links WHERE id = ?`, id);
    return json({ ok: true });
  }

  private async handleUpdateTags(id: string, request: Request): Promise<Response> {
    let body: Pick<AddLinkBody, 'tags'>;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'Invalid JSON body' }, 400);
    }
    if (!Array.isArray(body.tags)) {
      return json({ ok: false, error: 'tags must be an array' }, 400);
    }

    // Same string-only rule as handleAdd: String() would coerce a number or an
    // object into a tag rather than rejecting it.
    const cleanTags = body.tags
      .filter((t): t is string => typeof t === 'string')
      .map(t => t.trim())
      .filter(Boolean);
    const now = new Date().toISOString();

    this.ctx.storage.sql.exec(
      `UPDATE links SET tags = ?1, updated_at = ?2 WHERE id = ?3`,
      JSON.stringify(cleanTags), now, id,
    );

    const row = this.ctx.storage.sql.exec<Link>(
      `SELECT * FROM links WHERE id = ?`, id,
    ).toArray()[0];

    if (!row) return json({ ok: false, error: 'Link not found' }, 404);

    return json({ ok: true, link: parseTags(row) });
  }
}

function parseTags(row: Link): Omit<Link, 'tags'> & { tags: string[] } {
  let tags: string[] = [];
  try { tags = JSON.parse(row.tags); } catch { /* Preserve an empty tag list for malformed legacy rows. */ }
  return { ...row, tags };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
