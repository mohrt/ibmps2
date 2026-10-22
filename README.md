# IBM PS/2 in the browser

**Play it at [mohrt.github.io/ibmps2](https://mohrt.github.io/ibmps2/)**

IBM's PCs of the 1980s, emulated from scratch in TypeScript: pick the machine in **Machine setup...**

| Machine | Year | CPU | Video | Floppies |
| --- | --- | --- | --- | --- |
| PS/2 Model 30 286 | 1988 | 80286, 10 MHz | VGA | 1.44 MB |
| PS/2 Model 25 286 | 1990 | 80286, 10 MHz | VGA | 1.44 MB |
| PS/2 Model 30 | 1987 | 8086, 8 MHz | MCGA | 720 KB |
| PS/2 Model 25 | 1987 | 8086, 8 MHz | MCGA | 720 KB |
| PS/1 (Model 2011) | 1990 | 80286, 10 MHz | VGA | 1.44 MB |
| PC/AT (5170) | 1984 | 80286, 8 MHz | CGA | 1.2 MB and 360 KB |
| PC/XT (5160) | 1983 | 8088, 4.77 MHz | CGA | 360 KB |
| PC (5150) | 1981 | 8088, 4.77 MHz | CGA | 360 KB |

The emulator has:

- **CPU:** an 80286 that passes all 326 instruction forms of Daniel Balsom's real mode SingleStepTests, captured from a Harris 80C286, including the flags Intel leaves undefined and the way each instruction leaves its registers when it faults. Protected mode is there too: descriptor tables, privilege levels, call, interrupt and trap gates, task switches and LOADALL. For the 8086 PS/2s, the PC and the XT it becomes an 8086 or 8088, which passes all 323 forms of the 8088 SingleStepTests (captured from an AMD D8088): 20 address lines, the 8086's undocumented opcodes (POP CS, SETMO, the 60h-6Fh jumps) and its own way with flags, PUSH SP and divide errors.
- **The planar:** the 8259 interrupt controllers, the 8254 timer, the 8237 DMA controllers with their page registers (and the PC's memory refresh on channel 0), the MC146818 CMOS clock, port 92h's fast A20 gate and reset, and the PS/2 setup registers.
- **Keyboard and mouse:** the 8042 keyboard controller with IBM's PS/2 or AT firmware commands, a Model M keyboard (scan code set 2, translated to set 1) and a PS/2 mouse; on the 8086 PS/2s, the gate array's two serial interfaces in its place (with the keyboard sending set 1 itself); on the PC and XT, the 8255 with the 83-key keyboard and the DIP switches.
- **VGA:** all of IBM's VGA, as built into the PS/2 planar: the sequencer, graphics controller, attribute controller, CRT controller and DAC, with every text and graphics mode and the tweaks programs build from them (mode X, split screens, smooth scrolling). It is drawn a line at a time as the beam reaches it, and reports retrace from the CRTC's own timing.
- **MCGA:** the 8086 PS/2s' Multi-Color Graphics Array: the CGA's modes on a VGA monitor (text in 8x16 characters from the font RAM the BIOS loads), 640x480 in two colours and 320x200 in 256, with the VGA's DAC and the retrace interrupt.
- **CGA:** IBM's Color Graphics Adapter for the PC, XT and AT: its 6845, 40- and 80-column text, and 320x200 and 640x200 graphics, a line at a time.
- **Floppy drives:** each machine's floppy controller (the PS/2's status registers and disk change line, the AT's data rates and 1.2 MB drive double-stepping 360 KB disks, the PC's 250 kbit/s adapter), with drive A: and an optional B:.
- **Everything else:** the speaker, a serial and a parallel port for the BIOS to find, the Model 30's MM58167 clock (which keeps the BIOS's settings in its alarm registers), and on the AT the hard disk controller's registers (with no drive).

Drop an `.img`, `.ima`, `.vfd` or `.zip` floppy image onto the page to put it in a drive.

## Keys and the mouse

- **Keyboard:** keys type as labelled. Cmd stays with the browser and Option is Alt. Browsers keep Ctrl-Alt-Del for themselves, so it is a toolbar button. The PC and XT keyboard has no separate arrow keys: the arrows are the number pad's (with Num Lock off), as on the real one.
- **Mouse:** on the PS/2s and PS/1, click the screen to capture the mouse; Esc lets it go. It is a PS/2 mouse, which the BIOS supports (INT 15h) and DOS mouse drivers find.
- **Sound:** the speaker, as a square wave from the timer or toggled directly by a program.

## The machine

The toolbar has pause, Ctrl-Alt-Del, power cycle and full screen. **Machine setup...** opens the setup panel over the screen:

- **Model:** one of the machines above, with its ROMs (see below).
- **Memory:** from 256 KB to 640 KB on the PC and XT, 512 or 640 KB on the Model 25; up to 4 MB on the 286s (640K and the rest as extended memory).
- **Second floppy drive (B:)**

Nothing changes until **Restart**, which switches the machine off and on. Each machine's CMOS settings are kept in the browser, as its battery would keep them, and set afresh (as IBM's Reference Diskette or the AT's setup disk would) when the memory or drives change. **Fast start-up** runs the machine flat out through its power-on self test, which takes some 20 seconds on a PS/2 with 2 MB and half a minute on an XT counting its 640K.

Save states keep the whole machine, floppies included, in the browser, and can be exported and imported as `.ps2state` files. A state only loads with the ROM it was saved with.

## ROMs

No BIOS or program files are included in this repository.

- **ROMs:** IBM's BIOSes are still under copyright, so the site never serves them. On the first visit the page shows a setup panel in place of the screen, asking for the chosen machine's ROMs:
  - **PS/2 Model 30 286 and Model 25 286:** `33f5381a.bin` (revision 2) or `27F4092.BIN` (revision 0), 128 KB each, or the two 64 KB halves dumped from the chips.
  - **PS/2 Model 30:** the two 32 KB chips of revision 4, `33F4498.BIN` and `33F4499.BIN`.
  - **PS/2 Model 25:** the two 32 KB chips `00F2122.BIN` and `00F2123.BIN`.
  - **PS/1 2011:** `FC0000_US.BIN` (256 KB), or a language's F80000 and FC0000 halves.
  - **PC/AT:** the two 32 KB BIOS chips, U27 and U47, of November 1985 or January 1984.
  - **PC/XT:** the 32 KB U18 and the 8 KB U19 of November 1982.
  - **PC:** the 8 KB BIOS of October 1982 (U33) and the 32 KB Cassette BASIC 1.10.
  - **The CGA's character ROM** (`mda.rom`, 8 KB), for the PC, XT and AT.
- The panel recognises every chip by checksum and puts each machine's ROM together from them. Overdumps work too, and so does a whole ROM collection, even one with a zip for each machine inside a zip: every machine's chips in it are kept. The 86Box emulator's ROM collection has them in its [`machines`](https://github.com/86Box/roms/tree/master/machines) folder (`ibmps2_m30_286`, `ibmps2_m30`, `ibmps2_m25`, `ibmps1_2011`, `ibmat`, `ibmxt`, `ibmpc82`), with the character ROM in [`video/mda`](https://github.com/86Box/roms/tree/master/video/mda). A BIOS of another make, the size of the machine's, is accepted with a warning.
- The ROMs are kept in the browser's IndexedDB, with persistent storage requested, so later visits start straight away. **Machine setup...** in the toolbar adds or forgets them.

## Disks

Raw floppy images of the PC formats go in as they are: 1.44 MB, 720 KB, 1.2 MB, 360 KB, 320 KB, 180 KB and 160 KB, and the 1.68 MB DMF. A machine reads what its drives could: the PC, XT and 8086 PS/2s only double density disks, and the PS/2s even 5.25" formats (which a real 3.5" drive couldn't read, but programs on them run). Gzipped images and `.zip` files work too. Several files dropped or chosen at once, or a zip holding several disks, give each drive a **Swap disk** menu for changing disks.

Your disk images are never changed. What programs write to a disk is kept in the browser (only the sectors that changed) and put back whenever that image is inserted again. **Revert** forgets it, and **Download .img** gives you the disk as it is now. **New blank disk** makes an empty disk the size the machine's drive takes (1.44 MB, 1.2 MB, 720 KB or 360 KB), already formatted for DOS.

## Free disks

`npm run fetch:games` downloads the freely licensed disks listed in `scripts/games-catalog.json` into `public/games/`, where they appear in a "Free disks" picker: FreeDOS boot disks (1.44 MB for the 286 PS/2s and PS/1, 360 KB for the others), and Oscar Toledo's boot sector games (cubicDoom, which needs VGA or MCGA, bootRogue, Bricks, Follow the Lights, Bootle and bootBASIC), which start straight from a floppy. Each entry has its credit, licence, source and checksum, and the machines it is offered on. To offer other disks, list them in `public/games/index.json` the same way: `{ "games": [{ "title": "Some Disk", "file": "some-disk.img", "models": ["pc-xt"] }] }` (without `models`, every machine).

## Accuracy

Both of IBM's Model 30 286 BIOSes, the Model 30's and Model 25's, the PC/AT's, the PC/XT's and the PC's pass their power-on self tests with no errors, FreeDOS boots on all of them, and the free disks run. The PS/1 starts its built-in DOS shell.

The CPU's timing is per instruction, from Intel's clock counts, not per bus cycle, and it isn't slowed by the memory's wait states. The chips are brought up to the CPU's time at least every 100 µs, and whenever the CPU reads one whose state depends on time (the timer, the VGA's status, the keyboard controller, the CMOS clock).

Not covered: hard disks (the Model 25's and 30's, and the AT's and XT's), the 8087 and 80287, the MDA, and the serial and parallel ports' devices.

## Development

```sh
npm install
npm run fetch:games      # optional: free disks into public/games/
npm run dev              # http://localhost:5173
npm test                 # tests needing downloaded files or your ROMs skip when they're missing
npm run fetch:286        # optional: the 80286 SingleStepTests (about 300 MB)
npm run fetch:8088       # optional: the 8088 SingleStepTests (about 200 MB)
```

The tests that run a BIOS use your own ROMs, put in `roms/` (never committed; any folder layout, as every file in it is checked): `33f5381a.bin` and `27F4092.BIN` for the Model 30 286, and the other machines' chips for theirs. Each machine's tests skip without its ROMs. `npm test` also boots FreeDOS and the free disks. `SHOTS=/tmp/shots npm test` saves screenshots, and `I286=00,F6.7 npm test` runs only some of the 80286 tests.

## Deploying

`.github/workflows/pages.yml` downloads the free disks and the 80286 and 8088 tests, tests and builds the site, and deploys it to GitHub Pages on every push to `main` (Pages source: "GitHub Actions").
