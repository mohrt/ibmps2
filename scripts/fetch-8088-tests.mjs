// Downloads the 8088 SingleStepTests (MIT licensed, about 200 MB, not committed): Daniel
// Balsom's tests captured from an AMD D8088, with metadata.json giving each instruction's
// undefined flags. Pass names to fetch only some, e.g. `npm run fetch:8088 -- 00 F6.6`.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT = 'aea84484abc79d09639d855b7b0ab32bc9e4dbeb';
const api = `https://api.github.com/repos/SingleStepTests/8088/contents/v2_binary?ref=${COMMIT}`;
const base = `https://raw.githubusercontent.com/SingleStepTests/8088/${COMMIT}`;
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', '8088');
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
await writeFile(join(outDir, 'metadata.json'), await download(`${base}/v2/metadata.json`));
let saved = 0;
const queue = wanted.filter((name) => !existsSync(join(outDir, name)));
await Promise.all(
  Array.from({ length: 8 }, async () => {
    for (let name = queue.shift(); name; name = queue.shift()) {
      await writeFile(join(outDir, name), await download(`${base}/v2_binary/${name}`));
      saved++;
    }
  }),
);
console.log(`Saved ${saved} test files in ${outDir} (${wanted.length - saved} were already there)`);
