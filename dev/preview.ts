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
let n = 0;
const api = {
  permissions: { has: () => true },
  onFrontendMessage: (fn: typeof listener) => { listener = fn; return () => {}; },
  sendToFrontend: (m: unknown) => { const copy = structuredClone(m); setTimeout(() => panelHandlers.forEach(h => h(copy)), 0); },
  userStorage: {
    getJson: async (path: string, o: { fallback: unknown }) => store.has(path) ? structuredClone(store.get(path)) : o.fallback,
    setJson: async (path: string, value: unknown) => { store.set(path, structuredClone(value)); },
  },
  connections: { list: async () => [{ id: 'c1', name: 'DeepSeek', provider: 'openrouter', model: 'deepseek-v4-pro' }], get: async () => ({ id: 'c1', name: 'DeepSeek', provider: 'openrouter', model: 'deepseek-v4-pro' }) },
  generate: {
    rawStream: async function* () {
      const text = replies.shift() ?? '"Got it."';
      for (const part of text.match(/[\s\S]{1,30}/g)!) { await new Promise(r => setTimeout(r, 5)); yield { type: 'token', token: part }; }
      yield { type: 'done', content: text, finish_reason: 'stop' };
    },
  },
  characters: { get: async () => null, create: async (i: object) => ({ ...i, id: `c${++n}` }), update: async () => ({}) },
  world_books: { get: async () => null, create: async (i: object) => ({ ...i, id: `b${++n}` }), entries: { list: async () => ({ data: [], total: 0 }), create: async () => ({}) } },
  personas: { get: async () => null, create: async (i: object) => ({ ...i, id: `p${++n}` }) },
  rpcPool: { sync: () => 'paige.cast', read: async (e: string) => { if (e === 'lumicast.paige.start') return { ok: true }; return { sessionId: 'x' }; } },
};
store.set('settings.json', { connectionId: 'c1', thinking: 'light' });
setupBackend(api as never);
const root = document.getElementById('root')!;
const ctx = {
  sendToBackend: (m: unknown) => { const copy = structuredClone(m); setTimeout(() => listener(copy, "u1", "s1"), 0); },
  onBackendMessage: (h: (m: unknown) => void) => { panelHandlers.push(h); return () => {}; },
  ui: { registerDrawerTab: () => ({ root, destroy() {}, onActivate: () => () => {} }), mountApp: (o: { className?: string }) => { const r = document.createElement('div'); if (o.className) r.className = o.className; r.hidden = true; document.body.append(r); return { root: r, mountId: 'm1', setVisible: (v: boolean) => { r.hidden = !v; }, destroy: () => r.remove() }; } },
  dom: { addStyle: (css: string) => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); return () => s.remove(); } },
};
setup(ctx as never);
(window as unknown as { paigeSend: (t: string) => void }).paigeSend = (t: string) => {
  const box = root.querySelector('textarea')!; box.value = t; (root.querySelector('.pg-primary') as HTMLButtonElement).click();
};
