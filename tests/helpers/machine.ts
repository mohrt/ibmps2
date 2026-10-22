import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultCmos } from '../../src/chips/cmos-defaults';
import { FloppyImage } from '../../src/drive/floppy-image';
import { CPU_HZ, Ps2 } from '../../src/ps2';
import { screenText } from './png';

const root = join(import.meta.dirname, '..', '..');

/** The user's BIOS ROMs (never committed) and the free disks (`npm run fetch:games`). */
export const ROMS = {
  rev2: join(root, 'roms', '33f5381a.bin'),
  rev0: join(root, 'roms', '27F4092.BIN'),
};
export const gamesDir = join(root, 'public', 'games');
export const hasRom = (path: string) => existsSync(path);

export function loadDisk(path: string): FloppyImage {
  return new FloppyImage(new Uint8Array(readFileSync(path)), path.split('/').pop()!);
}

/** A PS/2 with a BIOS and a configured CMOS, switched on (with a disk in A: if given). */
export function startMachine(romPath: string, disk?: FloppyImage, memory: 1 | 2 | 4 = 2): Ps2 {
  const machine = new Ps2();
  machine.setRom(readFileSync(romPath));
  machine.setMemory(memory);
  machine.loadCmos(defaultCmos(memory, 1));
  machine.powerOn(new Date(2026, 9, 22, 12, 0, 0));
  if (disk) machine.insertDisk(0, disk);
  return machine;
}

export function runSeconds(machine: Ps2, seconds: number): void {
  for (let i = 0; i < seconds * 10; i++) machine.run(CPU_HZ / 10);
}

/** Runs until the power-on self test hands over to a disk (or gives up); returns the emulated seconds it took. */
export function runToBoot(machine: Ps2, limitSeconds = 60): number {
  for (let tenths = 0; tenths < limitSeconds * 10; tenths++) {
    if (!machine.starting) return tenths / 10;
    machine.run(CPU_HZ / 10);
  }
  return limitSeconds;
}

/** Runs until `text` shows on a text screen; returns whether it did within the limit. */
export function runUntilText(machine: Ps2, text: string, limitSeconds = 20): boolean {
  for (let tenths = 0; tenths < limitSeconds * 10; tenths++) {
    if (screenText(machine.vga).includes(text)) return true;
    machine.run(CPU_HZ / 10);
  }
  return false;
}

const CODES: Record<string, string> = { ' ': 'Space', '\n': 'Enter', '.': 'Period', '\\': 'Backslash', '-': 'Minus' };

/** Types text on the PS/2's keyboard, a key every tenth of a second. */
export function typeText(machine: Ps2, text: string): void {
  const keyboard = machine.kbc.keyboard;
  for (const char of text) {
    const code = CODES[char] ?? (/[0-9]/.test(char) ? `Digit${char}` : `Key${char.toUpperCase()}`);
    keyboard.press(code);
    machine.run(CPU_HZ / 20);
    keyboard.release(code);
    machine.run(CPU_HZ / 20);
  }
}
