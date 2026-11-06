import { describe, expect, test } from 'bun:test';
import { setupBackend } from '../src/backend';

/** Just enough of the host for Paige's backend: storage, one connection, streaming replies, cards, lorebooks, personas, the shared pool. */
function fakeHost(replies: string[], lumicast = true, denied: string[] = []) {
  const store = new Map<string, unknown>();
  const sent: Record<string, unknown>[] = [];
  let listener: (payload: unknown, userId?: string, session?: string) => void = () => {};
  const characters = new Map<string, Record<string, unknown>>(), books = new Map<string, Record<string, unknown>>(), entries = new Map<string, Record<string, unknown>>(), personas = new Map<string, Record<string, unknown>>();
  const pool = new Map<string, unknown>();
  let seq = 0; const nid = (p: string) => `${p}${++seq}`;
  const chats: { id: string; character_id: string; name: string; updated_at: number }[] = [];
  const requests: unknown[] = [];
  const api = {
    permissions: { has: (p: string) => !denied.includes(p) },
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
      list: async () => { const data = [...characters.values()]; return { data, total: data.length }; },
      get: async (id: string) => characters.get(id) ?? null,
      create: async (input: Record<string, unknown>) => { const c = { world_book_ids: [], alternate_greetings: [], ...input, id: nid('char'), updated_at: ++seq }; characters.set(c.id, c); return c; },
      update: async (id: string, input: Record<string, unknown>) => { const c = { ...characters.get(id), ...input }; characters.set(id, c); return c; },
    },
    world_books: {
      get: async (id: string) => books.get(id) ?? null,
      create: async (input: Record<string, unknown>) => { const b = { ...input, id: nid('book') }; books.set(b.id, b); return b; },
      update: async (id: string, input: Record<string, unknown>) => { const b = { ...books.get(id), ...input }; books.set(id, b); return b; },
      entries: {
        list: async (bookId: string) => { const data = [...entries.values()].filter(e => e.bookId === bookId); return { data, total: data.length }; },
        create: async (bookId: string, input: Record<string, unknown>) => { const e = { key: [], comment: '', content: '', constant: false, disabled: false, extensions: {}, ...input, bookId, world_book_id: bookId, id: nid('entry') }; entries.set(e.id, e); return e; },
        get: async (id: string) => entries.get(id) ?? null,
        update: async (id: string, input: Record<string, unknown>) => { const e = { ...entries.get(id), ...input }; entries.set(id, e); return e; },
        delete: async (id: string) => entries.delete(id),
      },
    },
    personas: {
      get: async (id: string) => personas.get(id) ?? null,
      create: async (input: Record<string, unknown>) => { const p = { ...input, id: nid('persona') }; personas.set(p.id, p); return p; },
      update: async (id: string, input: Record<string, unknown>) => { const p = { ...personas.get(id), ...input }; personas.set(id, p); return p; },
    },
    chats: {
      list: async (o: { characterId: string }) => ({ data: chats.filter(c => c.character_id === o.characterId), total: 1 }),
      get: async (id: string) => chats.find(c => c.id === id) ?? null,
    },
    chat: { getMessages: async () => [{ name: 'Jason', is_user: true, content: 'Sorry I lied.', role: 'user' }, { name: 'Vesper', is_user: false, content: 'Already forgiven!', role: 'assistant' }] },
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
  return { call, store, sent, characters, entries, personas, pool, requests, chats, books };
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
  test('a backup saves the session and loads it back, keeping what was open', async () => {
    const host = fakeHost(['```\nSide character\nName: Ash\n## Look\nTall.\n```', 'Something else.']);
    await host.call('saveSettings', { connectionId: 'c1', thinking: 'light' });
    await host.call('send', { text: 'go' });
    const backup = await host.call<{ kind: string; session: { id: string; blocks: { name: string }[] } }>('exportSession');
    expect(backup.kind).toBe('paige-backup');
    expect(backup.session.blocks.map(b => b.name)).toEqual(['Ash']);
    // Start over, build something else, then load the backup.
    const fresh = await host.call<{ id: string }>('startOver', { mode: 'full' });
    await host.call('send', { text: 'other' });
    await expect(host.call('importSession', { backup: { kind: 'nope' } })).rejects.toThrow('isn\'t a Paige backup');
    await expect(host.call('importSession', { backup: { kind: 'paige-backup', version: 2, session: backup.session } })).rejects.toThrow('newer Paige');
    const loaded = await host.call<{ id: string; blocks: { name: string }[]; turns: unknown[] }>('importSession', { backup: JSON.parse(JSON.stringify(backup)) });
    expect(loaded.id).toBe(backup.session.id);
    expect(loaded.blocks.map(b => b.name)).toEqual(['Ash']);
    expect(host.store.has(`old/${fresh.id}.json`)).toBe(true);
    // Paige's raw session.json loads too.
    const raw = await host.call<{ id: string }>('importSession', { backup: JSON.parse(JSON.stringify(backup.session)) });
    expect(raw.id).toBe(backup.session.id);
    // It survives a reload: the stored session is the loaded one.
    expect((host.store.get('session.json') as { id: string }).id).toBe(backup.session.id);
  });
  test('send looks again can send just the picked people', async () => {
    const host = fakeHost(['```\nMain character\nName: Ivy\n## Appearance & vibe\nTall.\n```\n```\nSide character\nName: Ash\n## Look\nShort.\n```']);
    await host.call('saveSettings', { connectionId: 'c1', thinking: 'light' });
    await host.call('send', { text: 'go' });
    await host.call('makeCard', { sendLooks: false });
    const sent = await host.call<{ state: string; message: string }>('sendLooks', { only: ['ash'] });
    expect(sent.state).toBe('started');
    expect((host.pool.get('paige.cast') as { characters: { name: string }[] }).characters.map(c => c.name)).toEqual(['Ash']);
    expect((await host.call<{ state: string }>('sendLooks', { only: [] })).state).toBe('skipped');
  });
  test('bring a card back, fix it, read the roleplay, save in place and as a copy', async () => {
    const host = fakeHost([
      '"Found it."\n```\nMain character\nName: Vesper\nVesper is a smuggler. She holds grudges for days.\n```\n```\nLore\nName: Rusty Gear\nTrigger words: Rusty Gear, tavern\n\nA loud tavern.\n```\n```\nSide character\nName: Ash\n## Look\nTall.\n```',
      '"Copy it is."',
    ]);
    await host.call('saveSettings', { connectionId: 'c1', thinking: 'light' });
    host.books.set('bk', { id: 'bk', name: 'Hesk' });
    host.entries.set('e1', { id: 'e1', bookId: 'bk', world_book_id: 'bk', key: ['Rusty Gear'], comment: 'Rusty Gear', content: 'A tavern.', constant: false, disabled: false, extensions: {}, position: 2, depth: 4 });
    host.characters.set('v', { id: 'v', name: 'Vesper', description: 'Vesper is a smuggler.', scenario: 'Fog.', personality: '', mes_example: '', system_prompt: '', post_history_instructions: '', first_mes: 'Fog rolls in.', alternate_greetings: [], world_book_ids: ['bk'], image_id: 'img', extensions: {}, updated_at: 5 });
    host.chats.push({ id: 'ch1', character_id: 'v', name: 'Night one', updated_at: 9 });
    const cards = await host.call<{ id: string; name: string }[]>('listCards');
    expect(cards.map(c => c.name)).toContain('Vesper');
    const brought = await host.call<{ session: { blocks: { type: string; name: string }[]; turns: { content: string }[]; source: { name: string } } }>('bringCard', { characterId: 'v' });
    expect(brought.session.source.name).toBe('Vesper');
    expect(brought.session.blocks.map(b => b.type)).toEqual(['Main character', 'Scenario', 'First message', 'Lore']);
    expect(brought.session.turns[0].content).toContain('Back in the shop');
    expect(await host.call<unknown[]>('listChats')).toEqual([{ id: 'ch1', name: 'Night one', updatedAt: 9 }]);
    const rp = await host.call<{ count: number; words: number }>('setRoleplay', { on: true, chatId: 'ch1' });
    expect(rp.count).toBe(2);
    await host.call('send', { text: 'She forgives me way too fast.' });
    const prompt = (host.requests.at(-1) as { messages: { content: string }[] }).messages[0].content;
    expect(prompt).toContain('Fixing mode');
    expect(prompt).toContain('Vesper: Already forgiven!');
    // Save in place: only what changed, entry edited where it lives, new piece in a Paige lorebook.
    const saved = await host.call<{ updated: boolean; changes: string[]; name: string }>('makeCard', { asCopy: false });
    expect(saved).toMatchObject({ updated: true, name: 'Vesper' });
    const v = host.characters.get('v')!;
    expect(v.description).toBe('Vesper is a smuggler. She holds grudges for days.');
    expect(v.scenario).toBe('Fog.');
    expect(host.entries.get('e1')).toMatchObject({ content: 'A loud tavern.', key: ['Rusty Gear', 'tavern'], position: 2 });
    expect((v.world_book_ids as string[]).length).toBe(2);
    expect([...host.entries.values()].some(e => e.comment === 'Side character · Ash')).toBe(true);
    // Saving again with no changes changes nothing.
    const again = await host.call<{ changes: string[] }>('makeCard', { asCopy: false });
    expect(again.changes).toEqual([]);
    // A copy leaves the original alone and gets its own lorebook.
    await host.call('send', { text: 'make a copy' });
    const copy = await host.call<{ copy: boolean; name: string; notes: string[] }>('makeCard', { asCopy: true, name: '' });
    expect(copy).toMatchObject({ copy: true, name: 'Vesper (fixed)' });
    expect(copy.notes.join(' ')).toContain('no picture');
    const made = [...host.characters.values()].find(c => c.name === 'Vesper (fixed)')!;
    expect((made.world_book_ids as string[]).length).toBe(1);
    const copied = [...host.entries.values()].filter(e => e.bookId === (made.world_book_ids as string[])[0]);
    expect(copied.map(e => e.comment).sort()).toEqual(['Rusty Gear', 'Side character · Ash']);
    expect(copied.find(e => e.comment === 'Rusty Gear')).toMatchObject({ position: 2, depth: 4 });
    expect(host.characters.get('v')!.name).toBe('Vesper');
  });

  test('reading the roleplay without the permissions says which to grant', async () => {
    const host = fakeHost(['hi'], true, ['chat_mutation']);
    await host.call('saveSettings', { connectionId: 'c1', thinking: 'light' });
    host.characters.set('v', { id: 'v', name: 'Vesper', description: 'x', scenario: '', personality: '', mes_example: '', system_prompt: '', post_history_instructions: '', first_mes: '', alternate_greetings: [], world_book_ids: [], extensions: {}, updated_at: 1 });
    host.chats.push({ id: 'ch1', character_id: 'v', name: 'Night one', updated_at: 9 });
    await host.call('bringCard', { characterId: 'v' });
    await expect(host.call('setRoleplay', { on: true, chatId: 'ch1' })).rejects.toThrow('chat_mutation');
  });
});
