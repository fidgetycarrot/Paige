# Paige

Paige is a Lumiverse extension that builds a character card with you. She interviews you one piece at a time (main character, side characters, scenario, locations, items, factions, history, concepts), pushes back on vague answers, and tapes every finished piece into your notebook. When you're done, **Make my card** builds the card, its lorebook and your persona in one go.

Paige, her personality and her whole interview are by **Deiomo** ([deiomo.github.io](https://deiomo.github.io/)), from the card "Paige (All-in-one writing assistant)", used with permission. This extension runs her inside Lumiverse so nothing has to be copied and pasted.

## Install

In Lumiverse, open Extensions and install from GitHub: `https://github.com/fidgetycarrot/Paige`

Give it these permissions: generation, characters, world_books, personas, presets. For **Let Paige read the roleplay** (optional), also chats and chat_mutation; Paige only reads chats with them, never changes one.

## Use

1. **Settings:** pick the model connection Paige should use and save. It doesn't have to be your story model.
2. **Chat:** answer Paige. The buttons above the box send her commands: Skip, You decide, Back, What's done, Next, Done.
   - **Full interview** (the default): one section at a time.
   - **Quick draft:** give her the pitch and she drafts the whole piece, then goes through the weak spots with you.
3. **Notebook:** every finished piece is taped in here. Open one to read it, edit it, or delete it. Your edits win; Paige uses your version from then on. First messages have a "Use on the card" box.
4. **Make my card**, at the bottom of the Notebook:
   - Main character goes in the description, the scenario in the scenario field.
   - Side characters and lore become lorebook entries, keyed on their names, other names and trigger words.
   - Kept first messages become the greeting and alternate greetings.
   - Your persona, if you made one with Paige, is created in Lumiverse.
   - Pressing it again later updates the same card instead of making a second one. Lorebook entries you added by hand stay.

**Full screen** (top right, on a Mac or other big screen) opens Paige over the whole window. Pick **Side by side** (chat on the left, notebook on the right) or **One wide chat**. **Back to the side panel** or Esc puts her back. She remembers both choices.

**Save a backup** in Settings downloads the whole chat and notebook as a file. **Load a backup** brings one back, and also takes Paige's own `session.json` from her storage folder. Whatever was open is kept in Paige's storage.

**First messages are written in** (Settings) picks the perspective for the first messages Paige writes. By default it matches your main chat preset: Paige reads that preset once to see how it writes (plain "third person" counts as from the outside), and again only when the preset changes. If the preset doesn't say, or the presets permission isn't given, she writes third person from the outside, never showing the main character's private thoughts. You can also pick a perspective yourself.

**Retry** takes back Paige's last reply (and anything it put in the notebook) and asks again. **Start over** in Settings clears the chat and notebook for a new card; the old chat is kept in Paige's storage.

## Fixing a card you've played

**Bring a card** (top of the panel) lists your cards. Pick one, any card, not just ones Paige made, and she reads the whole card and its lorebook into a fresh notebook. What was open before is kept in her storage. She starts by asking what you wanted from playing it and what happened instead. Then she finds the causes, says honestly how big the fix is (a tweak, a reworked piece, or rethinking the premise), tests her own ideas before offering them, and rebuilds pieces with her normal section-by-section flow when they need it. While fixing, Light thinking steps up to Medium, since diagnosing a whole card takes more thought than building one section.

- **Let Paige read the roleplay**: switch it on and pick one of the card's chats. Paige reads the end of it (about the last 24,000 characters) with every message you send her, so she can see the problem herself. It costs more per message, so switch it off once she's seen enough.
- **Update "card name"** saves only the pieces that changed, back where they came from: the description, scenario and other card fields, the greetings, and each lorebook entry in its own lorebook. A piece you delete from the notebook is switched off in the lorebook, not deleted, in case another card shares it. New pieces go into a "· Paige" lorebook attached to the card.
- **Save as a copy instead** leaves the original card exactly as it is (for chats you don't want changed) and makes a new card with its own copy of the lorebook. The copy has no picture; add one in Lumiverse. After that, Update saves to the copy.
- A very big lorebook (over 300 active entries) only brings its first 300 into the notebook; the rest stay as they are.

## LumiCast and Lumi Studio

Tick "Also send everyone's looks to LumiCast" before Make my card. Paige sends each character's look (and your persona's) to LumiCast 0.14.1 or newer, which translates them in the background with its own settings. Each one lands in Lumi Studio 1.13.1 or newer as a new reusable character or persona. Nobody already in Lumi Studio is ever replaced: a taken name is saved as "Vesper 2", Paige tells you, and Lumi Studio marks it **needs a new name** until you rename it. Progress shows under the button: who's done, who LumiCast is on and which step, a running clock, and a warning if it goes quiet. If the provider rate-limits, LumiCast waits and tries again twice before giving up. **Choose who to send** opens a list to tick; only the ticked ones are sent, and anyone who didn't make it last time is ticked for you. (LumiCast 0.14.3 or newer shows the steps.)

## What changed from the card

Only what running inside an extension needed:

- Finished pieces go into the notebook instead of being copied by hand, and the hand-off tells you to check it.
- No blank preset, empty persona or summarizer workaround; Paige has her own prompt and ignores your preset (except to match its perspective in first messages).
- First messages and the new optional persona step come out as pieces the app can pick up.
- The pointer to the single-character version of Paige is gone from her greeting.
- The quoted song lyric in her sign-off is now a short reference to it.

## Credits

The handwritten lettering is Permanent Marker by Font Diner, under the SIL Open Font License (`licenses/PermanentMarker-OFL.txt`).

## Build

```
bun install
bun test
bun run build
```

`dev/preview.html` runs the real panel and backend against a pretend Lumiverse (`bun build dev/preview.ts --outdir dev/build --target browser` first).
