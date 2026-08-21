import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

export const memberCategories = [
  { order: 0, label: 'Professor / Principal Investigator' },
  { order: 1, label: 'Postdoctoral Researcher' },
  { order: 2, label: 'Ph.D. Student' },
  { order: 3, label: 'M.S. Student' },
  { order: 4, label: 'Undergraduate Student' },
  { order: 5, label: 'Other / Visitor' },
] as const;

export type MemberOrder = (typeof memberCategories)[number]['order'];

export type MemberProfile = {
  listed: boolean;
  order: MemberOrder;
  name: string;
  position: string;
  details: string[];
  researchInterests: string[];
  contact: string[];
  website: string;
  photo: string;
};

export class ProfileValidationError extends Error {
  readonly issues: ErrorObject[];

  constructor(issues: ErrorObject[]) {
    super(formatValidationIssues(issues));
    this.name = 'ProfileValidationError';
    this.issues = issues;
  }
}

const schemaPath = new URL('../../../schemas/member-profile.schema.json', import.meta.url);
let validator: ValidateFunction<MemberProfile> | undefined;

function getValidator(): ValidateFunction<MemberProfile> {
  if (!validator) {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object;
    const compiled = new Ajv2020({ allErrors: true, strict: true }).compile<MemberProfile>(schema);
    validator = compiled;
    return compiled;
  }

  return validator;
}

function formatValidationIssues(issues: ErrorObject[]) {
  return issues.map((issue) => `${issue.instancePath || '/'} ${issue.message ?? 'is invalid'}`).join('; ');
}

export function assertMemberProfile(value: unknown): asserts value is MemberProfile {
  const validate = getValidator();

  if (!validate(value)) {
    throw new ProfileValidationError(validate.errors ?? []);
  }
}

export function normalizeMemberProfile(value: MemberProfile): MemberProfile {
  if (!isNormalizableProfile(value)) {
    assertMemberProfile(value);
  }

  const normalized: MemberProfile = {
    listed: value.listed,
    order: value.order,
    name: normalizeRequiredText(value.name),
    position: normalizeRequiredText(value.position),
    details: normalizeLines(value.details),
    researchInterests: normalizeLines(value.researchInterests),
    contact: normalizeLines(value.contact),
    website: normalizeOptionalText(value.website),
    photo: normalizeOptionalText(value.photo),
  };

  assertMemberProfile(normalized);
  return normalized;
}

export function createEmptyProfile(input: {
  name: string;
  position: string;
  order: MemberOrder;
}): MemberProfile {
  return normalizeMemberProfile({
    listed: false,
    order: input.order,
    name: input.name,
    position: input.position,
    details: [],
    researchInterests: [],
    contact: [],
    website: '',
    photo: '',
  });
}

export function isMemberOrder(value: number): value is MemberOrder {
  return memberCategories.some((category) => category.order === value);
}

export function generateProfileSlug(
  name: string,
  takenSlugs: ReadonlySet<string>,
  randomSuffix: () => string = () => randomBytes(4).toString('hex'),
) {
  const ascii = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');

  const base = ascii || 'member';

  if (base !== 'member' && !takenSlugs.has(base)) {
    return base;
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const requestedSuffix = randomSuffix().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
    const suffix = requestedSuffix || randomBytes(4).toString('hex');
    const candidateBase = base
      .slice(0, 64 - suffix.length - 1)
      .replace(/-+$/g, '');
    const candidate = `${candidateBase}-${suffix}`;

    if (!takenSlugs.has(candidate)) {
      return candidate;
    }
  }

  throw new Error('Unable to allocate a unique profile slug.');
}

function normalizeRequiredText(value: string) {
  return value.trim().replace(/\r\n?/g, '\n');
}

function normalizeOptionalText(value: string) {
  return value.trim().replace(/\r\n?/g, '\n');
}

function normalizeLines(lines: string[]) {
  return lines.map((line) => line.trim()).filter(Boolean);
}

function isNormalizableProfile(value: unknown): value is MemberProfile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.listed === 'boolean'
    && typeof candidate.order === 'number'
    && typeof candidate.name === 'string'
    && typeof candidate.position === 'string'
    && isStringArray(candidate.details)
    && isStringArray(candidate.researchInterests)
    && isStringArray(candidate.contact)
    && typeof candidate.website === 'string'
    && typeof candidate.photo === 'string'
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
