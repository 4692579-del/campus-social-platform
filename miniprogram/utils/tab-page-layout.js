const DEFAULT_LAYOUT = { navTop: 28, navButtonHeight: 32, navHeight: 72 };

function readTabLayout(api) {
  try {
    const info = api.getWindowInfo();
    const capsule = api.getMenuButtonBoundingClientRect();
    const status = info.statusBarHeight || 0;
    const valid = capsule && capsule.height > 0 && capsule.top >= status;
    const navTop = valid ? capsule.top : status + 8;
    const navButtonHeight = valid ? capsule.height : 32;
    return { navTop, navButtonHeight, navHeight: navTop + navButtonHeight + 8,
      windowWidth: info.windowWidth || info.screenWidth || 375 };
  } catch (error) { return { ...DEFAULT_LAYOUT, windowWidth: 375 }; }
}

// 仅发送真正变化的轻量页面/底栏状态；不用于动态、输入或图片源。
function patchState(target, values) {
  const data = target.data || {};
  const changed = Object.fromEntries(Object.entries(values).filter(([key, value]) => data[key] !== value));
  if (Object.keys(changed).length) target.setData(changed);
}

module.exports = { DEFAULT_LAYOUT, readTabLayout, patchState };
