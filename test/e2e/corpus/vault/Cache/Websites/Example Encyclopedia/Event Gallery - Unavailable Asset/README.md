# Event Gallery - Unavailable Asset

A synthetic test page in the layout of a cached website page, with one asset that could not be
retrieved and two stored elsewhere in the vault.

## Source

- **Page title:** Event Gallery
- **Page URL:** https://encyclopedia.example.org/wiki/Event_Gallery
- **Cache date:** 2026-05-01
- **Retrieved:** 2026-05-01

### Gaps

- `2026-05-01/card-summer.png` could not be retrieved; the summer card's appearance is not cached.
- `card-autumn.png` and `Shared Assets/card-winter.png` are not in this page's directory but in
  `Cache/Websites/Example Encyclopedia/Shared Assets/`. A browser opening the page does not find
  them; Obsidian's link resolution finds them by name and by partial path.

## Retained versions

- [2026-05-01](<2026-05-01.html>): the only version.
