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

if [ -n "$binary_path" ]; then
  say "Installing ranite from $binary_path"
  archive="$tmp_dir/$(basename "$binary_path")"
  cp "$binary_path" "$archive"
else
  say "Downloading ranite $specific_version ($target)"
  archive="$tmp_dir/$filename"
  curl -fL --progress-bar -o "$archive" "$url"
fi

mkdir -p "$tmp_dir/extract"
case "$archive" in
  *.zip) archive_ext=".zip"; unzip -q "$archive" -d "$tmp_dir/extract" ;;
  *) archive_ext=".tar.gz"; tar -xzf "$archive" -C "$tmp_dir/extract" ;;
esac

mkdir -p "$INSTALL_DIR"
cp -r "$tmp_dir/extract/$APP/." "$INSTALL_DIR/"
mkdir -p "$BIN_DIR"
if [ "$archive_ext" = ".zip" ]; then
  # Windows archive: the bundled runtime is node.exe, runnable from POSIX shells too.
  cat > "$BIN_DIR/$APP" <<EOF
#!/bin/sh
# Generated by the ranite installer. Uses the bundled Node.js runtime.
ROOT="\$(CDPATH= cd -- "\$(dirname -- "\$0")/.." && pwd)"
exec "\$ROOT/node/node.exe" "\$ROOT/app/dist/cli.js" "\$@"
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
