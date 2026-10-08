// Pure geometry shared by the review player and deterministic video exporter.
// Times are absolute seconds. Repeated keys intentionally preserve reading holds.
export function samplePanelKeyframes(keys, time) {
  if (time <= keys[0].at_sec) return keys[0];
  if (time >= keys.at(-1).at_sec) return keys.at(-1);
  const nextIndex = keys.findIndex((key) => key.at_sec > time);
  const a = keys[nextIndex - 1];
  const b = keys[nextIndex];
  let p = (time - a.at_sec) / (b.at_sec - a.at_sec);
  if (a.easing === 'hold') p = 0;
  else if (a.easing === 'smooth') p = p * p * (3 - 2 * p);
  const mix = (x, y) => x + (y - x) * p;
  return {
    at_sec: time,
    rect: Object.fromEntries(['x', 'y', 'width', 'height'].map((k) => [k, mix(a.rect[k], b.rect[k])])),
    camera: Object.fromEntries(['x', 'y', 'zoom'].map((k) => [k, mix(a.camera[k], b.camera[k])])),
    opacity: mix(a.opacity, b.opacity),
  };
}

export function panelFrameState(timeline, time) {
  const scene = timeline.scenes.find((s) => time >= s.start_sec && time < s.end_sec);
  if (!scene) return { scene: null, layers: [] };
  return {
    scene,
    layers: scene.layers.filter((l) => time >= l.start_sec && time < l.end_sec)
      .sort((a, b) => a.z - b.z)
      .map((layer) => ({ ...layer, state: samplePanelKeyframes(layer.keyframes, time) })),
  };
}

// The source crop and destination viewport are independent. Camera x/y traverse
// the available overflow: a tall page can scroll from its top (0) to bottom (1).
export function panelImagePlacement(sourceWidth, sourceHeight, rect, camera, fit) {
  const base = fit === 'contain'
    ? Math.min(rect.width / sourceWidth, rect.height / sourceHeight)
    : Math.max(rect.width / sourceWidth, rect.height / sourceHeight);
  const width = sourceWidth * base * camera.zoom;
  const height = sourceHeight * base * camera.zoom;
  return {
    x: rect.x + (width > rect.width ? (rect.width - width) * camera.x : (rect.width - width) / 2),
    y: rect.y + (height > rect.height ? (rect.height - height) * camera.y : (rect.height - height) / 2),
    width,
    height,
  };
}
