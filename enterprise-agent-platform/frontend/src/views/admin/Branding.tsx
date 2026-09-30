import { useEffect, useState } from 'react';
import { Button, ColorPicker, Form, Input, Popconfirm, Upload } from 'antd';
import { request } from '../../api';
import { useWords } from '../../words';
import { useBranding } from '../../context/BrandingContext';
import { BrandMark, DataRegion, FieldworkProvider, FormFooter, FormGrid, Notice, Section, StatusMark } from '../../components/ui/fieldwork';
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  // Seed once; later logo saves must not overwrite unsaved name/color edits.
  useEffect(() => { if (branding && !draft) setDraft({ product_name: branding.product_name, agent_name: branding.agent_name, primary_color: branding.primary_color }); }, [branding, draft]);

  async function patch(body: Partial<Branding>): Promise<Branding | null> {
    setSaving(true); setError(''); setSaved(false);
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
      setSaving(false);
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
    await patch({ logo: dataUrl });
  }

  const productValid = !!draft && draft.product_name.trim().length > 0 && draft.product_name.trim().length <= 64;
  const agentValid = !!draft && draft.agent_name.trim().length > 0 && draft.agent_name.trim().length <= 64;
  const colorValid = !!draft && COLOR.test(draft.primary_color);
  const dirty = !!draft && !!branding && (draft.product_name !== branding.product_name || draft.agent_name !== branding.agent_name || draft.primary_color.toLowerCase() !== branding.primary_color.toLowerCase());
  const nameHelp = w('1–64 characters.', '1–64 个字符。', '1–64 個字元。');

  return <DataRegion state={resource.state} loadingLabel={w('Loading branding…', '正在加载品牌设置…', '正在載入品牌設定…')} error={resource.error}
    retry={<Button onClick={() => void resource.reload()}>{w('Retry', '重试', '重試')}</Button>}>
    {error && <Notice tone="danger" title={error} />}
    {draft && branding && <>
      <Section title={w('Names and color', '名称与颜色', '名稱與顏色')} description={w('Shown on the sign-in page, in the navigation, and in the agent’s own introduction.', '显示在登录页、导航栏以及 Agent 的自我介绍中。', '顯示在登入頁、導覽列以及 Agent 的自我介紹中。')}>
        <FormGrid>
          <Form layout="vertical" disabled={saving} onFinish={async () => {
            if (!dirty || !productValid || !agentValid || !colorValid) return;
            const next = await patch({ product_name: draft.product_name.trim(), agent_name: draft.agent_name.trim(), primary_color: draft.primary_color.toLowerCase() });
            if (next) setDraft({ product_name: next.product_name, agent_name: next.agent_name, primary_color: next.primary_color });
          }}>
            <Form.Item label={w('Product name', '产品名称', '產品名稱')} validateStatus={productValid ? undefined : 'error'} help={nameHelp}>
              <Input aria-label={w('Product name', '产品名称', '產品名稱')} value={draft.product_name} maxLength={64} onChange={(event) => { setDraft({ ...draft, product_name: event.target.value }); setSaved(false); }} />
            </Form.Item>
            <Form.Item label={w('Agent name', 'Agent 名称', 'Agent 名稱')} validateStatus={agentValid ? undefined : 'error'} help={nameHelp}>
              <Input aria-label={w('Agent name', 'Agent 名称', 'Agent 名稱')} value={draft.agent_name} maxLength={64} onChange={(event) => { setDraft({ ...draft, agent_name: event.target.value }); setSaved(false); }} />
            </Form.Item>
            <Form.Item label={w('Primary color', '主色', '主色')} validateStatus={colorValid ? undefined : 'error'} help={w('Hex color such as #3f6f8f. Text contrast is adjusted automatically.', '十六进制颜色，例如 #3f6f8f。文字对比度会自动调整。', '十六進位顏色，例如 #3f6f8f。文字對比度會自動調整。')}>
              <ColorPicker aria-label={w('Primary color', '主色', '主色')} value={draft.primary_color} format="hex" disabledAlpha showText
                onChange={(color) => { setDraft({ ...draft, primary_color: color.toHexString() }); setSaved(false); }} />
            </Form.Item>
            <FormFooter note={dirty ? <StatusMark tone="warning">{w('Unsaved changes', '有未保存的更改', '有未儲存的變更')}</StatusMark> : saved ? <StatusMark tone="success">{w('Saved', '已保存', '已儲存')}</StatusMark> : undefined}>
              <Button disabled={!dirty || saving} onClick={() => setDraft({ product_name: branding.product_name, agent_name: branding.agent_name, primary_color: branding.primary_color })}>{w('Discard changes', '放弃更改', '放棄變更')}</Button>
              <Button type="primary" htmlType="submit" loading={saving} disabled={!dirty || !productValid || !agentValid || !colorValid}>{w('Save branding', '保存品牌设置', '儲存品牌設定')}</Button>
            </FormFooter>
          </Form>
          <div>
            <StatusMark tone="neutral" subtle>{w('Preview', '预览', '預覽')}</StatusMark>
            <FieldworkProvider mode="light" primaryColor={colorValid ? draft.primary_color : branding.primary_color}>
              <Section tone="inset">
                <BrandMark productName={draft.product_name.trim() || branding.product_name} logoUrl={branding.logo} />
                <FormFooter><Button type="primary" tabIndex={-1}>{w(`Ask ${draft.agent_name.trim() || branding.agent_name}`, `询问 ${draft.agent_name.trim() || branding.agent_name}`, `詢問 ${draft.agent_name.trim() || branding.agent_name}`)}</Button></FormFooter>
              </Section>
            </FieldworkProvider>
          </div>
        </FormGrid>
      </Section>
      <Section title={w('Logo', 'Logo', 'Logo')} description={w('PNG or WebP, up to 256 KB. A square image works best.', 'PNG 或 WebP，最大 256 KB。建议使用正方形图片。', 'PNG 或 WebP，最大 256 KB。建議使用正方形圖片。')}>
        <BrandMark productName={branding.product_name} logoUrl={branding.logo} />
        <FormFooter>
          <Upload accept={LOGO_TYPES.join(',')} multiple={false} showUploadList={false} disabled={saving}
            beforeUpload={(file) => { void uploadLogo(file).catch((cause) => setError(errorText(cause))); return false; }}>
            <Button loading={saving}>{branding.logo ? w('Replace logo', '更换 Logo', '更換 Logo') : w('Upload logo', '上传 Logo', '上傳 Logo')}</Button>
          </Upload>
          {branding.logo && <Popconfirm title={w('Remove the logo?', '移除 Logo？', '移除 Logo？')} okText={w('Remove', '移除', '移除')} cancelText={w('Cancel', '取消', '取消')} okButtonProps={{ danger: true }} onConfirm={() => patch({ logo: null })}>
            <Button danger disabled={saving}>{w('Remove logo', '移除 Logo', '移除 Logo')}</Button>
          </Popconfirm>}
        </FormFooter>
      </Section>
    </>}
  </DataRegion>;
}
