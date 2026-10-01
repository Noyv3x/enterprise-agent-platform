// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createChat, deleteChat, refreshChats, resetChatStore, setChatAccount, updateChat, useChats } from './chatStore';

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../api', () => api);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const chat = (title: string) => ({ id: 'shared-id', user_id: 1, title, model_id: 'model', created_at: '2026-10-01', updated_at: '2026-10-01', deleted_at: null });
const models = { allowed_models: ['model'], default_model_id: 'model' };
beforeEach(() => { vi.clearAllMocks(); setChatAccount(null); resetChatStore(); });
afterEach(cleanup);

it('clears account data immediately on session exit and loads the next account independently', async () => {
  const { result } = renderHook(() => useChats(false));
  api.request.mockImplementation(async (path: string) => path.endsWith('/models') ? models : { conversations: [chat('Account A')] });
  await act(async () => { setChatAccount(1); await refreshChats(); });
  expect(result.current.conversations?.[0].title).toBe('Account A');
  act(() => setChatAccount(null));
  expect(result.current).toEqual({ conversations: null, models: null, error: '' });
  api.request.mockImplementation(async (path: string) => path.endsWith('/models') ? { ...models, default_model_id: 'B model' } : { conversations: [chat('Account B')] });
  await act(async () => { setChatAccount(2); await refreshChats(); });
  expect(result.current.conversations?.[0].title).toBe('Account B');
  expect(result.current.models?.default_model_id).toBe('B model');
});

it.each(['resolve', 'reject'] as const)('ignores stale refresh %s and keeps the new account refresh in flight', async (settle) => {
  const old = deferred<unknown>();
  const current = deferred<unknown>();
  const { result } = renderHook(() => useChats(false));
  api.request.mockImplementation((path: string) => path.endsWith('/models') ? Promise.resolve(models) : old.promise);
  let first!: Promise<void>;
  act(() => { setChatAccount(1); first = refreshChats(); });
  api.request.mockImplementation((path: string) => path.endsWith('/models') ? Promise.resolve(models) : current.promise);
  let second!: Promise<void>;
  act(() => { setChatAccount(2); second = refreshChats(); });
  await act(async () => {
    if (settle === 'resolve') old.resolve({ conversations: [chat('Account A')] });
    else old.reject(new Error('Account A failed'));
    await first;
  });
  expect(result.current).toEqual({ conversations: null, models: null, error: '' });
  expect(refreshChats()).toBe(second);
  await act(async () => { current.resolve({ conversations: [chat('Account B')] }); await second; });
  expect(result.current.conversations?.[0].title).toBe('Account B');
});

it.each(['create', 'update', 'delete'] as const)('does not apply a stale %s response to a new account', async (operation) => {
  const pending = deferred<unknown>();
  const { result } = renderHook(() => useChats(false));
  act(() => setChatAccount(1));
  api.request.mockReturnValue(pending.promise);
  const mutation = operation === 'create' ? createChat() : operation === 'update' ? updateChat('shared-id', { title: 'Old account' }) : deleteChat('shared-id');
  api.request.mockImplementation(async (path: string) => path.endsWith('/models') ? models : { conversations: [chat('Account B')] });
  await act(async () => { setChatAccount(2); await refreshChats(); });
  await act(async () => { pending.resolve({ conversation: chat('Old account') }); await mutation; });
  expect(result.current.conversations?.map(item => item.title)).toEqual(['Account B']);
});

it('reloads an already mounted subscriber when the authenticated account changes', async () => {
  api.request.mockImplementation(async (path: string) => path.endsWith('/models') ? models : { conversations: [chat('Account A')] });
  setChatAccount(1);
  const { result } = renderHook(() => useChats());
  await act(async () => { await refreshChats(); });
  expect(result.current.conversations?.[0].title).toBe('Account A');
  api.request.mockImplementation(async (path: string) => path.endsWith('/models') ? models : { conversations: [chat('Account B')] });
  await act(async () => { setChatAccount(2); });
  expect(result.current.conversations?.[0].title).toBe('Account B');
});
