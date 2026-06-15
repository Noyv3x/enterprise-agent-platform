/* <ComposerHint/> — the keyboard hint under the composer field (legacy composer
   hint, :736-739). */

export function ComposerHint() {
  return (
    <div className="composer__hint">
      <span className="kbd">Enter</span>
      <span>发送</span>
      <span className="kbd">Shift+Enter</span>
      <span>换行</span>
    </div>
  );
}
