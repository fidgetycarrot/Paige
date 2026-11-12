import { describe, expect, test } from 'bun:test';
import { parseDetection, perspectiveRule, presetText } from '../src/perspective';

describe('perspective', () => {
  test('reads the model’s answer, and anything odd counts as unclear', () => {
    expect(parseDetection('Sure: {"pov": "2nd", "quote": "address the user as you"}')).toEqual({ pov: '2nd', quote: 'address the user as you' });
    expect(parseDetection('{"pov": "unclear", "quote": ""}').pov).toBeNull();
    expect(parseDetection('no idea').pov).toBeNull();
    expect(parseDetection('{"pov": "4th"}').pov).toBeNull();
  });
  test('limited third person forbids the main character’s private thoughts', () => {
    const rule = perspectiveRule('3rd-limited', 'x');
    expect(rule).toContain('Never narrate the main character\'s private thoughts');
    expect(rule).toContain('never write {{user}}');
    expect(perspectiveRule('1st', 'x')).toContain('narrates as "I"');
  });
  test('preset text keeps enabled blocks with words in them, within the limit', () => {
    const text = presetText([
      { name: 'A', content: 'one', enabled: true }, { name: 'B', content: 'two', enabled: false },
      { name: 'C', content: '   ' }, { name: 'D', content: 'cat', marker: 'category' }, { name: 'E', content: 'x'.repeat(100) },
    ], 50);
    expect(text).toBe('[A]\none');
  });
});
