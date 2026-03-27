# zedx

Scaffold [Zed Editor](https://zed.dev/) extensions and sync your settings across machines.

![screenshot](./assets/screenshot1.png)

## Installation

```bash
npm install -g zedx

# or
brew install tahayvr/tap/zedx
```

### Usage

```bash
# Create a new extension
zedx

# Add a theme or language to an existing extension
zedx add theme "Midnight Blue"
zedx add language rust

# Validate extension config and show what is missing or incomplete
zedx check

# Bump extension version
zedx version patch   # 1.2.3 → 1.2.4
zedx version minor   # 1.2.3 → 1.3.0
zedx version major   # 1.2.3 → 2.0.0

# Sync Zed settings and extensions via a GitHub repo
zedx sync init       # Link a GitHub repo as the sync target (run once)
zedx sync            # Sync local and remote config automatically
zedx sync install    # Install an OS daemon to auto-sync when Zed config changes
zedx sync uninstall  # Remove the OS daemon
```

### Supported extension types:

1. **Themes** - Color schemes for the editor
2. **Languages** - Syntax highlighting, indentation, and optional LSP support

You can choose to include theme, language, or both when creating an extension.
