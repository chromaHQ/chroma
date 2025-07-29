# Release Management

This project uses automated semantic versioning and publishing through GitHub Actions.

## Release Process

### Manual Release (Recommended)

1. **Trigger Release Workflow**:
   - Go to GitHub Actions → Release workflow
   - Click "Run workflow"
   - Choose version bump: `patch`, `minor`, `major`, or specific version (e.g., `1.2.3`)

2. **What Happens Automatically**:
   - Updates package versions
   - Builds all packages
   - Creates git tag
   - Publishes to npm
   - Creates GitHub release with auto-generated notes

### Local Release (Alternative)

```bash
# Update package versions manually
pnpm --filter "@chroma/*" version patch  # or minor, major

# Build and publish
pnpm release
```

## Version Types

- **patch**: Bug fixes and minor updates (1.0.0 → 1.0.1)
- **minor**: New features (1.0.0 → 1.1.0)
- **major**: Breaking changes (1.0.0 → 2.0.0)
- **specific**: Use exact version like `1.2.3`

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

This project follows [Semantic Versioning](https://semver.org/).

- **MAJOR** version when you make incompatible API changes
- **MINOR** version when you add functionality in a backward compatible manner
- **PATCH** version when you make backward compatible bug fixes

Changesets automatically determines the correct version bump based on your changeset selections.
