---
title: "Example post: how a Degent Chronicle is written"
date: 2026-09-24
slug: example-how-to-write-a-chronicle
excerpt: "EXAMPLE, not a real announcement. This file shows the format every blog post uses: front matter, Markdown, and the WordPress slug kept as-is."
author: degent.club web team
example: true
---

> **This is an example post.** It exists to show the format of the blog's content source. It is not an
> announcement and says nothing about the collection. Replace or delete it when the first real post lands.

## Where posts live

Every post is one Markdown file in `products/degent/apps/web/content/blog/`. The site bundles them at build
time, so a post ships with a normal pull request and is reviewed like code.

## The front matter

Each file starts with a small header between two `---` lines:

1. `title`: the headline (required).
2. `date`: `YYYY-MM-DD` (required); the newest post is listed first.
3. `slug`: the address of the post. When porting from WordPress, **keep the WordPress slug**, so
   `degent.club/blog/<slug>/` becomes `#/blog/<slug>`.
4. `excerpt`, `cover`, `author`: optional.

## What Markdown works

Headings, paragraphs, **bold**, *italic*, `inline code`, [links](https://degent.club), lists, quotes and fenced
code blocks:

```
a fenced code block keeps   its spacing
```

Raw HTML is shown as text, never executed.
