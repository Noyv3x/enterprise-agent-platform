import { useCallback } from 'react';
import { useI18n } from './i18n';

export function useWords() {
  const { locale } = useI18n();
  return useCallback((en: string, zhCN?: string, zhTW?: string) =>
    (locale === 'zh-CN' ? zhCN : locale === 'zh-TW' ? zhTW : en) || en, [locale]);
}
