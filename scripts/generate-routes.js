#!/usr/bin/env node
/**
 * generate-routes.js
 *
 * GitHub Pages serves static files only — there's no server to run per-item
 * routes. This script pre-builds them at deploy time instead: for every
 * project, blog post, and research entry defined in the `data` object inside
 * index.html, it writes a real file at /<category>/<slug>/index.html.
 *
 * Each generated file is a full copy of index.html (same app, same visuals,
 * same JS) with just the <head> swapped for that item: unique <title>,
 * meta description, canonical URL, Open Graph / Twitter tags, and a
 * type-appropriate JSON-LD block — plus a tiny inline `window.__ROUTE__`
 * hint so the page's own routing JS (see index.html) auto-opens the right
 * modal on load instead of showing the bare homepage.
 *
 * This means:
 *  - Non-JS crawlers (Facebook, LinkedIn, Twitter/X bots, Slack unfurls)
 *    see the correct title/description/image for THAT item, not the homepage's.
 *  - Google can index and rank each project/post as its own URL.
 *  - Visiting the URL directly opens straight into the right modal.
 *
 * Run this before every deploy (see .github/workflows/deploy.yml for a
 * GitHub Actions setup that runs it automatically on every push to main).
 *
 * Usage:  node scripts/generate-routes.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const INDEX_PATH = path.join(ROOT, "index.html");
const SITE_URL = "https://mithunsidhaarth.in";

function slugify(str) {
  return (str || "")
    .toString()
    .toLowerCase()
    .trim()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function setMetaTag(html, selectorRegex, attr, value) {
  // selectorRegex must match the *whole* tag, with one capture group
  // around the attribute value to replace.
  return html.replace(selectorRegex, (full, before, after) => `${before}${escapeAttr(value)}${after}`);
}

function escapeAttr(str) {
  return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtml(str) {
  return escapeAttr(str);
}

function readIndexHtml() {
  return fs.readFileSync(INDEX_PATH, "utf8");
}

function extractDataObject(html) {
  const match = html.match(/let data=(\{[\s\S]*?\n\};)/);
  if (!match) {
    throw new Error("Could not find `let data={...};` in index.html — has the structure changed?");
  }
  const literal = match[1].replace(/;\s*$/, "");
  // The object literal only contains strings/numbers/arrays/objects — safe to eval in isolation.
  // eslint-disable-next-line no-eval
  const data = eval("(" + literal + ")");
  return data;
}

const KICKER = { projects: "Project", blogs: "Blog post", research: "Research" };

function breadcrumbLd(category, item, url) {
  const categoryLabel = { projects: "Projects", blogs: "Blogs", research: "Research" }[category] || category;
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${SITE_URL}/` },
      { "@type": "ListItem", position: 2, name: categoryLabel, item: `${SITE_URL}/#${category}` },
      { "@type": "ListItem", position: 3, name: item.title, item: url }
    ]
  };
}

function jsonLdFor(category, item, url) {
  if (category === "projects") {
    return {
      "@context": "https://schema.org",
      "@type": "CreativeWork",
      name: item.title,
      description: item.desc || "",
      url,
      author: { "@type": "Person", name: "Mithun Sidhaarth", url: SITE_URL },
      ...(item.demo && item.demo !== "#" ? { sameAs: [item.demo] } : {})
    };
  }
  if (category === "blogs") {
    return {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: item.title,
      description: item.desc || "",
      url,
      mainEntityOfPage: url,
      author: { "@type": "Person", name: "Mithun Sidhaarth", url: SITE_URL }
    };
  }
  return {
    "@context": "https://schema.org",
    "@type": "ScholarlyArticle",
    headline: item.title,
    description: item.desc || "",
    url,
    author: { "@type": "Person", name: "Mithun Sidhaarth", url: SITE_URL }
  };
}

function buildPage(template, category, item, index, siteImage) {
  const slug = slugify(item.title);
  const url = `${SITE_URL}/${category}/${slug}/`;
  const title = `${item.title} — Mithun Sidhaarth`;
  const kicker = KICKER[category] || category;
  const description = item.desc || `${kicker}: ${item.title} — by Mithun Sidhaarth.`;

  let html = template;

  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(title)}</title>`);
  html = setMetaTag(
    html,
    /(<meta name="description" content=")[^"]*("\s*>)/,
    "content",
    description
  );
  html = setMetaTag(html, /(<link rel="canonical" href=")[^"]*("\s*>)/, "href", url);
  html = setMetaTag(html, /(<meta property="og:title" content=")[^"]*("\s*>)/, "content", title);
  html = setMetaTag(html, /(<meta property="og:description" content=")[^"]*("\s*>)/, "content", description);
  html = setMetaTag(html, /(<meta property="og:url" content=")[^"]*("\s*>)/, "content", url);
  html = setMetaTag(html, /(<meta name="twitter:title" content=")[^"]*("\s*>)/, "content", title);
  html = setMetaTag(html, /(<meta name="twitter:description" content=")[^"]*("\s*>)/, "content", description);

  // Swap the homepage's Person JSON-LD for item-specific blocks: the item's own
  // schema plus a BreadcrumbList (Person schema stays homepage-only — one Person
  // entity per site is enough).
  const itemLd = JSON.stringify(jsonLdFor(category, item, url), null, 2);
  const breadcrumbLdJson = JSON.stringify(breadcrumbLd(category, item, url), null, 2);
  html = html.replace(
    /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
    `<script type="application/ld+json">\n${itemLd}\n</script>\n<script type="application/ld+json">\n${breadcrumbLdJson}\n</script>`
  );

  // Tell the routing JS which item to auto-open. Inserted right before </head> —
  // a single, unambiguous anchor regardless of line-ending style (the source
  // file uses CRLF throughout, which broke a script-tag-text anchor here before).
  const routeHint = `<script>window.__ROUTE__ = {category:"${category}", slug:"${slug}"};</script>\n`;
  if (!/<\/head>/.test(html)) {
    throw new Error("Could not find </head> in index.html to inject the route hint.");
  }
  html = html.replace(/<\/head>/, `${routeHint}</head>`);

  return { html, url, slug };
}

function main() {
  const template = readIndexHtml();
  const data = extractDataObject(template);

  const today = new Date().toISOString().slice(0, 10);
  const routes = [{ loc: `${SITE_URL}/`, priority: "1.0" }];
  let written = 0;

  for (const category of ["projects", "blogs", "research"]) {
    const items = data[category] || [];
    const seenSlugs = new Set();

    items.forEach((item, index) => {
      let slug = slugify(item.title);
      if (!slug) {
        console.warn(`  ! Skipping ${category}[${index}] — title produced an empty slug.`);
        return;
      }
      if (seenSlugs.has(slug)) {
        console.warn(`  ! Duplicate slug "${slug}" in ${category} — appending index to disambiguate.`);
        slug = `${slug}-${index + 1}`;
      }
      seenSlugs.add(slug);

      const { html, url } = buildPage(template, category, item, index);
      const outDir = path.join(ROOT, category, slug);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, "index.html"), html, "utf8");
      routes.push({ loc: url, priority: "0.8" });
      written += 1;
      console.log(`  + /${category}/${slug}/`);
    });
  }

  const sitemap =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    routes.map(r => `  <url>\n    <loc>${r.loc}</loc>\n    <lastmod>${today}</lastmod>\n    <priority>${r.priority}</priority>\n  </url>`).join("\n") +
    `\n</urlset>\n`;
  fs.writeFileSync(path.join(ROOT, "sitemap.xml"), sitemap, "utf8");

  console.log(`\nGenerated ${written} route page(s) and rewrote sitemap.xml with ${routes.length} URL(s).`);
}

main();
