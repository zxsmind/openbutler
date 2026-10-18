#!/bin/sh
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/zxsmind/ranite/main/install.sh | bash
#   ./install.sh [--version <x.y.z>] [--binary <file>] [--no-modify-path]
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
        echo "Error: --version needs a value (e.g. --version 0.4.2)." >&2
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
      sed -n '2,4p' "$0"
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

BAR_TTY=""
if [ -t 2 ]; then BAR_TTY=1; fi

ORANGE=""
RESET=""
if [ -n "$BAR_TTY" ] && [ -z "${NO_COLOR:-}" ]; then
  esc=$(printf '\033')
  ORANGE="${esc}[38;5;214m"
  RESET="${esc}[0m"
fi

hide_cursor() {
  if [ -n "$BAR_TTY" ]; then printf '\033[?25l' >&2; fi
}

show_cursor() {
  if [ -n "$BAR_TTY" ]; then printf '\033[?25h' >&2; fi
}

repeat_char() {
  rc_n="$1"
  rc_char="$2"
  rc_out=""
  rc_i=0
  while [ "$rc_i" -lt "$rc_n" ]; do
    rc_out="$rc_out$rc_char"
    rc_i=$(( rc_i + 1 ))
  done
  printf '%s' "$rc_out"
}

render_single() {
  rs_done="$1"
  rs_total="$2"
  rs_label="$3"
  rs_width=50
  if [ -z "$rs_total" ] || [ "$rs_total" = "0" ]; then
    printf '\r%s[%s] %-11s%s' "$ORANGE" "$(repeat_char "$rs_width" '-')" "$rs_label" "$RESET" >&2
    return
  fi
  rs_percent=$(( rs_done * 100 / rs_total ))
  if [ "$rs_percent" -gt 100 ]; then rs_percent=100; fi
  rs_filled=$(( rs_percent * rs_width / 100 ))
  rs_empty_n=$(( rs_width - rs_filled ))
  rs_bar="$(repeat_char "$rs_filled" '=')$(repeat_char "$rs_empty_n" '-')"
  printf '\r%s[%s] %3d%% %-11s%s' "$ORANGE" "$rs_bar" "$rs_percent" "$rs_label" "$RESET" >&2
}

file_kb() {
  fb_out="$(wc -c <"$1" 2>/dev/null || true)"
  set -- $fb_out
  case "$1" in
    '' | *[!0-9]*) echo 0 ;;
    *) echo $(( $1 / 1024 )) ;;
  esac
}

dir_kb() {
  db_out="$(du -sk "$1" 2>/dev/null || true)"
  set -- $db_out
  case "$1" in
    '' | *[!0-9]*) echo 0 ;;
    *) echo "$1" ;;
  esac
}

head_bytes() {
  hb_out="$(curl -fsSLI "$1" 2>/dev/null | tr -d '\r' | grep -i -o 'content-length: *[0-9]*' | grep -o '[0-9]*' | tail -n 1)"
  case "$hb_out" in
    '' | *[!0-9]* | 0) echo '' ;;
    *) echo "$hb_out" ;;
  esac
}

fetch_meta() {
  META_D_KB=""
  META_U_KB=""
  if ! curl -fsSL -o "$2" "$1.meta" 2>/dev/null; then return; fi
  md_d="$(grep '^archive_bytes=' "$2" 2>/dev/null | cut -d= -f2)"
  md_u="$(grep '^payload_du_kb=' "$2" 2>/dev/null | cut -d= -f2)"
  case "$md_d" in
    '' | *[!0-9]* | 0) return ;;
  esac
  case "$md_u" in
    '' | *[!0-9]* | 0) return ;;
  esac
  META_D_KB=$(( (md_d + 1023) / 1024 ))
  META_U_KB="$md_u"
}

download_to() {
  dl_url="$1"
  dl_output="$2"
  dl_total="$3"
  dl_base="$4"
  if [ -z "$BAR_TTY" ]; then
    curl -fL --progress-bar -o "$dl_output" "$dl_url"
    return $?
  fi
  : >"$dl_output"
  trap 'kill $BG_PID 2>/dev/null; show_cursor; rm -rf "$tmp_dir"; exit 130' INT TERM
  curl -fL -s -o "$dl_output" "$dl_url" &
  BG_PID=$!
  while kill -0 "$BG_PID" 2>/dev/null; do
    render_single $(( dl_base + $(file_kb "$dl_output") )) "$dl_total" Downloading
    sleep 1
  done
  BG_RET=0
  wait "$BG_PID" || BG_RET=$?
  trap 'show_cursor; rm -rf "$tmp_dir"' EXIT INT TERM
  if [ "$BG_RET" -ne 0 ]; then
    printf '\n' >&2
    return "$BG_RET"
  fi
  render_single $(( dl_base + $(file_kb "$dl_output") )) "$dl_total" Downloading
}

extract_to() {
  ex_archive="$1"
  ex_dest="$2"
  ex_total="$3"
  ex_base="$4"
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
  trap 'kill $BG_PID 2>/dev/null; show_cursor; rm -rf "$tmp_dir"; exit 130' INT TERM
  case "$ex_archive" in
    *.zip) unzip -q "$ex_archive" -d "$ex_dest" & ;;
    *) tar -xzf "$ex_archive" -C "$ex_dest" & ;;
  esac
  BG_PID=$!
  while kill -0 "$BG_PID" 2>/dev/null; do
    render_single $(( ex_base + $(dir_kb "$ex_dest") )) "$ex_total" Extracting
    sleep 1
  done
  BG_RET=0
  wait "$BG_PID" || BG_RET=$?
  trap 'show_cursor; rm -rf "$tmp_dir"' EXIT INT TERM
  if [ "$BG_RET" -ne 0 ]; then
    printf '\n' >&2
    echo "Error: extraction failed." >&2
    return 1
  fi
  render_single $(( ex_base + $(dir_kb "$ex_dest") )) "$ex_total" Extracting
}

copy_to() {
  cp_src="$1"
  cp_dest="$2"
  cp_total="$3"
  cp_base="$4"
  mkdir -p "$cp_dest"
  CP_BASE0="$(dir_kb "$cp_dest")"
  if [ -z "$BAR_TTY" ]; then
    cp -r "$cp_src/." "$cp_dest/"
    return $?
  fi
  trap 'kill $BG_PID 2>/dev/null; show_cursor; rm -rf "$tmp_dir"; exit 130' INT TERM
  cp -r "$cp_src/." "$cp_dest/" &
  BG_PID=$!
  while kill -0 "$BG_PID" 2>/dev/null; do
    cp_now="$(dir_kb "$cp_dest")"
    cp_grown=$(( cp_now - CP_BASE0 ))
    if [ "$cp_grown" -lt 0 ]; then cp_grown=0; fi
    render_single $(( cp_base + cp_grown )) "$cp_total" Installing
    sleep 1
  done
  BG_RET=0
  wait "$BG_PID" || BG_RET=$?
  trap 'show_cursor; rm -rf "$tmp_dir"' EXIT INT TERM
  if [ "$BG_RET" -ne 0 ]; then
    printf '\n' >&2
    echo "Error: install copy failed." >&2
    return 1
  fi
  cp_now="$(dir_kb "$cp_dest")"
  cp_grown=$(( cp_now - CP_BASE0 ))
  if [ "$cp_grown" -lt 0 ]; then cp_grown=0; fi
  render_single $(( cp_base + cp_grown )) "$cp_total" Installing
}

installed_version() {
  if [ -x "$BIN_DIR/$APP" ]; then
    "$BIN_DIR/$APP" --version 2>/dev/null || true
  fi
}

host_running() {
  "$BIN_DIR/$APP" daemon status 2>/dev/null | grep -q "Background host running"
}

# The running host holds its node binary open, so it must stop before the files
# under the install directory are replaced; restarting only after the copy is
# too late.
stop_running_host() {
  if ! host_running; then return 1; fi
  say "Stopping the background host so its files can be replaced."
  "$BIN_DIR/$APP" daemon stop >/dev/null 2>&1 || true
  return 0
}

start_running_host() {
  say "Starting the background host on the new version."
  "$BIN_DIR/$APP" daemon start >/dev/null 2>&1 || say "Start it later with: ranite daemon start"
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

is_update=0
if [ -z "$binary_path" ] && [ -n "$current" ] && [ "$current" != "$specific_version" ]; then
  is_update=1
fi

tmp_dir="${TMPDIR:-/tmp}/ranite_install_$$"
mkdir -p "$tmp_dir"
trap 'show_cursor; rm -rf "$tmp_dir"' EXIT INT TERM

host_was_running=0
if stop_running_host; then host_was_running=1; fi

DO_COPY=1
if [ -n "$binary_path" ]; then
  say "Installing ranite from $binary_path"
  archive="$tmp_dir/$(basename "$binary_path")"
  cp "$binary_path" "$archive"
  mkdir -p "$tmp_dir/extract"
  extract_to "$archive" "$tmp_dir/extract" "" 0
  if [ -n "$BAR_TTY" ]; then printf '\n' >&2; fi
else
  if [ "$is_update" = "1" ]; then
    say "Updating ranite $current -> $specific_version ($target)"
  else
    say "Downloading ranite $specific_version ($target)"
  fi
  archive="$tmp_dir/$filename"
  fetch_meta "$url" "$tmp_dir/meta"
  if [ -n "$BAR_TTY" ] && [ -n "$META_D_KB" ] && [ -n "$META_U_KB" ]; then
    BAR_TOTAL=$(( META_D_KB + META_U_KB + META_U_KB ))
    hide_cursor
    download_to "$url" "$archive" "$BAR_TOTAL" 0
    BASE_D="$(file_kb "$archive")"
    mkdir -p "$tmp_dir/extract"
    extract_to "$archive" "$tmp_dir/extract" "$BAR_TOTAL" "$BASE_D"
    BASE_DU=$(( BASE_D + $(dir_kb "$tmp_dir/extract") ))
    mkdir -p "$INSTALL_DIR"
    BASE_INST="$(dir_kb "$INSTALL_DIR")"
    copy_to "$tmp_dir/extract/$APP" "$INSTALL_DIR" "$BAR_TOTAL" "$BASE_DU"
    FIN_NOW="$(dir_kb "$INSTALL_DIR")"
    FIN_GROWN=$(( FIN_NOW - BASE_INST ))
    if [ "$FIN_GROWN" -lt 0 ]; then FIN_GROWN=0; fi
    FIN_DONE=$(( BASE_DU + FIN_GROWN ))
    render_single "$FIN_DONE" "$FIN_DONE" Done
    printf '\n' >&2
    show_cursor
    DO_COPY=0
  else
    DL_KNOWN=""
    if [ -n "$BAR_TTY" ]; then
      DL_BYTES="$(head_bytes "$url")"
      case "$DL_BYTES" in
        '' | *[!0-9]* | 0) ;;
        *) DL_KNOWN=$(( (DL_BYTES + 1023) / 1024 )) ;;
      esac
    fi
    download_to "$url" "$archive" "$DL_KNOWN" 0
    mkdir -p "$tmp_dir/extract"
    extract_to "$archive" "$tmp_dir/extract" "" 0
    if [ -n "$BAR_TTY" ]; then printf '\n' >&2; fi
  fi
fi

if [ "$DO_COPY" = 1 ]; then
  mkdir -p "$INSTALL_DIR"
  cp -r "$tmp_dir/extract/$APP/." "$INSTALL_DIR/"
fi
mkdir -p "$BIN_DIR"
if [ "$archive_ext" = ".zip" ]; then
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
if [ "$is_update" = "1" ]; then
  say "Updated ranite $current -> $installed."
else
  say "Installed ranite $installed to $INSTALL_DIR."
fi
if [ "$host_was_running" = "1" ]; then start_running_host; fi

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
