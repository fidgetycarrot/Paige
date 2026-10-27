import type { Block, Mode } from './blocks';

export type Thinking = 'light' | 'off' | 'inherit';
export const THINKING: Thinking[] = ['light', 'off', 'inherit'];
export interface Settings { connectionId: string; thinking: Thinking }

export interface Turn { role: 'user' | 'assistant'; content: string; at: number; /** What this reply put on the Sheet, for the little note under it. */ saved?: string[] }
export interface SavedCard { characterId: string; worldBookId: string; personaId?: string; name: string; savedAt: number }
export interface Session {
  version: 1; id: string; mode: Mode; startedAt: number; turns: Turn[]; blocks: Block[];
  /** The Sheet as it was before Paige's last reply, so Retry can take that reply back cleanly. */
  undo?: Block[];
  card?: SavedCard;
}
export interface Snapshot {
  settings: Settings; session: Session; busy: boolean;
  connections: { id: string; name: string; provider: string; model: string }[];
  permissions: Record<'generation' | 'characters' | 'world_books' | 'personas', boolean>;
}
export interface CastStatus { state: 'started' | 'skipped' | 'failed'; message: string }
export interface CardResult { updated: boolean; name: string; entries: number; greetings: number; personaName: string; personaNote: string; notes: string[]; cast: CastStatus | null; session: Session }
/** What LumiCast publishes at lumicast.paige.status while it works through Paige's looks. */
export interface LumiCastStatus { sessionId: string; done: number; total: number; running: boolean; current?: string; finished: { name: string; ok: boolean; message: string }[] }

export const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function text(v: unknown, label: string, max: number): string {
  if (typeof v !== 'string' || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) throw new Error(`Invalid ${label}.`);
  return v.trim();
}
