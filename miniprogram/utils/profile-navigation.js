const clamp = value => Math.max(0, Math.min(1, value));
const smooth = value => { const t = clamp(value); return t * t * (3 - 2 * t); };

function navigationLayout(info = {}, capsule) {
  const width = info.windowWidth || info.screenWidth || 375;
  const status = info.statusBarHeight || 0;
  const valid = capsule && capsule.height > 0 && capsule.top >= status;
  const navTop = valid ? capsule.top : status + 8;
  const navButtonHeight = valid ? capsule.height : 32;
  const navHeight = navTop + navButtonHeight + 8;
  const capsuleLeft = valid && Number.isFinite(capsule.left) ? capsule.left : width - 96;
  const searchLeft = 24 * width / 750 + navButtonHeight + 24;
  const navTitleInset = Math.max(searchLeft + navButtonHeight + 16, width - capsuleLeft + 8);
  // 同一张静止封面预留最大下拉距离，白色区域移开时无需移动或拉伸图片。
  return { navTop, navButtonHeight, navHeight, searchLeft, navTitleInset,
    coverHeight: navHeight + 260 * width / 750, coverArtHeight: navHeight + 356 * width / 750,
    pullMax: 96 * width / 750, pullThreshold: 60 * width / 750 };
}
function defaultGeometry(layout, width = 375) {
  const headingTop = layout.coverHeight + 131 * width / 750;
  return { coverHeight: layout.coverHeight, headingTop, headingBottom: headingTop + 58 * width / 750 };
}
function navigationState(scrollTop, navHeight, geometry) {
  const top = Math.max(0, Number(scrollTop) || 0);
  const travel = Math.max(1, geometry.coverHeight - navHeight);
  const blur = smooth(top / travel);
  const titleHeight = Math.max(1, geometry.headingBottom - geometry.headingTop);
  const start = Math.max(0, geometry.headingTop - navHeight - titleHeight * .25);
  const end = Math.max(start + 1, geometry.headingBottom - navHeight);
  return { navCoverOffset: Math.round(Math.min(top, Math.max(0, travel - 20))),
    navBlurOpacity: Math.round(blur * 100) / 100,
    navShadeOpacity: Math.round(blur * 68) / 100,
    navTitleOpacity: Math.round(smooth((top - start) / (end - start)) * 100) / 100 };
}
function pullState(distance, max, threshold) {
  const offset = Math.round(Math.min(max, Math.max(0, distance) * .42));
  return { profilePullOffset: offset, pullOpacity: Math.min(1, offset / 16) };
}
module.exports = { navigationLayout, defaultGeometry, navigationState, pullState };
