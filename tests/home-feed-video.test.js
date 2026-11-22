const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const flush = () => new Promise(resolve => setImmediate(resolve));
const video = fileID => ({ fileID, type: 'video', width: 320, height: 180 });

function fixture(resolve = async file => 'https://example.test/' + file) {
  let definition;
  const requests = [], paused = [], playback = [];
  vm.runInNewContext(fs.readFileSync('miniprogram/components/square-post/index.js', 'utf8'), {
    Component: value => { definition = value; },
    require: name => name.endsWith('/post-images') ? {
      resolveVideoPlayback(file) { requests.push(file); return resolve(file); },
    } : require('../miniprogram/utils/' + name.split('/').pop()),
    wx: { createVideoContext: (id, component) => ({
      pause() { paused.push({ id, component }); },
      seek(time) { playback.push({ id, time }); },
      play() { playback.push({ id, play: true }); },
    }) },
  });
  function card(media, enabled = true, { detail = false, homeFeed = enabled && !detail } = {}) {
    const observers = [];
    const c = {
      ...definition.methods,
      data: { ...structuredClone(definition.data), detail, homeFeed, feedVideoEnabled: enabled },
      setData(values, done) {
        for (const [path, value] of Object.entries(values)) {
          const [field, key] = path.split('.');
          if (key) this.data[field][key] = value;
          else this.data[field] = value;
        }
        done?.();
      },
      createIntersectionObserver() {
        const observer = {
          relativeToViewport() { return this; },
          observe(selector, callback) { assert.equal(selector, '.post-image-gallery'); this.emit = callback; },
          disconnect() { this.disconnected = true; },
        };
        observers.push(observer);
        return observer;
      },
    };
    c.syncMedia({ media });
    definition.lifetimes.ready.call(c);
    return {
      c, observers, see: ratio => observers.at(-1).emit({ intersectionRatio: ratio }),
      hide: () => definition.pageLifetimes.hide.call(c),
      show: () => definition.pageLifetimes.show.call(c),
      detach: () => definition.lifetimes.detached.call(c),
      enable(value) { c.data.feedVideoEnabled = value; definition.observers.feedVideoEnabled.call(c); },
      event(detail = {}, token = c.data.feedVideo.token) { return { currentTarget: { dataset: { token } }, detail }; },
    };
  }
  return { card, requests, paused, playback };
}

test('首页视频在视野内单条循环，滑出暂停，返回后从本轮的最近进度续播', async () => {
  const f = fixture();
  const a = f.card([video('a')]), b = f.card([video('b')]);
  a.see(.3);
  await flush();
  assert.deepEqual(f.requests, []);
  a.see(.8);
  b.see(.7);
  await flush();
  assert.equal(a.c.data.feedVideo.src, 'https://example.test/a');
  assert.equal(b.c.data.feedVideo, null);
  const first = a.event({ currentTime: 9 });
  a.c.feedVideoTime(first);
  a.c.feedVideoTime(a.event({ currentTime: 1 }));
  assert.equal(a.c.data.feedVideo.file, 'a');
  assert.equal(b.c.data.feedVideo, null);
  a.see(.2);
  await flush();
  assert.equal(f.paused[0].component, a.c);
  assert.equal(b.c.data.feedVideo.file, 'b');
  a.see(.7);
  b.see(0);
  await flush();
  assert.equal(a.c.data.feedVideo.start, 1);
  a.c.feedVideoTime(first);
  a.see(0);
  a.see(.7);
  await flush();
  assert.equal(a.c.data.feedVideo.start, 1);
  assert.deepEqual(f.requests, ['a', 'b', 'a', 'a']);
});

test('混排动态只播当前视频，关闭面板或返回后重新判断视野，旧回调无效', async () => {
  const pending = [];
  const f = fixture(file => new Promise(resolve => pending.push(() => resolve('https://example.test/' + file))));
  const a = f.card([{ fileID: 'image', type: 'image' }, video('video')]);
  a.see(.8);
  await flush();
  assert.deepEqual(f.requests, []);
  a.c.imageChanged({ detail: { current: 1 } });
  await flush();
  a.enable(false);
  pending[0]();
  await flush();
  assert.equal(a.c.data.feedVideo, null);
  assert.equal(a.c.data.imageIndex, 1);
  a.enable(true);
  a.see(.8);
  await flush();
  pending[1]();
  await flush();
  assert.equal(a.c.data.feedVideo.file, 'video');
  a.hide();
  assert.equal(a.c.data.feedVideo, null);
  const oldObserver = a.observers.at(-1);
  a.show();
  oldObserver.emit({ intersectionRatio: .8 });
  await flush();
  assert.equal(pending.length, 2);
  a.see(.8);
  await flush();
  a.detach();
  const detachedState = { ...a.c.data.feedVideo };
  pending[2]();
  await flush();
  assert.equal(a.c._feedVideoTicket, null);
  assert.deepEqual({ ...a.c.data.feedVideo }, detachedState);
  assert.equal(f.card([video('detail')], false).observers.length, 0);
});

test('当前视频加载失败时恢复封面并允许下一条播放', async () => {
  const f = fixture();
  const a = f.card([video('a')]), b = f.card([video('b')]), c = f.card([video('c')]);
  a.see(.9);
  b.see(.8);
  c.see(.7);
  await flush();
  a.c.feedVideoError(a.event());
  await flush();
  assert.equal(a.c.data.feedVideo, null);
  assert.equal(b.c.data.feedVideo.file, 'b');
  b.c.feedVideoError(b.event());
  await flush();
  assert.equal(b.c.data.feedVideo, null);
  assert.equal(c.c.data.feedVideo.file, 'c');
  assert.deepEqual(f.requests, ['a', 'b', 'c']);
});

test('首页未播放时只显示封面，循环由结束事件处理，播放器隐藏播放控件', () => {
  const markup = fs.readFileSync('miniprogram/components/square-post/index.wxml', 'utf8');
  const template = markup.match(/<template name="post-video">([\s\S]*?)<\/template>/)[1];
  const player = template.match(/<video\b[\s\S]*?\/>/)[0];
  assert.match(player, /loop="{{false}}"/);
  assert.match(player, /bindended="feedVideoEnded"/);
  for (const attribute of ['controls', 'show-play-btn', 'show-center-play-btn']) {
    assert.ok(player.includes(`${attribute}="{{false}}"`));
  }
  assert.match(template, /wx:if="{{!homeFeed && \(!feedVideo \|\| feedVideo.file !== item.fileID\)}}" class="post-play-badge"/);
  const uses = markup.match(/is="post-video"[^>]+/g);
  assert.equal(uses.length, 2);
  assert.ok(uses.every(use => use.includes('homeFeed: homeFeed')));
});

test('从断点续播到结尾后跳回第0秒，片尾回调和旧播放器不能把续播点拉回结尾', async () => {
  const f = fixture();
  const a = f.card([video('a')]);
  a.see(.8);
  await flush();
  a.c.feedVideoTime(a.event({ currentTime: 6, duration: 10 }));
  a.see(0);
  a.see(.8);
  await flush();
  assert.equal(a.c.data.feedVideo.start, 6);
  const ended = a.event();
  const playerId = 'feed-video-' + a.c.data.feedVideo.token;
  a.c.feedVideoTime(a.event({ currentTime: 9.8, duration: 10 }));
  a.c.feedVideoEnded(ended);
  a.c.feedVideoEnded(ended);
  a.c.feedVideoTime(a.event({ currentTime: 10, duration: 10 }));
  assert.deepEqual(f.playback, [{ id: playerId, time: 0 }, { id: playerId, play: true }]);
  a.c.feedVideoTime(a.event({ currentTime: .3, duration: 10 }));
  a.c.feedVideoTime(a.event({ currentTime: 9.9, duration: 10 }));
  a.c.feedVideoEnded(ended);
  assert.deepEqual(f.playback.slice(2), [{ id: playerId, time: 0 }, { id: playerId, play: true }]);
  a.see(0);
  a.see(.8);
  await flush();
  assert.equal(a.c.data.feedVideo.start, 0);
  a.c.feedVideoEnded(ended);
  a.c.feedVideoTime(a.event({ currentTime: 9.2, duration: 10 }));
  a.see(0);
  a.see(.8);
  await flush();
  assert.equal(a.c.data.feedVideo.start, 0);
  assert.equal(f.playback.length, 4);
});

test('详情页在视频进入视野时原位播放，隐藏或被面板遮挡时暂停', async () => {
  const f = fixture();
  const detail = f.card([video('detail')], true, { detail: true });
  detail.see(.1);
  await flush();
  assert.deepEqual(f.requests, []);
  detail.see(.4);
  await flush();
  assert.equal(detail.c.data.feedVideo.file, 'detail');
  detail.enable(false);
  assert.equal(detail.c.data.feedVideo, null);
  assert.equal(f.paused[0].component, detail.c);
  detail.enable(true);
  detail.see(.4);
  await flush();
  assert.equal(detail.c.data.feedVideo.file, 'detail');
  detail.hide();
  assert.equal(detail.c.data.feedVideo, null);
  assert.equal(f.paused[1].component, detail.c);
});

test('官方主页可启用列表视频循环播放，切换标签后旧回调不能重启视频', async () => {
  const f = fixture();
  const profile = f.card([video('profile')], true, { homeFeed: false });
  profile.see(.8);
  await flush();
  const ended = profile.event();
  profile.c.feedVideoEnded(ended);
  assert.deepEqual(f.playback.map(event => event.time ?? event.play), [0, true]);
  profile.enable(false);
  profile.see(.8);
  profile.c.feedVideoEnded(ended);
  await flush();
  assert.equal(profile.c.data.feedVideo, null);
  assert.equal(f.playback.length, 2);
  profile.enable(true);
  profile.see(.8);
  await flush();
  assert.equal(profile.c.data.feedVideo.file, 'profile');
});

test('首页视频解析地址时开始显示加载动画，等待实际播放，旧事件不能提前露出新画面', async () => {
  const pending = [];
  const f = fixture(file => new Promise(resolve => pending.push(() => resolve('https://example.test/' + file))));
  const { c, see, event } = f.card([video('a')]);
  see(.8);
  await flush();
  assert.equal(c.data.feedVideo.ready, false);
  assert.equal(c.data.feedVideo.src, '');
  const first = event({ currentTime: .3 });
  pending[0]();
  await flush();
  assert.equal(c.data.feedVideo.ready, false);
  c.feedVideoTime(event({ currentTime: 0 }));
  assert.equal(c.data.feedVideo.ready, false);
  c.feedVideoTime(first);
  assert.equal(c.data.feedVideo.ready, true);
  see(0);
  assert.equal(c.data.feedVideo, null);
  see(.8);
  await flush();
  pending[1]();
  await flush();
  c.feedVideoTime(first);
  c.feedVideoTime(event({ currentTime: .3 }));
  assert.equal(c.data.feedVideo.ready, false);
  c.feedVideoTime(event({ currentTime: .6 }));
  assert.equal(c.data.feedVideo.ready, true);
});
