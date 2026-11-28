const { glassStyle, readTransparency } = require('./dock-transparency');

const CLOSE_DURATION = 200;

function popoverLayout(api, anchor, rows, { windowWidth = 375, safeTop = 0, alignRight = false, origin, placement } = {}) {
  let windowHeight = 667;
  try {
    const info = api.getWindowInfo();
    windowWidth = info.windowWidth || windowWidth;
    windowHeight = info.windowHeight || windowHeight;
    safeTop = Math.max(safeTop, info.statusBarHeight || 0);
  } catch (error) { /* Older clients use the page measurements. */ }
  const scale = windowWidth / 750;
  const width = Math.min(windowWidth - 24, placement?.width ?? 286 * scale * (placement?.widthScale ?? 1));
  const height = (18 + rows * 72) * scale;
  const anchorWidth = anchor.width || width / 4;
  const anchorTop = Number.isFinite(anchor.top) ? anchor.top : anchor.bottom;
  const anchorHeight = anchor.bottom - anchorTop || anchorWidth;
  const diameter = Math.min(anchorWidth, anchorHeight);
  const centerX = anchor.left + anchorWidth / 2;
  const centerY = anchorTop + anchorHeight / 2;
  const edgeOffset = origin === 'avatar' ? diameter * Math.SQRT1_2 / 2 : 0;
  const alignedLeft = Number.isFinite(placement?.right) ? placement.right - width :
    Number.isFinite(placement?.center) ? placement.center - width / 2 :
    alignRight ? anchor.left + anchorWidth - width : anchor.left;
  const left = Math.max(12, Math.min(alignedLeft, windowWidth - width - 12));
  const below = (placement?.bottom ?? anchor.bottom) + 6, above = anchorTop - height - 6;
  const preferAbove = below + height > windowHeight - 12 && above >= safeTop;
  const top = placement ? below : Math.max(safeTop, Math.min(preferAbove ? above : below, windowHeight - height - 12));
  const originX = (placement?.centerX ?? centerX + edgeOffset) - left;
  const originY = (placement?.originY ?? placement?.bottom ?? centerY + edgeOffset) - top;
  const startScaleX = diameter * .44 / width;
  const startScaleY = diameter * .44 / height;
  const startShiftX = (originX - width / 2) * startScaleX;
  const startShiftY = (originY - height / 2) * startScaleY;
  return { width, height, left, top, originX, originY, startScaleX, startScaleY, startShiftX, startShiftY, glassStyle: glassStyle(readTransparency(api)) };
}

module.exports = { CLOSE_DURATION, popoverLayout };
