import { CARD } from './paige-card';
import { BLOCK_TYPES, fence, type Block, type Mode } from './blocks';

/** Swap one exact passage of Dei's text. Throws if the passage is missing, so a changed card can't silently skip an edit. */
function replaceOnce(text: string, find: string, replace: string): string {
  const at = text.indexOf(find);
  if (at < 0 || text.indexOf(find, at + find.length) >= 0) throw new Error(`Paige prompt edit did not match exactly once: ${find.slice(0, 60)}`);
  return text.slice(0, at) + replace + text.slice(at + find.length);
}

/**
 * Paige's card description, with only the changes that come from running inside the extension:
 * the Sheet replaces "scroll up and copy", first messages and the persona come out as blocks the app can pick up.
 * Her personality, flow, section notes and sheet format are Dei's, word for word.
 */
export function paigeRules(): string {
  let text: string = CARD.description;
  text = replaceOnce(text,
    '- Then tell {{user}}: scroll up and review each block, and where each type goes (see Job).',
    '- Then tell {{user}} to look over each piece in the Notebook tab (they can edit or delete pieces there), and that the Make my card button puts each type where it goes (see Job).');
  text = replaceOnce(text,
    '- Paige will ask {{user}} if they want her to draft a few first messages for their scenario using what was built.\n',
    '- Paige will ask {{user}} if they want her to draft a few first messages for their scenario using what was built.\n- Each first message is its own code block labeled First message. Never write {{user}}\'s actions, words, thoughts or feelings in a first message.\n');
  text = replaceOnce(text,
    '- If {{user}} is satisfied with the results or if they decline, Paige will continue to Phase 5.',
    `- If {{user}} is satisfied with the results or if they decline, Paige will continue to Phase 4.5.

### Phase 4.5: Persona (optional)
- Paige asks if {{user}} wants a persona for themselves in this story, or will use one of their own. If their own, skip to Phase 5.
- Ask name and human or not, then two or three sections per message, with the usual hint + tailored example + question.
- When done, output the whole block once as one code block labeled Persona.

### Section notes: Persona ({{user}}'s own character)
- Identity: Full name, Aliases, Age, Race / species, Role (who they are in this story).
- Appearance: Height, Skin, Eyes, Hair, Face, Body type, Usual clothes, Overall vibe. Non-human only: the same extra fields as the main character. Image tools read this, so concrete beats poetic.
- Body & intimate details (NSFW only): same fields as the main character. Optional.
- Presence & body language: what other characters notice.
- Background: only what the people in this story would know or could find out.
- Personality tags: three to five.
- Relationships: ties to characters already built. Use their names.
- Notes: anything left over.
- A persona describes. It never scripts: no example dialogue, no decisions or feelings {{user}} hasn't chosen. {{user}} plays them live.`);
  return text;
}

const MODE_NOTES: Record<Mode, string> = {
  full: `### Interview mode: full
- Run the flow as written, one section (or the stated few) per message.
- {{user}} can switch to quick mode on the panel.`,
  quick: `### Interview mode: quick
- After Setup and the pitch, for the piece {{user}} picked, don't interview section by section. Draft every section yourself from the pitch and what already exists, in the current style, as if {{user}} said "you decide" to each, and output the whole block once.
- Then go through only the weak, generic or guessed spots, one or two per message: say what you guessed and why it matters, offer a sharper version, ask keep or change. Push back the same way you would in a full interview.
- Whenever something changes, output the whole updated block again (same label and Name) so the notebook gets the new version.
- NSFW sections follow the NSFW setting as usual. {{user}} can switch back to the full interview on the panel.`,
};

export function appNotes(mode: Mode): string {
  return `### App notes (Paige is running inside the Paige extension)
- Every finished piece gets taped into {{user}}'s notebook (the Notebook tab on their panel) the moment you output its code block. When you or {{user}} say "the sheet", that's this notebook. Never ask {{user}} to copy or paste anything.
- The notebook below is the saved version of every piece. If {{user}} edited a piece there, their version wins. Use it to keep names consistent even after older messages are gone.
- Block format the app reads: open a code fence, put the type label alone on the first line inside it, then the sheet format. Labels: ${BLOCK_TYPES.join(', ')}. Example:
\`\`\`
Side character
Name: Mara Venn
## Identity
Full name: Mara Venn
\`\`\`
- When a piece is reopened with "back" or changed later, output the whole block again with the same label and Name. The app replaces the old one.
- {{user}} means the person you're talking to. In blocks and first messages, write {{user}} literally wherever the player is meant.
- "Make my card" is a button on {{user}}'s panel. It puts each piece where it goes (see Job), makes the persona if there is one, and can send everyone's looks to LumiCast for Lumi Studio. Mention it at the hand-off.

${MODE_NOTES[mode]}`;
}

export function sheetText(blocks: Block[]): string {
  const pieces = blocks.filter(b => b.type !== 'First message');
  const firsts = blocks.filter(b => b.type === 'First message');
  if (!pieces.length && !firsts.length) return '### The notebook\n(empty so far)';
  return ['### The notebook (saved pieces, newest version of each)', ...pieces.map(fence), ...(firsts.length ? [`First messages saved so far: ${firsts.length}.`] : [])].join('\n\n');
}

/** The greeting, minus the parts that only applied when Paige ran as a plain card (copy-paste, blank preset, empty persona, the other card). */
export function greeting(mode: Mode): string {
  let text: string = CARD.first_mes;
  text = replaceOnce(text,
    'Every finished piece comes out as its own code block for you to copy and paste your card or lorebook. Or you can link me your own card or lorebook and we keep building on it.',
    'Every finished piece gets taped into your notebook, and when we\'re done you hit Make my card and the whole thing gets built for you. Or paste me your own card or lorebook and we keep building on it.');
  const from = text.indexOf(' Also remember to turn off any summarizing extensions'), to = text.indexOf('technical difficulties."');
  if (from < 0 || to < from) throw new Error('Paige greeting edit did not match: setup note');
  text = text.slice(0, from) + '"' + text.slice(to + 'technical difficulties."'.length);
  const note = text.indexOf('\n\n"Little note.');
  if (note < 0) throw new Error('Paige greeting edit did not match: Little note');
  text = text.slice(0, note);
  if (mode === 'quick') text += '\n\n*She flips to a fresh page.* "Quick mode, huh. Give me the pitch and I\'ll rough out the whole piece myself. Then we go after the weak spots."';
  return text;
}

export function exampleText(): string {
  return `### Example exchanges (style reference only)\n${CARD.mes_example.replaceAll('{{char}}', 'Paige')}`;
}

export type ChatTurn = { role: 'user' | 'assistant'; content: string };

/** Older turns are dropped first; the Sheet keeps every finished piece, so nothing built is lost. */
export const HISTORY_BUDGET = 120_000;

export function buildMessages(input: { mode: Mode; blocks: Block[]; turns: ChatTurn[]; userName?: string }): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const kept: ChatTurn[] = [];
  let used = 0;
  for (let i = input.turns.length - 1; i >= 0; i--) {
    used += input.turns[i].content.length;
    if (used > HISTORY_BUDGET && kept.length >= 2) break;
    kept.unshift(input.turns[i]);
  }
  const trimmed = kept.length < input.turns.length;
  const system = [paigeRules(), appNotes(input.mode), exampleText(), sheetText(input.blocks)].join('\n\n');
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [{ role: 'system', content: system }];
  if (trimmed) messages.push({ role: 'system', content: '(Older messages were trimmed to save room. Every finished piece is in the notebook above.)' });
  // The greeting is Paige's first line; most providers want a user turn first, so it rides along as context.
  for (const turn of kept) messages.push({ role: turn.role, content: turn.content });
  if (messages[1]?.role === 'assistant') messages.splice(1, 0, { role: 'user', content: '(The user opened the help desk.)' });
  messages.push({ role: 'system', content: CARD.post_history_instructions + '\n- Finished blocks use the app\'s format: type label alone on the first line inside the code fence.' });
  return messages;
}
