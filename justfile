alias b := build
alias v := version
alias c := check

pack:
    pnpm pack

build: 
    pnpm build

# Bump version (major, minor, patch or <version> e.g. 1.2.3)
version VER:
    pnpm version {{VER}}
    @TAG=$(node -p "require('./package.json').version") && \
    git push origin "v$TAG"

# get latest published package sha256
sha:
    @VERSION=$(node -p "require('./package.json').version") && \
    curl -sL "https://registry.npmjs.org/zedx/-/zedx-$VERSION.tgz" | shasum -a 256 | awk '{print $1}'

brew:
    @VERSION=$(node -p "require('./package.json').version") && \
    SHA=$(curl -sL "https://registry.npmjs.org/zedx/-/zedx-$VERSION.tgz" | shasum -a 256 | awk '{print $1}') && \
    sed -i '' "s/version '[^']*'/version '$VERSION'/" zedx.rb && \
    sed -i '' "s|url '[^']*'|url 'https://registry.npmjs.org/zedx/-/zedx-$VERSION.tgz'|" zedx.rb && \
    sed -i '' "s/sha256 '[^']*'/sha256 '$SHA'/" zedx.rb && \
    echo "Updated zedx.rb to version $VERSION ($SHA)"

check:
    pnpm lint
    pnpm fmt