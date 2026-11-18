#!/usr/bin/env bash
# Writes out-abi/<Contract>.json ({ contractName, abi, bytecode }) from a fresh build, so TypeScript packages can
# import the ABI (and deploy with viem) without Foundry. Run from contracts/: ./script/export-abi.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
forge build --force --skip test script > /dev/null 2>&1
mkdir -p out-abi
for name in PriceFeed ScoutLend; do
  jq --arg n "$name" '{contractName: $n, abi: .abi, bytecode: .bytecode.object}' "out/$name.sol/$name.json" > "out-abi/$name.json"
  echo "out-abi/$name.json"
done
