import { Monogram } from "../../components/ui/beautiful/atoms/EntityChip";
import { cn } from "../../components/ui/beautiful/cn";
import { siteMark } from "./web";

/** A site's generated avatar (the Monogram atom): its initial on a stable tone. Never a favicon. */
export function SiteMark({ url, className }: { url: string; className?: string }) {
  const mark = siteMark(url);
  return <Monogram color={mark.color} className={className}>{mark.letter}</Monogram>;
}

/** Upstream StreamingText's source avatar stack: up to four sites, overlapping, ringed in the ground they sit on. */
export function SiteStack({ urls, ring = "var(--page)", className }: { urls: string[]; ring?: string; className?: string }) {
  return (
    <span aria-hidden className={cn("flex shrink-0 -space-x-1", className)}>
      {urls.slice(0, 4).map((url, index) => (
        <span key={`${index}-${url}`} className="flex rounded-full" style={{ boxShadow: `0 0 0 1.5px ${ring}` }}>
          <SiteMark url={url} className="size-3.5 text-[7.5px]" />
        </span>
      ))}
    </span>
  );
}
