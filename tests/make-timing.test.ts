import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { I286, Seg, type CpuBus } from '../src/cpu/i286';
import { formKey, type TimingTable } from '../src/cpu/timing';
import { readMoo, type MooTest } from './helpers/moo';

// Writes src/cpu/timing-8088.ts or timing-286.ts from the SingleStepTests' cycle counts:
// MAKE_TIMING=8088 npx vitest run tests/make-timing.test.ts (or MAKE_TIMING=80286).
const chip = process.env.MAKE_TIMING;
const fixtures = join(import.meta.dirname, 'fixtures', chip ?? '');

class Bus implements CpuBus {
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
}

const REGS: [string, number][] = [
  ['ax', 0],
  ['cx', 1],
  ['dx', 2],
  ['bx', 3],
  ['sp', 4],
  ['bp', 5],
  ['si', 6],
  ['di', 7],
];
const SEGS: [string, number][] = [
  ['es', Seg.ES],
  ['cs', Seg.CS],
  ['ss', Seg.SS],
  ['ds', Seg.DS],
];

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1];

/** Least squares: clocks = base + per * count. */
function fit(points: [number, number][]): [number, number] {
  const n = points.length;
  const mx = points.reduce((s, [x]) => s + x, 0) / n;
  const my = points.reduce((s, [, y]) => s + y, 0) / n;
  const sxx = points.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  const per = sxx ? points.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / sxx : 0;
  return [Math.round((my - per * mx) * 10) / 10, Math.round(per * 100) / 100];
}

const STRING_OPS = new Set([0x6c, 0x6d, 0x6e, 0x6f, 0xa4, 0xa5, 0xa6, 0xa7, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf]);

describe.skipIf(!chip || !existsSync(fixtures))(`timing table from the ${chip} tests`, () => {
  it('measures every form', { timeout: 1_800_000 }, () => {
    const is8086 = chip === '8088';
    const bus = new Bus();
    const cpu = new I286(bus);
    const names = readdirSync(fixtures)
      .filter((name) => name.endsWith('.MOO.gz'))
      .map((name) => name.replace('.MOO.gz', ''));
    const table: TimingTable = { groups: [...new Set(names.filter((n) => n.includes('.')).map((n) => parseInt(n, 16)))], forms: {}, counted: {} };
    const samples = new Map<string, number[][]>();
    const counted = new Map<string, [number, number][]>();
    for (const name of names) {
      for (const test of readMoo(readFileSync(join(fixtures, `${name}.MOO.gz`)))) {
        if (!test.cycles || ended(test, is8086)) continue;
        for (const address of bus.touched) bus.ram[address] = 0;
        bus.touched.length = 0;
        cpu.reset();
        cpu.is8086 = is8086;
        const initial = test.initial.regs as Record<string, number>;
        for (const [reg, i] of REGS) cpu.regs[i] = initial[reg] ?? 0;
        for (const [reg, seg] of SEGS) cpu.loadSegment(seg, initial[reg] ?? 0);
        cpu.ip = initial.ip ?? 0;
        cpu.setFlags(initial.flags ?? 0);
        for (const [address, value] of test.initial.ram) bus.write8(address, value);
        try {
          cpu.step();
        } catch {
          continue;
        }
        const shape = cpu.lastShape;
        const key = formKey(table, shape.op, shape.reg);
        const shift = (shape.op & 0xfe) === 0xd2 || (!is8086 && (shape.op & 0xfe) === 0xc0);
        if ((shape.repeated && STRING_OPS.has(shape.op)) || shift) {
          const at = shape.repeated && !shift ? `${key}r` : key;
          if (!counted.has(at)) counted.set(at, []);
          counted.get(at)!.push([shape.count, test.cycles]);
          continue;
        }
        if (!samples.has(key)) samples.set(key, [[], [], [], []]);
        samples.get(key)![(shape.memory ? 1 : 0) + (shape.branched ? 2 : 0)].push(test.cycles);
      }
    }
    // The 286 tests run on to a HLT, which every count includes: NOP's excess over its 3 clocks.
    const overhead = is8086 ? 0 : median(samples.get('90')![0]) - 3;
    for (const [key, kinds] of [...samples].sort()) table.forms[key] = kinds.map((values) => (values.length >= 8 ? median(values) - overhead : -1));
    for (const [key, points] of [...counted].sort()) {
      if (points.length < 8) continue;
      const [base, per] = fit(points);
      table.counted[key] = [Math.round((base - overhead) * 10) / 10, per];
    }
    const file = is8086 ? 'timing-8088.ts' : 'timing-286.ts';
    const constant = is8086 ? 'TIMING_8088' : 'TIMING_286';
    const source = is8086 ? "the 8088 SingleStepTests (an AMD D8088's)" : "the 80286 SingleStepTests (a Harris 80C286's)";
    writeFileSync(
      join(import.meta.dirname, '..', 'src', 'cpu', file),
      `import type { TimingTable } from './timing';\n\n/** Clocks by instruction form, from ${source} cycle counts. Made by tests/make-timing.test.ts. */\nexport const ${constant}: TimingTable = ${JSON.stringify(table)};\n`,
    );
    process.stderr.write(`NOP ${JSON.stringify(table.forms['90'])} INC ${JSON.stringify(table.forms['40'])} forms ${Object.keys(table.forms).length} counted ${JSON.stringify(table.counted)}\n`);
  });
});

/** A test that ends in an exception handler rather than after the instruction. */
function ended(test: MooTest, is8086: boolean): boolean {
  if (test.exception) return true;
  const final = { ...test.initial.regs, ...test.final.regs };
  return is8086 && final.cs === 0 && (final.ip ?? 0) >= 0x400 && (final.ip ?? 0) <= 0x402;
}
