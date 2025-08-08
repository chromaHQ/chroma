# Chroma Framework

Chroma is a modern, type-safe framework for building Chrome extensions. It provides secure messaging, dependency injection, React integration, and automated tooling for efficient extension development.

## Features

- Secure messaging between service worker, popup, and content scripts
- Option to keep the service worker alive (configurable)
- Validates message origin for security
- Small bundle size for fast load
- Automatic service registration (no decorator required)
- React hooks and providers
- Full TypeScript support
- Message handlers and services can inject other services
- Automatic circular dependency detection

## Installation

```bash
pnpm add @chromahq/core @chromahq/react @chromahq/manifest
```

## Messaging Example

```typescript
// Service Worker
import { bootstrap } from '@chromahq/core';

bootstrap().create({
  keepPortAlive: true,
  portName: 'chroma-bridge',
});

// Popup or Content Script
import { useBridge } from '@chromahq/react';

const bridge = useBridge();
bridge.send('getUser', { userId: '123' }).then((response) => {
  console.log('User:', response.data);
});
```

## Handlers and Service Injection

- Message handlers can inject any registered service.
- Services can also inject other services.
- All dependencies are resolved automatically.

```typescript
// Example handler that injects a service
export default class GetUserHandler {
  constructor(private readonly userService) {}

  async handle(payload) {
    return await this.userService.getUser(payload.userId);
  }
}

// Example service that injects another service
export default class UserService {
  constructor(private readonly logger) {}

  getUser(id) {
    this.logger.info('Fetching user', id);
    return { id, name: 'John Doe' };
  }
}
```

## Circular Dependency Detection

Chroma automatically detects circular dependencies between services and handlers. If a cycle is found, it will log a warning and provide suggestions for resolution.

## Keep-Alive Option

To keep the service worker running, set `keepPortAlive: true`:

```typescript
bootstrap().create({ keepPortAlive: true });
```

You can change the interval by editing `KEEP_ALIVE_INTERVAL_MS` in your bridge runtime.

## Security

- Only accepts messages from the same extension (checks `port.sender.id`)
- No cross-extension message leakage

## Bundle Size

Chroma core is optimized for minimal size. Typical builds are under 30KB gzipped.

## Service Registration

You do not need to use any decorator for your services. Chroma automatically discovers and registers services:

```typescript
export default class UserService {
  constructor(private readonly logger) {}

  getUser() {
    return { name: 'John Doe' };
  }
}
```

## Development Workflow

- TypeScript for type safety
- ESLint & Prettier for code quality
- Conventional Commits for versioning
- Automated build with Rollup and Vite

## Support & Documentation

- [Documentation](https://github.com/chromaHQ/chroma/docs)
- [Issues](https://github.com/chromaHQ/chroma/issues)
- [Discussions](https://github.com/chromaHQ/chroma/discussions)

## License

MIT License
