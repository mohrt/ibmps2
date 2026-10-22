import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseGameManifest } from '../src/games';
import { MAX_WIDTH } from '../src/video/vga';
import { ROMS, gamesDir, hasRom, loadDisk, runSeconds, runToBoot, startMachine } from './helpers/machine';
import { screenText } from './helpers/png';

describe('game manifest', () => {
  it('keeps well-formed entries and drops unsafe paths', () => {
    const games = parseGameManifest({
      games: [
        { title: 'Good', file: 'good.img', licenseUrl: 'games/good.img.license.txt', sourceUrl: 'https://example.com' },
        { title: 'Escape', file: '../secret.img' },
        { title: 'Bad link', file: 'bad.img', licenseUrl: 'javascript:alert(1)' },
        { file: 'untitled.img' },
      ],
    });
    expect(games.map((game) => game.title)).toEqual(['Good', 'Bad link']);
    expect(games[0].licenseUrl).toBe('games/good.img.license.txt');
    expect(games[1].licenseUrl).toBeUndefined();
  });

  it('lists every catalog entry with its licence', () => {
    const catalog = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'scripts', 'games-catalog.json'), 'utf8'));
    for (const game of catalog.games) {
      expect(game.license, game.title).toBeTruthy();
      expect(game.sha256, game.title).toMatch(/^[0-9a-f]{64}$/);
      expect(game.url, game.title).toMatch(/^https:\/\/raw\.githubusercontent\.com\//);
    }
  });
});

const disks = existsSync(gamesDir) ? readdirSync(gamesDir).filter((name) => name.endsWith('.img')) : [];

/** How many different colours the picture has (a booted program draws something). */
function colours(machine: ReturnType<typeof startMachine>): number {
  const { framebuffer, width, height } = machine.vga;
  const seen = new Set<number>();
  for (let y = 0; y < height; y += 4) for (let x = 0; x < width; x += 4) seen.add(framebuffer[y * MAX_WIDTH + x]);
  return seen.size;
}

describe.skipIf(!hasRom(ROMS.rev2) || disks.length === 0)('free disks (npm run fetch:games)', () => {
  for (const file of disks) {
    it(`${file} boots and draws`, { timeout: 60000 }, () => {
      const machine = startMachine(ROMS.rev2, loadDisk(join(gamesDir, file)));
      expect(runToBoot(machine)).toBeLessThan(40);
      runSeconds(machine, 4);
      // The BIOS's prompt for a startup disk has the function keys along the bottom.
      expect(screenText(machine.vga)).not.toContain('F12');
      expect(colours(machine)).toBeGreaterThan(1);
    });
  }
});
