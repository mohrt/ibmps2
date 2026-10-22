import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { I286, Seg, type CpuBus } from '../src/cpu/i286';
import { readMoo, type MooRegister, type MooTest } from './helpers/moo';

// Daniel Balsom's 8088 SingleStepTests (`npm run fetch:8088`), captured from an AMD D8088, run
// against the CPU in its 8086 mode. metadata.json gives the flags each instruction leaves undefined.
const fixtures = join(import.meta.dirname, 'fixtures', '8088');
const files = existsSync(fixtures)
  ? readdirSync(fixtures)
      .filter((name) => name.endsWith('.MOO.gz'))
      .sort()
  : [];
const only = process.env.I8088?.split(',');

interface OpcodeInfo {
  status?: string;
  'flags-mask'?: number;
  reg?: Record<string, OpcodeInfo>;
}
const metadata: Record<string, OpcodeInfo> = existsSync(join(fixtures, 'metadata.json'))
  ? JSON.parse(readFileSync(join(fixtures, 'metadata.json'), 'utf8')).opcodes
  : {};

/** The 8088's 1 MB, remembering what was written so it can be cleared quickly between tests. */
class TestBus implements CpuBus {
  readonly ram = new Uint8Array(1 << 20);
  readonly touched: number[] = [];
  read8(address: number): number {
    return this.ram[address & 0xfffff];
  }
  write8(address: number, value: number): void {
    this.touched.push(address & 0xfffff);
    this.ram[address & 0xfffff] = value;
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
const hex = (value: number, digits = 4) => value.toString(16).padStart(digits, '0');

/** The flags an opcode (file name such as "F6.6") leaves undefined, from the metadata. */
function flagMask(name: string): number {
  const [opcode, reg] = name.split('.');
  const info = metadata[opcode];
  const entry = reg !== undefined ? info?.reg?.[reg] : info;
  return entry?.['flags-mask'] ?? 0xffff;
}

function run(cpu: I286, bus: TestBus, test: MooTest, mask: number): string | null {
  bus.clear();
  cpu.reset();
  cpu.is8086 = true;
  const initial = test.initial.regs;
  for (const [name, reg] of GENERAL) cpu.regs[reg] = initial[name] ?? 0;
  for (const [name, seg] of SEGMENTS) cpu.loadSegment(seg, initial[name] ?? 0);
  cpu.ip = initial.ip ?? 0;
  cpu.setFlags(initial.flags ?? 0);
  for (const [address, value] of test.initial.ram) bus.write8(address, value);
  // One instruction (prefixes and all).
  cpu.step();

  const problems: string[] = [];
  const expected = { ...initial, ...test.final.regs };
  const actual: Record<string, number> = { ip: cpu.ip, flags: cpu.flags };
  for (const [name, reg] of GENERAL) actual[name] = cpu.regs[reg];
  for (const [name, seg] of SEGMENTS) actual[name] = cpu.sreg[seg];
  for (const name of Object.keys(expected) as MooRegister[]) {
    const m = name === 'flags' ? mask : 0xffff;
    if (((expected[name] ?? 0) & m) !== (actual[name] & m)) problems.push(`${name} ${hex(actual[name])} != ${hex(expected[name] ?? 0)}`);
  }
  const finalRam = new Map(test.initial.ram);
  for (const [address, value] of test.final.ram) finalRam.set(address, value);
  // A divide error ends in the handler at 0000:0400 with the flags (undefined bits and all) on the stack.
  const divideError = expected.cs === 0 && (expected.ip ?? 0) >= 0x400 && (expected.ip ?? 0) <= 0x402;
  const flagAddress = divideError ? ((expected.ss ?? 0) * 16 + (((expected.sp ?? 0) + 4) & 0xffff)) & 0xfffff : -1;
  for (const [address, value] of finalRam) {
    let m = 0xff;
    if (address === flagAddress) m = mask & 0xff;
    if (address === flagAddress + 1) m = mask >> 8;
    if ((bus.ram[address] & m) !== (value & m)) problems.push(`[${hex(address, 5)}] ${hex(bus.ram[address], 2)} != ${hex(value, 2)}`);
  }
  return problems.length ? problems.join(', ') : null;
}

describe.skipIf(files.length === 0)('8088 SingleStepTests', () => {
  const cpu = new I286(new TestBus());
  const bus = (cpu as unknown as { bus: TestBus }).bus;
  for (const file of files) {
    const name = file.replace(/\.MOO\.gz$/, '');
    if (only && !only.includes(name)) continue;
    const [opcode, reg] = name.split('.');
    const status = (reg !== undefined ? metadata[opcode]?.reg?.[reg] : metadata[opcode])?.status;
    // Undefined forms (their behaviour has no use and no known rule) are left out.
    it.skipIf(status === 'undefined')(name, () => {
      const tests = readMoo(readFileSync(join(fixtures, file)));
      const mask = flagMask(name);
      const failures: string[] = [];
      let failed = 0;
      for (const test of tests) {
        const problem = run(cpu, bus, test, mask);
        if (problem === null) continue;
        failed++;
        if (failures.length < 4) failures.push(`#${test.index} ${test.name}: ${problem}`);
      }
      expect(failures, `${failed} of ${tests.length} failed`).toEqual([]);
    });
  }
});
