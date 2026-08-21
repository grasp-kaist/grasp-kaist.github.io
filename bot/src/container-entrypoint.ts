import { chownSync, lchownSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dataDirectory = '/data';

if (typeof process.getuid === 'function' && process.getuid() === 0) {
  const setgid = process.setgid;
  const setuid = process.setuid;

  if (typeof setgid !== 'function' || typeof setuid !== 'function') {
    throw new Error('This container cannot drop root privileges on the current platform.');
  }

  const nodeHome = statSync('/home/node');
  mkdirSync(dataDirectory, { recursive: true });
  chownSync(dataDirectory, nodeHome.uid, nodeHome.gid);

  for (const entry of readdirSync(dataDirectory)) {
    lchownSync(join(dataDirectory, entry), nodeHome.uid, nodeHome.gid);
  }

  if (typeof process.setgroups === 'function') {
    process.setgroups([]);
  }

  setgid(nodeHome.gid);
  setuid(nodeHome.uid);
}

await import('./index.js');
