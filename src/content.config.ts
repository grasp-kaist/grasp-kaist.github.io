import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const members = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/members' }),
  schema: z.object({
    order: z.number().int().nonnegative(),
    name: z.string(),
    position: z.string(),
    interests: z.array(z.string()),
    contact: z.string(),
    website: z.string().url().optional(),
  }),
});

const studentSeminar = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/student-seminar' }),
  schema: z.object({
    order: z.number().int().nonnegative(),
    semester: z.string(),
    title: z.string(),
    speaker: z.string(),
    date: z.string(),
    location: z.string(),
    organizers: z.array(z.string()).default([]),
  }),
});

const studyGroups = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/study-groups' }),
  schema: z.object({
    order: z.number().int().nonnegative(),
    semester: z.string(),
    title: z.string(),
    topic: z.string(),
    startDate: z.string(),
    meetingTime: z.string(),
    location: z.string(),
    coordinators: z.array(z.string()).default([]),
    status: z.string().default('active'),
  }),
});

export const collections = {
  members,
  studentSeminar,
  studyGroups,
};
