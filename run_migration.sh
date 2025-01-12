#!/bin/bash

if [ -z "$1" ]; then
  echo "Usage: ./run_migration <migration_name>"
  exit 1
fi

s="${1%.ts}"
cp "Anchor.toml" "Anchor.toml.bak";
echo -e "\n$s = \"yarn run ts-mocha -p ./tsconfig.json -t 1000000 migrations/$s.ts\"" >> "Anchor.toml"
anchor run $s;
mv "Anchor.toml.bak" "Anchor.toml";
