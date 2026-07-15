# Report fonts

`NotoSans{KR,JP,SC}-{Regular,Bold}.ttf` back the PDF exports in `index.html`
(see `window.MOBrand` — `fontsFor` / `ensureUnicodeFonts` / `pickerFor`).

## Why they exist

jsPDF's built-in Helvetica is a PDF standard-14 font, which is WinAnsi-encoded: it can
only address the CP1252 repertoire. Korean (and any other non-CP1252 script) is silently
byte-mangled into mojibake instead of failing, which is what turned the Korean queries in
the GEO report into a row of accented Latin garbage. Embedding real Unicode TTFs is the
only fix.

They are fetched **on demand** — only for the languages a report actually contains — so
English reports pay nothing. jsPDF subsets each font as it writes the PDF, so a Korean
report exports at ~210KB even though the font is 2.4MB.

## Why three fonts

CJK shares Han codepoints across languages but draws them with different regional forms,
and no single Noto family covers all of it. Measured coverage of the upstream fonts:

| font | Hangul | kana | Han (U+4E00–9FFF) | notes |
|---|---:|---:|---:|---|
| Noto Sans KR | 11,172 | 189 | 8,138 | no simplified forms |
| Noto Sans JP | 0 | 189 | 12,747 | no simplified forms |
| Noto Sans SC | 0 | 189 | 20,976 | simplified **and** traditional |

So SC is the widest net for Chinese (both scripts — verified: it renders 臺灣繁體 as well
as 简体中文), and JP exists purely to give Japanese its correct kanji forms. Fonts are
picked **per string**, so one table can hold Korean, Japanese and Chinese rows and render
each correctly.

Traditional Chinese is served by SC rather than a separate Noto Sans TC: SC has a glyph
for every TC codepoint, and shipping TC would add ~10MB to settle only regional
glyph-variant nuances on shared codepoints.

## Sizes (per weight)

KR 2.4MB · JP 4.2MB · SC 7.1MB. Both weights of a family are fetched together, so a
Korean report costs ~5MB, Japanese ~8.5MB, Chinese ~14MB — once per session, then cached.

## How they were built

Run `./fonts/build-fonts.sh` — it fetches the upstream variable fonts, builds all six
files into this directory, and needs nothing but `python3` and `curl`. The output is not
byte-reproducible (fontTools stamps `head.modified`), but is structurally identical run to
run. Two traps the script exists to avoid:

1. **Never hand jsPDF the upstream variable font.** It reads `glyf` outlines and ignores
   `gvar`, so every glyph would draw at the default axis position — which for all of
   `NotoSans{KR,JP,SC}[wght]` is **100 (Thin)**, not Regular. Instance the axis first.
2. **`varLib.instancer` keeps the variable font's name table**, so the output still calls
   itself "Noto Sans KR Thin" at `usWeightClass=400`. Rewrite name IDs 1/2/4/6/16/17 and
   the `fsSelection`/`macStyle` bits, or the PDF reports a nonsense font name.

```sh
pip install fonttools brotli
curl -sL 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf' -o kr-var.ttf

COMMON="U+0020-007E,U+00A0-00FF,U+0100-017F,U+0192,U+02C6,U+02DC,U+2000-206F,U+20A0-20BF,\
U+2100-214F,U+2190-21FF,U+2200-22FF,U+25A0-25FF,U+2600-26FF,U+3000-303F,U+FF00-FFEF"
KR_ONLY="U+1100-11FF,U+3130-318F,U+A960-A97F,U+AC00-D7A3,U+D7B0-D7FF"   # KR
KANA="U+3040-309F,U+30A0-30FF,U+31F0-31FF"; HAN="U+2E80-2EFF,U+4E00-9FFF"  # JP + SC

fonttools varLib.instancer kr-var.ttf wght=400 -o inst-400.ttf   # 700 -> Bold
pyftsubset inst-400.ttf --unicodes="$COMMON,$KR_ONLY" --layout-features='' \
  --drop-tables+=DSIG,BASE,GDEF,GSUB,GPOS,STAT,vhea,vmtx \
  --no-hinting --desubroutinize --name-IDs='*' --recalc-bounds \
  --output-file=NotoSansKR-Regular.ttf
# then fix the name table / fsSelection — see build-fonts.sh
```

## Known limits

- **Han-only text is ambiguous.** 料金比較 is valid Japanese and valid Chinese; nothing in
  the characters says which. It routes to SC, so a Japanese label containing no kana
  renders in Chinese kanji forms. Deliberate — see the comment in `MOBrand`.
- **KR ships no Han**, so Hanja inside Korean text has no glyph. Adding it takes KR from
  2.4MB to ~5.2MB per weight; modern Korean queries are pure Hangul.
- Anything else (Thai, Devanagari, emoji) has no glyph in any of these.
  `MOBrand.unsupportedChars()` warns on export rather than exporting silent blanks.

## Licence

Noto Sans KR/JP/SC are all licensed under the SIL Open Font License 1.1 and share the same
Adobe/Source Han copyright — see `OFL.txt`, which must stay alongside these files.
