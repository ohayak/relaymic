// The extension suites' helpers, on the shared kit (../lib.mjs): the mock
// receiver (mock.mjs) and these suites' test pages (www/, served on
// 127.0.0.1:7631-7637) need nothing else. The extension under test is the
// kit's copy, pointed at 127.0.0.1:7621, where the mock listens.
import { launch as kitLaunch, serve, sleep, toneWav, makeExtension, portsFree, puppeteer, CHROME, S, E2E } from '../lib.mjs';
export { serve, sleep, makeExtension, puppeteer, CHROME, S, E2E };

// The mock takes the browser devices' port; the pages take theirs.
portsFree([7621, 7631, 7632, 7633, 7634, 7635, 7636, 7637]);
export const TONE440 = toneWav(440);
export const AUDIO_KIT_FILE = new URL('../audiokit.js', import.meta.url);

export function launch({ ext, args = [] } = {}) {
  return kitLaunch({ ext: ext ? [ext] : [], wav: TONE440, args: ['--no-proxy-server', ...args], defaultViewport: null });
}
