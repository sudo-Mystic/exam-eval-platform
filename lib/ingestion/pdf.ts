import { execFile } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import sharp from "sharp";
import { config } from "../config";
import { storage } from "../storage";

const execFileAsync = promisify(execFile);

export const MAX_PDF_PAGES = 50;
const RENDER_DPI = 150;

// Render a PDF to PNG page images using poppler (non-executing: pdftoppm
// never honors embedded JS or launch actions). Caps page count before
// rasterizing to blunt decompression bombs.
export async function pdfPageCount(pdfPath: string): Promise<number> {
  const { stdout } = await execFileAsync("pdfinfo", [pdfPath]);
  const m = stdout.match(/Pages:\s+(\d+)/);
  if (!m) throw new Error("Could not read PDF page count");
  return parseInt(m[1], 10);
}

export async function rasterizePdf(
  pdfBuffer: Buffer,
  onPage: (pageNo: number, png: Buffer) => Promise<void>
): Promise<number> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "exam-eval-pdf-"));
  try {
    const pdfPath = path.join(tmp, "input.pdf");
    await fs.writeFile(pdfPath, pdfBuffer);

    const pages = await pdfPageCount(pdfPath);
    if (pages > MAX_PDF_PAGES) {
      throw new Error(`PDF has ${pages} pages; max ${MAX_PDF_PAGES} supported`);
    }
    if (pages === 0) throw new Error("PDF has no pages");

    const outPrefix = path.join(tmp, "page");
    await execFileAsync("pdftoppm", [
      "-png",
      "-r",
      String(RENDER_DPI),
      "-f",
      "1",
      "-l",
      String(pages),
      pdfPath,
      outPrefix,
    ]);

    for (let n = 1; n <= pages; n++) {
      const name = `page-${String(n).padStart(2, "0")}.png`;
      const png = await fs.readFile(path.join(tmp, name));
      await onPage(n, png);
    }
    return pages;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// Downscale to a readable-but-compact width and cap dimensions against
// image decode bombs.
export async function normalizePageImage(input: Buffer): Promise<Buffer> {
  const meta = await sharp(input).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w > 8000 || h > 8000) {
    throw new Error(`Image dimensions ${w}x${h} exceed safety caps`);
  }
  const target = Math.min(w, config.capture.maxImageWidth);
  return sharp(input)
    .resize({ width: target, withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
}

export async function makeThumbnail(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .resize({ width: config.capture.thumbWidth, withoutEnlargement: true })
    .jpeg({ quality: 70 })
    .toBuffer();
}

// Store a normalized paper page and return its storage path.
export async function storePaperPage(
  examId: string,
  pageNo: number,
  png: Buffer
): Promise<string> {
  const normalized = await normalizePageImage(png);
  const jpgRel = `papers/${examId}/page-${pageNo}.jpg`;
  await storage.save(jpgRel, normalized);
  return jpgRel;
}
