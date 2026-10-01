/* The product mark: the configured same-origin logo, else a monogram tile in the upstream workspace-menu style
 * (ink tile, surface letter). Decorative: the product name always sits beside it. */
export function BrandMark({ name, logoUrl, size = 20 }: { name: string; logoUrl: string | null; size?: number }) {
  if (logoUrl) {
    return <img src={logoUrl} alt="" width={size} height={size} className="shrink-0 rounded-[6px] object-contain" style={{ width: size, height: size }} />;
  }
  const letter = Array.from(name.trim())[0]?.toUpperCase() ?? "A";
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-[6px] bg-ink font-semibold text-surface"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }}
    >
      {letter}
    </span>
  );
}
