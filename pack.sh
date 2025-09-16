#!/bin/sh
set -e

echo "Building @chromahq/core..."
cd packages/core
pnpm run build
pnpm pack
cd ../..

echo "Building @chromahq/react..."
cd packages/react
pnpm run build
pnpm pack
cd ../..

echo "Building @chromahq/store..."
cd packages/store
pnpm run build
pnpm pack
cd ../..

echo "All packages built and packed successfully."