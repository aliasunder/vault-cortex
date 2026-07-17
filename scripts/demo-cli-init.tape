# Records assets/demo-cli-init.gif — the `init` wizard demo embedded in
# cli/README.md (rendered on npmjs.com via a raw.githubusercontent URL).
#
# Re-record with vhs (`brew bundle` installs it): run `vhs demo-cli-init.tape`
# from a working directory containing a `setup.sh` that prepares the demo
# environment. The recording must never contain a real secret or a personal
# path, so setup.sh has three jobs:
#
#   1. Define an `npx` shell function that routes the typed
#      `npx vault-cortex@latest init` to a locally extracted copy of the
#      published package (`npm pack vault-cortex@latest`, untar, `npm install
#      --omit=dev` inside it) whose dist/token.js is patched to return the
#      fixed fake token "0123456789abcdef".repeat(4) — the connect message
#      prints the token, and a committed GIF must never hold a real one:
#        npx() { node /path/to/package/dist/bin.js "${@:2}"; }
#   2. cd into a username-neutral working directory (e.g. /Users/Shared/demo).
#   3. Expect a scratch vault at /Users/Shared/Vaults/MyVault containing a
#      .obsidian/ directory and a few sample .md files.
#
# Docker must be running with ghcr.io/aliasunder/vault-cortex:latest already
# pulled (the wizard starts a real container; pre-pulling keeps the recorded
# health-check wait short). Between takes: `docker rm -f vault-cortex` and
# delete the demo dir's vault-cortex/ config folder, or the wizard hits the
# overwrite-conflict flow instead of the happy path.
Output demo-cli-init.gif

Set Shell "bash"
Set FontSize 15
Set Width 940
Set Height 1020
Set Padding 16
Set TypingSpeed 55ms

Hide
Type "source ./setup.sh && clear"
Enter
Show

Type "npx vault-cortex@latest init"
Sleep 700ms
Enter

Wait+Screen@15s /How do you want to run/
Sleep 1.5s
Enter

Wait+Screen@15s /Path to your Obsidian vault/
Sleep 1s
Type "/Users/Shared/Vaults/MyVault"
Sleep 500ms
Enter

Wait+Screen@15s /config files/
Sleep 1s
Enter

Wait+Screen@15s /Start the server now/
Sleep 1s
Enter

# The connect message prints atomically right after the health check passes,
# so there is no reliable later screen state to Wait on — linger instead.
Wait+Screen@150s /Server is up/
Sleep 7s
