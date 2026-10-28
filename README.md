# Paige

Paige is a Lumiverse extension that builds a character card with you. She interviews you one piece at a time (main character, side characters, scenario, locations, items, factions, history, concepts), pushes back on vague answers, and tapes every finished piece into your notebook. When you're done, **Make my card** builds the card, its lorebook and your persona in one go.

Paige, her personality and her whole interview are by **Deiomo** ([deiomo.github.io](https://deiomo.github.io/)), from the card "Paige (All-in-one writing assistant)", used with permission. This extension runs her inside Lumiverse so nothing has to be copied and pasted.

## Install

In Lumiverse, open Extensions and install from GitHub: `https://github.com/fidgetycarrot/Paige`

Give it these permissions: generation, characters, world_books, personas.

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

**Save a backup** in Settings downloads the whole chat and notebook as a file. **Load a backup** brings one back, and also takes Paige's own `session.json` from her storage folder. Whatever was open is kept in Paige's storage.

**Retry** takes back Paige's last reply (and anything it put in the notebook) and asks again. **Start over** in Settings clears the chat and notebook for a new card; the old chat is kept in Paige's storage.

## LumiCast and Lumi Studio

Tick "Also send everyone's looks to LumiCast" before Make my card. Paige sends each character's look (and your persona's) to LumiCast 0.14.1 or newer, which translates them in the background with its own settings. Each one lands in Lumi Studio 1.13.1 or newer as a new reusable character or persona. Nobody already in Lumi Studio is ever replaced: a taken name is saved as "Vesper 2", Paige tells you, and Lumi Studio marks it **needs a new name** until you rename it. Progress shows under the button. **Send looks again** reruns it after you change someone.

## What changed from the card

Only what running inside an extension needed:

- Finished pieces go into the notebook instead of being copied by hand, and the hand-off tells you to check it.
- No blank preset, empty persona or summarizer workaround; Paige has her own prompt and ignores your preset.
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
