/* <Brand/> — the logo + eyebrow lockup (legacy brand(), legacy-app.js:325-330). */

export function Brand() {
  return (
    <div className="brand">
      <img className="brand__logo" src="/ubitech-logo.png" alt="ubitech" />
      <span className="brand__eyebrow">Agent Platform</span>
    </div>
  );
}
