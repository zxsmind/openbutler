import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandLineMatchesSpawn, treeKillCommand } from '../src/process-tree.js';

describe('treeKillCommand', () => {
  it('kills the whole tree where the platform supports it and the pid otherwise', () => {
    const plan = treeKillCommand(4242);
    expect(plan).not.toBeNull();
    if (process.platform === 'win32') expect(plan).toEqual({ command: 'taskkill', args: ['/PID', '4242', '/T', '/F'] });
    else expect(plan).toEqual({ command: 'kill', args: ['-KILL', '4242'] });
  });

  it('refuses pids that cannot name a process', () => {
    expect(treeKillCommand(0)).toBeNull();
    expect(treeKillCommand(1)).toBeNull();
    expect(treeKillCommand(-7)).toBeNull();
    expect(treeKillCommand(12.5)).toBeNull();
  });
});

describe('commandLineMatchesSpawn', () => {
  const wrapper = 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "npx mcp-remote https://mcp.atlassian.com/v2/mcp"';

  it('accepts the wrapper this spawn created', () => {
    expect(commandLineMatchesSpawn(wrapper, 'npx', ['mcp-remote', 'https://mcp.atlassian.com/v2/mcp'])).toBe(true);
  });

  it('accepts a spawn that carries no arguments', () => {
    const command = join('tools', 'playwright-ext.cmd');
    expect(commandLineMatchesSpawn(`cmd /c "${command}"`, command, [])).toBe(true);
  });

  it('refuses a pid that runs something else', () => {
    expect(commandLineMatchesSpawn('node other-server.js', 'npx', ['mcp-remote'])).toBe(false);
    expect(commandLineMatchesSpawn(wrapper, 'uvx', ['windows-mcp'])).toBe(false);
    expect(commandLineMatchesSpawn(null, 'npx', ['mcp-remote'])).toBe(false);
  });

  it('requires the spawn argument, not just any process with the same executable', () => {
    expect(commandLineMatchesSpawn('cmd /c npx some-other-package', 'npx', ['mcp-remote'])).toBe(false);
  });
});
