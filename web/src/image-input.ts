import type { DraftImage } from './types.js';
export async function readImage(file: File): Promise<DraftImage> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('PNG, JPEG veya WebP görsel seçin.');
  if (file.size > 5 * 1024 * 1024) throw new Error('Her görsel en fazla 5 MB olabilir.');
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 16_000_000) throw new Error('Görsel en fazla 16 megapiksel olabilir.');
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Görsel okunamadı.');
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('Görsel okunamadı.'))), 'image/png'),
    );
    if (blob.size > 5 * 1024 * 1024) throw new Error('Dönüştürülen görsel 5 MB sınırını aşıyor.');
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Görsel okunamadı.'));
      reader.readAsDataURL(blob);
    });
    return { id: crypto.randomUUID(), name: file.name, dataUrl, base64: dataUrl.slice(dataUrl.indexOf(',') + 1), mediaType: 'image/png' };
  } finally {
    bitmap.close();
  }
}
