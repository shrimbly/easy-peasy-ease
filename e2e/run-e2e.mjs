/**
 * End-to-end validation of easy-peasy-ease against a real Chromium with real
 * WebCodecs. Drives the actual UI: upload -> capability checks -> finalize ->
 * audio mix -> update -> download, then validates the produced MP4 with
 * ffprobe. Exits non-zero on any failure.
 *
 * Usage: node run-e2e.mjs <baseURL>
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const outDir = join(here, 'out');
mkdirSync(outDir, { recursive: true });

const baseURL = process.argv[2] ?? 'http://localhost:3000';
let failures = 0;

const check = (cond, label) => {
  if (cond) {
    console.log(`  PASS: ${label}`);
  } else {
    failures++;
    console.log(`  FAIL: ${label}`);
  }
};

const ffprobe = (file) => {
  const raw = execFileSync('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format', '-show_streams', '-count_frames',
    file,
  ]).toString();
  return JSON.parse(raw);
};

async function freshPage(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (err) => console.log(`  [pageerror] ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`  [console.error] ${msg.text().slice(0, 200)}`);
  });
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  return { context, page };
}

async function uploadClips(page, files) {
  await page.setInputFiles('#videos-input', files);
  // Wait for all capability checks to settle (list items say 'Ready to finalize')
  await page.waitForSelector(`text=Uploaded Videos (${files.length})`, { timeout: 20_000 });
  await page.waitForFunction(
    () => !document.body.innerText.includes('Checking device encoder support'),
    { timeout: 60_000 }
  );
}

async function setPreviewQuality(page, enabled) {
  const checkbox = page.locator('label:has-text("Render previews in lower quality") input[type="checkbox"]');
  const isChecked = await checkbox.isChecked();
  if (isChecked !== enabled) await checkbox.click();
}

async function finalize(page) {
  await page.locator('button', { hasText: /Finalize/ }).first().click();
  // Preflight dialog may appear (e.g. resolution disparity warning) — proceed.
  const proceed = page.locator('button:has-text("Proceed Anyway")');
  try {
    await proceed.waitFor({ state: 'visible', timeout: 3_000 });
    await proceed.click();
  } catch {
    // No preflight dialog — fine.
  }
  // Success = the editor appears (its Download button is unique to it).
  // Failure = the persistent error dialog. NOTE: upload thumbnails also have
  // blob: video srcs, so a video[src^=blob:] check would false-positive.
  const result = await Promise.race([
    page
      .waitForSelector('button:has-text("Download")', { timeout: 300_000 })
      .then(() => 'ok'),
    page
      .waitForSelector('text=Render failed', { timeout: 300_000 })
      .then(() => 'error'),
  ]);
  return result;
}

async function downloadFinal(page, saveAs) {
  const downloadPromise = page.waitForEvent('download', { timeout: 300_000 });
  await page.locator('button', { hasText: /^Download/ }).first().click();
  const download = await downloadPromise;
  await download.saveAs(saveAs);
  return saveAs;
}

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist'],
});

// ============================================================
console.log('Scenario A: 3 uniform 1080p clips, full quality, audio, download');
{
  const { context, page } = await freshPage(browser);
  await uploadClips(page, [
    join(fixtures, 'clip1.mp4'),
    join(fixtures, 'clip2.mp4'),
    join(fixtures, 'clip3.mp4'),
  ]);
  check(
    !(await page.isVisible('text=This device can\'t encode')),
    'no encoder-capability warnings for 1080p clips'
  );
  await setPreviewQuality(page, false);
  const outcome = await finalize(page);
  check(outcome === 'ok', `finalize succeeds (got: ${outcome})`);

  if (outcome === 'ok') {
    // Add music — an "Update video to mix your audio" prompt dialog opens;
    // click the update button inside it.
    await page.setInputFiles('#audio-input', join(fixtures, 'music.mp3'));
    const dialogUpdate = page.locator('[data-slot="dialog-content"] button:has-text("Update video")');
    await dialogUpdate.waitFor({ state: 'visible', timeout: 10_000 });
    await dialogUpdate.click();
    // Wait for the update spinner to clear
    await page.waitForFunction(
      () => !/Updating/.test(document.body.innerText),
      { timeout: 300_000 }
    );
    check(!(await page.isVisible('text=Render failed')), 'audio update succeeds');

    const file = join(outDir, 'scenarioA.mp4');
    await downloadFinal(page, file);
    check(existsSync(file) && statSync(file).size > 100_000, 'downloaded file is non-trivial');

    const probe = ffprobe(file);
    const v = probe.streams.find((s) => s.codec_type === 'video');
    const a = probe.streams.find((s) => s.codec_type === 'audio');
    const duration = parseFloat(probe.format.duration);
    check(v?.codec_name === 'h264', `video codec is h264 (got ${v?.codec_name})`);
    check(v?.width === 1920 && v?.height === 1080, `resolution preserved (got ${v?.width}x${v?.height})`);
    check(Math.abs(duration - 4.5) < 0.25, `duration ~4.5s: 3 clips x 1.5s (got ${duration})`);
    const frames = parseInt(v?.nb_read_frames ?? '0', 10);
    check(Math.abs(frames - 270) <= 6, `~270 frames at 60fps (got ${frames})`);
    check(a?.codec_name === 'aac' || a?.codec_name === 'mp3', `audio track present (got ${a?.codec_name})`);
    console.log(`  info: profile=${v?.profile} level=${v?.level} bitrate=${probe.format.bit_rate}`);
  }
  await context.close();
}

// ============================================================
console.log('Scenario B: mixed 1080p + 720p clips (re-encode fallback path)');
{
  const { context, page } = await freshPage(browser);
  await uploadClips(page, [join(fixtures, 'clip1.mp4'), join(fixtures, 'clip_small.mp4')]);
  await setPreviewQuality(page, false);
  const outcome = await finalize(page);
  check(outcome === 'ok', `mixed-resolution finalize succeeds (got: ${outcome})`);
  if (outcome === 'ok') {
    const file = join(outDir, 'scenarioB.mp4');
    await downloadFinal(page, file);
    const probe = ffprobe(file);
    const v = probe.streams.find((s) => s.codec_type === 'video');
    const duration = parseFloat(probe.format.duration);
    check(v?.codec_name === 'h264', `video codec is h264 (got ${v?.codec_name})`);
    check(Math.abs(duration - 3.0) < 0.25, `duration ~3.0s: 2 clips x 1.5s (got ${duration})`);
    console.log(`  info: ${v?.width}x${v?.height} frames=${v?.nb_read_frames}`);
  }
  await context.close();
}

// ============================================================
console.log('Scenario C: preview render, then download forces full-quality re-render');
{
  const { context, page } = await freshPage(browser);
  await uploadClips(page, [join(fixtures, 'clip1.mp4'), join(fixtures, 'clip2.mp4')]);
  await setPreviewQuality(page, true);
  const outcome = await finalize(page);
  check(outcome === 'ok', `preview finalize succeeds (got: ${outcome})`);
  if (outcome === 'ok') {
    const file = join(outDir, 'scenarioC.mp4');
    await downloadFinal(page, file); // triggers full-quality re-render first
    const probe = ffprobe(file);
    const v = probe.streams.find((s) => s.codec_type === 'video');
    check(
      v?.width === 1920 && v?.height === 1080,
      `download is full quality 1080p, not preview 720p (got ${v?.width}x${v?.height})`
    );
    const frames = parseInt(v?.nb_read_frames ?? '0', 10);
    check(Math.abs(frames - 180) <= 5, `~180 frames at 60fps for 3s (got ${frames})`);
  }
  await context.close();
}

await browser.close();
console.log(failures === 0 ? '\nALL E2E CHECKS PASSED' : `\n${failures} E2E CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
