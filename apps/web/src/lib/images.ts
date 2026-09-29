/**
 * Zdjęcie do czatu: zmniejszenie w przeglądarce (dłuższy bok najwyżej 1600 px, JPEG) — mniej danych przez
 * sieć i tańsza analiza przez model; orientacja z EXIF uwzględniona (createImageBitmap). Podgląd jako data:
 * (CSP aplikacji nie pozwala na adresy blob: w obrazkach).
 */
export const MAX_EDGE = 1600;

export interface PreparedImage {
  blob: Blob;
  preview: string;
}

async function decode(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* format nieobsługiwany przez createImageBitmap — niżej przez <img> */
    }
  }
  const url = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('read'));
    r.readAsDataURL(file);
  });
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

/** Rozmiar po zmniejszeniu (proporcje zachowane, bez powiększania). */
export function fitSize(w: number, h: number, max = MAX_EDGE): { w: number; h: number } {
  const scale = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  const src = await decode(file);
  const { w, h } = fitSize(src.width, src.height);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  ctx.drawImage(src, 0, 0, w, h);
  if ('close' in src) src.close();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', 0.85),
  );
  // Mała miniatura do podglądu przed wysłaniem.
  const t = fitSize(w, h, 240);
  const thumb = document.createElement('canvas');
  thumb.width = t.w;
  thumb.height = t.h;
  thumb.getContext('2d')?.drawImage(canvas, 0, 0, t.w, t.h);
  return { blob, preview: thumb.toDataURL('image/jpeg', 0.8) };
}
