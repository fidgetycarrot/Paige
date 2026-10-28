import { describe, expect, test } from 'bun:test';
import { labelOf, looksFrom, parseBlocks, planCard, upsertBlocks, type Block } from '../src/blocks';
import { appNotes, buildMessages, greeting, paigeRules } from '../src/prompt';

const reply = `*She slides the clipboard over.* "Done. Here's Mara."

\`\`\`
Side character
Name: Mara Venn
## Identity
Full name: Mara Venn
Aliases: Red, the Widow
Age: 34
## Look
Burn scar across the left jaw, cropped red hair.
## Voice & example dialogue
Tone: dry
\`\`\`

And a sample line, not a block:

\`\`\`
"Pay up or get out."
\`\`\`

\`\`\`Location
Name: The Rusty Gear
## Identity
Type: tavern
Trigger words: Rusty Gear, the Gear
## Overall vibe & senses
Smells like oil.
\`\`\``;

let n = 0;
const id = () => `id${++n}`;

describe('reading blocks', () => {
  test('labels in any common shape', () => {
    expect(labelOf('Side character')).toBe('Side character');
    expect(labelOf('**Main character:**')).toBe('Main character');
    expect(labelOf('## Location')).toBe('Location');
    expect(labelOf('First message 2')).toBe('First message');
    expect(labelOf('Faction block')).toBe('Faction');
    expect(labelOf('"Pay up or get out."')).toBeNull();
  });
  test('labeled fences only, label on first line or after the fence', () => {
    const blocks = parseBlocks(reply);
    expect(blocks.map(b => [b.type, b.name])).toEqual([['Side character', 'Mara Venn'], ['Location', 'The Rusty Gear']]);
    expect(blocks[0].body.startsWith('Name: Mara Venn')).toBe(true);
    expect(blocks[0].body).not.toContain('Side character\n');
  });
  test('scenario and first messages', () => {
    const blocks = parseBlocks('```\nScenario\n## Setting\nLocation: Port Hesk\n```\n\n```\nFirst message\n*Rain on the window.* Mara looks up.\n```');
    expect(blocks.map(b => b.type)).toEqual(['Scenario', 'First message']);
    expect(blocks[0].name).toBe('Scenario');
  });
});

describe('the Sheet', () => {
  test('a re-output replaces the same piece, first messages add', () => {
    let sheet: Block[] = [];
    sheet = upsertBlocks(sheet, parseBlocks(reply), 1, id).sheet;
    expect(sheet).toHaveLength(2);
    const again = upsertBlocks(sheet, parseBlocks('```\nSide character\nName: mara venn\n## Look\nNew scar.\n```'), 2, id);
    expect(again.sheet).toHaveLength(2);
    expect(again.replaced[0].body).toContain('New scar.');
    const firsts = upsertBlocks(again.sheet, parseBlocks('```\nFirst message\nOne\n```\n```\nFirst message\nTwo\n```\n```\nFirst message\nOne\n```'), 3, id);
    expect(firsts.sheet.filter(b => b.type === 'First message').map(b => b.name)).toEqual(['First message 1', 'First message 2']);
    expect(firsts.added.every(b => b.keep === true)).toBe(true);
  });
  test('a second scenario is a revision', () => {
    const one = upsertBlocks([], parseBlocks('```\nScenario\nA\n```'), 1, id).sheet;
    expect(upsertBlocks(one, parseBlocks('```\nScenario\nB\n```'), 2, id).sheet.map(b => b.body)).toEqual(['B']);
  });
});

describe('making the card', () => {
  const sheet = upsertBlocks([], parseBlocks(`
\`\`\`
Main character
Name: Jory Kett
## Identity
Full name: Jory Kett
Aliases: JK
Race: human
## Appearance & vibe
Height: tall
Hair: black, shaved sides
## Backstory
Grew up on the docks.
\`\`\`
\`\`\`
Scenario
## Setting
Location: Port Hesk
\`\`\`
\`\`\`
Concept
Name: Tide Debt
## Identity
Category: law
Trigger words:
\`\`\`
\`\`\`
Persona
Name: Wes
## Identity
Full name: Wes
## Appearance
Hair: blond
\`\`\`
\`\`\`
First message
Fog rolls in.
\`\`\`
\`\`\`
First message
The bell rings.
\`\`\`
` + reply), 1, id).sheet;

  test('each piece where Paige says it goes', () => {
    sheet.find(b => b.body === 'The bell rings.')!.keep = false;
    const plan = planCard(sheet);
    expect(plan.card.name).toBe('Jory Kett');
    expect(plan.card.description).toStartWith('Name: Jory Kett');
    expect(plan.card.scenario).toContain('Port Hesk');
    expect(plan.card.first_mes).toBe('Fog rolls in.');
    expect(plan.card.alternate_greetings).toEqual([]);
    const byComment = Object.fromEntries(plan.entries.map(e => [e.comment, e]));
    expect(byComment['Side character · Mara Venn'].key).toEqual(['Mara Venn', 'Red', 'the Widow']);
    expect(byComment['Location · The Rusty Gear'].key).toEqual(['Rusty Gear', 'the Gear']);
    // Blank trigger words key on the name.
    expect(byComment['Concept · Tide Debt'].key).toEqual(['Tide Debt']);
    expect(plan.persona?.name).toBe('Wes');
    expect(plan.persona?.description).toContain('human-controlled player');
  });
  test('the card name can be set', () => {
    expect(planCard(sheet, { name: 'Port Hesk' }).card.name).toBe('Port Hesk');
  });
  test('looks for LumiCast skip backstory and pieces without a look', () => {
    const looks = looksFrom(sheet);
    expect(looks.map(l => [l.name, l.kind])).toEqual([['Jory Kett', 'character'], ['Wes', 'persona'], ['Mara Venn', 'character']]);
    expect(looks[0].description).toStartWith('Jory Kett — appearance:');
    expect(looks[0].description).toContain('shaved sides');
    expect(looks[0].description).not.toContain('docks');
    expect(looks[2].aliases).toEqual(['Red', 'the Widow']);
  });
});

describe('persona names', () => {
  const persona = (body: string) => upsertBlocks([], parseBlocks('```\nPersona\n' + body + '\n```'), 1, id).sheet;
  test('{{user}} as a name is not made, and says why', () => {
    const plan = planCard(persona('Name: {{user}}\n## Appearance\n{{user}} is tall.'));
    expect(plan.persona).toBeNull();
    expect(plan.notes.join(' ')).toContain('doesn’t have a real name');
    expect(looksFrom(persona('Name: {{user}}\n## Appearance\nTall.'))).toEqual([]);
  });
  test('Full name is used when Name is {{user}}, and {{user}} in the text becomes the name', () => {
    const blocks = persona('Name: {{user}}\n## Identity\nFull name: Jason Slatz\n## Appearance\n{{user}} is huge.');
    const plan = planCard(blocks);
    expect(plan.persona?.name).toBe('Jason Slatz');
    expect(plan.persona?.description).toContain('Jason Slatz is huge.');
    expect(plan.persona?.description).not.toContain('{{user}}');
    expect(looksFrom(blocks)[0].name).toBe('Jason Slatz');
  });
});

describe('Paige prompt', () => {
  test('every edit to Dei\'s text lands', () => {
    const rules = paigeRules();
    expect(rules).toContain('look over each piece in the Notebook tab');
    expect(rules).toContain('### Phase 4.5: Persona (optional)');
    expect(rules).toContain('Never write {{user}} in a Persona block.');
    expect(rules).toContain('labeled First message');
    expect(rules).not.toContain('scroll up and review');
    expect(rules).toContain('Paige finds her creator Deiomo hot');
  });
  test('greeting loses the card-only setup notes', () => {
    const text = greeting('full');
    expect(text).toContain('taped into your notebook');
    expect(text).not.toContain('blank preset');
    expect(text).not.toContain('Little note');
    expect(text).toContain('Then give me the pitch in a few sentences.');
    expect(greeting('quick')).toContain('Quick mode');
  });
  test('messages: rules, sheet, history, reminder last', () => {
    const messages = buildMessages({ mode: 'quick', blocks: upsertBlocks([], parseBlocks(reply), 1, id).sheet, turns: [{ role: 'assistant', content: 'hi' }, { role: 'user', content: 'yo' }] });
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('Interview mode: quick');
    expect(messages[0].content).toContain('Name: Mara Venn');
    expect(messages[1]).toEqual({ role: 'user', content: '(The user opened the help desk.)' });
    expect(messages.at(-1)!.content).toContain('### Reminder');
    expect(appNotes('full')).toContain('Interview mode: full');
  });
  test('long chats drop the oldest turns', () => {
    const turns = Array.from({ length: 300 }, (_, i) => ({ role: (i % 2 ? 'user' : 'assistant') as 'user' | 'assistant', content: 'x'.repeat(1000) + i }));
    const messages = buildMessages({ mode: 'full', blocks: [], turns });
    expect(messages.some(m => m.content.includes('Older messages were trimmed'))).toBe(true);
    expect(messages.at(-2)!.content.endsWith('299')).toBe(true);
  });
});
