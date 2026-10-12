#!/bin/sh
# Ranite installer: downloads the self-contained release archive for this
# machine (bundled Node.js runtime, no npm needed) and sets it up under
# ~/.ranite with a `ranite` launcher on PATH.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/zxsmind/ranite/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --version 0.1.0
#   ./install.sh --binary ./ranite-0.1.0-linux-x64.tar.gz
#
# Flags: --version <x.y.z>  install a specific release (default: latest)
#        --binary <file>    install from a local archive instead of downloading
#        --no-modify-path   do not touch shell startup files
# Env:   RANITE_GITHUB_REPO override the releases source (default zxsmind/ranite)
#        RANITE_INSTALL_DIR override the install directory (default ~/.ranite)
set -eu

APP="ranite"
REPO="${RANITE_GITHUB_REPO:-zxsmind/ranite}"
INSTALL_DIR="${RANITE_INSTALL_DIR:-$HOME/.ranite}"
BIN_DIR="$INSTALL_DIR/bin"

requested_version=""
binary_path=""
no_modify_path="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      requested_version="${2:-}"
      if [ -z "$requested_version" ]; then
        echo "Error: --version needs a value (e.g. --version 0.1.0)." >&2
        exit 1
      fi
      shift 2
      ;;
    --binary)
      binary_path="${2:-}"
      if [ -z "$binary_path" ]; then
        echo "Error: --binary needs a file path." >&2
        exit 1
      fi
      shift 2
      ;;
    --no-modify-path) no_modify_path="true"; shift ;;
    --help | -h)
      sed -n '2,14p' "$0"
      exit 0
      ;;
    *)
      echo "Error: unknown flag $1 (see --help)." >&2
      exit 1
      ;;
  esac
done

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: '$1' is required but not installed." >&2
    exit 1
  fi
}
need curl

say() {
  printf '%s\n' "$1"
}

# ---- One-bar progress: sequential phases, every number measured ----
# The bar stays on a single terminal line across download and extraction.
# Each phase shows its step (1/2, 2/2) with a measured fraction; nothing is
# staged or estimated. Without a terminal, downloads keep curl's own meter
# and extraction stays silent.
BAR_TTY=""
if [ -t 2 ]; then BAR_TTY=1; fi

# Formats a byte count as megabytes with one decimal, using shell arithmetic only.
fmt_mb() {
  printf '%d.%d' "$(( $1 / 1048576 ))" "$(( ($1 % 1048576) * 10 / 1048576 ))"
}

# render_step <step> <steps> <label> <done_bytes> <total_bytes|''>.
# An empty total renders a measured counter with no percentage, never a guess.
# Writes to stderr so stdout stays clean for piping.
render_step() {
  rs_step="$1"
  rs_steps="$2"
  rs_label="$3"
  rs_done="$4"
  rs_total="$5"
  rs_width=30
  if [ -z "$rs_total" ] || [ "$rs_total" = "0" ]; then
    rs_empty="$(printf '%30s' '')"
    printf '\r[%s] Step %s/%s: %s (%s MB)' "$(printf '%s' "$rs_empty" | tr ' ' '-')" "$rs_step" "$rs_steps" "$rs_label" "$(fmt_mb "$rs_done")" >&2
    return
  fi
  rs_percent=$(( rs_done * 100 / rs_total ))
  if [ "$rs_percent" -gt 100 ]; then rs_percent=100; fi
  rs_filled=$(( rs_percent * rs_width / 100 ))
  rs_empty_n=$(( rs_width - rs_filled ))
  rs_bar="$(printf "%${rs_filled}s" '')"
  rs_bar="$(printf '%s' "$rs_bar" | tr ' ' '=')"
  rs_rest="$(printf "%${rs_empty_n}s" '')"
  rs_rest="$(printf '%s' "$rs_rest" | tr ' ' '-')"
  printf '\r[%s%s] %3d%% Step %s/%s: %s (%s/%s MB)' "$rs_bar" "$rs_rest" "$rs_percent" "$rs_step" "$rs_steps" "$rs_label" "$(fmt_mb "$rs_done")" "$(fmt_mb "$rs_total")" >&2
}

# File size in bytes, or 0 when unreadable.
file_bytes() {
  fb_out="$(wc -c <"$1" 2>/dev/null)" || {
    echo 0
    return
  }
  set -- $fb_out
  case "$1" in
    '' | *[!0-9]*) echo 0 ;;
    *) echo "$1" ;;
  esac
}

# Directory size in bytes via du kilobytes, or 0 when unreadable.
dir_bytes() {
  db_out="$(du -sk "$1" 2>/dev/null)" || {
    echo 0
    return
  }
  set -- $db_out
  case "$1" in
    '' | *[!0-9]*) echo 0 ;;
    *) echo $(( $1 * 1024 )) ;;
  esac
}

# Archive size in bytes from a HEAD request, or empty when unavailable.
head_bytes() {
  hb_out="$(curl -fsSLI "$1" 2>/dev/null | tr -d '\r' | grep -i -o 'content-length: *[0-9]*' | grep -o '[0-9]*' | tail -n 1)"
  case "$hb_out" in
    '' | *[!0-9]* | 0) echo '' ;;
    *) echo "$hb_out" ;;
  esac
}

# Uncompressed payload size of an archive in bytes, or empty when it cannot
# be determined without extracting.
archive_payload_bytes() {
  case "$1" in
    *.tar.gz | *.tgz)
      set -- $(gzip -l "$1" 2>/dev/null | tail -n 1)
      case "$2" in
        '' | *[!0-9]*) echo '' ;;
        *) echo "$2" ;;
      esac
      ;;
    *.zip)
      set -- $(unzip -l "$1" 2>/dev/null | tail -n 1)
      case "$1" in
        '' | *[!0-9]*) echo '' ;;
        *) echo "$1" ;;
      esac
      ;;
    *) echo '' ;;
  esac
}

# Downloads a file as step <step>/<steps> of the single install bar.
# Falls back to curl's own meter when the size is unknown or stderr is not
# a terminal. Sets DL_TOTAL to the measured archive size.
download_phase() {
  dl_step="$1"
  dl_steps="$2"
  dl_url="$3"
  dl_output="$4"
  if [ -z "$BAR_TTY" ]; then
    curl -fL --progress-bar -o "$dl_output" "$dl_url"
    BG_RET=$?
    DL_TOTAL="$(file_bytes "$dl_output")"
    return "$BG_RET"
  fi
  DL_TOTAL="$(head_bytes "$dl_url")"
  case "$DL_TOTAL" in
    '')
      curl -fL --progress-bar -o "$dl_output" "$dl_url"
      BG_RET=$?
      DL_TOTAL="$(file_bytes "$dl_output")"
      return "$BG_RET"
      ;;
  esac
  : >"$dl_output"
  trap 'kill $BG_PID 2>/dev/null; rm -rf "$tmp_dir"; exit 130' INT TERM
  curl -fL -s -o "$dl_output" "$dl_url" &
  BG_PID=$!
  while kill -0 "$BG_PID" 2>/dev/null; do
    render_step "$dl_step" "$dl_steps" Downloading "$(file_bytes "$dl_output")" "$DL_TOTAL"
    sleep 1
  done
  BG_RET=0
  wait "$BG_PID" || BG_RET=$?
  trap 'rm -rf "$tmp_dir"' EXIT INT TERM
  if [ "$BG_RET" -ne 0 ]; then
    printf '\n' >&2
    return "$BG_RET"
  fi
  render_step "$dl_step" "$dl_steps" Downloading "$(file_bytes "$dl_output")" "$DL_TOTAL"
}

# Extracts an archive as the final step of the single install bar, measuring
# written bytes against the payload size. Without a terminal the extractor
# runs silently in the foreground.
extract_phase() {
  ex_step="$1"
  ex_steps="$2"
  ex_archive="$3"
  ex_dest="$4"
  case "$ex_archive" in
    *.zip) archive_ext=".zip" ;;
    *) archive_ext=".tar.gz" ;;
  esac
  if [ -z "$BAR_TTY" ]; then
    case "$ex_archive" in
      *.zip) unzip -q "$ex_archive" -d "$ex_dest" ;;
      *) tar -xzf "$ex_archive" -C "$ex_dest" ;;
    esac
    return $?
  fi
  EX_TOTAL="$(archive_payload_bytes "$ex_archive")"
  trap 'kill $BG_PID 2>/dev/null; rm -rf "$tmp_dir"; exit 130' INT TERM
  case "$ex_archive" in
    *.zip) unzip -q "$ex_archive" -d "$ex_dest" & ;;
    *) tar -xzf "$ex_archive" -C "$ex_dest" & ;;
  esac
  BG_PID=$!
  while kill -0 "$BG_PID" 2>/dev/null; do
    render_step "$ex_step" "$ex_steps" Extracting "$(dir_bytes "$ex_dest")" "$EX_TOTAL"
    sleep 1
  done
  BG_RET=0
  wait "$BG_PID" || BG_RET=$?
  trap 'rm -rf "$tmp_dir"' EXIT INT TERM
  if [ "$BG_RET" -ne 0 ]; then
    printf '\n' >&2
    echo "Error: extraction failed." >&2
    return 1
  fi
  render_step "$ex_step" "$ex_steps" Extracting "$(dir_bytes "$ex_dest")" "$EX_TOTAL"
  printf '\n' >&2
}

installed_version() {
  if [ -x "$BIN_DIR/$APP" ]; then
    "$BIN_DIR/$APP" --version 2>/dev/null || true
  fi
}

if [ -n "$binary_path" ]; then
  if [ ! -f "$binary_path" ]; then
    echo "Error: binary archive not found at $binary_path" >&2
    exit 1
  fi
  specific_version="local"
else
  raw_os="$(uname -s)"
  case "$raw_os" in
    Darwin*) os="darwin" ;;
    Linux*) os="linux" ;;
    MINGW* | MSYS* | CYGWIN*) os="windows" ;;
    *) echo "Error: unsupported OS: $raw_os" >&2; exit 1 ;;
  esac
  arch="$(uname -m)"
  case "$arch" in
    x86_64) arch="x64" ;;
    aarch64 | arm64) arch="arm64" ;;
    *) echo "Error: unsupported CPU: $arch" >&2; exit 1 ;;
  esac

  if [ "$os" = "linux" ]; then
    if [ -f /etc/alpine-release ]; then
      echo "Error: musl Linux (Alpine) builds are not published yet." >&2
      exit 1
    fi
    if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
      echo "Error: musl Linux builds are not published yet." >&2
      exit 1
    fi
    need tar
  elif [ "$os" = "darwin" ]; then
    echo "Error: macOS builds are not published yet. Follow the releases page for updates." >&2
    exit 1
  else
    need unzip
  fi

  target="$os-$arch"
  if [ "$os" = "windows" ]; then
    archive_ext=".zip"
  else
    archive_ext=".tar.gz"
  fi

  if [ -z "$requested_version" ]; then
    specific_version="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p')"
    if [ -z "$specific_version" ]; then
      echo "Error: could not determine the latest release version." >&2
      exit 1
    fi
    filename="$APP-$specific_version-$target$archive_ext"
    url="https://github.com/$REPO/releases/latest/download/$filename"
  else
    requested_version="${requested_version#v}"
    specific_version="$requested_version"
    filename="$APP-$specific_version-$target$archive_ext"
    url="https://github.com/$REPO/releases/download/v${specific_version}/$filename"
    status="$(curl -fsSL -o /dev/null -w "%{http_code}" "https://github.com/$REPO/releases/tag/v${specific_version}" || true)"
    if [ "$status" = "404" ]; then
      echo "Error: release v${specific_version} not found." >&2
      echo "Available releases: https://github.com/$REPO/releases" >&2
      exit 1
    fi
  fi
fi

current="$(installed_version)"
if [ -n "$current" ] && [ "$current" = "$specific_version" ]; then
  say "ranite $current is already installed at $INSTALL_DIR."
  exit 0
fi

tmp_dir="${TMPDIR:-/tmp}/ranite_install_$$"
mkdir -p "$tmp_dir"
trap 'rm -rf "$tmp_dir"' EXIT INT TERM

PHASE_STEPS=2
if [ -n "$binary_path" ]; then
  say "Installing ranite from $binary_path"
  archive="$tmp_dir/$(basename "$binary_path")"
  cp "$binary_path" "$archive"
  PHASE_STEPS=1
else
  say "Downloading ranite $specific_version ($target)"
  archive="$tmp_dir/$filename"
  download_phase 1 "$PHASE_STEPS" "$url" "$archive"
fi

mkdir -p "$tmp_dir/extract"
extract_phase "$PHASE_STEPS" "$PHASE_STEPS" "$archive" "$tmp_dir/extract"

mkdir -p "$INSTALL_DIR"
cp -r "$tmp_dir/extract/$APP/." "$INSTALL_DIR/"
mkdir -p "$BIN_DIR"
if [ "$archive_ext" = ".zip" ]; then
  # Windows archive: the bundled runtime is node.exe, runnable from POSIX shells too.
  cat > "$BIN_DIR/$APP" <<EOF
#!/bin/sh
# Generated by the ranite installer. Uses the bundled Node.js runtime.
ROOT="\$(CDPATH= cd -- "\$(dirname -- "\$0")/.." && pwd)"
exec "\$ROOT/node/bin/node.exe" "\$ROOT/app/dist/cli.js" "\$@"
EOF
else
  cat > "$BIN_DIR/$APP" <<EOF
#!/bin/sh
# Generated by the ranite installer. Uses the bundled Node.js runtime.
ROOT="\$(CDPATH= cd -- "\$(dirname -- "\$0")/.." && pwd)"
exec "\$ROOT/node/bin/node" "\$ROOT/app/dist/cli.js" "\$@"
EOF
fi
chmod 755 "$BIN_DIR/$APP"

installed="$(installed_version)"
if [ -z "$installed" ]; then
  echo "Error: installation finished but \`ranite --version\` does not run." >&2
  exit 1
fi
say "Installed ranite $installed to $INSTALL_DIR."

if [ "$no_modify_path" = "true" ]; then
  say "Skipped PATH setup (--no-modify-path). Add $BIN_DIR to PATH manually."
  exit 0
fi

if [ -n "${GITHUB_ACTIONS:-}" ] && [ -n "${GITHUB_PATH:-}" ]; then
  printf '%s\n' "$BIN_DIR" >> "$GITHUB_PATH"
  say "Added $BIN_DIR to GITHUB_PATH."
  exit 0
fi

current_shell="$(basename "${SHELL:-sh}")"
case "$current_shell" in
  fish) config_files="$HOME/.config/fish/config.fish" ;;
  zsh) config_files="$HOME/.zshenv $HOME/.zshrc" ;;
  bash) config_files="$HOME/.bashrc $HOME/.bash_profile $HOME/.profile" ;;
  ash | dash) config_files="$HOME/.profile" ;;
  *) config_files="$HOME/.profile" ;;
esac

export_line="export PATH=\"$BIN_DIR:\$PATH\""
config_file=""
for file in $config_files; do
  if [ -f "$file" ]; then
    config_file="$file"
    break
  fi
done

if [ -z "$config_file" ]; then
  say "No shell startup file found. Add this to your shell configuration:"
  say "  $export_line"
  exit 0
fi

if grep -qF "$BIN_DIR" "$config_file" 2>/dev/null; then
  say "PATH already contains $BIN_DIR ($config_file)."
else
  printf '\n# Added by the ranite installer.\n%s\n' "$export_line" >> "$config_file"
  say "Added $BIN_DIR to PATH in $config_file."
fi
say "Restart your shell (or run: export PATH=\"$BIN_DIR:\$PATH\") then try: ranite --version"
