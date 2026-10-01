// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Login } from './App';
import { ThemeProvider } from './context/ThemeContext';
import { I18nProvider } from './i18n';

beforeEach(() => localStorage.setItem('eap-locale','en'));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows failed authentication, then signs in with the entered credentials', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({error:'Invalid credentials'}),{status:401})).mockResolvedValueOnce(new Response(JSON.stringify({user:{id:1}})));
  vi.stubGlobal('fetch', fetcher);
  const onLogin = vi.fn().mockResolvedValue(undefined);
  render(<I18nProvider><ThemeProvider><Login onLogin={onLogin} /></ThemeProvider></I18nProvider>);
  fireEvent.change(screen.getByLabelText('Username'),{target:{value:'alice'}});
  fireEvent.change(screen.getByLabelText('Password'),{target:{value:'wrong'}});
  fireEvent.click(screen.getByRole('button',{name:'Sign in'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Invalid credentials');
  expect(onLogin).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Password'),{target:{value:'correct-password'}});
  fireEvent.click(screen.getByRole('button',{name:'Sign in'}));
  await waitFor(()=>expect(onLogin).toHaveBeenCalledOnce());
  expect(fetcher.mock.calls[1][0]).toBe('/api/auth/login');
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({username:'alice',password:'correct-password'});
});
