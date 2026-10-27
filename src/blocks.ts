/** Reading Paige's finished blocks out of her replies, keeping the Sheet, and laying the Sheet out as a card. No host calls here. */

export const BLOCK_TYPES = ['Main character', 'Side character', 'Scenario', 'Location', 'Item', 'Faction', 'History', 'Concept', 'Persona', 'First message'] as const;
export type BlockType = typeof BLOCK_TYPES[number];
export type Mode = 'full' | 'quick';
export const LORE_TYPES: BlockType[] = ['Location', 'Item', 'Faction', 'History', 'Concept'];

export interface Block {
  id: string;
  type: BlockType;
  name: string;
  /** The sheet text without the label line. */
  body: string;
  updatedAt: number;
  /** First messages only: whether it goes on the card. */
  keep?: boolean;
  /** True once the user changed it on the Sheet. */
  edited?: boolean;
}

const LABELS: Record<string, BlockType> = {
  'main character': 'Main character', 'main': 'Main character', 'character': 'Main character',
  'side character': 'Side character', 'side': 'Side character', 'npc': 'Side character',
  'scenario': 'Scenario',
  'location': 'Location', 'item': 'Item', 'faction': 'Faction', 'history': 'History', 'history event': 'History', 'event': 'History', 'concept': 'Concept',
  'persona': 'Persona', 'user persona': 'Persona',
  'first message': 'First message', 'greeting': 'First message', 'opening message': 'First message', 'alternate greeting': 'First message',
};

/** "**Side character:**", "## Location", "Block: Item", "First message 2" all count. */
export function labelOf(line: string): BlockType | null {
  let text = line.trim().replace(/^[#>*_\s]+|[*_\s:]+$/g, '').replace(/^(?:block|type)\s*[:\-–—]\s*/i, '').trim().toLowerCase();
  text = text.replace(/\s*(?:block)$/, '').replace(/\s*(?:#?\d+|\(\d+\))$/, '').replace(/\s*[:\-–—].*$/, '').trim();
  return LABELS[text] ?? null;
}

const nameLine = /^[ \t]*[*_]*Name[*_]*[ \t]*:[*_]*[ \t]*(.+?)[ \t]*$/im;
export function fieldOf(body: string, label: string): string {
  const re = new RegExp(`^[ \\t]*[*_]*${label.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}[*_]*[ \\t]*:[*_]*[ \\t]*(.+?)[ \\t]*$`, 'im');
  return re.exec(body)?.[1]?.trim() ?? '';
}
export function listOf(value: string): string[] {
  const seen = new Set<string>();
  return value.split(/[,;\/]/).map(v => v.replace(/^["'“”]+|["'“”.]+$/g, '').trim()).filter(v => v && !/^(?:none|n\/a|-)$/i.test(v) && !seen.has(v.toLowerCase()) && seen.add(v.toLowerCase()));
}

export interface ParsedBlock { type: BlockType; name: string; body: string }

/** Every labeled code block in a reply, in order. Unlabeled fences (sample lines, anything else) are left alone. */
export function parseBlocks(reply: string): ParsedBlock[] {
  const found: ParsedBlock[] = [];
  const fences = /(^|\n)[ \t]*(```+|~~~+)([^\n]*)\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g;
  for (const match of reply.matchAll(fences)) {
    const info = match[3].trim();
    let content = match[4].replace(/\r/g, '');
    let type = info ? labelOf(info) : null;
    if (!type) {
      const lines = content.split('\n');
      const first = lines.findIndex(l => l.trim());
      if (first < 0) continue;
      type = labelOf(lines[first]);
      if (!type) continue;
      content = lines.slice(first + 1).join('\n');
    }
    const body = content.trim();
    if (!body) continue;
    const name = type === 'Scenario' ? (fieldOf(body, 'Name') || 'Scenario') : type === 'First message' ? '' : (nameLine.exec(body)?.[1]?.replace(/[*_]+/g, '').trim() ?? '');
    found.push({ type, name: name.slice(0, 120) || (type === 'First message' ? '' : type), body });
  }
  return found;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** New version replaces the old one with the same type and name; first messages always add. Returns what changed, for the chat. */
export function upsertBlocks(sheet: Block[], parsed: ParsedBlock[], now = Date.now(), id = () => crypto.randomUUID()): { sheet: Block[]; added: Block[]; replaced: Block[] } {
  const next = sheet.map(b => ({ ...b }));
  const added: Block[] = [], replaced: Block[] = [];
  for (const p of parsed) {
    if (p.type !== 'First message') {
      // There is one scenario per story; a second Scenario block is a revision.
      const index = next.findIndex(b => b.type === p.type && (p.type === 'Scenario' || same(b.name, p.name)));
      if (index >= 0) {
        next[index] = { ...next[index], name: p.name, body: p.body, updatedAt: now, edited: false };
        replaced.push(next[index]);
        continue;
      }
    } else if (next.some(b => b.type === 'First message' && b.body.trim() === p.body.trim())) continue;
    const block: Block = { id: id(), type: p.type, name: p.name || (p.type === 'First message' ? `First message ${next.filter(b => b.type === 'First message').length + 1}` : p.type), body: p.body, updatedAt: now, ...(p.type === 'First message' ? { keep: true } : {}) };
    next.push(block);
    added.push(block);
  }
  return { sheet: next, added, replaced };
}

export function fence(block: Block): string {
  return '```\n' + block.type + '\n' + block.body.trim() + '\n```';
}

/** "## Appearance & vibe" sections, by title. */
export function sections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = body.split(/^[ \t]*#{2,3}[ \t]+(.+?)[ \t]*#*[ \t]*$/m);
  for (let i = 1; i < parts.length; i += 2) out.set(parts[i].replace(/[*_]+/g, '').trim().toLowerCase(), parts[i + 1].trim());
  return out;
}
function pick(body: string, titles: string[]): string[] {
  const all = sections(body);
  return titles.flatMap(title => {
    const key = [...all.keys()].find(k => k === title || k.replace(/\band\b/g, '&') === title || k.startsWith(title));
    const text = key ? all.get(key)!.trim() : '';
    return text ? [`## ${title.replace(/(^|\s)\S/g, c => c.toUpperCase())}\n${text}`] : [];
  });
}

export interface Look { name: string; aliases: string[]; kind: 'character' | 'persona'; description: string }

/** What LumiCast needs to draw someone: who they are, what they look like. Clothes go in too; LumiCast keeps them apart. */
export function looksFrom(blocks: Block[]): Look[] {
  const looks: Look[] = [];
  for (const b of blocks) {
    const kind = b.type === 'Persona' ? 'persona' : 'character';
    const parts = b.type === 'Main character' ? pick(b.body, ['identity', 'appearance & vibe', 'body & intimate details'])
      : b.type === 'Side character' ? pick(b.body, ['identity', 'look'])
      : b.type === 'Persona' ? pick(b.body, ['identity', 'appearance', 'body & intimate details'])
      : [];
    // Without a look section there is nothing to draw.
    if (!parts.some(p => !p.startsWith('## Identity'))) continue;
    looks.push({ name: b.name, aliases: listOf(fieldOf(b.body, 'Aliases')).slice(0, 8), kind, description: `${b.name} — appearance:\n\n${parts.join('\n\n')}`.slice(0, 12_000) });
  }
  return looks;
}

export const PLAYER_RULE = 'This is the human-controlled player. These are starting facts, not a script. During live play the human supplies their actions, dialogue, thoughts, feelings and decisions.';

export interface EntryPlan { comment: string; key: string[]; content: string; constant: boolean }
export interface CardPlan {
  card: { name: string; description: string; scenario: string; first_mes: string; alternate_greetings: string[]; tags: string[]; creator: string; creator_notes: string };
  entries: EntryPlan[];
  persona: { name: string; title: string; description: string } | null;
  notes: string[];
}

/** Where each piece goes, as Paige's Job section says: main character in the description, scenario in the scenario field, everyone and everything else in the lorebook. */
export function planCard(blocks: Block[], options: { name?: string } = {}): CardPlan {
  const of = (type: BlockType) => blocks.filter(b => b.type === type);
  const mains = of('Main character'), scenarios = of('Scenario'), notes: string[] = [];
  const name = (options.name?.trim() || mains[0]?.name || fieldOf(scenarios[0]?.body ?? '', 'Location') || 'New story').slice(0, 120);
  if (!mains.length) notes.push('There is no main character, so the card description says what the story is instead.');
  const entries: EntryPlan[] = [];
  // A second main character can't share the description, so it rides in the lorebook, always on.
  for (const extra of mains.slice(1)) entries.push({ comment: `Main character · ${extra.name}`, key: [extra.name, ...listOf(fieldOf(extra.body, 'Aliases'))], content: `[Main character]\n${extra.body}`, constant: true });
  for (const extra of scenarios.slice(1)) entries.push({ comment: 'Scenario (more)', key: [], content: `[Scenario]\n${extra.body}`, constant: true });
  for (const side of of('Side character')) {
    entries.push({ comment: `Side character · ${side.name}`, key: [side.name, ...listOf(fieldOf(side.body, 'Aliases'))].slice(0, 12), content: `[Side character]\n${side.body}`, constant: false });
  }
  for (const type of LORE_TYPES) for (const lore of of(type)) {
    const triggers = listOf(fieldOf(lore.body, 'Trigger words'));
    // Blank trigger words key on the name, as the section notes say.
    entries.push({ comment: `${type} · ${lore.name}`, key: (triggers.length ? triggers : [lore.name]).slice(0, 16), content: `[${type}]\n${lore.body}`, constant: false });
  }
  const firsts = of('First message').filter(b => b.keep !== false).map(b => b.body.trim()).filter(Boolean);
  if (!firsts.length) notes.push('No first message is kept, so the chat will start empty.');
  const description = mains[0]?.body.trim() ?? [`${name}`, scenarios[0] ? 'The story is set out in the scenario. Characters and lore are in the lorebook.' : 'Characters and lore are in the lorebook.'].join('\n\n');
  const personaBlock = of('Persona')[0];
  if (of('Persona').length > 1) notes.push('There is more than one persona; only the first one is made.');
  return {
    card: {
      name, description, scenario: scenarios[0]?.body.trim() ?? '', first_mes: firsts[0] ?? '', alternate_greetings: firsts.slice(1),
      tags: ['Paige'], creator: 'Paige', creator_notes: 'Built with Paige. Paige by Deiomo (https://deiomo.github.io/).',
    },
    entries, notes,
    persona: personaBlock ? { name: personaBlock.name, title: name, description: `${personaBlock.body.trim()}\n\n${PLAYER_RULE}` } : null,
  };
}
