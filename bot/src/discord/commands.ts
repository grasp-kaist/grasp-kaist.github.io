import { memberCategories } from '../domain/member-profile.js';

export const memberCategoryChoices = memberCategories.map(({ order, label }) => ({
  name: label,
  value: order,
}));

const userOption = (name: string, description: string) => ({
  type: 6, // USER
  name,
  description,
  required: true,
});

export const guildCommands = [
  {
    type: 1, // CHAT_INPUT
    name: 'register',
    description: 'Create your GRASP website profile',
    options: [
      {
        type: 4, // INTEGER
        name: 'category',
        description: 'Your current member category',
        required: true,
        choices: memberCategoryChoices,
      },
    ],
  },
  {
    type: 1,
    name: 'profile',
    description: 'View and edit your GRASP website profile',
  },
  {
    type: 1,
    name: 'profile-admin',
    description: 'Owner-only profile recovery and moderation',
    options: [
      {
        type: 1, // SUB_COMMAND
        name: 'hide',
        description: 'Force-hide a profile from the website',
        options: [userOption('member', 'Profile owner')],
      },
      {
        type: 1,
        name: 'unhide',
        description: 'Return visibility control to a profile owner',
        options: [userOption('member', 'Profile owner')],
      },
      {
        type: 1,
        name: 'revoke',
        description: 'Suspend a profile binding',
        options: [userOption('member', 'Profile owner')],
      },
      {
        type: 1,
        name: 'restore',
        description: 'Restore a suspended profile binding',
        options: [userOption('member', 'Profile owner')],
      },
      {
        type: 1,
        name: 'transfer',
        description: 'Transfer a profile to another Discord account',
        options: [
          userOption('from', 'Current profile owner'),
          userOption('to', 'New profile owner'),
        ],
      },
      {
        type: 1,
        name: 'set-category',
        description: 'Correct a member category',
        options: [
          userOption('member', 'Profile owner'),
          {
            type: 4, // INTEGER
            name: 'category',
            description: 'New member category',
            required: true,
            choices: memberCategoryChoices,
          },
        ],
      },
    ],
  },
] as const;
