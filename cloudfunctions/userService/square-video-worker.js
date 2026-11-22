const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');

async function convert() {
  const { input, output, args, deadline, maxOutputBytes } = workerData;
  let core;
  try {
    // UMD 构建按 Web Worker 加载；显式提供本地 npm 包中的 wasm 字节，不发起网络请求。
    globalThis.self = { location: { href: 'file:///ffmpeg-core.js' } };
    const createCore = require('@ffmpeg/core');
    core = await createCore({ wasmBinary: fs.readFileSync(require.resolve('@ffmpeg/core/wasm')) });
  } catch (_) {
    return 'VIDEO_CONVERTER_UNAVAILABLE';
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) return 'VIDEO_PROCESS_TIMEOUT';
  try {
    core.FS.writeFile('/source.video', fs.readFileSync(input), { canOwn: true });
    core.setTimeout(remaining);
    const result = core.exec(...args);
    if (Date.now() >= deadline) return 'VIDEO_PROCESS_TIMEOUT';
    if (result !== 0) return 'VIDEO_DECODE_FAILED';
    const { size } = core.FS.stat('/playback.mp4');
    if (size > maxOutputBytes) return 'VIDEO_TOO_LARGE';
    if (!size) return 'VIDEO_DECODE_FAILED';
    fs.writeFileSync(output, core.FS.readFile('/playback.mp4'));
    return null;
  } catch (_) {
    return Date.now() >= deadline ? 'VIDEO_PROCESS_TIMEOUT' : 'VIDEO_DECODE_FAILED';
  }
}

if (parentPort) convert().then(code => parentPort.postMessage({ code }), () => parentPort.postMessage({ code: 'VIDEO_CONVERTER_UNAVAILABLE' }));
