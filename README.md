# IBM PS/2 in the browser

**Play it at [mohrt.github.io/ibmps2](https://mohrt.github.io/ibmps2/)**

An IBM PS/2 Model 30 286 emulator written from scratch in TypeScript. It has:

- **CPU:** an 80286 at 10 MHz that passes all 326 instruction forms of Daniel Balsom's real mode SingleStepTests, captured from a Harris 80C286, including the flags Intel leaves undefined and the way each instruction leaves its registers when it faults. Protected mode is there too: descriptor tables, privilege levels, call, interrupt and trap gates, task switches and LOADALL.
- **The planar:** the AT's two 8259 interrupt controllers, the 8254 timer, both 8237 DMA controllers with their page registers, the MC146818 CMOS clock, port 92h's fast A20 gate and reset, and the PS/2 setup registers.
- **Keyboard and mouse:** the 8042 keyboard controller with IBM's PS/2 firmware commands, a Model M keyboard (scan code set 2, translated to set 1) and a PS/2 mouse.
- **VGA:** all of IBM's VGA, as built into the planar: the sequencer, graphics controller, attribute controller, CRT controller and DAC, with every text and graphics mode and the tweaks programs build from them (mode X, split screens, smooth scrolling). It is drawn a line at a time as the beam reaches it, and reports retrace from the CRTC's own timing.
- **Floppy drives:** the Model 30's floppy controller, with the PS/2's status registers and disk change line, a 1.44 MB drive A: and an optional B:.
- **Everything else:** the speaker, and a serial and a parallel port for the BIOS to find.

Drop an `.img`, `.ima`, `.vfd` or `.zip` floppy image onto the page to put it in a drive.

## Keys and the mouse

- **Keyboard:** keys type on the PS/2 as labelled. Cmd stays with the browser and Option is Alt. Browsers keep Ctrl-Alt-Del for themselves, so it is a toolbar button.
- **Mouse:** click the screen to capture the mouse; Esc lets it go. It is a PS/2 mouse, which the BIOS supports (INT 15h) and DOS mouse drivers find.
- **Sound:** the speaker, as a square wave from the timer or toggled directly by a program.

## The machine

The toolbar has pause, Ctrl-Alt-Del, power cycle and full screen. **Machine setup...** opens the setup panel over the screen:

- **BIOS:** the ROM (see below).
- **Memory:** 1, 2 or 4 MB (640K and the rest as extended memory).
- **Second floppy drive (B:)**

Nothing changes until **Restart the PS/2 with these settings**, which switches it off and on. The CMOS settings are kept in the browser, as the PS/2's battery would keep them, and set afresh (as IBM's Reference Diskette would) when the memory or drives change. **Fast start-up** runs the PS/2 flat out through its power-on self test, which takes some 20 seconds with 2 MB.

Save states keep the whole machine, floppies included, in the browser, and can be exported and imported as `.ps2state` files. A state only loads with the BIOS it was saved with.

## ROMs

No BIOS or program files are included in this repository.

- **BIOS:** IBM's BIOS is still under copyright, so the site never serves it. On the first visit the page shows a setup panel in place of the screen, asking for the Model 30 286 BIOS (also used by the Model 25 286): `33f5381a.bin` (revision 2) or `27F4092.BIN` (revision 0), 128 KB each.
  - The panel recognises both by checksum. Dumps of the two ROM chips (two 64 KB halves) and overdumps work too, and so does a whole ROM collection, even one with a zip for each machine inside a zip.
  - The 86Box emulator's ROM collection keeps both in its [`ibmps2_m30_286`](https://github.com/86Box/roms/tree/master/machines/ibmps2_m30_286) folder.
  - The ROM is kept in the browser's IndexedDB, with persistent storage requested, so later visits start straight away. **Machine setup...** in the toolbar changes or forgets it.

## Disks

Raw floppy images of the PC formats go in as they are: 1.44 MB, 720 KB, and the 1.68 MB DMF and 1.2 MB and 360 KB ones (which a real 3.5" drive couldn't read, but programs on them run). Gzipped images and `.zip` files work too. Several files dropped or chosen at once, or a zip holding several disks, give each drive a **Swap disk** menu for changing disks.

Your disk images are never changed. What programs write to a disk is kept in the browser (only the sectors that changed) and put back whenever that image is inserted again. **Revert** forgets it, and **Download .img** gives you the disk as it is now. **New blank disk** makes an empty 1.44 MB disk, already formatted for DOS.

## Free disks

`npm run fetch:games` downloads the freely licensed disks listed in `scripts/games-catalog.json` into `public/games/`, where they appear in a "Free disks" picker: a FreeDOS boot disk, and Oscar Toledo's boot sector games (cubicDoom, bootRogue, Bricks, Follow the Lights, Bootle and bootBASIC), which start straight from a floppy. Each entry has its credit, licence, source and checksum. To offer other disks, list them in `public/games/index.json` the same way: `{ "games": [{ "title": "Some Disk", "file": "some-disk.img" }] }`.

## Accuracy

Both of IBM's Model 30 286 BIOSes pass their power-on self test with no errors, FreeDOS boots, and the free disks run.

The CPU's timing is per instruction, from Intel's clock counts, not per bus cycle, and it isn't slowed by the memory's wait states. The chips are brought up to the CPU's time at least every 100 µs, and whenever the CPU reads one whose state depends on time (the timer, the VGA's status, the keyboard controller, the CMOS clock).

Not covered: the Model 30 286's hard disk (an IBM XTA drive), the 80287, and the serial and parallel ports' devices.

## Development

```sh
npm install
npm run fetch:games      # optional: free disks into public/games/
npm run dev              # http://localhost:5173
npm test                 # tests needing downloaded files or your ROMs skip when they're missing
npm run fetch:286        # optional: the 80286 SingleStepTests (about 300 MB)
```

The tests that run the BIOS use your own ROMs, put in `roms/` (never committed) as `33f5381a.bin` and `27F4092.BIN`. `npm test` also boots FreeDOS and the free disks. `SHOTS=/tmp/shots npm test` saves screenshots, and `I286=00,F6.7 npm test` runs only some of the 80286 tests.

## Deploying

`.github/workflows/pages.yml` downloads the free disks and the 80286 tests, tests and builds the site, and deploys it to GitHub Pages on every push to `main` (Pages source: "GitHub Actions").
