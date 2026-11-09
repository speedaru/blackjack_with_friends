import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Entry {
  /** Display name, keeping the case that was used first. */
  name: string;
  chips: number;
  /** Running result: negative is what the player owes. Wins and withdrawals raise it, losses and borrowing lower it. */
  earnings: number;
}

/**
 * Chips saved per username in `<dataDir>/players.json`, which maps each username to its chip count,
 * or to `{ "chips": 0, "earnings": -1000 }` for a player whose earnings are not 0 (`earnings` is left
 * out when 0). A `debt` field from older files is ignored: the earnings already include it.
 * Usernames match ignoring case. The file is only written by `save()`, using a temporary file
 * and a rename so a crash never leaves a half-written file.
 */
export class PlayerStore {
  private readonly entries = new Map<string, Entry>();
  private readonly file: string;

  constructor(
    private readonly dataDir: string,
    private readonly warn: (message: string) => void = (m) => console.warn(m),
  ) {
    this.file = join(dataDir, 'players.json');
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('expected a JSON object');
      }
    } catch (err) {
      this.backUpBrokenFile(err);
      return;
    }
    const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      const key = name.toLowerCase();
      const obj = value !== null && typeof value === 'object' ? (value as { chips?: unknown; earnings?: unknown }) : null;
      const chips = obj ? obj.chips : value;
      const earnings = obj && obj.earnings !== undefined ? obj.earnings : 0;
      if (!valid(chips) || typeof earnings !== 'number' || !Number.isFinite(earnings)) {
        this.warn(`players.json: ignoring "${name}", its chip count is not a valid number`);
        continue;
      }
      if (this.entries.has(key)) continue; // first spelling wins
      this.entries.set(key, { name, chips: Math.floor(chips), earnings: Math.trunc(earnings) });
    }
  }

  private backUpBrokenFile(err: unknown): void {
    const reason = err instanceof Error ? err.message : String(err);
    const backup = `${this.file}.bak`;
    try {
      renameSync(this.file, backup);
      this.warn(`players.json could not be read (${reason}). Moved it to players.json.bak and starting with no saved players.`);
    } catch (renameErr) {
      const why = renameErr instanceof Error ? renameErr.message : String(renameErr);
      this.warn(`players.json could not be read (${reason}) and could not be moved aside (${why}). Starting with no saved players.`);
    }
  }

  /** Saved entry for a username, matched ignoring case. */
  get(name: string): Entry | undefined {
    return this.entries.get(name.toLowerCase());
  }

  /**
   * Sets the chips for a username in memory, and the earnings when given (kept as they were otherwise). Call `save()` to write them to disk.
   */
  set(name: string, chips: number, earnings?: number): void {
    const key = name.toLowerCase();
    const existing = this.entries.get(key);
    this.entries.set(key, {
      name: existing?.name ?? name,
      chips: Math.max(0, Math.floor(chips)),
      earnings: Math.trunc(earnings ?? existing?.earnings ?? 0),
    });
  }

  /** Writes the file. Never throws: a failed save is logged and the game goes on. */
  save(): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const data: Record<string, number | { chips: number; earnings?: number }> = {};
      for (const { name, chips, earnings } of this.entries.values()) {
        data[name] = earnings !== 0 ? { chips, earnings } : chips;
      }
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      renameSync(tmp, this.file);
    } catch (err) {
      this.warn(`Could not save players.json: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
