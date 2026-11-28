import type { SpindleAPI, GenerationRequestDTO } from 'lumiverse-spindle-types';
import { BLOCK_TYPES, lookHash, looksFrom, lookStatus, parseBlocks, planCard, rememberLines, unfinishedPiece, upsertBlocks, type Block, type BlockType, type Mode } from './blocks';
import { buildMessages, fixGreeting, greeting, roleplayText } from './prompt';
import { cardToBlocks, planFix, type CardIn, type CardSource, type EntryIn } from './fix';
import { generationError, ModelRequestError } from './errors';
import { promptCleaner } from './prompt';
import { dryRunText, type DryRunIn } from './dryrun';
import { REACH_BUDGET, REACHES, type Reach } from './contracts';
import { ABOUT_MAX, PICTURE_MAX_BYTES, PICTURE_MIMES, record, type PictureMime, text, THINKING, type CardListItem, type CardResult, type CastStatus, type ChatListItem, type Session, type Settings, type Snapshot, type Thinking, type Turn } from './contracts';
import { uuid } from './safe-id';
import { DETECT_SYSTEM, FALLBACK_POV, parseDetection, perspectiveRule, POV_NAMES, POV_SETTINGS, POVS, presetText, type Pov, type PovSetting } from './perspective';

const DEFAULTS: Settings = { connectionId: '', thinking: 'light', perspective: 'preset', presetId: '', aboutMe: '' };
const aboutMeIn = (v: string) => {
  const note = v.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (note.length > ABOUT_MAX) throw new Error(`The note is too long. Keep it under ${ABOUT_MAX} characters.`);
  return text(note, 'note', ABOUT_MAX);
};
const sameLine = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === b.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// A light think keeps Paige quick; off and inherit are the user's choice.
const REASONING = { light: { source: 'custom', apiReasoning: true, effort: 'low' }, off: { source: 'off' }, inherit: undefined } as const;
const SESSION = 'session.json', SETTINGS = 'settings.json';
const MAX_TURNS = 600;
const PICTURE_ID = /^[a-z0-9-]{8,64}$/i;
const pictureExt = (mime: PictureMime) => mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
const picturePath = (p: { id: string; mime: PictureMime }) => `pictures/${p.id}.${pictureExt(p.mime)}`;
function fromBase64(data: string): Uint8Array {
  const raw = atob(data);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
function toBase64(bytes: Uint8Array): string {
  let raw = '';
  for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(raw);
}

/** Fixing a whole card takes more thought than building one section, so Light thinking steps up to Medium there. */
export const thinkingFor = (session: Session, level: Thinking) => session.source && level === 'light' ? { source: 'custom', apiReasoning: true, effort: 'medium' } as const : REASONING[level];

export function freshSession(mode: Mode): Session {
  return { version: 1, id: uuid(), mode, startedAt: Date.now(), turns: [{ role: 'assistant', content: greeting(mode), at: Date.now() }], blocks: [] };
}

/** Loose check of a saved session, so a damaged file can't break the panel. */
function readSession(value: unknown): Session | null {
  const v = record(value);
  if (v.version !== 1 || typeof v.id !== 'string' || !Array.isArray(v.turns) || !Array.isArray(v.blocks)) return null;
  const cutOf = (v: unknown): Pick<Turn, 'cut'> => {
    const c = record(v);
    if (!['length', 'stopped', 'unfinished'].includes(String(c.why))) return {};
    return { cut: { why: c.why as NonNullable<Turn['cut']>['why'], finish: String(c.finish ?? '').slice(0, 60), ...(typeof c.lost === 'string' ? { lost: c.lost.slice(0, 120) } : {}) } };
  };
  const rememberOf = (v: unknown): Pick<Turn, 'remember'> => {
    if (!Array.isArray(v)) return {};
    const list = v.map(record).filter(x => typeof x.text === 'string' && x.text).slice(0, 3)
      .map(x => ({ text: String(x.text).slice(0, 240), state: (['open', 'added', 'skipped'].includes(String(x.state)) ? x.state : 'open') as 'open' | 'added' | 'skipped' }));
    return list.length ? { remember: list } : {};
  };
  const dryRunOf = (v: unknown): Pick<Turn, 'dryRun'> => {
    const d = record(v);
    return typeof d.id === 'string' && PICTURE_ID.test(d.id) ? { dryRun: { id: d.id, tokens: Number(d.tokens) || 0, chatName: String(d.chatName ?? '').slice(0, 200) } } : {};
  };
  const pictureOf = (v: unknown): Pick<Turn, 'picture'> => {
    const p = record(v);
    return typeof p.id === 'string' && PICTURE_ID.test(p.id) && PICTURE_MIMES.includes(p.mime as PictureMime) ? { picture: { id: p.id, mime: p.mime as PictureMime } } : {};
  };
  const turns: Turn[] = v.turns.filter(t => record(t).role === 'user' || record(t).role === 'assistant').map(t => {
    const r = record(t);
    return { role: r.role as Turn['role'], content: String(r.content ?? ''), at: Number(r.at) || 0, ...(Array.isArray(r.saved) ? { saved: r.saved.map(String).slice(0, 40) } : {}), ...cutOf(r.cut), ...rememberOf(r.remember), ...pictureOf(r.picture), ...dryRunOf(r.dryRun) };
  });
  const blocks: Block[] = v.blocks.map(b => record(b)).filter(b => typeof b.id === 'string' && (BLOCK_TYPES as readonly string[]).includes(String(b.type))).map(b => ({
    id: String(b.id), type: b.type as BlockType, name: String(b.name ?? ''), body: String(b.body ?? ''), updatedAt: Number(b.updatedAt) || 0,
    ...(b.type === 'First message' ? { keep: b.keep !== false } : {}), ...(b.edited ? { edited: true } : {}),
    ...(typeof b.origin === 'string' ? { origin: b.origin } : {}),
    ...(Object.keys(record(b.source)).length ? { source: (({ field, entryId, bookId, foreign }) => ({
      ...(typeof field === 'string' ? { field: field as never } : {}), ...(typeof entryId === 'string' ? { entryId } : {}), ...(typeof bookId === 'string' ? { bookId } : {}), ...(foreign === true ? { foreign: true } : {}),
    }))(record(b.source)) } : {}),
  }));
  const src = record(v.source), rp = record(v.roleplay), sentLooks = Object.fromEntries(Object.entries(record(v.sentLooks)).filter(([k, h]) => typeof h === 'string' && /^[0-9a-f]{8}$/.test(h) && k.length <= 120).slice(0, 300)) as Record<string, string>;
  const strings = (x: unknown) => Array.isArray(x) ? x.filter((y): y is string => typeof y === 'string') : [];
  const card = record(v.card);
  return {
    version: 1, id: v.id, mode: v.mode === 'quick' ? 'quick' : 'full', startedAt: Number(v.startedAt) || Date.now(), turns: turns.length ? turns : freshSession('full').turns, blocks,
    ...(Array.isArray(v.undo) ? { undo: readSession({ version: 1, id: 'x', turns: [], blocks: v.undo })!.blocks } : {}),
    ...(Object.keys(sentLooks).length ? { sentLooks } : {}),
    ...(typeof src.characterId === 'string' ? { source: { characterId: src.characterId, name: String(src.name ?? ''), bookIds: strings(src.bookIds), entryIds: strings(src.entryIds), greetings: strings(src.greetings), skipped: Number(src.skipped) || 0, broughtAt: Number(src.broughtAt) || 0, ...(typeof src.paigeBookId === 'string' ? { paigeBookId: src.paigeBookId } : {}), ...(typeof src.castEntryId === 'string' ? { castEntryId: src.castEntryId, cast: String(src.cast ?? '') } : {}) } } : {}),
    ...(typeof rp.chatId === 'string' ? { roleplay: { on: rp.on === true, chatId: rp.chatId, chatName: String(rp.chatName ?? ''), ...(REACHES.includes(rp.reach as Reach) ? { reach: rp.reach as Reach } : {}) } } : {}),
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
        const found = record(saved.detected);
        state.settings = {
          connectionId: typeof saved.connectionId === 'string' ? saved.connectionId.slice(0, 100) : '', thinking: THINKING.includes(saved.thinking as Thinking) ? saved.thinking as Thinking : 'light',
          perspective: POV_SETTINGS.includes(saved.perspective as PovSetting) ? saved.perspective as PovSetting : 'preset',
          presetId: typeof saved.presetId === 'string' ? saved.presetId.slice(0, 100) : '',
          aboutMe: typeof saved.aboutMe === 'string' ? saved.aboutMe.slice(0, ABOUT_MAX) : '',
          ...(typeof found.presetId === 'string' ? { detected: { presetId: found.presetId, presetName: String(found.presetName ?? ''), presetUpdatedAt: Number(found.presetUpdatedAt) || 0, pov: POVS.includes(found.pov as Pov) ? found.pov as Pov : null, quote: String(found.quote ?? '').slice(0, 200) } } : {}),
        };
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
        const canPresets = api.permissions.has('presets');
        const presets = canPresets ? await Promise.resolve().then(() => api.presets.list({ limit: 200, userId })).then(r => r.data.map(p => ({ id: p.id, name: p.name })), () => []) : [];
        const fallback = connections.find(c => c.is_default)?.preset_id;
        return {
          settings, session: session(), busy: !!state.job, presets,
          defaultPreset: fallback ? { id: fallback, name: presets.find(p => p.id === fallback)?.name ?? '' } : null,
          connections: connections.map(c => ({ id: c.id, name: c.name, provider: c.provider, model: c.model })),
          permissions: { generation: api.permissions.has('generation'), characters: api.permissions.has('characters'), world_books: api.permissions.has('world_books'), personas: api.permissions.has('personas'), chats: api.permissions.has('chats'), chat_mutation: api.permissions.has('chat_mutation'), presets: canPresets },
        } satisfies Snapshot;
      }
      if (r.action === 'stop') { state.job?.abort(); return true; }
      if (r.action === 'saveSettings') {
        const connectionId = text(input.connectionId ?? '', 'connection', 100);
        if (connectionId && !await api.connections.get(connectionId, userId)) throw new Error('That connection is gone. Pick another one.');
        state.settings = {
          ...settings, connectionId, thinking: THINKING.includes(input.thinking as Thinking) ? input.thinking as Thinking : settings.thinking,
          perspective: POV_SETTINGS.includes(input.perspective as PovSetting) ? input.perspective as PovSetting : settings.perspective,
          presetId: typeof input.presetId === 'string' ? text(input.presetId, 'preset', 100) : settings.presetId,
          aboutMe: typeof input.aboutMe === 'string' ? aboutMeIn(input.aboutMe) : settings.aboutMe,
        };
        await api.userStorage.setJson(SETTINGS, state.settings, { userId });
        // Read the preset now, so the panel can show what Paige found.
        if (state.settings.perspective === 'preset' && connectionId) await perspectiveFor(true).catch(() => {});
        return state.settings;
      }
      if (r.action === 'picture') {
        // A picture from this chat, for the panel to show.
        const turn = session().turns.find(t => t.picture?.id === input.id);
        if (!turn?.picture) throw new Error('That picture is gone.');
        const bytes = await api.userStorage.readBinary(picturePath(turn.picture), userId).catch(() => null);
        if (!bytes) throw new Error('That picture is gone.');
        return { mime: turn.picture.mime, data: toBase64(bytes) };
      }
      if (r.action === 'remember') {
        // Add or skip a line Paige suggested for the about-me note.
        const session = state.session!;
        const turn = session.turns.find(t => t.at === Number(input.at) && t.role === 'assistant');
        const line = turn?.remember?.[Number(input.index)];
        if (!turn || !line) throw new Error('That suggestion is gone.');
        if (line.state === 'open') {
          if (input.add === true) {
            const next = settings.aboutMe.trim() ? `${settings.aboutMe.trim()}\n- ${line.text}` : `- ${line.text}`;
            if (next.length > ABOUT_MAX) throw new Error('Your note is full. Make room in Settings first.');
            state.settings = { ...settings, aboutMe: next };
            await api.userStorage.setJson(SETTINGS, state.settings, { userId });
          }
          line.state = input.add === true ? 'added' : 'skipped';
          await persist(); broadcast();
        }
        return { settings: state.settings, session };
      }
      if (r.action === 'checkPreset') {
        await perspectiveFor(true);
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
          const reach: Reach = REACHES.includes(input.reach as Reach) ? input.reach as Reach : current.roleplay?.reach ?? 'recent';
          current.roleplay = { on: true, chatId, chatName: chat.name || 'Untitled chat', reach };
          const preview = await readRoleplay(current);
          await persist(); broadcast();
          return { session: current, words: preview.words, count: preview.count, cleaned: preview.cleaned };
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
          const message = text(input.text ?? '', 'message (maximum 20,000 characters)', 20_000);
          const sent = record(input.picture);
          let picture: Turn['picture'];
          if (input.picture !== undefined) {
            const mime = sent.mime as PictureMime;
            if (!PICTURE_MIMES.includes(mime) || typeof sent.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(sent.data)) throw new Error('That picture couldn’t be read. Try a JPEG, PNG or WebP.');
            const bytes = fromBase64(sent.data);
            if (bytes.length > PICTURE_MAX_BYTES) throw new Error('That picture is too big. Try a smaller one.');
            picture = { id: uuid(), mime };
            await api.userStorage.writeBinary(picturePath(picture), bytes, userId);
          }
          let dryRun: Turn['dryRun'];
          if (input.dryRun === true) {
            // The full prompt the main model gets for the roleplay chat, built without calling the model.
            const rp = current.roleplay;
            if (!current.source || !rp?.chatId) throw new Error('Bring a card back and switch on “Let Paige read the roleplay” first, so Paige knows which chat to look at.');
            const run = await api.generate.dryRun({ chatId: rp.chatId }, userId).catch((e: unknown) => { throw new Error(`Lumiverse couldn’t build the prompt for that chat: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown error'}`); });
            const report = dryRunText(run as unknown as DryRunIn, rp.chatName);
            dryRun = { id: uuid(), tokens: report.tokens, chatName: rp.chatName };
            await api.userStorage.setJson(`dryruns/${dryRun.id}.json`, { text: report.text, at: Date.now() }, { userId });
          }
          if (!message && !picture && !dryRun) throw new Error('Type something first.');
          if (current.turns.length >= MAX_TURNS) throw new Error('This session is very long. Make the card, then use Start over for the next one.');
          current.turns.push({ role: 'user', content: message, at: Date.now(), ...(picture ? { picture } : {}), ...(dryRun ? { dryRun } : {}) });
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
            messages: buildMessages({ mode: current.mode, blocks: current.blocks, turns: await withPicture(current.turns), perspective: await perspectiveFor(false).catch(() => perspectiveRule(FALLBACK_POV, 'default')), fixing: current.source?.name, roleplay: current.roleplay?.on ? (await readRoleplay(current)).text : undefined, aboutMe: settings.aboutMe }),
            parameters: { max_tokens: 16000 }, ...(thinkingFor(current, settings.thinking) ? { reasoning: { ...thinkingFor(current, settings.thinking)! } } : {}), signal: controller.signal,
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
            else { if (controller.signal.aborted) throw Object.assign(new Error('Stopped.'), { name: 'AbortError' }); throw generationError(error, connection.provider, connection.model, !!lastPicture(current.turns)); }
          }
          if (!written.trim()) throw new ModelRequestError(reasoning ? 'The model only thought and never answered. Set Thinking to Off or Light under Settings, or try again.' : `The model sent back an empty reply (finish reason: ${finish || 'none given'}). Try again, or pick another connection.`);
          const parsed = parseBlocks(written);
          const outcome = upsertBlocks(current.blocks, parsed);
          current.blocks = outcome.sheet;
          const saved = [...outcome.added.map(b => `Added ${b.type.toLowerCase()}: ${b.name}`), ...outcome.replaced.map(b => `Updated ${b.type.toLowerCase()}: ${b.name}`)];
          const lost = unfinishedPiece(written);
          const why = finish === 'stopped' ? 'stopped' : /length|max_tokens/i.test(finish) ? 'length' : lost ? 'unfinished' : null;
          const cut = why ? { why, finish: finish || 'none given', ...(lost ? { lost } : {}) } as const : undefined;
          const known = state.settings!.aboutMe.split('\n').map(l => l.replace(/^[-*•]\s*/, ''));
          const remember = rememberLines(written).filter(l => !known.some(k => sameLine(k, l))).slice(0, 1).map(text => ({ text, state: 'open' as const }));
          current.turns.push({ role: 'assistant', content: written.trim(), at: Date.now(), ...(saved.length ? { saved } : {}), ...(cut ? { cut } : {}), ...(remember.length ? { remember } : {}) });
          await persist();
          return { session: current, stopped: why === 'stopped', cutOff: why === 'length' || why === 'unfinished' };
        } finally {
          clearTimeout(timer);
          state.job = undefined;
          broadcast();
        }
      }

      if (r.action === 'makeCard') {
        for (const permission of ['characters', 'world_books']) if (!api.permissions.has(permission)) throw new Error(`Grant Paige the ${permission} permission in Extensions to make the card.`);
        const current = session();
        if (current.source) return await saveFixes(current, input.asCopy === true, typeof input.name === 'string' ? input.name : '', input.sendLooks === true, input.sendChanged === true);
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
        const pictureNote = await setCardPicture(character.id, input.pictureId);
        current.card = { characterId: character.id, worldBookId: book.id, personaId, name: character.name, savedAt: Date.now() };
        await persist(); broadcast();
        let cast: CastStatus | null = null;
        if (input.sendLooks === true) cast = await sendNewLooks(current, plan.card.name, input.sendChanged === true);
        return { updated: !!old, name: character.name, entries: plan.entries.length, greetings: (plan.card.first_mes ? 1 : 0) + plan.card.alternate_greetings.length, personaName, personaNote, notes: [...plan.notes, ...pictureNote], cast, session: current } satisfies CardResult;
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

      /** Pictures go to the model only with the newest message you sent; earlier ones are marked as already seen. */
      function lastPicture(turns: Turn[]): Turn['picture'] {
        for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === 'user') return turns[i].picture;
        return undefined;
      }
      async function withPicture(turns: Turn[]) {
        const newest = lastPicture(turns);
        const data = newest ? await api.userStorage.readBinary(picturePath(newest), userId).then(toBase64).catch(() => null) : null;
        // What the model sees, like a picture: only with the newest message you sent.
        const lastUser = [...turns].reverse().find(t => t.role === 'user');
        const report = lastUser?.dryRun ? await api.userStorage.getJson<{ text?: string }>(`dryruns/${lastUser.dryRun.id}.json`, { fallback: {}, userId }).then(v => v.text ?? null).catch(() => null) : null;
        return turns.map(t => ({
          role: t.role, content: t.content,
          ...(t.picture ? { picture: t.picture === newest && data ? { data, mime: t.picture.mime } : 'seen' as const } : {}),
          ...(t.dryRun ? { dryRun: t === lastUser && report ? report : 'seen' as const } : {}),
        }));
      }

      /** Makes one of your pictures the card's picture, if you picked one. Returns a note if it didn't work. */
      async function setCardPicture(characterId: string, pictureId: unknown): Promise<string[]> {
        if (typeof pictureId !== 'string' || !pictureId) return [];
        const turn = session().turns.find(t => t.picture?.id === pictureId);
        try {
          if (!turn?.picture) throw new Error('gone');
          const bytes = await api.userStorage.readBinary(picturePath(turn.picture), userId);
          await api.characters.setAvatar(characterId, { data: bytes, mime_type: turn.picture.mime, filename: `paige.${pictureExt(turn.picture.mime)}` }, userId);
          return [];
        } catch { return ['The card’s picture couldn’t be set. Add it in Lumiverse if you like.']; }
      }

      /** New looks always; changed ones only when asked, since LumiCast makes a second profile rather than touch one you may have tweaked. */
      async function sendNewLooks(current: Session, cardName: string, withChanged: boolean, status = lookStatus(current.blocks, current.sentLooks)): Promise<CastStatus> {
        const { added, changed } = status;
        const names = [...added, ...(withChanged ? changed : [])];
        if (names.length) return await sendLooks(current, cardName, names);
        return { state: 'skipped', message: changed.length ? `No new looks, so nothing went to LumiCast. ${changed.join(', ')} changed; tick “Also re-send changed looks” if you want new profiles for them.` : 'No looks are new or changed, so nothing went to LumiCast.' };
      }

      /** Shares everyone's looks, then asks LumiCast to turn them into Lumi Studio characters. LumiCast does the rest in the background. */
      /** only: send just these names (Choose who to send lets you pick), so the ones already in Lumi Studio aren't copied. */
      async function sendLooks(current: Session, cardName: string, only?: string[]): Promise<CastStatus> {
        const wanted = only && new Set(only.map(n => n.trim().toLowerCase()));
        const looks = looksFrom(current.blocks).filter(l => !wanted || wanted.has(l.name.trim().toLowerCase()));
        if (wanted && !looks.length) return { state: 'skipped', message: 'Pick at least one person to send.' };
        if (!looks.length) return { state: 'skipped', message: 'No one in the notebook has a look section, so nothing went to LumiCast.' };
        const pool = (api as unknown as { rpcPool?: { sync?: (e: string, v: unknown, p?: { requires?: string[] }) => string; read?: (e: string) => Promise<unknown> } }).rpcPool;
        if (typeof pool?.sync !== 'function' || typeof pool.read !== 'function') return { state: 'failed', message: 'This Lumiverse version can\'t share data between extensions.' };
        // Which story each person belongs to, so Lumi Studio files them under the card (its Library groups faces by story).
        const cardId = current.card?.characterId ?? '';
        const story = { ...(cardId ? { cardId } : {}), cardName };
        pool.sync('cast', { version: 1, sessionId: current.id, sentAt: Date.now(), userId: userId ?? '', card: cardName, story, characters: looks.map(l => ({ ...l, story: { ...story, ...(l.role ? { role: l.role } : {}) } })) }, { requires: [] });
        try {
          const answer = record(await pool.read('lumicast.paige.start'));
          if (answer.ok !== true) return { state: 'failed', message: typeof answer.message === 'string' ? answer.message.slice(0, 300) : 'LumiCast didn\'t take them.' };
          // Remember what LumiCast got, so the same look isn't sent again and made into a second profile.
          current.sentLooks = { ...current.sentLooks, ...Object.fromEntries(looks.map(l => [l.name.toLowerCase(), lookHash(l)])) };
          await persist();
          return { state: 'started', message: `LumiCast is working on ${looks.length} ${looks.length === 1 ? 'look' : 'looks'}: ${looks.map(l => l.name).join(', ')}. They land in Lumi Studio as they finish.` };
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          if (/not registered|unknown endpoint|not found/i.test(message)) return { state: 'failed', message: 'LumiCast isn\'t installed, or it\'s too old to take characters from Paige. Install or update LumiCast, then press Choose who to send.' };
          return { state: 'failed', message: `LumiCast didn't take them: ${message.replace(/^.*?:\s*(?=[A-Z])/, '').slice(0, 240) || 'no reason given'}` };
        }
      }
      /**
       * The first-message perspective rule. With "match my preset", the preset is read by the model once and
       * remembered until the preset is changed; if it can't be read or doesn't say, third person limited is used.
       */
      async function perspectiveFor(force: boolean): Promise<string> {
        const current = state.settings!;
        if (current.perspective !== 'preset') return perspectiveRule(current.perspective, 'set in Paige’s settings');
        if (!api.permissions.has('presets')) return perspectiveRule(FALLBACK_POV, 'default, because Paige can’t read presets');
        let presetId = current.presetId;
        if (!presetId) presetId = (await api.connections.list(userId).catch(() => [])).find(c => c.is_default)?.preset_id ?? '';
        if (!presetId) return perspectiveRule(FALLBACK_POV, 'default, because no main chat preset is picked');
        const preset = await Promise.resolve().then(() => api.presets.get(presetId, userId)).catch(() => null);
        if (!preset) return perspectiveRule(FALLBACK_POV, 'default, because the main chat preset is gone');
        const seen = current.detected;
        if (force || !seen || seen.presetId !== preset.id || seen.presetUpdatedAt !== preset.updated_at) {
          const connection = current.connectionId ? await api.connections.get(current.connectionId, userId) : null;
          if (!connection) return perspectiveRule(FALLBACK_POV, 'default');
          const blocks = preset.prompt_order?.length ? preset.prompt_order : await api.presets.blocks.list(preset.id, userId).catch(() => []);
          const body = presetText(blocks);
          let found: { pov: Pov | null; quote: string } = { pov: null, quote: '' };
          if (body) {
            const request: GenerationRequestDTO & { provider: string; model: string } = {
              type: 'raw', connection_id: connection.id, provider: connection.provider, model: connection.model, userId,
              messages: [{ role: 'system', content: DETECT_SYSTEM }, { role: 'user', content: `Preset "${preset.name}":\n\n${body}` }],
              parameters: { max_tokens: 2000 }, reasoning: { source: 'off' },
            };
            try { const value = record(await api.generate.raw(request)); found = parseDetection(String(value.content ?? '')); }
            catch (error) { throw generationError(error, connection.provider, connection.model); }
          }
          current.detected = { presetId: preset.id, presetName: preset.name, presetUpdatedAt: preset.updated_at, ...found };
          await api.userStorage.setJson(SETTINGS, current, { userId });
        }
        const pov = current.detected!.pov;
        return pov ? perspectiveRule(pov, `matches the main chat preset "${preset.name}"`) : perspectiveRule(FALLBACK_POV, `default, because "${preset.name}" doesn't say`);
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
      async function readRoleplay(current: Session): Promise<{ text: string; count: number; words: number; cleaned: number | null }> {
        const rp = current.roleplay;
        if (!rp?.on) return { text: '', count: 0, words: 0, cleaned: null };
        for (const permission of ['chats', 'chat_mutation']) if (!api.permissions.has(permission)) throw new Error(`Grant Paige the ${permission} permission in Extensions so she can read the roleplay, or switch Read the roleplay off. She only reads with it.`);
        let messages: { name: string; is_user: boolean; content: string; role?: string }[];
        try { messages = await api.chat.getMessages(rp.chatId); }
        catch { throw new Error('Paige couldn’t read that chat. Pick another one, or switch Read the roleplay off.'); }
        // The preset's own prompt cleanup takes trackers out, the same way the main chat does.
        const scripts = api.permissions.has('regex_scripts')
          ? await Promise.resolve().then(() => api.regex_scripts.getActive({ target: 'prompt', chatId: rp.chatId, characterId: current.source?.characterId, userId })).catch(() => null)
          : null;
        const cleaner = promptCleaner(scripts ?? []);
        const result = roleplayText(rp.chatName, messages.filter(m => m.role !== 'system').map(m => ({ name: m.name, isUser: m.is_user, content: cleaner.clean(m.content ?? '', m.is_user) })), REACH_BUDGET[rp.reach ?? 'recent']);
        return { ...result, words: result.text.split(/\s+/).length, cleaned: scripts ? cleaner.count : null };
      }

      /** Saves the notebook's changes back to the card it came from, or to a new copy of it. */
      async function saveFixes(current: Session, asCopy: boolean, copyName: string, looks: boolean, sendChanged: boolean): Promise<CardResult> {
        const source = current.source!;
        const plan = planFix(current.blocks, source);
        // Worked out now: after saving, the card is read in again and everything matches it.
        const lookNow = lookStatus(current.blocks, current.sentLooks);
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
          if (original.image_id && !input.pictureId) notes.push('The copy has no picture yet. Add one in Lumiverse if you like.');
        }
        notes.push(...await setCardPicture(target.id, input.pictureId));
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
        // Only people whose look changed, or who are new, go to LumiCast; everyone else is already in Lumi Studio.
        let cast: CastStatus | null = null;
        if (looks) cast = await sendNewLooks(current, target.name, sendChanged, lookNow);
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
