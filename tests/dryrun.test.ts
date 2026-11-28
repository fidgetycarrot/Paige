import { describe, expect, test } from 'bun:test';
import { dryRunText } from '../src/dryrun';

describe('what the model sees', () => {
  const run = {
    messages: [{ role: 'system', content: 'Big preset block.' }, { role: 'system', content: 'Note from an extension.' }, { role: 'assistant', content: 'story' }],
    breakdown: [
      { type: 'block', name: 'Setup', content: 'Big preset block.', preCountedTokens: 500 },
      { type: 'chat_history', name: 'History', content: 'story', messageCount: 12, preCountedTokens: 9000 },
      { type: 'world_info', name: 'Dean', content: 'x'.repeat(8000), extensionName: undefined },
      { type: 'block', name: 'Notes', content: 'From LumiBooks', extensionName: 'LumiBooks' },
    ],
    tokenCount: { total_tokens: 12345, breakdown: [{ name: 'Setup', type: 'block', tokens: 480 }] },
    worldInfoStats: { totalCandidates: 20, activatedAfterBudget: 6, evictedByBudget: 2, estimatedTokens: 3000 },
  };
  test('lists every piece with its size, counts the chat instead of copying it, and labels extensions', () => {
    const { text, tokens } = dryRunText(run, 'My chat');
    expect(tokens).toBe(12345);
    expect(text).toContain('Preset block: Setup, ~480 tokens');
    expect(text).toContain('Chat history: History, 12 messages, ~9,000 tokens');
    expect(text).toContain('(added by the LumiBooks extension)');
    expect(text).toContain('6 of 20 entries fired');
    expect(text).toContain('2 dropped for lack of room');
    expect(text).not.toContain('### Chat history');
    expect(text).toContain('more characters left out');
    expect(text).toContain('### Not labeled (probably an extension or a macro)\nNote from an extension.');
    expect(text).not.toContain('### Not labeled (probably an extension or a macro)\nBig preset block.');
  });
  test('stays within its budget', () => {
    const { text } = dryRunText(run, 'My chat', 1500);
    expect(text.length).toBeLessThan(2200);
    expect(text).toContain('hit its size limit');
  });
});
