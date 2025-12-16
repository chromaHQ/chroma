# GitHub Copilot Instructions

## General Guidelines

### Documentation

- **DO NOT** create summary `.md` files after completing tasks
- Documentation should only be created when explicitly requested by the user
- Focus on code implementation rather than documentation generation

### Code Quality

- Follow existing code patterns and conventions in the codebase
- Use TypeScript types appropriately
- Write clear, self-documenting code with minimal comments

### Code Organization

- **DO NOT** add business logic directly to components or providers
- Extract business logic into custom hooks in the appropriate directory:
  - `/hooks/wallet/` - Wallet-related logic
  - `/hooks/browser/` - Browser/extension-related logic
  - `/hooks/bridge/` - Bridge communication logic
- Keep components and providers focused on presentation and composition

### Communication

- Keep responses concise and focused on the task
- Explain changes when they affect multiple parts of the system
- Ask clarifying questions when requirements are ambiguous

---

## React Component Architecture

### Separation of Concerns Pattern

When creating or refactoring components, follow this structure:

```
feature/
├── hooks/
│   ├── index.ts              # Barrel exports
│   ├── useFeatureLogic.ts    # Main business logic hook
│   └── useFeatureFlow.ts     # Flow/navigation logic hook
├── components/
│   ├── index.ts              # Barrel exports
│   ├── FeatureItem.tsx       # Reusable presentational component
│   └── FeatureProgress.tsx   # UI-only component
│   └── steps/
│       └── FeatureStep.tsx   # Page/step component (composes hooks + components)
├── contexts/
│   └── FeatureContext.tsx    # Shared state if needed
└── types/
    └── feature-types.ts      # TypeScript interfaces
```

### Custom Hooks Pattern

**Structure:**

```typescript
interface UseFeatureProps {
  // Input data
  items: Item[];
  // Callbacks from parent
  onItemProcessed: (id: string, data: Data) => void;
}

export function useFeature({ items, onItemProcessed }: UseFeatureProps) {
  // 1. State declarations
  const [state, setState] = useState<State>(initialState);

  // 2. Computed values (useMemo)
  const derivedValue = useMemo(() => /* ... */, [deps]);

  // 3. Internal helpers (useCallback)
  const internalHelper = useCallback(async () => { /* ... */ }, [deps]);

  // 4. Public actions (useCallback)
  const publicAction = useCallback(async () => { /* ... */ }, [deps]);

  // 5. Return object
  return {
    // State
    state,
    isLoading,
    error,

    // Computed
    derivedValue,

    // Actions
    publicAction,
  };
}
```

**Naming conventions:**

- `useXxxVerification` - Validation/verification logic
- `useXxxFlow` - Navigation/step flow logic
- `useXxxState` - Complex state management
- `useXxxData` - Data fetching/caching

### Presentational Components Pattern

**Structure:**

```tsx
interface ComponentProps {
  // Data
  item: Item;
  // State
  isActive: boolean;
  error?: string;
  // Handlers
  onChange: (id: string, value: string) => void;
}

export const Component: React.FC<ComponentProps> = ({ item, isActive, error, onChange }) => {
  // NO useState for business logic
  // NO useEffect for data fetching
  // NO async operations

  return <div>{/* Pure rendering based on props */}</div>;
};
```

### Page/Step Components Pattern

**Structure:**

```tsx
export const PageComponent: React.FC = () => {
  // 1. Context hooks
  const { state, actions } = useFeatureContext();

  // 2. Business logic hooks
  const {
    data,
    isLoading,
    actions: logicActions,
  } = useFeatureLogic({
    items: state.items,
    onComplete: actions.onComplete,
  });

  // 3. Flow hooks
  const { isProcessing, proceed } = useFeatureFlow({
    canProceed: data.isValid,
    onProceed: actions.goToNext,
  });

  // 4. Effects (minimal, UI-only)
  useEffect(() => {
    logicActions.initialize();
  }, [logicActions.initialize]);

  // 5. Event handlers (thin wrappers)
  const handleSubmit = async () => {
    if (data.isComplete) {
      await proceed();
    } else {
      await logicActions.validate();
    }
  };

  // 6. Render (composition only)
  return (
    <>
      <FeatureProgress data={data.progress} />
      {data.items.map((item) => (
        <FeatureItem key={item.id} item={item} onChange={logicActions.updateItem} />
      ))}
      <Footer onSubmit={handleSubmit} isDisabled={isProcessing} />
    </>
  );
};
```

### Barrel Exports Pattern

**hooks/index.ts:**

```typescript
export { useFeatureLogic, type FeatureState } from './useFeatureLogic';
export { useFeatureFlow } from './useFeatureFlow';
```

**components/index.ts:**

```typescript
export { default as FeatureProgress } from './FeatureProgress';
export { FeatureItem } from './FeatureItem';
```

### Anti-Patterns to Avoid

❌ **Don't:**

- Put `useState` for business data in components
- Make API calls directly in components
- Have components > 200 lines
- Mix presentation and business logic
- Use `useEffect` for data transformations

✅ **Do:**

- Extract all business logic to hooks
- Keep components focused on rendering
- Use composition over inheritance
- Create small, focused hooks
- Use `useMemo` for derived state

## Code Style Rules (IMPORTANT)

- Write **clean, professional-grade TypeScript code**
- Follow **single responsibility principle** - small, focused functions
- Use **descriptive variable names** - avoid abbreviations unless industry standard
- Prefer **early returns** over deeply nested conditionals
- Use **const** by default, **let** only when reassignment is needed
- Group related code with **blank lines** for visual separation
- Extract **magic numbers** into named constants with clear documentation
- Use **readonly** for immutable properties and parameters where appropriate
- Prefer **Map/Set** over plain objects for dynamic key collections
- Use **explicit return types** on public methods
- Avoid `any` - use `unknown` with type guards or proper interfaces

## TSDoc & Documentation Style (CRITICAL - Follow Consistently)

### File-Level Documentation

Every TypeScript file MUST start with a `@fileoverview` block:

````typescript
/**
 * @fileoverview Brief description of the file's purpose.
 *
 * Longer explanation of what this module does, its responsibilities,
 * and any important context (2-4 sentences).
 *
 * @module path/to/module
 *
 * @example
 * ```typescript
 * // Usage example if applicable
 * const result = myFunction();
 * ```
 */
````

### Visual Section Separators

Use ASCII box separators to organize code into logical sections:

```typescript
// ─────────────────────────────────────────────────────────────────────────────
// Section Name (e.g., "Constants", "Types", "Public Methods", "Private Helpers")
// ─────────────────────────────────────────────────────────────────────────────
```

### Function/Method Documentation

All public functions and methods MUST have comprehensive TSDoc:

````typescript
/**
 * Brief one-line description of what the function does.
 *
 * Longer explanation if needed. Explain the "why" not just the "what".
 * Include any important context, edge cases, or performance notes.
 *
 * @param paramName - Description of parameter (use lowercase for start)
 * @param options - Configuration options object
 * @param options.field - Description of nested option field
 * @returns Description of return value
 * @throws {ErrorType} When this error occurs
 *
 * @example
 * ```typescript
 * const result = myFunction('input', { field: true });
 * console.log(result); // Expected output
 * ```
 *
 * @see {@link RelatedFunction} for related functionality
 */
````

### Interface/Type Documentation

```typescript
/**
 * Brief description of what this type represents.
 *
 * @interface
 */
export interface MyInterface {
  /** Description of this field */
  fieldName: string;

  /**
   * Longer description for complex fields.
   * Can span multiple lines.
   */
  complexField: ComplexType;
}
```

### Enum Documentation

```typescript
/**
 * Description of what this enum represents.
 *
 * @enum {string}
 */
export enum MyEnum {
  /** Description of this value */
  VALUE_ONE = 'value_one',

  /** Description of this value */
  VALUE_TWO = 'value_two',
}
```

### Constant Documentation

```typescript
/**
 * Description of what this constant is for.
 * Include units if applicable (e.g., "in milliseconds").
 */
export const MY_CONSTANT = 42;
```

### Class Documentation

````typescript
/**
 * Brief description of class purpose.
 *
 * Longer explanation of the class's role, responsibilities,
 * and how it fits into the system architecture.
 *
 * @implements {IInterface} - if applicable
 * @see {@link RelatedClass} for related functionality
 *
 * @example
 * ```typescript
 * const instance = new MyClass(dependency);
 * await instance.doSomething();
 * ```
 */
@Injectable()
export class MyClass implements IInterface {
````

### Test File Documentation

```typescript
/**
 * @fileoverview Unit tests for MyClass.
 *
 * Tests cover:
 * - Feature 1 behavior
 * - Feature 2 edge cases
 * - Error handling scenarios
 *
 * @module path/to/__tests__/my-class
 */
```

### Import Organization

Organize imports in this order with blank lines between groups:

```typescript
// 1. Node.js built-ins
import { EventEmitter } from 'events';

// 2. External packages (npm)
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// 3. Internal packages (@crucible/*)
import { normalizeAddressToHex, ChainEvent } from '@crucible/shared';

// 4. Relative imports (local)
import { MyService } from './my.service';
import { MyType } from './types';
```
