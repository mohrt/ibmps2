/**
 * The fixed disk half of the AT's Fixed Disk and Diskette Drive Adapter (a
 * Western Digital WD1003), at 1F0h-1F7h, with no drive connected: the task
 * file registers hold what is written to them (the BIOS checks this as part
 * of the diskette test), the status says ready for a command, and commands
 * end in an error.
 */
export class Wd1003 {
  readonly taskFile = new Uint8Array(8);
  error = 0;
  status = 0;

  reset(): void {
    this.taskFile.fill(0);
    this.error = 0;
    this.status = 0;
  }

  owns(port: number): boolean {
    return port >= 0x1f0 && port <= 0x1f7;
  }

  read(port: number): number {
    const reg = port & 7;
    if (reg === 0) return 0xff;
    if (reg === 1) return this.error;
    if (reg === 7) return this.status;
    return this.taskFile[reg];
  }

  write(port: number, value: number): void {
    const reg = port & 7;
    if (reg === 7) {
      // No drive answers: the command is aborted.
      this.error = 0x04;
      this.status = 0x01;
      return;
    }
    this.taskFile[reg] = value;
  }
}
