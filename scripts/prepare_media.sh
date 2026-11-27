#!/usr/bin/env bash
# ============================================================================
# prepare_media.sh — Convert, Resize, and Strip EXIF/GPS Metadata for Public Docs
# ============================================================================
# Processes raw photos/screenshots from local_media_raw/ into docs/images/,
# stripping all EXIF, GPS, XMP, and IPTC metadata so public-repo media never
# leaks personal location, camera serials, or oversized binaries.
# ============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RAW_DIR="${REPO_ROOT}/local_media_raw"
OUT_DIR="${REPO_ROOT}/docs/images"
MAX_DIM=1600
MAX_KB=600

usage() {
  cat <<'EOF'
Usage: ./scripts/prepare_media.sh [--verify] [--help]

Modes:
  (default)   Convert & optimize all images in local_media_raw/ -> docs/images/
              - Hardware photos (.heic/.jpg/.jpeg/.png) -> JPEG (max 1600px, <= 600 KB)
              - Screenshots (dashboard-* or ai-*)       -> PNG (or JPEG if > 600 KB)
              - Strips 100% of EXIF, GPS, XMP, IPTC, and PNG text metadata
  --verify    Audit all images currently in docs/images/ for size (<= 600 KB)
              and zero EXIF/GPS/XMP metadata without modifying files.
  --help      Show this help message.
EOF
}

strip_metadata() {
  local filepath="$1"
  python3 - "$filepath" <<'PY'
import struct, sys

path = sys.argv[1]
with open(path, "rb") as f:
    data = f.read()

if data.startswith(b"\xff\xd8"):
    # JPEG: keep SOI, drop APP1 (Exif/XMP), APP13 (IPTC), COM (0xFE)
    out = bytearray(b"\xff\xd8")
    i = 2
    n = len(data)
    while i < n:
        if data[i] != 0xFF:
            out.extend(data[i:])
            break
        while i < n and data[i] == 0xFF:
            i += 1
        if i >= n:
            break
        marker = data[i]
        i += 1
        if marker == 0xD9:  # EOI
            out.extend(b"\xff\xd9")
            break
        if marker == 0xDA:  # SOS — copy rest of entropy-coded stream verbatim
            out.extend(b"\xff\xda")
            out.extend(data[i:])
            break
        if 0xD0 <= marker <= 0xD7 or marker == 0x01:
            out.extend(bytes([0xFF, marker]))
            continue
        if i + 2 > n:
            break
        seg_len = struct.unpack(">H", data[i:i+2])[0]
        seg_end = i + seg_len
        if marker not in (0xE1, 0xED, 0xFE):
            out.extend(bytes([0xFF, marker]))
            out.extend(data[i:seg_end])
        i = seg_end
    with open(path, "wb") as f:
        f.write(out)
elif data.startswith(b"\x89PNG\r\n\x1a\n"):
    # PNG: drop eXIf, tEXt, zTXt, iTXt, tIME chunks
    out = bytearray(data[:8])
    i = 8
    n = len(data)
    drop = {b"eXIf", b"tEXt", b"zTXt", b"iTXt", b"tIME"}
    while i + 12 <= n:
        length = struct.unpack(">I", data[i:i+4])[0]
        ctype = data[i+4:i+8]
        chunk_end = i + 12 + length
        if ctype not in drop:
            out.extend(data[i:chunk_end])
        i = chunk_end
    with open(path, "wb") as f:
        f.write(out)
PY
}

file_size_bytes() {
  wc -c < "$1" | tr -d '[:space:]'
}

verify_images() {
  if [[ ! -d "$OUT_DIR" ]]; then
    echo "ℹ️  No docs/images/ directory found yet."
    exit 0
  fi

  local count=0
  local failed=0
  shopt -s nullglob
  for img in "$OUT_DIR"/*.jpg "$OUT_DIR"/*.jpeg "$OUT_DIR"/*.png; do
    count=$((count + 1))
    local name
    name="$(basename "$img")"
    local size_bytes
    size_bytes="$(file_size_bytes "$img")"
    local size_kb=$(( (size_bytes + 1023) / 1024 ))

    local meta_status
    meta_status="$(python3 - "$img" <<'PY'
import struct, sys

path = sys.argv[1]
with open(path, "rb") as f:
    data = f.read()

found = []
if data.startswith(b"\xff\xd8"):
    i = 2
    n = len(data)
    while i < n:
        if data[i] != 0xFF:
            break
        while i < n and data[i] == 0xFF:
            i += 1
        if i >= n:
            break
        marker = data[i]
        i += 1
        if marker in (0xD9, 0xDA):
            break
        if 0xD0 <= marker <= 0xD7 or marker == 0x01:
            continue
        if i + 2 > n:
            break
        seg_len = struct.unpack(">H", data[i:i+2])[0]
        if marker == 0xE1:
            found.append("JPEG-APP1(EXIF/XMP)")
        elif marker == 0xED:
            found.append("JPEG-APP13(IPTC)")
        i += seg_len
elif data.startswith(b"\x89PNG\r\n\x1a\n"):
    i = 8
    n = len(data)
    bad = {b"eXIf", b"tEXt", b"zTXt", b"iTXt"}
    while i + 12 <= n:
        length = struct.unpack(">I", data[i:i+4])[0]
        ctype = data[i+4:i+8]
        if ctype in bad:
            found.append(f"PNG-{ctype.decode('ascii', 'ignore')}")
        i += 12 + length

print("OK" if not found else ",".join(found))
PY
)"

    if [[ "$meta_status" != "OK" ]]; then
      echo "❌ [FAIL] ${name}: metadata still present (${meta_status})"
      failed=1
    elif (( size_kb > MAX_KB )); then
      echo "❌ [FAIL] ${name}: ${size_kb} KB exceeds ${MAX_KB} KB budget"
      failed=1
    else
      echo "✅ [PASS] ${name}: ${size_kb} KB, zero EXIF/GPS/XMP metadata"
    fi
  done
  shopt -u nullglob

  if (( count == 0 )); then
    echo "ℹ️  No processed images found in docs/images/ yet."
    exit 0
  fi

  if (( failed != 0 )); then
    exit 1
  fi
  echo "🎉 All ${count} image(s) in docs/images/ passed size and privacy checks!"
}

process_all() {
  if ! command -v sips >/dev/null 2>&1; then
    echo "❌ macOS 'sips' command is required to resize/convert images."
    exit 1
  fi

  mkdir -p "$RAW_DIR" "$OUT_DIR"

  shopt -s nullglob nocaseglob
  local files=("$RAW_DIR"/*.heic "$RAW_DIR"/*.jpg "$RAW_DIR"/*.jpeg "$RAW_DIR"/*.png)
  shopt -u nullglob nocaseglob

  if (( ${#files[@]} == 0 )); then
    echo "ℹ️  No raw images found in ${RAW_DIR}/."
    echo "   Drop your photos/screenshots into local_media_raw/ and re-run ./scripts/prepare_media.sh"
    exit 0
  fi

  for src in "${files[@]}"; do
    local filename
    filename="$(basename "$src")"
    local stem="${filename%.*}"
    local is_ui=0
    if [[ "$stem" == dashboard-* || "$stem" == ai-* ]]; then
      is_ui=1
    fi

    if (( is_ui == 1 )); then
      local dst_png="${OUT_DIR}/${stem}.png"
      sips -s format png -Z "$MAX_DIM" "$src" --out "$dst_png" >/dev/null
      strip_metadata "$dst_png"
      local size_kb=$(( ($(file_size_bytes "$dst_png") + 1023) / 1024 ))
      if (( size_kb > MAX_KB )); then
        # Fall back to high-quality JPEG if PNG screenshot is too large
        rm -f "$dst_png"
        local dst_jpg="${OUT_DIR}/${stem}.jpg"
        for q in 88 80 72; do
          sips -s format jpeg -s formatOptions "$q" -Z "$MAX_DIM" "$src" --out "$dst_jpg" >/dev/null
          strip_metadata "$dst_jpg"
          size_kb=$(( ($(file_size_bytes "$dst_jpg") + 1023) / 1024 ))
          (( size_kb <= MAX_KB )) && break
        done
        echo "🖼️  ${filename} -> docs/images/${stem}.jpg (${size_kb} KB, EXIF stripped)"
      else
        echo "🖼️  ${filename} -> docs/images/${stem}.png (${size_kb} KB, metadata stripped)"
      fi
    else
      local dst_jpg="${OUT_DIR}/${stem}.jpg"
      local size_kb=0
      for q in 84 76 68; do
        sips -s format jpeg -s formatOptions "$q" -Z "$MAX_DIM" "$src" --out "$dst_jpg" >/dev/null
        strip_metadata "$dst_jpg"
        size_kb=$(( ($(file_size_bytes "$dst_jpg") + 1023) / 1024 ))
        (( size_kb <= MAX_KB )) && break
      done
      echo "📷 ${filename} -> docs/images/${stem}.jpg (${size_kb} KB, EXIF/GPS stripped)"
    fi
  done

  echo ""
  verify_images
}

case "${1:-}" in
  --help|-h)
    usage
    ;;
  --verify)
    verify_images
    ;;
  "")
    process_all
    ;;
  *)
    echo "Unknown argument: $1" >&2
    usage >&2
    exit 2
    ;;
esac
