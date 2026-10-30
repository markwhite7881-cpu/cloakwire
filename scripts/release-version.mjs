#!/usr/bin/env node
// tauri.conf.json is canonical. This tool uses only Node built-ins so every
// release host can validate source versions before installing dependencies.
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const androidPath = 'src-tauri/gen/android/app/tauri.properties';
const usage = 'Usage: node scripts/release-version.mjs check [--version EXPECTED] [--project-root PATH]\n       node scripts/release-version.mjs get [--project-root PATH]\n       node scripts/release-version.mjs set VERSION [--project-root PATH]\n       node scripts/release-version.mjs sync-android [--version EXPECTED] [--project-root PATH]';

function parseArgs(args) {
  const positional = [];
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--project-root' || arg === '--version') {
      if (Object.hasOwn(options, arg)) throw new Error(`Duplicate argument ${arg}.`);
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      options[arg] = value;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown argument ${arg}.`);
    } else {
      positional.push(arg);
    }
  }
  const [command, version] = positional;
  if (!['check', 'get', 'set', 'sync-android'].includes(command)) throw new Error(usage);
  if (positional.length !== (command === 'set' ? 2 : 1)) throw new Error(usage);
  if (options['--version'] !== undefined && !['check', 'sync-android'].includes(command)) {
    throw new Error('--version is only valid with check or sync-android.');
  }
  return { command, version, root: resolve(options['--project-root'] ?? defaultRoot), expected: options['--version'] };
}

function versionInfo(version, label = 'Version') {
  if (typeof version !== 'string' || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)) {
    throw new Error(`${label} must be a numeric x.y.z version without leading zeros or prerelease/build suffixes.`);
  }
  const [major, minor, patch] = version.split('.').map(BigInt);
  if (minor > 999n || patch > 999n) {
    throw new Error(`${label} minor and patch components must be at most 999 for a unique Android versionCode.`);
  }
  const code = major * 1_000_000n + minor * 1_000n + patch;
  if (code < 1n || code > 2_147_483_647n) {
    throw new Error(`${label} produces an Android versionCode outside the supported range 1..2147483647.`);
  }
  return { version, androidVersionCode: Number(code) };
}

function readDocument(root, path, optional = false) {
  const fullPath = join(root, path);
  try {
    const stat = lstatSync(fullPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${path} must be a regular file.`);
    return { path, fullPath, text: readFileSync(fullPath, 'utf8'), mode: stat.mode };
  } catch (error) {
    if (optional && error.code === 'ENOENT') return { path, fullPath, text: null, mode: 0o644 };
    if (error.code === 'ENOENT') throw new Error(`Required version file is missing: ${path}.`);
    throw error;
  }
}

function jsonDocument(root, path, fields) {
  const document = readDocument(root, path);
  let value;
  try { value = JSON.parse(document.text.replace(/^\uFEFF/, '')); }
  catch { throw new Error(`Invalid JSON in ${path}.`); }
  const versions = fields.map(field => {
    let owner = value;
    for (const part of field.slice(0, -1)) owner = owner?.[part];
    if (owner === null || typeof owner !== 'object' || Array.isArray(owner) || !Object.hasOwn(owner, field.at(-1))) {
      throw new Error(`Missing version field ${field.join('.')} in ${path}.`);
    }
    const version = owner[field.at(-1)];
    versionInfo(version, `${path} ${field.join('.')}`);
    return { owner, key: field.at(-1), version, label: `${path} ${field.join('.')}` };
  });
  return {
    ...document, versions,
    withVersion(version) {
      if (versions.every(field => field.version === version)) return document.text;
      for (const field of versions) field.owner[field.key] = version;
      const eol = document.text.includes('\r\n') ? '\r\n' : '\n';
      const indent = document.text.match(/\n([ \t]+)"/)?.[1] ?? 2;
      const bom = document.text.startsWith('\uFEFF') ? '\uFEFF' : '';
      const trailing = /\r?\n$/.test(document.text) ? eol : '';
      return bom + JSON.stringify(value, null, indent).replaceAll('\n', eol) + trailing;
    },
  };
}

// Cargo's app version is a simple string in a named table. Locate only that
// table and replace only its value; dependency crate versions remain untouched.
function cargoDocument(root, path, arrayTable) {
  const document = readDocument(root, path);
  const headers = [...document.text.matchAll(/^[ \t]*(\[\[?[^\]\r\n]+\]\]?)[ \t]*(?:#[^\r\n]*)?\r?$/gm)];
  const target = arrayTable ? '[[package]]' : '[package]';
  const blocks = headers.flatMap((header, index) => {
    if (header[1] !== target) return [];
    const start = header.index + header[0].length;
    const end = headers[index + 1]?.index ?? document.text.length;
    const text = document.text.slice(start, end);
    const names = [...text.matchAll(/^[ \t]*name[ \t]*=[ \t]*"([^"\r\n]*)"[ \t]*(?:#[^\r\n]*)?\r?$/gm)];
    const assignments = [...text.matchAll(/^[ \t]*name[ \t]*=/gm)];
    if (names.length !== 1 || assignments.length !== 1) throw new Error(`Invalid package name in ${path}.`);
    return [{ start, text, name: names[0][1] }];
  });
  const appBlocks = blocks.filter(block => block.name === 'cloakwire');
  if (appBlocks.length !== 1 || (!arrayTable && blocks.length !== 1)) {
    throw new Error(`${path} must contain exactly one cloakwire package table.`);
  }
  const block = appBlocks[0];
  const matches = [...block.text.matchAll(/^[ \t]*version[ \t]*=[ \t]*"([^"\r\n]*)"[ \t]*(?:#[^\r\n]*)?\r?$/gm)];
  const assignments = [...block.text.matchAll(/^[ \t]*version[ \t]*=/gm)];
  if (matches.length !== 1 || assignments.length !== 1) throw new Error(`${path} must contain exactly one app package version string.`);
  const match = matches[0];
  const version = match[1];
  versionInfo(version, `${path} cloakwire package version`);
  const start = block.start + match.index + match[0].indexOf('"') + 1;
  return {
    ...document,
    versions: [{ version, label: `${path} cloakwire package version` }],
    withVersion(next) { return document.text.slice(0, start) + next + document.text.slice(start + version.length); },
  };
}

function sourceDocuments(root) {
  return [
    jsonDocument(root, 'src-tauri/tauri.conf.json', [['version']]),
    jsonDocument(root, 'package.json', [['version']]),
    jsonDocument(root, 'package-lock.json', [['version'], ['packages', '', 'version']]),
    cargoDocument(root, 'src-tauri/Cargo.toml', false),
    cargoDocument(root, 'src-tauri/Cargo.lock', true),
  ];
}

function assertSourceVersions(documents, expected) {
  const info = versionInfo(documents[0].versions[0].version, 'Canonical Tauri version');
  if (expected !== undefined) {
    versionInfo(expected, 'Expected version');
    if (expected !== info.version) throw new Error(`Expected version ${expected}, but canonical Tauri version is ${info.version}.`);
  }
  for (const document of documents) {
    for (const field of document.versions) {
      if (field.version !== info.version) throw new Error(`Version mismatch: ${field.label} is ${field.version}; must match canonical Tauri version ${info.version}.`);
    }
  }
  return info;
}

function androidContent(info) {
  return `// THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\ntauri.android.versionName=${info.version}\ntauri.android.versionCode=${info.androidVersionCode}\n`;
}

// All inputs and replacement content are validated before staging any writes.
// Stage beside each destination for atomic per-file replacement, and restore
// already replaced files if a later replacement fails.
function writeDocuments(updates) {
  const changed = updates.filter(document => document.next !== document.text);
  const staged = [];
  const applied = [];
  try {
    for (const document of changed) {
      mkdirSync(dirname(document.fullPath), { recursive: true });
      const temporary = `${document.fullPath}.release-version-${randomUUID()}.tmp`;
      staged.push({ ...document, temporary });
      writeFileSync(temporary, document.next, { encoding: 'utf8', mode: document.mode, flag: 'wx' });
    }
    for (const document of staged) {
      renameSync(document.temporary, document.fullPath);
      applied.push(document);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const document of applied.reverse()) {
      try {
        if (document.text === null) unlinkSync(document.fullPath);
        else writeFileSync(document.fullPath, document.text, { encoding: 'utf8', mode: document.mode });
      } catch { rollbackErrors.push(document.path); }
    }
    if (rollbackErrors.length) throw new Error(`Version update failed; restore these files from source control: ${rollbackErrors.join(', ')}. ${error.message}`);
    throw error;
  } finally {
    for (const document of staged) {
      try { unlinkSync(document.temporary); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

try {
  const { command, version, root, expected } = parseArgs(process.argv.slice(2));
  const requested = command === 'set' ? versionInfo(version) : undefined;
  const documents = sourceDocuments(root);
  const info = requested ?? assertSourceVersions(documents, expected);
  const android = readDocument(root, androidPath, true);
  if (command === 'check' && android.text !== null && android.text.replaceAll('\r\n', '\n') !== androidContent(info)) {
    throw new Error('Android version metadata is incorrect; run release-version.mjs sync-android to regenerate it.');
  }
  if (command === 'set' || command === 'sync-android') {
    const updates = command === 'set' ? documents.map(document => ({ ...document, next: document.withVersion(info.version) })) : [];
    updates.push({ ...android, next: androidContent(info) });
    writeDocuments(updates);
  }
  process.stdout.write(command === 'get' ? `${info.version}\n` : `${JSON.stringify(info)}\n`);
} catch (error) {
  process.stderr.write(`release-version: ${error.message}\n`);
  process.exitCode = 1;
}
