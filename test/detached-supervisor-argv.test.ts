import { describe, test, expect } from 'bun:test';
import { detachedSupervisorArgv } from '../src/core/minions/detached-stderr.ts';

describe('detachedSupervisorArgv', () => {
  const args = ['jobs', 'supervisor', 'start', '--queue', 'default'];

  test('script runtime keeps the entry file', () => {
    expect(detachedSupervisorArgv('/home/u/.bun/bin/bun', '/repo/src/cli.ts', args)).toEqual(['/repo/src/cli.ts', ...args]);
    expect(detachedSupervisorArgv('/usr/bin/node', '/repo/src/cli.ts', args)).toEqual(['/repo/src/cli.ts', ...args]);
    expect(detachedSupervisorArgv('C:\\bun\\bun.exe', 'C:\\repo\\src\\cli.ts', args)).toEqual(['C:\\repo\\src\\cli.ts', ...args]);
  });

  test('compiled binary drops the virtual bunfs entry', () => {
    expect(detachedSupervisorArgv('/home/u/.bun/bin/gbrain', '/$bunfs/root/gbrain', args)).toEqual(args);
    expect(detachedSupervisorArgv('/usr/local/bin/gbrain-linux-x64', '/$bunfs/root/gbrain', args)).toEqual(args);
  });
});
