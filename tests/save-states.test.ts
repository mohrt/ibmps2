import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeSession, encodeSession } from '../src/storage/save-states';
import { ROMS, gamesDir, hasRom, loadDisk, runSeconds, runToBoot, runUntilText, startMachine, typeText } from './helpers/machine';
import { screenText } from './helpers/png';

const freedos = join(gamesDir, 'freedos.img');

describe.skipIf(!hasRom(ROMS.rev2) || !existsSync(freedos))('save states', () => {
  it('carry a running DOS over to a fresh machine', { timeout: 60000 }, async () => {
    const disk = loadDisk(freedos);
    const machine = startMachine(ROMS.rev2, disk);
    runToBoot(machine);
    expect(runUntilText(machine, 'A:\\>')).toBe(true);
    const session = await decodeSession(
      await encodeSession({
        machine: machine.saveState(),
        biosCrc: 1,
        biosTitle: 'BIOS',
        memory: 2,
        secondDrive: false,
        disks: [{ name: 'FreeDOS', bytes: disk.bytes, origin: null }, null],
      }),
    );

    const restored = startMachine(ROMS.rev2, loadDisk(freedos));
    restored.loadState(session.machine);
    typeText(restored, 'ver\n');
    runSeconds(restored, 2);
    expect(screenText(restored.vga)).toContain('FreeCom version');
  });
});
