/** Bringing a card back to Paige: card → notebook pieces, and the notebook's changes → back to the card. No host calls here. */
import { fieldOf, LORE_TYPES, listOf, personaName, PLAYER_RULE, withoutAddedName, type Block, type BlockType, type CardField, type EntryPlan } from './blocks';
import { uuid } from './safe-id';

/** The card fields Paige can fix besides the description and scenario, with the names she uses for them. */
export const FIELD_NAMES: Record<Exclude<CardField, 'description' | 'scenario'>, string> = {
  personality: 'Personality', mes_example: 'Example dialogue', system_prompt: 'System prompt', post_history_instructions: 'Post-history instructions',
};
const fieldByName = (name: string): CardField | undefined =>
  (Object.entries(FIELD_NAMES) as [CardField, string][]).find(([, label]) => label.toLowerCase() === name.trim().toLowerCase())?.[0];

export interface CardIn {
  id: string; name: string; description: string; personality: string; scenario: string; first_mes: string; mes_example: string;
  system_prompt: string; post_history_instructions: string; alternate_greetings: string[]; world_book_ids: string[];
}
export interface EntryIn { id: string; world_book_id: string; key: string[]; content: string; comment: string; constant: boolean; disabled: boolean; extensions: Record<string, unknown> }

/** What the notebook remembers about the card it came from. */
export interface CardSource {
  characterId: string; name: string; bookIds: string[]; entryIds: string[]; greetings: string[];
  /** The lorebook Paige adds new entries to, once there is one. */
  paigeBookId?: string;
  /** Entries left out because the lorebook was very big; they stay as they are. */
  skipped: number;
  broughtAt: number;
}

export const MAX_ENTRIES = 300;
const PAIGE_LABEL = /^\[(Main character|Side character|Scenario|Location|Item|Faction|History|Concept)\]\n/;
const ALWAYS = '(always on)';

/** A card as notebook pieces. Paige's own entries come back as the pieces they were; anyone else's are Lore pieces. */
export function cardToBlocks(card: CardIn, entries: EntryIn[], id: () => string = () => uuid(), now = Date.now()): { blocks: Block[]; source: CardSource } {
  const blocks: Block[] = [];
  const add = (type: BlockType, name: string, body: string, extra: Partial<Block> = {}) => {
    const text = body.replace(/\r/g, '').trim();
    if (!text) return;
    blocks.push({ id: id(), type, name: name.trim().slice(0, 120) || type, body: text, updatedAt: now, origin: text, ...extra });
  };
  add('Main character', fieldOf(card.description, 'Name') || card.name, card.description, { source: { field: 'description' } });
  add('Scenario', 'Scenario', card.scenario, { source: { field: 'scenario' } });
  for (const [field, label] of Object.entries(FIELD_NAMES) as [CardField, string][]) add('Card field', label, String(card[field as keyof CardIn] ?? ''), { source: { field } });
  const greetings = [card.first_mes, ...(card.alternate_greetings ?? [])].map(g => (g ?? '').replace(/\r/g, '').trim()).filter(Boolean);
  greetings.forEach((g, i) => add('First message', `First message ${i + 1}`, g, { keep: true }));
  const live = entries.filter(e => !e.disabled);
  const used = live.slice(0, MAX_ENTRIES);
  for (const entry of used) {
    const mine = !!entry.extensions?.paige && PAIGE_LABEL.test(entry.content);
    if (mine) {
      const type = PAIGE_LABEL.exec(entry.content)![1] as BlockType;
      const body = entry.content.replace(PAIGE_LABEL, '');
      const name = fieldOf(body, 'Name') || entry.comment.replace(/^.*?·\s*/, '') || entry.key[0] || type;
      add(type, name, body, { source: { entryId: entry.id, bookId: entry.world_book_id } });
    } else {
      const name = entry.comment.trim() || entry.key[0] || 'Entry';
      const head = `Name: ${name}\nTrigger words: ${entry.constant ? ALWAYS : entry.key.join(', ')}`;
      add('Lore', name, `${head}\n\n${entry.content}`, { source: { entryId: entry.id, bookId: entry.world_book_id, foreign: true } });
    }
  }
  const paigeBook = entries.find(e => e.extensions?.paige)?.world_book_id;
  return {
    blocks,
    source: { characterId: card.id, name: card.name, bookIds: [...card.world_book_ids], entryIds: used.map(e => e.id), greetings, skipped: live.length - used.length, broughtAt: now, ...(paigeBook ? { paigeBookId: paigeBook } : {}) },
  };
}

/** A notebook piece as a lorebook entry, in Paige's usual layout, or back in the original layout for someone else's entry. */
export function entryFor(block: Block): EntryPlan & { foreign: boolean } {
  if (block.type === 'Lore' || block.source?.foreign) {
    let body = block.body.replace(/\r/g, '');
    const triggers = fieldOf(body, 'Trigger words');
    // The Name and Trigger words lines were added to show the entry to Paige; they come off again.
    body = body.replace(/^[ \t]*[*_]*Name[*_]*[ \t]*:.*\n?/im, '').replace(/^[ \t]*[*_]*Trigger words[*_]*[ \t]*:.*\n?/im, '').trim();
    const always = triggers.trim().toLowerCase() === ALWAYS;
    const key = always ? [] : listOf(triggers).slice(0, 24);
    return { comment: block.name, key: key.length || always ? key : [block.name], content: body, constant: always, foreign: true };
  }
  const aliases = listOf(fieldOf(block.body, 'Aliases'));
  if (block.type === 'Main character') return { comment: `Main character · ${block.name}`, key: [block.name, ...aliases], content: `[Main character]\n${block.body}`, constant: true, foreign: false };
  if (block.type === 'Scenario') return { comment: 'Scenario (more)', key: [], content: `[Scenario]\n${block.body}`, constant: true, foreign: false };
  if (block.type === 'Side character') return { comment: `Side character · ${block.name}`, key: [block.name, ...aliases].slice(0, 12), content: `[Side character]\n${block.body}`, constant: false, foreign: false };
  const triggers = listOf(fieldOf(block.body, 'Trigger words'));
  return { comment: `${block.type} · ${block.name}`, key: (triggers.length ? triggers : [block.name]).slice(0, 16), content: `[${block.type}]\n${block.body}`, constant: false, foreign: false };
}

const ENTRY_TYPES: BlockType[] = ['Side character', 'Lore', ...LORE_TYPES];
export const changed = (b: Block) => b.origin === undefined || withoutAddedName(b) !== withoutAddedName({ ...b, body: b.origin });

export interface FixPlan {
  /** Only the card fields that changed. */
  patch: Partial<Record<CardField, string>> & { first_mes?: string; alternate_greetings?: string[] };
  updates: { entryId: string; plan: EntryPlan }[];
  /** Pieces deleted from the notebook: their entries are switched off, not deleted, in case the lorebook is shared. */
  disable: string[];
  create: EntryPlan[];
  persona: { name: string; title: string; description: string } | null;
  notes: string[];
  /** Plain list of what will change, for the panel. */
  summary: string[];
}

export function planFix(blocks: Block[], source: CardSource): FixPlan {
  const notes: string[] = [], summary: string[] = [];
  const patch: FixPlan['patch'] = {};
  const updates: FixPlan['updates'] = [], create: EntryPlan[] = [];
  const fromField = (field: CardField) => blocks.find(b => b.source?.field === field);
  // Card fields
  for (const field of ['description', 'scenario', ...Object.keys(FIELD_NAMES)] as CardField[]) {
    const block = fromField(field);
    if (block && changed(block)) { patch[field] = withoutAddedName(block); summary.push(`card ${field === 'description' ? 'description' : field === 'scenario' ? 'scenario' : FIELD_NAMES[field as keyof typeof FIELD_NAMES].toLowerCase()}`); }
  }
  const hadDescription = !!fromField('description'), hadScenario = !!fromField('scenario');
  for (const block of blocks.filter(b => !b.source)) {
    if (block.type === 'Main character') {
      if (!hadDescription && patch.description === undefined) { patch.description = block.body.trim(); summary.push('card description'); }
      else { create.push(entryFor(block)); summary.push(`new lorebook entry: ${block.name}`); }
    } else if (block.type === 'Scenario') {
      if (!hadScenario && patch.scenario === undefined) { patch.scenario = block.body.trim(); summary.push('card scenario'); }
      else { create.push(entryFor(block)); summary.push('new lorebook entry: more scenario'); }
    } else if (block.type === 'Card field') {
      const field = fieldByName(block.name);
      if (field) { patch[field] = withoutAddedName(block); summary.push(`card ${FIELD_NAMES[field as keyof typeof FIELD_NAMES].toLowerCase()}`); }
      else notes.push(`“${block.name}” isn’t a card field Paige can fill, so it was left out.`);
    } else if (ENTRY_TYPES.includes(block.type)) { create.push(entryFor(block)); summary.push(`new lorebook entry: ${block.name}`); }
  }
  // Greetings, in order
  const greetings = blocks.filter(b => b.type === 'First message' && b.keep !== false).map(b => b.body.trim()).filter(Boolean);
  if (greetings.join('\u0000') !== source.greetings.join('\u0000')) {
    patch.first_mes = greetings[0] ?? ''; patch.alternate_greetings = greetings.slice(1);
    summary.push('greetings');
    if (!greetings.length) notes.push('No first message is kept, so new chats will start empty.');
  }
  // Lorebook entries that came from the card
  const present = new Set<string>();
  for (const block of blocks) {
    const entryId = block.source?.entryId;
    if (!entryId) continue;
    present.add(entryId);
    if (changed(block)) { updates.push({ entryId, plan: entryFor(block) }); summary.push(`lorebook entry: ${block.name}`); }
  }
  const disable = source.entryIds.filter(id => !present.has(id));
  if (disable.length) summary.push(`${disable.length} lorebook ${disable.length === 1 ? 'entry' : 'entries'} switched off`);
  // Persona, made the same way as for a new card
  const personaBlock = blocks.find(b => b.type === 'Persona');
  const realName = personaBlock ? personaName(personaBlock) : '';
  if (personaBlock && !realName) notes.push('Your persona doesn’t have a real name yet (it says {{user}}), so it wasn’t made. Give it a name in the notebook first.');
  const persona = personaBlock && realName ? { name: realName, title: source.name, description: `${personaBlock.body.trim().replace(/\{\{\s*user\s*\}\}/gi, realName)}\n\n${PLAYER_RULE}` } : null;
  return { patch, updates, disable, create, persona, notes, summary };
}
