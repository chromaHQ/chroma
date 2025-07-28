# Release Management

This project uses automated semantic versioning and publishing through Changesets and GitHub Actions.

## Conventional Commits

All commits must follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Types

- `feat`: A new feature
- `fix`: A bug fix
- `docs`: Documentation only changes
- `style`: Changes that do not affect the meaning of the code
- `refactor`: A code change that neither fixes a bug nor adds a feature
- `perf`: A code change that improves performance
- `test`: Adding missing tests or correcting existing tests
- `build`: Changes that affect the build system or external dependencies
- `ci`: Changes to CI configuration files and scripts
- `chore`: Other changes that don't modify src or test files
- `revert`: Reverts a previous commit

### Examples

```
feat: add user authentication
fix: resolve memory leak in core module
docs: update README with installation instructions
perf: optimize bundle size by lazy loading components
```

## Creating Releases

### 1. Making Changes

1. Create a feature branch from `main`
2. Make your changes
3. Commit using conventional commit format
4. Create a pull request

### 2. Adding Changesets

When you make changes that should trigger a release, add a changeset:

```bash
pnpm changeset
```

This will:

- Prompt you to select which packages were changed
- Ask for the type of change (major, minor, patch)
- Generate a changeset file in `.changeset/`

### 3. Automatic Releases

When changes are merged to `main`:

1. GitHub Actions will run tests and build packages
2. If there are pending changesets, a "Release PR" will be created
3. The Release PR will:
   - Update package versions according to semantic versioning
   - Update CHANGELOG.md files
   - Remove consumed changeset files
4. When the Release PR is merged, packages are automatically published to npm

## Manual Release

To manually trigger a release:

```bash
# Version packages (updates package.json and CHANGELOG.md)
pnpm version-packages

# Build and publish to npm
pnpm release
```

## GitHub Secrets Required

Set these secrets in your GitHub repository:

- `NPM_TOKEN`: Your npm authentication token with publish permissions

## Package Publishing

All packages are published with:

- Public access (`"access": "public"`)
- Proper repository metadata
- Professional descriptions and keywords
- MIT license

Published packages:

- `@chroma/core` - Core dependency injection framework
- `@chroma/react` - React hooks and providers
- `@chroma/manifest` - Build tooling and manifest generation
- `@chroma/cli` - Command-line scaffolding tool

## Versioning Strategy

This project follows [Semantic Versioning](https://semver.org/):

- **MAJOR** version when you make incompatible API changes
- **MINOR** version when you add functionality in a backward compatible manner
- **PATCH** version when you make backward compatible bug fixes

Changesets automatically determines the correct version bump based on your changeset selections.
