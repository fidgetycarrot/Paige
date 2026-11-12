// Runs the real panel and the real backend in one browser page against a pretend Lumiverse, for screenshots.
import { setupBackend } from '../src/backend';
import { setup } from '../src/frontend';

const replies = [
  `*Paige squints at the clipboard, then nods.* "Okay. A disgraced harbor pilot who still knows every rock in the bay. That I can work with."

"Locking the basics in."

\`\`\`
Main character
Name: Jory Kett
## Identity
Full name: Jory Kett
Aliases: JK, the Pilot
Age: 38
Race: human
Occupation: smuggler's pilot
Goal: Pay off the Tide Debt before the Harbor Guild takes his boat.
## Appearance & vibe
Height: 6'2"
Hair: black, shaved at the sides, salt-stiff
Eyes: grey, always squinting at the waterline
Usual clothes: oilskin coat, rope-burned gloves
\`\`\`

"Next up: Current status. Where is he right now, and how does he feel about it? Example: **Docked illegally at Pier Nine, pretending the Guild hasn't noticed.**"`,
  `*Paige taps the pen against her teeth.* "Pier Nine. Good. That's a place with teeth: the Guild can walk down that dock any morning it likes."

"Here's what I've got so far, so you can see the shape of him:"

- He's broke, and the boat is the only thing he owns outright.
- The Guild knows he's there. They're waiting for him to slip.
- He sleeps aboard, because a room in town costs coin he doesn't have.

"Now the fun part. **Backstory.** Only the events that explain who he is *now*. I don't want a résumé. I want the night it went wrong."

"Example, tuned to your guy: **He ran the Hesk Narrows in fog to save a Guild cutter, and the Guild stripped his license for 'reckless piloting' the next week.** That's a grudge with a date on it."

"So. What happened to Jory? One or two events. The kind he still thinks about at three in the morning."

*She slides a fresh mug of tea across the table and waits.*`,
];
const store = new Map<string, unknown>();
let listener: (payload: unknown, userId?: string, session?: string) => void = () => {};
const panelHandlers: ((m: unknown) => void)[] = [];
let n = 0; let castStart = 0;
const api = {
  permissions: { has: () => true },
  onFrontendMessage: (fn: typeof listener) => { listener = fn; return () => {}; },
  sendToFrontend: (m: unknown) => { const copy = structuredClone(m); setTimeout(() => panelHandlers.forEach(h => h(copy)), 0); },
  userStorage: {
    getJson: async (path: string, o: { fallback: unknown }) => store.has(path) ? structuredClone(store.get(path)) : o.fallback,
    setJson: async (path: string, value: unknown) => { store.set(path, structuredClone(value)); },
  },
  presets: {
    list: async () => ({ data: [{ id: 'p1', name: 'Marinara' }, { id: 'p2', name: 'Celia 4.1' }], total: 2 }),
    get: async (id: string) => ({ id, name: id === 'p1' ? 'Marinara' : 'Celia 4.1', updated_at: 1, prompt_order: [{ name: 'Style', content: 'Third person limited. Never reveal {{char}}’s inner thoughts.', enabled: true, marker: null }] }),
    blocks: { list: async () => [] },
  },
  connections: { list: async () => [{ id: 'c1', name: 'DeepSeek', provider: 'openrouter', model: 'deepseek-v4-pro', is_default: true, preset_id: 'p1' }], get: async () => ({ id: 'c1', name: 'DeepSeek', provider: 'openrouter', model: 'deepseek-v4-pro' }) },
  generate: {
    raw: async () => { await new Promise(r => setTimeout(r, 300)); return { content: '{"pov": "3rd-limited", "quote": "Third person limited. Never reveal {{char}}’s inner thoughts."}' }; },
    rawStream: async function* () {
      const text = replies.shift() ?? '"Got it."';
      for (const part of text.match(/[\s\S]{1,30}/g)!) { await new Promise(r => setTimeout(r, 5)); yield { type: 'token', token: part }; }
      yield { type: 'done', content: text, finish_reason: 'stop' };
    },
  },
  characters: {
    list: async () => ({ data: [
      { id: 'v', name: 'Vesper Vance', updated_at: Date.now() / 1000 - 3600, extensions: { paige: {} } },
      { id: 'm', name: 'Maren', updated_at: Date.now() / 1000 - 86400 * 3, extensions: {} },
      { id: 'g', name: 'Guild RPG', updated_at: Date.now() / 1000 - 86400 * 9, extensions: {} },
    ], total: 3 }),
    get: async (id: string) => id === 'v' ? { id: 'v', name: 'Vesper Vance', description: 'Name: Vesper Vance\n## Identity\nFull name: Vesper Vance\nAge: 31\nOccupation: smuggler captain\n## Psychology & behavioral triggers\n- When someone apologizes, she forgives them on the spot.', scenario: '## Setting\nLocation: Port Hesk\nGenre: low fantasy', personality: '', mes_example: '', system_prompt: '', post_history_instructions: '', first_mes: '*Fog rolls in over Pier Nine.*', alternate_greetings: [], world_book_ids: ['bk'], extensions: { paige: {} }, updated_at: 1 } : null,
    create: async (i: object) => ({ ...i, id: `c${++n}` }), update: async (id: string, i: object) => ({ id, name: 'Vesper Vance', ...i }),
  },
  world_books: { get: async () => null, create: async (i: object) => ({ ...i, id: `b${++n}` }), entries: {
    list: async (book: string) => ({ data: book === 'bk' ? [
      { id: 'e1', world_book_id: 'bk', key: ['Inquisitor', 'Valeria'], comment: 'Side character · Inquisitor Valeria Helveta', content: '[Side character]\nName: Inquisitor Valeria Helveta\n## Look\nSilver armor, a burn scar.', constant: false, disabled: false, extensions: { paige: {} } },
      { id: 'e2', world_book_id: 'bk', key: ['Rusty Gear'], comment: 'Rusty Gear', content: 'A tavern on the docks.', constant: false, disabled: false, extensions: {} },
    ] : [], total: 2 }),
    create: async () => ({}), get: async () => ({ constant: false }), update: async () => ({}) } },
  chats: { list: async () => ({ data: [{ id: 'ch1', character_id: 'v', name: 'The Pier Nine job', updated_at: Date.now() / 1000 - 600 }, { id: 'ch2', character_id: 'v', name: 'First try', updated_at: Date.now() / 1000 - 86400 * 2 }], total: 2 }), get: async (id: string) => ({ id, character_id: 'v', name: id === 'ch1' ? 'The Pier Nine job' : 'First try' }) },
  chat: { getMessages: async () => Array.from({ length: 30 }, (_, i) => ({ name: i % 2 ? 'Vesper Vance' : 'Jason', is_user: i % 2 === 0, role: i % 2 ? 'assistant' : 'user', content: i % 2 ? 'She sighs and waves it off. "Forget it. We\'re good."' : 'I\'m sorry I sold you out to the Guild.' })) },
  personas: { get: async () => null, create: async (i: object) => ({ ...i, id: `p${++n}` }) },
  rpcPool: { sync: () => 'paige.cast', read: async (e: string) => {
    if (e === 'lumicast.paige.start') { castStart = Date.now(); return { ok: true }; }
    // A pretend LumiCast run: Jory works, Wes hits a rate limit and fails, Mara's name is taken.
    const t = (Date.now() - castStart) / 1000, sid = JSON.parse(String(store.get('session.json') ? JSON.stringify(store.get('session.json')) : '{}')).id;
    const names = ['Jory Kett', 'Mara Venn', 'Wes'];
    const finished = [{ name: 'Jory Kett', ok: true, message: 'added' }, { name: 'Mara Venn', ok: true, message: 'saved as “Mara Venn 2” because Lumi Studio already had a Mara Venn; give one of them a new name there' }, { name: 'Wes', ok: false, message: 'LumiCast model request failed during trait extraction (openrouter / anthropic/claude-opus-5.5; RATE_LIMIT; HTTP 429). Wait before retrying or check the provider quota.' }];
    const done = Math.min(3, Math.floor(t / 2));
    return { sessionId: sid, names, total: 3, done, running: done < 3, current: names[done], stage: done === 2 ? 'The provider says to slow down. Trying again in 20 seconds…' : 'Step 2 of 3: checking 14 tags on Danbooru…', startedAt: castStart, updatedAt: Date.now(), finished: finished.slice(0, done) };
  } },
};
store.set('settings.json', { connectionId: 'c1', thinking: 'light' });
setupBackend(api as never);
const root = document.getElementById('root')!;
const ctx = {
  sendToBackend: (m: unknown) => { const copy = structuredClone(m); setTimeout(() => listener(copy, "u1", "s1"), 0); },
  onBackendMessage: (h: (m: unknown) => void) => { panelHandlers.push(h); return () => {}; },
  ui: { registerDrawerTab: () => ({ root, destroy() {}, onActivate: () => () => {} }), mountApp: () => { throw new Error('PERMISSION_DENIED:app_manipulation'); },
    // Built the way Lumiverse's loader builds ctx.ui.showModal (frontend/src/lib/spindle/loader.ts).
    showModal: (o: { title: string; width?: number; maxHeight?: number; persistent?: boolean }) => {
      const root = document.createElement('div'), backdrop = document.createElement('div'), container = document.createElement('div'), header = document.createElement('div'), body = document.createElement('div');
      Object.assign(backdrop.style, { position: 'fixed', inset: '0', zIndex: '10003', background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' });
      Object.assign(container.style, { width: `${Math.min(o.width ?? 420, innerWidth - 40)}px`, maxHeight: `${Math.min(o.maxHeight ?? 520, innerHeight - 40)}px`, background: '#17131d', borderRadius: '12px', border: '1px solid #333', display: 'flex', flexDirection: 'column', overflow: 'hidden' });
      Object.assign(header.style, { padding: '12px 16px', borderBottom: '1px solid #333' }); header.textContent = o.title;
      Object.assign(body.style, { padding: '16px', overflowY: 'auto', flex: '1' }); body.append(root);
      container.append(header, body); backdrop.append(container); document.body.append(backdrop);
      const handlers = new Set<() => void>(); let gone = false;
      return { root, modalId: 'm', dismiss() { if (gone) return; gone = true; backdrop.remove(); handlers.forEach(h => h()); }, setTitle() {}, onDismiss(h: () => void) { handlers.add(h); return () => handlers.delete(h); } };
    } },
  dom: { addStyle: (css: string) => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); return () => s.remove(); } },
};
setup(ctx as never);
(window as unknown as { paigeSend: (t: string) => void }).paigeSend = (t: string) => {
  const box = root.querySelector('textarea')!; box.value = t; (root.querySelector('.pg-primary') as HTMLButtonElement).click();
};
