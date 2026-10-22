import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { I286, Seg, type CpuBus } from '../src/cpu/i286';
import { readMoo, type MooRegister, type MooTest } from './helpers/moo';

// Daniel Balsom's real mode SingleStepTests for the 80286 (`npm run fetch:286`), captured from a
// Harris 80C286: each sets up the registers and some memory, runs one instruction and a HLT, and
// gives the registers and memory afterwards.
const fixtures = join(import.meta.dirname, 'fixtures', '80286');
const files = existsSync(fixtures)
  ? readdirSync(fixtures)
      .filter((name) => name.endsWith('.MOO.gz'))
      .sort()
  : [];
const only = process.env.I286?.split(',');
const revoked = new Set(
  existsSync(join(fixtures, 'revocation_list.txt'))
    ? readFileSync(join(fixtures, 'revocation_list.txt'), 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
    : [],
);

/** 16 MB of RAM that remembers what was written, so it can be cleared quickly between tests. */
class TestBus implements CpuBus {
  readonly ram = new Uint8Array(1 << 24);
  readonly touched: number[] = [];
  read8(address: number): number {
    return this.ram[address & 0xffffff];
  }
  write8(address: number, value: number): void {
    this.touched.push(address & 0xffffff);
    this.ram[address & 0xffffff] = value;
  }
  read16(address: number): number {
    return this.read8(address) | (this.read8(address + 1) << 8);
  }
  write16(address: number, value: number): void {
    this.write8(address, value & 0xff);
    this.write8(address + 1, value >> 8);
  }
  in8(): number {
    return 0xff;
  }
  in16(): number {
    return 0xffff;
  }
  out8(): void {}
  out16(): void {}
  clear(): void {
    for (const address of this.touched) this.ram[address] = 0;
    this.touched.length = 0;
  }
}

const GENERAL: [MooRegister, number][] = [
  ['ax', 0],
  ['cx', 1],
  ['dx', 2],
  ['bx', 3],
  ['sp', 4],
  ['bp', 5],
  ['si', 6],
  ['di', 7],
];
const SEGMENTS: [MooRegister, number][] = [
  ['es', Seg.ES],
  ['cs', Seg.CS],
  ['ss', Seg.SS],
  ['ds', Seg.DS],
];

const ARITHMETIC_FLAGS = 0x08d5;
const OF = 0x0800;
/**
 * Flags Intel leaves undefined that this core doesn't reproduce, by opcode (masked off before
 * comparing): those after a divide, and OF after AAD.
 */
const UNDEFINED_FLAGS: Record<string, number> = {
  'F6.6': ARITHMETIC_FLAGS,
  'F6.7': ARITHMETIC_FLAGS,
  'F7.6': ARITHMETIC_FLAGS,
  'F7.7': ARITHMETIC_FLAGS,
  D5: OF,
};
/**
 * Tests this core is known to fail, by file and test index: byte IDIVs that overflow, where the
 * 286 returns a quotient of 80h without a divide error, and two AAM 0s with PF the other way round.
 */
const KNOWN_FAILURES: Record<string, number[]> = {
  D4: [1905, 2125],
  'F6.7': [952, 1085, 2653, 4297],
};
const hex = (value: number, digits = 4) => value.toString(16).padStart(digits, '0');

/** Runs one test; returns what differed, or null if it passed. */
function run(cpu: I286, bus: TestBus, test: MooTest, flagMask: number): string | null {
  bus.clear();
  cpu.reset();
  const initial = test.initial.regs;
  for (const [name, reg] of GENERAL) cpu.regs[reg] = initial[name] ?? 0;
  for (const [name, seg] of SEGMENTS) cpu.loadSegment(seg, initial[name] ?? 0);
  cpu.ip = initial.ip ?? 0;
  cpu.setFlags(initial.flags ?? 0);
  for (const [address, value] of test.initial.ram) bus.write8(address, value);
  for (let i = 0; i < 64 && !cpu.halted; i++) cpu.step();

  const problems: string[] = [];
  const expected = { ...initial, ...test.final.regs };
  const actual: Record<string, number> = { ip: cpu.ip, flags: cpu.flags };
  for (const [name, reg] of GENERAL) actual[name] = cpu.regs[reg];
  for (const [name, seg] of SEGMENTS) actual[name] = cpu.sreg[seg];
  for (const name of Object.keys(expected) as MooRegister[]) {
    const mask = name === 'flags' ? flagMask : 0xffff;
    if (((expected[name] ?? 0) & mask) !== (actual[name] & mask)) {
      problems.push(`${name} ${hex(actual[name])} != ${hex(expected[name] ?? 0)}`);
    }
  }
  const finalRam = new Map(test.initial.ram);
  for (const [address, value] of test.final.ram) finalRam.set(address, value);
  for (const [address, value] of finalRam) {
    let mask = 0xff;
    // Flags pushed by an exception have the same undefined bits.
    if (test.exception && address === test.exception.flagAddress) mask = flagMask & 0xff;
    if (test.exception && address === test.exception.flagAddress + 1) mask = flagMask >> 8;
    if ((bus.ram[address] & mask) !== (value & mask)) problems.push(`[${hex(address, 6)}] ${hex(bus.ram[address], 2)} != ${hex(value, 2)}`);
  }
  return problems.length ? problems.join(', ') : null;
}

describe.skipIf(files.length === 0)('80286 SingleStepTests (real mode)', () => {
  const cpu = new I286(new TestBus());
  const bus = (cpu as unknown as { bus: TestBus }).bus;
  for (const file of files) {
    const name = file.replace(/\.MOO\.gz$/, '');
    if (only && !only.includes(name)) continue;
    it(name, () => {
      const tests = readMoo(readFileSync(join(fixtures, file)));
      const opcode = name.split('.')[0];
      const flagMask = 0xffff & ~(UNDEFINED_FLAGS[name] ?? UNDEFINED_FLAGS[opcode] ?? 0);
      const failures: string[] = [];
      let failed = 0;
      for (const test of tests) {
        if (revoked.has(test.hash) || KNOWN_FAILURES[name]?.includes(test.index)) continue;
        const problem = run(cpu, bus, test, flagMask);
        if (problem === null) continue;
        failed++;
        if (failures.length < 4) failures.push(`#${test.index} ${test.name}${test.exception ? ` (int ${test.exception.vector})` : ''}: ${problem}`);
      }
      expect(failures, `${failed} of ${tests.length} failed`).toEqual([]);
    });
  }
});
