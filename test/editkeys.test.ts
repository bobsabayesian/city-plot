import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editKeyFor, EDIT_KEYS, forgetEditKey, NotYoursError, rememberEditKey, saveProject } from '../src/projectFile';
import { defaultProject } from '../src/scene/project';

const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }; };
let ls: ReturnType<typeof memory>;
beforeEach(() => { ls = memory(); vi.stubGlobal('localStorage', ls); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('edit keys kept in this browser', () => {
  it('remembers, replaces and forgets a key', () => {
    expect(editKeyFor('abcd2345')).toBeUndefined();
    rememberEditKey('abcd2345', 'k1');
    expect(editKeyFor('abcd2345')).toBe('k1');
    rememberEditKey('abcd2345', 'k2');
    expect(editKeyFor('abcd2345')).toBe('k2');
    forgetEditKey('abcd2345');
    expect(editKeyFor('abcd2345')).toBeUndefined();
  });
  it('keeps the newest 200 and survives junk or blocked storage', () => {
    for (let i = 0; i < 205; i++) rememberEditKey(`c${i}`, 'k');
    expect(Object.keys(JSON.parse(ls.m.get(EDIT_KEYS)!))).toHaveLength(200);
    expect(editKeyFor('c0')).toBeUndefined();
    expect(editKeyFor('c204')).toBe('k');
    ls.m.set(EDIT_KEYS, '[1,2]');
    expect(editKeyFor('x')).toBeUndefined();
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(editKeyFor('x')).toBeUndefined();
    expect(() => rememberEditKey('x', 'k')).not.toThrow();
  });
});

describe('saving from the browser', () => {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  it('a new save remembers the key it is given; saving over sends it and keeps the code', async () => {
    const calls: { url: string; method: string; key?: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method!, key: (init.headers as Record<string, string>)['x-edit-key'] });
      return init.method === 'POST' ? reply(201, { code: 'abcd2345', editKey: 'k'.repeat(32) }) : reply(200, { code: 'abcd2345' });
    });
    const p = defaultProject();
    expect(await saveProject(p)).toBe('abcd2345');
    expect(editKeyFor('abcd2345')).toBe('k'.repeat(32));
    expect(await saveProject(p, undefined, undefined, 'abcd2345')).toBe('abcd2345');
    expect(calls.map((c) => [c.method, c.url, c.key])).toEqual([['POST', '/api/project', undefined], ['PUT', '/api/project/abcd2345', 'k'.repeat(32)]]);
  });
  it('saving over a code with no key here makes a new code instead', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => { calls.push(init.method!); return reply(201, { code: 'zzzz2222', editKey: 'k'.repeat(32) }); });
    expect(await saveProject(defaultProject(), undefined, undefined, 'abcd2345')).toBe('zzzz2222');
    expect(calls).toEqual(['POST']);
  });
  it('a refused key is forgotten and reported', async () => {
    rememberEditKey('abcd2345', 'k'.repeat(32));
    vi.stubGlobal('fetch', async () => reply(403, { error: 'not yours' }));
    await expect(saveProject(defaultProject(), undefined, undefined, 'abcd2345')).rejects.toBeInstanceOf(NotYoursError);
    expect(editKeyFor('abcd2345')).toBeUndefined();
  });
});
