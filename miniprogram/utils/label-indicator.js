function labelIndicator(page, index, previous, count, fallbackWidth, offset = 0) {
  const label = page._indicatorLabels?.[index];
  const halfWidth = label ? `${label.width / 2}px + 8rpx` : `${fallbackWidth / 2 + 8}rpx`;
  const center = label ? `${label.center}px` : `${(index + .5) * 100 / count}% ${offset < 0 ? '-' : '+'} ${Math.abs(offset)}rpx`;
  return {
    labelIndicatorStyle: `left:calc((${center}) - (${halfWidth}));right:calc(100% - (${center}) - (${halfWidth}));`,
    ...(index === previous ? {} : { labelIndicatorDirection: index > previous ? 'right' : 'left' }),
  };
}

function measureIndicator(page, api, tabs, parts, index, state) {
  if (typeof page.createSelectorQuery !== 'function') return;
  const version = page._indicatorMeasure = (page._indicatorMeasure || 0) + 1;
  const current = () => !page._unloaded && page._visible !== false && version === page._indicatorMeasure;
  const measure = () => {
    if (!current()) return;
    const query = page.createSelectorQuery();
    query.select(tabs).boundingClientRect();
    for (const part of parts) query.select(part).boundingClientRect();
    query.exec(([bar, ...bounds] = []) => {
      const visible = bounds.filter(box => box?.width > 0);
      if (!current() || !bar?.width || !visible.length) return;
      const left = Math.min(...visible.map(box => box.left));
      const right = Math.max(...visible.map(box => box.left + box.width));
      page._indicatorLabels ||= [];
      page._indicatorLabels[index] = { center: (left + right) / 2 - bar.left, width: right - left };
      const patch = state();
      if (page.data.labelIndicatorStyle !== patch.labelIndicatorStyle) page.setData(patch);
    });
  };
  if (typeof api.nextTick === 'function') api.nextTick(measure);
  else measure();
}

module.exports = { labelIndicator, measureIndicator };
