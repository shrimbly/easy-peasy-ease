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

async function freshPage(browser, contextOptions) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.on('pageerror', (err) => console.log(`  [pageerror] ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`  [console.error] ${msg.text().slice(0, 200)}`);
  });
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  return { context, page };
}

// An iPhone-sized touch context (Chromium mobile emulation).
const MOBILE_CONTEXT = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
};

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

// ============================================================
console.log('Scenario D: split one 12s video into 3 eased sections');
{
  const { context, page } = await freshPage(browser);
  // Switch to "Split one video" mode and upload a single long clip.
  await page.locator('button', { hasText: 'Split one video' }).click();
  await page.setInputFiles('#split-input', join(fixtures, 'long.mp4'));

  // The split editor appears once metadata + encode capability are probed.
  const createButton = page.locator('button', { hasText: /^Create \d+ section/ });
  await createButton.waitFor({ state: 'visible', timeout: 30_000 });
  const createLabel = (await createButton.innerText()).trim();
  check(
    /Create 3 sections/.test(createLabel),
    `default 5s split of a 12s clip yields 3 sections (got "${createLabel}")`
  );

  // Create -> preview render -> editor.
  await createButton.click();
  const proceed = page.locator('button:has-text("Proceed Anyway")');
  try {
    await proceed.waitFor({ state: 'visible', timeout: 3_000 });
    await proceed.click();
  } catch {
    // No preflight dialog — fine.
  }
  const outcome = await Promise.race([
    page.waitForSelector('button:has-text("Download")', { timeout: 300_000 }).then(() => 'ok'),
    page.waitForSelector('text=Render failed', { timeout: 300_000 }).then(() => 'error'),
  ]);
  check(outcome === 'ok', `split finalize succeeds (got: ${outcome})`);

  if (outcome === 'ok') {
    const file = join(outDir, 'scenarioD.mp4');
    await downloadFinal(page, file); // preview render -> full-quality re-render on download
    check(existsSync(file) && statSync(file).size > 100_000, 'split download is non-trivial');

    const probe = ffprobe(file);
    const v = probe.streams.find((s) => s.codec_type === 'video');
    const duration = parseFloat(probe.format.duration);
    check(v?.codec_name === 'h264', `video codec is h264 (got ${v?.codec_name})`);
    check(v?.width === 1920 && v?.height === 1080, `full-quality 1080p (got ${v?.width}x${v?.height})`);
    check(Math.abs(duration - 4.5) < 0.3, `duration ~4.5s: 3 sections x 1.5s (got ${duration})`);
    const frames = parseInt(v?.nb_read_frames ?? '0', 10);
    check(Math.abs(frames - 270) <= 8, `~270 frames at 60fps (got ${frames})`);
    console.log(`  info: ${v?.width}x${v?.height} frames=${frames} duration=${duration}`);
  }
  await context.close();
}

// ============================================================
console.log('Scenario E: split mode on a mobile viewport (touch input)');
{
  const { context, page } = await freshPage(browser, MOBILE_CONTEXT);
  // Tap (not click) the mode toggle and upload one long clip.
  await page.locator('button', { hasText: 'Split one video' }).tap();
  await page.setInputFiles('#split-input', join(fixtures, 'long.mp4'));

  const createButton = page.locator('button', { hasText: /^Create \d+ section/ });
  await createButton.waitFor({ state: 'visible', timeout: 30_000 });
  check(
    /Create 3 sections/.test((await createButton.innerText()).trim()),
    'mobile: 12s clip splits into 3 sections by default'
  );

  // The split-track marker handle must be a finger-sized touch target.
  const marker = page.locator('button[aria-label^="Split point"]').first();
  const box = await marker.boundingBox();
  check(
    !!box && box.width >= 28 && box.height >= 40,
    `mobile: split marker is a finger-sized touch target (got ${box?.width}x${box?.height})`
  );

  // Touch path: tap a marker to select it, then tap its remove (×) button.
  await marker.tap();
  const removeBtn = page.locator('button[aria-label^="Remove split point"]').first();
  await removeBtn.waitFor({ state: 'visible', timeout: 5_000 });
  await removeBtn.tap();
  await page
    .waitForFunction(() => /Create 2 sections/.test(document.body.innerText), { timeout: 5_000 })
    .catch(() => {});
  check(
    /Create 2 sections/.test((await createButton.innerText()).trim()),
    'mobile: tap-select + tap-remove deletes a split (3 -> 2)'
  );

  // Create and finalize entirely via touch.
  await createButton.tap();
  const proceed = page.locator('button:has-text("Proceed Anyway")');
  try {
    await proceed.waitFor({ state: 'visible', timeout: 3_000 });
    await proceed.tap();
  } catch {
    // No preflight dialog — fine.
  }
  // On phones the editor shows a Clip/Audio/Export tab bar (Download lives in
  // the Export tab, not a persistent footer), so success = the tab bar appears.
  const exportTab = page.locator('button[role="tab"]', { hasText: 'Export' });
  const outcome = await Promise.race([
    exportTab.waitFor({ state: 'visible', timeout: 300_000 }).then(() => 'ok'),
    page.waitForSelector('text=Render failed', { timeout: 300_000 }).then(() => 'error'),
  ]);
  check(outcome === 'ok', `mobile: split finalize succeeds via touch (got: ${outcome})`);
  if (outcome === 'ok') {
    // Verify the mobile export path: tap Export -> Download becomes reachable.
    await exportTab.tap();
    const dl = page.locator('button', { hasText: /^Download/ }).first();
    await dl.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    check(await dl.isVisible(), 'mobile: Download is reachable via the Export tab');
  }
  await context.close();
}

await browser.close();
console.log(failures === 0 ? '\nALL E2E CHECKS PASSED' : `\n${failures} E2E CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
