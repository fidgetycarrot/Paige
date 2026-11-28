/** Turning a Lumiverse dry run (the full prompt the main model gets for a chat) into a report Paige can read. No host calls here. */

export interface DryRunPiece { type: string; name: string; role?: string; content?: string; messageCount?: number; preCountedTokens?: number; extensionName?: string; excludeFromTotal?: boolean }
export interface DryRunIn {
  messages: { role: string; content: unknown }[];
  breakdown: DryRunPiece[];
  model?: string; provider?: string;
  tokenCount?: { total_tokens: number; breakdown: { name: string; type: string; tokens: number; extensionName?: string }[] };
  worldInfoStats?: { totalCandidates?: number; activatedAfterBudget?: number; evictedByBudget?: number; estimatedTokens?: number };
  memoryStats?: { enabled?: boolean; chunksRetrieved?: number };
}

/** Kinds of pieces, in plain words, so the report reads well for Paige and for anyone reading over her shoulder. */
const KIND: Record<string, string> = {
  block: 'Preset block', text: 'Preset text', utility: 'Preset utility', world_info: 'Lorebook entries that fired', chat_history: 'Chat history',
  long_term_memory: 'Long-term memory', authors_note: "Author's note", databank: 'Databank', databank_mention: 'Databank', append: 'Appended text', adaptive: 'Adaptive',
};
const PIECE_MAX = 5_000;

const textOf = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(p => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string') ? (p as { text: string }).text : '').join('\n') : '';
const cut = (s: string, max: number) => s.length > max ? `${s.slice(0, max)}\n[… ${(s.length - max).toLocaleString('en-US')} more characters left out]` : s;

/** The report, within a budget. Chat history is only counted: Paige reads the story itself through roleplay reading. */
export function dryRunText(run: DryRunIn, chatName: string, budget = 60_000): { text: string; tokens: number } {
  const tokens = run.tokenCount?.total_tokens ?? run.breakdown.reduce((n, p) => n + (p.excludeFromTotal ? 0 : p.preCountedTokens ?? 0), 0);
  const tokensFor = (p: DryRunPiece) => run.tokenCount?.breakdown.find(t => t.name === p.name && t.type === p.type)?.tokens ?? p.preCountedTokens;
  const head = [
    `# What the model sees: “${chatName}”`,
    `Model: ${[run.provider, run.model].filter(Boolean).join(' / ') || 'unknown'}. About ${tokens.toLocaleString('en-US')} tokens in all.`,
    run.worldInfoStats ? `Lorebook: ${run.worldInfoStats.activatedAfterBudget ?? 0} of ${run.worldInfoStats.totalCandidates ?? 0} entries fired (${(run.worldInfoStats.estimatedTokens ?? 0).toLocaleString('en-US')} tokens)${run.worldInfoStats.evictedByBudget ? `, ${run.worldInfoStats.evictedByBudget} dropped for lack of room` : ''}.` : '',
    run.memoryStats?.enabled ? `Chat memory: ${run.memoryStats.chunksRetrieved ?? 0} old passages pulled back in.` : '',
  ].filter(Boolean);
  // The list of pieces with sizes, in prompt order.
  const list = run.breakdown.map(p => {
    const size = tokensFor(p);
    const from = p.extensionName ? ` (added by the ${p.extensionName} extension)` : '';
    const count = p.type === 'chat_history' && p.messageCount ? `, ${p.messageCount} messages` : '';
    return `- ${KIND[p.type] ?? p.type}: ${p.name || 'unnamed'}${from}${count}${size ? `, ~${size.toLocaleString('en-US')} tokens` : ''}`;
  });
  const parts = [...head, '', '## Pieces, in order', ...list, '', '## What each piece says'];
  let used = parts.join('\n').length;
  const shown = new Set<string>();
  let full = false;
  const add = (title: string, body: string) => {
    const piece = `### ${title}\n${cut(body.trim(), PIECE_MAX)}`;
    if (full || used + piece.length > budget) { full = true; return false; }
    parts.push(piece); used += piece.length; shown.add(body.trim().slice(0, 160));
    return true;
  };
  for (const p of run.breakdown) {
    if (p.type === 'chat_history' || !p.content?.trim()) continue;
    if (!add(`${KIND[p.type] ?? p.type}: ${p.name || 'unnamed'}${p.extensionName ? ` (${p.extensionName})` : ''}`, p.content)) break;
  }
  // Extension notes don't always show up as labeled pieces; anything system-level that isn't above came from somewhere else.
  for (const m of run.messages) {
    if (m.role !== 'system') continue;
    const body = textOf(m.content).trim();
    if (!body || [...shown].some(s => body.includes(s) || s.includes(body.slice(0, 160)))) continue;
    if (!add('Not labeled (probably an extension or a macro)', body)) break;
  }
  if (full) parts.push('\n[The report hit its size limit; some pieces aren’t shown. Ask for another look at a specific piece if you need it.]');
  return { text: parts.join('\n'), tokens };
}
