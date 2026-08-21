import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getListedMembers, getWebsitePresentation } from '../src/lib/member-profile.mjs';
import { validateMemberProfiles } from '../scripts/member-profile-validator.mjs';

const canonicalProfile = {
  listed: false,
  order: 4,
  name: 'Example Member',
  position: 'Undergraduate Student, KAIST',
  details: [],
  researchInterests: ['Graph algorithms'],
  contact: ['example@kaist'],
  website: '',
  photo: '',
};

test('includes only profiles with listed set to true', () => {
  const listed = { ...canonicalProfile, listed: true, name: 'Listed' };
  const hidden = { ...canonicalProfile, listed: false, name: 'Hidden' };
  const legacy = { ...canonicalProfile, name: 'Missing flag' };
  delete legacy.listed;

  assert.deepEqual(getListedMembers([listed, hidden, legacy]), [listed]);
});

test('normalizes a bare website domain to an HTTPS link', () => {
  assert.deepEqual(getWebsitePresentation('example.com/profile'), {
    href: 'https://example.com/profile',
    text: 'https://example.com/profile',
  });
});

test('keeps explicit HTTP and HTTPS website links clickable', () => {
  assert.deepEqual(getWebsitePresentation('http://example.com/profile'), {
    href: 'http://example.com/profile',
    text: 'http://example.com/profile',
  });
  assert.deepEqual(getWebsitePresentation('https://example.com/'), {
    href: 'https://example.com/',
    text: 'https://example.com/',
  });
});

test('renders unsafe and unparseable website values as text only', () => {
  assert.deepEqual(getWebsitePresentation('javascript:alert(1)'), {
    text: 'javascript:alert(1)',
  });
  assert.deepEqual(getWebsitePresentation('not a URL'), {
    text: 'not a URL',
  });
  assert.deepEqual(getWebsitePresentation('https://'), {
    text: 'https://',
  });
});

test('treats an empty website as absent', () => {
  assert.equal(getWebsitePresentation('   '), undefined);
  assert.equal(getWebsitePresentation(undefined), undefined);
});

test('accepts the canonical profile shape and a referenced PNG', async (t) => {
  const directory = await makeTemporaryMembersDirectory(t);
  await fs.writeFile(path.join(directory, 'example.png'), 'image fixture');
  await writeProfile(directory, { ...canonicalProfile, listed: true, photo: 'example.png' });

  const result = await validateMemberProfiles({ membersDirectory: directory });

  assert.equal(result.profileCount, 1);
  assert.deepEqual(result.issues, []);
});

test('rejects legacy scalar arrays, unknown order values, and missing fields', async (t) => {
  const directory = await makeTemporaryMembersDirectory(t);
  const { researchInterests: _omitted, ...invalidProfile } = canonicalProfile;
  await writeProfile(directory, {
    ...invalidProfile,
    order: 6,
    contact: 'example@kaist',
  });

  const result = await validateMemberProfiles({ membersDirectory: directory });

  assert.ok(result.issues.some((issue) => issue.message.includes("must have required property 'researchInterests'")));
  assert.ok(result.issues.some((issue) => issue.message.includes('/order must be equal to one of the allowed values')));
  assert.ok(result.issues.some((issue) => issue.message.includes('/contact must be array')));
});

test('rejects SVG photos and missing image files', async (t) => {
  const svgDirectory = await makeTemporaryMembersDirectory(t);
  await writeProfile(svgDirectory, { ...canonicalProfile, photo: 'example.svg' });
  const svgResult = await validateMemberProfiles({ membersDirectory: svgDirectory });
  assert.ok(svgResult.issues.some((issue) => issue.message.includes('/photo must match pattern')));

  const missingDirectory = await makeTemporaryMembersDirectory(t);
  await writeProfile(missingDirectory, { ...canonicalProfile, photo: 'example.webp' });
  const missingResult = await validateMemberProfiles({ membersDirectory: missingDirectory });
  assert.ok(missingResult.issues.some((issue) => issue.message.includes('/photo file is missing')));
});

async function makeTemporaryMembersDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grasp-member-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeProfile(directory, profile) {
  await fs.writeFile(path.join(directory, 'example.json'), `${JSON.stringify(profile, null, 2)}\n`);
}
