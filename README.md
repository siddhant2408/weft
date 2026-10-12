# Margin

Comment threads on anything you read, where the replies come from AI. Spec: Notion → Tech → "Margin — … Technical Specification".

## Setup (macOS)
1. `./native-host/install.sh` registers the native host (extension ID is pinned by `key` in manifest.json).
2. Chrome → `chrome://extensions` → Developer mode → Load unpacked → this folder.
3. `claude` must be installed at `~/.local/bin/claude` and logged in.

## Checks
- `python3 native-host/test_host.py`: host round-trip, prompt-injection (no tools), bad request.
- Host log: `~/Library/Logs/margin-host.log` (no prompt text).
