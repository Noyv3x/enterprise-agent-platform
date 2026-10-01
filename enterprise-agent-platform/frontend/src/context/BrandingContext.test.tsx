// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BRAND_ACCENT_STYLE_ID, BrandingProvider, useBranding } from './BrandingContext';
import { I18nProvider } from '../i18n';

function Brand() { const { branding } = useBranding(); return <span>{branding.product_name}</span>; }
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

it('loads public branding before authentication and applies it to the document', async () => {
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({branding:{product_name:'Acme',agent_name:'Helper',primary_color:'#123456',logo:null}}))));
  render(<I18nProvider><BrandingProvider><Brand /></BrandingProvider></I18nProvider>);
  expect(await screen.findByText('Acme')).toBeVisible();
  await waitFor(()=>expect(document.title).toBe('Acme'));
  await waitFor(()=>expect(document.getElementById(BRAND_ACCENT_STYLE_ID)?.textContent).toContain('--accent:#123456'));
});
