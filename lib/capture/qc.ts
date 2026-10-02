import sharp from "sharp";
import { createHash } from "crypto";
import { config } from "./config";

// Image quality checks for the capture workspace.
// Never silently discards: returns flags the faculty sees and decides on.

export interface QcResult {
  flags: string[];
  blurScore: number;
  width: number;
  height: number;
  sha256: string;
}

// Laplacian variance on a downscaled grayscale image. Lower = blurrier.
// Threshold is deliberately conservative: it flags only clearly blurred shots.
export async function blurVariance(input: Buffer): Promise<number> {
  const { data, info } = await sharp(input)
    .resize({ width: 320, withoutEnlargement: true })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap =
        -4 * data[i] + data[i - 1] + data[i + 1] + data[i - w] + data[i + w];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

export async function checkPageImage(input: Buffer): Promise<QcResult> {
  const meta = await sharp(input).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width > 8000 || height > 8000) {
    throw new Error(`Image dimensions ${width}x${height} exceed safety caps`);
  }
  const flags: string[] = [];
  if (width < 600 || height < 600) flags.push("low-resolution");
  // Heuristic: very small JPEG of a page is likely blank or out of frame.
  if (input.length < 30 * 1024) flags.push("possibly-blank");

  let blurScore = 0;
  try {
    blurScore = await blurVariance(input);
    if (blurScore < config.capture.blurThreshold) flags.push("blur");
  } catch {
    flags.push("qc-failed");
  }

  const sha256 = createHash("sha256").update(input).digest("hex");
  return { flags, blurScore: Math.round(blurScore), width, height, sha256 };
}
