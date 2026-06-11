# GRASP Lab Website

This repository contains the source code for the GRASP Lab website at KAIST.

The website is public and deployed through GitHub Pages:

https://grasp-kaist.github.io/

## Important Notice

This website was initially built with the help of AI agents. The repository is public, and the site content is publicly visible on the internet.

Please be careful when adding personal information, contact details, photos, or other files. Do not upload private, sensitive, confidential, or security-related information unless you are sure it should be public.

## Updating Your Member Profile

Member information is stored under:

```text
src/data/members/
```

Each member should have one JSON file. If you want to add a profile photo, put the image file in the same folder.

For example:

```text
src/data/members/example.json
src/data/members/example.png
```

You can edit files directly on GitHub:

https://github.com/grasp-kaist/grasp-kaist.github.io/tree/main/src/data/members

## Member JSON Format

A member JSON file looks like this:

```json
{
  "order": 4,
  "name": "Example",
  "position": "Undergraduate Student, School of Computing, KAIST",
  "contact": [
    "example@kaist.ac.kr",
    "+82-10-1234-5678"
  ],
  "website": "https://example.github.io/",
  "photo": "example.png"
}
```

### Fields

`order` controls the display order on the Members page.

Use the following convention:

| order | Role                               |
| ----: | ---------------------------------- |
|     0 | Professor / Principal Investigator |
|     1 | Postdoctoral Researcher            |
|     2 | Ph.D. Student                      |
|     3 | M.S. Student                       |
|     4 | Undergraduate Student              |
|     5 | Other, such as Visitor             |

Members with the same `order` value are sorted alphabetically by `name`.

`name`, `position`, `contact`, and `website` should contain your public-facing information.

`contact` may be a single string or an array of strings. Use an array when listing multiple contacts so each item appears on its own line:

```json
{
  "contact": [
    "example@kaist.ac.kr",
    "+82-10-1234-5678"
  ]
}
```

If you do not want to show a field such as `contact` or `website`, leave it as an empty string:

```json
{
  "website": ""
}
```

`photo` should contain only the image file name, not a path.

For example:

```json
{
  "photo": "example.png"
}
```

The matching image file should be placed in the same folder:

```text
src/data/members/example.png
```

If you do not want to show a photo, leave `photo` as an empty string or remove the `photo` field. If the `photo` field is empty or the referenced file is missing, the default placeholder is shown.

Supported image formats are:

```text
.jpg, .jpeg, .png, .webp, .svg
```

A 4:5 portrait ratio is recommended. Images with other ratios may be cropped to fit the displayed photo area.

## Updating Teaching Courses

Teaching courses are stored under:

```text
src/data/teaching/
```

Each course lives in its own folder:

```text
src/data/teaching/<course-slug>/
```

The main course page is:

```text
src/data/teaching/<course-slug>/index.md
```

The generated course URL is:

```text
/teaching/<course-slug>
```

The `index.md` file can use optional frontmatter fields:

```markdown
---
title: Example Course
semester:
instructor:
order: 999
---

Course information will be added here.
```

Optional lecture materials go under:

```text
src/data/teaching/<course-slug>/materials/
```

The materials list is generated automatically from files in that folder. Supported material formats are:

```text
.pdf, .ppt, .pptx, .tex, .zip, .md, .txt
```

## Student Seminar and Ongoing Study Groups

The Student Seminar and Ongoing Study Groups pages are still under development.

Their data format has not been finalized yet.

## Developer Notes

The website is built with Astro and deployed to GitHub Pages.

Install dependencies:

```bash
npm install
```

Start the local development server:

```bash
npm run dev
```

Build the static site:

```bash
npm run build
```

Preview the production build locally:

```bash
npm run preview
```

Important source files:

```text
src/layouts/BaseLayout.astro
src/styles/global.css
src/data/members/
src/pages/index.astro
src/pages/members.astro
src/pages/student-seminar.astro
src/pages/ongoing-study-groups.astro
```

The site is static. There is no backend, login, database, server route, or external CMS.
