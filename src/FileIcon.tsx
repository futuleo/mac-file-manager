import { useEffect, useRef, useState } from "react";
import type { EntryKind } from "./backend/contracts";
import { FileGlyph, FolderGlyph } from "./glyphs";
import { cachedIcon, requestIcon } from "./iconQueue";

/**
 * Folders always render the original yellow FolderGlyph (Windows 10 baseline); the native
 * (blue) system folder icon is never requested, cached or shown. Files show an original
 * placeholder glyph, replaced by the real system icon once the row is (nearly) visible and
 * a bounded-concurrency lookup completes.
 */
export default function FileIcon({ id, kind, size = 16 }: { id: string; kind: EntryKind; size?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const isFolder = kind === "directory";
  const [src, setSrc] = useState<string | null>(isFolder ? null : cachedIcon(id, size * 2));

  useEffect(() => {
    if (isFolder) {
      setSrc(null);
      return;
    }
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
  }, [id, size, isFolder]);

  return (
    <span ref={ref} className="icon" style={{ width: size, height: size }} aria-hidden="true">
      {isFolder ? (
        <FolderGlyph size={size} />
      ) : src ? (
        <img src={src} width={size} height={size} alt="" draggable={false} />
      ) : (
        <FileGlyph size={size} />
      )}
    </span>
  );
}
