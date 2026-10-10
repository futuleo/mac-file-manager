import { useEffect, useRef, useState } from "react";
import type { EntryKind } from "./backend/contracts";
import { FileGlyph, FolderGlyph } from "./glyphs";
import { cachedIcon, requestIcon } from "./iconQueue";

/**
 * An original placeholder glyph, replaced by the real system icon once the row is
 * (nearly) visible and a bounded-concurrency lookup completes.
 */
export default function FileIcon({ id, kind, size = 16 }: { id: string; kind: EntryKind; size?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string | null>(cachedIcon(id, size * 2));

  useEffect(() => {
    setSrc(cachedIcon(id, size * 2));
    let cancel = () => {};
    let observer: IntersectionObserver | null = null;
    const start = () => {
      cancel = requestIcon(id, size * 2, setSrc);
    };
    const node = ref.current;
    if (cachedIcon(id, size * 2)) return;
    if (!node || typeof IntersectionObserver === "undefined") {
      start();
    } else {
      observer = new IntersectionObserver((hits) => {
        if (hits.some((h) => h.isIntersecting)) {
          observer?.disconnect();
          start();
        }
      });
      observer.observe(node);
    }
    return () => {
      observer?.disconnect();
      cancel();
    };
  }, [id, size]);

  return (
    <span ref={ref} className="icon" style={{ width: size, height: size }} aria-hidden="true">
      {src ? (
        <img src={src} width={size} height={size} alt="" draggable={false} />
      ) : kind === "directory" ? (
        <FolderGlyph size={size} />
      ) : (
        <FileGlyph size={size} />
      )}
    </span>
  );
}
