// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiModule from '../../api';
import { ApiError } from '../../api';
import { connectMcp, McpPopupBlocked } from './connect';

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../api', async (actual) => ({ ...(await actual<typeof ApiModule>()), request: api.request }));

const popup = () => ({ closed: false, location: { href: 'about:blank' }, close: vi.fn() });

describe('connectMcp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.request.mockResolvedValue({ authorize_url: 'https://idp.example/authorize' });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('settles as closed, not failed, when the window closes without a message', async () => {
    vi.useFakeTimers();
    const window1 = popup();
    vi.stubGlobal('open', vi.fn(() => window1));
    const result = connectMcp('/api/mcp/connectors/3/connect', 3);
    await vi.advanceTimersByTimeAsync(0);
    expect(window1.location.href).toBe('https://idp.example/authorize');
    window1.closed = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toBe('closed');
  });

  it('closes the blank window and rethrows when the platform refuses', async () => {
    const window1 = popup();
    vi.stubGlobal('open', vi.fn(() => window1));
    api.request.mockRejectedValue(new ApiError('PKCE', 400, 'oauth_pkce_unsupported'));
    await expect(connectMcp('/api/mcp/connectors/3/connect', 3)).rejects.toMatchObject({ code: 'oauth_pkce_unsupported' });
    expect(window1.close).toHaveBeenCalled();
  });

  it('hands back the authorize link when every window is blocked', async () => {
    vi.stubGlobal('open', vi.fn(() => null));
    const failure = await connectMcp('/api/mcp/connectors/3/connect', 3).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(McpPopupBlocked);
    expect((failure as McpPopupBlocked).url).toBe('https://idp.example/authorize');
  });

  it.each(['http://idp.example/authorize', 'javascript:alert(1)', 'not a url'])('refuses to open %s and closes the blank window', async (url) => {
    const window1 = popup();
    vi.stubGlobal('open', vi.fn(() => window1));
    api.request.mockResolvedValue({ authorize_url: url });
    await expect(connectMcp('/api/mcp/connectors/3/connect', 3)).rejects.toThrow('not a secure (https) link');
    expect(window1.location.href).toBe('about:blank');
    expect(window1.close).toHaveBeenCalled();
  });

  it('allows loopback http for a local identity provider and cuts the opener', async () => {
    const window1: ReturnType<typeof popup> & { opener?: unknown } = { ...popup(), opener: window };
    vi.stubGlobal('open', vi.fn(() => window1));
    api.request.mockResolvedValue({ authorize_url: 'http://127.0.0.1:9000/authorize' });
    void connectMcp('/api/mcp/connectors/3/connect', 3);
    await vi.waitFor(() => expect(window1.location.href).toBe('http://127.0.0.1:9000/authorize'));
    expect(window1.opener).toBeNull();
    window1.closed = true;
  });
});
