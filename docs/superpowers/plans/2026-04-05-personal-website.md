# samnichols.dev Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dual-purpose personal website (portfolio + freelance web design services) as a static site hosted on GitHub Pages.

**Architecture:** Five HTML pages sharing a single CSS stylesheet and one JS file. CSS custom properties define the Ocean Teal theme. No build step — files served as-is from the repo root.

**Tech Stack:** HTML5, CSS3 (custom properties, grid, flexbox), vanilla JavaScript, EmailJS CDN

---

## File Map

| File | Responsibility |
|------|---------------|
| `css/style.css` | All styles: reset, custom properties, layout, nav, footer, page-specific sections, responsive breakpoints |
| `js/main.js` | Mobile nav toggle, style picker expand/select, EmailJS form submission |
| `index.html` | Landing page — hero with dual CTAs |
| `about.html` | Bio page — headshot placeholder + first-person story |
| `projects.html` | Project card grid with placeholder cards |
| `resume.html` | Timeline resume + PDF download button |
| `services.html` | Style showcase (expand on click) + contact form (EmailJS) |
| `assets/images/.gitkeep` | Placeholder for future images |
| `assets/resume.pdf` | Placeholder PDF (user replaces later) |
| `CNAME` | GitHub Pages custom domain |
| `.gitignore` | Ignore .superpowers/, .DS_Store, etc. |

---

### Task 1: Project Scaffolding and CSS Foundation

**Files:**
- Create: `css/style.css`
- Create: `.gitignore`
- Create: `assets/images/.gitkeep`

- [ ] **Step 1: Create .gitignore**

```
.superpowers/
.DS_Store
Thumbs.db
*.swp
```

- [ ] **Step 2: Create assets directory placeholder**

Create `assets/images/.gitkeep` (empty file) so the directory is tracked by git.

- [ ] **Step 3: Create css/style.css with reset, custom properties, and shared layout**

```css
/* ===== Reset ===== */
*,
*::before,
*::after {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

/* ===== Custom Properties ===== */
:root {
  --color-dark: #1a2f3d;
  --color-mid: #3d7a8a;
  --color-light: #7fbcc8;
  --color-bg: #f3f8f8;
  --color-surface: #ffffff;
  --color-border: #cddfe3;
  --font-stack: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --max-width: 1100px;
  --radius: 10px;
  --shadow: 0 2px 12px rgba(26, 47, 61, 0.08);
}

html {
  scroll-behavior: smooth;
}

body {
  font-family: var(--font-stack);
  background: var(--color-bg);
  color: var(--color-dark);
  line-height: 1.6;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

a {
  color: var(--color-mid);
  text-decoration: none;
}

a:hover {
  color: var(--color-dark);
}

img {
  max-width: 100%;
  display: block;
}

/* ===== Navigation ===== */
.nav {
  position: sticky;
  top: 0;
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-border);
  z-index: 100;
  padding: 0 24px;
}

.nav-inner {
  max-width: var(--max-width);
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 64px;
}

.nav-logo {
  font-size: 1.2rem;
  font-weight: 700;
  color: var(--color-dark);
}

.nav-links {
  display: flex;
  gap: 28px;
  list-style: none;
}

.nav-links a {
  color: var(--color-dark);
  font-size: 0.95rem;
  padding: 4px 0;
  border-bottom: 2px solid transparent;
  transition: border-color 0.2s, color 0.2s;
}

.nav-links a:hover,
.nav-links a.active {
  color: var(--color-mid);
  border-bottom-color: var(--color-mid);
}

.nav-hamburger {
  display: none;
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px;
}

.nav-hamburger span {
  display: block;
  width: 24px;
  height: 2px;
  background: var(--color-dark);
  margin: 5px 0;
  border-radius: 2px;
  transition: transform 0.3s, opacity 0.3s;
}

/* ===== Footer ===== */
.footer {
  margin-top: auto;
  background: var(--color-dark);
  color: var(--color-border);
  text-align: center;
  padding: 24px;
  font-size: 0.85rem;
}

.footer a {
  color: var(--color-light);
}

.footer a:hover {
  color: var(--color-surface);
}

.footer-links {
  display: flex;
  justify-content: center;
  gap: 20px;
  margin-bottom: 8px;
}

/* ===== Utility ===== */
.container {
  max-width: var(--max-width);
  margin: 0 auto;
  padding: 0 24px;
}

.section {
  padding: 60px 0;
}

.btn {
  display: inline-block;
  padding: 12px 28px;
  border-radius: var(--radius);
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s, color 0.2s, border-color 0.2s;
  border: 2px solid transparent;
  text-align: center;
}

.btn-primary {
  background: var(--color-dark);
  color: var(--color-bg);
  border-color: var(--color-dark);
}

.btn-primary:hover {
  background: var(--color-mid);
  border-color: var(--color-mid);
  color: var(--color-surface);
}

.btn-secondary {
  background: transparent;
  color: var(--color-dark);
  border-color: var(--color-dark);
}

.btn-secondary:hover {
  background: var(--color-dark);
  color: var(--color-bg);
}

.pill {
  display: inline-block;
  background: var(--color-light);
  color: var(--color-dark);
  padding: 4px 12px;
  border-radius: 20px;
  font-size: 0.8rem;
  font-weight: 500;
}

/* ===== Responsive ===== */
@media (max-width: 768px) {
  .nav-links {
    display: none;
    flex-direction: column;
    position: absolute;
    top: 64px;
    right: 0;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 0 0 var(--radius) var(--radius);
    padding: 16px 24px;
    gap: 16px;
    box-shadow: var(--shadow);
  }

  .nav-links.open {
    display: flex;
  }

  .nav-hamburger {
    display: block;
  }

  .section {
    padding: 40px 0;
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add .gitignore css/style.css assets/images/.gitkeep
git commit -m "feat: scaffold project with CSS foundation, nav, footer, and responsive base"
```

---

### Task 2: Landing Page

**Files:**
- Create: `index.html`

- [ ] **Step 1: Create index.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sam Nichols — Software Engineer & Web Designer</title>
  <meta name="description" content="Software engineer and bioinformatician building tools for science. Web designer building sites for small businesses.">
  <link rel="stylesheet" href="css/style.css">
</head>
<body>

  <nav class="nav">
    <div class="nav-inner">
      <a href="index.html" class="nav-logo">Sam Nichols</a>
      <button class="nav-hamburger" aria-label="Toggle menu">
        <span></span><span></span><span></span>
      </button>
      <ul class="nav-links">
        <li><a href="about.html">About</a></li>
        <li><a href="projects.html">Projects</a></li>
        <li><a href="resume.html">Resume</a></li>
        <li><a href="services.html">Services</a></li>
      </ul>
    </div>
  </nav>

  <main class="hero">
    <h1 class="hero-name">Sam Nichols</h1>
    <p class="hero-tagline">Building tools for science. Building sites for business.</p>
    <div class="hero-ctas">
      <a href="projects.html" class="btn btn-primary">View My Work</a>
      <a href="services.html" class="btn btn-secondary">Need a Website?</a>
    </div>
  </main>

  <footer class="footer">
    <div class="footer-links">
      <a href="https://github.com/samnichols" target="_blank" rel="noopener">GitHub</a>
      <a href="mailto:sam@samnichols.dev">Email</a>
    </div>
    <p>&copy; 2026 Sam Nichols</p>
  </footer>

  <script src="js/main.js"></script>
</body>
</html>
```

- [ ] **Step 2: Add hero styles to css/style.css**

Append to `css/style.css`:

```css
/* ===== Hero (Landing Page) ===== */
.hero {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 40px 24px;
  min-height: calc(100vh - 64px - 73px);
}

.hero-name {
  font-size: 3rem;
  font-weight: 700;
  color: var(--color-dark);
  margin-bottom: 12px;
}

.hero-tagline {
  font-size: 1.2rem;
  color: var(--color-mid);
  margin-bottom: 36px;
  max-width: 500px;
}

.hero-ctas {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  justify-content: center;
}

@media (max-width: 768px) {
  .hero-name {
    font-size: 2.2rem;
  }

  .hero-tagline {
    font-size: 1rem;
  }
}
```

- [ ] **Step 3: Create js/main.js with mobile nav toggle**

```javascript
// ===== Mobile Nav Toggle =====
document.addEventListener('DOMContentLoaded', function () {
  var hamburger = document.querySelector('.nav-hamburger');
  var navLinks = document.querySelector('.nav-links');

  if (hamburger && navLinks) {
    hamburger.addEventListener('click', function () {
      navLinks.classList.toggle('open');
    });
  }
});
```

- [ ] **Step 4: Open index.html in a browser to verify**

Run: `open index.html` (macOS) or open the file manually in a browser. Verify:
- Hero is vertically centered
- Both CTAs display side by side
- Nav shows all links on desktop
- Hamburger appears and works on mobile (resize browser)
- Ocean Teal palette is applied

- [ ] **Step 5: Commit**

```bash
git add index.html css/style.css js/main.js
git commit -m "feat: add landing page with centered hero and dual CTAs"
```

---

### Task 3: About Page

**Files:**
- Create: `about.html`
- Modify: `css/style.css` (append about-page styles)

- [ ] **Step 1: Create about.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>About — Sam Nichols</title>
  <meta name="description" content="Learn about Sam Nichols — software engineer, bioinformatician, and freelance web designer.">
  <link rel="stylesheet" href="css/style.css">
</head>
<body>

  <nav class="nav">
    <div class="nav-inner">
      <a href="index.html" class="nav-logo">Sam Nichols</a>
      <button class="nav-hamburger" aria-label="Toggle menu">
        <span></span><span></span><span></span>
      </button>
      <ul class="nav-links">
        <li><a href="about.html" class="active">About</a></li>
        <li><a href="projects.html">Projects</a></li>
        <li><a href="resume.html">Resume</a></li>
        <li><a href="services.html">Services</a></li>
      </ul>
    </div>
  </nav>

  <main class="container section">
    <div class="about">
      <div class="about-photo">
        <div class="about-photo-placeholder">Photo</div>
      </div>
      <div class="about-text">
        <h1>Hi, I'm Sam.</h1>
        <p>
          I'm a software engineer and bioinformatician who loves building things that make a difference — whether that's a pipeline analyzing genomic data or a clean, fast website for a local business.
        </p>
        <p>
          By day, I work at the intersection of biology and computer science, writing software that helps researchers make sense of complex data. On the side, I design and build websites for small businesses who want a strong online presence without the agency price tag.
        </p>
        <p>
          I believe great software — and great websites — should be simple, fast, and built with care. If you're a recruiter or hiring manager, check out <a href="projects.html">my projects</a> and <a href="resume.html">resume</a>. If you're a business owner looking for a website, <a href="services.html">let's talk</a>.
        </p>
      </div>
    </div>
  </main>

  <footer class="footer">
    <div class="footer-links">
      <a href="https://github.com/samnichols" target="_blank" rel="noopener">GitHub</a>
      <a href="mailto:sam@samnichols.dev">Email</a>
    </div>
    <p>&copy; 2026 Sam Nichols</p>
  </footer>

  <script src="js/main.js"></script>
</body>
</html>
```

- [ ] **Step 2: Append about-page styles to css/style.css**

```css
/* ===== About Page ===== */
.about {
  max-width: 700px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 32px;
}

.about-photo-placeholder {
  width: 180px;
  height: 180px;
  border-radius: 50%;
  background: var(--color-border);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-mid);
  font-size: 0.9rem;
}

.about-text h1 {
  font-size: 2rem;
  margin-bottom: 16px;
  color: var(--color-dark);
}

.about-text p {
  margin-bottom: 16px;
  font-size: 1.05rem;
  color: var(--color-dark);
  line-height: 1.7;
}
```

- [ ] **Step 3: Verify in browser**

Open `about.html`. Verify: photo placeholder circle centered, text readable at ~700px width, nav shows "About" as active.

- [ ] **Step 4: Commit**

```bash
git add about.html css/style.css
git commit -m "feat: add about page with bio and headshot placeholder"
```

---

### Task 4: Projects Page

**Files:**
- Create: `projects.html`
- Modify: `css/style.css` (append project card styles)

- [ ] **Step 1: Create projects.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Projects — Sam Nichols</title>
  <meta name="description" content="Software engineering and bioinformatics projects by Sam Nichols.">
  <link rel="stylesheet" href="css/style.css">
</head>
<body>

  <nav class="nav">
    <div class="nav-inner">
      <a href="index.html" class="nav-logo">Sam Nichols</a>
      <button class="nav-hamburger" aria-label="Toggle menu">
        <span></span><span></span><span></span>
      </button>
      <ul class="nav-links">
        <li><a href="about.html">About</a></li>
        <li><a href="projects.html" class="active">Projects</a></li>
        <li><a href="resume.html">Resume</a></li>
        <li><a href="services.html">Services</a></li>
      </ul>
    </div>
  </nav>

  <main class="container section">
    <h1 class="page-title">Projects</h1>
    <p class="page-subtitle">A selection of things I've built — from genomics pipelines to web applications.</p>

    <div class="project-grid">

      <a href="#" class="project-card" target="_blank" rel="noopener">
        <div class="project-thumb">
          <div class="project-thumb-placeholder">Screenshot</div>
        </div>
        <div class="project-info">
          <h3>Genomic Variant Pipeline</h3>
          <p>Automated pipeline for calling and annotating genomic variants from next-gen sequencing data.</p>
          <div class="project-tags">
            <span class="pill">Python</span>
            <span class="pill">Snakemake</span>
            <span class="pill">Bioinformatics</span>
          </div>
        </div>
      </a>

      <a href="#" class="project-card" target="_blank" rel="noopener">
        <div class="project-thumb">
          <div class="project-thumb-placeholder">Screenshot</div>
        </div>
        <div class="project-info">
          <h3>RNA-Seq Dashboard</h3>
          <p>Interactive web dashboard for exploring differential gene expression results across experiments.</p>
          <div class="project-tags">
            <span class="pill">R</span>
            <span class="pill">Shiny</span>
            <span class="pill">D3.js</span>
          </div>
        </div>
      </a>

      <a href="#" class="project-card" target="_blank" rel="noopener">
        <div class="project-thumb">
          <div class="project-thumb-placeholder">Screenshot</div>
        </div>
        <div class="project-info">
          <h3>Local Business Website</h3>
          <p>Responsive website for a local restaurant featuring online menu, reservations, and gallery.</p>
          <div class="project-tags">
            <span class="pill">HTML</span>
            <span class="pill">CSS</span>
            <span class="pill">JavaScript</span>
          </div>
        </div>
      </a>

      <a href="#" class="project-card" target="_blank" rel="noopener">
        <div class="project-thumb">
          <div class="project-thumb-placeholder">Screenshot</div>
        </div>
        <div class="project-info">
          <h3>Sequence Alignment Tool</h3>
          <p>Web-based tool for pairwise and multiple sequence alignment with visual output.</p>
          <div class="project-tags">
            <span class="pill">Python</span>
            <span class="pill">Flask</span>
            <span class="pill">Biopython</span>
          </div>
        </div>
      </a>

    </div>
  </main>

  <footer class="footer">
    <div class="footer-links">
      <a href="https://github.com/samnichols" target="_blank" rel="noopener">GitHub</a>
      <a href="mailto:sam@samnichols.dev">Email</a>
    </div>
    <p>&copy; 2026 Sam Nichols</p>
  </footer>

  <script src="js/main.js"></script>
</body>
</html>
```

- [ ] **Step 2: Append project styles to css/style.css**

```css
/* ===== Page Titles ===== */
.page-title {
  font-size: 2rem;
  margin-bottom: 8px;
  color: var(--color-dark);
}

.page-subtitle {
  color: var(--color-mid);
  margin-bottom: 40px;
  font-size: 1.05rem;
}

/* ===== Projects Page ===== */
.project-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 24px;
}

.project-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  overflow: hidden;
  box-shadow: var(--shadow);
  transition: transform 0.2s, box-shadow 0.2s;
  color: var(--color-dark);
  display: flex;
  flex-direction: column;
}

.project-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 6px 20px rgba(26, 47, 61, 0.12);
  color: var(--color-dark);
}

.project-thumb {
  background: var(--color-border);
  height: 160px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.project-thumb-placeholder {
  color: var(--color-mid);
  font-size: 0.9rem;
}

.project-info {
  padding: 20px;
  flex: 1;
  display: flex;
  flex-direction: column;
}

.project-info h3 {
  font-size: 1.1rem;
  margin-bottom: 8px;
}

.project-info p {
  font-size: 0.9rem;
  line-height: 1.5;
  color: var(--color-mid);
  margin-bottom: 12px;
  flex: 1;
}

.project-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

@media (max-width: 1024px) {
  .project-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 768px) {
  .project-grid {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 3: Verify in browser**

Open `projects.html`. Verify: 3-column grid on desktop, 2 on tablet, 1 on mobile. Cards have hover lift effect. Pills display correctly.

- [ ] **Step 4: Commit**

```bash
git add projects.html css/style.css
git commit -m "feat: add projects page with responsive card grid"
```

---

### Task 5: Resume Page

**Files:**
- Create: `resume.html`
- Create: `assets/resume.pdf` (placeholder)
- Modify: `css/style.css` (append resume styles)

- [ ] **Step 1: Create a placeholder resume.pdf**

Create a minimal placeholder file at `assets/resume.pdf`. The user will replace this with their real resume.

```bash
echo "Placeholder — replace with real resume" > assets/resume.pdf
```

- [ ] **Step 2: Create resume.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Resume — Sam Nichols</title>
  <meta name="description" content="Resume of Sam Nichols — software engineer and bioinformatician.">
  <link rel="stylesheet" href="css/style.css">
</head>
<body>

  <nav class="nav">
    <div class="nav-inner">
      <a href="index.html" class="nav-logo">Sam Nichols</a>
      <button class="nav-hamburger" aria-label="Toggle menu">
        <span></span><span></span><span></span>
      </button>
      <ul class="nav-links">
        <li><a href="about.html">About</a></li>
        <li><a href="projects.html">Projects</a></li>
        <li><a href="resume.html" class="active">Resume</a></li>
        <li><a href="services.html">Services</a></li>
      </ul>
    </div>
  </nav>

  <main class="container section">
    <div class="resume-header">
      <h1 class="page-title">Resume</h1>
      <a href="assets/resume.pdf" class="btn btn-primary" download>Download PDF</a>
    </div>

    <div class="resume">

      <section class="resume-section">
        <h2>Experience</h2>
        <div class="timeline">

          <div class="timeline-item">
            <div class="timeline-marker"></div>
            <div class="timeline-content">
              <div class="timeline-header">
                <h3>Bioinformatics Software Engineer</h3>
                <span class="timeline-date">2023 — Present</span>
              </div>
              <p class="timeline-company">Company Name</p>
              <p>Developed and maintained genomic analysis pipelines processing terabytes of sequencing data. Built internal tools for researchers to visualize and interact with experimental results.</p>
            </div>
          </div>

          <div class="timeline-item">
            <div class="timeline-marker"></div>
            <div class="timeline-content">
              <div class="timeline-header">
                <h3>Freelance Web Designer</h3>
                <span class="timeline-date">2022 — Present</span>
              </div>
              <p class="timeline-company">Self-employed</p>
              <p>Designed and built responsive websites for small businesses including restaurants, retail shops, and service providers. Focused on clean design, fast performance, and easy maintenance.</p>
            </div>
          </div>

          <div class="timeline-item">
            <div class="timeline-marker"></div>
            <div class="timeline-content">
              <div class="timeline-header">
                <h3>Research Assistant</h3>
                <span class="timeline-date">2021 — 2023</span>
              </div>
              <p class="timeline-company">University Name</p>
              <p>Supported computational biology research by developing scripts for data processing, statistical analysis, and visualization of high-throughput experimental data.</p>
            </div>
          </div>

        </div>
      </section>

      <section class="resume-section">
        <h2>Education</h2>
        <div class="timeline">

          <div class="timeline-item">
            <div class="timeline-marker"></div>
            <div class="timeline-content">
              <div class="timeline-header">
                <h3>B.S. in Bioinformatics</h3>
                <span class="timeline-date">2019 — 2023</span>
              </div>
              <p class="timeline-company">University Name</p>
              <p>Coursework in algorithms, data structures, molecular biology, genomics, and statistical computing.</p>
            </div>
          </div>

        </div>
      </section>

      <section class="resume-section">
        <h2>Skills</h2>
        <div class="skills-grid">
          <div class="skills-group">
            <h3>Languages</h3>
            <div class="skills-list">
              <span class="pill">Python</span>
              <span class="pill">R</span>
              <span class="pill">JavaScript</span>
              <span class="pill">HTML/CSS</span>
              <span class="pill">SQL</span>
              <span class="pill">Bash</span>
            </div>
          </div>
          <div class="skills-group">
            <h3>Frameworks & Tools</h3>
            <div class="skills-list">
              <span class="pill">Snakemake</span>
              <span class="pill">Flask</span>
              <span class="pill">Biopython</span>
              <span class="pill">Git</span>
              <span class="pill">Docker</span>
              <span class="pill">Linux</span>
            </div>
          </div>
          <div class="skills-group">
            <h3>Web Design</h3>
            <div class="skills-list">
              <span class="pill">Responsive Design</span>
              <span class="pill">CSS Grid/Flexbox</span>
              <span class="pill">UI/UX</span>
              <span class="pill">SEO</span>
            </div>
          </div>
        </div>
      </section>

    </div>
  </main>

  <footer class="footer">
    <div class="footer-links">
      <a href="https://github.com/samnichols" target="_blank" rel="noopener">GitHub</a>
      <a href="mailto:sam@samnichols.dev">Email</a>
    </div>
    <p>&copy; 2026 Sam Nichols</p>
  </footer>

  <script src="js/main.js"></script>
</body>
</html>
```

- [ ] **Step 3: Append resume styles to css/style.css**

```css
/* ===== Resume Page ===== */
.resume-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 40px;
  flex-wrap: wrap;
  gap: 16px;
}

.resume {
  max-width: 800px;
}

.resume-section {
  margin-bottom: 48px;
}

.resume-section h2 {
  font-size: 1.4rem;
  color: var(--color-mid);
  margin-bottom: 24px;
  padding-bottom: 8px;
  border-bottom: 2px solid var(--color-border);
}

.timeline {
  position: relative;
  padding-left: 28px;
}

.timeline::before {
  content: '';
  position: absolute;
  left: 6px;
  top: 4px;
  bottom: 4px;
  width: 2px;
  background: var(--color-border);
}

.timeline-item {
  position: relative;
  margin-bottom: 32px;
}

.timeline-item:last-child {
  margin-bottom: 0;
}

.timeline-marker {
  position: absolute;
  left: -28px;
  top: 6px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--color-light);
  border: 2px solid var(--color-surface);
  box-shadow: 0 0 0 2px var(--color-light);
}

.timeline-content h3 {
  font-size: 1.1rem;
  color: var(--color-dark);
}

.timeline-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 4px;
}

.timeline-date {
  font-size: 0.85rem;
  color: var(--color-mid);
  white-space: nowrap;
}

.timeline-company {
  font-size: 0.9rem;
  color: var(--color-mid);
  margin-bottom: 8px;
}

.timeline-content p:last-child {
  font-size: 0.95rem;
  line-height: 1.6;
}

.skills-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 24px;
}

.skills-group h3 {
  font-size: 0.95rem;
  color: var(--color-dark);
  margin-bottom: 12px;
}

.skills-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

@media (max-width: 768px) {
  .skills-grid {
    grid-template-columns: 1fr;
  }

  .timeline-header {
    flex-direction: column;
    gap: 2px;
  }
}
```

- [ ] **Step 4: Verify in browser**

Open `resume.html`. Verify: timeline markers and vertical line render, skills pills display in 3 columns on desktop and 1 on mobile, PDF download button works.

- [ ] **Step 5: Commit**

```bash
git add resume.html css/style.css assets/resume.pdf
git commit -m "feat: add resume page with timeline layout and skills grid"
```

---

### Task 6: Services Page — Style Showcase

**Files:**
- Create: `services.html`
- Modify: `css/style.css` (append services styles)
- Modify: `js/main.js` (add style picker logic)

- [ ] **Step 1: Create services.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Services — Sam Nichols</title>
  <meta name="description" content="Web design services for small businesses. Browse design styles and request a custom website.">
  <link rel="stylesheet" href="css/style.css">
</head>
<body>

  <nav class="nav">
    <div class="nav-inner">
      <a href="index.html" class="nav-logo">Sam Nichols</a>
      <button class="nav-hamburger" aria-label="Toggle menu">
        <span></span><span></span><span></span>
      </button>
      <ul class="nav-links">
        <li><a href="about.html">About</a></li>
        <li><a href="projects.html">Projects</a></li>
        <li><a href="resume.html">Resume</a></li>
        <li><a href="services.html" class="active">Services</a></li>
      </ul>
    </div>
  </nav>

  <main class="container section">
    <h1 class="page-title">Web Design Services</h1>
    <p class="page-subtitle">Browse design styles, pick what speaks to you, and let's build something great.</p>

    <!-- Style Picker -->
    <section class="style-picker">
      <div class="style-cards">

        <button class="style-card" data-style="Modern" aria-pressed="false">
          <div class="style-card-preview style-preview-modern">
            <div class="sp-nav">Logo <span>Menu</span></div>
            <div class="sp-hero"><div class="sp-hero-text"></div><div class="sp-hero-btn"></div></div>
            <div class="sp-grid"><div></div><div></div><div></div></div>
          </div>
          <span class="style-card-label">Modern</span>
        </button>

        <button class="style-card" data-style="Classic" aria-pressed="false">
          <div class="style-card-preview style-preview-classic">
            <div class="sp-nav">Logo <span>Menu</span></div>
            <div class="sp-hero"><div class="sp-hero-text"></div><div class="sp-hero-btn"></div></div>
            <div class="sp-cols"><div class="sp-sidebar"></div><div class="sp-main"></div></div>
          </div>
          <span class="style-card-label">Classic</span>
        </button>

        <button class="style-card" data-style="Bold" aria-pressed="false">
          <div class="style-card-preview style-preview-bold">
            <div class="sp-nav">Logo <span>Menu</span></div>
            <div class="sp-hero-full"><div class="sp-hero-text"></div><div class="sp-hero-btn"></div></div>
            <div class="sp-grid"><div></div><div></div></div>
          </div>
          <span class="style-card-label">Bold</span>
        </button>

        <button class="style-card" data-style="Minimal" aria-pressed="false">
          <div class="style-card-preview style-preview-minimal">
            <div class="sp-nav-minimal">Logo</div>
            <div class="sp-hero-minimal"><div class="sp-hero-text"></div></div>
            <div class="sp-content-minimal"><div></div><div></div></div>
          </div>
          <span class="style-card-label">Minimal</span>
        </button>

      </div>

      <!-- Expanded Preview -->
      <div class="style-expanded" id="style-expanded" hidden>
        <div class="style-expanded-inner">
          <h3 class="style-expanded-name"></h3>
          <p class="style-expanded-desc"></p>
          <div class="style-expanded-preview"></div>
          <a href="#contact-form" class="btn btn-primary style-expanded-cta">I Want This Style &rarr;</a>
        </div>
      </div>
    </section>

    <!-- Contact Form -->
    <section class="contact-section" id="contact-form">
      <h2>Let's Build Your Site</h2>
      <p class="page-subtitle">Tell me about your project and I'll get back to you within 48 hours.</p>

      <form class="contact-form" id="contact-form-el">
        <div class="form-row">
          <div class="form-group">
            <label for="name">Name *</label>
            <input type="text" id="name" name="name" required>
          </div>
          <div class="form-group">
            <label for="email">Email *</label>
            <input type="email" id="email" name="email" required>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="business">Business Name *</label>
            <input type="text" id="business" name="business" required>
          </div>
          <div class="form-group">
            <label for="site-type">Type of Site Needed</label>
            <select id="site-type" name="site_type">
              <option value="">Select...</option>
              <option value="business">Business Website</option>
              <option value="portfolio">Portfolio</option>
              <option value="ecommerce">E-commerce</option>
              <option value="blog">Blog</option>
              <option value="other">Other</option>
            </select>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="budget">Budget Range</label>
            <select id="budget" name="budget">
              <option value="">Select...</option>
              <option value="under-500">Under $500</option>
              <option value="500-1000">$500 — $1,000</option>
              <option value="1000-2500">$1,000 — $2,500</option>
              <option value="2500-plus">$2,500+</option>
            </select>
          </div>
          <div class="form-group">
            <label for="timeline">Timeline</label>
            <select id="timeline" name="timeline">
              <option value="">Select...</option>
              <option value="asap">ASAP</option>
              <option value="1-2-months">1–2 months</option>
              <option value="3-plus-months">3+ months</option>
              <option value="flexible">Flexible</option>
            </select>
          </div>
        </div>

        <div class="form-group">
          <label for="style-pref">Preferred Design Style</label>
          <input type="text" id="style-pref" name="style_preference" placeholder="Click a style above, or type your own">
        </div>

        <div class="form-group">
          <label for="current-url">Current Website URL (if any)</label>
          <input type="url" id="current-url" name="current_url" placeholder="https://...">
        </div>

        <div class="form-group">
          <label for="message">Message / Additional Details</label>
          <textarea id="message" name="message" rows="5" placeholder="Tell me about your business and what you're looking for..."></textarea>
        </div>

        <button type="submit" class="btn btn-primary form-submit">Send Request</button>
      </form>

      <div class="form-success" id="form-success" hidden>
        <h3>Thanks for reaching out!</h3>
        <p>I'll review your request and get back to you within 48 hours.</p>
      </div>

      <div class="form-error" id="form-error" hidden>
        <p>Something went wrong. Please try again or email me directly at <a href="mailto:sam@samnichols.dev">sam@samnichols.dev</a>.</p>
        <button class="btn btn-secondary" id="form-retry">Try Again</button>
      </div>
    </section>
  </main>

  <footer class="footer">
    <div class="footer-links">
      <a href="https://github.com/samnichols" target="_blank" rel="noopener">GitHub</a>
      <a href="mailto:sam@samnichols.dev">Email</a>
    </div>
    <p>&copy; 2026 Sam Nichols</p>
  </footer>

  <script src="https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js"></script>
  <script src="js/main.js"></script>
</body>
</html>
```

- [ ] **Step 2: Append services and form styles to css/style.css**

```css
/* ===== Services — Style Picker ===== */
.style-cards {
  display: flex;
  gap: 16px;
  overflow-x: auto;
  padding-bottom: 8px;
  margin-bottom: 24px;
}

.style-card {
  flex: 0 0 180px;
  background: var(--color-surface);
  border: 2px solid var(--color-border);
  border-radius: var(--radius);
  padding: 12px;
  cursor: pointer;
  text-align: center;
  transition: border-color 0.2s, box-shadow 0.2s;
  font-family: inherit;
  font-size: inherit;
  color: inherit;
}

.style-card:hover {
  border-color: var(--color-mid);
}

.style-card[aria-pressed="true"] {
  border-color: var(--color-mid);
  box-shadow: 0 0 0 3px rgba(61, 122, 138, 0.2);
}

.style-card-preview {
  height: 120px;
  border-radius: 6px;
  margin-bottom: 8px;
  padding: 8px;
  overflow: hidden;
}

.style-card-label {
  font-weight: 600;
  font-size: 0.9rem;
  color: var(--color-dark);
}

/* Mini mockup building blocks */
.sp-nav {
  display: flex;
  justify-content: space-between;
  font-size: 6px;
  margin-bottom: 6px;
  padding: 2px 4px;
  border-radius: 2px;
}

.sp-hero {
  text-align: center;
  padding: 8px 0;
  margin-bottom: 6px;
}

.sp-hero-text {
  height: 4px;
  width: 60%;
  margin: 0 auto 4px;
  border-radius: 2px;
}

.sp-hero-btn {
  height: 6px;
  width: 30%;
  margin: 0 auto;
  border-radius: 3px;
}

.sp-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 3px;
}

.sp-grid div {
  height: 20px;
  border-radius: 2px;
}

.sp-cols {
  display: flex;
  gap: 3px;
}

.sp-sidebar {
  width: 30%;
  height: 30px;
  border-radius: 2px;
}

.sp-main {
  flex: 1;
  height: 30px;
  border-radius: 2px;
}

/* Modern style preview */
.style-preview-modern {
  background: #1a1a2e;
}

.style-preview-modern .sp-nav {
  color: #e0e0e0;
  background: rgba(255, 255, 255, 0.05);
}

.style-preview-modern .sp-hero-text {
  background: #e0e0e0;
}

.style-preview-modern .sp-hero-btn {
  background: #4a9ff5;
}

.style-preview-modern .sp-grid div {
  background: rgba(255, 255, 255, 0.08);
}

/* Classic style preview */
.style-preview-classic {
  background: #faf5ee;
}

.style-preview-classic .sp-nav {
  color: #5c4a32;
  background: rgba(92, 74, 50, 0.08);
}

.style-preview-classic .sp-hero-text {
  background: #5c4a32;
}

.style-preview-classic .sp-hero-btn {
  background: #8b6914;
}

.style-preview-classic .sp-sidebar {
  background: rgba(92, 74, 50, 0.1);
}

.style-preview-classic .sp-main {
  background: rgba(92, 74, 50, 0.05);
}

/* Bold style preview */
.style-preview-bold {
  background: #ff6b35;
}

.style-preview-bold .sp-nav {
  color: #fff;
  background: rgba(255, 255, 255, 0.15);
}

.style-preview-bold .sp-hero-full {
  text-align: center;
  padding: 12px 0;
  margin-bottom: 6px;
}

.style-preview-bold .sp-hero-full .sp-hero-text {
  background: #fff;
  height: 4px;
  width: 60%;
  margin: 0 auto 4px;
  border-radius: 2px;
}

.style-preview-bold .sp-hero-full .sp-hero-btn {
  background: #1a1a2e;
  height: 6px;
  width: 30%;
  margin: 0 auto;
  border-radius: 3px;
}

.style-preview-bold .sp-grid {
  grid-template-columns: repeat(2, 1fr);
}

.style-preview-bold .sp-grid div {
  background: rgba(255, 255, 255, 0.2);
}

/* Minimal style preview */
.style-preview-minimal {
  background: #ffffff;
  border: 1px solid #eee;
}

.sp-nav-minimal {
  font-size: 7px;
  color: #333;
  padding: 2px 4px;
  margin-bottom: 10px;
}

.sp-hero-minimal {
  text-align: center;
  padding: 14px 0;
  margin-bottom: 6px;
}

.sp-hero-minimal .sp-hero-text {
  background: #333;
  height: 3px;
  width: 40%;
  margin: 0 auto;
  border-radius: 2px;
}

.sp-content-minimal {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0 12px;
}

.sp-content-minimal div {
  height: 3px;
  background: #ddd;
  border-radius: 2px;
}

.sp-content-minimal div:last-child {
  width: 70%;
}

/* Expanded preview */
.style-expanded {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 32px;
  margin-bottom: 48px;
  box-shadow: var(--shadow);
}

.style-expanded-inner {
  max-width: 600px;
  margin: 0 auto;
  text-align: center;
}

.style-expanded-name {
  font-size: 1.4rem;
  margin-bottom: 8px;
  color: var(--color-dark);
}

.style-expanded-desc {
  color: var(--color-mid);
  margin-bottom: 24px;
  line-height: 1.6;
}

.style-expanded-preview {
  height: 200px;
  border-radius: var(--radius);
  margin-bottom: 24px;
  padding: 16px;
  overflow: hidden;
}

.style-expanded-cta {
  display: inline-block;
}

/* ===== Services — Contact Form ===== */
.contact-section {
  padding-top: 48px;
}

.contact-section h2 {
  font-size: 1.6rem;
  margin-bottom: 8px;
  color: var(--color-dark);
}

.contact-form {
  max-width: 700px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 32px;
  box-shadow: var(--shadow);
}

.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-bottom: 16px;
}

.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  font-size: 0.9rem;
  font-weight: 600;
  margin-bottom: 6px;
  color: var(--color-dark);
}

.form-group input,
.form-group select,
.form-group textarea {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-family: var(--font-stack);
  font-size: 0.95rem;
  color: var(--color-dark);
  background: var(--color-bg);
  transition: border-color 0.2s;
}

.form-group input:focus,
.form-group select:focus,
.form-group textarea:focus {
  outline: none;
  border-color: var(--color-mid);
  box-shadow: 0 0 0 3px rgba(61, 122, 138, 0.15);
}

.form-submit {
  width: 100%;
  margin-top: 8px;
}

.form-submit:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.form-success,
.form-error {
  max-width: 700px;
  text-align: center;
  padding: 40px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

.form-success h3 {
  color: var(--color-mid);
  margin-bottom: 8px;
}

.form-error p {
  margin-bottom: 16px;
}

@media (max-width: 768px) {
  .form-row {
    grid-template-columns: 1fr;
  }

  .style-cards {
    gap: 12px;
  }

  .style-card {
    flex: 0 0 150px;
  }

  .style-expanded {
    padding: 20px;
  }
}
```

- [ ] **Step 3: Add style picker and form JavaScript to js/main.js**

Replace the full contents of `js/main.js` with:

```javascript
// ===== Mobile Nav Toggle =====
document.addEventListener('DOMContentLoaded', function () {
  var hamburger = document.querySelector('.nav-hamburger');
  var navLinks = document.querySelector('.nav-links');

  if (hamburger && navLinks) {
    hamburger.addEventListener('click', function () {
      navLinks.classList.toggle('open');
    });
  }

  // ===== Style Picker =====
  var styleCards = document.querySelectorAll('.style-card');
  var expanded = document.getElementById('style-expanded');

  if (styleCards.length > 0 && expanded) {
    var styleData = {
      Modern: {
        desc: 'Clean lines, dark backgrounds, and bold typography. Perfect for tech companies, startups, and creative professionals who want a sleek, contemporary look.',
        bg: '#1a1a2e',
        navColor: '#e0e0e0',
        navBg: 'rgba(255,255,255,0.05)',
        textColor: '#e0e0e0',
        btnBg: '#4a9ff5',
        cardBg: 'rgba(255,255,255,0.08)'
      },
      Classic: {
        desc: 'Warm tones, elegant typography, and a traditional layout with sidebar navigation. Great for established businesses, law firms, and professional services.',
        bg: '#faf5ee',
        navColor: '#5c4a32',
        navBg: 'rgba(92,74,50,0.08)',
        textColor: '#5c4a32',
        btnBg: '#8b6914',
        cardBg: 'rgba(92,74,50,0.08)'
      },
      Bold: {
        desc: 'Vibrant colors, large imagery, and high-energy layouts. Ideal for restaurants, entertainment venues, and brands that want to make a strong first impression.',
        bg: '#ff6b35',
        navColor: '#fff',
        navBg: 'rgba(255,255,255,0.15)',
        textColor: '#fff',
        btnBg: '#1a1a2e',
        cardBg: 'rgba(255,255,255,0.2)'
      },
      Minimal: {
        desc: 'Maximum whitespace, restrained color, and typography-focused design. Perfect for portfolios, writers, and businesses that value simplicity and clarity.',
        bg: '#ffffff',
        navColor: '#333',
        navBg: 'transparent',
        textColor: '#333',
        btnBg: '#333',
        cardBg: '#f5f5f5'
      }
    };

    styleCards.forEach(function (card) {
      card.addEventListener('click', function () {
        var styleName = card.getAttribute('data-style');
        var data = styleData[styleName];

        // Update aria-pressed
        styleCards.forEach(function (c) {
          c.setAttribute('aria-pressed', 'false');
        });
        card.setAttribute('aria-pressed', 'true');

        // Populate expanded preview
        expanded.querySelector('.style-expanded-name').textContent = styleName;
        expanded.querySelector('.style-expanded-desc').textContent = data.desc;

        var preview = expanded.querySelector('.style-expanded-preview');
        preview.style.background = data.bg;
        preview.innerHTML =
          '<div style="display:flex;justify-content:space-between;font-size:10px;color:' + data.navColor + ';background:' + data.navBg + ';padding:4px 8px;border-radius:4px;margin-bottom:12px;">Logo <span>Home &middot; About &middot; Contact</span></div>' +
          '<div style="text-align:center;padding:16px 0;">' +
          '<div style="height:6px;width:50%;margin:0 auto 8px;background:' + data.textColor + ';border-radius:3px;opacity:0.8;"></div>' +
          '<div style="height:4px;width:30%;margin:0 auto 12px;background:' + data.textColor + ';border-radius:3px;opacity:0.4;"></div>' +
          '<div style="height:10px;width:20%;margin:0 auto;background:' + data.btnBg + ';border-radius:5px;"></div>' +
          '</div>' +
          '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;">' +
          '<div style="height:30px;background:' + data.cardBg + ';border-radius:4px;"></div>' +
          '<div style="height:30px;background:' + data.cardBg + ';border-radius:4px;"></div>' +
          '<div style="height:30px;background:' + data.cardBg + ';border-radius:4px;"></div>' +
          '</div>';

        expanded.hidden = false;

        // Auto-fill style preference in form
        var stylePref = document.getElementById('style-pref');
        if (stylePref) {
          stylePref.value = styleName;
        }
      });
    });
  }

  // ===== EmailJS Contact Form =====
  var form = document.getElementById('contact-form-el');
  var formSuccess = document.getElementById('form-success');
  var formError = document.getElementById('form-error');
  var formRetry = document.getElementById('form-retry');

  // TODO: Replace these with your actual EmailJS IDs
  var EMAILJS_PUBLIC_KEY = 'YOUR_PUBLIC_KEY';
  var EMAILJS_SERVICE_ID = 'YOUR_SERVICE_ID';
  var EMAILJS_TEMPLATE_ID = 'YOUR_TEMPLATE_ID';

  if (typeof emailjs !== 'undefined') {
    emailjs.init(EMAILJS_PUBLIC_KEY);
  }

  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();

      var submitBtn = form.querySelector('.form-submit');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending...';

      if (typeof emailjs === 'undefined') {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send Request';
        form.hidden = true;
        formError.hidden = false;
        return;
      }

      emailjs.sendForm(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, form)
        .then(function () {
          form.hidden = true;
          formSuccess.hidden = false;
        })
        .catch(function () {
          form.hidden = true;
          formError.hidden = false;
        });
    });
  }

  if (formRetry) {
    formRetry.addEventListener('click', function () {
      formError.hidden = true;
      form.hidden = false;
      var submitBtn = form.querySelector('.form-submit');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send Request';
    });
  }
});
```

- [ ] **Step 4: Verify in browser**

Open `services.html`. Verify:
- Four style cards display horizontally
- Clicking a card expands the preview below with correct colors and description
- "I Want This Style" scrolls to form and the style preference field is auto-filled
- Form validates required fields (name, email, business)
- Form submit shows "Sending..." (will fail without real EmailJS keys — that's expected)

- [ ] **Step 5: Commit**

```bash
git add services.html css/style.css js/main.js
git commit -m "feat: add services page with style picker and contact form"
```

---

### Task 7: CNAME and Final Polish

**Files:**
- Create: `CNAME`
- Modify: `css/style.css` (any final tweaks)

- [ ] **Step 1: Create CNAME file**

```
samnichols.dev
```

- [ ] **Step 2: Verify all page links work**

Open each page in the browser and click through all navigation links:
- `index.html` → all nav links and both CTAs
- `about.html` → in-text links to projects, resume, services
- `projects.html` → card links (placeholder `#` is fine)
- `resume.html` → PDF download button
- `services.html` → style picker → form flow

Verify mobile nav hamburger works on all pages.

- [ ] **Step 3: Commit**

```bash
git add CNAME
git commit -m "feat: add CNAME for samnichols.dev and verify all navigation"
```

---

### Task 8: Rename branch to main

**Files:** None (git operation only)

- [ ] **Step 1: Rename master to main**

```bash
git branch -m master main
```

This ensures the repo uses `main` as the default branch, which is what GitHub Pages expects by default.

- [ ] **Step 2: Verify**

```bash
git log --oneline
git branch
```

Expected: all commits present on `main` branch.
