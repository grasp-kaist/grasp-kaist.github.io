import { memberCategories } from '../domain/member-profile.js';

export const memberCategoryChoices = memberCategories.map(({ order, label }) => ({
  name: label,
  value: order,
}));

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
] as const;
