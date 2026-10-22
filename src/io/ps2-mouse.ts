/**
 * An IBM PS/2 mouse on the auxiliary port: two buttons (and a middle one),
 * stream and remote modes, sample rate, resolution and scaling commands, and
 * 3-byte movement packets. Bytes for the controller wait in `output`.
 */
export class Ps2Mouse {
  readonly output: number[] = [];
  enabled = false;
  remote = false;
  wrap = false;
  rate = 100;
  resolution = 2;
  scaling2to1 = false;
  left = false;
  right = false;
  middle = false;
  private dx = 0;
  private dy = 0;
  private buttonsSent = 0;
  private command = -1;
  private last = 0;
  /** Emulated seconds until the next packet may be sent. */
  private wait = 0;

  reset(): void {
    this.output.length = 0;
    this.defaults();
    this.wrap = false;
    this.command = -1;
    this.dx = this.dy = 0;
  }

  private defaults(): void {
    this.enabled = false;
    this.remote = false;
    this.rate = 100;
    this.resolution = 2;
    this.scaling2to1 = false;
  }

  private send(...bytes: number[]): void {
    for (const byte of bytes) {
      this.output.push(byte);
      this.last = byte;
    }
  }

  receive(byte: number): void {
    if (this.wrap && byte !== 0xec && byte !== 0xff) {
      this.send(byte);
      return;
    }
    if (this.command >= 0) {
      const command = this.command;
      this.command = -1;
      if (command === 0xf3) this.rate = byte || 100;
      else if (command === 0xe8) this.resolution = byte & 3;
      this.send(0xfa);
      return;
    }
    switch (byte) {
      case 0xe6:
        this.scaling2to1 = false;
        this.send(0xfa);
        break;
      case 0xe7:
        this.scaling2to1 = true;
        this.send(0xfa);
        break;
      case 0xe8:
      case 0xf3:
        this.command = byte;
        this.send(0xfa);
        break;
      case 0xe9:
        this.send(
          0xfa,
          (this.remote ? 0x40 : 0) | (this.enabled ? 0x20 : 0) | (this.scaling2to1 ? 0x10 : 0) | this.buttons,
          this.resolution,
          this.rate,
        );
        break;
      case 0xea:
        this.remote = false;
        this.send(0xfa);
        break;
      case 0xeb:
        this.send(0xfa);
        this.sendPacket();
        break;
      case 0xec:
        this.wrap = false;
        this.send(0xfa);
        break;
      case 0xee:
        this.wrap = true;
        this.send(0xfa);
        break;
      case 0xf0:
        this.remote = true;
        this.send(0xfa);
        break;
      case 0xf2:
        this.send(0xfa, 0x00);
        break;
      case 0xf4:
        this.enabled = true;
        this.send(0xfa);
        break;
      case 0xf5:
        this.enabled = false;
        this.send(0xfa);
        break;
      case 0xf6:
        this.defaults();
        this.send(0xfa);
        break;
      case 0xfe:
        this.output.push(this.last);
        break;
      case 0xff:
        this.reset();
        this.send(0xfa, 0xaa, 0x00);
        break;
      default:
        this.send(0xfe);
    }
  }

  private get buttons(): number {
    return (this.left ? 1 : 0) | (this.right ? 2 : 0) | (this.middle ? 4 : 0);
  }

  move(dx: number, dy: number): void {
    this.dx += dx;
    this.dy += dy;
  }

  private sendPacket(): void {
    const clamp = (value: number) => Math.max(-255, Math.min(255, value));
    const x = clamp(Math.round(this.dx));
    // The mouse counts up as it moves away from you; the screen counts down.
    const y = clamp(Math.round(-this.dy));
    this.dx -= x;
    this.dy += y;
    const buttons = this.buttons;
    this.buttonsSent = buttons;
    this.send(0x08 | buttons | (x < 0 ? 0x10 : 0) | (y < 0 ? 0x20 : 0), x & 0xff, y & 0xff);
  }

  /** Sends a packet at the sample rate when the mouse has moved or a button changed. */
  advance(seconds: number): void {
    this.wait -= seconds;
    if (this.wait > 0 || !this.enabled || this.remote || this.output.length > 0) return;
    const moved = Math.round(this.dx) !== 0 || Math.round(this.dy) !== 0;
    if (!moved && this.buttons === this.buttonsSent) return;
    this.sendPacket();
    this.wait = 1 / this.rate;
  }
}
