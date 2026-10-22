import { AudioOutput } from './audio/audio-output';
import { defaultCmos } from './chips/cmos-defaults';
import { FloppyImage } from './drive/floppy-image';
import { STATE_EXTENSION, filesFrom, firstDisk, readMedia, titleFromFileName } from './drive/load';
import { Emulator } from './emulator';
import { fetchGame, loadGameManifest, type BundledGame } from './games';
import { BrowserInput } from './io/browser-input';
import type { MemorySize } from './ps2';
import { SCREEN_ASPECT, Screen } from './render/screen';
import { SystemRomStore, type Bios, type StoredRom } from './roms/system-roms';
import { DiskSaves, type DiskSaveRecord, type SaveDiskRecord } from './storage/disk-saves';
import { SaveStates, decodeSession, encodeSession, type SaveStateRecord, type Session } from './storage/save-states';
import { memoryStores, openBrowserStores, type KeyValueStore } from './storage/store';
import { DiskPanel } from './ui/disk-panel';
import { downloadFile } from './ui/download';
import { DEFAULT_CHOICES, askForMachine, type MachineChoices } from './ui/machine-setup';
import { JsonRecord, Settings } from './ui/settings';
import { attachToolbar } from './ui/toolbar';
import { crc32 } from './util/crc32';

/** Form fields whose values are remembered between visits. */
const REMEMBERED_SETTINGS = ['warp', 'sound', 'volume'];

/** How often programs' writes to their disks (and the CMOS) are written to browser storage. */
const SAVE_INTERVAL_MS = 2000;
const DRIVES = 2;

/** The CMOS kept between visits, with the machine it was set up for. */
interface StoredCmos {
  bytes: number[];
  memory: number;
  secondDrive: boolean;
}

function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Page is missing ${selector}`);
  return element;
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'disk';

/** A line about a disk: its format, and whether DOS can boot from it. */
function describeDisk(disk: FloppyImage): string {
  const bytes = disk.bytes;
  const bootable = bytes[510] === 0x55 && bytes[511] === 0xaa;
  const blank = bytes.subarray(0, 512).every((byte) => byte === 0);
  return `${disk.geometry.label}${blank ? ', not formatted' : bootable ? '' : ', not a startup disk'}`;
}

async function main(): Promise<void> {
  const canvas = requireElement<HTMLCanvasElement>('#screen');
  const status = requireElement<HTMLParagraphElement>('#status');
  const screenFrame = requireElement<HTMLElement>('.screen-frame');
  const romSetup = requireElement<HTMLElement>('#rom-setup');
  document.documentElement.style.setProperty('--screen-aspect', SCREEN_ASPECT.toFixed(4));

  try {
    const settings = new Settings();
    settings.bind(document, REMEMBERED_SETTINGS);

    // --- The BIOS ---------------------------------------------------------------------
    let storageWorks = true;
    const stores = await openBrowserStores(() => {
      status.textContent = "Waiting for the browser's storage: if this PS/2 is open in another tab, close or reload that tab.";
    }).catch((error: unknown) => {
      console.warn('Browser storage is unavailable; saves will last until the page is closed.', error);
      storageWorks = false;
      return memoryStores();
    });
    if (!storageWorks) {
      requireElement<HTMLElement>('.rom-storage-note').textContent =
        "This browser isn't letting the page store files, so the ROM will be forgotten when you close it.";
    }
    const romStore = new SystemRomStore(stores.systemRoms as KeyValueStore<StoredRom>);
    const machineRecord = new JsonRecord<MachineChoices>('ibmps2-machine');
    const cmosRecord = new JsonRecord<StoredCmos>('ibmps2-cmos');
    let choices: MachineChoices = { ...DEFAULT_CHOICES, ...machineRecord.read() };

    let bios: Bios | null = await romStore.load();
    if (!bios) {
      status.textContent = 'Load the PS/2 BIOS above to switch it on.';
      const setup = await askForMachine(romSetup, romStore, null, { choices });
      if (!setup) throw new Error('No BIOS ROM.');
      bios = setup.bios;
      choices = setup.choices;
      machineRecord.write(choices);
    }
    let biosCrc = crc32(bios.data);

    // --- The machine ------------------------------------------------------------------
    const screen = new Screen(canvas);
    const emulator = new Emulator(screen);
    const machine = emulator.machine;
    machine.setRom(bios.data);
    const audio = await AudioOutput.create().catch((error: unknown) => {
      console.warn('Audio is unavailable:', error);
      return null;
    });
    if (audio) machine.setSampleRate(audio.sampleRate);

    let paused = false;
    /** While Machine setup is open over the running PS/2. */
    let changingSetup = false;
    const focusScreen = () => canvas.focus();

    const updateStatus = () => {
      const parts = [bios!.title, `${machine.memoryMegabytes} MB`];
      if (machine.fdc.drives[1].connected) parts.push('drive B:');
      status.textContent = parts.join(' · ');
    };

    /** The CMOS for this machine: as the PS/2 last left it, or set up afresh when the machine changed. */
    const cmosFor = (choices: MachineChoices): Uint8Array => {
      const stored = cmosRecord.read();
      if (stored.bytes?.length === 128 && stored.memory === choices.memory && stored.secondDrive === choices.secondDrive) {
        return Uint8Array.from(stored.bytes);
      }
      return defaultCmos(choices.memory, choices.secondDrive ? 2 : 1);
    };
    let savedCmos = '';
    const persistCmos = () => {
      const bytes = [...machine.rtc.ram];
      const text = bytes.join(',');
      if (text === savedCmos) return;
      savedCmos = text;
      cmosRecord.write({ bytes, memory: choices.memory, secondDrive: choices.secondDrive });
    };

    const applyMachine = (choices: MachineChoices) => {
      machine.setMemory(choices.memory);
      machine.fdc.drives[1].connected = choices.secondDrive;
      diskPanel.setDriveConnected(1, choices.secondDrive);
      if (!choices.secondDrive) {
        diskSaves.eject(1);
        machine.insertDisk(1, null);
        diskPanel.showEmpty(1);
      }
    };

    const powerCycle = () => {
      machine.loadCmos(cmosFor(choices));
      machine.powerOn(new Date());
      emulator.resetTiming();
      audio?.flush();
      updateStatus();
    };

    // --- Disks and their saves -------------------------------------------------------
    const diskSaves = new DiskSaves(
      stores.diskSaves as KeyValueStore<DiskSaveRecord>,
      stores.saveDisks as KeyValueStore<SaveDiskRecord>,
    );
    /** The names shown for the disks in the drives (also used to label save states). */
    const diskLabels: (string | null)[] = [null, null];

    const refreshSaveDisks = async () => diskPanel.setSaveDisks(await diskSaves.listSaveDisks());

    /** Stores what programs have written to a drive's disk. */
    const persistDisk = async (drive: number) => {
      const disk = machine.fdc.drives[drive].disk;
      if (!disk || !disk.dirty) return;
      await diskSaves.persist(drive, disk);
      if (diskSaves.origin(drive)?.kind === 'image') diskPanel.setSavedChanges(drive, true);
    };
    const persistAll = async () => {
      persistCmos();
      await Promise.all([0, 1].map((drive) => persistDisk(drive)));
    };
    setInterval(() => {
      persistCmos();
      for (let drive = 0; drive < DRIVES; drive++) {
        // Wait for the motor to stop, so a file being written is finished.
        if (!(machine.fdc.dor & (0x10 << drive))) void persistDisk(drive).catch((error: unknown) => console.warn('Could not keep the disk:', error));
      }
    }, SAVE_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void persistAll();
    });
    window.addEventListener('pagehide', () => void persistAll());

    const insertDisk = async (drive: number, image: FloppyImage, label: string) => {
      await persistDisk(drive);
      const { disk, hasSavedChanges } = await diskSaves.openImage(drive, image);
      machine.insertDisk(drive, disk);
      diskLabels[drive] = label;
      diskPanel.showDisk(drive, label, describeDisk(disk), hasSavedChanges);
    };

    const eject = (drive: number) => {
      void persistDisk(drive).then(() => {
        diskSaves.eject(drive);
        machine.insertDisk(drive, null);
        diskLabels[drive] = null;
        diskPanel.showEmpty(drive);
      });
    };

    // --- Save states -----------------------------------------------------------------
    const saveStates = new SaveStates(stores.saveStates as KeyValueStore<SaveStateRecord>);
    const sessionName = () => diskLabels[0] ?? 'PS/2';
    const currentSession = async (): Promise<Session> => {
      await persistAll();
      return {
        machine: machine.saveState(),
        biosCrc,
        biosTitle: bios!.title,
        memory: machine.memoryMegabytes,
        secondDrive: machine.fdc.drives[1].connected,
        disks: machine.fdc.drives.slice(0, DRIVES).map((drive, i) =>
          drive.disk ? { name: diskLabels[i] ?? drive.disk.name, bytes: drive.disk.bytes.slice(), origin: diskSaves.origin(i) } : null,
        ),
      };
    };
    const restoreSession = async (session: Session) => {
      if (session.biosCrc !== biosCrc) {
        throw new Error(`That state was saved with the ${session.biosTitle}; load that ROM (Machine setup...) to use it.`);
      }
      await persistAll();
      choices = { memory: session.memory as MemorySize, secondDrive: session.secondDrive };
      machineRecord.write(choices);
      applyMachine(choices);
      session.disks.forEach((saved, drive) => {
        const disk = saved ? new FloppyImage(saved.bytes.slice(), saved.name) : null;
        // In without the disk change line: the restored drive state says whether it was changed.
        machine.fdc.drives[drive].disk = disk;
        diskSaves.adopt(drive, saved?.origin ?? null);
        diskLabels[drive] = saved?.name ?? null;
        if (disk && saved) diskPanel.showDisk(drive, saved.name, describeDisk(disk), false);
        else diskPanel.showEmpty(drive);
      });
      machine.loadState(session.machine);
      emulator.resetTiming();
      audio?.flush();
      updateStatus();
    };

    // --- Panels ----------------------------------------------------------------------
    let bundledGames: BundledGame[] = [];
    /** Puts one disk image in a drive, or loads a save state. */
    const openDisk = async (file: File, drive: number) => {
      const media = await readMedia(file);
      if (media.kind === 'state') {
        await restoreSession(await decodeSession(media.bytes));
        toolbar.showMessage('Save state loaded');
        return;
      }
      const game = bundledGames.find((entry) => entry.file.split('/').pop() === file.name);
      await insertDisk(drive, media.disk, game?.title ?? titleFromFileName(file.name));
      diskPanel.markSetDisk(drive, file.name);
    };

    /** Files dropped or chosen together: every disk in them goes in the Swap menus, and the first goes in. */
    const openFiles = async (chosen: File[], drive: number) => {
      const files = (await Promise.all(chosen.map((file) => filesFrom(file)))).flat();
      if (chosen.length > 1) files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      diskPanel.setZipFiles(files.length > 1 ? files : []);
      await openDisk(firstDisk(files), drive);
    };

    const diskPanel = new DiskPanel(requireElement('#disk-panel'), {
      onFiles: openFiles,
      onSwapDisk: openDisk,
      onEject: eject,
      onRevert: async (drive) => {
        const disk = await diskSaves.revert(drive);
        if (!disk) return;
        machine.insertDisk(drive, disk);
        diskPanel.setSavedChanges(drive, false);
      },
      onDownload: async (drive) => {
        const disk = machine.fdc.drives[drive].disk;
        if (disk) downloadFile(disk.bytes, `${slug(diskLabels[drive] ?? disk.name)}.img`);
      },
      onGame: (index) => fetchGame(import.meta.env.BASE_URL, bundledGames[index]),
      onPlayGame: async (file) => {
        await openFiles([file], 0);
        powerCycle();
      },
      onNewSaveDisk: async (drive) => {
        await persistDisk(drive);
        const { disk, name } = await diskSaves.createSaveDisk(drive);
        machine.insertDisk(drive, disk);
        diskLabels[drive] = name;
        diskPanel.showDisk(drive, name, describeDisk(disk), false);
        await refreshSaveDisks();
      },
      onInsertSaveDisk: async (id, drive) => {
        await persistDisk(drive);
        const opened = await diskSaves.openSaveDisk(drive, id);
        if (!opened) throw new Error('That disk no longer exists.');
        machine.insertDisk(drive, opened.disk);
        diskLabels[drive] = opened.name;
        diskPanel.showDisk(drive, opened.name, describeDisk(opened.disk), false);
      },
      onExportSaveDisk: async (id) => {
        await persistAll();
        const bytes = await diskSaves.saveDiskBytes(id);
        const name = (await diskSaves.listSaveDisks()).find((disk) => disk.id === id)?.name ?? 'disk';
        if (bytes) downloadFile(bytes, `${slug(name)}.img`);
      },
      onDeleteSaveDisk: async (id) => {
        for (let drive = 0; drive < DRIVES; drive++) {
          const origin = diskSaves.origin(drive);
          if (origin?.kind === 'saveDisk' && origin.id === id) {
            machine.insertDisk(drive, null);
            diskLabels[drive] = null;
            diskPanel.showEmpty(drive);
          }
        }
        await diskSaves.deleteSaveDisk(id);
        await refreshSaveDisks();
      },
      onWarp: (enabled) => (emulator.fastStartup = enabled),
      focusScreen,
    });

    const input = new BrowserInput(machine, canvas);
    input.attach(window);
    const mouseLabel = requireElement<HTMLElement>('.mouse-label');
    input.onMouseCapture = (captured) => (mouseLabel.hidden = captured);

    const refreshStates = async () => toolbar.setStates(await saveStates.list());
    const toolbar = attachToolbar(requireElement('#toolbar'), {
      onPause: (pause) => {
        paused = pause;
        screenFrame.classList.toggle('paused', pause);
        emulator.resetTiming();
        audio?.flush();
      },
      onReset: () => input.ctrlAltDel(),
      onPowerCycle: powerCycle,
      onFullscreen: () => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void screenFrame.requestFullscreen().then(focusScreen);
      },
      onSaveState: async () => {
        await saveStates.add(sessionName(), await currentSession());
        await refreshStates();
        toolbar.showMessage('State saved');
      },
      onLoadState: async (id) => {
        const session = await saveStates.load(id);
        if (!session) throw new Error('That save state no longer exists.');
        await restoreSession(session);
        toolbar.showMessage('State loaded');
      },
      onDeleteState: async (id) => {
        await saveStates.delete(id);
        await refreshStates();
      },
      onExportState: async () => {
        downloadFile(await encodeSession(await currentSession()), `${slug(sessionName())}${STATE_EXTENSION}`);
      },
      onImportState: async (file) => {
        await restoreSession(await decodeSession(new Uint8Array(await file.arrayBuffer())));
        toolbar.showMessage('Save state loaded');
      },
      focusScreen,
    });
    await refreshStates();
    await refreshSaveDisks();

    void loadGameManifest(import.meta.env.BASE_URL).then((games) => {
      bundledGames = games;
      const href = (link?: string) => (link?.startsWith('games/') ? `${import.meta.env.BASE_URL}${link}` : link);
      diskPanel.setGames(games.map((game) => ({ ...game, licenseHref: href(game.licenseUrl), sourceHref: href(game.sourceUrl) })));
    });

    /** Shows Machine setup over the paused PS/2; what it sets takes effect with a power cycle. */
    const openMachineSetup = async () => {
      if (changingSetup) return;
      changingSetup = true;
      audio?.flush();
      const setup = await askForMachine(romSetup, romStore, await romStore.load(), { whileRunning: true, choices });
      changingSetup = false;
      if (setup) {
        await persistAll();
        bios = setup.bios;
        biosCrc = crc32(setup.bios.data);
        machine.setRom(setup.bios.data);
        choices = setup.choices;
        machineRecord.write(choices);
        applyMachine(choices);
        powerCycle();
      }
      focusScreen();
    };
    requireElement<HTMLButtonElement>('[data-action="machine-setup"]').addEventListener('click', () => void openMachineSetup());

    // --- Sound ------------------------------------------------------------------------
    const sound = requireElement<HTMLInputElement>('input[name="sound"]');
    const volume = requireElement<HTMLInputElement>('input[name="volume"]');
    const soundHint = requireElement<HTMLElement>('.sound-hint');
    const applySound = () => {
      audio?.setEnabled(sound.checked);
      audio?.setVolume(Number(volume.value));
    };
    sound.addEventListener('change', applySound);
    volume.addEventListener('input', applySound);
    applySound();
    if (!audio) {
      sound.disabled = volume.disabled = true;
      soundHint.textContent = 'Sound is not supported in this browser';
      soundHint.hidden = false;
    } else if (!audio.running) {
      soundHint.hidden = false;
      audio.resumeOnGesture(window, () => (soundHint.hidden = true));
    }

    // --- Main loop -------------------------------------------------------------------
    const leds = [false, false];
    let last = performance.now();
    let wasWarped = false;
    const frame = (now: number) => {
      const elapsed = now - last;
      last = now;
      if (!paused && !changingSetup) {
        emulator.run(elapsed);
        // Warped sound would play many times too fast, so it is dropped.
        const samples = emulator.takeAudioSamples();
        if (emulator.warped !== wasWarped) audio?.flush();
        wasWarped = emulator.warped;
        if (!emulator.warped) audio?.play(samples);
      }
      for (let drive = 0; drive < DRIVES; drive++) {
        const on = (machine.fdc.dor & (0x10 << drive)) !== 0;
        if (on !== leds[drive]) {
          leds[drive] = on;
          diskPanel.setLed(drive, on);
        }
      }
      screen.present();
      requestAnimationFrame(frame);
    };

    applyMachine(choices);
    diskPanel.showEmpty(0);
    diskPanel.showEmpty(1);
    powerCycle();
    focusScreen();
    requestAnimationFrame(frame);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

void main();
