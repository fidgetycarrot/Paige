import { describe, expect, test } from 'bun:test';
import { setupBackend } from '../src/backend';

/** Just enough of the host for Paige's backend: storage, one connection, streaming replies, cards, lorebooks, personas, the shared pool. */
function fakeHost(replies: string[], lumicast = true) {
  const store = new Map<string, unknown>();
  const sent: Record<string, unknown>[] = [];
  let listener: (payload: unknown, userId?: string, session?: string) => void = () => {};
  const characters = new Map<string, Record<string, unknown>>(), books = new Map<string, Record<string, unknown>>(), entries = new Map<string, Record<string, unknown>>(), personas = new Map<string, Record<string, unknown>>();
  const pool = new Map<string, unknown>();
  let seq = 0; const nid = (p: string) => `${p}${++seq}`;
  const requests: unknown[] = [];
  const api = {
    permissions: { has: () => true },
    onFrontendMessage: (fn: typeof listener) => { listener = fn; return () => {}; },
    sendToFrontend: (m: Record<string, unknown>) => { sent.push(m); },
    userStorage: {
      getJson: async (path: string, o: { fallback: unknown }) => store.has(path) ? structuredClone(store.get(path)) : o.fallback,
      setJson: async (path: string, value: unknown) => { store.set(path, structuredClone(value)); },
    },
    connections: { list: async () => [{ id: 'c1', name: 'Cheap', provider: 'openrouter', model: 'deepseek' }], get: async (id: string) => id === 'c1' ? { id: 'c1', name: 'Cheap', provider: 'openrouter', model: 'deepseek' } : null },
    generate: {
      raw: async () => ({}),
      rawStream: async function* (request: unknown) {
        requests.push(request);
        const text = replies.shift() ?? 'ok';
        for (const part of text.match(/[\s\S]{1,20}/g)!) yield { type: 'token', token: part };
        yield { type: 'done', content: text, finish_reason: 'stop' };
      },
    },
    characters: {
      get: async (id: string) => characters.get(id) ?? null,
      create: async (input: Record<string, unknown>) => { const c = { ...input, id: nid('char') }; characters.set(c.id, c); return c; },
      update: async (id: string, input: Record<string, unknown>) => { const c = { ...characters.get(id), ...input }; characters.set(id, c); return c; },
    },
    world_books: {
      get: async (id: string) => books.get(id) ?? null,
      create: async (input: Record<string, unknown>) => { const b = { ...input, id: nid('book') }; books.set(b.id, b); return b; },
      update: async (id: string, input: Record<string, unknown>) => { const b = { ...books.get(id), ...input }; books.set(id, b); return b; },
      entries: {
        list: async (bookId: string) => { const data = [...entries.values()].filter(e => e.bookId === bookId); return { data, total: data.length }; },
        create: async (bookId: string, input: Record<string, unknown>) => { const e = { ...input, bookId, id: nid('entry') }; entries.set(e.id, e); return e; },
        delete: async (id: string) => entries.delete(id),
      },
    },
    personas: {
      get: async (id: string) => personas.get(id) ?? null,
      create: async (input: Record<string, unknown>) => { const p = { ...input, id: nid('persona') }; personas.set(p.id, p); return p; },
      update: async (id: string, input: Record<string, unknown>) => { const p = { ...personas.get(id), ...input }; personas.set(id, p); return p; },
    },
    rpcPool: {
      sync: (endpoint: string, value: unknown) => { pool.set(`paige.${endpoint}`, value); return `paige.${endpoint}`; },
      read: async (endpoint: string) => { if (lumicast && endpoint === 'lumicast.paige.start') return { ok: true, count: (pool.get('paige.cast') as { characters: unknown[] }).characters.length }; throw new Error(`Endpoint ${endpoint} is not registered`); },
    },
  };
  setupBackend(api as never);
  const call = async <T>(action: string, input?: unknown): Promise<T> => {
    const id = crypto.randomUUID();
    listener({ type: 'paige:request', id, action, input }, 'u1', 's1');
    for (let i = 0; i < 400; i++) {
      const hit = sent.find(m => m.type === 'paige:response' && m.id === id);
      if (hit) { if (hit.error) throw new Error(String(hit.error)); return hit.result as T; }
      await new Promise(r => setTimeout(r, 2));
    }
    throw new Error('no reply');
  };
  return { call, store, sent, characters, entries, personas, pool, requests };
}

describe('Paige backend', () => {
  test('a whole run: chat, Sheet, card, persona, update, LumiCast', async () => {
    const host = fakeHost([
      'Pitch noted. *She clicks the pen.*\n\n```\nMain character\nName: Jory Kett\n## Identity\nFull name: Jory Kett\n## Appearance & vibe\nHair: black\n```\nNext: side characters?',
      '```\nSide character\nName: Mara\n## Identity\nAliases: Red\n## Look\nRed hair.\n```',
      '```\nPersona\nName: Wes\n## Appearance\nBlond.\n```\n```\nFirst message\nFog rolls in.\n```',
    ]);
    let snap = await host.call<{ session: { turns: unknown[] } }>('snapshot');
    expect(snap.session.turns).toHaveLength(1);
    await expect(host.call('send', { text: 'hi' })).rejects.toThrow('Pick a model connection');
    await host.call('saveSettings', { connectionId: 'c1', thinking: 'off' });
    const first = await host.call<{ session: { blocks: { name: string }[]; turns: { saved?: string[] }[] } }>('send', { text: 'Main character, direct, NSFW off. A dockworker.' });
    expect(first.session.blocks.map(b => b.name)).toEqual(['Jory Kett']);
    expect(first.session.turns.at(-1)!.saved).toEqual(['Added main character: Jory Kett']);
    expect(host.sent.some(m => m.type === 'paige:stream')).toBe(true);
    // The model saw the saved Sheet in its rules.
    await host.call('send', { text: 'side character Mara' });
    const second = host.requests.at(-1) as { messages: { content: string }[]; reasoning?: unknown };
    expect(second.messages[0].content).toContain('Name: Jory Kett');
    expect(second.reasoning).toEqual({ source: 'off' });
    await host.call('send', { text: 'persona and first messages' });

    const made = await host.call<{ name: string; entries: number; greetings: number; personaName: string; cast: { state: string }; updated: boolean }>('makeCard', { name: '', sendLooks: true });
    expect(made).toMatchObject({ name: 'Jory Kett', entries: 1, greetings: 1, personaName: 'Wes', updated: false });
    expect(made.cast.state).toBe('started');
    expect((host.pool.get('paige.cast') as { characters: { name: string }[] }).characters.map(c => c.name)).toEqual(['Jory Kett', 'Mara', 'Wes']);
    const card = [...host.characters.values()][0];
    expect(card.description).toContain('Hair: black');
    expect(card.first_mes).toBe('Fog rolls in.');

    // Editing on the Sheet, then making again, updates the same card and rebuilds only Paige's entries.
    snap = await host.call('snapshot');
    const mara = (snap.session as unknown as { blocks: { id: string; name: string }[] }).blocks.find(b => b.name === 'Mara')!;
    await host.call('editBlock', { id: mara.id, body: 'Name: Mara\n## Look\nShaved head now.' });
    const again = await host.call<{ updated: boolean }>('makeCard', { name: 'Port Hesk', sendLooks: false });
    expect(again.updated).toBe(true);
    expect(host.characters.size).toBe(1);
    expect([...host.characters.values()][0].name).toBe('Port Hesk');
    expect([...host.entries.values()].map(e => e.content)).toEqual(['[Side character]\nName: Mara\n## Look\nShaved head now.']);
    expect(host.personas.size).toBe(1);
  });

  test('retry takes back the last reply and what it saved', async () => {
    const host = fakeHost(['```\nSide character\nName: Ash\n```', 'Plain reply, nothing saved.']);
    await host.call('saveSettings', { connectionId: 'c1', thinking: 'light' });
    await host.call('send', { text: 'go' });
    const result = await host.call<{ session: { blocks: unknown[]; turns: { content: string }[] } }>('retry');
    expect(result.session.blocks).toEqual([]);
    expect(result.session.turns.at(-1)!.content).toBe('Plain reply, nothing saved.');
    expect(result.session.turns.filter(t => t.content === 'go')).toHaveLength(1);
  });

  test('without LumiCast, the card is still made and the reason is plain', async () => {
    const host = fakeHost(['```\nMain character\nName: Ivy\n## Appearance & vibe\nTall.\n```'], false);
    await host.call('saveSettings', { connectionId: 'c1', thinking: 'light' });
    await host.call('send', { text: 'go' });
    const made = await host.call<{ name: string; cast: { state: string; message: string } }>('makeCard', { sendLooks: true });
    expect(made.name).toBe('Ivy');
    expect(made.cast.state).toBe('failed');
    expect(made.cast.message).toContain('Install or update LumiCast');
  });

  test('start over keeps the old session', async () => {
    const host = fakeHost([]);
    const before = await host.call<{ session: { id: string } }>('snapshot');
    const after = await host.call<{ id: string; mode: string }>('startOver', { mode: 'quick' });
    expect(after.id).not.toBe(before.session.id);
    expect(after.mode).toBe('quick');
    expect(host.store.has(`old/${before.session.id}.json`)).toBe(true);
  });
});
