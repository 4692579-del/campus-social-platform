const { resolveFiles } = require('../services/post-images');

const STYLES = ['backgroundColor', 'borderBottomColor', 'borderBottomWidth',
  'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color'];
const IMAGE_TIMEOUT = 1800;
const MAX_SAMPLE_SIDE = 480;

function measure(component, selectors) {
  if (!component?.createSelectorQuery) return Promise.resolve({});
  return new Promise(resolve => {
    const query = component.createSelectorQuery();
    for (const selector of selectors) query.selectAll(selector).fields({ rect: true, size: true, dataset: true, computedStyle: STYLES });
    query.exec(results => resolve(Object.fromEntries(selectors.map((selector, i) => [selector, results?.[i] || []]))));
  });
}

function roundedRect(ctx, x, y, w, h, radius) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function lineWrap(ctx, value, width) {
  const lines = [];
  for (const line of value.split('\n')) {
    let current = '';
    for (const token of line.match(/[^\S\n]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) || []) {
      if (current && ctx.measureText(current + token).width > width) {
        lines.push(current);
        current = '';
      }
      if (ctx.measureText(token).width <= width) {
        current += token;
        continue;
      }
      for (const char of token) {
        if (current && ctx.measureText(current + char).width > width) {
          lines.push(current);
          current = '';
        }
        current += char;
      }
    }
    lines.push(current);
  }
  return lines;
}

function paintText(ctx, box, value, wrap, clip) {
  const fontSize = parseFloat(box.fontSize);
  if (!value || !(fontSize > 0) || !box.width || !box.height) return;
  const height = parseFloat(box.lineHeight) || fontSize * 1.25;
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.left, box.top, box.width, Math.max(0, Math.min(box.height, clip ? clip.bottom - box.top : Infinity)));
  ctx.clip();
  ctx.font = `${box.fontWeight || '400'} ${fontSize}px ${box.fontFamily || 'sans-serif'}`;
  ctx.fillStyle = box.color || '#171b20';
  ctx.textBaseline = 'alphabetic';
  // Canvas and WebView can have different glyph metrics on the same device.
  const metrics = ctx.measureText('国Ag');
  const baseline = (height - (metrics.actualBoundingBoxAscent || fontSize * .8) -
    (metrics.actualBoundingBoxDescent || fontSize * .2)) / 2 + (metrics.actualBoundingBoxAscent || fontSize * .8);
  if (wrap) {
    lineWrap(ctx, String(value), box.width).forEach((line, i) => ctx.fillText(line, box.left, box.top + baseline + i * height));
  } else {
    let text = String(value), fitted = '';
    if (ctx.measureText(text).width > box.width + 1) {
      for (const char of text) {
        if (ctx.measureText(fitted + char + '…').width > box.width) break;
        fitted += char;
      }
      text = fitted + '…';
    }
    ctx.fillText(text, box.left, box.top + (box.height - height) / 2 + baseline);
  }
  ctx.restore();
}

function paintImage(ctx, image, box, { mode, clip, radius = 0, background, omitIfMissing }) {
  if (!image && !background && !omitIfMissing) return;
  ctx.save();
  if (clip) {
    roundedRect(ctx, clip.left, clip.top, clip.width, clip.height, clip.radius);
    ctx.clip();
  }
  roundedRect(ctx, box.left, box.top, box.width, box.height, radius);
  ctx.clip();
  if (!image && omitIfMissing) {
    ctx.clearRect(box.left, box.top, box.width, box.height);
  } else if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(box.left, box.top, box.width, box.height);
  }
  if (image) {
    const scale = (mode === 'aspectFill' ? Math.max : Math.min)(box.width / image.width, box.height / image.height);
    const w = image.width * scale, h = image.height * scale;
    ctx.drawImage(image, box.left + (box.width - w) / 2, box.top + (box.height - h) / 2, w, h);
  }
  ctx.restore();
}

function overlaps(a, b) {
  return a?.width > 0 && a.height > 0 && b?.width > 0 && b.height > 0 &&
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function addPostLayers(layers, boxes, state, unit) {
  const post = state.post;
  if (!post) return;
  const author = post.author || {};
  const [avatar] = boxes['.post-avatar'], [badge] = boxes['.author-badge'];
  const [gallery] = boxes['.post-image-gallery'], [card] = boxes['.post-card'];
  layers.rect(boxes['.post-pin'][0]);
  layers.image(boxes['.post-pin image'][0], '/images/interface/pin.svg');
  layers.text(boxes['.post-pin text'][0], '置顶');
  layers.rect(card, true);
  layers.image(avatar, author.avatarFileID || '/images/avatar.png', {
    mode: 'aspectFill', radius: (avatar?.width || 0) / 2, background: '#f0f2f4', omitIfMissing: true,
  });
  layers.image(badge, '/images/verification/' + (author.officialVerified ? 'verified.png' : 'student.svg'));
  layers.text(boxes['.post-name'][0], author.nickname);
  layers.text(boxes['.post-time'][0], '· ' + (post.timeText || ''));
  layers.image(boxes['.post-more-icon'][0], '/images/interface/menu-two.svg');
  const content = state.expanded || state.sevenLinePreview ? (post.fullContent || post.content) : post.content;
  layers.text(boxes['.post-text'][0], content, true, boxes['.post-text-clip'][0]);
  layers.text(boxes['.expand-post'][0], state.expanded ? '收起' : '展开全文');
  layers.media(boxes['.sand-media'], [gallery], unit);
  layers.text(boxes['.post-declaration text'][0], post.declarationText, true);
  layers.image(boxes['.post-declaration image'][0], '/images/interface/alert-circle-muted.svg');
  const format = value => value >= 1e8 ? Math.floor(value / 1e7) / 10 + '亿' :
    value >= 1e4 ? Math.floor(value / 1e3) / 10 + '万' : String(Math.max(0, Math.floor(value || 0)));
  const counts = [post.replyCount, post.likeCount, post.quoteCount];
  boxes['.post-action text'].forEach((box, i) => layers.text(box, format(counts[i])));
  const actions = ['comment', post.liked ? (state.likeMotion ? 'like-filled' : 'like-active') : 'like',
    post.quoted ? 'quote-active' : 'quote', 'share'];
  boxes['.post-action image:not(.like-particle)'].forEach((box, i) => layers.image(box, '/images/post-actions/' + actions[i] + '.svg'));
}

function addQuoteLayers(layers, boxes, frames, unit) {
  for (const box of boxes['.quote-border']) layers.border(box, 22 * unit, 2 * unit);
  for (const box of boxes['.quote-entry.is-nested']) layers.border(box, 16 * unit, 2 * unit);
  const build = (selector, draw) => boxes[selector].forEach(box => draw(box, frames[box.dataset?.frame] || {}));
  build('.quote-avatar', (box, row) => layers.image(box, row.author?.avatarFileID || '/images/avatar.png',
    { mode: 'aspectFill', radius: box.width / 2, background: '#f0f2f4', omitIfMissing: true }));
  build('.quote-name', (box, row) => layers.text(box, row.author?.nickname));
  build('.quote-time', (box, row) => layers.text(box, row.timeText));
  build('.quote-verified', (box, row) => layers.image(box, '/images/verification/' + (row.author?.officialVerified ? 'verified.png' : 'student.svg')));
  build('.quote-content', (box, row) => layers.text(box, row.content, true));
  build('.quote-placeholder', (box, row) => layers.text(box, row.loading ? '正在读取原动态…' :
    row.unavailable ? '原动态已删除或不可见' : row.failed ? '原动态暂时无法读取' : '查看更早的引用 ›'));
  build('.quote-declaration text', (box, row) => layers.text(box, row.declarationText, true));
  for (const box of boxes['.quote-declaration-icon']) layers.image(box, '/images/interface/alert-circle-muted.svg');
  layers.media(boxes['.sand-media'], boxes['.quote-gallery'], unit);
}

const native = (name, options) => new Promise((resolve, reject) => wx[name]({ ...options, success: resolve, fail: reject }));

function loadImages(canvas, files, current) {
  const loaded = new Map();
  if (!files.length) return Promise.resolve(loaded);
  return new Promise(resolve => {
    let active = true;
    const finish = () => { active = false; clearTimeout(timer); resolve(loaded); };
    const timer = setTimeout(finish, IMAGE_TIMEOUT);
    const valid = () => active && current();
    Promise.allSettled(files.map(async file => {
      if (file.startsWith('/images/')) { await decode(file, file); return; }
      if (!/^(cloud:\/\/|https:\/\/)/.test(file)) return;
      const pathFromDisplayCache = async () => (await native('getImageInfo', { src: file })).path;
      const pathFromCloud = async () => (await wx.cloud.downloadFile({ fileID: file })).tempFilePath;
      const pathFromURL = async () => {
        const [url] = await resolveFiles([file]);
        if (valid()) return (await native('getImageInfo', { src: url })).path;
      };
      const loaders = [pathFromDisplayCache];
      if (file.startsWith('cloud://') && typeof wx.cloud?.downloadFile === 'function') loaders.push(pathFromCloud);
      if (file.startsWith('cloud://')) loaders.push(pathFromURL);
      await new Promise(resolve => {
        let pending = loaders.length;
        const complete = ok => { if (ok || --pending === 0) resolve(); };
        for (const load of loaders) {
          load().then(path => readLocal(file, path)).then(complete, () => complete(false));
        }
      });
    })).then(finish);

    async function readLocal(file, path) {
      if (!path || !valid() || (/^(cloud:\/\/|https?:\/\/)/.test(path) && !path.startsWith('http://tmp/'))) return false;
      if (loaded.has(file) || await decode(file, path)) return true;
      if (!valid()) return false;
      // Some offscreen implementations reject temporary file paths but decode data URIs.
      const fs = wx.getFileSystemManager?.();
      if (!fs) return false;
      const { size } = await new Promise((success, fail) => fs.getFileInfo({ filePath: path, success, fail }));
      if (!valid() || !(size > 0 && size <= 5 * 1024 * 1024)) return;
      const { data } = await new Promise((success, fail) => fs.readFile({ filePath: path, success, fail }));
      if (!valid() || data.byteLength > 5 * 1024 * 1024) return;
      const bytes = new Uint8Array(data);
      let type;
      if (bytes[0] === 0xff && bytes[1] === 0xd8) type = 'jpeg';
      else if (bytes[0] === 0x89 && bytes[1] === 0x50) type = 'png';
      else if (bytes[0] === 0x52 && bytes[8] === 0x57 && bytes[9] === 0x45) type = 'webp';
      if (type && typeof wx.arrayBufferToBase64 === 'function') {
        return decode(file, 'data:image/' + type + ';base64,' + wx.arrayBufferToBase64(data));
      }
      return false;
    }

    function decode(file, src) {
      if (!src || !valid()) return false;
      return new Promise(done => {
        const img = canvas.createImage();
        img.onload = () => {
          const ready = Boolean(valid() && img.width && img.height);
          if (ready) loaded.set(file, img);
          done(ready);
        };
        img.onerror = () => done(false);
        img.src = src;
      });
    }
  });
}

async function cardPixels(card, rect, area, current) {
  if (!card?.data?.post || typeof wx.createOffscreenCanvas !== 'function') return;
  const viewport = { left: rect.left, right: rect.right, top: rect.top + area.top, bottom: rect.top + area.top + area.height,
    width: area.width, height: area.height };
  const quote = card.selectComponent?.('#post-quote');
  const [boxes, quoteBoxes] = await Promise.all([
    measure(card, ['.post-card', '.post-pin', '.post-pin image', '.post-pin text', '.post-avatar', '.author-badge', '.post-name', '.post-time', '.post-more-icon', '.post-text',
      '.post-text-clip', '.expand-post', '.post-image-gallery', '.sand-media', '.post-declaration text', '.post-declaration image',
      '.post-action text', '.post-action image:not(.like-particle)']),
    measure(quote, ['.quote-border', '.quote-entry.is-nested', '.quote-avatar', '.quote-name', '.quote-time', '.quote-verified',
      '.quote-content', '.quote-placeholder', '.quote-declaration text', '.quote-declaration-icon', '.sand-media', '.quote-gallery']),
  ]);
  if (!current() || !boxes['.post-card']?.length) return;
  const scale = Math.min(1, MAX_SAMPLE_SIDE / Math.max(area.width, area.height));
  const width = Math.ceil(area.width * scale), height = Math.ceil(area.height * scale);
  const canvas = wx.createOffscreenCanvas({ type: '2d', width, height });
  const ctx = canvas.getContext('2d');
  ctx.scale(width / area.width, height / area.height);
  ctx.translate(-viewport.left, -viewport.top);
  const draws = [], files = new Set(), requiredMedia = new Set();
  let missingMedia = false;
  const layers = {
    rect(box, bottom) {
      if (!overlaps(box, viewport)) return;
      draws.push(() => {
        ctx.fillStyle = box.backgroundColor || '#fff';
        ctx.fillRect(box.left, box.top, box.width, box.height);
        if (bottom) {
          const line = parseFloat(box.borderBottomWidth) || rect.width / 750;
          ctx.fillStyle = box.borderBottomColor || '#dce1e7';
          ctx.fillRect(box.left, box.bottom - line, box.width, line);
        }
      });
    },
    border(box, radius, width) {
      if (!overlaps(box, viewport)) return;
      draws.push(() => {
        ctx.save();
        roundedRect(ctx, box.left, box.top, box.width, box.height, radius);
        ctx.strokeStyle = '#c7cdd6';
        ctx.lineWidth = width;
        ctx.setLineDash?.([4 * width, 3 * width]);
        ctx.stroke();
        ctx.restore();
      });
    },
    text(box, value, wrap, clip) {
      if (overlaps(box, viewport)) draws.push(() => paintText(ctx, box, value, wrap, clip));
    },
    image(box, url, options = {}) {
      if (!overlaps(box, viewport)) return;
      if (url) files.add(url);
      if (options.omitIfMissing) {
        if (url) requiredMedia.add(url);
        else missingMedia = true;
      }
      draws.push(images => paintImage(ctx, images.get(url), box, options));
    },
    media(media, galleries, unit) {
      for (const box of media) {
        const clip = galleries.find(gallery => overlaps(box, gallery) && overlaps(gallery, viewport));
        if (clip) this.image(box, box.dataset?.source, {
          mode: box.dataset?.mode, radius: 20 * unit, background: '#f0f2f4',
          clip: { ...clip, radius: 20 * unit }, omitIfMissing: true,
        });
      }
    },
  };
  const unit = rect.width / 750;
  addPostLayers(layers, boxes, card.data, unit);
  if (quote && quoteBoxes['.quote-border']?.length) addQuoteLayers(layers, quoteBoxes, quote.data.frames || [], unit);
  const images = await loadImages(canvas, [...files], current);
  if (!current()) return;
  // The live card hands off its whole visible image to the canvas. A partial
  // capture would drop an entire photo before any of its tiles has detached.
  if (missingMedia || [...requiredMedia].some(file => !images.has(file))) return;
  for (const draw of draws) draw(images);
  return { surface: canvas, data: ctx.getImageData(0, 0, width, height).data, width, height };
}

module.exports = { cardPixels };
