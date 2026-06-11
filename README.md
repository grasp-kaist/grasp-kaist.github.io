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
  "details": [],
  "contact": [
    "example@kaist",
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

`contact` may be a single string or an array of strings. Use an array when listing multiple contacts so each item appears on its own line. Since contact information can be sensitive when exposed to web crawlers, consider writing it in a lightly obfuscated form, such as `example (at) gmail.com`. The Members page has a note explaining that `@kaist` should be read as `@kaist.ac.kr`, so you may also use that convention. Please also think carefully before adding a personal phone number.

```json
{
  "contact": [
    "example@kaist",
    "+82-10-1234-5678"
  ]
}
```

If you do not want to show a field such as `contact` or `website`, do not delete the field. Leave it as an empty string:

```json
{
  "website": ""
}
```

`details` is a field for any additional information you would like to include. It is intentionally flexible, since it is unclear whether people will want to list degrees, previous affiliations, research interests, advisors, or other information. Use it freely. Like `contact`, it can contain multiple entries.

For example:

```json
{
  "details": [
    "B.S. in Mathematical Sciences, KAIST",
    "Advisor: Example Professor",
    "Research interests: graph theory and algorithms"
  ]
}
```

If you do not want to show details, leave it as an empty array:

```json
{
  "details": []
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

Teaching course information is stored under:

```text
src/data/teaching/
```

To add a new course to the Teaching page, create a new folder under `src/data/teaching/`. It is recommended to copy the existing `example-course` folder and modify it.

You can edit files directly on GitHub:

https://github.com/grasp-kaist/grasp-kaist.github.io/tree/main/src/data/teaching/

Each course folder should contain:

```text
src/data/teaching/example-course/
src/data/teaching/example-course/index.md
src/data/teaching/example-course/materials/
```

### Course Page

The `index.md` file is the main Markdown document for the course page.

You can freely write the course description there. For example, you may include:

* offered semesters
* course codes for each semester
* lecturer information
* a short summary of the course content
* links to external course pages or resources

In Markdown, links can be written as:

```markdown
[display text](https://example.com/)
```

Please refer to `example-course/index.md` for the recommended format.

### Lecture Materials

Lecture materials should be placed under the course’s `materials/` folder.

For example:

```text
src/data/teaching/example-course/materials/
```

You may upload files such as syllabi, lecture notes, slides, and other course materials.

The website provides search over material file names, so it is recommended to include useful information in the file names, such as the year, semester, and material type.

For example:

```text
2025fall-syllabus.pdf
2025fall-lecture-note-01.pdf
2025fall-lecture-slide-01.pdf
```

Please refer to the example course for the current folder structure and file naming style.

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
src/data/teaching/
src/pages/index.astro
src/pages/members.astro
src/pages/teaching.astro
src/pages/teaching/[slug].astro
src/pages/student-seminar.astro
src/pages/ongoing-study-groups.astro
```

The site is static. There is no backend, login, database, server route, or external CMS.