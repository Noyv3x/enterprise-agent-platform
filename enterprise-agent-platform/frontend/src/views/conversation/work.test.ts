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
