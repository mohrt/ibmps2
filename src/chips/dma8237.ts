/** Physical memory as DMA sees it (no A20 gate: DMA drives the address lines itself). */
export interface DmaMemory {
  readPhysical(address: number): number;
  writePhysical(address: number, value: number): void;
}

class Channel {
  baseAddress = 0;
  baseCount = 0;
  address = 0;
  count = 0;
  /** Bits 2-3 transfer type (1 write to memory, 2 read from memory), 4 auto-init, 5 decrement, 6-7 mode. */
  mode = 0;
  page = 0;
  masked = true;
  request = false;
}

/** The page register port for each channel (0-7). */
const PAGE_PORTS = [0x87, 0x83, 0x81, 0x82, 0x8f, 0x8b, 0x89, 0x8a];

/**
 * The AT's two Intel 8237A DMA controllers: channels 0-3 move bytes (ports
 * 00h-0Fh), channels 4-7 move words (ports C0h-DFh, channel 4 cascading the
 * first controller), with page registers at 80h-8Fh holding the address bits
 * above 16. Devices pull or push a byte at a time with read() and write().
 */
export class Dma8237 {
  readonly channels = Array.from({ length: 8 }, () => new Channel());
  /** Each controller's byte pointer flip-flop. */
  readonly flipFlop = [false, false];
  /** Each controller's status: terminal count (bits 0-3) and request (4-7) bits. */
  readonly status = [0, 0];
  readonly command = [0, 0];
  /** The page registers' other ports, which are scratch storage (80h holds POST codes). */
  readonly scratch = new Uint8Array(16);
  /** The last byte written to port 80h, where BIOSes post their progress. */
  postCode = 0;

  constructor(private readonly memory: DmaMemory) {
    this.channels[4].masked = false;
  }

  reset(): void {
    for (let i = 0; i < 8; i++) {
      const channel = this.channels[i];
      channel.masked = i !== 4;
      channel.request = false;
    }
    this.flipFlop[0] = this.flipFlop[1] = false;
    this.status[0] = this.status[1] = 0;
  }

  private controller(port: number): number {
    return port >= 0xc0 ? 1 : 0;
  }

  write(port: number, value: number): void {
    if (port >= 0x80 && port <= 0x8f) {
      const channel = PAGE_PORTS.indexOf(port);
      if (channel >= 0) this.channels[channel].page = value;
      this.scratch[port & 0xf] = value;
      if (port === 0x80) this.postCode = value;
      return;
    }
    const c = this.controller(port);
    const reg = c === 0 ? port & 0xf : ((port - 0xc0) >> 1) & 0xf;
    const first = c * 4;
    if (reg < 8) {
      const channel = this.channels[first + (reg >> 1)];
      const high = this.flipFlop[c];
      this.flipFlop[c] = !high;
      if (reg & 1) {
        channel.baseCount = high ? (channel.baseCount & 0xff) | (value << 8) : (channel.baseCount & 0xff00) | value;
        channel.count = channel.baseCount;
      } else {
        channel.baseAddress = high ? (channel.baseAddress & 0xff) | (value << 8) : (channel.baseAddress & 0xff00) | value;
        channel.address = channel.baseAddress;
      }
      return;
    }
    switch (reg) {
      case 8:
        this.command[c] = value;
        break;
      case 9:
        this.channels[first + (value & 3)].request = (value & 4) !== 0;
        break;
      case 10:
        this.channels[first + (value & 3)].masked = (value & 4) !== 0;
        break;
      case 11:
        this.channels[first + (value & 3)].mode = value;
        break;
      case 12:
        this.flipFlop[c] = false;
        break;
      case 13:
        // Master clear.
        this.flipFlop[c] = false;
        this.status[c] = 0;
        this.command[c] = 0;
        for (let i = 0; i < 4; i++) this.channels[first + i].masked = true;
        break;
      case 14:
        for (let i = 0; i < 4; i++) this.channels[first + i].masked = false;
        break;
      case 15:
        for (let i = 0; i < 4; i++) this.channels[first + i].masked = (value & (1 << i)) !== 0;
        break;
    }
  }

  read(port: number): number {
    if (port >= 0x80 && port <= 0x8f) {
      const channel = PAGE_PORTS.indexOf(port);
      return channel >= 0 ? this.channels[channel].page : this.scratch[port & 0xf];
    }
    const c = this.controller(port);
    const reg = c === 0 ? port & 0xf : ((port - 0xc0) >> 1) & 0xf;
    const first = c * 4;
    if (reg < 8) {
      const channel = this.channels[first + (reg >> 1)];
      const high = this.flipFlop[c];
      this.flipFlop[c] = !high;
      const value = reg & 1 ? channel.count : channel.address;
      return high ? value >> 8 : value & 0xff;
    }
    switch (reg) {
      case 8: {
        let requests = 0;
        for (let i = 0; i < 4; i++) if (this.channels[first + i].request) requests |= 0x10 << i;
        const value = this.status[c] | requests;
        // Reading the status clears the terminal count bits.
        this.status[c] &= 0xf0;
        return value;
      }
      case 15: {
        let mask = 0xf0;
        for (let i = 0; i < 4; i++) if (this.channels[first + i].masked) mask |= 1 << i;
        return mask;
      }
      default:
        return 0xff;
    }
  }

  /** Whether a channel is unmasked and ready to move data. */
  ready(channel: number): boolean {
    return !this.channels[channel].masked;
  }

  private physical(index: number): number {
    const channel = this.channels[index];
    if (index < 4) return ((channel.page << 16) | channel.address) & 0xffffff;
    return (((channel.page & 0xfe) << 16) | (channel.address << 1)) & 0xffffff;
  }

  /** Moves the channel on by one transfer; returns true at terminal count. */
  private step(index: number): boolean {
    const channel = this.channels[index];
    channel.address = (channel.address + (channel.mode & 0x20 ? -1 : 1)) & 0xffff;
    channel.count = (channel.count - 1) & 0xffff;
    if (channel.count !== 0xffff) return false;
    this.status[index >> 2] |= 1 << (index & 3);
    if (channel.mode & 0x10) {
      channel.address = channel.baseAddress;
      channel.count = channel.baseCount;
    } else {
      channel.masked = true;
    }
    return true;
  }

  /** A device writes a byte to memory on an 8-bit channel; returns true at terminal count. */
  writeByte(index: number, value: number): boolean {
    const channel = this.channels[index];
    // Verify transfers (type 0) move nothing; only "write" transfers (type 1) store.
    if (((channel.mode >> 2) & 3) === 1) this.memory.writePhysical(this.physical(index), value);
    return this.step(index);
  }

  /** A device reads a byte from memory on an 8-bit channel; the second value is true at terminal count. */
  readByte(index: number): [number, boolean] {
    const value = this.memory.readPhysical(this.physical(index));
    return [value, this.step(index)];
  }
}
