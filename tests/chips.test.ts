import { describe, expect, it } from 'vitest';
import { defaultCmos, ps2CmosCrc } from '../src/chips/cmos-defaults';
import { Dma8237 } from '../src/chips/dma8237';
import { Fdc } from '../src/chips/fdc';
import { Kbc8042 } from '../src/chips/kbc8042';
import { Pic8259 } from '../src/chips/pic8259';
import { Pit8254 } from '../src/chips/pit8254';
import { Ppi8255 } from '../src/chips/ppi8255';
import { Rtc146818 } from '../src/chips/rtc146818';
import { FloppyImage, formattedDisk } from '../src/drive/floppy-image';
import { Ps2Keyboard } from '../src/io/ps2-keyboard';

/** Programs a pair of PICs the way the BIOS does: vectors 08h and 70h, cascade on IRQ 2. */
function biosPics(): [Pic8259, Pic8259] {
  const slave = new Pic8259();
  const master = new Pic8259(slave);
  for (const [pic, base, icw3] of [
    [master, 0x08, 0x04],
    [slave, 0x70, 0x02],
  ] as const) {
    pic.write(0, 0x11);
    pic.write(1, base);
    pic.write(1, icw3);
    pic.write(1, 0x01);
    pic.write(1, 0x00);
  }
  return [master, slave];
}

describe('8259 interrupt controllers', () => {
  it('give the highest priority request, and hold lower ones until EOI', () => {
    const [master] = biosPics();
    master.setLine(3, true);
    master.setLine(1, true);
    expect(master.output).toBe(true);
    expect(master.acknowledge()).toBe(0x09);
    // IRQ 3 waits while IRQ 1 is in service.
    expect(master.output).toBe(false);
    master.write(0, 0x20);
    expect(master.acknowledge()).toBe(0x0b);
  });

  it('cascade the slave through IRQ 2', () => {
    const [master, slave] = biosPics();
    slave.setLine(4, true);
    expect(master.output).toBe(true);
    expect(master.acknowledge()).toBe(0x74);
  });

  it('mask lines and read the IRR and ISR', () => {
    const [master] = biosPics();
    master.write(1, 0x01);
    master.setLine(0, true);
    expect(master.output).toBe(false);
    master.write(0, 0x0a);
    expect(master.read(0)).toBe(0x01);
    master.write(1, 0x00);
    master.acknowledge();
    master.write(0, 0x0b);
    expect(master.read(0)).toBe(0x01);
  });
});

describe('8254 timer', () => {
  it('counts 65536 in mode 2 when given 0 (and keeps to its period)', () => {
    const pit = new Pit8254();
    const edges: number[] = [];
    pit.onOutput = (index, high, tick) => {
      if (index === 0 && !high) edges.push(tick);
    };
    pit.write(0x43, 0x34);
    pit.write(0x40, 0);
    pit.write(0x40, 0);
    for (let i = 0; i < 300; i++) pit.advance(1000);
    expect(edges.length).toBe(4);
    expect(edges[1] - edges[0]).toBe(0x10000);
    pit.write(0x43, 0x00);
    const count = pit.read(0x40) | (pit.read(0x40) << 8);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(0xffff);
  });


  it('runs mode 3 at the programmed rate and mode 2 as a rate generator', () => {
    const pit = new Pit8254();
    const edges: number[] = [];
    pit.onOutput = (index, high, tick) => {
      if (index === 0 && high) edges.push(tick);
    };
    pit.write(0x43, 0x36);
    pit.write(0x40, 100);
    pit.write(0x40, 0);
    pit.advance(1000);
    const periods = edges.slice(1).map((tick, i) => tick - edges[i]);
    expect(periods.length).toBeGreaterThan(5);
    expect(new Set(periods)).toEqual(new Set([100]));

    pit.write(0x43, 0x74);
    pit.write(0x41, 10);
    pit.write(0x41, 0);
    let low = 0;
    pit.onOutput = (index, high) => {
      if (index === 1 && !high) low++;
    };
    pit.advance(101);
    expect(low).toBe(10);
  });

  it('latches counts and status', () => {
    const pit = new Pit8254();
    pit.write(0x43, 0x30);
    pit.write(0x40, 0x00);
    pit.write(0x40, 0x10);
    pit.advance(0x101);
    pit.write(0x43, 0x00);
    pit.advance(50);
    expect(pit.read(0x40) | (pit.read(0x40) << 8)).toBe(0x1000 - 0x100);
    pit.write(0x43, 0xe2);
    expect(pit.read(0x40)).toBe(0x30);
  });
});

describe('8237 DMA', () => {
  it('moves bytes through a channel to its page and stops at terminal count', () => {
    const memory = new Uint8Array(1 << 20);
    const dma = new Dma8237({ readPhysical: (a) => memory[a], writePhysical: (a, v) => (memory[a] = v) });
    dma.write(0x0c, 0);
    dma.write(0x0b, 0x46);
    dma.write(0x04, 0x00);
    dma.write(0x04, 0x20);
    dma.write(0x81, 0x03);
    dma.write(0x05, 0x03);
    dma.write(0x05, 0x00);
    dma.write(0x0a, 0x02);
    const results = [1, 2, 3, 4].map((value) => dma.writeByte(2, value));
    expect(results).toEqual([false, false, false, true]);
    expect([...memory.subarray(0x32000, 0x32004)]).toEqual([1, 2, 3, 4]);
    expect(dma.read(0x08) & 0x04).toBe(0x04);
    expect(dma.ready(2)).toBe(false);
  });
});

describe('CMOS clock', () => {
  it('counts BCD time and raises its periodic interrupt', () => {
    const rtc = new Rtc146818();
    let interrupts = 0;
    rtc.onInterrupt = (high) => high && interrupts++;
    rtc.powerOn(new Date(2026, 9, 22, 23, 59, 58));
    rtc.advance(2.5);
    const read = (index: number) => {
      rtc.write(0x70, index);
      return rtc.read(0x71);
    };
    expect([read(4), read(2), read(0), read(7)]).toEqual([0x00, 0x00, 0x00, 0x23]);
    expect(read(0x37)).toBe(0x20);
    rtc.write(0x70, 0x0b);
    rtc.write(0x71, 0x42);
    rtc.advance(1 / 512);
    expect(interrupts).toBeGreaterThan(0);
    expect(read(0x0c) & 0xc0).toBe(0xc0);
    expect(read(0x0c)).toBe(0);
  });

  it("keeps the CRC IBM's BIOS checks", () => {
    const ram = defaultCmos(2, 1);
    expect(ps2CmosCrc(ram)).toBe(0);
    ram[0x10] ^= 1;
    expect(ps2CmosCrc(ram)).not.toBe(0);
  });
});

describe('keyboard controller', () => {
  const host = () => {
    const irqs: string[] = [];
    let a20 = false;
    let resets = 0;
    const kbc = new Kbc8042({
      setIrq: (line, high) => irqs.push(`${line}${high ? '+' : '-'}`),
      setA20: (on) => (a20 = on),
      resetCpu: () => resets++,
      inputPort: () => 0x9c,
    });
    return { kbc, irqs, a20: () => a20, resets: () => resets };
  };
  const readAll = (kbc: Kbc8042) => {
    const bytes: number[] = [];
    for (let i = 0; i < 20; i++) {
      kbc.advance(0.002);
      if (kbc.read(0x64) & 1) bytes.push(kbc.read(0x60));
    }
    return bytes;
  };

  it('passes its self test, gates A20 and resets the CPU', () => {
    const { kbc, a20, resets } = host();
    kbc.write(0x64, 0xaa);
    expect(kbc.read(0x60)).toBe(0x55);
    kbc.write(0x64, 0xd1);
    kbc.write(0x60, 0xdd);
    expect(a20()).toBe(false);
    kbc.write(0x64, 0xd1);
    kbc.write(0x60, 0xdf);
    expect(a20()).toBe(true);
    kbc.write(0x64, 0xfe);
    expect(resets()).toBe(1);
  });

  it('translates the keyboard to scan code set 1', () => {
    const { kbc, irqs } = host();
    kbc.write(0x64, 0x60);
    kbc.write(0x60, 0x45);
    kbc.keyboard.press('KeyA');
    kbc.keyboard.release('KeyA');
    kbc.keyboard.press('ArrowUp');
    expect(readAll(kbc)).toEqual([0x1e, 0x9e, 0xe0, 0x48]);
    expect(irqs[0]).toBe('1+');
  });

  it('talks to the mouse, which reports movement in packets', () => {
    const { kbc } = host();
    kbc.write(0x64, 0x60);
    kbc.write(0x60, 0x47);
    kbc.write(0x64, 0xd4);
    kbc.write(0x60, 0xff);
    expect(readAll(kbc)).toEqual([0xfa, 0xaa, 0x00]);
    kbc.write(0x64, 0xd4);
    kbc.write(0x60, 0xf4);
    expect(readAll(kbc)).toEqual([0xfa]);
    kbc.mouse.move(5, 3);
    kbc.mouse.left = true;
    expect(readAll(kbc)).toEqual([0x29, 5, 0xfd]);
    expect(kbc.read(0x64) & 0x20).toBe(0x20);
  });
});

describe('PC and XT keyboard interface (8255)', () => {
  function xt() {
    const irq: boolean[] = [];
    const ppi = new Ppi8255(new Ps2Keyboard(), { setIrq: (high) => irq.push(high), portBChanged: () => {}, timer2Output: () => false }, false);
    ppi.configure(false, 1, 640);
    return { ppi, irq };
  }

  it('resets the keyboard when its clock is let go, even with the acknowledge bit set', () => {
    const { ppi, irq } = xt();
    ppi.write(0x61, 0x08);
    ppi.write(0x61, 0xc8);
    ppi.advance(0.01);
    expect(ppi.full).toBe(false);
    ppi.write(0x61, 0x48);
    ppi.advance(0.01);
    expect(ppi.read(0x60)).toBe(0xaa);
    expect(irq.at(-1)).toBe(true);
    // Acknowledged, the register reads 0: no key is stuck down.
    ppi.write(0x61, 0xc8);
    ppi.write(0x61, 0x48);
    ppi.advance(0.01);
    expect(ppi.read(0x60)).toBe(0);
  });

  it('sends set 1 codes, with the arrows as the number pad', () => {
    const { ppi } = xt();
    ppi.write(0x61, 0x48);
    const codes: number[] = [];
    ppi.keyboard.press('KeyA');
    ppi.keyboard.release('KeyA');
    ppi.keyboard.press('ArrowUp');
    for (let i = 0; i < 4; i++) {
      ppi.advance(0.01);
      codes.push(ppi.read(0x60));
      ppi.write(0x61, 0xc8);
      ppi.write(0x61, 0x48);
    }
    // Starting its clock resets the keyboard, which answers AA first.
    expect(codes).toEqual([0xaa, 0x1e, 0x9e, 0x48]);
  });

  it('reads the switches a nibble at a time', () => {
    const { ppi } = xt();
    // One drive, an 80-column colour card and 256K on the planar: 2Dh.
    ppi.write(0x61, 0x08);
    expect(ppi.read(0x62) & 0x0f).toBe(0x02);
    ppi.write(0x61, 0x00);
    expect(ppi.read(0x62) & 0x0f).toBe(0x0d);
  });
});

describe('Model 25 and 30 gate array', () => {
  it('raises the diagnostic NMI from port 63h when port 69h allows it', async () => {
    const { GateArray } = await import('../src/chips/gate-array');
    const { Ps2Mouse } = await import('../src/io/ps2-mouse');
    let nmis = 0;
    const irqs: string[] = [];
    const ga = new GateArray(new Ps2Keyboard(), new Ps2Mouse(), {
      setIrq: (line, high) => irqs.push(`${line}${high ? '+' : '-'}`),
      picIcw: () => 0x08,
      portBChanged: () => {},
      timer2Output: () => false,
      nmi: () => nmis++,
    });
    ga.write(0x63, 0x01);
    expect(nmis).toBe(0);
    ga.write(0x63, 0x00);
    ga.write(0x69, 0x84);
    ga.write(0x63, 0x05);
    expect(nmis).toBe(1);
    expect(irqs).toEqual(['2+']);
    ga.write(0x69, 0x00);
    expect(irqs).toEqual(['2+', '2-']);
  });
});

describe('floppy controller', () => {
  function setup(disk: FloppyImage) {
    const memory = new Uint8Array(1 << 20);
    const dma = new Dma8237({ readPhysical: (a) => memory[a], writePhysical: (a, v) => (memory[a] = v) });
    let irq = false;
    const fdc = new Fdc(dma, (high) => (irq = high));
    fdc.drives[0].insert(disk);
    const run = () => {
      for (let i = 0; i < 200 && !irq; i++) fdc.advance(0.001);
    };
    const command = (...bytes: number[]) => bytes.forEach((byte) => fdc.write(0x3f5, byte));
    const results = () => {
      const out: number[] = [];
      while (fdc.read(0x3f4) & 0x40) out.push(fdc.read(0x3f5));
      return out;
    };
    return { fdc, dma, memory, run, command, results, irq: () => irq };
  }

  it('resets, recalibrates and reads a sector by DMA', () => {
    const disk = new FloppyImage(formattedDisk(), 'test');
    disk.bytes.fill(0x5a, 512 * 18 * 2 * 3 + 512 * 4, 512 * 18 * 2 * 3 + 512 * 5);
    const { fdc, dma, memory, run, command, results, irq } = setup(disk);
    fdc.write(0x3f2, 0x00);
    fdc.write(0x3f2, 0x1c);
    run();
    expect(irq()).toBe(true);
    for (let unit = 0; unit < 4; unit++) {
      command(0x08);
      expect(results()[0]).toBe(0xc0 | unit);
    }
    command(0x0f, 0x00, 3);
    run();
    command(0x08);
    expect(results()).toEqual([0x20, 3]);
    // DMA channel 2: write to memory at 1000h, 512 bytes.
    dma.write(0x0c, 0);
    dma.write(0x0b, 0x46);
    dma.write(0x04, 0x00);
    dma.write(0x04, 0x10);
    dma.write(0x81, 0x00);
    dma.write(0x05, 0xff);
    dma.write(0x05, 0x01);
    dma.write(0x0a, 0x02);
    command(0xe6, 0x00, 3, 0, 5, 2, 18, 0x1b, 0xff);
    run();
    expect(results()).toEqual([0x00, 0x00, 0x00, 3, 0, 6, 2]);
    expect(memory[0x1000]).toBe(0x5a);
    expect(memory[0x11ff]).toBe(0x5a);
  });

  it("can't read a high density disk at the double density rate", () => {
    const { fdc, run, command, results } = setup(new FloppyImage(formattedDisk(), 'test'));
    fdc.write(0x3f2, 0x1c);
    fdc.write(0x3f7, 0x02);
    command(0x4a, 0x00);
    run();
    expect(results().slice(0, 2)).toEqual([0x40, 0x01]);
  });

  it("keeps the DIR's own bits with the motors off", () => {
    const { fdc } = setup(new FloppyImage(formattedDisk(), 'test'));
    fdc.write(0x3f2, 0x08);
    fdc.write(0x3f7, 0x06);
    expect(fdc.read(0x3f7)).toBe(0x0e);
  });

  it('shows the head, the read data line and writes in the PS/2 status registers', () => {
    const disk = new FloppyImage(formattedDisk(), 'test');
    const { fdc, dma, run, command, results } = setup(disk);
    fdc.write(0x3f2, 0x1c);
    command(0x0f, 0x04, 0);
    run();
    command(0x08);
    results();
    // Head 1 selected: SRA's bit 3 (head select, active low) clears.
    expect(fdc.read(0x3f0) & 0x08).toBe(0);
    expect(fdc.read(0x3f1) & 0x1c).toBe(0x08);
    dma.write(0x0b, 0x4a);
    dma.write(0x05, 0xff);
    dma.write(0x05, 0x01);
    dma.write(0x0a, 0x02);
    command(0xc5, 0x04, 0, 1, 1, 2, 18, 0x1b, 0xff);
    run();
    results();
    // A write latches SRB's write enable and write data bits until it is read.
    expect(fdc.read(0x3f1) & 0x14).toBe(0x14);
    expect(fdc.read(0x3f1) & 0x14).toBe(0);
  });

  it('finds sectors by the numbers a track was formatted with', () => {
    const disk = new FloppyImage(formattedDisk(), 'test');
    const { fdc, dma, memory, run, command, results } = setup(disk);
    fdc.write(0x3f2, 0x1c);
    // FORMAT track 0 with sectors numbered 51h-62h, from IDs at 2000h.
    for (let i = 0; i < 18; i++) memory.set([0, 0, 0x51 + i, 2], 0x2000 + i * 4);
    dma.write(0x0b, 0x4a);
    dma.write(0x04, 0x00);
    dma.write(0x04, 0x20);
    dma.write(0x05, 71);
    dma.write(0x05, 0);
    dma.write(0x0a, 0x02);
    command(0x4d, 0x00, 2, 18, 0x54, 0xe5);
    run();
    results();
    expect(disk.offset(0, 0, 1)).toBe(-1);
    // Reading 51h-52h goes past EOT (12h): the track goes on to the next numbers.
    dma.write(0x0b, 0x46);
    dma.write(0x04, 0x00);
    dma.write(0x04, 0x10);
    dma.write(0x05, 0xff);
    dma.write(0x05, 0x03);
    dma.write(0x0a, 0x02);
    command(0xe6, 0x00, 0, 0, 0x51, 2, 18, 0x1b, 0xff);
    run();
    expect(results()).toEqual([0x00, 0x00, 0x00, 0, 0, 0x53, 2]);
    expect(memory[0x1000]).toBe(0xe5);
  });

  it('reports the disk change line through the DIR, active low', () => {
    const { fdc, run, command } = setup(new FloppyImage(formattedDisk(), 'test'));
    fdc.write(0x3f2, 0x1c);
    expect(fdc.read(0x3f7) & 0x80).toBe(0);
    command(0x0f, 0x00, 1);
    run();
    expect(fdc.read(0x3f7) & 0x80).toBe(0x80);
  });
});
