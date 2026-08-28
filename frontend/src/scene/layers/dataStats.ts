// Shared by DepthSliceLayer and VolumeLayer: the color range (u_clim) must reflect what's
// actually IN the fetched data, not the dataset's global theoretical valid_min/valid_max. A
// small searched region's real variance (a couple degrees of SST, say) is a sliver of the full
// dataset range (e.g. 1-32degC for the whole HYCOM grid) — mapped through that full range, the
// colormap compresses to a near-invisible band and the slice/volume reads as flat, uncolored.
// Auto-contrast-stretching to the fetched data's own range is what makes the gradient visible.
export function computeDataRange(
  data: Float32Array,
  missingValue: number,
  fallbackMin: number,
  fallbackMax: number,
): [number, number] {
  let min = Infinity
  let max = -Infinity
  const missingTolerance = Math.abs(missingValue) * 0.01

  for (let i = 0; i < data.length; i++) {
    const v = data[i]
    if (!isFinite(v) || Math.abs(v - missingValue) < missingTolerance) continue
    if (v < min) min = v
    if (v > max) max = v
  }

  if (!isFinite(min) || !isFinite(max) || min === max) {
    return [fallbackMin, fallbackMax]
  }
  return [min, max]
}
