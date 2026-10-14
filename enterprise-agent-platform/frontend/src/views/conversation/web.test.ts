import { describe, expect, it } from 'vitest';
import { parseWork } from './work';
import { calmFailure, readSources, safeHref, siteMark, siteOf, visits, webFromEvent, webFromItem } from './web';

const results = [
  { title: 'NEV sales', url: 'https://www.news.cn/a.html', description: 'Up 34%', position: 1 },
  { title: 'EV lead', url: 'https://www.bloomberg.com/b', description: 'Half of sales', position: 2 },
];

describe('web step data', () => {
  it('reads live details and, without them, the JSON output the tool returned (cut or not)', () => {
    const live = webFromEvent('web_search', { query: 'ev' }, false, { query: 'ev', web: results, source: 'managed_search', unresponsive: [{ engine: 'baidu', reason: 'CAPTCHA' }] }, '');
    expect(live).toEqual({ kind: 'search', query: 'ev', results: results.map(({ title, url, description }) => ({ title, url, description })), unresponsive: [{ engine: 'baidu', reason: 'CAPTCHA' }] });

    // An older event: no details, the content preview cut inside the second result's snippet.
    const json = JSON.stringify({ web: results, source: 'managed_search' });
    const older = webFromEvent('web_search', { query: 'ev' }, false, null, json.slice(0, json.indexOf('Half')));
    expect(older).toMatchObject({ kind: 'search', query: 'ev', results: [{ url: 'https://www.news.cn/a.html', description: 'Up 34%' }, { url: 'https://www.bloomberg.com/b' }] });

    const page = webFromEvent('web_fetch', { url: 'https://news.cn/a' }, false, null, JSON.stringify({ url: 'https://news.cn/a', content: '# T\n\n![chart](https://cdn.example/x.png)Body' }));
    expect(page).toMatchObject({ kind: 'page', url: 'https://news.cn/a', via: null, excerpt: '# T\n\nBody' });

    // Text that is not the JSON shape stays readable as text.
    expect(webFromEvent('web_search', { query: 'pi' }, false, null, 'Pi docs https://pi.dev/docs')).toMatchObject({ kind: 'search', results: [], text: 'Pi docs https://pi.dev/docs' });
  });

  it('explains failures from the contract fields, and older failures from their message', () => {
    const blocked = webFromEvent('web_fetch', { url: 'https://www.reuters.com/x' }, true,
      { error: 'blocked', url: 'https://www.reuters.com/x', host: 'www.reuters.com', status: 401, protection: 'DataDome', tried_browser: true }, 'Could not read');
    expect(blocked).toEqual({ kind: 'failure', error: 'blocked', url: 'https://www.reuters.com/x', host: 'www.reuters.com', status: 401, protection: 'DataDome', triedBrowser: true, message: 'Could not read' });
    const old = webFromEvent('web_fetch', { url: 'https://www.reuters.com/x' }, true, null, 'Platform tool HTTP 502');
    expect(old).toMatchObject({ kind: 'failure', error: 'unknown', host: 'www.reuters.com', triedBrowser: null, message: 'Platform tool HTTP 502' });
    expect(webFromEvent('read', {}, false, null, 'x')).toBeNull();
  });

  it('reads a reloaded trace exactly like the live step', () => {
    const details = { url: 'https://www.bloomberg.com/b', title: 'EV lead', via: 'browser', chars: 48213, truncated: true, excerpt: 'Body' };
    const live = webFromEvent('web_fetch', { url: 'https://bloomberg.com/b' }, false, details, '{}');
    const persisted = webFromItem('web_fetch', { url: 'https://bloomberg.com/b' }, 'done', { page: { url: details.url, title: details.title, via: 'browser', chars: 48213, truncated: true }, excerpt: 'Body' }, '');
    expect(persisted).toEqual(live);
    // A running step has nothing yet; an older trace item without fields falls back to its output.
    expect(webFromItem('web_fetch', {}, 'running', {}, '')).toBeNull();
    const trace = parseWork({ v: 1, items: [{ type: 'tool', id: 's', name: 'web_search', args: { query: 'ev' }, status: 'done', output: '{"web":[{"title":"A","url":"https://a.cn/"', query: 'ev', results: [{ title: 'A', url: 'https://a.cn/', description: '' }], unresponsive: [] }] });
    expect(trace?.items[0]).toMatchObject({ web: { kind: 'search', results: [{ url: 'https://a.cn/' }] } });
  });

  it('clips a live step to the trace bounds, so the reloaded step shows the same rows, count and excerpt', () => {
    // The gateway's sizes (title ≤300, description ≤1000, excerpt ≤4000, any number of rows and engines) …
    const web = Array.from({ length: 14 }, (_, at) => ({ title: `标题${at}`.padEnd(300, '题'), url: `https://news.cn/${at}`, description: 'd'.repeat(1000), position: at + 1 }));
    const unresponsive = Array.from({ length: 20 }, (_, at) => ({ engine: `engine${at}`.padEnd(100, 'e'), reason: 'r'.repeat(200) }));
    const excerpt = `正文${'字'.repeat(3998)}`;
    const details = { url: 'https://news.cn/a', title: 'T'.repeat(300), via: 'browser', chars: 52000, truncated: true, excerpt };
    // … and what Platform keeps of them (platform-api.md § Assistant message work trace).
    const persistedSearch = {
      query: 'ev', unresponsive: unresponsive.slice(0, 5).map(({ engine, reason }) => ({ engine: engine.slice(0, 64), reason: reason.slice(0, 120) })),
      results: web.slice(0, 10).map(({ title, url, description }) => ({ title: title.slice(0, 200), url, description: description.slice(0, 240) })),
    };
    const persistedPage = { page: { url: details.url, title: details.title.slice(0, 200), via: 'browser', chars: 52000, truncated: true }, excerpt: excerpt.slice(0, 2000) };

    const live = webFromEvent('web_search', { query: 'ev' }, false, { query: 'ev', web, source: 'managed_search', unresponsive }, '');
    expect(live).toEqual(webFromItem('web_search', { query: 'ev' }, 'done', persistedSearch, ''));
    expect(live).toMatchObject({ results: { length: 10 }, unresponsive: { length: 5 } });
    const livePage = webFromEvent('web_fetch', { url: details.url }, false, details, '');
    expect(livePage).toEqual(webFromItem('web_fetch', { url: details.url }, 'done', persistedPage, ''));
    expect(livePage?.kind === 'page' && [livePage.excerpt.length, livePage.title.length]).toEqual([2000, 200]);
  });

  it('keeps every explained page failure calm and the rest red', () => {
    const failed = (error?: string) => webFromEvent('web_fetch', { url: 'https://x.cn/' }, true, error ? { error, url: 'https://x.cn/', host: 'x.cn', tried_browser: false } : null, 'failed');
    for (const error of ['blocked', 'not_found', 'http_error', 'timeout', 'unreachable', 'too_large', 'unsupported', 'invalid_url', 'forbidden']) {
      expect(calmFailure(failed(error)), error).not.toBeNull();
    }
    // An older step or a gateway error carries no reason; an unknown reason is not explained either.
    expect(calmFailure(failed())).toBeNull();
    expect(calmFailure(failed('exploded'))).toBeNull();
  });

  it('links only http and https addresses', () => {
    expect(safeHref('https://news.cn/a')).toBe('https://news.cn/a');
    expect(safeHref('HTTP://news.cn/a')).toBe('HTTP://news.cn/a');
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'news.cn/a', '//news.cn/a']) expect(safeHref(url)).toBeUndefined();
  });

  it('names sites, marks them without any request, and tracks which pages were read', () => {
    expect(siteOf('https://www.news.cn/x')).toBe('news.cn');
    expect(siteMark('https://zhuanlan.zhihu.com/p/1')).toEqual(siteMark('https://www.zhihu.com/'));
    expect(siteMark('https://finance.sina.com.cn/').letter).toBe('S');
    expect(siteMark('https://36kr.com/p/1').letter).toBe('3');
    const steps = [
      { name: 'web_fetch', args: { url: 'https://news.cn/a.html' }, web: webFromEvent('web_fetch', {}, false, { url: 'https://www.news.cn/a.html', title: 'A', via: 'direct', chars: 9, truncated: false, excerpt: '' }, '') },
      { name: 'web_fetch', args: { url: 'https://www.reuters.com/x' }, web: webFromEvent('web_fetch', { url: 'https://www.reuters.com/x' }, true, { error: 'blocked', url: 'https://www.reuters.com/x', host: 'www.reuters.com', tried_browser: true }, '') },
      { name: 'web_fetch', args: { url: 'https://news.cn/a.html#top' }, web: webFromEvent('web_fetch', {}, false, { url: 'https://news.cn/a.html', title: 'A again', via: 'direct', chars: 9, truncated: false, excerpt: '' }, '') },
    ];
    const seen = visits(steps);
    expect(seen.get('news.cn/a.html')).toBe('read');
    expect(seen.get('reuters.com/x')).toBe('failed');
    expect(readSources(steps)).toEqual([{ url: 'https://www.news.cn/a.html', title: 'A', site: 'news.cn' }]);
  });
});
