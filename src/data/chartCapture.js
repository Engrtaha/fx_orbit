// Registry letting the News page grab a screenshot of the live PriceChart.
// `fn` is active while the chart is mounted; `last` caches the final capture
// so the News page can still offer it after the chart has unmounted.
export const chartCapture = { fn: null, last: null };
