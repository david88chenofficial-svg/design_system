import { createHash } from "node:crypto";
import type { ReferenceImage } from "./types";

export const REFERENCE_IMAGES_DIRECTORY = "Reference Images";

const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif"
};

export function prepareReferenceImage(image: ReferenceImage): {
  image: ReferenceImage;
  data: ArrayBuffer;
} {
  const data = decodeReferenceImageData(image);
  const hash = createHash("sha256").update(new Uint8Array(data)).digest("hex");
  const extension = EXTENSION_BY_MIME_TYPE[image.mimeType];
  if (!extension) throw new Error(`Unsupported reference image type: ${image.mimeType}`);
  const stem = safeImageStem(image.name);
  return {
    image: {
      ...image,
      projectRelativePath: `${REFERENCE_IMAGES_DIRECTORY}/${stem}-${hash.slice(0, 12)}.${extension}`
    },
    data
  };
}

export function referenceImagePromptLabel(image: ReferenceImage): string {
  return image.projectRelativePath
    ? `REFERENCE IMAGE: ${image.name}\nPROJECT-RELATIVE ASSET PATH: ${image.projectRelativePath}`
    : `REFERENCE IMAGE: ${image.name}`;
}

function decodeReferenceImageData(image: ReferenceImage): ArrayBuffer {
  const match = /^data:([^;,]+);base64,([a-zA-Z0-9+/=\r\n]+)$/.exec(image.dataUrl);
  if (!match || match[1].toLowerCase() !== image.mimeType.toLowerCase()) {
    throw new Error(`Reference image data does not match its declared type: ${image.name}`);
  }
  const decoded = Buffer.from(match[2], "base64");
  return Uint8Array.from(decoded).buffer;
}

function safeImageStem(name: string): string {
  const withoutExtension = name.replace(/\.[^.]+$/, "");
  const normalized = withoutExtension
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || "reference-image";
}
