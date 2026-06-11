# GRASP Lab Website

Initial static website for the GRASP lab at KAIST.

The site is built with Astro and deployed to GitHub Pages at <https://grasp-kaist.github.io>.

## Run Locally

Install dependencies:

```sh
npm install
```

Start the local development server:

```sh
npm run dev
```

Build the static site:

```sh
npm run build
```

Preview the production build locally:

```sh
npm run preview
```

## Project Structure

Important files and folders:

```text
src/layouts/BaseLayout.astro
src/styles/global.css
src/content.config.ts
src/content/members/
src/content/student-seminar/
src/content/study-groups/
src/pages/index.astro
src/pages/members.astro
src/pages/student-seminar.astro
src/pages/ongoing-study-groups.astro
```

The pages are static. There is no backend, login, database, server route, or external CMS.

## Editing Convention

- Members edit their own member file under `src/content/members/`.
- Student seminar organizers edit files under `src/content/student-seminar/`.
- Study group organizers edit files under `src/content/study-groups/`.
- Site-wide layout, styling, configuration, and deployment changes are handled by site admins.

## Add or Edit a Member

Create or edit a Markdown file in `src/content/members/`.

Example:

```md
---
order: 10
name: "Placeholder Student"
position: "Graduate Student"
interests:
  - "robot learning"
  - "planning"
contact: "placeholder@example.com"
website: "https://example.com/placeholder"
---
```

The `order` field controls the display order on the Members page. Use clearly fake placeholder information until real member information is approved.

## Add or Edit a Student Seminar Entry

Create or edit a Markdown file in `src/content/student-seminar/`.

Example:

```md
---
order: 10
semester: "Fall 2026"
title: "Placeholder Seminar Title"
speaker: "Placeholder Speaker"
date: "2026-09-01"
location: "TBD"
organizers:
  - "Student seminar organizers"
---

Add the abstract, paper links, or notes here.
```

The `order` field controls the display order on the Student Seminar page.

## Add or Edit a Study Group Entry

Create or edit a Markdown file in `src/content/study-groups/`.

Example:

```md
---
order: 10
semester: "Fall 2026"
title: "Placeholder Study Group"
topic: "Robot learning"
startDate: "2026-09-01"
meetingTime: "TBD"
location: "TBD"
coordinators:
  - "Study group organizers"
status: "planning"
---

Add the study plan, reading list, or participation notes here.
```

The `order` field controls the display order on the Ongoing Study Groups page.
