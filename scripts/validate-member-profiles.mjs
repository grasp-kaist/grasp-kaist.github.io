#!/usr/bin/env node

import { validateMemberProfiles } from './member-profile-validator.mjs';

try {
  const result = await validateMemberProfiles();

  if (result.issues.length > 0) {
    console.error(`Member profile validation failed with ${result.issues.length} issue(s):`);

    for (const issue of result.issues) {
      console.error(`- ${issue.file}: ${issue.message}`);
    }

    process.exitCode = 1;
  } else {
    console.log(`Validated ${result.profileCount} member profile(s).`);
  }
} catch (error) {
  console.error('Member profile validation could not run.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
