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
src/assets/members/
src/data/members/
src/pages/index.astro
src/pages/members.astro
src/pages/student-seminar.astro
src/pages/ongoing-study-groups.astro
```

The pages are static. There is no backend, login, database, server route, or external CMS.

## Editing Convention

- Members edit or add their own JSON file under `src/data/members/`.
- Student seminar organizers maintain seminar information once a data format is added.
- Study group organizers maintain study group information once a data format is added.
- Site-wide layout, styling, configuration, and deployment changes are handled by site admins.

## Add or Edit a Member

Create or edit one JSON file per person in `src/data/members/`.

Example:

```json
{
  "order": 3,
  "name": "Taein Oh",
  "position": "Undergraduate Student, Department of Mathematical Sciences, KAIST",
  "contact": "octanec8h18@kaist.ac.kr, +82-10-5858-5697",
  "website": "https://octane-kr.github.io/",
  "photo": "taein-oh.png"
}
```

The required fields are `order`, `name`, `position`, and `contact`. The `researchInterests`, `website`, and `photo` fields are optional.

Use the `order` field to group members:

- `0`: Lab professor / principal investigator
- `1`: Postdoctoral researcher or Ph.D. student
- `2`: M.S. student
- `3`: Undergraduate student
- `4`: Visitor

People with the same `order` are sorted alphabetically by `name`.

Optional fields can be added like this:

```json
{
  "researchInterests": ["Graph algorithms", "Parameterized algorithms"],
  "photo": "name.jpg"
}
```

The `photo` field should be only the file name, such as `taein-oh.png`. Member photos should be stored under `src/assets/members/`; the site imports them automatically through Vite. If `photo` is omitted, the default placeholder is shown. The build fails with a clear error if a referenced photo is missing, uses a path instead of a file name, or has an unsupported extension.

## Add or Edit a Student Seminar Entry

The Student Seminar page currently shows a clean empty state. When the seminar format is decided, site admins should add a simple editable data file structure for seminar organizers to maintain.

## Add or Edit a Study Group Entry

The Ongoing Study Groups page currently shows a clean empty state. When the study group format is decided, site admins should add a simple editable data file structure for study group organizers to maintain.
