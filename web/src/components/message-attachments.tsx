import type { Entry } from '../types.js';

export function MessageAttachments({ entry, sessionId }: { entry: Entry; sessionId: string }) {
  const images = entry.attachments?.filter((file) => file.mediaType.startsWith('image/')) ?? [];
  if (!images.length)
    return entry.imageCount ? <span className="message-attachments">The preview for this older image is not available.</span> : null;
  return (
    <div className="message-images">
      {images.map((image) => {
        const url = `/api/attachment?${new URLSearchParams({ sessionId, id: image.id })}`;
        return (
          <a key={image.id} href={url} target="_blank" rel="noreferrer" title={`Open ${image.name}`}>
            <img src={url} alt={image.name} loading="lazy" />
          </a>
        );
      })}
    </div>
  );
}
