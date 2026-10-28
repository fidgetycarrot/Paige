import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { BLOCK_TYPES, labelOf, looksFrom, type Block, type BlockType, type Mode } from './blocks';
import type { CardResult, CastStatus, LumiCastStatus, Session, Snapshot } from './contracts';
import { MARKER_WOFF2 } from './font';

export function createRpc(ctx: Pick<SpindleFrontendContext, 'sendToBackend' | 'onBackendMessage'>, onSession: (session: Session, busy: boolean) => void, timeout = 320_000) {
  let closed = false;
  const pending = new Map<string, { resolve(value: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout>; stream?: (text: string) => void }>();
  const off = ctx.onBackendMessage(value => {
    const r = value as { type?: string; id?: string; result?: unknown; error?: string; text?: unknown; session?: Session; busy?: boolean };
    if (r?.type === 'paige:session' && r.session) { onSession(r.session, !!r.busy); return; }
    if (r?.type === 'paige:stream' && r.id && typeof r.text === 'string') { pending.get(r.id)?.stream?.(r.text); return; }
    if (!r || r.type !== 'paige:response' || !r.id) return;
    const p = pending.get(r.id); if (!p) return;
    clearTimeout(p.timer); pending.delete(r.id);
    if (r.error) p.reject(new Error(r.error)); else p.resolve(r.result);
  });
  return {
    request<T>(action: string, input?: unknown, stream?: (text: string) => void): Promise<T> {
      if (closed) return Promise.reject(new Error('Paige is closed.'));
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Lumiverse did not answer in time. Your session is saved.')); }, timeout);
        pending.set(id, { resolve: v => resolve(v as T), reject, timer, stream });
        try { ctx.sendToBackend({ type: 'paige:request', id, action, input }); } catch (e) { clearTimeout(timer); pending.delete(id); reject(e as Error); }
      });
    },
    destroy() { closed = true; off(); for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Paige closed.')); } pending.clear(); },
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, content?: string, className?: string) {
  const n = document.createElement(tag); if (content !== undefined) n.textContent = content; if (className) n.className = className; return n;
}

/** Bold, italics, inline code and links, built as DOM nodes so nothing Paige writes is ever run as HTML. */
function inline(target: HTMLElement, line: string) {
  const parts = line.split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|https?:\/\/[^\s)<>"]+)/g);
  for (const part of parts) {
    if (!part) continue;
    if (/^\*\*[^*]+\*\*$/.test(part)) target.append(el('strong', part.slice(2, -2)));
    else if (/^\*[^*]+\*$/.test(part)) target.append(el('em', part.slice(1, -1)));
    else if (/^`[^`]+`$/.test(part)) target.append(el('code', part.slice(1, -1)));
    else if (/^https?:\/\//.test(part)) { const a = el('a', part); a.href = part; a.target = '_blank'; a.rel = 'noopener noreferrer'; target.append(a); }
    else target.append(document.createTextNode(part));
  }
}

function prose(target: HTMLElement, text: string) {
  for (const para of text.split(/\n{2,}/)) {
    const lines = para.split('\n').filter(l => l.trim());
    if (!lines.length) continue;
    if (lines.every(l => /^\s*[-*•]\s+/.test(l))) {
      const ul = el('ul');
      for (const l of lines) { const li = el('li'); inline(li, l.replace(/^\s*[-*•]\s+/, '')); ul.append(li); }
      target.append(ul); continue;
    }
    const p = el('p');
    lines.forEach((l, i) => { if (i) p.append(el('br')); inline(p, l.replace(/^#{1,4}\s+/, '')); });
    target.append(p);
  }
}

/** A piece's sheet text laid out like a filled-in form: section names, labels, answers. Built as DOM nodes. */
function sheetBody(target: HTMLElement, body: string, skipName = true) {
  const sheet = el('div', undefined, 'pg-form');
  let list: HTMLUListElement | null = null;
  for (const raw of body.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line) { list = null; continue; }
    const heading = /^#{1,4}\s+(.+)$/.exec(line);
    if (heading) { sheet.append(el('h4', heading[1].replace(/[*_]+/g, ''))); list = null; continue; }
    const bullet = /^[-*•]\s+(.+)$/.exec(line);
    if (bullet) { if (!list) { list = el('ul'); sheet.append(list); } const li = el('li'); inline(li, bullet[1]); list.append(li); continue; }
    list = null;
    const field = /^([^:]{1,40}):\s*(.*)$/.exec(line);
    if (field && !/[.!?"“]/.test(field[1])) {
      if (skipName && /^name$/i.test(field[1].trim())) continue;
      const row = el('div', undefined, 'pg-field-row'); row.append(el('span', field[1].replace(/[*_]+/g, ''), 'pg-label'));
      const value = el('span'); inline(value, field[2]); row.append(value); sheet.append(row);
      continue;
    }
    const p = el('p'); inline(p, line); sheet.append(p);
  }
  target.append(sheet);
}

/** A finished piece in the chat: an index card taped onto the page, folded shut. The full text lives in the notebook. */
function ticket(type: BlockType, body: string): HTMLElement {
  const box = el('details', undefined, 'pg-card');
  const name = type === 'Scenario' || type === 'First message' ? '' : (/^\s*[*_]*Name[*_]*\s*:\s*(.+)$/im.exec(body)?.[1] ?? '').replace(/[*_]+/g, '').trim();
  const head = el('summary');
  head.append(el('span', type, 'pg-card-type'), el('span', name || (type === 'First message' ? body.trim().split('\n')[0].slice(0, 70) : ''), 'pg-card-name'), el('span', 'in your notebook', 'pg-card-tag'));
  const inner = el('div', undefined, 'pg-inner'); sheetBody(inner, body.trim());
  box.append(head, inner);
  return box;
}

function message(target: HTMLElement, text: string) {
  const fences = /(^|\n)[ \t]*(```+|~~~+)([^\n]*)\n([\s\S]*?)(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g;
  let at = 0;
  for (const m of text.matchAll(fences)) {
    prose(target, text.slice(at, m.index! + m[1].length));
    at = m.index! + m[0].length;
    const info = m[3].trim();
    let body = m[4];
    let type = info ? labelOf(info) : null;
    if (!type) {
      const lines = body.split('\n'); const first = lines.findIndex(l => l.trim());
      type = first >= 0 ? labelOf(lines[first]) : null;
      if (type) body = lines.slice(first + 1).join('\n');
    }
    target.append(type ? ticket(type, body) : el('pre', body, 'pg-pre'));
  }
  prose(target, text.slice(at));
}

const STYLES = `
@font-face{font-family:'Paige Marker';src:url(data:font/woff2;base64,${MARKER_WOFF2}) format('woff2');font-display:swap}
.pg-app{--pg-paper:#1d1a25;--pg-desk:#14121a;--pg-rule:#a99ccc1c;--pg-margin:#ff7a9a55;--pg-ink:#ebe5f4;--pg-pencil:#a39bb5;--pg-violet:#b583ff;--pg-violet-ink:#1c1029;--pg-note:#dccbff;--pg-note-ink:#24192f;--pg-card:#272331;--pg-edge:#ffffff14;--pg-hand:'Paige Marker','Marker Felt','Bradley Hand',cursive;--pg-row:26px;--pg-m:46px;
  box-sizing:border-box;font-size:15px;line-height:var(--pg-row);color:var(--pg-ink);display:flex;flex-direction:column;height:100%;min-height:520px;max-width:820px;margin:0 auto;background:var(--pg-desk)}
.pg-app *{box-sizing:border-box}
.pg-top{display:flex;align-items:center;gap:12px;padding:14px 18px 4px}
.pg-title{font:400 34px/1 var(--pg-hand);color:var(--pg-violet);margin:0;position:relative;padding-top:8px;transform:rotate(-2deg);transform-origin:left center}
.pg-crown{position:absolute;left:-4px;top:-6px;width:22px;height:16px;transform:rotate(-14deg)}
.pg-sub{color:var(--pg-pencil);font-size:13px;line-height:1.4;margin:0}
/* Divider tabs that stick up from the top of the page. */
.pg-tabs{display:flex;gap:4px;padding:8px 14px 0;align-items:flex-end}
.pg-tabs button{background:#ffffff0a;border:1px solid var(--pg-edge);border-bottom:0;border-radius:9px 9px 0 0;color:var(--pg-pencil);padding:6px 14px 5px;font:inherit;font-size:14px;line-height:1.3;cursor:pointer}
.pg-tabs button[aria-selected=true]{background:var(--pg-paper);color:var(--pg-ink);font-weight:600;padding-bottom:8px;margin-bottom:-1px;position:relative;z-index:1}
.pg-view{flex:1;min-height:0;display:flex;flex-direction:column;background:var(--pg-paper);border-top:1px solid var(--pg-edge)}
.pg-view[hidden]{display:none!important}
/* The page: faint rules every line, and the margin line. The rules scroll with the writing. */
.pg-page{background:linear-gradient(90deg,transparent calc(var(--pg-m) - 1px),var(--pg-margin) calc(var(--pg-m) - 1px) var(--pg-m),transparent var(--pg-m)),repeating-linear-gradient(transparent 0 calc(var(--pg-row) - 1px),var(--pg-rule) calc(var(--pg-row) - 1px) var(--pg-row)),var(--pg-paper);background-attachment:local}
.pg-log{flex:1;min-height:0;overflow-y:auto;padding:var(--pg-row) 18px var(--pg-row) calc(var(--pg-m) + 14px);position:relative}
.pg-msg{margin:0 0 var(--pg-row)}
.pg-msg p{margin:0 0 var(--pg-row)}.pg-msg>p:last-child,.pg-msg>ul:last-child{margin-bottom:0}.pg-msg ul{margin:0 0 var(--pg-row);padding-left:20px}
.pg-paige em{color:var(--pg-pencil)}
.pg-paige strong{color:#fff;background:linear-gradient(transparent 58%,#b583ff40 58%)}
.pg-msg code{background:#ffffff10;border-radius:4px;padding:0 5px;font-size:.92em}
.pg-msg a{color:var(--pg-violet)}
/* Your answers: a note stuck onto the page. */
.pg-user{width:fit-content;max-width:84%;margin-left:auto;background:var(--pg-note);color:var(--pg-note-ink);padding:9px 14px 11px;line-height:1.5;border-radius:2px 2px 2px 12px;white-space:pre-wrap;overflow-wrap:anywhere;box-shadow:0 2px 0 #00000055;transform:rotate(var(--pg-tilt,.5deg))}
.pg-pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0}
.pg-pre{background:#ffffff08;border-radius:6px;padding:0 12px;margin:0 0 var(--pg-row);line-height:var(--pg-row)}
/* A finished piece: an index card taped in. */
.pg-card{position:relative;background:var(--pg-card);border-radius:4px;border-top:3px solid var(--pg-margin);margin:6px 0 var(--pg-row);box-shadow:0 1px 0 #00000066}
.pg-card::before{content:'';position:absolute;top:-10px;left:50%;width:58px;height:16px;margin-left:-29px;background:#ffffff1c;transform:rotate(-3deg);border-radius:1px}
.pg-card summary{display:flex;gap:10px;align-items:baseline;padding:10px 14px;cursor:pointer;list-style:none;flex-wrap:wrap;line-height:1.4}
.pg-card summary::-webkit-details-marker{display:none}
.pg-card-type{font:400 15px/1.3 var(--pg-hand);color:var(--pg-violet)}
.pg-card-name{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pg-card-tag{font-size:12px;color:var(--pg-pencil)}
.pg-card summary::after{content:'›';color:var(--pg-pencil);transition:transform .15s}
.pg-card[open] summary::after{transform:rotate(90deg)}
.pg-saved{font-size:12px;line-height:1.5;color:var(--pg-pencil);margin-top:6px}
.pg-working{display:flex;align-items:center;gap:8px;color:var(--pg-pencil);font:400 16px/var(--pg-row) var(--pg-hand)}
.pg-working svg{width:20px;height:20px;color:var(--pg-violet)}
/* The bottom of the page, where you write. */
.pg-compose{border-top:1px solid var(--pg-edge);padding:10px 18px max(14px,env(safe-area-inset-bottom));background:var(--pg-desk);line-height:1.4}.pg-app.pg-typing .pg-compose{padding-bottom:10px}
.pg-chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;align-items:center}
.pg-chips button{border:1px dashed #a99ccc55;background:none;color:var(--pg-ink);border-radius:6px;padding:2px 10px;font:inherit;font-size:13px;cursor:pointer}
.pg-chips button:hover:not(:disabled){border-style:solid;border-color:var(--pg-violet)}
.pg-mode{margin-left:auto;display:flex;border:1px solid var(--pg-edge);border-radius:7px;overflow:hidden;font-size:12px}
.pg-app .pg-mode button{border:0;border-radius:0;padding:3px 10px;color:var(--pg-pencil)}
.pg-app .pg-mode button[aria-pressed=true]{background:var(--pg-violet);color:var(--pg-violet-ink);font-weight:600}
.pg-row{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}
.pg-app textarea,.pg-app input[type=text],.pg-app select{width:100%;border:1px solid var(--pg-edge);border-radius:8px;background:var(--pg-paper);color:inherit;padding:10px 12px;font:inherit;line-height:1.45}
.pg-app textarea:focus,.pg-app input[type=text]:focus,.pg-app select:focus{border-color:var(--pg-violet);outline:none}
.pg-compose .pg-row{flex-wrap:nowrap}
.pg-compose textarea{resize:none;min-height:44px;max-height:180px;flex:1}
.pg-app button.pg-btn{border:1px solid var(--pg-edge);border-radius:8px;background:#ffffff0a;color:inherit;padding:9px 15px;font:inherit;line-height:1.4;cursor:pointer;white-space:nowrap}
.pg-app button.pg-primary{background:var(--pg-violet);border-color:var(--pg-violet);color:var(--pg-violet-ink);font-weight:650}
.pg-app button:disabled{opacity:.45;cursor:default}
.pg-app :focus-visible{outline:2px solid var(--pg-violet);outline-offset:2px}
.pg-status{font-size:13px;line-height:1.5;color:var(--pg-pencil);min-height:20px;margin-top:6px;white-space:pre-wrap}
.pg-status:empty{min-height:0;margin:0}
.pg-status[data-error=true]{color:#ff9db1}
.pg-scroll{flex:1;min-height:0;overflow-y:auto;padding:var(--pg-row) 18px calc(var(--pg-row) * 2) calc(var(--pg-m) + 14px);line-height:1.5}
.pg-group{margin-bottom:28px}
.pg-group h3{font:400 20px/1.2 var(--pg-hand);color:var(--pg-violet);margin:0 0 14px;transform:rotate(-1deg);transform-origin:left}
.pg-card .pg-inner{padding:0 14px 14px;border-top:1px dashed var(--pg-edge)}
.pg-form{padding:12px 0 2px;line-height:1.5}
.pg-form h4{font:400 16px/1.3 var(--pg-hand);color:var(--pg-violet);margin:16px 0 6px}.pg-form h4:first-child{margin-top:2px}
.pg-field-row{display:grid;grid-template-columns:minmax(90px,150px) 1fr;gap:12px;padding:3px 0;border-bottom:1px solid var(--pg-rule)}
.pg-label{color:var(--pg-pencil);font-size:13px;padding-top:1px}
.pg-form ul{margin:4px 0;padding-left:20px}.pg-form p{margin:6px 0}
@media (max-width:480px){.pg-field-row{grid-template-columns:1fr;gap:0}.pg-label{font-size:12px}}
.pg-card .pg-inner textarea{min-height:300px;margin-top:12px;font-size:14px;line-height:1.55}
.pg-inner>.pg-row{margin-top:12px}.pg-card label{display:flex;gap:8px;align-items:center;font-size:13px;margin-right:auto}
.pg-note{font-size:12px;line-height:1.5;color:var(--pg-pencil)}
/* Make my card: the page you tear out at the end. */
.pg-make{margin-top:34px;padding-top:22px;border-top:2px dashed #a99ccc55;position:relative}
.pg-pick{border:1px dashed var(--pg-edge);border-radius:8px;padding:4px 14px 12px;margin:12px 0}
.pg-cast{margin-top:14px;border-left:3px solid var(--pg-violet);padding:4px 0 4px 14px;line-height:1.45}
.pg-cast-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.pg-cast-clock{margin-left:auto;color:var(--pg-pencil);font-variant-numeric:tabular-nums;font-size:13px}
.pg-pulse{width:9px;height:9px;border-radius:50%;background:var(--pg-violet);flex-shrink:0}
.pg-cast-row{display:flex;gap:10px;padding:4px 0}
.pg-cast-mark{width:16px;text-align:center;flex-shrink:0}
.pg-cast-row>div{display:flex;flex-direction:column;min-width:0}
.pg-cast-name{font-weight:600}
.pg-cast-detail{font-size:13px;color:var(--pg-pencil);overflow-wrap:anywhere}
.pg-ok .pg-cast-mark{color:#8fdca2}.pg-bad .pg-cast-mark,.pg-bad .pg-cast-detail{color:#ff9db1}.pg-now .pg-cast-mark{color:var(--pg-violet)}.pg-wait{opacity:.6}
.pg-cast-warn{font-size:13px;color:#f0b866;margin:8px 0 0}
.pg-make::before{content:'✂';position:absolute;top:-15px;left:-4px;font-size:18px;color:var(--pg-pencil);background:var(--pg-paper);padding:0 6px}
.pg-make h3{font:400 24px/1.2 var(--pg-hand);color:var(--pg-violet);margin:0 0 6px;transform:rotate(-1deg);transform-origin:left}
.pg-field{display:flex;flex-direction:column;gap:6px;margin:14px 0}
.pg-field>span{font-size:13px;font-weight:600}
.pg-check{display:flex;gap:9px;align-items:flex-start;margin:14px 0;font-size:14px}
.pg-check input{margin-top:3px;accent-color:var(--pg-violet)}
.pg-empty{color:var(--pg-pencil);padding:10px 0 20px;font:400 18px/1.4 var(--pg-hand)}
.pg-app hr{border:0;border-top:1px dashed var(--pg-edge);margin:22px 0}
.pg-credit{margin-top:22px}
.pg-app [hidden]{display:none!important}
.pg-full-btn{margin-left:auto;display:flex;align-items:center;gap:6px;background:none;border:1px solid var(--pg-edge);border-radius:8px;color:var(--pg-pencil);padding:5px 10px;font:inherit;font-size:13px;line-height:1.3;cursor:pointer;flex-shrink:0}
.pg-full-btn:hover{color:var(--pg-ink);border-color:var(--pg-violet)}
.pg-full-btn svg{width:16px;height:16px}
/* Full screen: Paige over the whole window, with a comfortable reading width and a little bigger type. */
.pg-panes{flex:1;min-height:0;display:flex;flex-direction:column}
.pg-layout{display:flex;border:1px solid var(--pg-edge);border-radius:8px;overflow:hidden;font-size:13px;margin-left:auto;flex-shrink:0}
.pg-layout button{background:none;border:0;color:var(--pg-pencil);padding:5px 10px;font:inherit;cursor:pointer;line-height:1.3}
.pg-layout button[aria-pressed=true]{background:var(--pg-violet);color:var(--pg-violet-ink);font-weight:600}
.pg-layout+.pg-full-btn{margin-left:8px}
/* Side by side: chat (or settings) on the left, the notebook on the right. */
.pg-app.pg-full.pg-split,.pg-app.pg-full.pg-wide{max-width:none;border:0}
.pg-app.pg-split .pg-panes{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(320px,1fr)}
.pg-app.pg-split .pg-panes>.pg-view{min-height:0}
.pg-app.pg-split #pg-sheet-view{border-left:1px solid var(--pg-edge)}
.pg-app.pg-split .pg-panes>.pg-view:not([hidden]){grid-row:1}
.pg-app.pg-full{width:100%;max-width:900px;font-size:16px;--pg-row:28px;--pg-m:56px;border-left:1px solid var(--pg-edge);border-right:1px solid var(--pg-edge)}
.pg-app.pg-full .pg-top{padding-top:18px}
.pg-app.pg-full .pg-title{font-size:40px}
.pg-app.pg-typing .pg-top{display:none}.pg-app.pg-typing .pg-tabs{padding-top:6px}
@media (max-width:759px){.pg-full-btn{display:none}}
@media (max-width:480px){.pg-app{--pg-m:26px}.pg-top{padding:12px 14px 2px}.pg-sub{display:none}.pg-log{padding-right:14px;padding-left:calc(var(--pg-m) + 10px)}.pg-scroll{padding-right:14px;padding-left:calc(var(--pg-m) + 10px)}.pg-compose{padding:8px 12px max(12px,env(safe-area-inset-bottom))}.pg-tabs{padding:6px 10px 0}.pg-mode{margin-left:0}}
@media (prefers-reduced-motion:no-preference){.pg-pulse{animation:pg-pulse 1.2s ease-in-out infinite}@keyframes pg-pulse{50%{opacity:.25;transform:scale(.7)}}.pg-now .pg-cast-mark{display:inline-block;animation:pg-scribble 1.1s ease-in-out infinite}.pg-card.pg-new{animation:pg-pin .6s ease-out}@keyframes pg-pin{from{transform:translateY(-8px) rotate(-1deg);opacity:.3}to{transform:none;opacity:1}}.pg-working svg{animation:pg-scribble 1.1s ease-in-out infinite}@keyframes pg-scribble{0%,100%{transform:translate(0,0) rotate(0)}25%{transform:translate(3px,-1px) rotate(6deg)}50%{transform:translate(6px,1px) rotate(-3deg)}75%{transform:translate(3px,0) rotate(4deg)}}}
`;

const TYPE_ORDER: BlockType[] = [...BLOCK_TYPES];
const COMMANDS: [string, string, string][] = [['Skip', 'skip', 'Leave this part empty and move on'], ['You decide', 'you decide', 'Paige fills it in from what you have so far'], ['Back', 'back', 'Reopen the last part'], ['What’s done', 'sheet', 'Paige lists everything finished so far'], ['Next', 'next', 'Finish this piece and pick the next one'], ['Done', 'done', 'Wrap up with what you have']];

export function setup(ctx: SpindleFrontendContext, options: { castPollMs?: number } = {}) {
  let closed = false, busy = false, remoteBusy = false, session: Session | null = null, snapshot: Snapshot | null = null;
  let streaming: { node: HTMLElement; text: string } | null = null;
  // True from the start of Paige's reply until you scroll or type, so nothing yanks you away from where you're reading.
  let keepReading = false;
  let castTimer: ReturnType<typeof setInterval> | null = null;
  const rpc = createRpc(ctx, (next, nextBusy) => { if (closed) return; remoteBusy = nextBusy; if (!busy) { session = next; render(); } });
  const tab = ctx.ui.registerDrawerTab({ id: 'paige', title: 'Paige', shortName: 'Paige', description: 'Build characters, a scenario and lore with Paige, then make the card', keywords: ['character', 'card', 'lorebook', 'scenario', 'creator', 'persona', 'writing'],
    iconSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 3h10a1.5 1.5 0 0 1 1.5 1.5v15a1.5 1.5 0 0 1-1.5 1.5h-10z"/><path d="M4 6.5h4M4 10.5h4M4 14.5h4M4 18.5h4"/><path d="M10.5 8l1.2-1.6 1.3 1.2 1.3-1.2 1.2 1.6v1.6h-5z"/><path d="M10.5 13.5h5M10.5 16.5h3.5"/></svg>' });
  const removeStyle = ctx.dom.addStyle(STYLES);
  const app = el('div', undefined, 'pg-app'); tab.root.append(app);
  // Full screen uses Lumiverse's pop-up window, sized to fill the app (any extension may open one; the
  // full-window layer needs an extra permission). The live panel moves into it and back, so nothing reloads.
  let modal: { root: HTMLElement; dismiss(): void; onDismiss(handler: () => void): () => void } | null = null;
  let full = false;
  const canFull = typeof (ctx.ui as { showModal?: unknown }).showModal === 'function';
  const fullPref = () => { try { return localStorage.getItem('paige.full') === '1'; } catch { return false; } };
  function setFull(on: boolean, remember = true) {
    if (closed || on === full || (on && !canFull)) return;
    // Moving the panel resets its scroll, so remember where you were reading in each tab.
    const places = [...app.querySelectorAll<HTMLElement>('.pg-log, .pg-scroll')].map(node => [node, node.scrollTop] as const);
    if (on) {
      try { modal = ctx.ui.showModal({ title: 'Paige', width: 4000, maxHeight: 4000, persistent: true }); }
      catch { notify('Lumiverse wouldn’t open a full-screen window for Paige.', true); return; }
      // Paige has her own header and close button, so the pop-up's frame steps aside and she fills it.
      const body = modal.root.parentElement, box = body?.parentElement;
      if (box && body) {
        box.style.height = box.style.maxHeight; box.style.background = '#100e15';
        (box.firstElementChild as HTMLElement | null)?.style.setProperty('display', 'none');
        Object.assign(body.style, { padding: '0', overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: '0' });
      }
      Object.assign(modal.root.style, { flex: '1', minHeight: '0', display: 'flex', justifyContent: 'center' });
      modal.root.append(app);
      modal.onDismiss(() => { if (full) { modal = null; setFull(false); } });
    } else {
      tab.root.append(app);
      const open = modal; modal = null; open?.dismiss();
    }
    full = on; app.classList.toggle('pg-full', on); setFullLook(on); applyLayout();
    const backToPlace = () => { for (const [node, top] of places) node.scrollTop = top; };
    backToPlace(); requestAnimationFrame(backToPlace);
    keepReading = true;
    if (remember) { try { localStorage.setItem('paige.full', on ? '1' : '0'); } catch { /* not kept */ } }
    fitSoon();
  }
  const onKey = (e: KeyboardEvent) => { if (full && e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); setFull(false); } };
  document.addEventListener('keydown', onKey);
  // Opening Paige's tab goes straight to full screen if that's how you left her (on a big enough screen).
  const offActivate = typeof tab.onActivate === 'function' ? tab.onActivate(() => { if (fullPref() && window.innerWidth >= 760) setFull(true, false); }) : () => {};

  // ── Header and tabs ──
  const top = el('div', undefined, 'pg-top');
  const title = el('h1', 'Paige', 'pg-title'); title.insertAdjacentHTML('afterbegin', '<svg class="pg-crown" viewBox="0 0 22 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 13 3.5 3l5 5 3-6 3 6 5-5L21 13z"/></svg>');
  const heading = el('div'); heading.append(title);
  const sub = el('p', 'Your notebook for characters, scenarios and lore. When it’s full, it becomes a card.', 'pg-sub');
  // Full screen: the same live panel moves into a layer over the whole app and back, so nothing reloads.
  const fullButton = el('button', undefined, 'pg-full-btn'); fullButton.type = 'button';
  const fullLabel = el('span');
  const setFullLook = (on: boolean) => {
    fullButton.innerHTML = on ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
    fullLabel.textContent = on ? 'Back to the side panel' : 'Full screen';
    fullButton.append(fullLabel); fullButton.title = on ? 'Put Paige back in the side panel (Esc)' : 'Open Paige over the whole window';
  };
  setFullLook(false);
  fullButton.addEventListener('click', () => setFull(!full));
  // In full screen: chat and notebook side by side, or one wide chat. Remembered.
  let layout: 'split' | 'wide' = (() => { try { return localStorage.getItem('paige.layout') === 'wide' ? 'wide' : 'split'; } catch { return 'split'; } })();
  let current: 'chat' | 'sheet' | 'settings' = 'chat';
  const layoutSwitch = el('div', undefined, 'pg-layout'); layoutSwitch.setAttribute('role', 'group'); layoutSwitch.setAttribute('aria-label', 'Full screen layout');
  const layoutButtons = (['split', 'wide'] as const).map(kind => {
    const b = el('button', kind === 'split' ? 'Side by side' : 'One wide chat'); b.type = 'button';
    b.title = kind === 'split' ? 'Chat on the left, notebook on the right' : 'The chat fills the whole window';
    b.addEventListener('click', () => { layout = kind; try { localStorage.setItem('paige.layout', kind); } catch { /* not kept */ } applyLayout(); });
    layoutSwitch.append(b); return b;
  });
  function applyLayout() {
    const split = full && layout === 'split';
    app.classList.toggle('pg-split', split); app.classList.toggle('pg-wide', full && layout === 'wide');
    layoutButtons.forEach((b, i) => b.setAttribute('aria-pressed', String((['split', 'wide'] as const)[i] === layout)));
    layoutSwitch.hidden = !full;
    show(current);
  }
  layoutSwitch.hidden = true;
  top.append(heading, sub, layoutSwitch, fullButton);
  const tabs = el('div', undefined, 'pg-tabs'); tabs.setAttribute('role', 'tablist');
  const views: Record<'chat' | 'sheet' | 'settings', HTMLElement> = { chat: el('section', undefined, 'pg-view'), sheet: el('section', undefined, 'pg-view'), settings: el('section', undefined, 'pg-view') };
  views.sheet.id = 'pg-sheet-view';
  const tabButtons = {} as Record<keyof typeof views, HTMLButtonElement>;
  function show(name: keyof typeof views) {
    current = name;
    // Side by side keeps the notebook open on the right, so the left side shows the chat or settings.
    const split = app.classList.contains('pg-split');
    const left = split && name === 'sheet' ? 'chat' : name;
    for (const [key, view] of Object.entries(views) as [keyof typeof views, HTMLElement][]) { view.hidden = key !== left && !(split && key === 'sheet'); tabButtons[key].setAttribute('aria-selected', String(key === left)); }
    tabButtons.sheet.hidden = split;
    try { localStorage.setItem('paige.tab', name); } catch { /* not kept */ }
    if (left === 'chat' && !keepReading) log.scrollTop = log.scrollHeight;
    fitSoon();
  }
  for (const [key, label] of [['chat', 'Chat'], ['sheet', 'Notebook'], ['settings', 'Settings']] as const) {
    const b = el('button', label); b.type = 'button'; b.setAttribute('role', 'tab'); b.addEventListener('click', () => show(key));
    tabButtons[key] = b; tabs.append(b);
  }
  const panes = el('div', undefined, 'pg-panes'); panes.append(views.chat, views.settings, views.sheet);
  app.append(top, tabs, panes);

  // ── Chat ──
  const log = el('div', undefined, 'pg-log pg-page'); log.setAttribute('aria-live', 'polite');
  // Any scroll you make yourself hands control back.
  for (const kind of ['wheel', 'touchmove']) log.addEventListener(kind, () => { if (!streaming) keepReading = false; }, { passive: true });
  const compose = el('div', undefined, 'pg-compose');
  const chips = el('div', undefined, 'pg-chips');
  for (const [label, command, hint] of COMMANDS) {
    const b = el('button', label); b.type = 'button'; b.title = hint;
    b.addEventListener('click', () => void sendText(command)); chips.append(b);
  }
  const mode = el('div', undefined, 'pg-mode'); mode.setAttribute('role', 'group'); mode.setAttribute('aria-label', 'Interview');
  const modeButtons = (['full', 'quick'] as Mode[]).map(m => {
    const b = el('button', m === 'full' ? 'Full interview' : 'Quick draft'); b.type = 'button';
    b.title = m === 'full' ? 'Paige asks one section at a time.' : 'Paige drafts the whole piece from your pitch, then fixes the weak spots with you.';
    b.addEventListener('click', () => { if (session?.mode !== m) void act(() => rpc.request<Session>('setMode', { mode: m }).then(s => { session = s; notify(m === 'quick' ? 'Quick draft is on. Paige will rough out each piece, then go after the weak spots.' : 'Full interview is on. Paige asks one section at a time.'); })); });
    mode.append(b); return b;
  });
  chips.append(mode);
  const box = el('textarea'); box.rows = 1; box.placeholder = 'Answer Paige…'; box.setAttribute('aria-label', 'Your message');
  const sendButton = el('button', 'Send', 'pg-btn pg-primary'); sendButton.type = 'button';
  const stopButton = el('button', 'Stop', 'pg-btn'); stopButton.type = 'button';
  const retryButton = el('button', 'Retry', 'pg-btn'); retryButton.type = 'button'; retryButton.title = 'Take back Paige’s last reply and ask again';
  const status = el('div', undefined, 'pg-status'); status.setAttribute('role', 'status');
  const row = el('div', undefined, 'pg-row'); row.append(box, sendButton, stopButton, retryButton);
  compose.append(chips, row, status);
  views.chat.append(log, compose);
  const grow = () => { box.style.height = 'auto'; box.style.height = `${Math.min(box.scrollHeight, 180)}px`; };
  box.addEventListener('input', grow);
  // Paige always fills exactly the visible part of the screen, so only her chat scrolls, never the drawer around
  // it (a redraw used to throw the drawer back to the top). On iOS the keyboard slides over the page without
  // resizing it, so while typing the visible part is what the keyboard leaves, with the newest message just
  // above the box.
  const view = (globalThis as { visualViewport?: VisualViewport }).visualViewport;
  let fitTimers: ReturnType<typeof setTimeout>[] = [];
  const scroller = (): HTMLElement | null => {
    for (let node = app.parentElement; node && node !== document.body; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') return node;
    }
    return null;
  };
  const fit = () => {
    if (closed) return;
    if (full) {
      // Full screen fills the window; while typing on a touch screen, only the part the keyboard leaves.
      const keepFull = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
      app.style.minHeight = '0'; app.style.height = '100%';
      if (!streaming && !keepReading && keepFull) log.scrollTop = log.scrollHeight;
      return;
    }
    if (app.offsetParent === null) return;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const visibleTop = view?.offsetTop ?? 0, visibleBottom = visibleTop + (view?.height ?? window.innerHeight);
    const typing = document.activeElement === box && window.innerHeight - (view?.height ?? window.innerHeight) > 100;
    app.classList.toggle('pg-typing', typing);
    // If the drawer is scrolled so Paige's top is off screen, bring it back first.
    const outer = scroller();
    const above = visibleTop - app.getBoundingClientRect().top;
    if (outer && above > 1) outer.scrollTop -= above;
    const top = Math.max(app.getBoundingClientRect().top, visibleTop);
    app.style.minHeight = '0';
    app.style.height = `${Math.max(260, Math.round(visibleBottom - top))}px`;
    // Anything the drawer adds below Paige (padding, a bar) comes off her height, so nothing is left to scroll.
    const over = app.getBoundingClientRect().bottom - visibleBottom;
    if (over > 1) app.style.height = `${Math.max(260, Math.round(visibleBottom - top - over))}px`;
    // Padding the drawer puts under Paige would still let the drawer itself scroll a little; take that off too.
    const spare = outer ? outer.scrollHeight - outer.clientHeight : 0;
    if (spare > 1) app.style.height = `${Math.max(260, app.getBoundingClientRect().height - spare)}px`;
    if (!streaming && !keepReading && (atBottom || typing)) log.scrollTop = log.scrollHeight;
  };
  // iOS moves the page a moment after the keyboard opens or closes, so look again once it has settled.
  function fitSoon() { fit(); fitTimers.forEach(clearTimeout); fitTimers = [120, 350, 700].map(ms => setTimeout(fit, ms)); };
  view?.addEventListener('resize', fitSoon);
  view?.addEventListener('scroll', fit);
  window.addEventListener('resize', fitSoon);
  box.addEventListener('focus', () => { keepReading = false; fitSoon(); });
  box.addEventListener('blur', () => setTimeout(fitSoon, 50));
  // Showing the drawer tab, or switching tabs inside Paige, changes where she sits.
  const seen = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fitSoon()) : null;
  seen?.observe(tab.root);
  box.addEventListener('keydown', e => {
    // Enter sends on a keyboard; on a phone the return key makes a new line and Send sends.
    const touch = matchMedia?.('(pointer: coarse)').matches;
    if (e.key === 'Enter' && !e.shiftKey && (!touch || e.metaKey || e.ctrlKey)) { e.preventDefault(); void sendText(box.value); }
  });
  sendButton.addEventListener('click', () => void sendText(box.value));
  stopButton.addEventListener('click', () => void rpc.request('stop').catch(() => {}));
  retryButton.addEventListener('click', () => void talk('retry'));

  // ── Notebook (the Sheet) ──
  const sheetScroll = el('div', undefined, 'pg-scroll pg-page');
  const pieces = el('div');
  const make = el('section', undefined, 'pg-make');
  const makeTitle = el('h3', 'Make my card');
  const makeHint = el('p', 'Tears this notebook out into a card. The main character goes in the description, the scenario in the scenario field, and everyone and everything else in the card’s lorebook. Kept first messages become the greetings.', 'pg-note');
  const cardName = el('input'); cardName.type = 'text'; cardName.maxLength = 120;
  const nameField = el('label', undefined, 'pg-field'); nameField.append(el('span', 'Card name'), cardName);
  const looks = el('input'); looks.type = 'checkbox';
  try { looks.checked = localStorage.getItem('paige.looks') !== '0'; } catch { looks.checked = true; }
  looks.addEventListener('change', () => { try { localStorage.setItem('paige.looks', looks.checked ? '1' : '0'); } catch { /* not kept */ } });
  const looksRow = el('label', undefined, 'pg-check'); looksRow.append(looks, el('span', 'Also send everyone’s looks to LumiCast, so they show up in Lumi Studio ready to draw'));
  const makeButton = el('button', 'Make my card', 'pg-btn pg-primary'); makeButton.type = 'button';
  const resendButton = el('button', 'Send looks again', 'pg-btn'); resendButton.type = 'button';
  const makeStatus = el('div', undefined, 'pg-status'); makeStatus.setAttribute('role', 'status');
  const makeRow = el('div', undefined, 'pg-row'); makeRow.append(makeButton, resendButton);
  // Send looks again: pick who. Anyone who didn't make it last time starts ticked.
  const pick = el('div', undefined, 'pg-pick'); pick.hidden = true;
  // LumiCast's progress, one line per person.
  const cast = el('div', undefined, 'pg-cast'); cast.hidden = true; cast.setAttribute('role', 'status');
  make.append(makeTitle, makeHint, nameField, looksRow, makeRow, pick, makeStatus, cast);
  sheetScroll.append(pieces, make);
  views.sheet.append(sheetScroll);
  makeButton.addEventListener('click', () => void act(async () => {
    makeNotify('Making the card…');
    const result = await rpc.request<CardResult>('makeCard', { name: cardName.value, sendLooks: looks.checked });
    session = result.session;
    const made = [
      `${result.updated ? 'Updated' : 'Made'} “${result.name}” with ${result.entries} lorebook ${result.entries === 1 ? 'entry' : 'entries'} and ${result.greetings} ${result.greetings === 1 ? 'greeting' : 'greetings'}.`,
      result.personaName ? `Persona “${result.personaName}” is ready.` : '', result.personaNote, ...result.notes,
    ].filter(Boolean);
    makeNotify(made.join('\n'));
    if (result.cast) castNews(result.cast, made.join('\n'), looksFrom(result.session.blocks).map(l => l.name));
  }));
  resendButton.addEventListener('click', () => { if (pick.hidden) openPick(); else pick.hidden = true; });
  function openPick() {
    const people = looksFrom(session?.blocks ?? []);
    pick.replaceChildren(el('p', 'Who should LumiCast send to Lumi Studio? Anyone already there gets a copy marked “needs a new name”, so only tick the ones that are missing or that you changed.', 'pg-note'));
    if (!people.length) { pick.append(el('p', 'No one in the notebook has a look section yet.', 'pg-note')); pick.hidden = false; return; }
    const boxes = people.map(person => {
      const box = el('input'); box.type = 'checkbox'; box.checked = failedLast.has(person.name.toLowerCase());
      const row = el('label', undefined, 'pg-check'); row.append(box, el('span', `${person.name}${person.kind === 'persona' ? ' (your persona)' : ''}${failedLast.has(person.name.toLowerCase()) ? ' — didn’t make it last time' : ''}`));
      pick.append(row); return [person.name, box] as const;
    });
    const go = el('button', 'Send these', 'pg-btn pg-primary'); go.type = 'button';
    const cancel = el('button', 'Cancel', 'pg-btn'); cancel.type = 'button';
    const row = el('div', undefined, 'pg-row'); row.append(go, cancel); pick.append(row);
    cancel.addEventListener('click', () => { pick.hidden = true; });
    go.addEventListener('click', () => void act(async () => {
      const only = boxes.filter(([, box]) => box.checked).map(([name]) => name);
      if (!only.length) { makeNotify('Tick at least one person first.', true); return; }
      pick.hidden = true;
      castNews(await rpc.request<CastStatus>('sendLooks', { only }), '', only);
    }));
    pick.hidden = false;
  }

  // ── Settings ──
  const settingsScroll = el('div', undefined, 'pg-scroll pg-page');
  const connection = el('select');
  const thinking = el('select');
  for (const [value, label] of [['light', 'Light (quick think, the default)'], ['off', 'Off'], ['inherit', 'Use the connection’s own setting']]) { const o = el('option', label); o.value = value; thinking.append(o); }
  const saveSettings = el('button', 'Save settings', 'pg-btn pg-primary'); saveSettings.type = 'button';
  const settingsStatus = el('div', undefined, 'pg-status');
  const field = (label: string, input: HTMLElement, hint: string) => { const w = el('label', undefined, 'pg-field'); w.append(el('span', label), input, el('small', hint, 'pg-note')); return w; };
  const startOver = el('button', 'Start over', 'pg-btn'); startOver.type = 'button';
  // ── Backups: the whole chat and notebook as a file you keep, and loading one back in ──
  const saveBackup = el('button', 'Save a backup', 'pg-btn'); saveBackup.type = 'button';
  const loadBackup = el('button', 'Load a backup', 'pg-btn'); loadBackup.type = 'button';
  const picker = el('input'); picker.type = 'file'; picker.accept = '.json,application/json'; picker.hidden = true;
  const backupStatus = el('div', undefined, 'pg-status'); backupStatus.setAttribute('role', 'status');
  const confirmRow = el('div', undefined, 'pg-row'); confirmRow.hidden = true;
  const confirmLoad = el('button', 'Load it', 'pg-btn pg-primary'); confirmLoad.type = 'button';
  const cancelLoad = el('button', 'Cancel', 'pg-btn'); cancelLoad.type = 'button';
  confirmRow.append(confirmLoad, cancelLoad);
  let pickedBackup: unknown = null;
  const backupNotify = (text: string, error = false) => { if (closed) return; backupStatus.textContent = text; backupStatus.dataset.error = String(error); };
  saveBackup.addEventListener('click', () => void act(async () => {
    const backup = await rpc.request<{ session: Session }>('exportSession');
    const main = backup.session.blocks.find(b => b.type === 'Main character')?.name || backup.session.card?.name || 'notebook';
    const day = new Date().toISOString().slice(0, 10);
    const name = `Paige - ${main.replace(/[\\/:*?"<>|]+/g, '').slice(0, 60)} - ${day}.json`;
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 1)], { type: 'application/json' }));
    const link = el('a'); link.href = url; link.download = name; link.hidden = true; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    const pieces = backup.session.blocks.filter(b => b.type !== 'First message').length;
    backupNotify(`Saved “${name}”: ${backup.session.turns.length} messages and ${pieces} ${pieces === 1 ? 'piece' : 'pieces'}. It goes wherever your downloads go.`);
  }));
  loadBackup.addEventListener('click', () => { if (!busy) picker.click(); });
  picker.addEventListener('change', async () => {
    const file = picker.files?.[0]; picker.value = '';
    if (!file) return;
    try {
      if (file.size > 20_000_000) throw new Error('That file is too big to be a Paige backup.');
      let backup = JSON.parse(await file.text()) as { kind?: string; version?: number; session?: Session };
      // Paige's own saved file (session.json) works too, as it is.
      const bare = backup as unknown as Session;
      if (!backup?.kind && bare?.version === 1 && Array.isArray(bare.turns) && Array.isArray(bare.blocks)) backup = { kind: 'paige-backup', version: 1, session: bare } as typeof backup;
      if (backup?.kind !== 'paige-backup' || !backup.session) throw new Error('That file isn’t a Paige backup.');
      pickedBackup = backup;
      const pieces = (backup.session.blocks ?? []).filter(b => b.type !== 'First message').length;
      backupNotify(`“${file.name}” has ${backup.session.turns?.length ?? 0} messages and ${pieces} ${pieces === 1 ? 'piece' : 'pieces'}. Loading it replaces what’s open now. What’s open now is kept in Paige’s storage.`);
      confirmRow.hidden = false;
    } catch (e) { pickedBackup = null; confirmRow.hidden = true; backupNotify(e instanceof SyntaxError ? 'That file isn’t a Paige backup.' : e instanceof Error ? e.message : 'That file couldn’t be read.', true); }
  });
  cancelLoad.addEventListener('click', () => { pickedBackup = null; confirmRow.hidden = true; backupNotify(''); });
  confirmLoad.addEventListener('click', () => void act(async () => {
    const s = await rpc.request<Session>('importSession', { backup: pickedBackup });
    session = s; pickedBackup = null; confirmRow.hidden = true; cardName.value = s.card?.name ?? ''; makeStatus.textContent = '';
    backupNotify('Loaded. You’re back where that backup left off.');
    renderLog(true); renderSheet(); show('chat');
  }));
  let armed: ReturnType<typeof setTimeout> | null = null;
  startOver.addEventListener('click', () => {
    if (!armed) { startOver.textContent = 'Press again to clear the chat and notebook'; armed = setTimeout(() => { armed = null; startOver.textContent = 'Start over'; }, 4000); return; }
    clearTimeout(armed); armed = null; startOver.textContent = 'Start over';
    void act(() => rpc.request<Session>('startOver', { mode: session?.mode ?? 'full' }).then(s => { session = s; cardName.value = ''; makeStatus.textContent = ''; settingsNotify('Started over. Cards you already made are still in Lumiverse.'); show('chat'); }));
  });
  settingsScroll.append(
    field('Model connection', connection, 'The model Paige talks with. It doesn’t have to be your story model.'),
    field('Thinking', thinking, 'How long the model thinks before each reply. Light keeps Paige quick.'),
    el('div', undefined, 'pg-row'), settingsStatus,
    el('hr'), el('p', 'Save the whole chat and notebook as a file, so a long session is never lost, even if you reinstall Paige. Load it back in any time to pick up where you left off.', 'pg-note'), el('div', undefined, 'pg-row pg-backup'), confirmRow, backupStatus, picker,
    el('hr'), el('p', 'Start a fresh notebook for a new card. The old chat is kept in Paige’s storage, and cards you already made stay in Lumiverse.', 'pg-note'), startOver,
    el('p', 'Paige and her interview are by Deiomo (deiomo.github.io), used with permission.', 'pg-note pg-credit'),
  );
  settingsScroll.children[2].append(saveSettings);
  settingsScroll.querySelector('.pg-backup')!.append(saveBackup, loadBackup);
  views.settings.append(settingsScroll);
  saveSettings.addEventListener('click', () => void act(async () => {
    await rpc.request('saveSettings', { connectionId: connection.value, thinking: thinking.value });
    settingsNotify('Saved.');
  }));

  function notify(text: string, error = false) { if (closed) return; status.textContent = text; status.dataset.error = String(error); }
  function makeNotify(text: string, error = false) { if (closed) return; makeStatus.textContent = text; makeStatus.dataset.error = String(error); }
  function settingsNotify(text: string, error = false) { if (closed) return; settingsStatus.textContent = text; settingsStatus.dataset.error = String(error); }

  async function act(run: () => Promise<unknown>) {
    if (busy || closed) return;
    busy = true; update();
    try { await run(); } catch (e) { const m = e instanceof Error ? e.message : 'That didn’t work.'; notify(m, true); makeNotify(m, true); settingsNotify(m, true); backupNotify(m, true); }
    finally { busy = false; if (!closed) render(); }
  }

  function sendText(text: string) {
    if (!text.trim()) return;
    if (!snapshot?.settings.connectionId) { show('settings'); settingsNotify('Pick a model connection for Paige first.', true); return; }
    return talk('send', text);
  }

  async function talk(action: 'send' | 'retry', text?: string) {
    if (busy || closed || remoteBusy) return;
    busy = true;
    if (action === 'send' && session) { session.turns.push({ role: 'user', content: text!.trim(), at: Date.now() }); box.value = ''; grow(); }
    if (action === 'retry' && session && session.turns[session.turns.length - 1]?.role === 'assistant' && session.turns.length > 1) session.turns.pop();
    renderLog();
    const node = el('div', undefined, 'pg-msg pg-paige');
    const working = el('p', 'Paige is writing…', 'pg-working'); working.insertAdjacentHTML('afterbegin', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/></svg>'); node.append(working);
    // Room below the reply, so its start can sit at the top of the page before there's much written.
    const room = el('div'); room.style.height = `${log.clientHeight}px`; room.setAttribute('aria-hidden', 'true');
    log.append(node, room);
    // Show the start of her reply (with the end of your note above it) and leave the scroll alone after that,
    // so a long reply can be read from the top while it's still coming in.
    log.scrollTop = Math.max(0, node.offsetTop - 56);
    streaming = { node, text: '' }; keepReading = true;
    // On a phone, put the keyboard away so the whole page is there to read.
    if (matchMedia?.('(pointer: coarse)').matches) box.blur();
    update(); notify('');
    try {
      const result = await rpc.request<{ session: Session; stopped: boolean; cutOff: boolean }>(action, action === 'send' ? { text } : {}, partial => {
        if (!streaming) return;
        const keep = log.scrollTop;
        streaming.text = partial; streaming.node.replaceChildren(); message(streaming.node, partial);
        log.scrollTop = keep;
      });
      session = result.session;
      if (result.cutOff) notify('Paige’s reply hit the length limit and was cut off. Press Retry, or ask her to finish.');
      else if (result.stopped) notify('Stopped. What she wrote so far is kept.');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Paige didn’t answer.', true);
      try { const fresh = await rpc.request<Snapshot>('snapshot'); snapshot = fresh; session = fresh.session; } catch { /* keep what we have */ }
    } finally {
      streaming = null; busy = false;
      if (!closed) render();
    }
  }

  /** Who didn't make it in the last batch, so Send looks again can tick them for you. */
  const failedLast = new Set<string>();
  let castClock: ReturnType<typeof setInterval> | null = null;
  const stopCast = () => { if (castTimer) clearInterval(castTimer); if (castClock) clearInterval(castClock); castTimer = castClock = null; if (!closed) update(); };
  const minutes = (ms: number) => { const sec = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
  /** Shows LumiCast's batch as it goes: who's done, who it's on and which step, a running clock, and a warning if it goes quiet. */
  function castNews(started: CastStatus, before: string, sent: string[] = []) {
    makeNotify([before, started.state === 'started' ? '' : started.message].filter(Boolean).join('\n'), started.state === 'failed');
    stopCast(); cast.hidden = true;
    if (started.state !== 'started') return;
    const began = Date.now();
    let last: LumiCastStatus | null = null, quiet = 0;
    const draw = () => {
      if (closed) return;
      const s = last;
      const names = s?.names?.length ? s.names : sent;
      const done = new Map((s?.finished ?? []).map(f => [f.name.toLowerCase(), f]));
      const running = !s || s.running;
      const lastWord = s?.updatedAt ? Date.now() - s.updatedAt : Date.now() - began;
      cast.replaceChildren();
      const head = el('div', undefined, 'pg-cast-head');
      if (running) head.append(el('span', undefined, 'pg-pulse'));
      head.append(el('strong', running ? `LumiCast is working: ${s?.done ?? 0} of ${s?.total ?? names.length} done` : `LumiCast finished ${s!.done} of ${s!.total}`), el('span', minutes((s?.updatedAt && !running ? s.updatedAt : Date.now()) - (s?.startedAt ?? began)), 'pg-cast-clock'));
      cast.append(head);
      for (const name of names) {
        const f = done.get(name.toLowerCase()), current = running && s?.current?.toLowerCase() === name.toLowerCase();
        const row = el('div', undefined, `pg-cast-row ${f ? (f.ok ? 'pg-ok' : 'pg-bad') : current ? 'pg-now' : 'pg-wait'}`);
        row.append(el('span', f ? (f.ok ? '✓' : '✗') : current ? '✎' : '○', 'pg-cast-mark'));
        const text = el('div'); text.append(el('span', name, 'pg-cast-name'));
        const clash = f?.ok && /^saved as /.test(f.message);
        const detail = f ? (f.ok ? (clash ? f.message : 'in Lumi Studio') : f.message) : current ? (s?.stage || 'working…') : 'waiting';
        text.append(el('span', detail, 'pg-cast-detail'));
        row.append(text); cast.append(row);
      }
      if (running && lastWord > 150_000) cast.append(el('p', `LumiCast hasn’t said anything for ${minutes(lastWord)}. It may be stuck. Reloading Lumiverse stops it, and nothing already in Lumi Studio is lost.`, 'pg-cast-warn'));
      if (!running) {
        const failed = (s?.finished ?? []).filter(f => !f.ok), clashes = (s?.finished ?? []).filter(f => f.ok && /^saved as /.test(f.message));
        if (failed.length) cast.append(el('p', `Press Send looks again to try ${failed.length === 1 ? failed[0].name : 'the ones that didn’t make it'} again. ${failed.length === 1 ? 'It’s' : 'They’re'} ticked for you.`, 'pg-cast-warn'));
        if (clashes.length) cast.append(el('p', `${clashes.length === 1 ? 'One name was' : `${clashes.length} names were`} already taken in Lumi Studio, so nothing was replaced. Rename the ones marked “needs a new name” there.`, 'pg-cast-warn'));
      }
      cast.hidden = false;
    };
    draw();
    castClock = setInterval(draw, 1000);
    castTimer = setInterval(async () => {
      if (closed) return;
      const s = await rpc.request<LumiCastStatus | null>('lumicastStatus').catch(() => null);
      if (!s) { if (++quiet > 40) { stopCast(); cast.append(el('p', 'Lost track of LumiCast. Check Lumi Studio to see who arrived.', 'pg-cast-warn')); } return; }
      quiet = 0;
      if (s.error) { stopCast(); cast.hidden = true; makeNotify([before, `LumiCast couldn’t start: ${s.error}`].filter(Boolean).join('\n'), true); return; }
      last = s;
      if (!s.running) {
        failedLast.clear(); for (const f of s.finished) if (!f.ok) failedLast.add(f.name.toLowerCase());
        draw(); stopCast();
      }
    }, options.castPollMs ?? 3000);
  }

  /** Redraws the chat. It stays where you were reading unless you were already at the bottom, or toBottom asks. */
  function renderLog(toBottom = false) {
    const wasBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40, keep = log.scrollTop;
    log.replaceChildren();
    if (!session) return;
    const lastSaved = session.turns.length - 1;
    session.turns.forEach((turn, index) => {
      const node = el('div', undefined, `pg-msg ${turn.role === 'user' ? 'pg-user' : 'pg-paige'}`);
      if (turn.role === 'user') { node.textContent = turn.content; node.style.setProperty('--pg-tilt', ['.6deg', '-.5deg', '.3deg'][index % 3]); }
      else {
        message(node, turn.content);
        if (turn.saved?.length) node.append(el('div', turn.saved.join(', ') + '. It’s in your notebook.', 'pg-saved'));
        if (index === lastSaved && Date.now() - turn.at < 4000) node.querySelectorAll('.pg-card').forEach(t => t.classList.add('pg-new'));
      }
      log.append(node);
    });
    log.scrollTop = toBottom || (wasBottom && !keepReading) ? log.scrollHeight : keep;
  }

  function piece(block: Block): HTMLDetailsElement {
    const box = el('details', undefined, 'pg-card');
    const head = el('summary'); head.append(el('span', block.name || block.type, 'pg-card-name'));
    if (block.edited) head.append(el('span', 'edited by you', 'pg-card-tag'));
    const inner = el('div', undefined, 'pg-inner');
    const pre = el('div'); sheetBody(pre, block.body);
    const edit = el('button', 'Edit', 'pg-btn'); edit.type = 'button';
    const del = el('button', 'Delete', 'pg-btn'); del.type = 'button';
    const actions = el('div', undefined, 'pg-row'); actions.append(edit, del);
    if (block.type === 'First message') {
      const keep = el('input'); keep.type = 'checkbox'; keep.checked = block.keep !== false;
      const keepRow = el('label'); keepRow.append(keep, el('span', 'Use on the card'));
      keep.addEventListener('change', () => void act(() => rpc.request<Session>('keepFirst', { id: block.id, keep: keep.checked }).then(s => { session = s; })));
      actions.prepend(keepRow);
    }
    inner.append(pre, el('div'), actions);
    let armedDelete: ReturnType<typeof setTimeout> | null = null;
    del.addEventListener('click', () => {
      if (!armedDelete) { del.textContent = 'Press again to delete'; armedDelete = setTimeout(() => { armedDelete = null; del.textContent = 'Delete'; }, 4000); return; }
      clearTimeout(armedDelete);
      void act(() => rpc.request<Session>('deleteBlock', { id: block.id }).then(s => { session = s; }));
    });
    edit.addEventListener('click', () => {
      const area = el('textarea'); area.value = block.body; area.setAttribute('aria-label', `Edit ${block.name}`);
      const save = el('button', 'Save', 'pg-btn pg-primary'); save.type = 'button';
      const cancel = el('button', 'Cancel', 'pg-btn'); cancel.type = 'button';
      const editRow = el('div', undefined, 'pg-row'); editRow.append(save, cancel);
      inner.replaceChildren(area, el('p', 'Paige will use your version from now on.', 'pg-note'), editRow);
      area.focus();
      cancel.addEventListener('click', () => renderSheet());
      save.addEventListener('click', () => void act(() => rpc.request<Session>('editBlock', { id: block.id, body: area.value }).then(s => { session = s; })));
    });
    box.append(head, inner);
    return box;
  }

  function renderSheet() {
    const open = new Set([...pieces.querySelectorAll<HTMLDetailsElement>('details[open]')].map(d => d.dataset.id));
    pieces.replaceChildren();
    const blocks = session?.blocks ?? [];
    if (!blocks.length) pieces.append(el('p', 'Nothing here yet. Every piece Paige finishes gets taped in here.', 'pg-empty'));
    for (const type of TYPE_ORDER) {
      const group = blocks.filter(b => b.type === type);
      if (!group.length) continue;
      const section = el('div', undefined, 'pg-group');
      section.append(el('h3', type === 'First message' ? 'First messages' : type === 'History' ? 'History' : type === 'Persona' ? 'Your persona' : `${type}${group.length > 1 ? 's' : ''}`));
      for (const block of group) { const node = piece(block); node.dataset.id = block.id; if (open.has(block.id)) node.open = true; section.append(node); }
      pieces.append(section);
    }
    const main = blocks.find(b => b.type === 'Main character');
    cardName.placeholder = main?.name || 'Name the card';
    if (!cardName.value && session?.card?.name) cardName.value = session.card.name;
    makeTitle.textContent = session?.card ? 'Update my card' : 'Make my card';
    makeButton.textContent = session?.card ? `Update “${session.card.name}”` : 'Make my card';
    resendButton.hidden = !session?.card;
    const count = blocks.filter(b => b.type !== 'First message').length;
    tabButtons.sheet.textContent = count ? `Notebook (${count})` : 'Notebook';
  }

  function update() {
    const working = busy || remoteBusy;
    sendButton.hidden = working && !!streaming; stopButton.hidden = !(working && (streaming || remoteBusy));
    sendButton.disabled = working; box.disabled = false; retryButton.disabled = working || !session || session.turns.length < 2;
    for (const b of chips.querySelectorAll('button')) (b as HTMLButtonElement).disabled = working;
    modeButtons.forEach((b, i) => b.setAttribute('aria-pressed', String((session?.mode ?? 'full') === (['full', 'quick'] as Mode[])[i])));
    makeButton.disabled = working || !session?.blocks.some(b => b.type !== 'First message');
    resendButton.disabled = working || !!castTimer; saveSettings.disabled = working; startOver.disabled = working; saveBackup.disabled = working; loadBackup.disabled = working; confirmLoad.disabled = working;
  }

  function render() { renderLog(); renderSheet(); update(); }

  async function load() {
    snapshot = await rpc.request<Snapshot>('snapshot');
    if (closed) return;
    session = snapshot.session; remoteBusy = snapshot.busy;
    connection.replaceChildren(el('option', 'Pick a connection'));
    (connection.firstChild as HTMLOptionElement).value = '';
    for (const c of snapshot.connections) { const o = el('option', `${c.name} · ${c.model}`); o.value = c.id; connection.append(o); }
    connection.value = snapshot.settings.connectionId; thinking.value = snapshot.settings.thinking;
    renderLog(true); renderSheet(); update();
    const missing = (Object.entries(snapshot.permissions) as [string, boolean][]).filter(([, ok]) => !ok).map(([p]) => p.replace('_', ' '));
    if (!snapshot.settings.connectionId) { show('settings'); settingsNotify('Pick the model connection Paige should use, then save.'); }
    if (missing.length) notify(`Paige needs these permissions in Extensions: ${missing.join(', ')}.`, true);
  }
  saveSettings.addEventListener('click', () => { if (snapshot) snapshot.settings = { connectionId: connection.value, thinking: thinking.value as Snapshot['settings']['thinking'] }; });

  let start: keyof typeof views = 'chat';
  try { const saved = localStorage.getItem('paige.tab'); if (saved === 'sheet' || saved === 'settings') start = saved; } catch { /* default */ }
  show(start);
  busy = true; update();
  void load().catch(e => notify(e instanceof Error ? e.message : 'Paige couldn’t load.', true)).finally(() => { busy = false; if (!closed) update(); });

  return () => { closed = true; stopCast(); document.removeEventListener('keydown', onKey); offActivate(); const openModal = modal; modal = null; openModal?.dismiss(); view?.removeEventListener('resize', fitSoon); view?.removeEventListener('scroll', fit); window.removeEventListener('resize', fitSoon); seen?.disconnect(); fitTimers.forEach(clearTimeout); if (castTimer) clearInterval(castTimer); if (armed) clearTimeout(armed); rpc.destroy(); removeStyle(); tab.destroy(); };
}
