# Chroma

A modern, type-safe framework for building Chrome browser extensions with dependency injection, React hooks, and automated build tooling.

## Features

- **Dependency Injection**: Built-in IoC container with decorators
- **React Integration**: Hooks and providers for seamless React development
- **Build Tools**: Automated manifest generation and build optimization
- **TypeScript First**: Full TypeScript support with strict typing
- **Semantic Versioning**: Automated releases with conventional commits
- **Professional Development**: ESLint, Prettier, and commit validation

## Packages

| Package                                 | Description                           | Version                                               |
| --------------------------------------- | ------------------------------------- | ----------------------------------------------------- |
| [@chroma/core](./packages/core)         | Core dependency injection framework   | ![npm](https://img.shields.io/npm/v/@chroma/core)     |
| [@chroma/react](./packages/react)       | React hooks and providers             | ![npm](https://img.shields.io/npm/v/@chroma/react)    |
| [@chroma/manifest](./packages/manifest) | Build tooling and manifest generation | ![npm](https://img.shields.io/npm/v/@chroma/manifest) |
| [@chroma/cli](./packages/cli)           | Command-line scaffolding tool         | ![npm](https://img.shields.io/npm/v/@chroma/cli)      |

## Quick Start

### Create a new extension

```bash
npx @chroma/cli create my-extension
cd my-extension
pnpm install
pnpm dev
```

### Manual Installation

```bash
pnpm add @chroma/core @chroma/react @chroma/manifest
```

## Development

### Prerequisites

- Node.js 18+
- pnpm 8+

### Setup

```bash
git clone https://github.com/chromaHQ/chroma.git
cd chroma
pnpm install
```

### Development Scripts

```bash
# Start development mode with watch
pnpm dev

# Build all packages
pnpm build

# Run tests
pnpm test

# Lint code
pnpm lint

# Format code
pnpm format

# Create a changeset for release
pnpm changeset
```

## Contributing

We follow [Conventional Commits](https://www.conventionalcommits.org/) for consistent commit messages and automated semantic versioning.

### Commit Message Format

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Examples

```bash
feat: add user authentication system
fix: resolve memory leak in core module
docs: update README with installation guide
```

### Release Process

1. Make changes and commit using conventional commit format
2. Run `pnpm changeset` to create a changeset
3. Create a pull request
4. After merge, GitHub Actions will automatically create a release PR
5. Merge the release PR to publish to npm

## Architecture

### Core (@chroma/core)

Provides dependency injection container with decorators:

```typescript
import { Injectable, Container } from '@chroma/core';

@Injectable()
class UserService {
  getUser() {
    return { name: 'John Doe' };
  }
}

const container = new Container();
const userService = container.get(UserService);
```

### React (@chroma/react)

React hooks for Chrome extension development:

```typescript
import { useBridge, useConnectionStatus } from '@chroma/react';

function Popup() {
  const bridge = useBridge();
  const isConnected = useConnectionStatus();

  return (
    <div>
      <p>Status: {isConnected ? 'Connected' : 'Disconnected'}</p>
    </div>
  );
}
```

### Manifest (@chroma/manifest)

Automated manifest generation and build optimization:

```typescript
// chroma.config.ts
import { defineExtension } from '@chroma/manifest';

export default defineExtension({
  name: 'My Extension',
  description: 'A Chrome extension built with Chroma',
  permissions: ['storage', 'activeTab'],
  popup: true,
});
```

## License

MIT License - see the [LICENSE](LICENSE) file for details.

## Support

- [Documentation](https://github.com/chromaHQ/chroma/docs)
- [Issues](https://github.com/chromaHQ/chroma/issues)
- [Discussions](https://github.com/chromaHQ/chroma/discussions)
