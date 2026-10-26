import { describe, expect, it } from 'vitest';
import { movePanelHistory, navigatePanelTab, newPanelTab, removePanelTab, resolvePanelAddress } from './panel-navigation.js';

describe('panel navigation', () => {
  it('ignores a repeated close from an exiting tab and keeps the selected tab valid', () => {
    const state = { tabs: [newPanelTab('one'), newPanelTab('two'), newPanelTab('three')], active: 'one' };
    const closed = removePanelTab(state, 'one', 'home');
    expect(closed.active).toBe('three');
    expect(removePanelTab(closed, 'one', 'other-home')).toBe(closed);
    const last = removePanelTab({ tabs: [newPanelTab('one')], active: 'one' }, 'one', null);
    expect(last).toEqual({ tabs: [], active: '' });
  });
  it('opens Tools first, and preserves the terminal instance through back/forward and chat changes', () => {
    const home = newPanelTab('one');
    expect(home.history[home.index]).toBeNull();
    const terminal = navigatePanelTab(home, 'terminal', 'session-a');
    const back = movePanelHistory(terminal, -1);
    expect(back.history[back.index]).toBeNull();
    expect(movePanelHistory(back, 1).applications).toBe(terminal.applications);
    const reopened = navigatePanelTab(back, 'terminal', 'session-b');
    expect(reopened.applications.terminal.sessionId).toBe('session-a');
  });
  it('replaces forward history on a new destination and retains existing app instances', () => {
    const terminal = navigatePanelTab(newPanelTab('one'), 'terminal', 'session-a');
    const branched = navigatePanelTab(movePanelHistory(terminal, -1), 'another-app', 'session-b');
    expect(branched.history).toEqual([null, 'another-app']);
    expect(branched.applications.terminal.sessionId).toBe('session-a');
    expect(branched.applications['another-app'].sessionId).toBe('session-b');
    expect(movePanelHistory(branched, 10).index).toBe(1);
    expect(movePanelHistory(branched, -10).index).toBe(0);
  });
  it('resolves only registered workspace routes', () => {
    const apps = [{ id: 'terminal', title: 'Terminal' }];
    expect(resolvePanelAddress('ranite://tools', apps)).toEqual({ ok: true, appId: null });
    expect(resolvePanelAddress('ranite://terminal', apps)).toEqual({ ok: true, appId: 'terminal' });
    expect(resolvePanelAddress(' Terminal ', apps)).toEqual({ ok: true, appId: 'terminal' });
    expect(resolvePanelAddress('https://example.com', apps).ok).toBe(false);
    expect(resolvePanelAddress('terminal; run-something', apps).ok).toBe(false);
  });
});
