#!/bin/bash
# Rebuild the GEO report fonts from upstream Noto: instance the variable font at a real
# weight, subset it, then fix the name table. Writes straight into this directory.
#
#   ./fonts/build-fonts.sh
#
# Two traps this exists to avoid — see README.md:
#   1. jsPDF reads `glyf` and ignores `gvar`, so an un-instanced variable font draws every
#      glyph at the default axis position, which for all of these is 100 (Thin).
#   2. varLib.instancer keeps the variable font's name table, so the output still calls
#      itself "Noto Sans KR Thin" at usWeightClass=400 unless the names are rewritten.
set -euo pipefail
cd "$(dirname "$0")"

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
python3 -m venv "$WORK/venv"
"$WORK/venv/bin/pip" install -q fonttools brotli
PY="$WORK/venv/bin/python"

COMMON="U+0020-007E,U+00A0-00FF,U+0100-017F,U+0192,U+02C6,U+02DC,U+2000-206F,U+20A0-20BF,U+2100-214F,U+2190-21FF,U+2200-22FF,U+25A0-25FF,U+2600-26FF,U+3000-303F,U+FF00-FFEF"
KR_ONLY="U+1100-11FF,U+3130-318F,U+A960-A97F,U+AC00-D7A3,U+D7B0-D7FF"
KANA="U+3040-309F,U+30A0-30FF,U+31F0-31FF"
HAN="U+2E80-2EFF,U+4E00-9FFF"

fetch () { # $1=ofl-dir  $2=PostScript base
  echo "fetching $2 ..."
  curl -fsSL "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/$1/$2%5Bwght%5D.ttf" -o "$WORK/$2-var.ttf"
}

build () { # $1=PostScript base  $2=weight  $3=style  $4=unicodes
  local base=$1 w=$2 style=$3 uni=$4
  "$WORK/venv/bin/fonttools" varLib.instancer "$WORK/$base-var.ttf" wght=$w -o "$WORK/inst.ttf" >/dev/null
  "$WORK/venv/bin/pyftsubset" "$WORK/inst.ttf" --unicodes="$uni" --layout-features='' \
    --drop-tables+=DSIG,BASE,GDEF,GSUB,GPOS,STAT,vhea,vmtx --no-hinting --desubroutinize \
    --name-IDs='*' --recalc-bounds --output-file="$base-$style.ttf" >/dev/null
  "$PY" - "$base-$style.ttf" "$base" "$style" <<'PY'
import sys
from fontTools.ttLib import TTFont
path, ps_base, sub = sys.argv[1], sys.argv[2], sys.argv[3]
fam = {"NotoSansKR": "Noto Sans KR", "NotoSansJP": "Noto Sans JP", "NotoSansSC": "Noto Sans SC"}[ps_base]
t = TTFont(path); name = t["name"]
full = fam if sub == "Regular" else fam + " " + sub
for rec in list(name.names):
    for nid, val in ((1, fam), (2, sub), (4, full), (6, ps_base + "-" + sub), (16, fam), (17, sub)):
        if rec.nameID == nid:
            name.setName(val, nid, rec.platformID, rec.platEncID, rec.langID)
os2, head = t["OS/2"], t["head"]
if sub == "Bold":
    os2.fsSelection = (os2.fsSelection & ~0b01000000) | 0b00100000   # clear REGULAR, set BOLD
    head.macStyle |= 0b01
else:
    os2.fsSelection = (os2.fsSelection & ~0b00100000) | 0b01000000   # clear BOLD, set REGULAR
    head.macStyle &= ~0b01
t.save(path)
PY
  echo "  $base-$style.ttf  $(( $(wc -c < "$base-$style.ttf") / 1024 )) KB"
}

fetch notosanskr NotoSansKR
build NotoSansKR 400 Regular "$COMMON,$KR_ONLY"
build NotoSansKR 700 Bold    "$COMMON,$KR_ONLY"

fetch notosansjp NotoSansJP
build NotoSansJP 400 Regular "$COMMON,$KANA,$HAN"
build NotoSansJP 700 Bold    "$COMMON,$KANA,$HAN"

fetch notosanssc NotoSansSC
build NotoSansSC 400 Regular "$COMMON,$KANA,$HAN"
build NotoSansSC 700 Bold    "$COMMON,$KANA,$HAN"

echo "done — OFL.txt must ship alongside these files."
