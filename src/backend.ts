import type { SpindleAPI, GenerationRequestDTO } from 'lumiverse-spindle-types';
import { BLOCK_TYPES, looksFrom, parseBlocks, planCard, upsertBlocks, type Block, type BlockType, type Mode } from './blocks';
import { buildMessages, fixGreeting, greeting, roleplayText } from './prompt';
import { cardToBlocks, planFix, type CardIn, type CardSource, type EntryIn } from './fix';
import { generationError, ModelRequestError } from './errors';
import { record, text, THINKING, type CardListItem, type CardResult, type CastStatus, type ChatListItem, type Session, type Settings, type Snapshot, type Thinking, type Turn } from './contracts';

const DEFAULTS: Settings = { connectionId: '', thinking: 'light' };
// A light think keeps Paige quick; off and inherit are the user's choice.
const REASONING = { light: { source: 'custom', apiReasoning: true, effort: 'low' }, off: { source: 'off' }, inherit: undefined } as const;
const SESSION = 'session.json', SETTINGS = 'settings.json';
const MAX_TURNS = 600;

/** Fixing a whole card takes more thought than building one section, so Light thinking steps up to Medium there. */
export const thinkingFor = (session: Session, level: Thinking) => session.source && level === 'light' ? { source: 'custom', apiReasoning: true, effort: 'medium' } as const : REASONING[level];

export function freshSession(mode: Mode): Session {
  return { version: 1, id: crypto.randomUUID(), mode, startedAt: Date.now(), turns: [{ role: 'assistant', content: greeting(mode), at: Date.now() }], blocks: [] };
}

/** Loose check of a saved session, so a damaged file can't break the panel. */
function readSession(value: unknown): Session | null {
  const v = record(value);
  if (v.version !== 1 || typeof v.id !== 'string' || !Array.isArray(v.turns) || !Array.isArray(v.blocks)) return null;
  const turns: Turn[] = v.turns.filter(t => record(t).role === 'user' || record(t).role === 'assistant').map(t => {
    const r = record(t);
    return { role: r.role as Turn['role'], content: String(r.content ?? ''), at: Number(r.at) || 0, ...(Array.isArray(r.saved) ? { saved: r.saved.map(String).slice(0, 40) } : {}) };
  });
  const blocks: Block[] = v.blocks.map(b => record(b)).filter(b => typeof b.id === 'string' && (BLOCK_TYPES as readonly string[]).includes(String(b.type))).map(b => ({
    id: String(b.id), type: b.type as BlockType, name: String(b.name ?? ''), body: String(b.body ?? ''), updatedAt: Number(b.updatedAt) || 0,
    ...(b.type === 'First message' ? { keep: b.keep !== false } : {}), ...(b.edited ? { edited: true } : {}),
    ...(typeof b.origin === 'string' ? { origin: b.origin } : {}),
    ...(Object.keys(record(b.source)).length ? { source: (({ field, entryId, bookId, foreign }) => ({
      ...(typeof field === 'string' ? { field: field as never } : {}), ...(typeof entryId === 'string' ? { entryId } : {}), ...(typeof bookId === 'string' ? { bookId } : {}), ...(foreign === true ? { foreign: true } : {}),
    }))(record(b.source)) } : {}),
  }));
  const src = record(v.source), rp = record(v.roleplay);
  const strings = (x: unknown) => Array.isArray(x) ? x.filter((y): y is string => typeof y === 'string') : [];
  const card = record(v.card);
  return {
    version: 1, id: v.id, mode: v.mode === 'quick' ? 'quick' : 'full', startedAt: Number(v.startedAt) || Date.now(), turns: turns.length ? turns : freshSession('full').turns, blocks,
    ...(Array.isArray(v.undo) ? { undo: readSession({ version: 1, id: 'x', turns: [], blocks: v.undo })!.blocks } : {}),
    ...(typeof src.characterId === 'string' ? { source: { characterId: src.characterId, name: String(src.name ?? ''), bookIds: strings(src.bookIds), entryIds: strings(src.entryIds), greetings: strings(src.greetings), skipped: Number(src.skipped) || 0, broughtAt: Number(src.broughtAt) || 0, ...(typeof src.paigeBookId === 'string' ? { paigeBookId: src.paigeBookId } : {}) } } : {}),
    ...(typeof rp.chatId === 'string' ? { roleplay: { on: rp.on === true, chatId: rp.chatId, chatName: String(rp.chatName ?? '') } } : {}),
    ...(typeof card.characterId === 'string' ? { card: { characterId: card.characterId, worldBookId: String(card.worldBookId ?? ''), personaId: typeof card.personaId === 'string' ? card.personaId : undefined, name: String(card.name ?? ''), savedAt: Number(card.savedAt) || 0 } } : {}),
  };
}

export function setupBackend(api: SpindleAPI) {
  type State = { settings?: Settings; session?: Session; load?: Promise<void>; job?: AbortController; saving?: Promise<void> };
  const users = new Map<string, State>();
  let closed = false;

  const off = api.onFrontendMessage((payload, userId, frontendSessionId) => {
    const r = record(payload);
    if (closed || r.type !== 'paige:request' || typeof r.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(r.id)) return;
    const key = userId ?? 'owner';
    let s = users.get(key);
    if (!s) { s = {}; users.set(key, s); }
    const state = s;
    const send = (message: Record<string, unknown>) => { try { if (!closed) api.sendToFrontend(message, userId, frontendSessionId ? { frontendSessionId } : undefined); } catch { /* panel closed */ } };
    // Every open panel for this user hears about a changed session, so a phone and a laptop stay in step.
    const broadcast = () => { try { if (!closed && state.session) api.sendToFrontend({ type: 'paige:session', session: state.session, busy: !!state.job }, userId); } catch { /* ignore */ } };
    const reply = (result?: unknown, error?: string) => send({ type: 'paige:response', id: r.id, result, error });

    void (async () => {
      state.load ??= (async () => {
        const saved = record(await api.userStorage.getJson(SETTINGS, { fallback: { ...DEFAULTS }, userId }).catch(() => ({})));
        state.settings = { connectionId: typeof saved.connectionId === 'string' ? saved.connectionId.slice(0, 100) : '', thinking: THINKING.includes(saved.thinking as Thinking) ? saved.thinking as Thinking : 'light' };
        const session = await api.userStorage.getJson(SESSION, { fallback: null, userId }).catch(() => null);
        state.session = readSession(session) ?? freshSession('full');
      })();
      await state.load;
      const settings = state.settings!;
      const session = () => state.session!;
      const persist = async () => {
        const run = (state.saving ?? Promise.resolve()).then(() => api.userStorage.setJson(SESSION, state.session, { userId }));
        state.saving = run.catch(() => {});
        await run;
      };
      const input = record(r.input);

      if (r.action === 'snapshot') {
        const connections = await api.connections.list(userId).catch(() => []);
        return {
          settings, session: session(), busy: !!state.job,
          connections: connections.map(c => ({ id: c.id, name: c.name, provider: c.provider, model: c.model })),
          permissions: { generation: api.permissions.has('generation'), characters: api.permissions.has('characters'), world_books: api.permissions.has('world_books'), personas: api.permissions.has('personas'), chats: api.permissions.has('chats'), chat_mutation: api.permissions.has('chat_mutation') },
        } satisfies Snapshot;
      }
      if (r.action === 'stop') { state.job?.abort(); return true; }
      if (r.action === 'saveSettings') {
        const connectionId = text(input.connectionId ?? '', 'connection', 100);
        if (connectionId && !await api.connections.get(connectionId, userId)) throw new Error('That connection is gone. Pick another one.');
        state.settings = { connectionId, thinking: THINKING.includes(input.thinking as Thinking) ? input.thinking as Thinking : settings.thinking };
        await api.userStorage.setJson(SETTINGS, state.settings, { userId });
        return state.settings;
      }
      if (r.action === 'exportSession') {
        // Everything needed to pick up where you left off: the chat, the notebook, the mode and which card it made.
        return { kind: 'paige-backup', version: 1, savedAt: Date.now(), session: session() };
      }
      if (state.job && r.action !== 'lumicastStatus') throw new Error('Paige is still writing. Wait for her, or press Stop.');

      if (r.action === 'setMode') {
        session().mode = input.mode === 'quick' ? 'quick' : 'full';
        await persist(); broadcast();
        return session();
      }
      if (r.action === 'importSession') {
        let backup = record(input.backup);
        // Paige's own saved file (session.json) works too, as it is.
        if (!('kind' in backup) && backup.version === 1 && Array.isArray(backup.turns) && Array.isArray(backup.blocks)) backup = { kind: 'paige-backup', version: 1, session: backup };
        if (backup.kind !== 'paige-backup') throw new Error('That file isn\'t a Paige backup.');
        if (backup.version !== 1) throw new Error('That backup is from a newer Paige. Update Paige, then load it again.');
        const restored = readSession(backup.session);
        if (!restored) throw new Error('That backup is damaged, so nothing was loaded.');
        // What was open is kept, the same way Start over keeps it.
        if (session().turns.length > 1 || session().blocks.length) {
          try { await api.userStorage.setJson(`old/${session().id}.json`, session(), { userId }); } catch { /* best effort */ }
        }
        delete restored.undo;
        state.session = restored;
        await persist(); broadcast();
        return session();
      }
      if (r.action === 'startOver') {
        // The old session is kept, in case it was started over by mistake.
        try { await api.userStorage.setJson(`old/${session().id}.json`, session(), { userId }); } catch { /* best effort */ }
        state.session = freshSession(input.mode === 'quick' ? 'quick' : 'full');
        await persist(); broadcast();
        return session();
      }
      if (r.action === 'editBlock') {
        const block = session().blocks.find(b => b.id === input.id);
        if (!block) throw new Error('That piece is no longer in the notebook.');
        const body = text(input.body, 'piece text (maximum 40,000 characters)', 40_000);
        if (!body) throw new Error('A piece can\'t be empty. Use Delete instead.');
        block.body = body; block.edited = true; block.updatedAt = Date.now();
        if (typeof input.name === 'string' && input.name.trim()) block.name = text(input.name, 'name', 120);
        await persist(); broadcast();
        return session();
      }
      if (r.action === 'deleteBlock') {
        session().blocks = session().blocks.filter(b => b.id !== input.id);
        await persist(); broadcast();
        return session();
      }
      if (r.action === 'keepFirst') {
        const block = session().blocks.find(b => b.id === input.id && b.type === 'First message');
        if (block) block.keep = input.keep === true;
        await persist(); broadcast();
        return session();
      }

      if (r.action === 'listCards') {
        if (!api.permissions.has('characters')) throw new Error('Grant Paige the characters permission in Extensions.');
        const cards: CardListItem[] = [];
        for (let offset = 0; offset < 5000; offset += 200) {
          const page = await api.characters.list({ offset, limit: 200, userId });
          for (const c of page.data) cards.push({ id: c.id, name: c.name, updatedAt: c.updated_at, paige: !!record(c.extensions).paige });
          if (page.data.length < 200) break;
        }
        return cards.sort((a, b) => b.updatedAt - a.updatedAt);
      }
      if (r.action === 'bringCard') {
        for (const permission of ['characters', 'world_books']) if (!api.permissions.has(permission)) throw new Error(`Grant Paige the ${permission} permission in Extensions to bring a card in.`);
        const characterId = text(input.characterId, 'card', 100);
        const card = await api.characters.get(characterId, userId);
        if (!card) throw new Error('That card isn’t in Lumiverse anymore.');
        const { blocks, source } = await readCard(card as unknown as CardIn);
        // What was open is kept, the same way Start over keeps it.
        if (session().turns.length > 1 || session().blocks.length) {
          try { await api.userStorage.setJson(`old/${session().id}.json`, session(), { userId }); } catch { /* best effort */ }
        }
        const fresh = freshSession(session().mode);
        fresh.turns = [{ role: 'assistant', content: fixGreeting(card.name, blocks.length), at: Date.now() }];
        fresh.blocks = blocks; fresh.source = source;
        state.session = fresh;
        await persist(); broadcast();
        return { session: fresh, skipped: source.skipped };
      }
      if (r.action === 'listChats') {
        const current = session();
        if (!current.source) throw new Error('Bring a card to Paige first.');
        if (!api.permissions.has('chats')) throw new Error('Grant Paige the chats permission in Extensions so she can see this card’s chats.');
        const page = await api.chats.list({ characterId: current.source.characterId, limit: 50, userId });
        return page.data.sort((a, b) => b.updated_at - a.updated_at).map(c => ({ id: c.id, name: c.name || 'Untitled chat', updatedAt: c.updated_at })) satisfies ChatListItem[];
      }
      if (r.action === 'setRoleplay') {
        const current = session();
        if (!current.source) throw new Error('Bring a card to Paige first.');
        const on = input.on === true;
        const chatId = text(input.chatId ?? '', 'chat', 100);
        if (on) {
          if (!chatId) throw new Error('Pick which chat Paige should read.');
          const chat = await api.chats.get(chatId, userId);
          if (!chat || chat.character_id !== current.source.characterId) throw new Error('That chat isn’t one of this card’s chats.');
          current.roleplay = { on: true, chatId, chatName: chat.name || 'Untitled chat' };
          const preview = await readRoleplay(current);
          await persist(); broadcast();
          return { session: current, words: preview.words, count: preview.count };
        }
        if (current.roleplay) current.roleplay.on = false;
        await persist(); broadcast();
        return { session: current, words: 0, count: 0 };
      }

      if (r.action === 'send' || r.action === 'retry') {
        if (!api.permissions.has('generation')) throw new Error('Grant Paige the generation permission in Extensions.');
        if (!settings.connectionId) throw new Error('Pick a model connection for Paige under Settings first.');
        const connection = await api.connections.get(settings.connectionId, userId);
        if (!connection) throw new Error('Paige\'s model connection is gone. Pick another one under Settings.');
        const current = session();
        if (r.action === 'send') {
          const message = text(input.text, 'message (maximum 20,000 characters)', 20_000);
          if (!message) throw new Error('Type something first.');
          if (current.turns.length >= MAX_TURNS) throw new Error('This session is very long. Make the card, then use Start over for the next one.');
          current.turns.push({ role: 'user', content: message, at: Date.now() });
          current.undo = current.blocks.map(b => ({ ...b }));
        } else {
          // A retry takes back Paige's last reply and whatever it put on the Sheet.
          const last = current.turns[current.turns.length - 1];
          if (last?.role === 'assistant' && current.turns.length > 1) current.turns.pop();
          if (current.turns[current.turns.length - 1]?.role !== 'user') throw new Error('There is nothing to retry yet.');
          if (current.undo) current.blocks = current.undo.map(b => ({ ...b }));
          else current.undo = current.blocks.map(b => ({ ...b }));
        }
        await persist(); broadcast();
        const controller = new AbortController();
        state.job = controller;
        const timer = setTimeout(() => controller.abort(), 300_000);
        let written = '';
        try {
          const request: GenerationRequestDTO & { provider: string; model: string } = {
            type: 'raw', connection_id: connection.id, provider: connection.provider, model: connection.model, userId,
            messages: buildMessages({ mode: current.mode, blocks: current.blocks, turns: current.turns, fixing: current.source?.name, roleplay: current.roleplay?.on ? (await readRoleplay(current)).text : undefined }),
            parameters: { max_tokens: 8000 }, ...(thinkingFor(current, settings.thinking) ? { reasoning: { ...thinkingFor(current, settings.thinking)! } } : {}), signal: controller.signal,
          };
          let reasoning = '', finish = '';
          try {
            if (typeof api.generate.rawStream === 'function') {
              let lastSend = 0;
              for await (const chunk of api.generate.rawStream(request)) {
                if (chunk.type === 'token') {
                  written += chunk.token;
                  // Batched so a fast model doesn't flood the panel.
                  if (Date.now() - lastSend > 80) { lastSend = Date.now(); send({ type: 'paige:stream', id: r.id, text: written }); }
                } else if (chunk.type === 'reasoning') reasoning += chunk.token;
                else if (chunk.type === 'done') { written = chunk.content || written; reasoning = chunk.reasoning || reasoning; finish = chunk.finish_reason; }
              }
            } else {
              const value = record(await api.generate.raw(request));
              written = typeof value.content === 'string' ? value.content : '';
              reasoning = typeof value.reasoning === 'string' ? value.reasoning : '';
              finish = String(value.finish_reason ?? '');
            }
          } catch (error) {
            if (controller.signal.aborted && written.trim()) finish = 'stopped';
            else { if (controller.signal.aborted) throw Object.assign(new Error('Stopped.'), { name: 'AbortError' }); throw generationError(error, connection.provider, connection.model); }
          }
          if (!written.trim()) throw new ModelRequestError(reasoning ? 'The model only thought and never answered. Set Thinking to Off or Light under Settings, or try again.' : `The model sent back an empty reply (finish reason: ${finish || 'none given'}). Try again, or pick another connection.`);
          const parsed = parseBlocks(written);
          const outcome = upsertBlocks(current.blocks, parsed);
          current.blocks = outcome.sheet;
          const saved = [...outcome.added.map(b => `Added ${b.type.toLowerCase()}: ${b.name}`), ...outcome.replaced.map(b => `Updated ${b.type.toLowerCase()}: ${b.name}`)];
          current.turns.push({ role: 'assistant', content: written.trim(), at: Date.now(), ...(saved.length ? { saved } : {}) });
          await persist();
          return { session: current, stopped: finish === 'stopped', cutOff: /length|max_tokens/i.test(finish) };
        } finally {
          clearTimeout(timer);
          state.job = undefined;
          broadcast();
        }
      }

      if (r.action === 'makeCard') {
        for (const permission of ['characters', 'world_books']) if (!api.permissions.has(permission)) throw new Error(`Grant Paige the ${permission} permission in Extensions to make the card.`);
        const current = session();
        if (current.source) return await saveFixes(current, input.asCopy === true, typeof input.name === 'string' ? input.name : '', input.sendLooks === true);
        if (!current.blocks.some(b => b.type !== 'First message')) throw new Error('The notebook is empty. Build something with Paige first.');
        const plan = planCard(current.blocks, { name: typeof input.name === 'string' ? input.name : '' });
        if (plan.persona && !api.permissions.has('personas')) throw new Error('Grant Paige the personas permission in Extensions to make your persona, or delete the persona from the notebook.');
        const mark = { paige: { sessionId: current.id } };
        // The card from this session, if it's still there, gets updated instead of made twice.
        const old = current.card ? await api.characters.get(current.card.characterId, userId).catch(() => null) : null;
        let book = old && current.card?.worldBookId && old.world_book_ids?.includes(current.card.worldBookId) ? await api.world_books.get(current.card.worldBookId, userId).catch(() => null) : null;
        if (!book) book = await api.world_books.create({ name: `${plan.card.name} · Paige`.slice(0, 100), description: 'Characters and lore built with Paige.', metadata: mark }, userId);
        else {
          await api.world_books.update(book.id, { name: `${plan.card.name} · Paige`.slice(0, 100) }, userId).catch(() => {});
          // Paige's own entries are rebuilt; anything added by hand stays.
          for (let offset = 0, guard = 0; guard < 50; guard++) {
            const page = await api.world_books.entries.list(book.id, { offset, limit: 200, userId });
            const ours = page.data.filter(e => record(e.extensions).paige);
            for (const entry of ours) await api.world_books.entries.delete(entry.id, userId);
            offset += page.data.length - ours.length;
            if (page.data.length < 200) break;
          }
        }
        for (const [index, entry] of plan.entries.entries()) {
          await api.world_books.entries.create(book.id, { key: entry.key, comment: entry.comment, content: entry.content, constant: entry.constant, selective: false, disabled: false, case_sensitive: false, match_whole_words: true, order_value: 100 + index, extensions: { paige: { sessionId: current.id } } }, userId);
        }
        const fields = { ...plan.card, world_book_ids: [...new Set([...(old?.world_book_ids ?? []), book.id])] };
        const character = old ? await api.characters.update(old.id, fields, userId) : await api.characters.create({ ...fields, extensions: mark }, userId);
        let personaId: string | undefined, personaName = '', personaNote = '';
        if (plan.persona) {
          const existing = current.card?.personaId ? await api.personas.get(current.card.personaId, userId).catch(() => null) : null;
          const persona = existing ? await api.personas.update(existing.id, plan.persona, userId) : await api.personas.create({ ...plan.persona, metadata: mark }, userId);
          personaId = persona.id; personaName = persona.name;
        } else if (current.card?.personaId) personaNote = 'The persona from last time was left alone in Lumiverse.';
        current.card = { characterId: character.id, worldBookId: book.id, personaId, name: character.name, savedAt: Date.now() };
        await persist(); broadcast();
        let cast: CastStatus | null = null;
        if (input.sendLooks === true) cast = await sendLooks(current, plan.card.name);
        return { updated: !!old, name: character.name, entries: plan.entries.length, greetings: (plan.card.first_mes ? 1 : 0) + plan.card.alternate_greetings.length, personaName, personaNote, notes: plan.notes, cast, session: current } satisfies CardResult;
      }

      if (r.action === 'sendLooks') return await sendLooks(session(), session().card?.name ?? '', Array.isArray(input.only) ? input.only.filter((n): n is string => typeof n === 'string').slice(0, 40) : undefined);
      if (r.action === 'lumicastStatus') {
        const pool = (api as unknown as { rpcPool?: { read?: (e: string) => Promise<unknown> } }).rpcPool;
        if (typeof pool?.read !== 'function') return null;
        try {
          const status = record(await pool.read('lumicast.paige.status'));
          return status.sessionId === session().id ? status : null;
        } catch { return null; }
      }
      throw new Error('Unknown Paige action.');

      /** Shares everyone's looks, then asks LumiCast to turn them into Lumi Studio characters. LumiCast does the rest in the background. */
      /** only: send just these names (Choose who to send lets you pick), so the ones already in Lumi Studio aren't copied. */
      async function sendLooks(current: Session, cardName: string, only?: string[]): Promise<CastStatus> {
        const wanted = only && new Set(only.map(n => n.trim().toLowerCase()));
        const looks = looksFrom(current.blocks).filter(l => !wanted || wanted.has(l.name.trim().toLowerCase()));
        if (wanted && !looks.length) return { state: 'skipped', message: 'Pick at least one person to send.' };
        if (!looks.length) return { state: 'skipped', message: 'No one in the notebook has a look section, so nothing went to LumiCast.' };
        const pool = (api as unknown as { rpcPool?: { sync?: (e: string, v: unknown, p?: { requires?: string[] }) => string; read?: (e: string) => Promise<unknown> } }).rpcPool;
        if (typeof pool?.sync !== 'function' || typeof pool.read !== 'function') return { state: 'failed', message: 'This Lumiverse version can\'t share data between extensions.' };
        pool.sync('cast', { version: 1, sessionId: current.id, sentAt: Date.now(), userId: userId ?? '', card: cardName, characters: looks }, { requires: [] });
        try {
          const answer = record(await pool.read('lumicast.paige.start'));
          if (answer.ok !== true) return { state: 'failed', message: typeof answer.message === 'string' ? answer.message.slice(0, 300) : 'LumiCast didn\'t take them.' };
          return { state: 'started', message: `LumiCast is working on ${looks.length} ${looks.length === 1 ? 'look' : 'looks'}: ${looks.map(l => l.name).join(', ')}. They land in Lumi Studio as they finish.` };
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          if (/not registered|unknown endpoint|not found/i.test(message)) return { state: 'failed', message: 'LumiCast isn\'t installed, or it\'s too old to take characters from Paige. Install or update LumiCast, then press Choose who to send.' };
          return { state: 'failed', message: `LumiCast didn't take them: ${message.replace(/^.*?:\s*(?=[A-Z])/, '').slice(0, 240) || 'no reason given'}` };
        }
      }
      /** A card and its lorebooks as notebook pieces. */
      async function readCard(card: CardIn): Promise<{ blocks: Block[]; source: CardSource }> {
        const entries: EntryIn[] = [];
        for (const bookId of card.world_book_ids ?? []) {
          for (let offset = 0; offset < 5000; offset += 200) {
            const page = await api.world_books.entries.list(bookId, { offset, limit: 200, userId }).catch(() => null);
            if (!page) break;
            for (const e of page.data) entries.push({ id: e.id, world_book_id: e.world_book_id, key: e.key ?? [], content: e.content ?? '', comment: e.comment ?? '', constant: !!e.constant, disabled: !!e.disabled, extensions: record(e.extensions) });
            if (page.data.length < 200) break;
          }
        }
        return cardToBlocks(card, entries);
      }

      /** The end of the chosen chat, read fresh each time so Paige sees the latest. */
      async function readRoleplay(current: Session): Promise<{ text: string; count: number; words: number }> {
        const rp = current.roleplay;
        if (!rp?.on) return { text: '', count: 0, words: 0 };
        for (const permission of ['chats', 'chat_mutation']) if (!api.permissions.has(permission)) throw new Error(`Grant Paige the ${permission} permission in Extensions so she can read the roleplay, or switch Read the roleplay off. She only reads with it.`);
        let messages: { name: string; is_user: boolean; content: string; role?: string }[];
        try { messages = await api.chat.getMessages(rp.chatId); }
        catch { throw new Error('Paige couldn’t read that chat. Pick another one, or switch Read the roleplay off.'); }
        const result = roleplayText(rp.chatName, messages.filter(m => m.role !== 'system').map(m => ({ name: m.name, isUser: m.is_user, content: m.content ?? '' })));
        return { ...result, words: result.text.split(/\s+/).length };
      }

      /** Saves the notebook's changes back to the card it came from, or to a new copy of it. */
      async function saveFixes(current: Session, asCopy: boolean, copyName: string, looks: boolean): Promise<CardResult> {
        const source = current.source!;
        const plan = planFix(current.blocks, source);
        if (plan.persona && !api.permissions.has('personas')) throw new Error('Grant Paige the personas permission in Extensions to make your persona, or delete the persona from the notebook.');
        const original = await api.characters.get(source.characterId, userId);
        if (!original) throw new Error('That card isn’t in Lumiverse anymore. Tick “Save as a copy” to save the fixes as a new card.');
        const mark = { sessionId: current.id };
        const notes = [...plan.notes];
        const newEntry = (e: { comment: string; key: string[]; content: string; constant: boolean }, i: number) =>
          ({ key: e.key, comment: e.comment, content: e.content, constant: e.constant, selective: false, disabled: false, case_sensitive: false, match_whole_words: true, order_value: 100 + i, extensions: { paige: mark } });
        let target = original;
        if (!asCopy) {
          for (const u of plan.updates) {
            const before = await api.world_books.entries.get(u.entryId, userId).catch(() => null);
            if (!before) { notes.push(`The lorebook entry “${u.plan.comment}” was gone, so it was added again.`); plan.create.push(u.plan); continue; }
            await api.world_books.entries.update(u.entryId, { content: u.plan.content, key: u.plan.key, comment: u.plan.comment, ...(before.constant !== u.plan.constant ? { constant: u.plan.constant } : {}) }, userId);
          }
          for (const entryId of plan.disable) await api.world_books.entries.update(entryId, { disabled: true }, userId).catch(() => {});
          let bookIds = [...original.world_book_ids];
          if (plan.create.length) {
            let bookId = source.paigeBookId && bookIds.includes(source.paigeBookId) ? source.paigeBookId : '';
            if (!bookId) { bookId = (await api.world_books.create({ name: `${original.name} · Paige`.slice(0, 100), description: 'Pieces added with Paige.', metadata: { paige: mark } }, userId)).id; bookIds = [...bookIds, bookId]; }
            for (const [i, e] of plan.create.entries()) await api.world_books.entries.create(bookId, newEntry(e, i), userId);
          }
          target = await api.characters.update(original.id, { ...plan.patch, ...(bookIds.length !== original.world_book_ids.length ? { world_book_ids: bookIds } : {}) }, userId);
        } else {
          // The copy gets its own lorebook with every entry the card had (fixed ones fixed, switched-off ones left out), so the original stays exactly as it was.
          const name = copyName.trim() || `${original.name} (fixed)`;
          const book = await api.world_books.create({ name: `${name} · Paige`.slice(0, 100), description: `A copy of ${original.name}'s lorebook, with Paige's fixes.`, metadata: { paige: mark } }, userId);
          const fixes = new Map(plan.updates.map(u => [u.entryId, u.plan])), gone = new Set(plan.disable);
          let order = 0;
          for (const bookId of original.world_book_ids) {
            for (let offset = 0; offset < 5000; offset += 200) {
              const page = await api.world_books.entries.list(bookId, { offset, limit: 200, userId }).catch(() => null);
              if (!page) break;
              for (const e of page.data) {
                if (gone.has(e.id)) continue;
                const { id: _id, world_book_id: _book, uid: _uid, created_at: _c, updated_at: _u, vectorized: _v, ...rest } = e;
                const fix = fixes.get(e.id);
                await api.world_books.entries.create(book.id, { ...rest, ...(fix ? { content: fix.content, key: fix.key, comment: fix.comment, constant: fix.constant } : {}), order_value: rest.order_value ?? order++ } as never, userId);
              }
              if (page.data.length < 200) break;
            }
          }
          for (const [i, e] of plan.create.entries()) await api.world_books.entries.create(book.id, newEntry(e, 1000 + i), userId);
          const { id: _id, image_id: _img, created_at: _c, updated_at: _u, world_book_ids: _b, extensions, ...fields } = original;
          target = await api.characters.create({ ...fields, ...plan.patch, name, world_book_ids: [book.id], extensions: { ...(extensions ?? {}), paige: mark } }, userId);
          if (original.image_id) notes.push('The copy has no picture yet. Add one in Lumiverse if you like.');
        }
        let personaId = current.card?.personaId, personaName = '';
        if (plan.persona) {
          const existing = personaId ? await api.personas.get(personaId, userId).catch(() => null) : null;
          const persona = existing ? await api.personas.update(existing.id, plan.persona, userId) : await api.personas.create({ ...plan.persona, metadata: { paige: mark } }, userId);
          personaId = persona.id; personaName = persona.name;
        }
        // The notebook now matches the saved card, so the next changes are measured from here.
        const fresh = await api.characters.get(target.id, userId);
        if (fresh) {
          const keep = current.blocks.filter(b => b.type === 'Persona' || (b.type === 'First message' && b.keep === false));
          const again = await readCard(fresh as unknown as CardIn);
          current.blocks = [...again.blocks, ...keep];
          current.source = again.source;
        }
        if (asCopy && current.roleplay) current.roleplay.on = false;
        current.card = { characterId: target.id, worldBookId: current.source?.paigeBookId ?? '', personaId, name: target.name, savedAt: Date.now() };
        await persist(); broadcast();
        let cast: CastStatus | null = null;
        if (looks) cast = await sendLooks(current, target.name);
        return { copy: asCopy, changes: plan.summary, updated: !asCopy, name: target.name, entries: plan.updates.length + plan.create.length, greetings: plan.patch.first_mes !== undefined ? (plan.patch.first_mes ? 1 : 0) + (plan.patch.alternate_greetings?.length ?? 0) : 0, personaName, personaNote: '', notes, cast, session: current };
      }
    })().then(result => reply(result)).catch(error => {
      if (error instanceof Error && error.name === 'AbortError') return reply(undefined, 'Stopped.');
      // Provider errors can carry URLs or keys; only Paige's own messages go to the panel.
      const message = error instanceof Error ? error.message : '';
      const trusted = error instanceof ModelRequestError || /^(Grant Paige|Pick |Paige|That |There |The |This |Type |A piece|Invalid |Unknown Paige|Bring a card)/.test(message);
      reply(undefined, trusted ? message : 'Something went wrong. Your session is saved; try again.');
    });
  });
  return () => { closed = true; off(); for (const s of users.values()) s.job?.abort(); users.clear(); };
}

declare const spindle: SpindleAPI;
if (typeof spindle !== 'undefined') setupBackend(spindle);
