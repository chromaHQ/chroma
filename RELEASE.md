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

### Method 1: Manual Workflow Dispatch (Recommended)

1. Go to GitHub Actions in your repository
2. Select "Manual Release" workflow
3. Click "Run workflow"
4. Choose release type (patch, minor, major)
5. Packages will be automatically published to npm

### Method 2: Traditional Changesets Flow

#### 1. Making Changes

1. Create a feature branch from `main`
2. Make your changes
3. Commit using conventional commit format
4. Create a pull request

#### 2. Adding Changesets

When you make changes that should trigger a release, add a changeset:

```bash
pnpm changeset
```

This will:
- Prompt you to select which packages were changed
- Ask for the type of change (major, minor, patch)
- Generate a changeset file in `.changeset/`

#### 3. Manual Release

After changesets are added and merged to main:

```bash
# Version packages (updates package.json and CHANGELOG.md)
pnpm version-packages

# Build and publish to npm
pnpm release
```

Or use the GitHub Actions "Release" workflow manually.

## GitHub Secrets Required

Set these secrets in your GitHub repository:

- `NPM_TOKEN`: Your npm authentication token with publish permissions

## No Special Permissions Needed

This setup works with GitHub's default workflow permissions. No need to enable:
- ❌ "Read and write permissions" 
- ❌ "Allow GitHub Actions to create and approve pull requests"

The workflows use manual triggers to avoid permission issues while maintaining security.

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
