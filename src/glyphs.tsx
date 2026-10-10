import type { ReactNode } from "react";

/** Original, simple line-and-fill glyphs (no third-party or Microsoft artwork). */
interface GlyphProps {
  size?: number;
}

function Svg({ size = 16, children, viewBox = "0 0 16 16" }: GlyphProps & { children: ReactNode; viewBox?: string }) {
  return (
    <svg width={size} height={size} viewBox={viewBox} fill="none" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const FolderGlyph = (p: GlyphProps) => (
  <Svg {...p}>
    <path d="M1.5 3.5h4.2l1.3 1.5h7.5v7.5h-13z" fill="#e8b92d" />
    <path d="M1.5 6h13v6.5h-13z" fill="#f7d55f" />
  </Svg>
);

export const FileGlyph = (p: GlyphProps) => (
  <Svg {...p}>
    <path d="M3.5 1.5h6l3 3v10h-9z" fill="#fff" stroke="#8a8f94" />
    <path d="M9.5 1.5v3h3" stroke="#8a8f94" />
  </Svg>
);

export const ComputerGlyph = (p: GlyphProps) => (
  <Svg {...p}>
    <rect x="2" y="3" width="12" height="8" rx="1" fill="#dbe9f7" stroke="#4d7fb3" />
    <path d="M5 13.5h6" stroke="#4d7fb3" />
  </Svg>
);

const stroke = { stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const BackGlyph = (p: GlyphProps) => (
  <Svg {...p}>
    <path d="M13 8H3.5M7.5 4 3.5 8l4 4" {...stroke} />
  </Svg>
);
export const ForwardGlyph = (p: GlyphProps) => (
  <Svg {...p}>
    <path d="M3 8h9.5M8.5 4l4 4-4 4" {...stroke} />
  </Svg>
);
export const UpGlyph = (p: GlyphProps) => (
  <Svg {...p}>
    <path d="M8 13V3.5M4 7.5l4-4 4 4" {...stroke} />
  </Svg>
);
export const RefreshGlyph = (p: GlyphProps) => (
  <Svg {...p}>
    <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" {...stroke} />
  </Svg>
);
export const CloseGlyph = (p: GlyphProps) => (
  <Svg {...p}>
    <path d="m4 4 8 8M12 4l-8 8" {...stroke} />
  </Svg>
);
export const PlusGlyph = (p: GlyphProps) => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" {...stroke} />
  </Svg>
);
export const ChevronGlyph = (p: GlyphProps) => (
  <Svg {...p}>
    <path d="m6 3.5 4.5 4.5L6 12.5" {...stroke} />
  </Svg>
);
export const SortGlyph = ({ direction, size = 8 }: GlyphProps & { direction: "asc" | "desc" }) => (
  <Svg size={size} viewBox="0 0 8 8">
    <path d={direction === "asc" ? "M1 5.5 4 2.5l3 3" : "M1 2.5 4 5.5l3-3"} {...stroke} strokeWidth={1.1} />
  </Svg>
);
export const WarnGlyph = (p: GlyphProps) => (
  <Svg {...p}>
    <path d="M8 1.8 14.8 14H1.2z" fill="#fce100" stroke="#8a6d00" strokeLinejoin="round" />
    <path d="M8 6v4M8 11.5v.5" stroke="#3b3000" strokeWidth={1.3} strokeLinecap="round" />
  </Svg>
);
