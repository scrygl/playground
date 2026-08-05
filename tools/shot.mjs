#!/usr/bin/env node
/**
 * Headless capture harness.
 *
 * Boots the built app on a static server, drives it in Chromium with WebGPU
 * enabled (falling back to SwiftShader when there is no real GPU), and writes
 * screenshots plus the page's console log so we can actually see what shipped.
 *
 *   node tools/shot.mjs --out shots/ --steps steps.json
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import process from 'node:process';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? 'true' : arr[i + 1] ?? 'true']);
    return acc;
  }, []),
);

const ROOT = resolve(process.cwd(), args.root ?? 'dist');
const OUT = resolve(process.cwd(), args.out ?? 'shots');
const WIDTH = Number(args.width ?? 1600);
const HEIGHT = Number(args.height ?? 900);
const WAIT = Number(args.wait ?? 9000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

function serve(root) {
  return new Promise((res) => {
    const server = createServer(async (req, resp) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        let p = join(root, decodeURIComponent(url.pathname));
        if (!existsSync(p) || url.pathname === '/') p = join(root, 'index.html');
        const body = await readFile(p);
        resp.writeHead(200, {
          'Content-Type': MIME[extname(p)] ?? 'application/octet-stream',
          // Needed if we ever reach for SharedArrayBuffer / threaded wasm.
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
        });
        resp.end(body);
      } catch {
        resp.writeHead(404);
        resp.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => res(server));
  });
}

const server = await serve(ROOT);
const port = server.address().port;
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || undefined,
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,UseSkiaRenderer',
    '--use-angle=swiftshader',
    '--use-gl=angle',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

const ctx = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 1,
  reducedMotion: 'no-preference',
});
const page = await ctx.newPage();

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));
page.on('requestfailed', (r) => logs.push(`[requestfailed] ${r.url()} :: ${r.failure()?.errorText}`));

// Headless Chromium cannot composite a WebGPU canvas into screenshots, so the
// harness drives the WebGL2 fallback path by default. Same TSL, same scene.
const query = args.query ?? 'gpu=webgl';
await page.goto(`http://127.0.0.1:${port}/?${query}`, { waitUntil: 'load', timeout: 60_000 });

// Steps file lets callers script interactions: clicks, keys, waits, shots.
let steps = [];
if (args.steps && existsSync(resolve(process.cwd(), args.steps))) {
  steps = JSON.parse(await readFile(resolve(process.cwd(), args.steps), 'utf8'));
}

if (steps.length === 0) {
  await page.waitForTimeout(WAIT);
  await page.screenshot({ path: join(OUT, 'shot.png') });
} else {
  let n = 0;
  for (const step of steps) {
    try {
      if (step.wait) await page.waitForTimeout(step.wait);
      if (step.click) await page.click(step.click, { timeout: 8000 });
      if (step.hover) await page.hover(step.hover, { timeout: 8000 });
      if (step.key) await page.keyboard.press(step.key);
      if (step.keyDown) await page.keyboard.down(step.keyDown);
      if (step.keyUp) await page.keyboard.up(step.keyUp);
      if (step.eval) logs.push(`[eval] ${JSON.stringify(await page.evaluate(step.eval))}`);
      if (step.shot) {
        await page.screenshot({ path: join(OUT, `${String(++n).padStart(2, '0')}-${step.shot}.png`) });
        logs.push(`[shot] ${step.shot}`);
      }
    } catch (e) {
      logs.push(`[step-error] ${JSON.stringify(step)} :: ${e.message}`);
      await page.screenshot({ path: join(OUT, `${String(++n).padStart(2, '0')}-ERROR.png`) }).catch(() => {});
    }
  }
}

const state = await page.evaluate(() => ({
  spike: window.__SPIKE__ ?? null,
  game: window.__GAME_DEBUG__ ?? null,
  title: document.title,
}));

await writeFile(join(OUT, 'console.log'), logs.join('\n'), 'utf8');
await writeFile(join(OUT, 'state.json'), JSON.stringify(state, null, 2), 'utf8');

console.log(JSON.stringify(state, null, 2));
console.log('--- console tail ---');
console.log(logs.slice(-45).join('\n'));

await browser.close();
server.close();
