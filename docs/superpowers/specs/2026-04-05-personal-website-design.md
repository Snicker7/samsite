# Personal Website Design Spec — samnichols.dev

## Overview

A dual-purpose personal website for Sam Nichols, hosted on GitHub Pages. The site serves two audiences:

1. **Employers/recruiters** — view projects, resume, background, and education
2. **Small business owners** — browse web design styles and submit a site creation request

**Domain:** samnichols.dev
**Hosting:** GitHub Pages
**Tech:** Plain HTML, CSS, and vanilla JavaScript — no frameworks, no build step

## Site Structure

```
samnichols.dev/
├── index.html          — Landing page (hero + dual CTA)
├── about.html          — Bio, background, story
├── projects.html       — Portfolio of personal/bioinformatics projects
├── resume.html         — Education, experience, skills + PDF download
├── services.html       — Design style showcase + contact form
├── css/
│   └── style.css       — Single stylesheet with CSS custom properties
├── js/
│   └── main.js         — Style picker, EmailJS form, mobile nav
├── assets/
│   ├── images/         — Project screenshots, design previews, headshot
│   └── resume.pdf      — Downloadable resume
└── CNAME               — Custom domain config for GitHub Pages
```

## Visual Design

### Style
- Warm and approachable
- Rounded corners, generous whitespace, soft shadows
- Friendly but professional

### Color Palette — Ocean Teal
| Token              | Hex       | Usage                          |
|--------------------|-----------|--------------------------------|
| `--color-dark`     | `#1a2f3d` | Primary text, dark backgrounds |
| `--color-mid`      | `#3d7a8a` | Secondary text, accents        |
| `--color-light`    | `#7fbcc8` | Highlights, tags, decorative   |
| `--color-bg`       | `#f3f8f8` | Page background                |
| `--color-surface`  | `#ffffff` | Cards, form backgrounds        |
| `--color-border`   | `#cddfe3` | Borders, dividers              |

### Typography
- System font stack: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
- No web font dependencies — fast loading

## Pages

### Landing Page (`index.html`)
- **Layout:** Centered hero, full viewport height
- **Heading:** "Sam Nichols"
- **Tagline:** "Building tools for science. Building sites for business."
- **CTAs:** Two side-by-side buttons
  - "View My Work" → links to `projects.html`
  - "Need a Website?" → links to `services.html`
- **No additional content** below the fold — clean and focused

### About Page (`about.html`)
- **Content:** First-person bio bridging bioinformatics and web design
- **Photo:** Headshot placeholder (user provides later)
- **Tone:** Casual, warm, conversational
- **Layout:** Single column, readable width (~700px max)

### Projects Page (`projects.html`)
- **Layout:** Responsive card grid (3 columns desktop, 2 tablet, 1 mobile)
- **Each card:** Screenshot/thumbnail, project title, short description, tech tags (styled pills)
- **Interaction:** Cards link to GitHub repo or live demo
- **Initial state:** 3-4 placeholder project cards; user populates with real data

### Resume Page (`resume.html`)
- **Layout:** Clean single-column, timeline-style for work history
- **Sections:** Experience, Education, Skills
- **Skills display:** Grouped by category (Languages, Frameworks, Tools, etc.) as styled pills
- **PDF download:** Prominent "Download PDF" button at top, links to `assets/resume.pdf`

### Services Page (`services.html`)
- **Section 1 — Style Showcase:**
  - Horizontal row of design style cards (3-4 styles, e.g., "Modern", "Classic", "Bold", "Minimal")
  - Each card has a small CSS-rendered mockup thumbnail and style name (built as inline HTML/CSS, not screenshot images — these represent design directions Sam offers, not past client work)
  - Clicking a card expands a larger preview below the row with more detail
  - Expanded preview includes a "I Want This Style →" CTA button
- **Section 2 — Contact Form:**
  - Scrolled to when CTA is clicked; selected style auto-populates the style preference field
  - **Fields:**
    - Name (text, required)
    - Email (email, required)
    - Business name (text, required)
    - Type of site needed (select: Business website, Portfolio, E-commerce, Blog, Other)
    - Budget range (select: <$500, $500-$1000, $1000-$2500, $2500+)
    - Timeline (select: ASAP, 1-2 months, 3+ months, Flexible)
    - Preferred design style (text, auto-filled from style picker, editable)
    - Current website URL (text, optional)
    - Message / additional details (textarea)
  - **Submission:** EmailJS — client-side email delivery, no backend
  - **Success state:** Inline confirmation message replacing the form
  - **Error state:** Inline error message with retry option

## Shared Components

### Navigation
- **Desktop:** Logo/name left-aligned, links right-aligned (About, Projects, Resume, Services)
- **Mobile:** Hamburger menu icon, slides in from right or drops down
- **Active page** indicated with underline or color change
- **Sticky** at the top of the page

### Footer
- Simple, single row: Name, GitHub link, email link, copyright year
- Muted styling — not a focal point

## Responsive Behavior
- **Breakpoints:** Mobile (<768px), Tablet (768-1024px), Desktop (>1024px)
- **Mobile nav:** Hamburger with slide/dropdown menu
- **Project grid:** 3 → 2 → 1 columns
- **Style cards:** Horizontal scroll on mobile if needed
- **Form:** Full-width inputs on mobile

## EmailJS Integration
- EmailJS SDK loaded via CDN script tag
- Service and template IDs stored as constants in `main.js`
- Form submission intercepted with `addEventListener('submit', ...)` — prevents default, calls EmailJS `sendForm()`
- Loading state on submit button during send
- Success/error messages displayed inline

## Performance Goals
- No build step — files served as-is
- No web fonts — system font stack
- Minimal JavaScript — only for style picker interaction, mobile nav toggle, and form submission
- Images optimized manually before adding to `assets/images/`
- Target: <1s first contentful paint on GitHub Pages

## Deployment
- GitHub repository, `main` branch
- GitHub Pages enabled, serves from root
- `CNAME` file for custom domain `samnichols.dev`
- DNS: A records pointing to GitHub Pages IPs, CNAME for `www` subdomain
