// src/blocks.ts
var BLOCK_TYPES = ["Main character", "Side character", "Scenario", "Location", "Item", "Faction", "History", "Concept", "Persona", "First message"];
var LABELS = {
  "main character": "Main character",
  main: "Main character",
  character: "Main character",
  "side character": "Side character",
  side: "Side character",
  npc: "Side character",
  scenario: "Scenario",
  location: "Location",
  item: "Item",
  faction: "Faction",
  history: "History",
  "history event": "History",
  event: "History",
  concept: "Concept",
  persona: "Persona",
  "user persona": "Persona",
  "first message": "First message",
  greeting: "First message",
  "opening message": "First message",
  "alternate greeting": "First message"
};
function labelOf(line) {
  let text = line.trim().replace(/^[#>*_\s]+|[*_\s:]+$/g, "").replace(/^(?:block|type)\s*[:\-–—]\s*/i, "").trim().toLowerCase();
  text = text.replace(/\s*(?:block)$/, "").replace(/\s*(?:#?\d+|\(\d+\))$/, "").replace(/\s*[:\-–—].*$/, "").trim();
  return LABELS[text] ?? null;
}

// src/frontend.ts
function createRpc(ctx, onSession, timeout = 320000) {
  let closed = false;
  const pending = new Map;
  const off = ctx.onBackendMessage((value) => {
    const r = value;
    if (r?.type === "paige:session" && r.session) {
      onSession(r.session, !!r.busy);
      return;
    }
    if (r?.type === "paige:stream" && r.id && typeof r.text === "string") {
      pending.get(r.id)?.stream?.(r.text);
      return;
    }
    if (!r || r.type !== "paige:response" || !r.id)
      return;
    const p = pending.get(r.id);
    if (!p)
      return;
    clearTimeout(p.timer);
    pending.delete(r.id);
    if (r.error)
      p.reject(new Error(r.error));
    else
      p.resolve(r.result);
  });
  return {
    request(action, input, stream) {
      if (closed)
        return Promise.reject(new Error("Paige is closed."));
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Lumiverse did not answer in time. Your session is saved."));
        }, timeout);
        pending.set(id, { resolve: (v) => resolve(v), reject, timer, stream });
        try {
          ctx.sendToBackend({ type: "paige:request", id, action, input });
        } catch (e) {
          clearTimeout(timer);
          pending.delete(id);
          reject(e);
        }
      });
    },
    destroy() {
      closed = true;
      off();
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("Paige closed."));
      }
      pending.clear();
    }
  };
}
function el(tag, content, className) {
  const n = document.createElement(tag);
  if (content !== undefined)
    n.textContent = content;
  if (className)
    n.className = className;
  return n;
}
function inline(target, line) {
  const parts = line.split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|https?:\/\/[^\s)<>"]+)/g);
  for (const part of parts) {
    if (!part)
      continue;
    if (/^\*\*[^*]+\*\*$/.test(part))
      target.append(el("strong", part.slice(2, -2)));
    else if (/^\*[^*]+\*$/.test(part))
      target.append(el("em", part.slice(1, -1)));
    else if (/^`[^`]+`$/.test(part))
      target.append(el("code", part.slice(1, -1)));
    else if (/^https?:\/\//.test(part)) {
      const a = el("a", part);
      a.href = part;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      target.append(a);
    } else
      target.append(document.createTextNode(part));
  }
}
function prose(target, text) {
  for (const para of text.split(/\n{2,}/)) {
    const lines = para.split(`
`).filter((l) => l.trim());
    if (!lines.length)
      continue;
    if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
      const ul = el("ul");
      for (const l of lines) {
        const li = el("li");
        inline(li, l.replace(/^\s*[-*•]\s+/, ""));
        ul.append(li);
      }
      target.append(ul);
      continue;
    }
    const p = el("p");
    lines.forEach((l, i) => {
      if (i)
        p.append(el("br"));
      inline(p, l.replace(/^#{1,4}\s+/, ""));
    });
    target.append(p);
  }
}
function ticket(type, body) {
  const box = el("details", undefined, "pg-ticket");
  const name = type === "Scenario" || type === "First message" ? "" : (/^\s*[*_]*Name[*_]*\s*:\s*(.+)$/im.exec(body)?.[1] ?? "").replace(/[*_]+/g, "").trim();
  const head = el("summary");
  head.append(el("span", type, "pg-ticket-type"), el("span", name || (type === "First message" ? body.trim().split(`
`)[0].slice(0, 70) : ""), "pg-ticket-name"), el("span", "on the Sheet", "pg-ticket-tag"));
  box.append(head, el("pre", body.trim()));
  return box;
}
function message(target, text) {
  const fences = /(^|\n)[ \t]*(```+|~~~+)([^\n]*)\n([\s\S]*?)(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g;
  let at = 0;
  for (const m of text.matchAll(fences)) {
    prose(target, text.slice(at, m.index + m[1].length));
    at = m.index + m[0].length;
    const info = m[3].trim();
    let body = m[4];
    let type = info ? labelOf(info) : null;
    if (!type) {
      const lines = body.split(`
`);
      const first = lines.findIndex((l) => l.trim());
      type = first >= 0 ? labelOf(lines[first]) : null;
      if (type)
        body = lines.slice(first + 1).join(`
`);
    }
    target.append(type ? ticket(type, body) : el("pre", body, "pg-pre"));
  }
  prose(target, text.slice(at));
}
var STYLES = `
.pg-app{--pg-violet:#a35cff;--pg-violet-soft:#a35cff26;--pg-ink:var(--lumiverse-text,#ece7f4);--pg-muted:var(--lumiverse-text-muted,#aaa2b8);--pg-line:#8f80a83d;--pg-bg:var(--lumiverse-bg,#18141f);--pg-raise:#ffffff08;box-sizing:border-box;font:15px/1.6 inherit;color:var(--pg-ink);display:flex;flex-direction:column;height:100%;min-height:520px;max-width:820px;margin:0 auto}
.pg-app *{box-sizing:border-box}
.pg-top{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;padding:18px 18px 0;flex-wrap:wrap}
.pg-title{font-size:30px;font-weight:800;letter-spacing:-.5px;line-height:1;color:var(--pg-violet);margin:0;transform:skew(-6deg);transform-origin:left bottom}
.pg-sub{color:var(--pg-muted);font-size:13px;margin:6px 0 0}
.pg-tabs{display:flex;gap:2px;border-bottom:1px solid var(--pg-line);padding:0 18px;margin-top:14px}
.pg-tabs button{background:none;border:0;border-bottom:2px solid transparent;color:var(--pg-muted);padding:9px 12px;font:inherit;font-size:14px;cursor:pointer;margin-bottom:-1px}
.pg-tabs button[aria-selected=true]{color:var(--pg-ink);border-bottom-color:var(--pg-violet);font-weight:600}
.pg-view{flex:1;min-height:0;display:flex;flex-direction:column}
.pg-view[hidden]{display:none!important}
.pg-log{flex:1;min-height:0;overflow-y:auto;padding:18px;display:flex;flex-direction:column;gap:18px}
.pg-msg p{margin:0 0 10px}.pg-msg p:last-child{margin-bottom:0}.pg-msg ul{margin:0 0 10px;padding-left:20px}
.pg-msg em{color:var(--pg-muted)}
.pg-msg.pg-user{align-self:flex-end;max-width:85%;background:var(--pg-violet-soft);border-radius:14px 14px 4px 14px;padding:9px 14px;white-space:pre-wrap}
.pg-msg.pg-paige{max-width:100%}
.pg-msg code{background:var(--pg-raise);border-radius:4px;padding:1px 5px;font-size:.92em}
.pg-msg a{color:var(--pg-violet)}
.pg-pre,.pg-ticket pre,.pg-piece pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0}
.pg-pre{background:var(--pg-raise);border-radius:8px;padding:10px 12px;margin:0 0 10px}
.pg-ticket{border:1px dashed var(--pg-violet);border-radius:3px;margin:4px 0 12px;background:linear-gradient(90deg,var(--pg-violet) 0 4px,transparent 4px)}
.pg-ticket summary{display:flex;gap:10px;align-items:baseline;padding:9px 12px 9px 16px;cursor:pointer;list-style:none;flex-wrap:wrap}
.pg-ticket summary::-webkit-details-marker{display:none}
.pg-ticket-type{font-weight:700;color:var(--pg-violet)}
.pg-ticket-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pg-ticket-tag{font-size:12px;color:var(--pg-muted)}
.pg-ticket pre{padding:4px 14px 12px 16px;border-top:1px dashed var(--pg-line)}
.pg-saved{font-size:12px;color:var(--pg-muted);margin-top:6px}
.pg-working{color:var(--pg-muted);font-style:italic}
.pg-compose{border-top:1px solid var(--pg-line);padding:10px 18px 16px;background:var(--pg-bg)}
.pg-chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;align-items:center}
.pg-chips button{border:1px solid var(--pg-line);background:none;color:var(--pg-ink);border-radius:999px;padding:3px 11px;font:inherit;font-size:13px;cursor:pointer}
.pg-mode{margin-left:auto;display:flex;border:1px solid var(--pg-line);border-radius:999px;overflow:hidden;font-size:12px}
.pg-mode button{border:0;border-radius:0;padding:3px 10px;color:var(--pg-muted)}
.pg-mode button[aria-pressed=true]{background:var(--pg-violet);color:#1b0f2b;font-weight:600}
.pg-row{display:flex;gap:8px;align-items:flex-end}
.pg-app textarea,.pg-app input[type=text],.pg-app select{width:100%;border:1px solid var(--pg-line);border-radius:10px;background:var(--pg-raise);color:inherit;padding:10px 12px;font:inherit}
.pg-compose textarea{resize:none;min-height:44px;max-height:180px}
.pg-app button.pg-btn{border:1px solid var(--pg-line);border-radius:10px;background:var(--pg-raise);color:inherit;padding:9px 15px;font:inherit;cursor:pointer;white-space:nowrap}
.pg-app button.pg-primary{background:var(--pg-violet);border-color:var(--pg-violet);color:#1b0f2b;font-weight:650}
.pg-app button:disabled{opacity:.45;cursor:default}
.pg-app :focus-visible{outline:2px solid var(--pg-violet);outline-offset:2px}
.pg-status{font-size:13px;color:var(--pg-muted);min-height:20px;margin-top:6px;white-space:pre-wrap}
.pg-status[data-error=true]{color:#ff9d9d}
.pg-scroll{flex:1;min-height:0;overflow-y:auto;padding:18px}
.pg-group{margin-bottom:22px}
.pg-group h3{font-size:13px;color:var(--pg-muted);font-weight:600;margin:0 0 8px}
.pg-piece{border-left:3px solid var(--pg-violet);background:var(--pg-raise);border-radius:0 8px 8px 0;margin-bottom:8px}
.pg-piece summary{padding:9px 12px;cursor:pointer;display:flex;gap:8px;align-items:center}
.pg-piece summary span:first-child{flex:1;font-weight:600}
.pg-piece .pg-inner{padding:0 12px 12px}
.pg-piece textarea{min-height:240px;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
.pg-piece label{display:flex;gap:8px;align-items:center;font-size:13px}
.pg-note{font-size:12px;color:var(--pg-muted)}
.pg-make{border:1px solid var(--pg-violet);border-radius:12px;padding:16px;margin-top:8px}
.pg-make h3{color:var(--pg-ink);font-size:16px;margin:0 0 4px}
.pg-field{display:flex;flex-direction:column;gap:6px;margin:12px 0}
.pg-field>span{font-size:13px;font-weight:600}
.pg-check{display:flex;gap:8px;align-items:flex-start;margin:12px 0;font-size:14px}
.pg-check input{margin-top:4px}
.pg-empty{color:var(--pg-muted);padding:30px 0;text-align:center}
.pg-app [hidden]{display:none!important}
.pg-app.pg-typing .pg-top{display:none}.pg-app.pg-typing .pg-tabs{margin-top:0}.pg-app.pg-typing .pg-log{padding-top:10px}
@media (max-width:480px){.pg-top,.pg-log,.pg-scroll{padding-left:14px;padding-right:14px}.pg-compose{padding:8px 14px 12px}.pg-tabs{padding:0 8px}.pg-mode{margin-left:0}}
@media (prefers-reduced-motion:no-preference){.pg-ticket.pg-new{animation:pg-pin .5s ease-out}@keyframes pg-pin{from{background-color:var(--pg-violet-soft)}to{background-color:transparent}}}
`;
var TYPE_ORDER = [...BLOCK_TYPES];
var COMMANDS = ["skip", "you decide", "back", "sheet", "next", "done"];
function setup(ctx, options = {}) {
  let closed = false, busy = false, remoteBusy = false, session = null, snapshot = null;
  let streaming = null;
  let castTimer = null;
  const rpc = createRpc(ctx, (next, nextBusy) => {
    if (closed)
      return;
    remoteBusy = nextBusy;
    if (!busy) {
      session = next;
      render();
    }
  });
  const tab = ctx.ui.registerDrawerTab({
    id: "paige",
    title: "Paige",
    shortName: "Paige",
    description: "Build characters, a scenario and lore with Paige, then make the card",
    keywords: ["character", "card", "lorebook", "scenario", "creator", "persona", "writing"],
    iconSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h3"/></svg>'
  });
  const removeStyle = ctx.dom.addStyle(STYLES);
  const app = el("div", undefined, "pg-app");
  tab.root.append(app);
  const top = el("div", undefined, "pg-top");
  const heading = el("div");
  heading.append(el("h1", "Paige", "pg-title"), el("p", "Builds your characters, scenario and lore with you, then makes the card.", "pg-sub"));
  top.append(heading);
  const tabs = el("div", undefined, "pg-tabs");
  tabs.setAttribute("role", "tablist");
  const views = { chat: el("section", undefined, "pg-view"), sheet: el("section", undefined, "pg-view"), settings: el("section", undefined, "pg-view") };
  const tabButtons = {};
  const show = (name) => {
    for (const [key, view] of Object.entries(views)) {
      view.hidden = key !== name;
      tabButtons[key].setAttribute("aria-selected", String(key === name));
    }
    try {
      localStorage.setItem("paige.tab", name);
    } catch {}
    if (name === "chat")
      log.scrollTop = log.scrollHeight;
  };
  for (const [key, label] of [["chat", "Chat"], ["sheet", "Sheet"], ["settings", "Settings"]]) {
    const b = el("button", label);
    b.type = "button";
    b.setAttribute("role", "tab");
    b.addEventListener("click", () => show(key));
    tabButtons[key] = b;
    tabs.append(b);
  }
  app.append(top, tabs, views.chat, views.sheet, views.settings);
  const log = el("div", undefined, "pg-log");
  log.setAttribute("aria-live", "polite");
  const compose = el("div", undefined, "pg-compose");
  const chips = el("div", undefined, "pg-chips");
  for (const command of COMMANDS) {
    const b = el("button", command[0].toUpperCase() + command.slice(1));
    b.type = "button";
    b.title = `Send “${command}”`;
    b.addEventListener("click", () => void sendText(command));
    chips.append(b);
  }
  const mode = el("div", undefined, "pg-mode");
  mode.setAttribute("role", "group");
  mode.setAttribute("aria-label", "Interview");
  const modeButtons = ["full", "quick"].map((m) => {
    const b = el("button", m === "full" ? "Full interview" : "Quick draft");
    b.type = "button";
    b.title = m === "full" ? "Paige asks one section at a time." : "Paige drafts the whole piece from your pitch, then fixes the weak spots with you.";
    b.addEventListener("click", () => {
      if (session?.mode !== m)
        act(() => rpc.request("setMode", { mode: m }).then((s) => {
          session = s;
          notify(m === "quick" ? "Quick draft is on. Paige will rough out each piece, then go after the weak spots." : "Full interview is on. Paige asks one section at a time.");
        }));
    });
    mode.append(b);
    return b;
  });
  chips.append(mode);
  const box = el("textarea");
  box.rows = 1;
  box.placeholder = "Answer Paige…";
  box.setAttribute("aria-label", "Your message");
  const sendButton = el("button", "Send", "pg-btn pg-primary");
  sendButton.type = "button";
  const stopButton = el("button", "Stop", "pg-btn");
  stopButton.type = "button";
  const retryButton = el("button", "Retry", "pg-btn");
  retryButton.type = "button";
  retryButton.title = "Take back Paige’s last reply and ask again";
  const status = el("div", undefined, "pg-status");
  status.setAttribute("role", "status");
  const row = el("div", undefined, "pg-row");
  row.append(box, sendButton, stopButton, retryButton);
  compose.append(chips, row, status);
  views.chat.append(log, compose);
  const grow = () => {
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 180)}px`;
  };
  box.addEventListener("input", grow);
  const view = globalThis.visualViewport;
  let fitTimers = [];
  const fit = () => {
    if (closed || !view)
      return;
    const typing = document.activeElement === box && window.innerHeight - view.height > 100;
    if (!typing) {
      if (app.classList.contains("pg-typing")) {
        app.classList.remove("pg-typing");
        app.style.height = "";
        app.style.minHeight = "";
        log.scrollTop = log.scrollHeight;
      }
      return;
    }
    app.classList.add("pg-typing");
    const visibleTop = view.offsetTop, visibleBottom = view.offsetTop + view.height;
    const top = Math.max(app.getBoundingClientRect().top, visibleTop);
    app.style.minHeight = "0";
    app.style.height = `${Math.max(220, Math.round(visibleBottom - top))}px`;
    log.scrollTop = log.scrollHeight;
  };
  const fitSoon = () => {
    fit();
    fitTimers.forEach(clearTimeout);
    fitTimers = [120, 350, 700].map((ms) => setTimeout(fit, ms));
  };
  view?.addEventListener("resize", fitSoon);
  view?.addEventListener("scroll", fit);
  box.addEventListener("focus", fitSoon);
  box.addEventListener("blur", () => setTimeout(fitSoon, 50));
  box.addEventListener("keydown", (e) => {
    const touch = matchMedia?.("(pointer: coarse)").matches;
    if (e.key === "Enter" && !e.shiftKey && (!touch || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendText(box.value);
    }
  });
  sendButton.addEventListener("click", () => void sendText(box.value));
  stopButton.addEventListener("click", () => void rpc.request("stop").catch(() => {}));
  retryButton.addEventListener("click", () => void talk("retry"));
  const sheetScroll = el("div", undefined, "pg-scroll");
  const pieces = el("div");
  const make = el("section", undefined, "pg-make");
  const makeTitle = el("h3", "Make my card");
  const makeHint = el("p", "Main character goes in the description, scenario in the scenario field, everyone and everything else in the card’s lorebook. Kept first messages become the greetings.", "pg-note");
  const cardName = el("input");
  cardName.type = "text";
  cardName.maxLength = 120;
  const nameField = el("label", undefined, "pg-field");
  nameField.append(el("span", "Card name"), cardName);
  const looks = el("input");
  looks.type = "checkbox";
  try {
    looks.checked = localStorage.getItem("paige.looks") !== "0";
  } catch {
    looks.checked = true;
  }
  looks.addEventListener("change", () => {
    try {
      localStorage.setItem("paige.looks", looks.checked ? "1" : "0");
    } catch {}
  });
  const looksRow = el("label", undefined, "pg-check");
  looksRow.append(looks, el("span", "Also send everyone’s looks to LumiCast, so they show up in Lumi Studio ready to draw"));
  const makeButton = el("button", "Make my card", "pg-btn pg-primary");
  makeButton.type = "button";
  const resendButton = el("button", "Send looks again", "pg-btn");
  resendButton.type = "button";
  const makeStatus = el("div", undefined, "pg-status");
  makeStatus.setAttribute("role", "status");
  const makeRow = el("div", undefined, "pg-row");
  makeRow.append(makeButton, resendButton);
  make.append(makeTitle, makeHint, nameField, looksRow, makeRow, makeStatus);
  sheetScroll.append(pieces, make);
  views.sheet.append(sheetScroll);
  makeButton.addEventListener("click", () => void act(async () => {
    makeNotify("Making the card…");
    const result = await rpc.request("makeCard", { name: cardName.value, sendLooks: looks.checked });
    session = result.session;
    const made = [
      `${result.updated ? "Updated" : "Made"} “${result.name}” with ${result.entries} lorebook ${result.entries === 1 ? "entry" : "entries"} and ${result.greetings} ${result.greetings === 1 ? "greeting" : "greetings"}.`,
      result.personaName ? `Persona “${result.personaName}” is ready.` : "",
      result.personaNote,
      ...result.notes
    ].filter(Boolean);
    makeNotify(made.join(`
`));
    if (result.cast)
      castNews(result.cast, made.join(`
`));
  }));
  resendButton.addEventListener("click", () => void act(async () => {
    const cast = await rpc.request("sendLooks");
    castNews(cast, "");
  }));
  const settingsScroll = el("div", undefined, "pg-scroll");
  const connection = el("select");
  const thinking = el("select");
  for (const [value, label] of [["light", "Light (quick think, the default)"], ["off", "Off"], ["inherit", "Use the connection’s own setting"]]) {
    const o = el("option", label);
    o.value = value;
    thinking.append(o);
  }
  const saveSettings = el("button", "Save settings", "pg-btn pg-primary");
  saveSettings.type = "button";
  const settingsStatus = el("div", undefined, "pg-status");
  const field = (label, input, hint) => {
    const w = el("label", undefined, "pg-field");
    w.append(el("span", label), input, el("small", hint, "pg-note"));
    return w;
  };
  const startOver = el("button", "Start over", "pg-btn");
  startOver.type = "button";
  let armed = null;
  startOver.addEventListener("click", () => {
    if (!armed) {
      startOver.textContent = "Press again to clear the chat and Sheet";
      armed = setTimeout(() => {
        armed = null;
        startOver.textContent = "Start over";
      }, 4000);
      return;
    }
    clearTimeout(armed);
    armed = null;
    startOver.textContent = "Start over";
    act(() => rpc.request("startOver", { mode: session?.mode ?? "full" }).then((s) => {
      session = s;
      cardName.value = "";
      makeStatus.textContent = "";
      settingsNotify("Started over. Cards you already made are still in Lumiverse.");
      show("chat");
    }));
  });
  settingsScroll.append(field("Model connection", connection, "The model Paige talks with. It doesn’t have to be your story model."), field("Thinking", thinking, "How long the model thinks before each reply. Light keeps Paige quick."), el("div", undefined, "pg-row"), settingsStatus, el("hr"), el("p", "Start a new card from scratch. The old chat is kept in Paige’s storage, and cards you already made stay in Lumiverse.", "pg-note"), startOver, el("p", "Paige and her interview are by Deiomo (deiomo.github.io), used with permission.", "pg-note"));
  settingsScroll.children[2].append(saveSettings);
  views.settings.append(settingsScroll);
  saveSettings.addEventListener("click", () => void act(async () => {
    await rpc.request("saveSettings", { connectionId: connection.value, thinking: thinking.value });
    settingsNotify("Saved.");
  }));
  function notify(text, error = false) {
    if (closed)
      return;
    status.textContent = text;
    status.dataset.error = String(error);
  }
  function makeNotify(text, error = false) {
    if (closed)
      return;
    makeStatus.textContent = text;
    makeStatus.dataset.error = String(error);
  }
  function settingsNotify(text, error = false) {
    if (closed)
      return;
    settingsStatus.textContent = text;
    settingsStatus.dataset.error = String(error);
  }
  async function act(run) {
    if (busy || closed)
      return;
    busy = true;
    update();
    try {
      await run();
    } catch (e) {
      const m = e instanceof Error ? e.message : "That didn’t work.";
      notify(m, true);
      makeNotify(m, true);
      settingsNotify(m, true);
    } finally {
      busy = false;
      if (!closed)
        render();
    }
  }
  function sendText(text) {
    if (!text.trim())
      return;
    if (!snapshot?.settings.connectionId) {
      show("settings");
      settingsNotify("Pick a model connection for Paige first.", true);
      return;
    }
    return talk("send", text);
  }
  async function talk(action, text) {
    if (busy || closed || remoteBusy)
      return;
    busy = true;
    if (action === "send" && session) {
      session.turns.push({ role: "user", content: text.trim(), at: Date.now() });
      box.value = "";
      grow();
    }
    if (action === "retry" && session && session.turns[session.turns.length - 1]?.role === "assistant" && session.turns.length > 1)
      session.turns.pop();
    renderLog();
    const node = el("div", undefined, "pg-msg pg-paige");
    node.append(el("p", "Paige is writing…", "pg-working"));
    log.append(node);
    log.scrollTop = log.scrollHeight;
    streaming = { node, text: "" };
    update();
    notify("");
    try {
      const result = await rpc.request(action, action === "send" ? { text } : {}, (partial) => {
        if (!streaming)
          return;
        const near = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
        streaming.text = partial;
        streaming.node.replaceChildren();
        message(streaming.node, partial);
        if (near)
          log.scrollTop = log.scrollHeight;
      });
      session = result.session;
      if (result.cutOff)
        notify("Paige’s reply hit the length limit and was cut off. Press Retry, or ask her to finish.");
      else if (result.stopped)
        notify("Stopped. What she wrote so far is kept.");
    } catch (e) {
      notify(e instanceof Error ? e.message : "Paige didn’t answer.", true);
      try {
        const fresh = await rpc.request("snapshot");
        snapshot = fresh;
        session = fresh.session;
      } catch {}
    } finally {
      streaming = null;
      busy = false;
      if (!closed)
        render();
    }
  }
  function castNews(cast, before) {
    makeNotify([before, cast.message].filter(Boolean).join(`
`), cast.state === "failed");
    if (cast.state !== "started")
      return;
    if (castTimer)
      clearInterval(castTimer);
    let quiet = 0;
    castTimer = setInterval(async () => {
      if (closed)
        return;
      const s = await rpc.request("lumicastStatus").catch(() => null);
      if (!s) {
        if (++quiet > 20 && castTimer) {
          clearInterval(castTimer);
          castTimer = null;
        }
        return;
      }
      const lines = s.finished.map((f) => `${f.ok ? "In Lumi Studio" : "Didn’t make it"}: ${f.name}${f.ok ? "" : ` (${f.message})`}`);
      const head = s.running ? `LumiCast: ${s.done} of ${s.total} done${s.current ? `, working on ${s.current}` : ""}…` : `LumiCast finished ${s.done} of ${s.total}.`;
      makeNotify([before, head, ...lines].filter(Boolean).join(`
`), !s.running && s.finished.some((f) => !f.ok));
      if (!s.running && castTimer) {
        clearInterval(castTimer);
        castTimer = null;
      }
    }, options.castPollMs ?? 3000);
  }
  function renderLog() {
    log.replaceChildren();
    if (!session)
      return;
    const lastSaved = session.turns.length - 1;
    session.turns.forEach((turn, index) => {
      const node = el("div", undefined, `pg-msg ${turn.role === "user" ? "pg-user" : "pg-paige"}`);
      if (turn.role === "user")
        node.textContent = turn.content;
      else {
        message(node, turn.content);
        if (turn.saved?.length)
          node.append(el("div", turn.saved.join(" · ") + " — see the Sheet tab.", "pg-saved"));
        if (index === lastSaved && Date.now() - turn.at < 4000)
          node.querySelectorAll(".pg-ticket").forEach((t) => t.classList.add("pg-new"));
      }
      log.append(node);
    });
    log.scrollTop = log.scrollHeight;
  }
  function piece(block) {
    const box = el("details", undefined, "pg-piece");
    const head = el("summary");
    head.append(el("span", block.name || block.type));
    if (block.edited)
      head.append(el("span", "edited by you", "pg-note"));
    const inner = el("div", undefined, "pg-inner");
    const pre = el("pre", block.body);
    const edit = el("button", "Edit", "pg-btn");
    edit.type = "button";
    const del = el("button", "Delete", "pg-btn");
    del.type = "button";
    const actions = el("div", undefined, "pg-row");
    actions.append(edit, del);
    if (block.type === "First message") {
      const keep = el("input");
      keep.type = "checkbox";
      keep.checked = block.keep !== false;
      const keepRow = el("label");
      keepRow.append(keep, el("span", "Use on the card"));
      keep.addEventListener("change", () => void act(() => rpc.request("keepFirst", { id: block.id, keep: keep.checked }).then((s) => {
        session = s;
      })));
      actions.prepend(keepRow);
    }
    inner.append(pre, el("div"), actions);
    let armedDelete = null;
    del.addEventListener("click", () => {
      if (!armedDelete) {
        del.textContent = "Press again to delete";
        armedDelete = setTimeout(() => {
          armedDelete = null;
          del.textContent = "Delete";
        }, 4000);
        return;
      }
      clearTimeout(armedDelete);
      act(() => rpc.request("deleteBlock", { id: block.id }).then((s) => {
        session = s;
      }));
    });
    edit.addEventListener("click", () => {
      const area = el("textarea");
      area.value = block.body;
      area.setAttribute("aria-label", `Edit ${block.name}`);
      const save = el("button", "Save", "pg-btn pg-primary");
      save.type = "button";
      const cancel = el("button", "Cancel", "pg-btn");
      cancel.type = "button";
      const editRow = el("div", undefined, "pg-row");
      editRow.append(save, cancel);
      inner.replaceChildren(area, el("p", "Paige will use your version from now on.", "pg-note"), editRow);
      area.focus();
      cancel.addEventListener("click", () => renderSheet());
      save.addEventListener("click", () => void act(() => rpc.request("editBlock", { id: block.id, body: area.value }).then((s) => {
        session = s;
      })));
    });
    box.append(head, inner);
    return box;
  }
  function renderSheet() {
    const open = new Set([...pieces.querySelectorAll("details[open]")].map((d) => d.dataset.id));
    pieces.replaceChildren();
    const blocks = session?.blocks ?? [];
    if (!blocks.length)
      pieces.append(el("p", "Nothing here yet. Every piece Paige finishes lands on this Sheet.", "pg-empty"));
    for (const type of TYPE_ORDER) {
      const group = blocks.filter((b) => b.type === type);
      if (!group.length)
        continue;
      const section = el("div", undefined, "pg-group");
      section.append(el("h3", type === "First message" ? "First messages" : type === "History" ? "History" : type === "Persona" ? "Your persona" : `${type}${group.length > 1 ? "s" : ""}`));
      for (const block of group) {
        const node = piece(block);
        node.dataset.id = block.id;
        if (open.has(block.id))
          node.open = true;
        section.append(node);
      }
      pieces.append(section);
    }
    const main = blocks.find((b) => b.type === "Main character");
    cardName.placeholder = main?.name || "Name the card";
    if (!cardName.value && session?.card?.name)
      cardName.value = session.card.name;
    makeTitle.textContent = session?.card ? "Update my card" : "Make my card";
    makeButton.textContent = session?.card ? `Update “${session.card.name}”` : "Make my card";
    resendButton.hidden = !session?.card;
    const count = blocks.filter((b) => b.type !== "First message").length;
    tabButtons.sheet.textContent = count ? `Sheet (${count})` : "Sheet";
  }
  function update() {
    const working = busy || remoteBusy;
    sendButton.hidden = working && !!streaming;
    stopButton.hidden = !(working && (streaming || remoteBusy));
    sendButton.disabled = working;
    box.disabled = false;
    retryButton.disabled = working || !session || session.turns.length < 2;
    for (const b of chips.querySelectorAll("button"))
      b.disabled = working;
    modeButtons.forEach((b, i) => b.setAttribute("aria-pressed", String((session?.mode ?? "full") === ["full", "quick"][i])));
    makeButton.disabled = working || !session?.blocks.some((b) => b.type !== "First message");
    resendButton.disabled = working;
    saveSettings.disabled = working;
    startOver.disabled = working;
  }
  function render() {
    renderLog();
    renderSheet();
    update();
  }
  async function load() {
    snapshot = await rpc.request("snapshot");
    if (closed)
      return;
    session = snapshot.session;
    remoteBusy = snapshot.busy;
    connection.replaceChildren(el("option", "Pick a connection"));
    connection.firstChild.value = "";
    for (const c of snapshot.connections) {
      const o = el("option", `${c.name} · ${c.model}`);
      o.value = c.id;
      connection.append(o);
    }
    connection.value = snapshot.settings.connectionId;
    thinking.value = snapshot.settings.thinking;
    render();
    const missing = Object.entries(snapshot.permissions).filter(([, ok]) => !ok).map(([p]) => p.replace("_", " "));
    if (!snapshot.settings.connectionId) {
      show("settings");
      settingsNotify("Pick the model connection Paige should use, then save.");
    }
    if (missing.length)
      notify(`Paige needs these permissions in Extensions: ${missing.join(", ")}.`, true);
  }
  saveSettings.addEventListener("click", () => {
    if (snapshot)
      snapshot.settings = { connectionId: connection.value, thinking: thinking.value };
  });
  let start = "chat";
  try {
    const saved = localStorage.getItem("paige.tab");
    if (saved === "sheet" || saved === "settings")
      start = saved;
  } catch {}
  show(start);
  busy = true;
  update();
  load().catch((e) => notify(e instanceof Error ? e.message : "Paige couldn’t load.", true)).finally(() => {
    busy = false;
    if (!closed)
      update();
  });
  return () => {
    closed = true;
    view?.removeEventListener("resize", fitSoon);
    view?.removeEventListener("scroll", fit);
    fitTimers.forEach(clearTimeout);
    if (castTimer)
      clearInterval(castTimer);
    if (armed)
      clearTimeout(armed);
    rpc.destroy();
    removeStyle();
    tab.destroy();
  };
}
export {
  createRpc,
  setup
};
