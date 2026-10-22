// Downloads the real mode 80286 SingleStepTests (MIT licensed, about 300 MB, not committed):
// Daniel Balsom's tests captured from a Harris 80C286, 1,000 to 5,000 for each instruction form.
// Pass names to fetch only some, e.g. `npm run fetch:286 -- 00 F6.6 0F01.4`.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT = '37c73caf53dcd22d3dd369ff09305d13d117a4fe';
const api = `https://api.github.com/repos/SingleStepTests/80286/contents/v1_real_mode?ref=${COMMIT}`;
const base = `https://raw.githubusercontent.com/SingleStepTests/80286/${COMMIT}`;
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', '80286');

// CI passes its token, as the API limits unauthenticated listings on shared runners.
const headers = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};

async function download(url) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, url.startsWith('https://api.github.com/') ? { headers } : {});
    if (response.ok) return Buffer.from(await response.arrayBuffer());
    if (attempt === 3) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  }
}

const listing = JSON.parse((await download(api)).toString('utf8'));
const all = listing.map((entry) => entry.name).filter((name) => name.endsWith('.MOO.gz'));
const wanted = process.argv.length > 2 ? process.argv.slice(2).map((name) => `${name}.MOO.gz`) : all;
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'revocation_list.txt'), await download(`${base}/revocation_list.txt`));
let saved = 0;
// A few at a time: there are over 300 files.
const queue = wanted.filter((name) => !existsSync(join(outDir, name)));
await Promise.all(
  Array.from({ length: 8 }, async () => {
    for (let name = queue.shift(); name; name = queue.shift()) {
      await writeFile(join(outDir, name), await download(`${base}/v1_real_mode/${name}`));
      saved++;
    }
  }),
);
console.log(`Saved ${saved} test files in ${outDir} (${wanted.length - saved} were already there)`);
