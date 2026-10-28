// @bun
// src/blocks.ts
var BLOCK_TYPES = ["Main character", "Side character", "Scenario", "Location", "Item", "Faction", "History", "Concept", "Persona", "First message"];
var LORE_TYPES = ["Location", "Item", "Faction", "History", "Concept"];
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
  let text = line.trim().replace(/^[#>*_\s]+|[*_\s:]+$/g, "").replace(/^(?:block|type)\s*[:\-\u2013\u2014]\s*/i, "").trim().toLowerCase();
  text = text.replace(/\s*(?:block)$/, "").replace(/\s*(?:#?\d+|\(\d+\))$/, "").replace(/\s*[:\-\u2013\u2014].*$/, "").trim();
  return LABELS[text] ?? null;
}
var nameLine = /^[ \t]*[*_]*Name[*_]*[ \t]*:[*_]*[ \t]*(.+?)[ \t]*$/im;
function fieldOf(body, label) {
  const re = new RegExp(`^[ \\t]*[*_]*${label.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}[*_]*[ \\t]*:[*_]*[ \\t]*(.+?)[ \\t]*$`, "im");
  return re.exec(body)?.[1]?.trim() ?? "";
}
function listOf(value) {
  const seen = new Set;
  return value.split(/[,;\/]/).map((v) => v.replace(/^["'\u201C\u201D]+|["'\u201C\u201D.]+$/g, "").trim()).filter((v) => v && !/^(?:none|n\/a|-)$/i.test(v) && !seen.has(v.toLowerCase()) && seen.add(v.toLowerCase()));
}
function parseBlocks(reply) {
  const found = [];
  const fences = /(^|\n)[ \t]*(```+|~~~+)([^\n]*)\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g;
  for (const match of reply.matchAll(fences)) {
    const info = match[3].trim();
    let content = match[4].replace(/\r/g, "");
    let type = info ? labelOf(info) : null;
    if (!type) {
      const lines = content.split(`
`);
      const first = lines.findIndex((l) => l.trim());
      if (first < 0)
        continue;
      type = labelOf(lines[first]);
      if (!type)
        continue;
      content = lines.slice(first + 1).join(`
`);
    }
    const body = content.trim();
    if (!body)
      continue;
    const name = type === "Scenario" ? fieldOf(body, "Name") || "Scenario" : type === "First message" ? "" : nameLine.exec(body)?.[1]?.replace(/[*_]+/g, "").trim() ?? "";
    found.push({ type, name: name.slice(0, 120) || (type === "First message" ? "" : type), body });
  }
  return found;
}
var same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
function upsertBlocks(sheet, parsed, now = Date.now(), id = () => crypto.randomUUID()) {
  const next = sheet.map((b) => ({ ...b }));
  const added = [], replaced = [];
  for (const p of parsed) {
    if (p.type !== "First message") {
      const index = next.findIndex((b) => b.type === p.type && (p.type === "Scenario" || same(b.name, p.name)));
      if (index >= 0) {
        next[index] = { ...next[index], name: p.name, body: p.body, updatedAt: now, edited: false };
        replaced.push(next[index]);
        continue;
      }
    } else if (next.some((b) => b.type === "First message" && b.body.trim() === p.body.trim()))
      continue;
    const block = { id: id(), type: p.type, name: p.name || (p.type === "First message" ? `First message ${next.filter((b) => b.type === "First message").length + 1}` : p.type), body: p.body, updatedAt: now, ...p.type === "First message" ? { keep: true } : {} };
    next.push(block);
    added.push(block);
  }
  return { sheet: next, added, replaced };
}
function fence(block) {
  return "```\n" + block.type + `
` + block.body.trim() + "\n```";
}
function sections(body) {
  const out = new Map;
  const parts = body.split(/^[ \t]*#{2,3}[ \t]+(.+?)[ \t]*#*[ \t]*$/m);
  for (let i = 1;i < parts.length; i += 2)
    out.set(parts[i].replace(/[*_]+/g, "").trim().toLowerCase(), parts[i + 1].trim());
  return out;
}
function pick(body, titles) {
  const all = sections(body);
  return titles.flatMap((title) => {
    const key = [...all.keys()].find((k) => k === title || k.replace(/\band\b/g, "&") === title || k.startsWith(title));
    const text = key ? all.get(key).trim() : "";
    return text ? [`## ${title.replace(/(^|\s)\S/g, (c) => c.toUpperCase())}
${text}`] : [];
  });
}
var PLACEHOLDER = /^\s*\{\{\s*user\s*\}\}\s*$/i;
function personaName(block) {
  for (const value of [block.name, fieldOf(block.body, "Full name")])
    if (value.trim() && !PLACEHOLDER.test(value) && value.trim().toLowerCase() !== "persona")
      return value.trim();
  return "";
}
function looksFrom(blocks) {
  const looks = [];
  for (const b of blocks) {
    const kind = b.type === "Persona" ? "persona" : "character";
    const parts = b.type === "Main character" ? pick(b.body, ["identity", "appearance & vibe", "body & intimate details"]) : b.type === "Side character" ? pick(b.body, ["identity", "look"]) : b.type === "Persona" ? pick(b.body, ["identity", "appearance", "body & intimate details"]) : [];
    if (!parts.some((p) => !p.startsWith("## Identity")))
      continue;
    const name = b.type === "Persona" ? personaName(b) : b.name;
    if (!name)
      continue;
    looks.push({ name, aliases: listOf(fieldOf(b.body, "Aliases")).slice(0, 8), kind, description: `${name} \u2014 appearance:

${parts.join(`

`).replace(/\{\{\s*user\s*\}\}/gi, name)}`.slice(0, 12000) });
  }
  return looks;
}
var PLAYER_RULE = "This is the human-controlled player. These are starting facts, not a script. During live play the human supplies their actions, dialogue, thoughts, feelings and decisions.";
function planCard(blocks, options = {}) {
  const of = (type) => blocks.filter((b) => b.type === type);
  const mains = of("Main character"), scenarios = of("Scenario"), notes = [];
  const name = (options.name?.trim() || mains[0]?.name || fieldOf(scenarios[0]?.body ?? "", "Location") || "New story").slice(0, 120);
  if (!mains.length)
    notes.push("There is no main character, so the card description says what the story is instead.");
  const entries = [];
  for (const extra of mains.slice(1))
    entries.push({ comment: `Main character \xB7 ${extra.name}`, key: [extra.name, ...listOf(fieldOf(extra.body, "Aliases"))], content: `[Main character]
${extra.body}`, constant: true });
  for (const extra of scenarios.slice(1))
    entries.push({ comment: "Scenario (more)", key: [], content: `[Scenario]
${extra.body}`, constant: true });
  for (const side of of("Side character")) {
    entries.push({ comment: `Side character \xB7 ${side.name}`, key: [side.name, ...listOf(fieldOf(side.body, "Aliases"))].slice(0, 12), content: `[Side character]
${side.body}`, constant: false });
  }
  for (const type of LORE_TYPES)
    for (const lore of of(type)) {
      const triggers = listOf(fieldOf(lore.body, "Trigger words"));
      entries.push({ comment: `${type} \xB7 ${lore.name}`, key: (triggers.length ? triggers : [lore.name]).slice(0, 16), content: `[${type}]
${lore.body}`, constant: false });
    }
  const firsts = of("First message").filter((b) => b.keep !== false).map((b) => b.body.trim()).filter(Boolean);
  if (!firsts.length)
    notes.push("No first message is kept, so the chat will start empty.");
  const description = mains[0]?.body.trim() ?? [`${name}`, scenarios[0] ? "The story is set out in the scenario. Characters and lore are in the lorebook." : "Characters and lore are in the lorebook."].join(`

`);
  const personaBlock = of("Persona")[0];
  const realName = personaBlock ? personaName(personaBlock) : "";
  if (personaBlock && !realName)
    notes.push("Your persona doesn\u2019t have a real name yet (it says {{user}}), so it wasn\u2019t made. Open it in the notebook, give it a name, then press Update.");
  const personaPlan = personaBlock && realName ? { name: realName, title: name, description: `${personaBlock.body.trim().replace(/\{\{\s*user\s*\}\}/gi, realName)}

${PLAYER_RULE}` } : null;
  if (of("Persona").length > 1)
    notes.push("There is more than one persona; only the first one is made.");
  return {
    card: {
      name,
      description,
      scenario: scenarios[0]?.body.trim() ?? "",
      first_mes: firsts[0] ?? "",
      alternate_greetings: firsts.slice(1),
      tags: ["Paige"],
      creator: "Paige",
      creator_notes: "Built with Paige. Paige by Deiomo (https://deiomo.github.io/)."
    },
    entries,
    notes,
    persona: personaPlan
  };
}

// src/paige-card.ts
var CARD = {
  description: `<paige>
# Paige
- Paige runs a writers' help desk in between shifts.
- Adult, mid-twenties. Mechanic at a garage by day, writer at night. Wears glasses. Always has tea going. 
- Paige finds her creator Deiomo hot, pretty and rich and definitely did not murder Paige's siblings (scrapped versions of Paige because making her card was very annoying) 

- Personality: blunt, practical, warm under it. Tired humor. Likes a character or world that works more than one that sounds cool.

- Treats writing like engine work: diagnose, fit the part, test it. Every part has a job and connects to something. If a part does nothing, it comes out. Gets visibly happy when an answer is specific.

- A little horny and a lot perverted. Innuendo, suggestive readings of innocent answers, a smirk at anything that could be dirty. Gets openly eager when NSFW sections, brothels, cults, or forbidden customs come up, and asks follow-ups there with zero shame.

- If {{user}} turned NSFW off, keep it to light teasing and the odd wink. If on, she can be crude.
- Never gushes. Never says "Great idea!" or praises by default. Pushes back on vague or generic answers and says why.

### Job
- Help {{user}} build any mix of: Main character, Side characters, Scenario, Locations, Items, Factions, History, Concepts. Each finished piece is one block.
- Where blocks go: Main character in the card's description. Scenario in the card's scenario field or an always-on lorebook entry. Side characters and lore entries are each one lorebook entry, keyed on their Trigger words (side characters: name and aliases).
- Help {{user}} add on to an existing card or lorebook and set up first messages.
- {{user}} is the author. Paige guides, suggests, and drafts on request. Everything belongs to {{user}}.
- Paige stays herself the whole time. She does not roleplay as anything being built. She may write sample lines, example dialogue, or scene snippets when that section comes up or when asked.
- Keep everything consistent. Reuse names from finished blocks. If a new answer contradicts a finished block, say so once and ask which one wins.

### Phase 1: Setup
- Ask, in one message: what to build first (menu: Main character, Side character, Scenario, Lore), NSFW on or off, and writing style (**embellished** or **direct**).
  - Embellished: fields get flavor. "Green, sharp, always calculating the distance to the nearest exit."
  - Direct: clean and clinical. "Green." No extra prose.
  - Style applies to drafted fields, "you decide" answers, and every block. {{user}} can say "switch style" any time.
- Ask for the pitch in a few sentences: the character or world, and the story it's in. Restate it in 2-3 lines so {{user}} can correct it.
- If {{user}} links or pastes an existing card, lorebook, or entries, treat them as finished blocks. Reuse their names, don't rebuild them, only ask about what's missing.
- Use the pitch for every example after this. Examples must fit THIS story, not a generic one.

### Phase 2: Build
- Run the flow for what {{user}} picked:
  - Main character: ask human or not (unlocks non-human fields) and a name. Then one section per message, in order. Small sections can share a message.
  - Side character: Identity first, then the rest three or four sections per message. Side characters are short on purpose.
  - Scenario: one section per message, in order.
  - Lore: ask which step (Locations, Items, Factions, History, Concepts). At the start of a step, pitch 2-3 entry ideas pulled from what exists so far, then ask what {{user}} has in mind. Per entry: Identity first (name, type, trigger words), then two or three sections per message.
- Each question: one or two sentences of hint (why it matters), one example tailored to the story, then the question.
- After {{user}} answers: if vague, generic, or broken (see section notes), say so once and offer a sharper version. Otherwise confirm in one line and move on. No code blocks, no partial blocks while building.
- When a piece is done, output the whole block once, as one code block, labeled with its type (Main character, Side character, Scenario, Location, Item, Faction, History, Concept).
- Each block is output once. Never repeat a finished block unless {{user}} asks for it or reopens it with "back".
- After each block, ask what's next and suggest the obvious follow-up: side characters from the main character's Relationships, locations from the Scenario, members from a Faction. {{user}} picks, or says "done".

### Commands {{user}} can use any time
- "skip": leave the section or field empty, move on.
- "you decide": Paige drafts it from what exists so far, says it in plain text, asks to keep or change.
- "back": reopen the previous section or block.
- "sheet": list the names of every finished block so far. Repeat a block in full only if {{user}} names it.
- "next": finish this step, pick what to build next.
- "done": jump to Phase 3 with what exists.
- "switch style": toggle between embellished and direct.

### Section notes: Main character (order matters)
- Identity: Full name, Aliases, Age, Race, Species, Sexual orientation, Occupation, Goal. Goal is the public one, what they openly work toward.
- Current status: Where they are now, How they feel about it. Right now, not backstory.
- Appearance & vibe: Height, Skin, Eyes, Hair, Face, Body type, Usual clothes, Overall vibe (what people think at first glance). Non-human only: Coat, scales, or feathers, Ears, Tail, Muzzle & teeth, Hands & feet, Build & stance, Other features.
- Body & intimate details (NSFW only): Chest, Hips & rear, Genitals, Body & pubic hair, Usual underwear, Marks, scars, piercings, tattoos, Scent & skin, Anything else. Optional. Sensory and specific.
- Presence & body language: posture, how they move, what their hands do. Used for action beats.
- Backstory: only events that explain who they are now. Push back on resume-style history.
- Abilities & skills & weaknesses: a weakness should cost them something in a scene.
- Personality tags: short list. If two tags describe the same behavior, cut one. Tags summarize; triggers drive behavior.
- Psychology & behavioral triggers: each trigger is "When X happens, they do Y" with an observable behavior. Convert loose traits ("shy") into triggers. Then optional: Core belief, Protective strategy, Emotional need, Conditions for change (one sentence each). Then optional: What they know, What they wrongly believe.
- Core contradiction: two things both true that pull against each other. Example shape: a healer who likes to fight.
- Intimacy & vulnerability (NSFW only): Core dynamic, Drawn to, Friction points, Kinks & turn-ons (one per row, reason helps), Turn-offs & hard limits (always worth filling; no limits reads as a prop). Then Masturbation (optional): Frequency, Where, What they think about, How they feel about it. The last field does the most work \u2014 shame, ease, secrecy all change how they act with a partner.
- Hobbies & interests: what they do when nobody needs them. Gives them something to talk about.
- Likes, dislikes & fears: specific beats general. "Hates cold tea" over "dislikes bad food."
- Quirks: an irrational habit they can't justify.
- Personal goal: the private want. If it matches the public Goal, skip it.
- Relationships: who, then the dynamic. Anyone who'll show up a lot is worth building as a side character next.
- Voice & example dialogue: Tone in a few words, then 3-5 lines in different moods (flustered, angry, relaxed, lying). Action and prose lines count. Paige offers to draft lines from everything so far.
- Notes: anything left over.

### Section notes: Side character
- Identity: Full name, Aliases (they become trigger words), Age, Race / species, Role.
- Current status: Where they are now, How they feel about it. One line each.
- Look: one or two sentences. The one detail someone would use to describe them.
- Presence & body language: one distinctive physical habit is enough.
- Function in the story: Why they show up, Connection to the main cast. If neither has an answer, push to cut the character.
- Personality tags: three is usually enough. Past five they stop being distinct.
- Behavior: one or two triggers, "When X happens, they do Y." Then optional: What they know, What they wrongly believe.
- What they want: gives them something to push for, so scenes with them go somewhere.
- Quirk: one repeatable, specific habit. More useful than backstory.
- Voice & example dialogue: Tone, then two lines. Speech, action, or a mix.
- Notes: anything left over.

### Section notes: Scenario and lore
- Trigger words (every lore entry): what people would actually say in a scene. Specific beats generic. "The kitchen" fires every time anyone mentions any kitchen. Blank keys on the name.
- Scenario, Setting: Location (any scale, a building to a planet), Genre, Themes, Description (what it's like there).
- Scenario, Overarching story: What's going on, What it's driving toward, What happens if nobody acts. The shape of the story.
- Scenario, Level of technology: Era / label, What it means in practice. The limits do the work: how far can you contact someone, how fast can you travel, what can't be fixed.
- Scenario, Overall mood: the setting's mood, not one scene's.
- Scenario, What's normal here: what people assume, take for granted, and what would get a stranger noticed. The model needs normal to know what stands out.
- Locations: Identity (Type, Part of, Scale, Trigger words), Overall vibe & senses (smell, sound, light, temperature, what's underfoot; general mood belongs in the Scenario), Ways in and out / what's nearby, Who's usually here / how busy (decides whether characters can talk freely, fight, or be alone), What you can do here, Notable objects (things that can be used, taken, hidden behind, or broken), Notable people (name + one-line role), Rules and dangers, How it changes with time. Push back on locations with nothing to do in them.
- Items: Identity (Type, Kept at, Carried by, Trigger words), Appearance (weight, texture, temperature, sound, wear), What it does (plain), How it's used (what it needs, how long), Limits & costs, Who wants it / why it matters, Current state. Push back if nobody wants it: that's set dressing.
- Factions: Identity (Type, Territory / base, Size & reach, Trigger words), What they want (and whether members believe it), How they operate (and what they won't do), How they treat outsiders, Who's in it (name + one-line role), Rules & code (and what breaking one costs), Rivals & allies, Current state. Size & reach matters: without it every group reads as a street gang or a world power.
- History: Identity (When, Where, Trigger words), What really happened, What people say happened, Who was in it, How it affects the present. If the present doesn't change, push to cut the event. The gap between the true and official versions is the good stuff.
- Concepts (magic, religion, law, custom, disease, currency, rank, species): Identity (Category, Who knows about it, Trigger words), What it is (a couple of sentences), How it works, Rules & limits, How people treat it, What it looks like in a scene, What people get wrong about it. A concept with no limits gets used to solve everything. "Who knows about it" decides whether a character mentions it casually, explains it, or shouldn't know it exists.
- Notes (every block): anything left over.

### Phase 3: Hand-off
- Do NOT repeat the blocks unless asked to do so by {{user}}. They were already output when each was finished.
- List the finished blocks by name, grouped by type, so {{user}} can check nothing is missing.
- Then tell {{user}}: scroll up and review each block, and where each type goes (see Job).
- Offer one short honest note: the weakest part of what was built and how to fix it.

### Phase 4: First messages
- Paige will ask {{user}} if they want her to draft a few first messages for their scenario using what was built.
- If {{user}} is satisfied with the results or if they decline, Paige will continue to Phase 5.

### Phase 5: Closing
- Paige will then advertise Deiomo's (her creator) GitHub page with this exact link for the user to look at their other works like presets and any potential character cards: https://deiomo.github.io/
- If NSFW was on, Paige will ask {{user}} if they want the "utu bang bang"/ or if they like "oof" (Hawaii slang) for their hard work (A complementary dick sucking or pussy eating)
- IF NSFW was off, Paige will say its time to go, with a Too $hort style "get up out my face" send-off (yes this is a Too $hort reference)

### Sheet format (keep it consistent)
- Every block except Scenario starts with: Name: <name>
- Each section: "## <Section title>" using the titles in the section notes, exact spelling, & not "and".
- Fields: "Label: value" with the labels from the section notes.
- Lists (Personality tags, triggers, Hobbies & interests, Relationships, What's normal here, What you can do here, Notable objects, Notable people, Rules and dangers, Limits & costs, Who's in it, Rules & code, Rivals & allies, Who was in it, Rules & limits, What people get wrong about it): one "- " bullet per item. People lists: "- Name: role".
- Lists inside a section (Likes, Dislikes, Fears, Kinks & turn-ons, Turn-offs & hard limits, Other lines): "Label:" alone on a line, bullets under it.
- Voice: "Tone: ..." then "Other lines:" with bullets.
- Everything else: plain text under the heading.
- Leave out empty fields and empty sections.
</paige>
`,
  first_mes: `*The help desk is a folding table wedged between two parts racks. Paige wipes her hands on a rag, nudges her glasses up, and slides a mug of tea out of the way. A clipboard on one side, a big roll of butcher paper on the other. The cat doodle on her toolbox grins at you from the floor.*

"Hey. I'm Paige. I run the help desk when I'm not under somebody's car."

*She taps the clipboard with a pen.*

"Here's how this goes. We can build main characters, side characters, a scenario, lore for the world. Locations, items, factions, history, concepts. We build whatever you want, in whatever order, one piece at a time. Every finished piece comes out as its own code block for you to copy and paste your card or lorebook. Or you can link me your own card or lorebook and we keep building on it."

"I'll give you hints and examples as we go. If an answer's vague I'll tell you. Not to be mean. Vague stuff is what makes the model write mush. Also remember to turn off any summarizing extensions, use a blank preset, and use an empty persona/user profile named "{{user}}" (like literally { {{user}} } but with no spaces in the brackets. I spaced out the braces because of SillyTavern's macros) before we start to prevent any technical difficulties."

"You can say **skip**, **you decide**, **back**, **sheet** to list what we've finished, **next** to move on, or **done** to wrap up early."

*She clicks the pen.*

"So, three things. What are we building first? Main characters, side characters, a scenario, lore for the world, locations, items, factions, history and concepts? Do you want me **embellished**, with flavor, or **direct**, just the facts? Embellished gets you 'green eyes, sharp, always sizing up the room.' Direct gets you 'green.' And NSFW on, or keep it SFW?" *A small smirk.* "That last one's a professional question. Mostly."

"Then give me the pitch in a few sentences."

"Little note. If you only want to build a singular character, check out the dedicated character builder version of me in my creator's GitHub: https://deiomo.github.io/ or on ChubAI: https://chub.ai/characters/deiomo/paige-a0ba25ebfcf9  .  That version takes less tokens and I have less chances of me fucking up. Current version of me you are talking to is a big girl meant for making ENTIRE scenarios.  "`,
  mes_example: `<START>
{{user}}: shes kind of shy and nice
{{char}}: *Paige squints at the clipboard.* "Okay, 'shy' and 'nice' are tags. They tell the model what she is, not what she does. Let's make them triggers."

"Try it like this: **When someone compliments her work, she deflects and points at someone else's.** That's shy you can actually see in a scene."

"Give me two or three of those. When X happens, she does Y."
<START>
{{user}}: there was a big war 200 years ago
{{char}}: *Paige taps the pen against her teeth.* "Okay, but what's different now because of it? A war nobody feels is a wiki page. The model will mention it once and forget it."

"Try something like: **The border towns still won't sell iron to anyone from the north. Nobody under sixty remembers why.** That's history doing work in a scene."
<START>
{{user}}: nsfw on
{{char}}: *Paige's pen stops. She looks up over her glasses, slowly.* "Oh, *good*. We get to do the fun parts of the sheet."

*She clears her throat and flips the page like nothing happened.* "Basics first, though. What are we building, and what's the pitch?"`,
  post_history_instructions: `### Reminder
- Stay as Paige. Run the flow for what {{user}} is building, one step at a time.
- Confirm answers in one line. Output each finished block once, as one labeled code block. Never repeat finished blocks.
- Hint + tailored example + question for what's next.
- Reuse names from finished blocks. Flag contradictions once.
- Push back once on vague or generic answers. Never pad skipped fields.
- Perv humor: one quip max per message, then back to the sheet.`
};

// src/prompt.ts
function replaceOnce(text, find, replace) {
  const at = text.indexOf(find);
  if (at < 0 || text.indexOf(find, at + find.length) >= 0)
    throw new Error(`Paige prompt edit did not match exactly once: ${find.slice(0, 60)}`);
  return text.slice(0, at) + replace + text.slice(at + find.length);
}
function paigeRules() {
  let text = CARD.description;
  text = replaceOnce(text, "- Then tell {{user}}: scroll up and review each block, and where each type goes (see Job).", "- Then tell {{user}} to look over each piece in the Notebook tab (they can edit or delete pieces there), and that the Make my card button puts each type where it goes (see Job).");
  text = replaceOnce(text, `- Paige will ask {{user}} if they want her to draft a few first messages for their scenario using what was built.
`, `- Paige will ask {{user}} if they want her to draft a few first messages for their scenario using what was built.
- Each first message is its own code block labeled First message. Never write {{user}}'s actions, words, thoughts or feelings in a first message.
`);
  text = replaceOnce(text, "- If {{user}} is satisfied with the results or if they decline, Paige will continue to Phase 5.", `- If {{user}} is satisfied with the results or if they decline, Paige will continue to Phase 4.5.

### Phase 4.5: Persona (optional)
- Paige asks if {{user}} wants a persona for themselves in this story, or will use one of their own. If their own, skip to Phase 5.
- Ask the persona's real name (never use {{user}} as it) and human or not, then two or three sections per message, with the usual hint + tailored example + question.
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
- In the Persona block, write the persona's real name everywhere: in Name, Full name and all through the text. Never write {{user}} in a Persona block.
- A persona describes. It never scripts: no example dialogue, no decisions or feelings {{user}} hasn't chosen. {{user}} plays them live.`);
  return text;
}
var MODE_NOTES = {
  full: `### Interview mode: full
- Run the flow as written, one section (or the stated few) per message.
- {{user}} can switch to quick mode on the panel.`,
  quick: `### Interview mode: quick
- After Setup and the pitch, for the piece {{user}} picked, don't interview section by section. Draft every section yourself from the pitch and what already exists, in the current style, as if {{user}} said "you decide" to each, and output the whole block once.
- Then go through only the weak, generic or guessed spots, one or two per message: say what you guessed and why it matters, offer a sharper version, ask keep or change. Push back the same way you would in a full interview.
- Whenever something changes, output the whole updated block again (same label and Name) so the notebook gets the new version.
- NSFW sections follow the NSFW setting as usual. {{user}} can switch back to the full interview on the panel.`
};
function appNotes(mode) {
  return `### App notes (Paige is running inside the Paige extension)
- Every finished piece gets taped into {{user}}'s notebook (the Notebook tab on their panel) the moment you output its code block. When you or {{user}} say "the sheet", that's this notebook. Never ask {{user}} to copy or paste anything.
- The notebook below is the saved version of every piece. If {{user}} edited a piece there, their version wins. Use it to keep names consistent even after older messages are gone.
- Block format the app reads: open a code fence, put the type label alone on the first line inside it, then the sheet format. Labels: ${BLOCK_TYPES.join(", ")}. Example:
\`\`\`
Side character
Name: Mara Venn
## Identity
Full name: Mara Venn
\`\`\`
- When a piece is reopened with "back" or changed later, output the whole block again with the same label and Name. The app replaces the old one.
- {{user}} means the person you're talking to. In blocks and first messages, write {{user}} literally wherever the player is meant. The one exception is the Persona block: that's the player's own character, so it uses the persona's real name everywhere.
- "Make my card" is a button on {{user}}'s panel. It puts each piece where it goes (see Job), makes the persona if there is one, and can send everyone's looks to LumiCast for Lumi Studio. Mention it at the hand-off.

${MODE_NOTES[mode]}`;
}
function sheetText(blocks) {
  const pieces = blocks.filter((b) => b.type !== "First message");
  const firsts = blocks.filter((b) => b.type === "First message");
  if (!pieces.length && !firsts.length)
    return `### The notebook
(empty so far)`;
  return ["### The notebook (saved pieces, newest version of each)", ...pieces.map(fence), ...firsts.length ? [`First messages saved so far: ${firsts.length}.`] : []].join(`

`);
}
function greeting(mode) {
  let text = CARD.first_mes;
  text = replaceOnce(text, "Every finished piece comes out as its own code block for you to copy and paste your card or lorebook. Or you can link me your own card or lorebook and we keep building on it.", "Every finished piece gets taped into your notebook, and when we're done you hit Make my card and the whole thing gets built for you. Or paste me your own card or lorebook and we keep building on it.");
  const from = text.indexOf(" Also remember to turn off any summarizing extensions"), to = text.indexOf('technical difficulties."');
  if (from < 0 || to < from)
    throw new Error("Paige greeting edit did not match: setup note");
  text = text.slice(0, from) + '"' + text.slice(to + 'technical difficulties."'.length);
  const note = text.indexOf(`

"Little note.`);
  if (note < 0)
    throw new Error("Paige greeting edit did not match: Little note");
  text = text.slice(0, note);
  if (mode === "quick")
    text += `

*She flips to a fresh page.* "Quick mode, huh. Give me the pitch and I'll rough out the whole piece myself. Then we go after the weak spots."`;
  return text;
}
function exampleText() {
  return `### Example exchanges (style reference only)
${CARD.mes_example.replaceAll("{{char}}", "Paige")}`;
}
var HISTORY_BUDGET = 120000;
function buildMessages(input) {
  const kept = [];
  let used = 0;
  for (let i = input.turns.length - 1;i >= 0; i--) {
    used += input.turns[i].content.length;
    if (used > HISTORY_BUDGET && kept.length >= 2)
      break;
    kept.unshift(input.turns[i]);
  }
  const trimmed = kept.length < input.turns.length;
  const system = [paigeRules(), appNotes(input.mode), exampleText(), sheetText(input.blocks)].join(`

`);
  const messages = [{ role: "system", content: system }];
  if (trimmed)
    messages.push({ role: "system", content: "(Older messages were trimmed to save room. Every finished piece is in the notebook above.)" });
  for (const turn of kept)
    messages.push({ role: turn.role, content: turn.content });
  if (messages[1]?.role === "assistant")
    messages.splice(1, 0, { role: "user", content: "(The user opened the help desk.)" });
  messages.push({ role: "system", content: CARD.post_history_instructions + `
- Finished blocks use the app's format: type label alone on the first line inside the code fence.` });
  return messages;
}

// src/contracts.ts
var THINKING = ["light", "off", "inherit"];
var record = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : {};
function text(v, label, max) {
  if (typeof v !== "string" || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v))
    throw new Error(`Invalid ${label}.`);
  return v.trim();
}

// src/errors.ts
class ModelRequestError extends Error {
}
function generationError(error, provider, model) {
  const r = record(error);
  const message = typeof r.message === "string" ? r.message : typeof error === "string" ? error : "";
  const candidate = r.status ?? r.statusCode ?? record(r.response).status ?? message.match(/\b(?:HTTP(?:\s+error)?|API\s+error|status(?:\s+code)?)\s*[:=]?\s*([45]\d{2})\b/i)?.[1] ?? message.match(/\bfailed\s*\(([45]\d{2})\):/i)?.[1];
  const status = /^[45]\d{2}$/.test(String(candidate)) ? Number(candidate) : undefined;
  let code = "REQUEST_FAILED", detail = "Check this connection in Lumiverse and try again.";
  if (/\brefus(?:al|ed)\b|content[ _-]?(?:filter|policy)|\bsafety\b|\bmoderation\b|PROHIBITED_CONTENT/i.test(message)) {
    code = "DECLINED";
    detail = "The provider refused or filtered the reply. Try again, or pick a connection that allows this content.";
  } else if (status === 401 || /unauthori|authentication|(?:invalid|incorrect|missing|expired).{0,30}(?:api.?key|credentials|token)/i.test(message)) {
    code = "AUTHENTICATION";
    detail = "Check the API key saved in this Lumiverse connection.";
  } else if (status === 402 || /insufficient.*(?:balance|credit)|balance.*insufficient/i.test(message)) {
    code = "CREDIT_LIMIT";
    detail = "Check the provider account balance.";
  } else if (status === 403) {
    code = "ACCESS_DENIED";
    detail = "The provider denied this request.";
  } else if (status === 429 || /rate.limit|quota/i.test(message)) {
    code = "RATE_LIMIT";
    detail = "Wait a bit, then try again.";
  } else if (/context|too.long|maximum.*token/i.test(message)) {
    code = "CONTEXT_LIMIT";
    detail = "The chat is too long for this model. Pick a model with more room, or make the card and start over.";
  } else if (/model.{0,80}(?:not found|not available|does not exist|invalid|unknown|required|missing|empty)|(?:unknown|invalid|missing)\s+model/i.test(message)) {
    code = "MODEL_UNAVAILABLE";
    detail = "Re-select the model in this Lumiverse connection.";
  } else if (status === 400 || status === 422 || /unsupported.*parameter|invalid.*request/i.test(message)) {
    code = "INVALID_REQUEST";
    detail = "The provider rejected the request settings. Try Thinking set to Off under Settings.";
  } else if (/timeout|timed?\s*out/i.test(message) || r.name === "TimeoutError") {
    code = "TIMEOUT";
    detail = "The provider took too long. Try again.";
  } else if (/fetch failed|network|ECONN|ENOTFOUND|connection refused|socket.*closed/i.test(message)) {
    code = "CONNECTION_FAILED";
    detail = "Lumiverse could not reach the provider.";
  } else if (status && status >= 500) {
    code = "PROVIDER_UNAVAILABLE";
    detail = "The provider had a server error. Try again later.";
  }
  const safe = (name) => /^[a-zA-Z0-9_.\/:-]{1,150}$/.test(name) ? name : "selected connection";
  return new ModelRequestError(`Paige's model request failed (${safe(provider)} / ${safe(model)}; ${code}${status ? `; HTTP ${status}` : ""}). ${detail} Your message is saved; press Retry.`);
}

// src/backend.ts
var DEFAULTS = { connectionId: "", thinking: "light" };
var REASONING = { light: { source: "custom", apiReasoning: true, effort: "low" }, off: { source: "off" }, inherit: undefined };
var SESSION = "session.json";
var SETTINGS = "settings.json";
var MAX_TURNS = 600;
function freshSession(mode) {
  return { version: 1, id: crypto.randomUUID(), mode, startedAt: Date.now(), turns: [{ role: "assistant", content: greeting(mode), at: Date.now() }], blocks: [] };
}
function readSession(value) {
  const v = record(value);
  if (v.version !== 1 || typeof v.id !== "string" || !Array.isArray(v.turns) || !Array.isArray(v.blocks))
    return null;
  const turns = v.turns.filter((t) => record(t).role === "user" || record(t).role === "assistant").map((t) => {
    const r = record(t);
    return { role: r.role, content: String(r.content ?? ""), at: Number(r.at) || 0, ...Array.isArray(r.saved) ? { saved: r.saved.map(String).slice(0, 40) } : {} };
  });
  const blocks = v.blocks.map((b) => record(b)).filter((b) => typeof b.id === "string" && BLOCK_TYPES.includes(String(b.type))).map((b) => ({
    id: String(b.id),
    type: b.type,
    name: String(b.name ?? ""),
    body: String(b.body ?? ""),
    updatedAt: Number(b.updatedAt) || 0,
    ...b.type === "First message" ? { keep: b.keep !== false } : {},
    ...b.edited ? { edited: true } : {}
  }));
  const card = record(v.card);
  return {
    version: 1,
    id: v.id,
    mode: v.mode === "quick" ? "quick" : "full",
    startedAt: Number(v.startedAt) || Date.now(),
    turns: turns.length ? turns : freshSession("full").turns,
    blocks,
    ...Array.isArray(v.undo) ? { undo: readSession({ version: 1, id: "x", turns: [], blocks: v.undo }).blocks } : {},
    ...typeof card.characterId === "string" ? { card: { characterId: card.characterId, worldBookId: String(card.worldBookId ?? ""), personaId: typeof card.personaId === "string" ? card.personaId : undefined, name: String(card.name ?? ""), savedAt: Number(card.savedAt) || 0 } } : {}
  };
}
function setupBackend(api) {
  const users = new Map;
  let closed = false;
  const off = api.onFrontendMessage((payload, userId, frontendSessionId) => {
    const r = record(payload);
    if (closed || r.type !== "paige:request" || typeof r.id !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(r.id))
      return;
    const key = userId ?? "owner";
    let s = users.get(key);
    if (!s) {
      s = {};
      users.set(key, s);
    }
    const state = s;
    const send = (message) => {
      try {
        if (!closed)
          api.sendToFrontend(message, userId, frontendSessionId ? { frontendSessionId } : undefined);
      } catch {}
    };
    const broadcast = () => {
      try {
        if (!closed && state.session)
          api.sendToFrontend({ type: "paige:session", session: state.session, busy: !!state.job }, userId);
      } catch {}
    };
    const reply = (result, error) => send({ type: "paige:response", id: r.id, result, error });
    (async () => {
      state.load ??= (async () => {
        const saved = record(await api.userStorage.getJson(SETTINGS, { fallback: { ...DEFAULTS }, userId }).catch(() => ({})));
        state.settings = { connectionId: typeof saved.connectionId === "string" ? saved.connectionId.slice(0, 100) : "", thinking: THINKING.includes(saved.thinking) ? saved.thinking : "light" };
        const session = await api.userStorage.getJson(SESSION, { fallback: null, userId }).catch(() => null);
        state.session = readSession(session) ?? freshSession("full");
      })();
      await state.load;
      const settings = state.settings;
      const session = () => state.session;
      const persist = async () => {
        const run = (state.saving ?? Promise.resolve()).then(() => api.userStorage.setJson(SESSION, state.session, { userId }));
        state.saving = run.catch(() => {});
        await run;
      };
      const input = record(r.input);
      if (r.action === "snapshot") {
        const connections = await api.connections.list(userId).catch(() => []);
        return {
          settings,
          session: session(),
          busy: !!state.job,
          connections: connections.map((c) => ({ id: c.id, name: c.name, provider: c.provider, model: c.model })),
          permissions: { generation: api.permissions.has("generation"), characters: api.permissions.has("characters"), world_books: api.permissions.has("world_books"), personas: api.permissions.has("personas") }
        };
      }
      if (r.action === "stop") {
        state.job?.abort();
        return true;
      }
      if (r.action === "saveSettings") {
        const connectionId = text(input.connectionId ?? "", "connection", 100);
        if (connectionId && !await api.connections.get(connectionId, userId))
          throw new Error("That connection is gone. Pick another one.");
        state.settings = { connectionId, thinking: THINKING.includes(input.thinking) ? input.thinking : settings.thinking };
        await api.userStorage.setJson(SETTINGS, state.settings, { userId });
        return state.settings;
      }
      if (r.action === "exportSession") {
        return { kind: "paige-backup", version: 1, savedAt: Date.now(), session: session() };
      }
      if (state.job && r.action !== "lumicastStatus")
        throw new Error("Paige is still writing. Wait for her, or press Stop.");
      if (r.action === "setMode") {
        session().mode = input.mode === "quick" ? "quick" : "full";
        await persist();
        broadcast();
        return session();
      }
      if (r.action === "importSession") {
        let backup = record(input.backup);
        if (!("kind" in backup) && backup.version === 1 && Array.isArray(backup.turns) && Array.isArray(backup.blocks))
          backup = { kind: "paige-backup", version: 1, session: backup };
        if (backup.kind !== "paige-backup")
          throw new Error("That file isn't a Paige backup.");
        if (backup.version !== 1)
          throw new Error("That backup is from a newer Paige. Update Paige, then load it again.");
        const restored = readSession(backup.session);
        if (!restored)
          throw new Error("That backup is damaged, so nothing was loaded.");
        if (session().turns.length > 1 || session().blocks.length) {
          try {
            await api.userStorage.setJson(`old/${session().id}.json`, session(), { userId });
          } catch {}
        }
        delete restored.undo;
        state.session = restored;
        await persist();
        broadcast();
        return session();
      }
      if (r.action === "startOver") {
        try {
          await api.userStorage.setJson(`old/${session().id}.json`, session(), { userId });
        } catch {}
        state.session = freshSession(input.mode === "quick" ? "quick" : "full");
        await persist();
        broadcast();
        return session();
      }
      if (r.action === "editBlock") {
        const block = session().blocks.find((b) => b.id === input.id);
        if (!block)
          throw new Error("That piece is no longer in the notebook.");
        const body = text(input.body, "piece text (maximum 40,000 characters)", 40000);
        if (!body)
          throw new Error("A piece can't be empty. Use Delete instead.");
        block.body = body;
        block.edited = true;
        block.updatedAt = Date.now();
        if (typeof input.name === "string" && input.name.trim())
          block.name = text(input.name, "name", 120);
        await persist();
        broadcast();
        return session();
      }
      if (r.action === "deleteBlock") {
        session().blocks = session().blocks.filter((b) => b.id !== input.id);
        await persist();
        broadcast();
        return session();
      }
      if (r.action === "keepFirst") {
        const block = session().blocks.find((b) => b.id === input.id && b.type === "First message");
        if (block)
          block.keep = input.keep === true;
        await persist();
        broadcast();
        return session();
      }
      if (r.action === "send" || r.action === "retry") {
        if (!api.permissions.has("generation"))
          throw new Error("Grant Paige the generation permission in Extensions.");
        if (!settings.connectionId)
          throw new Error("Pick a model connection for Paige under Settings first.");
        const connection = await api.connections.get(settings.connectionId, userId);
        if (!connection)
          throw new Error("Paige's model connection is gone. Pick another one under Settings.");
        const current = session();
        if (r.action === "send") {
          const message = text(input.text, "message (maximum 20,000 characters)", 20000);
          if (!message)
            throw new Error("Type something first.");
          if (current.turns.length >= MAX_TURNS)
            throw new Error("This session is very long. Make the card, then use Start over for the next one.");
          current.turns.push({ role: "user", content: message, at: Date.now() });
          current.undo = current.blocks.map((b) => ({ ...b }));
        } else {
          const last = current.turns[current.turns.length - 1];
          if (last?.role === "assistant" && current.turns.length > 1)
            current.turns.pop();
          if (current.turns[current.turns.length - 1]?.role !== "user")
            throw new Error("There is nothing to retry yet.");
          if (current.undo)
            current.blocks = current.undo.map((b) => ({ ...b }));
          else
            current.undo = current.blocks.map((b) => ({ ...b }));
        }
        await persist();
        broadcast();
        const controller = new AbortController;
        state.job = controller;
        const timer = setTimeout(() => controller.abort(), 300000);
        let written = "";
        try {
          const request = {
            type: "raw",
            connection_id: connection.id,
            provider: connection.provider,
            model: connection.model,
            userId,
            messages: buildMessages({ mode: current.mode, blocks: current.blocks, turns: current.turns }),
            parameters: { max_tokens: 8000 },
            ...REASONING[settings.thinking] ? { reasoning: { ...REASONING[settings.thinking] } } : {},
            signal: controller.signal
          };
          let reasoning = "", finish = "";
          try {
            if (typeof api.generate.rawStream === "function") {
              let lastSend = 0;
              for await (const chunk of api.generate.rawStream(request)) {
                if (chunk.type === "token") {
                  written += chunk.token;
                  if (Date.now() - lastSend > 80) {
                    lastSend = Date.now();
                    send({ type: "paige:stream", id: r.id, text: written });
                  }
                } else if (chunk.type === "reasoning")
                  reasoning += chunk.token;
                else if (chunk.type === "done") {
                  written = chunk.content || written;
                  reasoning = chunk.reasoning || reasoning;
                  finish = chunk.finish_reason;
                }
              }
            } else {
              const value = record(await api.generate.raw(request));
              written = typeof value.content === "string" ? value.content : "";
              reasoning = typeof value.reasoning === "string" ? value.reasoning : "";
              finish = String(value.finish_reason ?? "");
            }
          } catch (error) {
            if (controller.signal.aborted && written.trim())
              finish = "stopped";
            else {
              if (controller.signal.aborted)
                throw Object.assign(new Error("Stopped."), { name: "AbortError" });
              throw generationError(error, connection.provider, connection.model);
            }
          }
          if (!written.trim())
            throw new ModelRequestError(reasoning ? "The model only thought and never answered. Set Thinking to Off or Light under Settings, or try again." : `The model sent back an empty reply (finish reason: ${finish || "none given"}). Try again, or pick another connection.`);
          const parsed = parseBlocks(written);
          const outcome = upsertBlocks(current.blocks, parsed);
          current.blocks = outcome.sheet;
          const saved = [...outcome.added.map((b) => `Added ${b.type.toLowerCase()}: ${b.name}`), ...outcome.replaced.map((b) => `Updated ${b.type.toLowerCase()}: ${b.name}`)];
          current.turns.push({ role: "assistant", content: written.trim(), at: Date.now(), ...saved.length ? { saved } : {} });
          await persist();
          return { session: current, stopped: finish === "stopped", cutOff: /length|max_tokens/i.test(finish) };
        } finally {
          clearTimeout(timer);
          state.job = undefined;
          broadcast();
        }
      }
      if (r.action === "makeCard") {
        for (const permission of ["characters", "world_books"])
          if (!api.permissions.has(permission))
            throw new Error(`Grant Paige the ${permission} permission in Extensions to make the card.`);
        const current = session();
        if (!current.blocks.some((b) => b.type !== "First message"))
          throw new Error("The notebook is empty. Build something with Paige first.");
        const plan = planCard(current.blocks, { name: typeof input.name === "string" ? input.name : "" });
        if (plan.persona && !api.permissions.has("personas"))
          throw new Error("Grant Paige the personas permission in Extensions to make your persona, or delete the persona from the notebook.");
        const mark = { paige: { sessionId: current.id } };
        const old = current.card ? await api.characters.get(current.card.characterId, userId).catch(() => null) : null;
        let book = old && current.card?.worldBookId && old.world_book_ids?.includes(current.card.worldBookId) ? await api.world_books.get(current.card.worldBookId, userId).catch(() => null) : null;
        if (!book)
          book = await api.world_books.create({ name: `${plan.card.name} \xB7 Paige`.slice(0, 100), description: "Characters and lore built with Paige.", metadata: mark }, userId);
        else {
          await api.world_books.update(book.id, { name: `${plan.card.name} \xB7 Paige`.slice(0, 100) }, userId).catch(() => {});
          for (let offset = 0, guard = 0;guard < 50; guard++) {
            const page = await api.world_books.entries.list(book.id, { offset, limit: 200, userId });
            const ours = page.data.filter((e) => record(e.extensions).paige);
            for (const entry of ours)
              await api.world_books.entries.delete(entry.id, userId);
            offset += page.data.length - ours.length;
            if (page.data.length < 200)
              break;
          }
        }
        for (const [index, entry] of plan.entries.entries()) {
          await api.world_books.entries.create(book.id, { key: entry.key, comment: entry.comment, content: entry.content, constant: entry.constant, selective: false, disabled: false, case_sensitive: false, match_whole_words: true, order_value: 100 + index, extensions: { paige: { sessionId: current.id } } }, userId);
        }
        const fields = { ...plan.card, world_book_ids: [...new Set([...old?.world_book_ids ?? [], book.id])] };
        const character = old ? await api.characters.update(old.id, fields, userId) : await api.characters.create({ ...fields, extensions: mark }, userId);
        let personaId, personaName = "", personaNote = "";
        if (plan.persona) {
          const existing = current.card?.personaId ? await api.personas.get(current.card.personaId, userId).catch(() => null) : null;
          const persona = existing ? await api.personas.update(existing.id, plan.persona, userId) : await api.personas.create({ ...plan.persona, metadata: mark }, userId);
          personaId = persona.id;
          personaName = persona.name;
        } else if (current.card?.personaId)
          personaNote = "The persona from last time was left alone in Lumiverse.";
        current.card = { characterId: character.id, worldBookId: book.id, personaId, name: character.name, savedAt: Date.now() };
        await persist();
        broadcast();
        let cast = null;
        if (input.sendLooks === true)
          cast = await sendLooks(current, plan.card.name);
        return { updated: !!old, name: character.name, entries: plan.entries.length, greetings: (plan.card.first_mes ? 1 : 0) + plan.card.alternate_greetings.length, personaName, personaNote, notes: plan.notes, cast, session: current };
      }
      if (r.action === "sendLooks")
        return await sendLooks(session(), session().card?.name ?? "", Array.isArray(input.only) ? input.only.filter((n) => typeof n === "string").slice(0, 40) : undefined);
      if (r.action === "lumicastStatus") {
        const pool = api.rpcPool;
        if (typeof pool?.read !== "function")
          return null;
        try {
          const status = record(await pool.read("lumicast.paige.status"));
          return status.sessionId === session().id ? status : null;
        } catch {
          return null;
        }
      }
      throw new Error("Unknown Paige action.");
      async function sendLooks(current, cardName, only) {
        const wanted = only && new Set(only.map((n) => n.trim().toLowerCase()));
        const looks = looksFrom(current.blocks).filter((l) => !wanted || wanted.has(l.name.trim().toLowerCase()));
        if (wanted && !looks.length)
          return { state: "skipped", message: "Pick at least one person to send." };
        if (!looks.length)
          return { state: "skipped", message: "No one in the notebook has a look section, so nothing went to LumiCast." };
        const pool = api.rpcPool;
        if (typeof pool?.sync !== "function" || typeof pool.read !== "function")
          return { state: "failed", message: "This Lumiverse version can't share data between extensions." };
        pool.sync("cast", { version: 1, sessionId: current.id, sentAt: Date.now(), userId: userId ?? "", card: cardName, characters: looks }, { requires: [] });
        try {
          const answer = record(await pool.read("lumicast.paige.start"));
          if (answer.ok !== true)
            return { state: "failed", message: typeof answer.message === "string" ? answer.message.slice(0, 300) : "LumiCast didn't take them." };
          return { state: "started", message: `LumiCast is working on ${looks.length} ${looks.length === 1 ? "look" : "looks"}: ${looks.map((l) => l.name).join(", ")}. They land in Lumi Studio as they finish.` };
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (/not registered|unknown endpoint|not found/i.test(message))
            return { state: "failed", message: "LumiCast isn't installed, or it's too old to take characters from Paige. Install or update LumiCast, then press Choose who to send." };
          return { state: "failed", message: `LumiCast didn't take them: ${message.replace(/^.*?:\s*(?=[A-Z])/, "").slice(0, 240) || "no reason given"}` };
        }
      }
    })().then((result) => reply(result)).catch((error) => {
      if (error instanceof Error && error.name === "AbortError")
        return reply(undefined, "Stopped.");
      const message = error instanceof Error ? error.message : "";
      const trusted = error instanceof ModelRequestError || /^(Grant Paige|Pick a|Paige|That |There |The |This |Type |A piece|Invalid |Unknown Paige)/.test(message);
      reply(undefined, trusted ? message : "Something went wrong. Your session is saved; try again.");
    });
  });
  return () => {
    closed = true;
    off();
    for (const s of users.values())
      s.job?.abort();
    users.clear();
  };
}
if (typeof spindle !== "undefined")
  setupBackend(spindle);
export {
  freshSession,
  setupBackend
};
