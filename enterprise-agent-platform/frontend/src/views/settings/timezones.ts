export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** IANA zones for a searchable select; the current value and UTC stay selectable even without Intl.supportedValuesOf. */
export function timezoneOptions(current: string): { value: string; label: string }[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] };
  const zones = intl.supportedValuesOf?.('timeZone') ?? [];
  return [...new Set([current, 'UTC', ...zones].filter(Boolean))].map((value) => ({ value, label: value }));
}
