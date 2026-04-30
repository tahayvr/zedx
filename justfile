alias b := build
alias v := version
alias c := check

# Create a tarball of the package (without publishing)
pack:
    pnpm pack

# Build the package (creates dist/)
build:
    pnpm build

# Bump version (major, minor, patch or <version> e.g. 1.2.3)
version VER:
    pnpm version {{ VER }}
    @TAG=$(node -p "require('./package.json').version") && \
    git push origin main && \
    git push origin "v$TAG"

# get latest published package sha256
sha:
    @VERSION=$(node -p "require('./package.json').version") && \
    curl -sL "https://registry.npmjs.org/zedx/-/zedx-$VERSION.tgz" | shasum -a 256 | awk '{print $1}'

# Update Homebrew formula with latest version and sha256
brew:
    @VERSION=$(node -p "require('./package.json').version") && \
    SHA=$(curl -sL "https://registry.npmjs.org/zedx/-/zedx-$VERSION.tgz" | shasum -a 256 | awk '{print $1}') && \
    sed -i '' "s/version '[^']*'/version '$VERSION'/" zedx.rb && \
    sed -i '' "s|url '[^']*'|url 'https://registry.npmjs.org/zedx/-/zedx-$VERSION.tgz'|" zedx.rb && \
    sed -i '' "s/sha256 '[^']*'/sha256 '$SHA'/" zedx.rb && \
    echo "Updated zedx.rb to version $VERSION ($SHA)"

# Run linters and formatters
check:
    pnpm lint
    pnpm fmt
