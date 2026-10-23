import { chromium } from '/home/alex/smartresponse/mcp/looping/browsing/playwright-worker/node_modules/playwright-core/index.mjs';
import { mkdir, stat, readdir } from 'node:fs/promises';
import { resolve, basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Usage: node bandcamp-visible-download.mjs <destination> <format> <album-url> [inspect]
// Operates only on the album explicitly identified in the existing visible Edge.
const [destination, format = 'mp3-320', albumUrl, mode = 'download'] = process.argv.slice(2);
if (!albumUrl) throw Error('EXPECTED_ALBUM_URL_REQUIRED');
if (!['download', 'inspect'].includes(mode)) throw Error('INVALID_MODE');
const requested = new URL(albumUrl);
if (requested.protocol !== 'https:' || !/^[a-z0-9-]+\.bandcamp\.com$/i.test(requested.hostname) || !/^\/album\/[a-z0-9-]+\/?$/i.test(requested.pathname) || requested.username || requested.password) throw Error('INVALID_BANDCAMP_ALBUM_URL');
const requestedPath = requested.origin + requested.pathname.replace(/\/$/, '');
const normalize = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/\bfree download\b/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
if (!destination) throw Error('DESTINATION_REQUIRED');
if (!['mp3-320', 'mp3-v0', 'flac'].includes(format)) throw Error('UNSUPPORTED_FORMAT');
// The guarded MCP runner can have a service HOME; bind to the actual Ubuntu music share.
const root = '/home/alex/MusicLibrary';
const output = resolve(destination);
if (!output.startsWith(root + '/') || output === root) throw Error('DESTINATION_OUTSIDE_MUSIC_LIBRARY');
if (mode === 'download') {
  const existing = await readdir(output).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (existing.some(name => /\.(mp3|flac)$/i.test(name))) {
    console.log(JSON.stringify({ok:true,status:'ALBUM_ALREADY_PRESENT',destination:output,files:existing.length,downloaded:false}));
    process.exit(0);
  }
}
const browser = await chromium.connectOverCDP('http://127.0.0.1:9224');
try {
  const pages = browser.contexts().flatMap(c => c.pages());
  const albumPages = pages.filter(p => {
    try { const u = new URL(p.url()); return u.origin + u.pathname.replace(/\/$/, '') === requestedPath; } catch { return false; }
  });
  if (albumPages.length !== 1) throw Error(albumPages.length ? 'AMBIGUOUS_ALBUM_TABS' : 'EXPECTED_ALBUM_TAB_MISSING');
  const albumTitle = await albumPages[0].title();
  const pieces = albumTitle.split('|').map(s => normalize(s));
  const albumName = pieces[0]?.trim();
  const artistName = pieces[1]?.trim();
  if (!albumName || !artistName || albumName.length < 3) throw Error('ALBUM_METADATA_UNVERIFIED');
  const candidates = pages.filter(p => /^https:\/\/bandcamp\.com\/download\?/i.test(p.url()));
  const inspected = [];
  for (const p of candidates) {
    const body = normalize(await p.locator('body').innerText({ timeout: 8000 }).catch(() => ''));
    const titleMatch = body.includes(albumName);
    const artistMatch = body.includes(artistName);
    inspected.push({ page: p, titleMatch, artistMatch });
  }
  const matches = inspected.filter(v => v.titleMatch && v.artistMatch);
  if (mode === 'inspect') {
    console.log(JSON.stringify({ok:true,status:matches.length === 1 ? 'ALBUM_DOWNLOAD_TAB_VERIFIED' : 'ALBUM_DOWNLOAD_TAB_NOT_VERIFIED',albumUrl:requestedPath,albumName,artistName,downloadTabCount:candidates.length,matchingTabs:matches.length,detail:inspected.map(v=>({titleMatch:v.titleMatch,artistMatch:v.artistMatch}))}));
    process.exit(0);
  }
  if (matches.length !== 1) throw Error(matches.length ? 'AMBIGUOUS_MATCHING_DOWNLOAD_TABS' : 'AUTHORIZED_DOWNLOAD_TAB_FOR_ALBUM_MISSING');
  const page = matches[0].page;
  await mkdir(output, { recursive: true });
  const selector = page.locator('#format-type');
  await selector.selectOption(format);
  // Do not trigger a new download when the user already has this album.
  // Existing browser-managed downloads may be canceled when an attached CDP client
  // changes download behavior. Leave browser settings unchanged here.
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120000 }),
    page.getByText('Download', { exact: true }).last().click()
  ]);
  const suggested = basename(download.suggestedFilename());
  if (!suggested.toLowerCase().endsWith('.zip')) throw Error('UNEXPECTED_DOWNLOAD_EXTENSION');
  const zip = join(output, suggested);
  const failure = await download.failure();
  if (failure) throw Error('BROWSER_DOWNLOAD_FAILED: ' + failure);
  try {
    await stat(zip);
    throw Error('DESTINATION_FILE_ALREADY_EXISTS: ' + zip);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await download.saveAs(zip);
  const size = (await stat(zip)).size;
  if (!size) throw Error('EMPTY_DOWNLOAD');
  const check = spawnSync('unzip', ['-t', zip], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 8 });
  if (check.status !== 0) throw Error('ZIP_INTEGRITY_FAILED: ' + check.stderr);
  const listing = spawnSync('unzip', ['-Z', '-1', zip], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 8 });
  if (listing.status !== 0) throw Error('ZIP_LIST_FAILED');
  const entries = listing.stdout.split('\n').filter(Boolean);
  if (!entries.length || entries.length > 1000) throw Error('UNEXPECTED_ZIP_ENTRY_COUNT');
  for (const entry of entries) {
    const name = entry.replace(/\\/g, '/');
    if (name.startsWith('/') || name.includes('\0') || /^[a-zA-Z]:/.test(name) || name.split('/').includes('..') || name.split('/').includes('.')) throw Error('UNSAFE_ZIP_ENTRY_PATH');
  }
  const mediaEntries = entries.filter(name => /\.(mp3|flac)$/i.test(name));
  if (!mediaEntries.length) throw Error('ZIP_CONTAINS_NO_AUDIO');
  // Deliberately no extraction until entry types (including symlinks) and atomic publication are verified.
  console.log(JSON.stringify({ ok: true, status: 'DOWNLOADED_ZIP_VERIFIED', zip, size, format, entries:entries.length, audioFiles:mediaEntries.length, extracted: false }));
} finally {
  await browser.close();
}
