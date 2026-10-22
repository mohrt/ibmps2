import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Machine } from '../src/machine';
import type { ModelId } from '../src/models';
import { ROMS, gamesDir, hasRom, loadDisk, runSeconds, runToBoot, runUntilText, startMachine, startModel, typeText } from './helpers/machine';
import { framePng, screenText } from './helpers/png';

// IBM's BIOS is never committed: these tests use your own copies in roms/ and skip without them.
const shots = process.env.SHOTS;
const freedos = join(gamesDir, 'freedos.img');
const freedos360 = join(gamesDir, 'freedos360.img');

function saveShot(name: string, machine: Machine): void {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  writeFileSync(join(shots, `${name}.png`), framePng(machine.video));
}

describe('power-on self test', () => {
  for (const [revision, path] of Object.entries(ROMS)) {
    it.skipIf(!hasRom(path))(`BIOS ${revision} passes POST and asks for a startup disk`, { timeout: 60000 }, () => {
      const machine = startMachine(path);
      runSeconds(machine, 30);
      saveShot(`post-${revision}`, machine);
      const text = screenText(machine.video);
      // The prompt for a disk is a picture with the function keys below it; errors would be listed as numbers.
      expect(text).toContain('F12');
      const numbers = text
        .split('\n')
        .filter((line) => !line.includes('F12'))
        .join(' ')
        .match(/\d{3,4}/g);
      expect(numbers, `error codes on screen:\n${text}`).toBeNull();
    });
  }
});

describe.skipIf(!hasRom(ROMS.rev2) || !existsSync(freedos))('FreeDOS', () => {
  it('boots from A: and lists the disk', { timeout: 60000 }, () => {
    const machine = startMachine(ROMS.rev2, loadDisk(freedos));
    expect(runToBoot(machine)).toBeLessThan(40);
    expect(runUntilText(machine, 'A:\\>')).toBe(true);
    typeText(machine, 'dir\n');
    runSeconds(machine, 2);
    saveShot('freedos-dir', machine);
    const text = screenText(machine.video);
    expect(text).toContain('KERNEL   SYS');
    expect(text).toContain('COMMAND  COM');
    expect(text).toMatch(/bytes free/);
  });
});

/** Boots FreeDOS from its 360 KB disk (which every model's drives read) and lists the disk. */
async function bootsFreeDos(id: ModelId, context: { skip: () => void }): Promise<void> {
  const machine = await startModel(id, loadDisk(freedos360));
  if (!machine) return context.skip();
  expect(runUntilText(machine, 'A:\\>', 90)).toBe(true);
  typeText(machine, 'dir\n');
  runSeconds(machine, 3);
  saveShot(`freedos-${id}`, machine);
  const text = screenText(machine.video);
  expect(text).toContain('COMMAND  COM');
  expect(text).toMatch(/bytes free/);
}

/** The other machines are built from several ROM chips in roms/ (each skips without its own). */
describe('the PS/2 Model 30 and Model 25 (8086)', () => {
  for (const id of ['m30', 'm25'] as ModelId[]) {
    it(`${id} passes POST and asks for a startup disk`, { timeout: 60000 }, async (context) => {
      const machine = await startModel(id);
      if (!machine) return context.skip();
      runSeconds(machine, 30);
      saveShot(`post-${id}`, machine);
      const text = screenText(machine.video);
      expect(text, text).toContain('F12');
      expect(text).not.toMatch(/\d{3}-/);
    });

    it.skipIf(!existsSync(freedos360))(`${id} boots FreeDOS from a 360 KB disk`, { timeout: 60000 }, (context) => bootsFreeDos(id, context));
  }
});

describe('the PC, XT and AT', () => {
  for (const id of ['pc-at', 'pc-xt', 'pc'] as ModelId[]) {
    it(`${id} passes POST into Cassette BASIC with no disk`, { timeout: 60000 }, async (context) => {
      const machine = await startModel(id);
      if (!machine) return context.skip();
      // The 4.77 MHz machines count their 640K for half a minute.
      expect(runUntilText(machine, 'Bytes free', 60), screenText(machine.video)).toBe(true);
      saveShot(`basic-${id}`, machine);
      expect(screenText(machine.video)).toContain('The IBM Personal Computer Basic');
    });

    it.skipIf(!existsSync(freedos360))(`${id} boots FreeDOS from its 360 KB disk`, { timeout: 60000 }, (context) => bootsFreeDos(id, context));
  }
});
