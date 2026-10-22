import { describe, expect, it } from 'vitest';
import { I286, type CpuBus } from '../src/cpu/i286';
import { Timing, type TimingTable } from '../src/cpu/timing';
import { TIMING_286 } from '../src/cpu/timing-286';
import { TIMING_8088 } from '../src/cpu/timing-8088';

class Bus implements CpuBus {
  readonly ram = new Uint8Array(1 << 20);
  read8(address: number): number {
    return this.ram[address & 0xfffff];
  }
  write8(address: number, value: number): void {
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
}

/** Clocks to run MOV CX,1000 then LOOP $ (a thousand jumps back) at 0000:0100. */
function loopClocks(table: TimingTable, is8086: boolean): number {
  const bus = new Bus();
  bus.ram.set([0xb9, 0xe8, 0x03, 0xe2, 0xfe], 0x100);
  const cpu = new I286(bus);
  cpu.reset();
  cpu.is8086 = is8086;
  cpu.timing = new Timing(table);
  cpu.loadSegment(1, 0);
  cpu.ip = 0x100;
  const start = cpu.cycles;
  for (let i = 0; i < 1001; i++) cpu.step();
  return cpu.cycles - start;
}

describe('measured instruction timing', () => {
  it("has the chips' costs per element and per bit", () => {
    expect(TIMING_8088.counted.A4r[1]).toBeCloseTo(17, 0);
    expect(TIMING_8088.counted['D2.4'][1]).toBeCloseTo(4, 0);
    expect(TIMING_286.counted.A4r[1]).toBeCloseTo(4, 0);
    expect(TIMING_286.counted['D2.4'][1]).toBeCloseTo(1, 0);
  });

  it('runs a loop at the speed each chip did', () => {
    // LOOP takes 17 clocks a jump on the 8088 and 8 (with its refetch) on the 286.
    expect(loopClocks(TIMING_8088, true) / 1000).toBeCloseTo(17, -1);
    expect(loopClocks(TIMING_286, false) / 1000).toBeLessThan(12);
  });
});
