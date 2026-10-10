#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/work"
WZ_DIR="$ROOT_DIR/wz"
NX_DIR="${NX_DIR:-$ROOT_DIR/assets}"
CACHE_DIR="$ROOT_DIR/.cache/tools"
SRC_DIR="$CACHE_DIR/NoLifeWzToNx"
BIN_DIR="$CACHE_DIR/bin"
BIN_PATH="$BIN_DIR/NoLifeWzToNx"
# Linux-only staging dir. NoLifeWzToNx writes the .nx file via mmap MAP_SHARED;
# Docker Desktop's Windows bind-mount FUSE drops mmap writes to host paths, so
# we run the conversion against symlinks in this in-container staging dir
# (overlayfs/ext4) and then cp the regular files to the bind-mounted output.
STAGE_DIR="/tmp/wzstage"

REPO_URL="${NO_LIFE_WZ_TO_NX_REPO:-https://github.com/ryantpayton/NoLifeWzToNx}"
REPO_REF="${NO_LIFE_WZ_TO_NX_REF:-master}"
SKIP_LIST_WZ="${SKIP_LIST_WZ:-1}"
MODE="${MODE:-client}" # client|server
LZ4HC="${LZ4HC:-0}"

mkdir -p "$CACHE_DIR" "$BIN_DIR" "$NX_DIR"

shopt -s nullglob
wz_files=("$WZ_DIR"/*.wz)
if [[ ${#wz_files[@]} -eq 0 ]]; then
  echo "No WZ files found in: $WZ_DIR" >&2
  exit 1
fi

if [[ ! -d "$SRC_DIR/.git" ]]; then
  echo "Cloning NoLifeWzToNx into $SRC_DIR"
  git clone "$REPO_URL" "$SRC_DIR"
fi

pushd "$SRC_DIR" >/dev/null

echo "Fetching latest from origin"
git fetch --all --tags --prune

echo "Checking out ref: $REPO_REF"
git checkout "$REPO_REF"
if git rev-parse --verify --quiet "origin/$REPO_REF" >/dev/null; then
  git reset --hard "origin/$REPO_REF"
fi

# Upstream currently includes <filesystem> but aliases std::experimental::filesystem.
# Patch in-container for modern GCC toolchains.
if grep -q "std::experimental::filesystem" NoLifeWzToNx.cpp; then
  sed -i 's/std::experimental::filesystem/std::filesystem/g' NoLifeWzToNx.cpp
fi
# Harden string conversion: malformed decoded text should not abort conversion.
if grep -q "return convert.to_bytes(ptr, ptr + p_str.size());" NoLifeWzToNx.cpp; then
  perl -0777 -i -pe "s@return convert\\.to_bytes\\(ptr, ptr \\+ p_str\\.size\\(\\)\\);@try { return convert.to_bytes(ptr, ptr + p_str.size()); } catch (...) { std::string fallback; fallback.reserve(p_str.size()); for (auto ch : p_str) fallback.push_back(ch < 0x80 ? static_cast<char>(ch) : '?'); return fallback; }@g" NoLifeWzToNx.cpp
fi
# Harden bitmap processing: some modern WZ bitmaps fail strict size checks.
# Fallback to blank bitmap data instead of aborting the entire conversion.
if grep -q "throw std::runtime_error(\"halp!\");" NoLifeWzToNx.cpp; then
  perl -0777 -i -pe "s@if \\(check != pixels \\* 4\\) \\{\\s*std::cerr << \"Size mismatch: \" << std::dec << width << \",\" << height << \",\" << decompressed << \",\" << f1 << \",\" << f2 << std::endl;\\s*throw std::runtime_error\\(\"halp!\"\\);\\s*\\}@if (check != pixels * 4) { std::cerr << \"Size mismatch: \" << std::dec << width << \",\" << height << \",\" << decompressed << \",\" << f1 << \",\" << f2 << std::endl; f1 = 2; f2 = 0; decompressed = size; std::fill(output.begin(), output.begin() + size, '\\\\0'); }@g" NoLifeWzToNx.cpp
fi
# Add a destructor with msync() to omapfile on Linux. Without this, MAP_SHARED
# mmap pages are only flushed implicitly on process exit, and Docker Desktop's
# Windows bind-mount FUSE drops the early-offset writes (the PKG4 header), so
# converted .nx files end up with a zeroed magic and fail to load. msync forces
# every dirty page back to the host filesystem before the file is closed.
if ! grep -q "msync(const_cast<char \*>(base)" NoLifeWzToNx.cpp; then
  perl -0777 -i -pe 's@    void close\(\) \{\s*::munmap\(const_cast<char \*>\(base\), file_size\);\s*::close\(file_handle\);\s*\}\n#endif@    void close() {\n        if (base) {\n            ::msync(const_cast<char *>(base), file_size, MS_SYNC);\n            ::munmap(const_cast<char *>(base), file_size);\n            base = nullptr;\n        }\n        if (file_handle > 0) {\n            ::close(file_handle);\n            file_handle = 0;\n        }\n    }\n    ~omapfile() { close(); }\n#endif@g' NoLifeWzToNx.cpp
fi

echo "Building converter binary (g++)"
g++ -std=c++17 -O2 -Iincludes/libsquish \
  NoLifeWzToNx.cpp Keys.cpp includes/libsquish/*.cpp \
  -lz -llz4 -o "$BIN_PATH"

popd >/dev/null

if [[ ! -x "$BIN_PATH" ]]; then
  echo "Failed to build converter: $BIN_PATH not found" >&2
  exit 1
fi

echo "Using converter binary: $BIN_PATH"

# Clean stale outputs in target dir
rm -f "$NX_DIR"/*.nx

# Reset the Linux-only staging dir. We convert one WZ at a time, copy the
# resulting .nx out to the bind-mounted output dir with regular cp, then
# delete the staged file before the next iteration. This keeps /tmp usage
# bounded to the single largest .nx (~4GB for Character) instead of the
# full ~14GB total set.
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

for wz in "${wz_files[@]}"; do
  base="$(basename "$wz")"
  if [[ "$base" == "List.wz" && "$SKIP_LIST_WZ" == "1" ]]; then
    echo "Skipping $base (non-PKG1 metadata file)"
    continue
  fi

  stage_wz="$STAGE_DIR/$base"
  stage_nx="$STAGE_DIR/${base%.wz}.nx"
  ln -sf "$wz" "$stage_wz"

  echo "Converting $base"
  args=("$stage_wz")
  if [[ "$MODE" == "server" ]]; then
    args+=("-s")
  else
    args+=("-c")
  fi
  if [[ "$LZ4HC" == "1" ]]; then
    args+=("-h")
  fi

  "$BIN_PATH" "${args[@]}"

  # Copy out via regular read/write (not mmap), then drop the staged file
  # so /tmp never holds more than one .nx at a time.
  if [[ -f "$stage_nx" ]]; then
    cp -f "$stage_nx" "$NX_DIR/"
    rm -f "$stage_nx"
  fi
  rm -f "$stage_wz"
done

rm -rf "$STAGE_DIR"

echo "Done. NX files in $NX_DIR:"
ls -lh "$NX_DIR"/*.nx
