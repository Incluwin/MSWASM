# WZ→NX conversion and full-stack launcher fixes

This documents the specific changes that were made to get a fresh
`MapleWasm/` checkout running end-to-end on Docker Desktop for Windows
(WSL2 backend), with a working login screen.

There were two independent bugs blocking the login screen from rendering.
Both are fixed in source; this doc explains *what* each change does and
*why* it was needed, so the fix isn't accidentally reverted later.

---

## Bug 1 — `.nx` files had a zeroed PKG4 header

### Symptom

After running `./scripts/wz-converter/convert.sh`, every produced `.nx`
file looked the right size on disk (Character.nx ~3.8 GB, Map.nx
~3.2 GB, etc.) but the first 16 bytes were all `0x00`. The WASM client
threw on startup:

```
[NoLifeNx] Invalid Magic for Base.nx: 0x0
Error: Could not initialize NLNX. Message: Base.nx is not a PKG4 NX file
```

The user-visible result was a black login screen. The connect overlay
worked because it's plain HTML/JS, but the moment the WASM module tried
to `nlnx::file::open()` anything, it errored out and never drew the UI.

### Root cause

`NoLifeWzToNx`'s output writer (`omapfile` in `NoLifeWzToNx.cpp`) writes
files via:

```cpp
file_handle = ::open(p.c_str(), O_RDWR | O_CREAT | O_TRUNC, ...);
::lseek(file_handle, file_size - 1, SEEK_SET);
::write(file_handle, "", 1);              // stretch to final size
base = ::mmap(nullptr, file_size,
              PROT_READ | PROT_WRITE,
              MAP_SHARED, file_handle, 0);
```

All subsequent writes go through the mmap'd region. The Linux side has
no destructor and never calls `msync` or `munmap` — it relies on the
kernel flushing dirty pages back to the file at process exit.

That works fine on a native Linux filesystem. It does **not** work
reliably when the file lives on a Docker Desktop bind mount from a
Windows host directory:

- Docker Desktop on Windows runs Linux in a WSL2 VM and exposes
  bind-mounted Windows directories through a FUSE layer
  (`grpcfuse`/`virtiofs` depending on version).
- That FUSE layer does not honor `MAP_SHARED` mmap pages on process
  exit. Pages that haven't been explicitly `msync`'d may never reach
  the host file.
- Empirically, large body writes that span full pages tended to
  survive, but the small early-offset writes like the 4-byte `PKG4`
  magic and the 60-byte header at offset 0 were silently dropped.
  That's why the files looked the right *size* on the host, but the
  start-of-file region was all zeros.

`msync` alone is not enough either — the FUSE layer doesn't relay it
correctly for bind-mounted Windows paths in this configuration.

### Fix

Two changes in `scripts/wz-converter/container-convert.sh`:

#### a) Stage each conversion in a Linux-only directory

The converter writes its `.nx` next to the input `.wz` (it just calls
`replace_extension(".nx")` on the input path). So instead of pointing
the converter at `/work/wz/Map.wz` (a bind mount), we:

1. Create `/tmp/wzstage` inside the container. `/tmp` is regular
   overlayfs/ext4 inside the WSL2 VM — `MAP_SHARED` mmap works
   correctly there.
2. For each WZ, create a symlink at `/tmp/wzstage/<file>.wz` pointing
   at `/work/wz/<file>.wz`. The converter follows the symlink to read
   the source bytes (read-side mmap on the bind mount is fine), but
   writes its output to `/tmp/wzstage/<file>.nx` — a regular file on
   native Linux fs.
3. After each file, copy the result out with `cp`:

   ```bash
   cp -f "$stage_nx" "$NX_DIR/"
   ```

   `cp` uses ordinary `read(2)`/`write(2)`. Those round-trip through
   the FUSE bind mount intact, unlike mmap pages.
4. Delete the staged `.nx` immediately so `/tmp` peaks at ~4 GB
   (the size of Character.nx) instead of the full ~14 GB set.

The relevant block of `container-convert.sh`:

```bash
STAGE_DIR="/tmp/wzstage"
...
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

for wz in "${wz_files[@]}"; do
  base="$(basename "$wz")"
  ...
  stage_wz="$STAGE_DIR/$base"
  stage_nx="$STAGE_DIR/${base%.wz}.nx"
  ln -sf "$wz" "$stage_wz"

  "$BIN_PATH" "$stage_wz" -c    # or -s for server mode

  if [[ -f "$stage_nx" ]]; then
    cp -f "$stage_nx" "$NX_DIR/"
    rm -f "$stage_nx"
  fi
  rm -f "$stage_wz"
done

rm -rf "$STAGE_DIR"
```

#### b) Add an explicit destructor with `msync` to `omapfile` (defense in depth)

A separate in-place patch added to `container-convert.sh` rewrites the
Linux branch of `omapfile` so the writer cleans up explicitly:

```bash
if ! grep -q "msync(const_cast<char \*>(base)" NoLifeWzToNx.cpp; then
  perl -0777 -i -pe 's@    void close\(\) \{\s*::munmap\(...\);\s*::close\(file_handle\);\s*\}\n#endif@\
    void close() {\
        if (base) {\
            ::msync(const_cast<char *>(base), file_size, MS_SYNC);\
            ::munmap(const_cast<char *>(base), file_size);\
            base = nullptr;\
        }\
        if (file_handle > 0) {\
            ::close(file_handle);\
            file_handle = 0;\
        }\
    }\
    ~omapfile() { close(); }\
#endif@g' NoLifeWzToNx.cpp
fi
```

This:

- adds an explicit `~omapfile()` destructor on Linux that calls
  `close()` (the Windows branch already had a destructor; the Linux
  branch had a `close()` method but never called it),
- has `close()` call `msync(MS_SYNC)` before `munmap` so dirty pages
  are flushed synchronously to whatever filesystem the file lives on,
- nulls out `base`/`file_handle` so the destructor is idempotent.

This isn't strictly necessary for the staging-dir fix above (mmap on
overlayfs flushes correctly without explicit `msync`), but it's
correct behavior in general and means the converter will produce
valid output even on host bind mounts in environments where the FUSE
layer behaves better (e.g. Linux Docker, macOS Docker Desktop's
virtiofs path).

**Important guard detail:** the existence check uses
`grep -q "msync(const_cast<char \*>(base)"` rather than
`grep -q "~omapfile"`. The Windows branch of `omapfile` already has a
`~omapfile()` destructor in upstream, so a `~omapfile`-based guard
matches on first run and the patch never applies. The msync substring
only exists in the patched output, so it's a reliable idempotency
marker.
