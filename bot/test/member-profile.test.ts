import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEmptyProfile,
  generateProfileSlug,
  memberCategories,
  normalizeMemberProfile,
  ProfileValidationError,
} from '../src/domain/member-profile.js';

test('member categories preserve the current website order convention', () => {
  assert.deepEqual(
    memberCategories.map((category) => category.order),
    [0, 1, 2, 3, 4, 5],
  );
});

test('new profiles start unlisted with canonical empty arrays', () => {
  assert.deepEqual(
    createEmptyProfile({
      name: '  Taein Oh  ',
      position: ' Undergraduate Student ',
      order: 4,
    }),
    {
      listed: false,
      order: 4,
      name: 'Taein Oh',
      position: 'Undergraduate Student',
      details: [],
      researchInterests: [],
      contact: [],
      website: '',
      photo: '',
    },
  );
});

test('profile normalization trims lines and removes empty items', () => {
  const profile = createEmptyProfile({ name: 'Example', position: 'Student', order: 4 });
  profile.details = [' Degree ', '', ' Advisor '];
  profile.contact = [' hello@kaist ', '  '];

  const normalized = normalizeMemberProfile(profile);
  assert.deepEqual(normalized.details, ['Degree', 'Advisor']);
  assert.deepEqual(normalized.contact, ['hello@kaist']);
});

test('invalid member order is rejected by the shared schema', () => {
  const profile = createEmptyProfile({ name: 'Example', position: 'Student', order: 4 });
  const invalid = { ...profile, order: 10 };

  assert.throws(() => normalizeMemberProfile(invalid as never), ProfileValidationError);
});

test('malformed runtime input reports schema validation instead of a TypeError', () => {
  assert.throws(
    () => normalizeMemberProfile({ details: undefined } as never),
    ProfileValidationError,
  );
});

test('ASCII names receive readable stable slugs', () => {
  assert.equal(generateProfileSlug('Taein Oh', new Set()), 'taein-oh');
});

test('non-ASCII names and collisions receive a suffix', () => {
  const suffixes = ['abc12345', 'def67890'];
  const nextSuffix = () => suffixes.shift()!;

  assert.equal(generateProfileSlug('김그래프', new Set(), nextSuffix), 'member-abc12345');
  assert.equal(
    generateProfileSlug('Taein Oh', new Set(['taein-oh']), nextSuffix),
    'taein-oh-def67890',
  );
});

test('a collision suffix keeps a maximum-length readable slug within 64 characters', () => {
  const base = 'a'.repeat(64);
  const slug = generateProfileSlug(base, new Set([base]), () => 'abc12345');

  assert.equal(slug, `${'a'.repeat(55)}-abc12345`);
  assert.equal(slug.length, 64);
});
