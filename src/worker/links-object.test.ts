import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `cloudflare:workers` is not resolvable outside the workers runtime, so the
 * base class is stubbed. These tests drive LinksObject.fetch() against a fake
 * SqlStorage rather than a real Durable Object: the routing, validation and
 * response shapes are plain logic, and testing them should not require
 * standing up workerd.
 *
 * What this cannot cover: real SQL execution and DO persistence. Anything
 * asserted about a query here is asserted about the string we pass, not about
 * what SQLite does with it.
 */
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { LinksObject } = await import('./links-object.js');

type ExecCall = { query: string; bindings: unknown[] };

function makeObject(rows: Record<string, unknown>[] = []) {
  const calls: ExecCall[] = [];
  const sql = {
    exec: vi.fn((query: string, ...bindings: unknown[]) => {
      calls.push({ query, bindings });
      return { toArray: () => rows };
    }),
  };
  const ctx = { storage: { sql } } as unknown as DurableObjectState;
  const obj = new LinksObject(ctx, {} as never);
  return { obj, calls, sql };
}

function req(path: string, init: RequestInit = {}) {
  return new Request(`https://links.test${path}`, init);
}

describe('routing', () => {
  it('404s an unknown path', async () => {
    const { obj } = makeObject();
    const res = await obj.fetch(req('/nope'));
    expect(res.status).toBe(404);
  });

  it('serves the list on both / and /list', async () => {
    for (const path of ['/', '/list']) {
      const { obj } = makeObject();
      const res = await obj.fetch(req(path));
      expect(res.status, path).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });
    }
  });

  it('405s a write verb on the read route', async () => {
    for (const method of ['DELETE', 'POST', 'PUT']) {
      const { obj } = makeObject();
      const res = await obj.fetch(req('/list', { method }));
      expect(res.status, method).toBe(405);
    }
  });

  it('still serves HEAD alongside GET', async () => {
    const { obj } = makeObject();
    const res = await obj.fetch(req('/list', { method: 'HEAD' }));
    expect(res.status).toBe(200);
  });
});

describe('add validation', () => {
  /**
   * The two guards are not interchangeable, and a naive test cannot tell them
   * apart: `new URL()` throws on undefined, on 42 and on "not a url" just as
   * the typeof check rejects them, so deleting the first guard leaves every
   * status code unchanged. Found by sabotaging that guard and watching nothing
   * go red.
   *
   * The error MESSAGE is what separates them, so these assert on it. If the
   * typeof guard is removed, the 400s stay but their bodies change to
   * "Invalid URL", and these fail.
   */
  it('rejects a missing url with the required-field error, not the parse error', async () => {
    const { obj } = makeObject();
    const res = await obj.fetch(req('/add', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'url is required' });
  });

  it('rejects a non-string url with the required-field error', async () => {
    const { obj } = makeObject();
    const res = await obj.fetch(
      req('/add', { method: 'POST', body: JSON.stringify({ url: 42 }) }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'url is required' });
  });

  it('rejects an unparseable string with the parse error', async () => {
    const { obj } = makeObject();
    const res = await obj.fetch(
      req('/add', { method: 'POST', body: JSON.stringify({ url: 'not a url' }) }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Invalid URL' });
  });

  it('accepts a normal http URL', async () => {
    const { obj } = makeObject();
    const res = await obj.fetch(
      req('/add', { method: 'POST', body: JSON.stringify({ url: 'https://example.com' }) }),
    );
    expect(res.status).toBe(200);
  });

  /**
   * `new URL()` accepts javascript:, data: and vbscript: as valid URLs, and
   * LinksApp renders a stored url into an href — so without a scheme check a
   * stored bookmark is a stored click-to-execute.
   */
  it('rejects schemes that are not http or https', async () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
    ]) {
      const { obj } = makeObject();
      const res = await obj.fetch(req('/add', { method: 'POST', body: JSON.stringify({ url }) }));
      expect(res.status, url).toBe(400);
    }
  });

  it('accepts http as well as https', async () => {
    for (const url of ['http://example.com', 'https://example.com']) {
      const { obj } = makeObject();
      const res = await obj.fetch(req('/add', { method: 'POST', body: JSON.stringify({ url }) }));
      expect(res.status, url).toBe(200);
    }
  });

  it('trims tags and drops empty ones', async () => {
    const { obj, calls } = makeObject();
    await obj.fetch(
      req('/add', {
        method: 'POST',
        body: JSON.stringify({ url: 'https://example.com', tags: ['  a  ', '', 'b'] }),
      }),
    );
    const insert = calls.find((c) => c.query.includes('INSERT'));
    const tagsJson = insert?.bindings.find(
      (b) => typeof b === 'string' && b.startsWith('['),
    ) as string;
    expect(JSON.parse(tagsJson)).toEqual(['a', 'b']);
  });

  /**
   * The coercion used to be `String(t).trim()`, which has an answer for every
   * input: 7 became "7", an object became "[object Object]". Non-strings are
   * dropped now rather than stringified.
   */
  it('drops non-string tags rather than stringifying them', async () => {
    const { obj, calls } = makeObject();
    await obj.fetch(
      req('/add', {
        method: 'POST',
        body: JSON.stringify({
          url: 'https://example.com',
          tags: [7, true, { a: 1 }, 'keep'],
        }),
      }),
    );
    const insert = calls.find((c) => c.query.includes('INSERT'));
    const tagsJson = insert?.bindings.find(
      (b) => typeof b === 'string' && b.startsWith('['),
    ) as string;
    expect(JSON.parse(tagsJson)).toEqual(['keep']);
  });

  it('400s a malformed JSON body instead of throwing', async () => {
    const { obj } = makeObject();
    const res = await obj.fetch(req('/add', { method: 'POST', body: '{not json' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Invalid JSON body' });
  });
});

describe('delete', () => {
  it('404s an id that does not exist instead of reporting success', async () => {
    const { obj } = makeObject([]);
    const res = await obj.fetch(req('/delete/does-not-exist', { method: 'DELETE' }));
    expect(res.status).toBe(404);
  });

  it('deletes a row that exists', async () => {
    const { obj, calls } = makeObject([{ id: 'real-id' }]);
    const res = await obj.fetch(req('/delete/real-id', { method: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.query.includes('DELETE FROM'))).toBe(true);
  });

  it('only deletes on DELETE, not GET', async () => {
    const { obj, calls } = makeObject();
    await obj.fetch(req('/delete/some-id'));
    expect(calls.some((c) => c.query.includes('DELETE FROM'))).toBe(false);
  });
});

describe('tags update', () => {
  it('rejects a non-array tags field', async () => {
    const { obj } = makeObject();
    const res = await obj.fetch(
      req('/tags/abc', { method: 'PATCH', body: JSON.stringify({ tags: 'a,b' }) }),
    );
    expect(res.status).toBe(400);
  });

  it('404s when the row is missing after the update', async () => {
    const { obj } = makeObject([]);
    const res = await obj.fetch(
      req('/tags/abc', { method: 'PATCH', body: JSON.stringify({ tags: ['x'] }) }),
    );
    expect(res.status).toBe(404);
  });
});

describe('list query handling', () => {
  it('caps limit at 1000 even when asked for more', async () => {
    const { obj, calls } = makeObject();
    await obj.fetch(req('/list?limit=99999'));
    const select = calls.find((c) => c.query.includes('SELECT'));
    expect(select?.bindings).toContain(1000);
  });

  it('defaults to 500 when no limit is given', async () => {
    const { obj, calls } = makeObject();
    await obj.fetch(req('/list'));
    const select = calls.find((c) => c.query.includes('SELECT'));
    expect(select?.bindings).toContain(500);
  });

  it('uses the search query when one is supplied', async () => {
    const { obj, calls } = makeObject();
    await obj.fetch(req('/list?search=Rust'));
    const select = calls.find((c) => c.query.includes('SELECT'));
    expect(select?.query).toContain('LIKE');
    expect(select?.bindings).toContain('%rust%');
  });
});

describe('tag parsing', () => {
  it('returns malformed stored tags as an empty list rather than throwing', async () => {
    const { obj } = makeObject([
      { id: '1', url: 'https://x', title: null, description: null, tags: '{bad', created_at: '', updated_at: '' },
    ]);
    const res = await obj.fetch(req('/list'));
    const body = (await res.json()) as { links: Array<{ tags: string[] }> };
    expect(body.links[0].tags).toEqual([]);
  });
});
