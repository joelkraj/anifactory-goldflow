#!/bin/zsh
set -e

SCRIPT_DIR="${0:A:h}"
cd "${SCRIPT_DIR:h:h}"

node apps/goldflow-studio/desktop/main.mjs
