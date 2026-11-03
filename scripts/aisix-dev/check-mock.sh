#!/bin/sh
# Inspect the mock agent source as the container actually sees it.
#
# Exists because the pwsh → wsl → podman → sh quoting chain mangles nested
# quotes; a script file sidesteps all of it.
set -u
grep -n 'final: false' /app/mock-agent.mjs | head -3
echo '--- old pattern (should be empty) ---'
grep -n 'final: state' /app/mock-agent.mjs || echo '(none — file is updated)'
echo '--- mtime ---'
ls -l /app/mock-agent.mjs
