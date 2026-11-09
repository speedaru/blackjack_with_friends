import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PlayerStore } from '../server/store.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bj-store-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('PlayerStore', () => {
  it('starts empty when players.json is missing', () => {
    const warnings: string[] = [];
    const store = new PlayerStore(tempDir(), (m) => warnings.push(m));
    expect(store.get('Alex')).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('saves and loads chips, matching usernames ignoring case and keeping the first spelling', () => {
    const dir = tempDir();
    const store = new PlayerStore(dir);
    store.set('Alex', 1200);
    store.set('ALEX', 1300);
    store.set('bob', 50);
    store.save();
    expect(JSON.parse(readFileSync(join(dir, 'players.json'), 'utf8'))).toEqual({ Alex: 1300, bob: 50 });
    expect(existsSync(join(dir, 'players.json.tmp'))).toBe(false);

    const loaded = new PlayerStore(dir);
    expect(loaded.get('aLeX')).toEqual({ name: 'Alex', chips: 1300, earnings: 0 });
    expect(loaded.get('BOB')).toEqual({ name: 'bob', chips: 50, earnings: 0 });
  });

  it('stores the earnings next to the chips, and keeps them when only the chips are updated', () => {
    const dir = tempDir();
    const store = new PlayerStore(dir);
    store.set('Alex', 1000, -1000);
    store.set('Bob', 500);
    store.set('Alex', 1400); // earnings omitted: unchanged
    store.save();
    expect(JSON.parse(readFileSync(join(dir, 'players.json'), 'utf8'))).toEqual({
      Alex: { chips: 1400, earnings: -1000 },
      Bob: 500,
    });
    const loaded = new PlayerStore(dir);
    expect(loaded.get('alex')).toEqual({ name: 'Alex', chips: 1400, earnings: -1000 });
    loaded.set('Alex', 1400, 0);
    loaded.save();
    expect(JSON.parse(readFileSync(join(dir, 'players.json'), 'utf8')).Alex).toBe(1400);
  });

  it('ignores the debt field of an older file, since the earnings already include it', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'players.json'), JSON.stringify({ Alex: { chips: 1000, debt: 1000, earnings: -1000 } }));
    const store = new PlayerStore(dir);
    expect(store.get('alex')).toEqual({ name: 'Alex', chips: 1000, earnings: -1000 });
    store.save();
    expect(JSON.parse(readFileSync(join(dir, 'players.json'), 'utf8'))).toEqual({ Alex: { chips: 1000, earnings: -1000 } });
  });

  it('moves an unreadable file to players.json.bak and warns', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'players.json'), '{ this is not json');
    const warnings: string[] = [];
    const store = new PlayerStore(dir, (m) => warnings.push(m));
    expect(store.get('Alex')).toBeUndefined();
    expect(existsSync(join(dir, 'players.json'))).toBe(false);
    expect(readFileSync(join(dir, 'players.json.bak'), 'utf8')).toBe('{ this is not json');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('players.json.bak');

    store.set('Alex', 10);
    store.save();
    expect(JSON.parse(readFileSync(join(dir, 'players.json'), 'utf8'))).toEqual({ Alex: 10 });
  });

  it('treats a file that is not an object as broken', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'players.json'), '[1, 2, 3]');
    const warnings: string[] = [];
    new PlayerStore(dir, (m) => warnings.push(m));
    expect(existsSync(join(dir, 'players.json.bak'))).toBe(true);
    expect(warnings).toHaveLength(1);
  });

  it('skips entries with a bad chip count but keeps the rest', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'players.json'), JSON.stringify({ Alex: 100, Bob: 'lots', Cy: -5 }));
    const warnings: string[] = [];
    const store = new PlayerStore(dir, (m) => warnings.push(m));
    expect(store.get('Alex')?.chips).toBe(100);
    expect(store.get('Bob')).toBeUndefined();
    expect(store.get('Cy')).toBeUndefined();
    expect(warnings).toHaveLength(2);
  });

  it('creates the data folder on the first save', () => {
    const dir = join(tempDir(), 'nested', 'data');
    const store = new PlayerStore(dir);
    store.set('Alex', 1);
    store.save();
    expect(existsSync(join(dir, 'players.json'))).toBe(true);
  });
});
