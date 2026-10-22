import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FloppyImage, formattedDisk } from '../src/drive/floppy-image';
import type { Machine } from '../src/machine';
import { blankFormatFor, modelSpec, type ModelId } from '../src/models';
import { MAX_WIDTH } from '../src/video/vga';
import { gamesDir, loadDisk, runSeconds, runToBoot, runUntilText, startModel, typeText } from './helpers/machine';
import { screenText } from './helpers/png';

// Each machine's tests use its ROMs in roms/ and skip without them.
const freedos = join(gamesDir, 'freedos.img');
const freedos360 = join(gamesDir, 'freedos360.img');
const ALL: ModelId[] = ['m30-286', 'm30', 'm25', 'pc-at', 'pc-xt', 'pc'];

/** A disk whose boot sector runs `code` (loaded at 0000:7C00), with `handler` at 7C40h. */
function bootSector(code: number[], handler: number[] = []): FloppyImage {
  const disk = new Uint8Array(368640);
  disk.set(code);
  disk.set(handler, 0x40);
  disk[510] = 0x55;
  disk[511] = 0xaa;
  return new FloppyImage(disk, 'test');
}

describe.skipIf(!existsSync(freedos360))('floppy writes', () => {
  for (const id of ALL) {
    it(`DOS on the ${id} copies a file to a blank disk in B:`, { timeout: 60000 }, async (context) => {
      const model = modelSpec(id);
      const blank = new FloppyImage(formattedDisk(blankFormatFor(model.drives[1])), 'blank');
      const boot = model.drives[0] === '3.5-hd' ? freedos : freedos360;
      const machine = await startModel(id, loadDisk(boot), { diskB: blank });
      if (!machine) return context.skip();
      expect(runUntilText(machine, 'A:\\>', 90)).toBe(true);
      typeText(machine, 'copy readme.txt b:\n');
      runSeconds(machine, 8);
      typeText(machine, 'dir b:\n');
      runSeconds(machine, 5);
      expect(screenText(machine.video)).toMatch(/README {3}TXT {11}214/);
      expect(new TextDecoder('latin1').decode(blank.bytes)).toContain('README  TXT');
    });
  }
});

describe('graphics modes', () => {
  /** Sets a mode through the BIOS (INT 10h) and plots one pixel at (10, 10). */
  const plotter = (mode: number, color: number) =>
    bootSector([0xb8, mode, 0x00, 0xcd, 0x10, 0xb8, color, 0x0c, 0x31, 0xdb, 0xb9, 10, 0, 0xba, 10, 0, 0xcd, 0x10, 0xeb, 0xfe]);

  /** The pixel at (x, y) of a mode `width` by `height`, wherever the adapter puts it in its picture. */
  const pixel = (machine: Machine, mode: [number, number], x: number, y: number) => {
    const video = machine.video;
    const [width, height] = mode;
    return video.framebuffer[Math.floor((y * video.height) / height) * MAX_WIDTH + Math.floor((x * video.width) / width)];
  };

  const MODES: [number, number, [number, number], ModelId[]][] = [
    [0x04, 3, [320, 200], ['m30', 'pc-xt']],
    [0x05, 2, [320, 200], ['m30']],
    [0x06, 1, [640, 200], ['m30', 'pc-xt']],
    [0x11, 1, [640, 480], ['m30']],
    [0x13, 0x2c, [320, 200], ['m30']],
  ];
  for (const [mode, color, size, ids] of MODES) {
    it(`mode ${mode.toString(16)}h draws as the VGA does on ${ids.join(' and ')}`, { timeout: 60000 }, async (context) => {
      const vga = await startModel('m30-286', plotter(mode, color));
      if (!vga) return context.skip();
      runSeconds(vga, 30);
      const expected = [pixel(vga, size, 10, 10), pixel(vga, size, 11, 10), pixel(vga, size, 50, 50)];
      expect(expected[0]).not.toBe(expected[2]);
      for (const id of ids) {
        const machine = await startModel(id, plotter(mode, color));
        if (!machine) continue;
        runToBoot(machine, 90);
        runSeconds(machine, 2);
        expect([pixel(machine, size, 10, 10), pixel(machine, size, 11, 10), pixel(machine, size, 50, 50)], id).toEqual(expected);
      }
    });
  }
});

describe('CGA', () => {
  it("shows mode 5's third palette (cyan, red, white), unlike the VGA", { timeout: 60000 }, async (context) => {
    const machine = await startModel('pc-xt', bootSector([0xb8, 0x05, 0x00, 0xcd, 0x10, 0xb8, 0x02, 0x0c, 0x31, 0xdb, 0xb9, 10, 0, 0xba, 10, 0, 0xcd, 0x10, 0xeb, 0xfe]));
    if (!machine) return context.skip();
    runToBoot(machine, 90);
    runSeconds(machine, 2);
    // Colour 2 is light red (as ABGR).
    expect(machine.video.framebuffer[20 * MAX_WIDTH + 20]).toBe(0xff5555ff);
  });
});

describe('the PS/2 mouse through the BIOS', () => {
  /** Resets the pointing device (INT 15h C205h), installs a handler (C207h) that counts packets and keeps X and Y, and enables it (C200h). */
  const mouseTest = bootSector(
    [
      0x31, 0xc0, 0x8e, 0xd8, 0x8e, 0xc0, 0xb8, 0x05, 0xc2, 0xb7, 0x03, 0xcd, 0x15, 0x88, 0x26, 0xf0, 0x7d, 0xbb, 0x40, 0x7c, 0xb8, 0x07, 0xc2,
      0xcd, 0x15, 0x88, 0x26, 0xf1, 0x7d, 0xb8, 0x00, 0xc2, 0xb7, 0x01, 0xcd, 0x15, 0x88, 0x26, 0xf2, 0x7d, 0xc6, 0x06, 0xf3, 0x7d, 0x01, 0xfb,
      0xeb, 0xfe,
    ],
    [0x55, 0x89, 0xe5, 0x2e, 0xff, 0x06, 0xf4, 0x7d, 0x8b, 0x46, 0x0a, 0x2e, 0xa3, 0xf6, 0x7d, 0x8b, 0x46, 0x08, 0x2e, 0xa3, 0xf8, 0x7d, 0x5d, 0xcb],
  );

  for (const id of ['m30-286', 'm30', 'm25'] as ModelId[]) {
    it(`reaches a program's handler on the ${id}`, { timeout: 60000 }, async (context) => {
      const machine = await startModel(id, mouseTest);
      if (!machine) return context.skip();
      runSeconds(machine, 35);
      const at = (address: number) => machine.read8(address);
      // Set up, with each service succeeding.
      expect([at(0x7df3), at(0x7df0), at(0x7df1), at(0x7df2)]).toEqual([1, 0, 0, 0]);
      machine.kbc.mouse.move(12, -7);
      runSeconds(machine, 0.5);
      expect(at(0x7df4)).toBe(1);
      // A PS/2 mouse counts up as positive.
      expect([at(0x7df6), at(0x7df8)]).toEqual([12, 7]);
    });
  }
});

describe.skipIf(!existsSync(freedos360))('other set-ups', () => {
  it('a 512K Model 25 maps its RAM from 0 and boots', { timeout: 60000 }, async (context) => {
    const machine = await startModel('m25', loadDisk(freedos360), { kilobytes: 512 });
    if (!machine) return context.skip();
    expect(runUntilText(machine, 'A:\\>', 90)).toBe(true);
    // 511K: the BIOS keeps its extended data area in the top 1K.
    expect(machine.read16(0x413)).toBe(511);
    expect(machine.gateArray.ramControl & 1).toBe(1);
  });

  it.skipIf(!existsSync(freedos))('the PS/1 starts from a disk in A:', { timeout: 60000 }, async (context) => {
    const machine = await startModel('ps1-2011', loadDisk(freedos));
    if (!machine) return context.skip();
    expect(runUntilText(machine, 'A:\\>', 60)).toBe(true);
  });
});
