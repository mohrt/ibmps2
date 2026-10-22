import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeSession, encodeSession } from '../src/storage/save-states';
import type { ModelId } from '../src/models';
import { ROMS, gamesDir, hasRom, loadDisk, runSeconds, runToBoot, runUntilText, startMachine, startModel, typeText } from './helpers/machine';
import { screenText } from './helpers/png';

const freedos = join(gamesDir, 'freedos.img');
const freedos360 = join(gamesDir, 'freedos360.img');

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
    expect(screenText(restored.video)).toContain('FreeCom version');
  });
});

describe.skipIf(!existsSync(freedos360))('save states of the other machines', () => {
  // The gate array, MCGA and the Model 30's clock; the PC's 8255 and CGA.
  for (const id of ['m30', 'pc-xt'] as ModelId[]) {
    it(`carry a running DOS on the ${id} over to a fresh one`, { timeout: 60000 }, async (context) => {
      const machine = await startModel(id, loadDisk(freedos360));
      if (!machine) return context.skip();
      expect(runUntilText(machine, 'A:\\>', 90)).toBe(true);
      const state = (await decodeSession(
        await encodeSession({ machine: machine.saveState(), model: id, biosCrc: 1, biosTitle: 'BIOS', memory: 640, secondDrive: false, disks: [null, null] }),
      )).machine;
      const restored = (await startModel(id, loadDisk(freedos360)))!;
      restored.loadState(state);
      typeText(restored, 'ver\n');
      runSeconds(restored, 2);
      expect(screenText(restored.video)).toContain('FreeCom version');
    });
  }
});
