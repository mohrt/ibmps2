import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseGameManifest } from '../src/games';
import type { Machine } from '../src/machine';
import type { ModelId } from '../src/models';
import { MAX_WIDTH } from '../src/video/vga';
import { gamesDir, loadDisk, runSeconds, runToBoot, startModel } from './helpers/machine';
import { screenText } from './helpers/png';

describe('game manifest', () => {
  it('keeps well-formed entries and drops unsafe paths', () => {
    const games = parseGameManifest({
      games: [
        { title: 'Good', file: 'good.img', licenseUrl: 'games/good.img.license.txt', sourceUrl: 'https://example.com', models: ['pc'] },
        { title: 'Escape', file: '../secret.img' },
        { title: 'Bad link', file: 'bad.img', licenseUrl: 'javascript:alert(1)' },
        { file: 'untitled.img' },
      ],
    });
    expect(games.map((game) => game.title)).toEqual(['Good', 'Bad link']);
    expect(games[0].licenseUrl).toBe('games/good.img.license.txt');
    expect(games[1].licenseUrl).toBeUndefined();
    expect(games[0].models).toEqual(['pc']);
    expect(games[1].models).toBeUndefined();
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

const manifest = join(gamesDir, 'index.json');
const listed = existsSync(manifest) ? parseGameManifest(JSON.parse(readFileSync(manifest, 'utf8'))) : [];

/** How many different colours the picture has (a booted program draws something). */
function colours(machine: Machine): number {
  const { framebuffer, width, height } = machine.video;
  const seen = new Set<number>();
  for (let y = 0; y < height; y += 4) for (let x = 0; x < width; x += 4) seen.add(framebuffer[y * MAX_WIDTH + x]);
  return seen.size;
}

describe.skipIf(listed.length === 0)('free disks (npm run fetch:games)', () => {
  for (const game of listed) {
    // Disks for every model are tried on a PS/2 and on the XT, whose drives read only double density.
    const models = (game.models ?? ['m30-286', 'pc-xt']) as ModelId[];
    for (const id of new Set([models[0], models.at(-1)!])) {
      it(`${game.file} boots and draws on the ${id}`, { timeout: 60000 }, async (context) => {
        const machine = await startModel(id, loadDisk(join(gamesDir, game.file)));
        if (!machine) return context.skip();
        expect(runToBoot(machine)).toBeLessThan(40);
        runSeconds(machine, 4);
        // Without a disk the PS/2s ask for one (with the function keys along the bottom) and the PCs start BASIC.
        const text = screenText(machine.video);
        expect(text).not.toContain('F12');
        expect(text).not.toContain('Bytes free');
        expect(colours(machine)).toBeGreaterThan(1);
      });
    }
  }
});
