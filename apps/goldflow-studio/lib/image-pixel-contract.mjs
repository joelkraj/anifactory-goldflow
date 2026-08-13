import sharp from "sharp";

export async function normalizedImagePixels(input, { width = 256, height = 144 } = {}) {
  return sharp(input, { failOn: "error" })
    .flatten({ background: "#ffffff" })
    .resize(width, height, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer();
}

export function meanAbsolutePixelDifference(left, right) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right) || left.length !== right.length) {
    throw new Error("Normalized image buffers must have equal lengths.");
  }
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += Math.abs(left[index] - right[index]);
  return total / left.length;
}

export async function findReferenceEcho(candidate, references = [], { threshold = 1 } = {}) {
  if (!references.length) return null;
  const candidatePixels = await normalizedImagePixels(candidate);
  let closest = null;
  for (const reference of references) {
    const referencePixels = reference.normalized_pixels ?? await normalizedImagePixels(reference.input ?? reference.path ?? reference.buffer);
    const meanAbsoluteDifference = meanAbsolutePixelDifference(candidatePixels, referencePixels);
    if (!closest || meanAbsoluteDifference < closest.mean_absolute_difference) {
      closest = {
        ref_id: reference.ref_id ?? null,
        slot: reference.slot ?? null,
        path: reference.path ?? null,
        mean_absolute_difference: meanAbsoluteDifference,
      };
    }
  }
  return closest && closest.mean_absolute_difference <= threshold ? closest : null;
}
