import type { DraftImage } from './types.js';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * A draft image needs only a unique key. `crypto.randomUUID` exists in secure
 * contexts alone, and this UI is also opened over plain HTTP on a tailnet
 * address, where attaching an image still has to work.
 */
function draftImageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function readImage(file: File): Promise<DraftImage> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG, or WebP image.');
  if (file.size > 50 * 1024 * 1024) throw new Error('The source image can be at most 50 MB.');
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    let scale = Math.min(1, Math.sqrt(16_000_000 / (bitmap.width * bitmap.height)));
    let blob: Blob = file;
    // Keep suitable PNGs untouched. JPEG/WebP conversion can grow well beyond
    // their source size; fit the encoded output to the host's PNG contract.
    if (file.type !== 'image/png' || file.size > MAX_IMAGE_BYTES || scale < 1) {
      do {
        canvas.width = Math.max(1, Math.floor(bitmap.width * scale));
        canvas.height = Math.max(1, Math.floor(bitmap.height * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('The image could not be read.');
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('The image could not be read.'))), 'image/png'),
        );
        if (blob.size <= MAX_IMAGE_BYTES) break;
        if (canvas.width === 1 && canvas.height === 1) throw new Error('The image could not be prepared.');
        scale *= Math.min(0.85, Math.sqrt(MAX_IMAGE_BYTES / blob.size) * 0.95);
      } while (blob.size > MAX_IMAGE_BYTES);
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('The image could not be read.'));
      reader.readAsDataURL(blob);
    });
    return { id: draftImageId(), name: file.name, dataUrl, base64: dataUrl.slice(dataUrl.indexOf(',') + 1), mediaType: 'image/png' };
  } finally {
    bitmap.close();
  }
}
