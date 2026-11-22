const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
const { Transform, pipeline } = require('stream');
const { Worker } = require('worker_threads');
const run = promisify(execFile);
const copy = promisify(pipeline);
const MiB = 1024 * 1024;
const MAX_SOURCE_BYTES = 100 * MiB;
const MAX_OUTPUT_BYTES = 48 * MiB;
const DIRECT_COPY_BYTES = 20 * MiB;
const VIDEO_ERRORS = {
  VIDEO_READ_FAILED: '无法读取已上传的视频，请重试；如果文件已失效，请重新选择',
  VIDEO_PROCESS_TIMEOUT: '视频处理超时，正文和附件已保留，请稍后重试',
  VIDEO_CONVERTER_UNAVAILABLE: '视频转码服务暂不可用，请稍后重试',
  VIDEO_DECODE_FAILED: '这段视频暂时无法解码，可能已损坏或受保护，请重新选择',
  VIDEO_TOO_LARGE: '视频自动压缩后仍过大，请选择较短的视频',
};
const failure = (code, message = VIDEO_ERRORS[code]) => Object.assign(new Error(message), { code });
const invalid = () => failure('INVALID_MEDIA', '视频结构不完整');

function atoms(bytes, start = 0, end = bytes.length) {
  const result = [];
  for (let offset = start; offset < end;) {
    if (end - offset < 8 || result.length >= 4096) throw invalid();
    let size = bytes.readUInt32BE(offset), header = 8;
    if (size === 1) {
      if (end - offset < 16 || bytes.readUInt32BE(offset + 8) !== 0) throw invalid();
      size = bytes.readUInt32BE(offset + 12);
      header = 16;
    } else if (size === 0) size = end - offset;
    if (size < header || size > end - offset) throw invalid();
    result.push({ type: bytes.toString('ascii', offset + 4, offset + 8), start: offset + header, end: offset + size });
    offset += size;
  }
  return result;
}

function isCompatibleHevc(bytes, entry) {
  if (entry.type !== 'hvc1' || entry.end - entry.start < 86) return false;
  const config = atoms(bytes, entry.start + 78, entry.end).find(atom => atom.type === 'hvcC');
  if (!config || config.end - config.start < 23) return false;
  const hvcC = bytes.subarray(config.start, config.end);
  // 微信播放器支持 HEVC。直传限于常见的 8-bit Main、4:2:0、1080p 规格。
  if (hvcC[0] !== 1 || hvcC[1] !== 1 || !hvcC[12] || hvcC[12] > 123 ||
      (hvcC[16] & 3) !== 1 || (hvcC[17] & 7) || (hvcC[18] & 7)) return false;
  const parameterSets = new Set();
  let offset = 23;
  for (let index = 0; index < hvcC[22]; index++) {
    if (offset + 3 > hvcC.length) return false;
    const nalType = hvcC[offset] & 63;
    const count = hvcC.readUInt16BE(offset + 1);
    offset += 3;
    for (let nal = 0; nal < count; nal++) {
      if (offset + 2 > hvcC.length) return false;
      const length = hvcC.readUInt16BE(offset);
      offset += 2;
      if (length < 2 || offset + length > hvcC.length || ((hvcC[offset] >> 1) & 63) !== nalType) return false;
      offset += length;
    }
    if (count) parameterSets.add(nalType);
  }
  return offset === hvcC.length && [32, 33, 34].every(type => parameterSets.has(type));
}

function videoSize(bytes, { allowQuickTime = false, allowHevc = false } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.length > MAX_OUTPUT_BYTES) throw invalid();
  const top = atoms(bytes);
  const brand = top.find(atom => atom.type === 'ftyp'), movie = top.find(atom => atom.type === 'moov');
  if (!brand || brand.end - brand.start < 8 || !allowQuickTime && bytes.toString('ascii', brand.start, brand.start + 4) === 'qt  ' ||
      !movie || !top.some(atom => atom.type === 'mdat' && atom.end > atom.start)) throw invalid();
  const children = atom => atom ? atoms(bytes, atom.start, atom.end) : [];
  const tracks = [];
  for (const track of children(movie).filter(atom => atom.type === 'trak')) {
    const parts = children(track), header = parts.find(atom => atom.type === 'tkhd');
    const media = children(parts.find(atom => atom.type === 'mdia'));
    const handler = media.find(atom => atom.type === 'hdlr');
    if (!handler || handler.end - handler.start < 12) continue;
    const kind = bytes.toString('ascii', handler.start + 8, handler.start + 12);
    if (kind !== 'vide' && kind !== 'soun') continue;
    const info = children(media.find(atom => atom.type === 'minf'));
    const table = children(info.find(atom => atom.type === 'stbl'));
    const descriptions = table.find(atom => atom.type === 'stsd');
    const entries = descriptions && descriptions.end - descriptions.start >= 16 ?
      atoms(bytes, descriptions.start + 8, descriptions.end) : [];
    tracks.push({ kind, entries, header });
  }
  const videoTracks = tracks.filter(track => track.kind === 'vide');
  const audioTracks = tracks.filter(track => track.kind === 'soun');
  for (const { entries, header } of videoTracks) {
    if (!entries.length || !header) continue;
    const avc = entries.every(entry => ['avc1', 'avc3'].includes(entry.type));
    const hevc = allowHevc && videoTracks.length === 1 && audioTracks.length <= 1 &&
      audioTracks.every(track => track.entries.length && track.entries.every(entry => entry.type === 'mp4a')) &&
      entries.every(entry => isCompatibleHevc(bytes, entry));
    if (!avc && !hevc) continue;
    const version = bytes[header.start], matrix = header.start + (version === 1 ? 52 : 40);
    if (version > 1 || header.end - matrix < 44) continue;
    let width = bytes.readUInt32BE(matrix + 36) / 65536, height = bytes.readUInt32BE(matrix + 40) / 65536;
    if (Math.abs(bytes.readInt32BE(matrix + 4)) > Math.abs(bytes.readInt32BE(matrix))) [width, height] = [height, width];
    if (width < 1 || height < 1 || width > 8192 || height > 8192) continue;
    if (hevc && (Math.max(width, height) > 1920 || Math.min(width, height) > 1080)) continue;
    return { width, height };
  }
  throw invalid();
}

async function remuxVideo(input, output, deadline) {
  let source, destination, conversion, timer;
  try {
    timeLeft(deadline);
    const { Input, FilePathSource, MP4, QTFF, Output, Mp4OutputFormat, FilePathTarget, Conversion } = require('mediabunny');
    source = new Input({ source: new FilePathSource(input), formats: [MP4, QTFF] });
    const [video, audio] = await Promise.all([source.getPrimaryVideoTrack(), source.getPrimaryAudioTrack()]);
    if (!video || await video.getCodec() !== 'avc' || audio && await audio.getCodec() !== 'aac') return false;
    destination = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new FilePathTarget(output) });
    conversion = await Conversion.init({ input: source, output: destination, tracks: 'primary',
      copy: { mode: 'forced', shiftTolerance: Infinity }, tags: {}, showWarnings: false });
    // 原视频有声音时不能让只复制画面的成品通过。
    if (!conversion.isValid || conversion.discardedTracks.some(({ track }) => track === video || track === audio)) return false;
    timer = setTimeout(() => { conversion.cancel().catch(() => {}); }, timeLeft(deadline));
    await conversion.execute();
    timeLeft(deadline);
    return true;
  } catch (error) {
    if (Date.now() >= deadline || error.code === 'VIDEO_PROCESS_TIMEOUT') throw failure('VIDEO_PROCESS_TIMEOUT');
    return false;
  } finally {
    clearTimeout(timer);
    if (destination && destination.state !== 'finalized') await destination.cancel().catch(() => {});
    if (source) source.dispose();
  }
}

function timeLeft(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw failure('VIDEO_PROCESS_TIMEOUT');
  return remaining;
}

async function beforeDeadline(operation, deadline) {
  const remaining = timeLeft(deadline);
  let timer;
  try {
    return await Promise.race([
      new Promise((_, reject) => { timer = setTimeout(() => reject(failure('VIDEO_PROCESS_TIMEOUT')), remaining); }),
      operation(),
    ]);
  } finally { clearTimeout(timer); }
}

function download(url, destination, deadline) {
  const timeout = Math.min(16000, timeLeft(deadline));
  return new Promise((resolve, reject) => {
    let timer, streaming = false, timedOut = false;
    const finish = error => {
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const request = https.get(url, async response => {
      if (response.statusCode !== 200) {
        response.destroy(); finish(failure('VIDEO_READ_FAILED')); return;
      }
      if (Number(response.headers['content-length']) > MAX_SOURCE_BYTES) {
        response.destroy(); finish(failure('VIDEO_TOO_LARGE')); return;
      }
      let size = 0;
      const limit = new Transform({ transform(chunk, _, callback) {
        size += chunk.length;
        callback(size > MAX_SOURCE_BYTES ? failure('VIDEO_TOO_LARGE') : null, chunk);
      } });
      streaming = true;
      try { await copy(response, limit, fs.createWriteStream(destination)); finish(); }
      catch (error) { finish(timedOut ? failure('VIDEO_PROCESS_TIMEOUT') : error.code === 'VIDEO_TOO_LARGE' ? error : failure('VIDEO_READ_FAILED')); }
    });
    timer = setTimeout(() => {
      timedOut = true;
      if (!streaming) finish(failure('VIDEO_PROCESS_TIMEOUT'));
      request.destroy(failure('VIDEO_PROCESS_TIMEOUT'));
    }, timeout);
    request.on('error', () => { if (!streaming) finish(failure(timedOut ? 'VIDEO_PROCESS_TIMEOUT' : 'VIDEO_READ_FAILED')); });
  });
}

function transcodeArgs(input, output, threads) {
  const protocols = ['-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm,avi,mpeg,mpegts,flv,asf,ogg'];
  const readOptions = ['-nostdin', '-loglevel', 'error', '-max_alloc', String(128 * MiB), ...protocols,
    '-threads', '1', '-max_pixels', '16777216', '-i', input];
  const encodeOptions = ['-map', '0:V:0', '-map', '0:a:0?', '-map_metadata', '-1', '-map_chapters', '-1',
    '-vf', "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    '-fpsmax', '30', '-c:v', 'libx264', '-threads', String(threads), '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ac', '2', '-b:a', '96k', '-movflags', '+faststart'];
  return [...readOptions, ...encodeOptions, '-crf', '26', '-maxrate', '1400k', '-bufsize', '2800k',
    '-fs', String(MAX_OUTPUT_BYTES + MiB), '-y', '-f', 'mp4', output];
}

function transcodeInWorker(input, output, deadline) {
  const timeout = timeLeft(deadline);
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(require.resolve('./square-video-worker'), { workerData: {
        input, output, deadline, maxOutputBytes: MAX_OUTPUT_BYTES,
        args: transcodeArgs('/source.video', '/playback.mp4', 1),
      } });
    } catch (_) { reject(failure('VIDEO_CONVERTER_UNAVAILABLE')); return; }
    let settled = false;
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.unref();
      void worker.terminate().catch(() => {});
      if (code) reject(failure(code)); else resolve();
    };
    const timer = setTimeout(() => finish('VIDEO_PROCESS_TIMEOUT'), timeout);
    worker.once('message', value => finish(value && 'code' in value ? value.code : 'VIDEO_CONVERTER_UNAVAILABLE'));
    worker.once('error', () => finish('VIDEO_CONVERTER_UNAVAILABLE'));
    worker.once('exit', () => finish('VIDEO_CONVERTER_UNAVAILABLE'));
  });
}

async function transcode(input, output, deadline) {
  const binary = process.env.SQUARE_FFMPEG_PATH;
  if (binary && path.isAbsolute(binary)) {
    try {
      await run(binary, transcodeArgs(input, output, 2), {
        timeout: timeLeft(deadline), killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 64 * 1024,
      });
      return;
    } catch (error) {
      if (error.code === 'VIDEO_PROCESS_TIMEOUT' || error.killed) throw failure('VIDEO_PROCESS_TIMEOUT');
      if (!['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code)) throw failure('VIDEO_DECODE_FAILED');
    }
  }
  await transcodeInWorker(input, output, deadline);
}

function createSquareVideoProcessor(cloud, { read = download, convert = transcode, remux = remuxVideo } = {}) {
  return async (fileID, { userId, postId, index, deadline = Date.now() + 42000 }) => {
    let file;
    try {
      const result = await beforeDeadline(() => cloud.getTempFileURL({ fileList: [{ fileID, maxAge: 120 }] }), deadline);
      file = result.fileList?.find(item => item.fileID === fileID);
    } catch (error) {
      if (error.code === 'VIDEO_PROCESS_TIMEOUT') throw error;
      throw failure('VIDEO_READ_FAILED');
    }
    if (!file || (file.status !== undefined && file.status !== 0) || (file.code && file.code !== 'SUCCESS') ||
        !/^https:\/\//.test(file.tempFileURL || '')) throw failure('VIDEO_READ_FAILED');

    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'square-video-'));
    const input = path.join(directory, 'source.video'), output = path.join(directory, 'playback.mp4');
    try {
      await read(file.tempFileURL, input, deadline);
      const { size: sourceSize } = await fs.promises.stat(input);
      if (sourceSize > MAX_SOURCE_BYTES) throw failure('VIDEO_TOO_LARGE');
      let bytes, size;
      if (sourceSize <= DIRECT_COPY_BYTES) {
        bytes = await fs.promises.readFile(input);
        try { size = videoSize(bytes, { allowHevc: true }); }
        catch (error) { if (error.code !== 'INVALID_MEDIA') throw error; }
        if (!size) {
          let compatible = false;
          try { videoSize(bytes, { allowQuickTime: true }); compatible = true; }
          catch (error) { if (error.code !== 'INVALID_MEDIA') throw error; }
          bytes = null;
          if (compatible && await remux(input, output, deadline)) {
            const result = await fs.promises.stat(output);
            if (result.size <= MAX_OUTPUT_BYTES) {
              bytes = await fs.promises.readFile(output);
              try { size = videoSize(bytes); }
              catch (error) { if (error.code !== 'INVALID_MEDIA') throw error; }
            }
          }
        }
      }
      if (!size) {
        bytes = null;
        await convert(input, output, deadline);
        const result = await fs.promises.stat(output);
        if (result.size > MAX_OUTPUT_BYTES) throw failure('VIDEO_TOO_LARGE');
        bytes = await fs.promises.readFile(output);
        try { size = videoSize(bytes); }
        catch (_) { throw failure('VIDEO_DECODE_FAILED'); }
      }
      timeLeft(deadline);
      const digest = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 24);
      const cloudPath = `square-media/${userId}/${postId}/${index}-${digest}.mp4`;
      const publicFile = await beforeDeadline(() => cloud.uploadFile({ cloudPath, fileContent: bytes }), deadline);
      return { fileID: publicFile.fileID, ...size };
    } finally {
      await Promise.allSettled([fs.promises.unlink(input), fs.promises.unlink(output)]);
      await fs.promises.rmdir(directory).catch(() => {});
    }
  };
}

module.exports = { createSquareVideoProcessor, videoSize, remuxVideo, transcode, VIDEO_ERRORS };
