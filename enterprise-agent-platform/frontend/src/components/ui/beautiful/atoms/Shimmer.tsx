/* Upstream components/atoms/Shimmer.tsx. Accessibility adaptation (as ThinkingState's header): the sweep runs between
 * ink-2 and ink instead of ink-3 and ink, so small labels keep 4.5:1 contrast; reduced motion stops the sweep (the
 * foundation's floor). The personal AI's web steps use it for a running search's query and a page being opened. */

/** Shimmering label — signals the agent is processing. */
export function Shimmer({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-block bg-clip-text text-transparent ${className}`}
      style={{
        backgroundImage:
          "linear-gradient(90deg, var(--ink-2) 35%, var(--ink) 50%, var(--ink-2) 65%)",
        backgroundSize: "200% 100%",
        animation: "shimmer-text 1.8s linear infinite",
      }}
    >
      {children}
    </span>
  );
}
