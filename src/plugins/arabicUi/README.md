# ArabicUI

Arabic for Discord and Vencord UI. Enable the plugin, restart Discord once. Missing text stays English. Layout stays LTR.

Help translate: [TRANSLATING.md](./TRANSLATING.md)

## Features

- Discord UI (phrase map + intl keys)
- Vencord plugin descriptions and settings (titles stay English)
- Optional fonts: Cairo, Tajawal, Amiri, Vazirmatn

## Loanwords

Write Discord words in Arabic letters (English sound): دسكورد، نيترو، ميوت، سيرفر، بوست…

No Latin. No English in parentheses.

DM → خاص · GIF → صورة متحركة · Rich Presence → حالة النشاط · Wishlist → قائمة الرغبات

See `locales/glossary.json`

## Discord strings

Edit `locales/discord/en-text/` (not `_all.json`):

```bash
node scripts/arabicUi/normalizeLoanwords.mjs
node scripts/arabicUi/dedupeEnText.mjs
node scripts/arabicUi/mergeEnText.mjs
```

Then build / inject.

Corpus from [wickstudio/discord-arabic-translations](https://github.com/wickstudio/discord-arabic-translations) (MIT).  
License: `locales/discord/THIRD_PARTY_WICK_STUDIO_LICENSE.txt`

## Plugin packs

Copy `locales/plugins/_template.json` → `ExactPluginName.json`, fill Arabic, then:

```bash
node scripts/arabicUi/generateRegistry.mjs
```

## Layout

```
arabicUi/
  index.ts
  engine/
  locales/
  README.md
  TRANSLATING.md
scripts/arabicUi/
  normalizeLoanwords.mjs
  dedupeEnText.mjs
  mergeEnText.mjs
  generateRegistry.mjs
```

---

PRs welcome.

**mar** · [github.com/n0tmar](https://github.com/n0tmar)
