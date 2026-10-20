import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Garbled-lettering check for page zone crops. Small bubbles on dense pages
// are the weak spot (gala dense proof: "dowg down", "PENDING PENDING",
// "queue agin. again"). Each zone's requested text is aligned against an OCR
// word stream of its review crop. A mismatch is a review risk, never an
// automatic rejection: the reviewer either crops the text out in composition
// or rejects the zone into an exact zone repair.
export const LETTERING_OCR = Object.freeze({ engine: 'tesseract', psm: 11, min_conf: 30, solid_conf: 60, anchor_similarity: 0.75, end_similarity: 0.6, keep_similarity: 0.6, echo_similarity: 0.6, max_gap_lines: 3, max_text_lines: 4, max_extra_words: 4 });

const norm = word => String(word).toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9']/g, '');
function similarity(a, b) {
  if (!a || !b) return 0;
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const keep = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = keep; }
  }
  return 1 - d[b.length] / Math.max(a.length, b.length);
}

/** Words from `tesseract <image> - --psm 11 tsv`, in reading order, with confidence and box. */
export async function tesseractWords(imagePath, { exec = promisify(execFile) } = {}) {
  const { stdout } = await exec('tesseract', [imagePath, '-', '--psm', String(LETTERING_OCR.psm), 'tsv'], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.split('\n').slice(1).map(line => line.split('\t')).filter(cols => cols.length >= 12 && cols[11].trim())
    .map(cols => ({ text: cols[11].trim(), conf: Number(cols[10]), box: { left: Number(cols[6]), top: Number(cols[7]), width: Number(cols[8]), height: Number(cols[9]) } }));
}

/** Compare each requested string with what the crop actually reads. */
export function letteringFindings({ requested, words }) {
  // Re-join fragments OCR split inside one word ("R" + "AINK"): same line, touching
  // boxes, or a lone letter within about a word space of its neighbour.
  const merged = [];
  for (const word of words) {
    const last = merged.at(-1), a = last?.box, b = word.box;
    const h = Math.max(a?.height ?? 0, b?.height ?? 0), gap = a && b ? b.left - (a.left + a.width) : NaN;
    const lone = /^[A-Za-z]$/.test(last?.text ?? '') || /^[A-Za-z]$/.test(word.text);
    const sameLine = a && b && [a.left, a.width, b.left, gap].every(Number.isFinite) && Math.abs(a.top - b.top) <= 0.3 * h;
    if (sameLine && gap >= -2 && gap <= (lone ? 0.6 : 0.2) * h) merged[merged.length - 1] = { text: last.text + word.text, conf: Math.max(last.conf, word.conf), box: { left: a.left, top: Math.min(a.top, b.top), width: b.left + b.width - a.left, height: h } };
    else merged.push(word);
  }
  const all = merged.map(word => ({ ...word, norm: norm(word.text) })).filter(word => word.norm);
  const findings = [];
  // Single letters ("I", "a") are unreliable in OCR, so neither side counts them.
  const real = value => /[a-z]{2,}|\d/.test(value);
  for (const text of requested ?? []) {
    const want = text.split(/\s+/).map(norm).filter(real);
    if (!want.length) continue;
    // Tesseract often scores a doubled word near zero; a near-exact echo of a requested word is kept at any confidence.
    const stream = all.filter(word => word.conf >= LETTERING_OCR.min_conf || (word.conf > 0 && want.some(w => similarity(word.norm, w) >= LETTERING_OCR.echo_similarity)));
    let best = null;
    for (let i = 0; i < stream.length; i++) {
      if (similarity(stream[i].norm, want[0]) < LETTERING_OCR.anchor_similarity) continue;
      // Farthest end anchor within reach, so a doubled last word is included.
      const start = stream[i].box, h = Math.max(start.height, 1), width = text.length * 0.6 * h + 2 * h;
      const reachable = ({ box }) => box.top >= start.top - h && box.top <= start.top + LETTERING_OCR.max_text_lines * h * 1.5 && box.left >= start.left - width && box.left <= start.left + width;
      for (let j = Math.min(stream.length - 1, i + want.length - 1 + LETTERING_OCR.max_extra_words); j >= i; j--) {
        if (similarity(stream[j].norm, want.at(-1)) >= LETTERING_OCR.end_similarity && (j === i || reachable(stream[j]))) { best ??= { i, j }; break; }
      }
      if (best) break;
    }
    if (!best) { findings.push({ code: 'zone_lettering_unread', requested: text, read: null, message: `Requested lettering "${text}" was not found in the zone crop (missing, illegible or stylized).` }); continue; }
    // Real words only: drop low-confidence art noise and single characters.
    // A low-confidence word that echoes a requested word is kept: doubled words are the typical garble.
    // Art noise elsewhere in the panel is not part of the bubble: keep words near the anchored text.
    const anchors = [stream[best.i].box, stream[best.j].box], line = Math.max(...anchors.map(b => b.height), 1) * LETTERING_OCR.max_gap_lines;
    const area = { left: Math.min(...anchors.map(b => b.left)) - line, top: Math.min(...anchors.map(b => b.top)) - line, right: Math.max(...anchors.map(b => b.left + b.width)) + line, bottom: Math.max(...anchors.map(b => b.top + b.height)) + line };
    const near = ({ box }) => !box || [box.left, box.top, box.width, box.height].some(v => !Number.isFinite(v)) || (box.left + box.width >= area.left && box.left <= area.right && box.top + box.height >= area.top && box.top <= area.bottom);
    const window = stream.slice(best.i, best.j + 1).filter(word => real(word.norm) && near(word) && (word.conf >= LETTERING_OCR.solid_conf || want.some(w => similarity(word.norm, w) >= LETTERING_OCR.keep_similarity)));
    // Garbled means an EXTRA word that echoes a requested one ("dowrg down", "PENDING PENDING",
    // "agian aaain"). A same-count substitution ("el:" for "else") is usually an OCR misread.
    const read = window.map(word => word.norm);
    const echoed = want.some(w => read.filter(value => similarity(value, w) >= LETTERING_OCR.keep_similarity).length >= 2);
    if (read.length <= want.length || !echoed) continue;
    const boxes = window.map(word => word.box);
    const box = boxes.length ? { left: Math.min(...boxes.map(b => b.left)), top: Math.min(...boxes.map(b => b.top)), right: Math.max(...boxes.map(b => b.left + b.width)), bottom: Math.max(...boxes.map(b => b.top + b.height)) } : null;
    findings.push({ code: 'zone_lettering_garbled', requested: text, read: window.map(word => word.text).join(' '), box_px: box, message: `Zone lettering reads "${window.map(word => word.text).join(' ')}" where "${text}" was requested; crop it out in composition or reject the zone for repair.` });
  }
  return findings;
}
