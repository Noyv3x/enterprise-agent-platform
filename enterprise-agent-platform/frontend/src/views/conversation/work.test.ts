import { describe, expect, it } from 'vitest';
import { stepTitle } from './computerView';
import type { ToolCall } from './types';
import { toolVerb, type Words } from './work';

const zh: Words = (_en, zhCN) => zhCN ?? _en;

describe('skill tool verbs', () => {
  it('names each action of the `skill` tool', () => {
    expect(toolVerb('skill', zh, { action: 'install', url: 'https://github.com/acme/pdf' })).toBe('安装技能');
    expect(toolVerb('skill', zh, { action: 'update', name: 'pdf' })).toBe('更新技能');
    expect(toolVerb('skill', zh, { action: 'remove', name: 'pdf' })).toBe('删除技能');
    expect(toolVerb('skill', zh, { action: 'info', name: 'pdf' })).toBe('查看技能');
    expect(toolVerb('skill', zh, { action: 'list' })).toBe('查看技能');
  });

  it('titles the computer step with the skill or its source', () => {
    const call = (args: Record<string, unknown>, status: ToolCall['status'] = 'done'): ToolCall => ({
      id: 't', name: 'skill', args, status, input: '', output: '', truncated: false, streamed: false, diff: '',
    });
    expect(stepTitle(call({ action: 'install', url: 'https://github.com/acme/pdf' }, 'running'), zh)).toBe('正在安装技能 https://github.com/acme/pdf');
    expect(stepTitle(call({ action: 'remove', name: 'pdf' }), zh)).toBe('删除技能 pdf');
    expect(stepTitle(call({ action: 'list' }), zh)).toBe('查看技能');
  });
});

describe('artifact tool verbs', () => {
  it('reads publishing as 发布作品 in the trace and the computer', () => {
    expect(toolVerb('artifact', zh, { action: 'publish', path: '/workspace/deck.html' })).toBe('发布作品');
    expect(toolVerb('artifact', zh, { action: 'list' })).toBe('查看作品');
    const call: ToolCall = { id: 'a', name: 'artifact', args: { action: 'publish', path: '/workspace/out/deck.html', title: '发布会' }, status: 'running', input: '', output: '', truncated: false, streamed: false, diff: '' };
    expect(stepTitle(call, zh)).toBe('正在发布作品 发布会');
  });
});

describe('MCP tool verbs', () => {
  const labels = { notion: 'Notion', 'acme-crm': 'Acme CRM' };
  const call = (name: string, args: Record<string, unknown>, status: ToolCall['status'] = 'done'): ToolCall => ({
    id: 'm', name, args, status, input: '', output: '', truncated: false, streamed: false, diff: '',
  });

  it('reads a connector tool as 「调用 <label> · <tool>」, falling back to the connector name', () => {
    expect(toolVerb('mcp__notion__search_pages', zh, { query: 'x' }, labels)).toBe('调用 Notion · search_pages');
    expect(toolVerb('mcp__acme-crm__find__deal', zh, {}, labels)).toBe('调用 Acme CRM · find__deal');
    expect(toolVerb('mcp__linear__issues', zh, {}, labels)).toBe('调用 linear · issues');
    expect(toolVerb('mcp__notion__search', (en) => en, {}, labels)).toBe('Call Notion · search');
    expect(stepTitle(call('mcp__notion__search', { query: 'roadmap' }, 'running'), zh, labels)).toBe('正在调用 Notion · search');
  });

  it('names each action of the `mcp` tool', () => {
    expect(toolVerb('mcp', zh, { action: 'list' })).toBe('查看连接器');
    expect(toolVerb('mcp', zh, { action: 'describe', connector: 'notion', tool: 'search' })).toBe('查看连接器');
    expect(toolVerb('mcp', zh, { action: 'call', name: 'mcp__notion__search' })).toBe('调用');
    expect(toolVerb('mcp', zh, { action: 'list_resources', connector: 'notion' })).toBe('读取资源');
    expect(toolVerb('mcp', zh, { action: 'read_resource', connector: 'notion', uri: 'notion://p/1' })).toBe('读取资源');
    expect(toolVerb('mcp', zh, { action: 'add', name: 'notion', transport: 'http' })).toBe('添加连接器');
    expect(toolVerb('mcp', zh, { action: 'import', path: '/workspace/.mcp.json' })).toBe('导入配置');
    expect(toolVerb('mcp', zh, { action: 'remove', name: 'notion' })).toBe('删除连接器');
    expect(toolVerb('mcp', zh, { action: 'connect', name: 'notion' })).toBe('请求连接');
    expect(toolVerb('mcp', zh, { action: 'enable', name: 'notion' })).toBe('启用连接器');
    expect(toolVerb('mcp', zh, { action: 'disable', name: 'notion' })).toBe('停用连接器');
  });

  it('titles the computer step with the connector and tool, the resource or the imported file', () => {
    expect(stepTitle(call('mcp', { action: 'call', name: 'mcp__notion__search', arguments: {} }), zh, labels)).toBe('调用 Notion · search');
    expect(stepTitle(call('mcp', { action: 'call', connector: 'acme-crm', tool: 'deals' }), zh, labels)).toBe('调用 Acme CRM · deals');
    expect(stepTitle(call('mcp', { action: 'read_resource', connector: 'notion', uri: 'notion://p/1' }), zh, labels)).toBe('读取资源 notion://p/1');
    expect(stepTitle(call('mcp', { action: 'import', path: '/workspace/.mcp.json' }, 'running'), zh, labels)).toBe('正在导入配置 /workspace/.mcp.json');
    expect(stepTitle(call('mcp', { action: 'connect', name: 'notion' }), zh, labels)).toBe('请求连接 Notion');
    // Traces of the removed per-call helper named a server and tool without an action.
    expect(stepTitle(call('mcp', { server: 'notion', tool: 'search' }), zh, labels)).toBe('调用 Notion · search');
  });
});
