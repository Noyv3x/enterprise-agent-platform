import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { request } from '../../api';
import { Button } from '../../components/ui/beautiful/atoms/Button';
import { ConfirmDialog, Icon, Notice } from '../../components/ui/beautiful/controls';
import LoadingState from '../../components/ui/beautiful/primitives/LoadingState';
import FineTuneCard, { FineTuneColorField, FineTuneSection, FineTuneTextField, type FineTuneStatus } from '../../components/ui/beautiful/primitives/FineTuneCard';
import { useBranding } from '../../context/BrandingContext';
import { useWords } from '../../words';
import { errorText, useResource } from './shared';

interface Branding { product_name: string; agent_name: string; primary_color: string; logo: string | null }
type Names = Pick<Branding, 'product_name' | 'agent_name' | 'primary_color'>;

const COLOR = /^#[0-9a-f]{6}$/i;
const LOGO_TYPES = ['image/png', 'image/webp'];
const LOGO_MAX_BYTES = 256 * 1024;

export function BrandingSettings() {
  const w = useWords();
  const { applyBranding } = useBranding();
  const resource = useResource<{ branding: Branding }>('/api/admin/branding');
  const branding = resource.data?.branding ?? null;
  const [draft, setDraft] = useState<Names | null>(null);
  const [saving, setSaving] = useState<'names' | 'logo' | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // Seed once; later logo saves must not overwrite unsaved name/color edits.
  useEffect(() => { if (branding && !draft) setDraft({ product_name: branding.product_name, agent_name: branding.agent_name, primary_color: branding.primary_color }); }, [branding, draft]);

  async function patch(body: Partial<Branding>, kind: 'names' | 'logo'): Promise<Branding | null> {
    setSaving(kind); setError(''); setSaved(false);
    try {
      const response = await request<{ branding: Branding }>('/api/admin/branding', { method: 'PATCH', body: JSON.stringify(body) });
      resource.setData(response);
      applyBranding({ schema_version: 1, revision: 0, product_name: response.branding.product_name, agent_name: response.branding.agent_name, primary_color: response.branding.primary_color, logo_url: response.branding.logo });
      setSaved(true);
      return response.branding;
    } catch (cause) {
      setError(errorText(cause));
      return null;
    } finally {
      setSaving(null);
    }
  }
  async function uploadLogo(file: File) {
    if (!LOGO_TYPES.includes(file.type)) { setError(w('The logo must be a PNG or WebP image.', 'Logo 必须是 PNG 或 WebP 图片。', 'Logo 必須是 PNG 或 WebP 圖片。')); return; }
    if (file.size > LOGO_MAX_BYTES) { setError(w('The logo must be 256 KB or smaller.', 'Logo 不能超过 256 KB。', 'Logo 不能超過 256 KB。')); return; }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error('read failed'));
      reader.readAsDataURL(file);
    });
    await patch({ logo: dataUrl }, 'logo');
  }

  if (!branding || !draft) {
    return <div className="p-4 sm:p-6">
      {resource.state === 'error'
        ? <Notice tone="danger" title={w('Branding could not be loaded', '无法加载品牌设置', '無法載入品牌設定')} action={<Button size="sm" onClick={() => void resource.reload()}>{w('Retry', '重试', '重試')}</Button>}>{resource.error}</Notice>
        : <LoadingState label={w('Loading branding…', '正在加载品牌设置…', '正在載入品牌設定…')} />}
    </div>;
  }

  const productValid = draft.product_name.trim().length > 0 && draft.product_name.trim().length <= 64;
  const agentValid = draft.agent_name.trim().length > 0 && draft.agent_name.trim().length <= 64;
  const colorValid = COLOR.test(draft.primary_color);
  const changed = {
    product: draft.product_name !== branding.product_name,
    agent: draft.agent_name !== branding.agent_name,
    color: draft.primary_color.toLowerCase() !== branding.primary_color.toLowerCase(),
  };
  const dirty = changed.product || changed.agent || changed.color;
  const status: FineTuneStatus = dirty ? 'edited' : saved ? 'saved' : 'idle';
  const nameHint = w('1–64 characters.', '1–64 个字符。', '1–64 個字元。');
  const edit = (patch: Partial<Names>) => { setDraft({ ...draft, ...patch }); setSaved(false); };
  const previewProduct = draft.product_name.trim() || branding.product_name;
  const previewAgent = draft.agent_name.trim() || branding.agent_name;
  const previewColor = colorValid ? draft.primary_color : branding.primary_color;

  async function saveNames() {
    if (!draft || !dirty || !productValid || !agentValid || !colorValid || saving) return;
    const next = await patch({ product_name: draft.product_name.trim(), agent_name: draft.agent_name.trim(), primary_color: draft.primary_color.toLowerCase() }, 'names');
    if (next) setDraft({ product_name: next.product_name, agent_name: next.agent_name, primary_color: next.primary_color });
  }

  return <div className="flex flex-col gap-4 p-4 sm:p-6">
    {error && <Notice tone="danger" title={w('Branding was not saved', '品牌设置未保存', '品牌設定未儲存')}>{error}</Notice>}
    <div className="grid items-start gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
      <form noValidate onSubmit={(event) => { event.preventDefault(); void saveNames(); }}>
        <FineTuneCard
          className="max-w-[340px]"
          status={status}
          labels={{ title: w('Branding', '品牌', '品牌'), edited: w('Unsaved', '未保存', '未儲存'), saved: w('Saved', '已保存', '已儲存') }}
          footer={<>
            <Button size="sm" type="button" disabled={!dirty || saving !== null} onClick={() => { setDraft({ product_name: branding.product_name, agent_name: branding.agent_name, primary_color: branding.primary_color }); setError(''); }}>{w('Discard', '放弃', '放棄')}</Button>
            <Button size="sm" variant="primary" type="submit" disabled={!dirty || !productValid || !agentValid || !colorValid || saving !== null}>
              {saving === 'names' ? w('Saving…', '正在保存…', '正在儲存…') : w('Save branding', '保存品牌设置', '儲存品牌設定')}
            </Button>
          </>}
        >
          <FineTuneSection label={w('Names', '名称', '名稱')}>
            <FineTuneTextField label={w('Product', '产品', '產品')} value={draft.product_name} maxLength={64} changed={changed.product} invalid={!productValid} hint={productValid ? undefined : nameHint} onChange={(product_name) => edit({ product_name })} />
            <FineTuneTextField label={w('Agent', 'Agent', 'Agent')} value={draft.agent_name} maxLength={64} changed={changed.agent} invalid={!agentValid} hint={agentValid ? undefined : nameHint} onChange={(agent_name) => edit({ agent_name })} />
            <p className="text-[11.5px] leading-[1.45] text-ink-2">{w('Shown on the sign-in page, in the navigation and in the agent’s own introduction.', '显示在登录页、导航栏以及 Agent 的自我介绍中。', '顯示在登入頁、導覽列以及 Agent 的自我介紹中。')}</p>
          </FineTuneSection>
          <FineTuneSection label={w('Accent color', '强调色', '強調色')}>
            <FineTuneColorField label="Hex" value={draft.primary_color} changed={changed.color} invalid={!colorValid}
              swatchLabel={w('Pick accent color', '选择强调色', '選擇強調色')}
              hint={colorValid ? w('Links, focus and the send button. Text contrast is adjusted automatically.', '用于链接、焦点和发送按钮。文字对比度会自动调整。', '用於連結、焦點和傳送按鈕。文字對比度會自動調整。') : w('Use a hex color such as #3f6f8f.', '请使用十六进制颜色，例如 #3f6f8f。', '請使用十六進位顏色，例如 #3f6f8f。')}
              onChange={(primary_color) => edit({ primary_color })} />
          </FineTuneSection>
          <FineTuneSection label="Logo" last>
            <div className="flex items-center gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-control bg-field shadow-hairline">
                {branding.logo ? <img src={branding.logo} alt={w('Current logo', '当前 Logo', '目前 Logo')} className="size-full object-contain" /> : <span aria-hidden className="text-[14px] font-semibold text-ink-2">{previewProduct.slice(0, 1).toUpperCase()}</span>}
              </span>
              <div className="flex min-w-0 flex-wrap gap-1.5">
                <input ref={fileRef} type="file" hidden accept={LOGO_TYPES.join(',')} onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) void uploadLogo(file).catch((cause) => setError(errorText(cause)));
                }} />
                <Button size="xs" type="button" disabled={saving !== null} onClick={() => fileRef.current?.click()}>
                  <Icon name="upload" size={13} />{saving === 'logo' ? w('Uploading…', '正在上传…', '正在上傳…') : branding.logo ? w('Replace', '更换', '更換') : w('Upload', '上传', '上傳')}
                </Button>
                {branding.logo && <Button size="xs" type="button" variant="quiet" className="text-red-ink" disabled={saving !== null} onClick={() => setConfirmingRemove(true)}>{w('Remove', '移除', '移除')}</Button>}
              </div>
            </div>
            <p className="text-[11.5px] leading-[1.45] text-ink-2">{w('PNG or WebP, up to 256 KB. Saved right away. A square image works best.', 'PNG 或 WebP，最大 256 KB，上传后立即保存。建议使用正方形图片。', 'PNG 或 WebP，最大 256 KB，上傳後立即儲存。建議使用正方形圖片。')}</p>
          </FineTuneSection>
        </FineTuneCard>
      </form>

      <BrandPreview product={previewProduct} agent={previewAgent} color={previewColor} logo={branding.logo} />
    </div>

    <ConfirmDialog
      open={confirmingRemove}
      tone="danger"
      title={w('Remove the logo?', '移除 Logo？', '移除 Logo？')}
      description={w('The product name’s initial is shown instead.', '将改为显示产品名称的首字母。', '將改為顯示產品名稱的首字母。')}
      confirmLabel={w('Remove logo', '移除 Logo', '移除 Logo')}
      busy={saving === 'logo'}
      onConfirm={() => { void patch({ logo: null }, 'logo').then(() => setConfirmingRemove(false)); }}
      onCancel={() => setConfirmingRemove(false)}
    />
  </div>;
}

/** The harness in miniature, repainted with the draft: sidebar brand row, a window with a reply and the composer's send button. */
function BrandPreview({ product, agent, color, logo }: { product: string; agent: string; color: string; logo: string | null }) {
  const w = useWords();
  const accent = { '--accent': color, '--accent-ink': `color-mix(in oklch, ${color} 72%, var(--ink))`, '--accent-tint': `color-mix(in oklch, ${color} 14%, var(--surface))` } as CSSProperties;
  return <section aria-label={w('Live preview', '实时预览', '即時預覽')} className="min-w-0">
    <p className="mb-2 text-[12.5px] font-medium text-ink">{w('Live preview', '实时预览', '即時預覽')}</p>
    <div aria-hidden className="flex h-[300px] gap-2 overflow-hidden rounded-window bg-canvas p-2 shadow-hairline select-none" style={accent}>
      <div className="hidden w-[168px] shrink-0 flex-col gap-1 p-1.5 sm:flex">
        <div className="flex items-center gap-2 px-1 py-1">
          <span className="flex size-6 items-center justify-center overflow-hidden rounded-[7px] bg-surface text-[11px] font-semibold text-ink shadow-btn">
            {logo ? <img src={logo} alt="" className="size-full object-contain" /> : product.slice(0, 1).toUpperCase()}
          </span>
          <span className="truncate text-[13px] font-semibold text-ink">{product}</span>
        </div>
        {[w('Personal AI', '个人 AI', '個人 AI'), w('Chat', '聊天', '聊天'), w('Schedules', '定时任务', '排程任務')].map((label, index) => (
          <span key={label} className={`truncate rounded-[8px] px-2 py-1.5 text-[12.5px] ${index === 0 ? 'bg-hover-2 font-medium text-ink' : 'text-ink-2'}`}>{label}</span>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-window border border-line bg-page">
        <div className="flex h-10 shrink-0 items-center border-b border-line px-3 text-[12.5px] font-medium text-ink">{w('Personal AI', '个人 AI', '個人 AI')}</div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pt-4">
          <span className="self-end rounded-[14px] bg-hover-2 px-3 py-1.5 text-[12.5px] text-ink">{w('Summarize this week’s tickets', '总结本周的工单', '總結本週的工單')}</span>
          <div className="flex flex-col gap-1">
            <span className="text-[11.5px] font-medium text-ink-2">{agent}</span>
            <p className="text-[12.5px] leading-[1.55] text-ink">{w('Here is the summary. The full list is in ', '摘要如下，完整列表见 ', '摘要如下，完整清單見 ')}<span className="text-accent-ink underline underline-offset-2">tickets.xlsx</span>{w('.', '。', '。')}</p>
          </div>
        </div>
        <div className="m-3 flex items-center justify-between rounded-[14px] bg-surface py-1.5 pr-1.5 pl-3 shadow-card">
          <span className="text-[12.5px] text-ink-2">{w(`Message ${agent}`, `给 ${agent} 发消息`, `傳訊息給 ${agent}`)}</span>
          <span className="flex size-7 items-center justify-center rounded-full bg-accent text-white">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
          </span>
        </div>
      </div>
    </div>
  </section>;
}
