import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defaultCmos } from '../../src/chips/cmos-defaults';
import { FloppyImage } from '../../src/drive/floppy-image';
import { Machine } from '../../src/machine';
import { freshCmos, modelSpec, type ModelId } from '../../src/models';
import { RomLibrary } from '../../src/roms/rom-library';
import { MemoryStore } from '../../src/storage/store';
import { screenText } from './png';

const root = join(import.meta.dirname, '..', '..');

/** The user's BIOS ROMs (never committed) and the free disks (`npm run fetch:games`). */
export const ROMS = {
  rev2: join(root, 'roms', '33f5381a.bin'),
  rev0: join(root, 'roms', '27F4092.BIN'),
};
export const gamesDir = join(root, 'public', 'games');
export const hasRom = (path: string) => existsSync(path);

/** Every ROM file under roms/, for the machines put together from several chips. */
function romFiles(dir = join(root, 'roms')): { name: string; data: Uint8Array }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? romFiles(path) : [{ name: path, data: new Uint8Array(readFileSync(path)) }];
  });
}

/** A machine of the given model with its ROMs from roms/ (null when they aren't all there). */
export async function startModel(id: ModelId, disk?: FloppyImage, kilobytes?: number): Promise<Machine | null> {
  const library = new RomLibrary(new MemoryStore());
  await library.add(romFiles(), id);
  const rom = await library.assemble(id);
  if (!rom) return null;
  const model = modelSpec(id);
  const memory = kilobytes ?? model.defaultMemory;
  const machine = new Machine();
  machine.setModel(model);
  machine.setRom(rom.image);
  for (const extra of model.extraRoms) {
    const part = await library.assemble(extra);
    if (!part) return null;
    if (extra === 'cga-font') machine.setCgaFont(part.image);
  }
  machine.setMemory(memory);
  const cmos = freshCmos(model, memory, false);
  if (cmos) machine.loadCmos(cmos);
  machine.powerOn(new Date(2026, 9, 22, 12, 0, 0));
  if (disk) machine.insertDisk(0, disk);
  return machine;
}

export function loadDisk(path: string): FloppyImage {
  return new FloppyImage(new Uint8Array(readFileSync(path)), path.split('/').pop()!);
}

/** A PS/2 with a BIOS and a configured CMOS, switched on (with a disk in A: if given). */
export function startMachine(romPath: string, disk?: FloppyImage, kilobytes = 2048): Machine {
  const machine = new Machine();
  machine.setRom(readFileSync(romPath));
  machine.setMemory(kilobytes);
  machine.loadCmos(defaultCmos(kilobytes, 1));
  machine.powerOn(new Date(2026, 9, 22, 12, 0, 0));
  if (disk) machine.insertDisk(0, disk);
  return machine;
}

export function runSeconds(machine: Machine, seconds: number): void {
  for (let i = 0; i < seconds * 10; i++) machine.run(machine.cpuHz / 10);
}

/** Runs until the power-on self test hands over to a disk (or gives up); returns the emulated seconds it took. */
export function runToBoot(machine: Machine, limitSeconds = 60): number {
  for (let tenths = 0; tenths < limitSeconds * 10; tenths++) {
    if (!machine.starting) return tenths / 10;
    machine.run(machine.cpuHz / 10);
  }
  return limitSeconds;
}

/** Runs until `text` shows on a text screen; returns whether it did within the limit. */
export function runUntilText(machine: Machine, text: string, limitSeconds = 20): boolean {
  for (let tenths = 0; tenths < limitSeconds * 10; tenths++) {
    if (screenText(machine.video).includes(text)) return true;
    machine.run(machine.cpuHz / 10);
  }
  return false;
}

const CODES: Record<string, string> = { ' ': 'Space', '\n': 'Enter', '.': 'Period', '\\': 'Backslash', '-': 'Minus' };

/** Types text on the PS/2's keyboard, a key every tenth of a second. */
export function typeText(machine: Machine, text: string): void {
  const keyboard = machine.kbc.keyboard;
  for (const char of text) {
    const code = CODES[char] ?? (/[0-9]/.test(char) ? `Digit${char}` : `Key${char.toUpperCase()}`);
    keyboard.press(code);
    machine.run(machine.cpuHz / 20);
    keyboard.release(code);
    machine.run(machine.cpuHz / 20);
  }
}
