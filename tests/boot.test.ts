import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROMS, gamesDir, hasRom, loadDisk, runSeconds, runToBoot, runUntilText, startMachine, typeText } from './helpers/machine';
import { framePng, screenText } from './helpers/png';

// IBM's BIOS is never committed: these tests use your own copies in roms/ and skip without them.
const shots = process.env.SHOTS;
const freedos = join(gamesDir, 'freedos.img');

function saveShot(name: string, machine: ReturnType<typeof startMachine>): void {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  writeFileSync(join(shots, `${name}.png`), framePng(machine.vga));
}

describe('power-on self test', () => {
  for (const [revision, path] of Object.entries(ROMS)) {
    it.skipIf(!hasRom(path))(`BIOS ${revision} passes POST and asks for a startup disk`, { timeout: 60000 }, () => {
      const machine = startMachine(path);
      runSeconds(machine, 30);
      saveShot(`post-${revision}`, machine);
      const text = screenText(machine.vga);
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
    const text = screenText(machine.vga);
    expect(text).toContain('KERNEL   SYS');
    expect(text).toContain('COMMAND  COM');
    expect(text).toMatch(/bytes free/);
  });
});
