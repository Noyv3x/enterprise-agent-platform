export interface User {
  id: number;
  username: string;
  display_name: string;
  role: string;
  position: string;
  permission_group: string;
  model_name: string;
  thinking_depth: string;
  timezone: string;
  active: boolean;
  language?: string;
  [key: string]: unknown;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  if (response.status === 401) window.dispatchEvent(new Event('session-expired'));
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new ApiError(payload?.error || `${response.status} ${response.statusText}`, response.status);
  }
  return response.json() as Promise<T>;
}
