# @chromahq/store

> 🏪 **Simple, powerful state management** for Chrome extensions with automatic synchronization between service worker and UI contexts.

## ✨ Features

- **🔄 Auto-Sync**: Service worker ↔ Popup ↔ Content scripts
- **💾 Auto-Persist**: All stores automatically persist to Chrome storage
- **🎯 Zero Config**: Smart context detection - no complex setup
- **🎨 Modern API**: Clean, fluent builder pattern
- **🔒 Type Safe**: Full TypeScript support with excellent DX
- **⚡ Fast**: Optimistic updates with background sync

## 🚀 Quick Setup

### Install

```bash
npm install @chromahq/store @chromahq/core
```

## � Usage

### 1. Define Your Slices

```typescript
// src/slices/counter.ts
import type { StateCreator } from 'zustand';

export interface CounterSlice {
  count: number;
  increment: () => void;
  decrement: () => void;
  reset: () => void;
}

export const counterSlice: StateCreator<CounterSlice> = (set) => ({
  count: 0,
  increment: () => set((state) => ({ count: state.count + 1 })),
  decrement: () => set((state) => ({ count: state.count - 1 })),
  reset: () => set({ count: 0 }),
});

// Export combined type for TypeScript
export type RootState = CounterSlice; // Add more slices with &
```

### 2. Service Worker Setup

```typescript
// src/service-worker.ts
import '@abraham/reflection';
import { StoreDefinition } from '@chromahq/store';
import { bootstrap } from '@chromahq/core';
import { counterSlice } from './slices/counter';

const store: StoreDefinition = {
  name: 'app',
  slices: [counterSlice],
  // Persistence is automatic - no config needed!
};

bootstrap().withStore(store).create();
```

### 3. React UI Setup

```typescript
// src/hooks/useAppStore.ts
import { RootState } from '../slices/counter';
import { useBridge } from '@chromahq/react';
import { CentralStore, createStore } from '@chromahq/store';
import { useEffect, useState } from 'react';

export function useAppStore() {
  const { bridge } = useBridge();
  const [store, setStore] = useState<CentralStore<RootState>>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function initStore() {
      if (!bridge) return;

      const store = await createStore<RootState>('app')
        .withSlices(counterSlice)
        .withBridge(bridge)
        .create();

      setStore(store);
      setLoading(false);
    }

    initStore();
  }, [bridge]);

  return { store, loading };
}
```

```typescript
// src/components/Counter.tsx
import { useCentralStore } from '@chromahq/store';
import { useAppStore } from '../hooks/useAppStore';

export function Counter() {
  const { store, loading } = useAppStore();

  // Use the store with a selector
  const count = useCentralStore(store!, (state) => state.count);
  const increment = useCentralStore(store!, (state) => state.increment);
  const decrement = useCentralStore(store!, (state) => state.decrement);

  if (loading) return <div>Loading...</div>;

  return (
    <div>
      <h2>Count: {count}</h2>
      <button onClick={increment}>+</button>
      <button onClick={decrement}>-</button>
    </div>
  );
}
```

## 🏗 Architecture

### Service Worker (Source of Truth)

- **ServiceWorkerStore**: Real Zustand store with automatic Chrome storage persistence
- **Message Handlers**: Auto-registered for cross-context communication
- **State Authority**: The single source of truth for all application state

### UI Contexts (React/Popup/Content Scripts)

- **BridgeStore**: Lightweight proxy that connects to service worker via bridge
- **Reactive Updates**: Automatically syncs with service worker state changes
- **Optimistic Updates**: Immediate UI feedback with background synchronization

## 🎯 Key Benefits

### Simple & Clean

- **No plugin system complexity** - just slices and bridges
- **Automatic persistence** - every store persists without configuration
- **Smart context detection** - creates the right store type automatically

### Developer Experience

- **TypeScript first** - excellent type inference and safety
- **Familiar API** - built on Zustand, same patterns you know
- **Zero boilerplate** - minimal setup, maximum functionality

### Performance

- **Optimistic updates** - UI responds immediately
- **Background sync** - service worker handles persistence
- **Efficient bridge** - only sends serializable data, executes functions locally

## 📚 API Reference

### Core Functions

```typescript
// Create a store builder
createStore<T>(name?: string): StoreBuilder<T>

// StoreBuilder methods
.withSlices(...slices): StoreBuilder<T>    // Add state slices
.withBridge(bridge): StoreBuilder<T>       // Connect to service worker (UI only)
.create(): Promise<CentralStore<T>>        // Create the store

// React hooks
useCentralStore<T, U>(store, selector): U  // Subscribe to state
useCentralDispatch<T>(store): SetState<T>  // Get state updater
```

### Types

```typescript
// Store definition for service worker bootstrap
interface StoreDefinition {
  name: string;
  slices: StateCreator<any, [], [], any>[];
}

// Central store interface (both ServiceWorkerStore and BridgeStore)
interface CentralStore<T> {
  getState(): T;
  setState(partial: T | Partial<T> | ((state: T) => T | Partial<T>), replace?: boolean): void;
  subscribe(listener: (state: T, prevState: T) => void): () => void;
  ready: Promise<void>;
}
```

## 🔧 Advanced Usage

### Multiple Stores

```typescript
// Service worker
const userStore: StoreDefinition = { name: 'user', slices: [userSlice] };
const settingsStore: StoreDefinition = { name: 'settings', slices: [settingsSlice] };

bootstrap().withStore(userStore).withStore(settingsStore).create();

// React
const userStore = await createStore<UserState>('user')
  .withSlices(userSlice)
  .withBridge(bridge)
  .create();
const settingsStore = await createStore<SettingsState>('settings')
  .withSlices(settingsSlice)
  .withBridge(bridge)
  .create();
```

### Context Providers

```typescript
// Create typed hooks with context
import { createStoreHooks } from '@chromahq/store';

const { StoreProvider, useStore } = createStoreHooks<RootState>();

function App() {
  const { store } = useAppStore();

  return (
    <StoreProvider store={store}>
      <MyComponent />
    </StoreProvider>
  );
}

function MyComponent() {
  // No need to pass store around - uses context
  const count = useStore(state => state.count);
  const increment = useStore(state => state.increment);

  return <button onClick={increment}>{count}</button>;
}
```

---

**🎉 That's it!** You now have powerful, type-safe state management across your entire Chrome extension with automatic persistence and synchronization.
return (
<BridgeProvider>
<AppContent />
</BridgeProvider>
);
}

````

### 3. Use in Components

```typescript
// src/popup/components/Counter.tsx
import React from 'react';
import { useStore } from '../../hooks/useAppStore';

export function Counter() {
  // Select specific state (automatically typed!)
  const count = useStore(state => state.count);
  const { increment, decrement, reset } = useStore(state => ({
    increment: state.increment,
    decrement: state.decrement,
    reset: state.reset
  }));

  return (
    <div className="counter">
      <h2>Counter: {count}</h2>
      <div className="buttons">
        <button onClick={increment}>+1</button>
        <button onClick={decrement}>-1</button>
        <button onClick={reset}>Reset</button>
      </div>
    </div>
  );
}
````

```typescript
// src/popup/components/UserProfile.tsx
import React from 'react';
import { useStore } from '../../hooks/useAppStore';

export function UserProfile() {
  const { user, isAuthenticated } = useStore(state => ({
    user: state.user,
    isAuthenticated: state.isAuthenticated
  }));
  const { login, logout } = useStore(state => ({
    login: state.login,
    logout: state.logout
  }));

  const handleLogin = () => {
    login({
      name: 'John Doe',
      email: 'john@example.com',
      id: '12345'
    });
  };

  if (!isAuthenticated) {
    return (
      <div className="login">
        <h3>Please log in</h3>
        <button onClick={handleLogin}>Login</button>
      </div>
    );
  }

  return (
    <div className="profile">
      <h3>Welcome, {user.name}!</h3>
      <p>Email: {user.email}</p>
      <button onClick={logout}>Logout</button>
    </div>
  );
}
```

---

## 🔄 How Sync Works

### Automatic Synchronization

```typescript
// Any change in service worker...
store.getState().increment(); // count: 0 → 1

// ...automatically appears in React components!
// No manual sync code needed ✨
```

### The Magic Behind The Scenes

1. **Service Worker** creates real store with persistence
2. **React Components** create bridge store with same name
3. **@chromahq/core** bridge automatically syncs all changes
4. **State updates** flow instantly between contexts
5. **Persistence** ensures state survives browser restarts

---

## 🛠️ Advanced Usage

### Custom Plugins

```typescript
// src/app/stores/plugins.ts
import type { StorePlugin } from '@chromahq/store';

// Analytics plugin
export const analyticsPlugin: StorePlugin = {
  name: 'analytics',
  priority: 50,
  async setup(store, config) {
    store.subscribe((state, prevState) => {
      // Track state changes
      chrome.runtime.sendMessage({
        type: 'ANALYTICS_EVENT',
        data: { store: config.name, state },
      });
    });
  },
};

// Logging plugin
export const loggingPlugin: StorePlugin = {
  name: 'logging',
  priority: 10, // Higher priority = runs first
  async setup(store, config) {
    console.log(`🏪 Store "${config.name}" initialized`);

    store.subscribe((state, prevState) => {
      console.log('State change:', { from: prevState, to: state });
    });
  },
};
```

### Enhanced Store Definition

```typescript
// src/app/stores/app.store.ts
import { counterSlice, userSlice } from '../slices';
import { analyticsPlugin, loggingPlugin } from './plugins';
import type { StoreDefinition } from '@chromahq/store';

const store: StoreDefinition = {
  name: 'app',
  slices: [counterSlice, userSlice],
  persistence: {
    name: 'my-extension-state',
    version: 2,
    migrate: (state, version) => {
      // Handle state migrations
      if (version < 2) {
        return { ...state, newField: 'default' };
      }
      return state;
    },
  },
  plugins: [loggingPlugin, analyticsPlugin],
  config: {
    apiUrl: 'https://api.myservice.com',
    debugMode: true,
  },
};

export default store;
```

### Multiple Stores

```typescript
// src/app/stores/user.store.ts
import { userSlice, authSlice } from '../slices';

export default {
  name: 'user',
  slices: [userSlice, authSlice],
  persistence: { name: 'user-data' },
};

// src/app/stores/settings.store.ts
import { settingsSlice, themeSlice } from '../slices';

export default {
  name: 'settings',
  slices: [settingsSlice, themeSlice],
  persistence: { name: 'user-settings' },
};

// src/app/stores/cache.store.ts
import { cacheSlice } from '../slices';
import { ttlPlugin } from './plugins';

export default {
  name: 'cache',
  slices: [cacheSlice],
  plugins: [ttlPlugin],
};
```

---

## 🎯 Best Practices

### 1. **Store Organization**

```typescript
// ✅ Good: Feature-based slices
const userSlice = (set, get) => ({
  /* user logic */
});
const settingsSlice = (set, get) => ({
  /* settings logic */
});

// ❌ Avoid: One giant slice
const everythingSlice = (set, get) => ({
  /* 500 lines of code */
});
```

### 2. **State Selection**

```typescript
// ✅ Good: Specific selectors
const count = useStore((state) => state.count);
const userName = useStore((state) => state.user?.name);

// ❌ Avoid: Selecting entire state
const everything = useStore((state) => state); // Causes unnecessary re-renders
```

### 3. **Store Names**

```typescript
// ✅ Good: Descriptive and consistent
createStore('user-preferences'); // Service worker
createStore('user-preferences'); // React (same name!)

// ❌ Avoid: Generic or mismatched names
createStore('store'); // Service worker
createStore('data'); // React (different name!)
```

### 4. **Error Handling**

```typescript
// ✅ Good: Handle connection states
function AppContent() {
  const store = useAppStore();

  if (!store) {
    return <LoadingSpinner />;
  }

  return <MainApp store={store} />;
}

// ❌ Avoid: Assuming store is always ready
function App() {
  const store = useAppStore();
  return <StoreProvider store={store}>...</StoreProvider>; // Might be null!
}
```

---

## 🚨 Troubleshooting

### Store Not Syncing

- ✅ Ensure both stores use the **exact same name**
- ✅ Check that service worker store is created first
- ✅ Verify `@chromahq/core` bridge is initialized with `create()`

### React Components Not Updating

- ✅ Use specific selectors: `state => state.count` not `state => state`
- ✅ Ensure components are wrapped in `<StoreProvider>`
- ✅ Check that bridge connection is established

### State Not Persisting

- ✅ Add `.withPersistence({ name: 'unique-name' })` to service worker store
- ✅ Ensure service worker has storage permissions in manifest
- ✅ Check Chrome DevTools → Application → Storage → Local Storage

### TypeScript Errors

- ✅ Define interfaces for your slices
- ✅ Use `createStoreHooks<YourStateType>()` for typed hooks
- ✅ Ensure same state shape in service worker and React

---

## 📦 Package Info

- **Main API**: `createStore()` with plugin system
- **React Integration**: `createStoreHooks()` for type-safe hooks
- **Auto-Sync**: Works with `@chromahq/core` bridge
- **Persistence**: Built-in Chrome storage support
- **TypeScript**: Full type safety throughout

## 📄 License

MIT
