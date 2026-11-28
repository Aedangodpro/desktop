const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

/**
 * Base64 characters kept in localStorage. The persisted store also holds the
 * palettes, so stay well inside the usual 5 MB origin quota.
 */
const MAX_STORED_LENGTH = 1_600_000;

const MAX_NAME_LENGTH = 40;

/** Preferred first: a crisp backdrop for large windows, then fallbacks. */
const ENCODINGS: readonly (readonly [number, number])[] = [
  [1600, 0.82],
  [1120, 0.72],
  [800, 0.62],
];

export type WallpaperUploadErrorCode = "type" | "size" | "storage" | "failed";

export class WallpaperUploadError extends Error {
  readonly code: WallpaperUploadErrorCode;

  constructor(code: WallpaperUploadErrorCode) {
    super(code);
    this.name = "WallpaperUploadError";
    this.code = code;
  }
}

/** `Sunset over Kyoto.final.png` -> `Sunset over Kyoto.final` */
export function wallpaperNameFromFile(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "").trim();
  return base.slice(0, MAX_NAME_LENGTH);
}

/** Keep the aspect ratio while fitting inside a square of `maxEdge` pixels. */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function decodeImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new WallpaperUploadError("failed"));
    image.src = src;
  });
}

function encodeJpeg(
  image: HTMLImageElement,
  maxEdge: number,
  quality: number,
): string {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const { width, height } = fitWithin(sourceWidth, sourceHeight, maxEdge);
  if (!width || !height) throw new WallpaperUploadError("failed");

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new WallpaperUploadError("failed");

  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", quality);
}

/**
 * Read a file the user picked, re-encode it at a sensible size and return the
 * data URL. The data URL is what gets stored, so the wallpaper survives a
 * reload and can be sampled for its palette without tainting the canvas the
 * way a `file://` image does in Electron.
 */
export async function readWallpaperFile(
  file: File,
): Promise<{ dataUrl: string; name: string }> {
  if (file.type && !file.type.startsWith("image/")) {
    throw new WallpaperUploadError("type");
  }
  if (file.size > MAX_SOURCE_BYTES) throw new WallpaperUploadError("size");

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await decodeImage(objectUrl);
    const name = wallpaperNameFromFile(file.name);

    for (const [maxEdge, quality] of ENCODINGS) {
      let dataUrl: string;
      try {
        dataUrl = encodeJpeg(image, maxEdge, quality);
      } catch (error) {
        if (error instanceof WallpaperUploadError) throw error;
        // A tainted canvas throws here (SVG with remote references, for one).
        throw new WallpaperUploadError("failed");
      }
      if (dataUrl.length <= MAX_STORED_LENGTH) return { dataUrl, name };
    }
    throw new WallpaperUploadError("size");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * A failed localStorage write is silent inside the persisted store, so check
 * first with a short-lived probe. If this passes the real save will fit too.
 */
export function canPersistWallpaper(dataUrl: string): boolean {
  if (typeof localStorage === "undefined") return false;
  const probeKey = "liner_wallpaper_probe";
  try {
    localStorage.setItem(probeKey, dataUrl);
    localStorage.removeItem(probeKey);
    return true;
  } catch {
    try {
      localStorage.removeItem(probeKey);
    } catch {
      // nothing left to clean up
    }
    return false;
  }
}
