import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
const records = process.argv.slice(2).map((file) => ({name: basename(file), size: statSync(file).size, sha256: createHash('sha256').update(readFileSync(file)).digest('hex')}));
process.stdout.write(JSON.stringify(records, null, 2) + '\n');
