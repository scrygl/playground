import './style.css';
import './ui/styles.css';
import { App } from './app';

/**
 * Entry point.
 *
 * Its only jobs are to find the two DOM nodes the game needs, start the
 * application, and present something honest if that fails — a blank canvas
 * tells a player nothing, and the most likely failure here is a browser that
 * cannot provide WebGPU *or* WebGL2.
 */

declare global {
  interface Window {
    /** Exposed for the headless capture harness and for debugging. */
    __GAME_DEBUG__: Record<string, unknown>;
  }
}

window.__GAME_DEBUG__ = { ready: false, frames: 0 };

function fail(title: string, message: string, detail?: string): void {
  const wrap = document.createElement('div');
  wrap.className = 'boot-failure';

  const heading = document.createElement('h1');
  heading.textContent = title;
  wrap.appendChild(heading);

  const body = document.createElement('p');
  body.textContent = message;
  wrap.appendChild(body);

  if (detail) {
    const pre = document.createElement('pre');
    pre.textContent = detail;
    wrap.appendChild(pre);
  }
  document.body.appendChild(wrap);
}

async function main(): Promise<void> {
  const canvas = document.getElementById('stage') as HTMLCanvasElement | null;
  const uiRoot = document.getElementById('ui');
  if (!canvas || !uiRoot) throw new Error('Missing #stage or #ui in the document.');

  const app = await App.create(canvas, uiRoot);
  window.__GAME_DEBUG__.app = app;
  window.__GAME_DEBUG__.ready = true;
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  window.__GAME_DEBUG__.error = detail;
  console.error(error);
  fail(
    'Velocity Horizon could not start',
    'This game needs a browser with WebGPU or WebGL2. Recent Chrome, Edge, Firefox and Safari all qualify; if you are on one of those, hardware acceleration may be switched off.',
    detail,
  );
});
