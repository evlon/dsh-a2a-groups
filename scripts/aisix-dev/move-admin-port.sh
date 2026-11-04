#!/bin/bash
# Move the gateway's admin listener off the port that Tabby already owns.
#
# The config said 0.0.0.0:3001, but 3001 belongs to an unrelated Express service, so the gateway
# could not bind and its admin surface never existed. That is why "the admin API is read-only" looked
# true: there was no admin API at all, only somebody else's 404 page.
#
# Whether the admin API can ADD an agent decides the whole question of whether a colleague can be
# added without an operator. So it is worth finding out rather than assuming.
set -eu

CFG=/home/niukl/aisix-dev/data/config.yaml

if grep -q '0.0.0.0:3002' "$CFG"; then
  echo "already on 3002"
else
  sed -i 's|addr: "0.0.0.0:3001"|addr: "0.0.0.0:3002"|' "$CFG"
  echo "moved admin to 3002"
fi

grep -A3 '^admin:' "$CFG"
