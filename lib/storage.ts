import { promises as fs } from "fs";
import path from "path";
import { config } from "./config";

// Storage interface. Local disk in MVP (free). S3-compatible later
// behind this same interface without touching callers.
export interface StorageBackend {
  save(relativePath: string, data: Buffer): Promise<void>;
  read(relativePath: string): Promise<Buffer>;
  exists(relativePath: string): Promise<boolean>;
  delete(relativePath: string): Promise<void>;
}

class LocalBackend implements StorageBackend {
  private root: string;

  constructor() {
    this.root = path.resolve(config.storage.dir);
  }

  private fullPath(relativePath: string): string {
    // Prevent path traversal: resolve and confirm it stays under root.
    const full = path.resolve(this.root, relativePath);
    if (!full.startsWith(this.root + path.sep) && full !== this.root) {
      throw new Error("Storage path escapes root");
    }
    return full;
  }

  async save(relativePath: string, data: Buffer): Promise<void> {
    const full = this.fullPath(relativePath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
  }

  async read(relativePath: string): Promise<Buffer> {
    return fs.readFile(this.fullPath(relativePath));
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await fs.access(this.fullPath(relativePath));
      return true;
    } catch {
      return false;
    }
  }

  async delete(relativePath: string): Promise<void> {
    await fs.unlink(this.fullPath(relativePath));
  }
}

function createBackend(): StorageBackend {
  switch (config.storage.backend) {
    case "local":
      return new LocalBackend();
    default:
      throw new Error(`Unknown STORAGE_BACKEND: ${config.storage.backend}`);
  }
}

export const storage: StorageBackend = createBackend();

// Path helpers. All answer-sheet and paper files live under these.
export const paths = {
  paperDir: (examId: string) => `papers/${examId}`,
  paperPage: (examId: string, n: number) => `papers/${examId}/page-${n}.png`,
  sheetDir: (examId: string, sheetId: string) => `sheets/${examId}/${sheetId}`,
  sheetPage: (examId: string, sheetId: string, pageNo: number) =>
    `sheets/${examId}/${sheetId}/page-${pageNo}.jpg`,
  sheetThumb: (examId: string, sheetId: string, pageNo: number) =>
    `thumbs/${examId}/${sheetId}/page-${pageNo}.jpg`,
};
