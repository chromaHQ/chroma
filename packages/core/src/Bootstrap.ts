import { container } from './di/Container';
import { bootstrap as bridgeBootstrap } from './runtime/BridgeRuntime';
import { JobRegistry, Scheduler } from './scheduler';
import { IJob } from './scheduler/core/IJob';
import { Logger } from './interfaces/Logger';
import { PopupVisibilityService } from './services/PopupVisibilityService';
import { AppEventBus, EventBusToken } from './events/AppEventBus';
import { getSubscribeMetadata } from './events/Subscribe';

type Newable<T> = new (...args: any[]) => T;

interface ServiceMetadata {
  readonly service: Newable<any>;
  readonly dependencies: ReadonlyArray<Newable<any>>;
  registered: boolean;
}

interface CircularDependency {
  readonly cycle: ReadonlyArray<string>;
  readonly services: ReadonlyArray<string>;
}

interface RegistrationResult {
  readonly success: boolean;
  readonly message: string;
  readonly error?: Error;
}

interface DependencyNode {
  readonly service: string;
  readonly dependencies: string[];
  readonly constructor: Newable<any>;
}

interface CircularDependencyDetectionResult {
  readonly hasCircularDependencies: boolean;
  readonly cycles: CircularDependency[];
  readonly dependencyGraph: Map<string, DependencyNode>;
}

/**
 * Application Bootstrap Manager
 * Handles automatic service discovery, dependency resolution, and application initialization
 */
class ApplicationBootstrap {
  private readonly serviceDependencies = new Map<string, ServiceMetadata>();
  private readonly serviceRegistry = new Map<string, Newable<any>>();
  private readonly jobRegistry = new Map<string, Newable<any>>();
  private logger: Logger = new BootstrapLogger();
  private readonly storeDefinitions: {
    def: any;
    store: any;
    classes: any;
  }[] = [];

  private scheduler: Scheduler | undefined;

  /**
   * Add a store definition to be initialized
   */
  public withStore(storeDefinition: { def: any; store: any; classes: any }): ApplicationBootstrap {
    if (storeDefinition && storeDefinition.def && storeDefinition.store) {
      this.storeDefinitions.push(storeDefinition);
    }
    return this;
  }

  /**
   * Add multiple store definitions to be initialized
   */
  public withStores(storeDefinitions: any[]): ApplicationBootstrap {
    storeDefinitions.forEach((store) => this.withStore(store));
    return this;
  }

  /**
   * Create and initialize a new Chroma application instance
   */
  public async create({
    keepPortAlive = true,
    portName,
    enableLogs = true,
    disableBootMethods = false,
  }: {
    keepPortAlive?: boolean;
    portName?: string;
    enableLogs?: boolean;
    disableBootMethods?: boolean;
  }): Promise<void> {
    try {
      this.logger = new BootstrapLogger(enableLogs);
      this.logger.info('Starting Chroma application bootstrap...');

      // Bind global event bus before service discovery so it can be injected
      this.initializeEventBus();

      await this.discoverAndInitializeStores();
      await this.discoverServices();

      const store = this.storeDefinitions[0].store;

      if (!store.isReady()) {
        this.logger.debug('Waiting for store to be ready...');
        await new Promise((resolve) => store.onReady(resolve));
      }

      await this.registerMessages();
      await this.registerJobs();

      // Initialize bridge runtime for message handling
      const runtime = bridgeBootstrap({
        container,
        portName,
        enableLogging: enableLogs,
        keepAlive: keepPortAlive,
      });

      store.setBridge(runtime);

      if (!disableBootMethods) {
        await this.bootMessages();
        await this.bootServices();
        this.wireEventSubscriptions();
      }

      this.logger.success('Chroma application initialization complete');
    } catch (error) {
      this.logger.error('Application bootstrap failed:', error as any);
      throw error;
    }
  }
  /**
   * Boot all registered services by calling their onBoot method if present
   */
  private async bootServices(): Promise<void> {
    this.logger.info('Booting services...');

    const bootPromises = Array.from(this.serviceRegistry.entries()).map(
      async ([serviceName, ServiceClass]) => {
        try {
          const instance = container.get(ServiceClass);

          if (typeof instance.onBoot === 'function') {
            await instance.onBoot();
            this.logger.success(`Booted service: ${serviceName}`);
            return { serviceName, success: true };
          }
          return { serviceName, success: true, skipped: true };
        } catch (error) {
          this.logger.error(`Failed to boot service ${serviceName}:`, error as any);
          return { serviceName, success: false, error };
        }
      },
    );

    await Promise.all(bootPromises);
  }

  /**
   * Create and bind the global AppEventBus singleton to the DI container.
   * Called early in bootstrap so any service can inject it.
   */
  private initializeEventBus(): void {
    if (!container.isBound(AppEventBus)) {
      container.bind(AppEventBus).toSelf().inSingletonScope();
    }

    if (!container.isBound(EventBusToken)) {
      container
        .bind(EventBusToken)
        .toDynamicValue(() => container.get(AppEventBus))
        .inSingletonScope();
    }

    this.logger.debug('AppEventBus bound to DI container');
  }

  /**
   * Scan all registered services and jobs for @Subscribe metadata and
   * wire the decorated methods to the AppEventBus.
   *
   * This runs after bootServices so every singleton is already instantiated.
   */
  private wireEventSubscriptions(): void {
    this.logger.info('Wiring @Subscribe event subscriptions...');

    const bus = container.get(AppEventBus);
    let wiredCount = 0;

    // Helper to scan a single class
    const scan = (name: string, Constructor: Newable<any>) => {
      const metadata = getSubscribeMetadata(Constructor);

      if (metadata.length === 0) {
        return;
      }

      let instance: any;

      try {
        instance = container.get(Constructor);
      } catch {
        this.logger.warn(`Could not resolve instance for ${name}, skipping @Subscribe wiring`);
        return;
      }

      for (const { eventName, methodName } of metadata) {
        const method = instance[methodName];

        if (typeof method !== 'function') {
          this.logger.warn(
            `@Subscribe('${eventName}') on ${name}.${methodName} is not a function, skipping`,
          );
          continue;
        }

        bus.on(eventName, method.bind(instance), `${name}.${methodName}`);
        wiredCount++;

        this.logger.debug(`Wired @Subscribe('${eventName}') → ${name}.${methodName}`);
      }
    };

    // Scan all services
    for (const [name, Constructor] of this.serviceRegistry) {
      scan(name, Constructor);
    }

    // Scan all jobs
    for (const [name, Constructor] of this.jobRegistry) {
      scan(name, Constructor);
    }

    this.logger.success(`Wired ${wiredCount} @Subscribe handler(s) to AppEventBus`);
  }

  /**
   * Discover all services in the application directory
   */
  private async discoverServices(): Promise<void> {
    this.logger.info('Discovering services...');

    const serviceModules = import.meta.glob<{ default?: Newable<any> }>(
      '/src/app/services/**/*.service.{ts,js}',
      { eager: true },
    );

    // First pass: collect all service classes
    const serviceClasses: Newable<any>[] = [];

    for (const module of Object.values(serviceModules)) {
      const ServiceClass = module?.default;
      if (ServiceClass) {
        serviceClasses.push(ServiceClass);
        this.serviceRegistry.set(ServiceClass.name, ServiceClass);
      }
    }

    // Second pass: detect circular dependencies before registration
    const circularDepsResult = this.detectCircularDependencies(serviceClasses);

    if (circularDepsResult.hasCircularDependencies) {
      this.logger.error('Circular dependencies detected!');
      circularDepsResult.cycles.forEach((cycle, index) => {
        this.logger.error(`Cycle ${index + 1}: ${cycle.cycle.join(' → ')} → ${cycle.cycle[0]}`);
      });
      throw new Error(`Circular dependencies found. Cannot initialize services.`);
    }

    // Third pass: register services if no circular dependencies
    for (const ServiceClass of serviceClasses) {
      container.bind(ServiceClass).toSelf().inSingletonScope();
      this.logger.debug(`Discovered service: ${ServiceClass.name}`);
    }

    this.logger.success(
      `Registered ${serviceClasses.length} services without circular dependencies`,
    );
  }

  /**
   * Detect circular dependencies in service classes using reflection
   * Enhanced: logs all detected dependencies for debugging
   */
  private detectCircularDependencies(
    serviceClasses: Newable<any>[],
  ): CircularDependencyDetectionResult {
    const dependencyGraph = new Map<string, DependencyNode>();

    // Build dependency graph from constructor metadata
    for (const ServiceClass of serviceClasses) {
      const dependencies = this.extractDependencies(ServiceClass);
      // Debug: log what dependencies are detected for each service
      this.logger.debug(`[DependencyDetection] ${ServiceClass.name} dependencies:`, {
        dependencies: dependencies.map((dep) =>
          typeof dep === 'function' ? dep.name : typeof dep === 'string' ? dep : dep?.toString(),
        ),
      });
      const dependencyNames = dependencies.map((dep) =>
        typeof dep === 'function' ? dep.name : typeof dep === 'string' ? dep : dep?.toString(),
      );
      dependencyGraph.set(ServiceClass.name, {
        service: ServiceClass.name,
        dependencies: dependencyNames,
        constructor: ServiceClass,
      });
    }

    // Detect cycles using DFS
    const cycles: CircularDependency[] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const currentPath: string[] = [];

    for (const serviceName of dependencyGraph.keys()) {
      if (!visited.has(serviceName)) {
        this.detectCycles(
          serviceName,
          dependencyGraph,
          visited,
          recursionStack,
          currentPath,
          cycles,
        );
      }
    }

    return {
      hasCircularDependencies: cycles.length > 0,
      cycles,
      dependencyGraph,
    };
  }

  /**
   * Extract dependencies from constructor using reflect-metadata
   * Fallback: parse constructor parameter names if metadata is missing
   */
  private extractDependencies(ServiceClass: Newable<any>): any[] {
    try {
      // Get constructor parameter types (preferred)
      const paramTypes = Reflect.getMetadata('design:paramtypes', ServiceClass) || [];
      // Get injected tokens from inversify metadata
      const injectMetadata = Reflect.getMetadata('inversify:tagged', ServiceClass) || new Map();
      const dependencies: any[] = [];

      // Process each constructor parameter
      for (let i = 0; i < paramTypes.length; i++) {
        const paramType = paramTypes[i];
        const paramMetadata = injectMetadata.get(i);
        if (paramMetadata && paramMetadata.length > 0) {
          // Use injected token if available
          const injectTag = paramMetadata.find((tag: any) => tag.key === 'inject');
          if (injectTag) {
            dependencies.push(injectTag.value);
          } else {
            dependencies.push(paramType);
          }
        } else {
          dependencies.push(paramType);
        }
      }

      // Fallback: If no dependencies found, try to parse constructor parameter names
      if (dependencies.length === 0) {
        const paramNames = this.getConstructorParamNames(ServiceClass);
        this.logger.debug(
          `[DependencyDetection:FALLBACK] ${ServiceClass.name} constructor param names:`,
          { paramNames },
        );
        return paramNames;
      }

      return dependencies.filter((dep) => dep && dep !== Object);
    } catch (error) {
      this.logger.debug(`Could not extract dependencies for ${ServiceClass.name}: ${error}`);
      return [];
    }
  }

  /**
   * Fallback: Parse constructor parameter names from function source
   */
  private getConstructorParamNames(ServiceClass: Newable<any>): string[] {
    const constructor = ServiceClass.prototype.constructor;
    const src = constructor.toString();
    // Match the constructor argument list
    const match = src.match(/constructor\s*\(([^)]*)\)/);
    if (!match) return [];
    const params = match[1]
      .split(',')
      .map((p: string) => p.trim())
      .filter((p: string) => p.length > 0);
    return params;
  }

  /**
   * Perform DFS to detect cycles in dependency graph
   */
  private detectCycles(
    serviceName: string,
    graph: Map<string, DependencyNode>,
    visited: Set<string>,
    recursionStack: Set<string>,
    currentPath: string[],
    cycles: CircularDependency[],
  ): void {
    visited.add(serviceName);
    recursionStack.add(serviceName);
    currentPath.push(serviceName);

    const node = graph.get(serviceName);
    if (!node) {
      recursionStack.delete(serviceName);
      currentPath.pop();
      return;
    }

    for (const dependency of node.dependencies) {
      // Skip primitive dependencies and external libraries
      if (!graph.has(dependency)) {
        continue;
      }

      if (!visited.has(dependency)) {
        this.detectCycles(dependency, graph, visited, recursionStack, currentPath, cycles);
      } else if (recursionStack.has(dependency)) {
        // Found a cycle
        const cycleStartIndex = currentPath.indexOf(dependency);
        const cycle = currentPath.slice(cycleStartIndex);

        cycles.push({
          cycle: [...cycle],
          services: [...currentPath],
        });
      }
    }

    recursionStack.delete(serviceName);
    currentPath.pop();
  }

  /**
   * Debug method to visualize the dependency graph
   */
  public analyzeDependencies(): void {
    const serviceClasses = Array.from(this.serviceRegistry.values());
    const result = this.detectCircularDependencies(serviceClasses);

    this.logger.info('Dependency Analysis Report:');
    this.logger.info(`Total Services: ${result.dependencyGraph.size}`);

    if (result.hasCircularDependencies) {
      this.logger.error(`Circular Dependencies Found: ${result.cycles.length}`);
      result.cycles.forEach((cycle, index) => {
        this.logger.error(`  Cycle ${index + 1}: ${cycle.cycle.join(' → ')} → ${cycle.cycle[0]}`);
      });
    } else {
      this.logger.success('No circular dependencies detected');
    }

    // Print dependency tree
    this.logger.info('Service Dependency Tree:');
    for (const [serviceName, node] of result.dependencyGraph) {
      if (node.dependencies.length > 0) {
        this.logger.info(`  ${serviceName} depends on:`);
        node.dependencies.forEach((dep) => {
          this.logger.info(`    - ${dep}`);
        });
      } else {
        this.logger.info(`  ${serviceName} (no dependencies)`);
      }
    }
  }

  /**
   * Initialize stores from provided definitions
   */
  private async discoverAndInitializeStores(): Promise<void> {
    try {
      if (this.storeDefinitions.length === 0) {
        this.logger.debug('No store definitions provided');
        return;
      }

      this.logger.info(`Initializing ${this.storeDefinitions.length} store(s)...`);

      let isFirstStore = true;

      for (const store of this.storeDefinitions) {
        // Bind store instance to DI container for injection
        const diKey = `CentralStore:${store.def.name}`;
        const storeInstance = store.store;
        const classes = store.classes;
        container.bind(diKey).toConstantValue(storeInstance);

        if (isFirstStore) {
          container.bind(Symbol.for('Store')).toConstantValue(storeInstance);
          isFirstStore = false;
        }

        await this.registerMessageClass(
          classes.GetStoreStateMessage,
          `store:${store.def.name}:getState`,
        );
        await this.registerMessageClass(
          classes.SetStoreStateMessage,
          `store:${store.def.name}:setState`,
        );

        // Register reset handler if available
        if (classes.ResetStoreMessage) {
          await this.registerMessageClass(
            classes.ResetStoreMessage,
            `store:${store.def.name}:reset`,
          );
        }

        this.logger.debug(`Initialized store: ${store.def.name}`);
      }

      this.logger.success(`Initialized ${this.storeDefinitions.length} store(s)`);
    } catch (error) {
      this.logger.error('Failed to initialize stores:', error as any);
    }
  }

  /**
   * Register message handlers
   */
  private async registerMessages(): Promise<void> {
    this.logger.info('Registering messages...');

    const messageModules = import.meta.glob<{ default?: Newable<any> }>(
      '/src/app/messages/**/*.message.{ts,js}',
      { eager: true },
    );

    // Collect all message classes
    const messageClasses: Newable<any>[] = [];
    for (const module of Object.values(messageModules)) {
      const MessageClass = module?.default;
      if (MessageClass) messageClasses.push(MessageClass);
    }

    // Detect circular dependencies in messages
    if (messageClasses.length > 0) {
      const circularDepsResult = this.detectCircularDependencies(messageClasses);
      if (circularDepsResult.hasCircularDependencies) {
        this.logger.error('Circular dependencies detected in messages!');
        circularDepsResult.cycles.forEach((cycle, index) => {
          this.logger.error(
            `Message Cycle ${index + 1}: ${cycle.cycle.join(' → ')} → ${cycle.cycle[0]}`,
          );
        });
        throw new Error(`Circular dependencies found in messages. Cannot register messages.`);
      }
    }

    for (const module of Object.values(messageModules)) {
      const MessageClass = module?.default;
      if (!MessageClass) continue;

      try {
        // check all service registry is available
        for (const [name, ServiceClass] of this.serviceRegistry) {
          if (!ServiceClass) {
            this.logger.warn(`Service not found in registry: ${name}`);
          }

          // check if in container
          if (!container.isBound(ServiceClass)) {
            this.logger.warn(`Service not bound in container: ${name}`);
          }
        }

        const messageMetadata = Reflect.getMetadata('name', MessageClass);
        const messageName = messageMetadata || MessageClass.name;
        container.bind(messageName).to(MessageClass).inSingletonScope();

        this.logger.success(`Registered message: ${messageName}`);
      } catch (error) {
        this.logger.error(`Failed to register message ${MessageClass.name}:`, error as any);
      }
    }
  }

  private async registerMessageClass(MessageClass: Newable<any>, name: string): Promise<void> {
    container.bind(name).to(MessageClass).inSingletonScope();
    this.logger.success(`Registered message: ${name}`);
  }

  /**
   * Boot all registered messages
   */
  private async bootMessages(): Promise<void> {
    this.logger.info('Booting messages...');

    const messageModules = import.meta.glob<{ default?: Newable<any> }>(
      '/src/app/messages/**/*.message.{ts,js}',
      { eager: true },
    );

    const bootPromises = Object.values(messageModules).map(async (module) => {
      const MessageClass = module?.default;

      if (!MessageClass || typeof MessageClass.prototype.boot !== 'function') {
        return { skipped: true };
      }

      try {
        const messageMetadata = Reflect.getMetadata('name', MessageClass);
        const messageName = messageMetadata || MessageClass.name;
        const messageInstance = container.get<any>(messageName);

        await messageInstance.boot();
        this.logger.success(`Booted message: ${messageName}`);
        return { messageName, success: true };
      } catch (error) {
        this.logger.error(`Failed to boot message ${MessageClass.name}:`, error as any);
        return { messageName: MessageClass.name, success: false, error };
      }
    });

    await Promise.all(bootPromises);
  }

  /**
   * Register jobs for scheduled execution
   */
  private async registerJobs(): Promise<void> {
    this.logger.info('Registering jobs...');

    const jobModules = import.meta.glob<{ default?: Newable<any> }>(
      '/src/app/jobs/**/*.job.{ts,js}',
      { eager: true },
    );

    // Register Scheduler with container and get instance from DI
    if (!container.isBound(Scheduler)) {
      container
        .bind(Scheduler)
        .toDynamicValue(() => new Scheduler(this.logger))
        .inSingletonScope();
    }

    this.logger.debug('container isBound(Scheduler)', { isBound: container.isBound(Scheduler) });

    // check all service registry is available
    for (const [name, ServiceClass] of this.serviceRegistry) {
      if (!ServiceClass) {
        this.logger.warn(`Service not found in registry: ${name}`);
      }

      // check if in container
      if (!container.isBound(ServiceClass)) {
        this.logger.warn(`Service not bound in container: ${name}`);
      } else {
        container.get(ServiceClass);
      }
    }

    this.scheduler = container.get(Scheduler);

    // First pass: bind all job classes to the container
    const jobEntries: Array<{
      JobClass: Newable<any>;
      jobName: string;
      id: string;
      options: any;
    }> = [];

    for (const module of Object.values(jobModules)) {
      const JobClass = module?.default;
      if (!JobClass) continue;

      try {
        const jobMetadata = Reflect.getMetadata('name', JobClass);
        const jobName = jobMetadata || JobClass.name;

        // Bind the job class first (before instantiation)
        if (!container.isBound(JobClass)) {
          container.bind(JobClass).toSelf().inSingletonScope();
        }

        const id = `${jobName.toLowerCase()}:${JobClass.name.toLowerCase()}`;
        container.bind(id).to(JobClass).inSingletonScope();

        const options = Reflect.getMetadata('job:options', JobClass) || {};

        jobEntries.push({ JobClass, jobName, id, options });
        this.jobRegistry.set(jobName, JobClass);
        this.logger.debug(`Bound job: ${jobName}`);
      } catch (error) {
        this.logger.error(`Failed to bind job ${JobClass.name}:`, error as any);
      }
    }

    // Second pass: instantiate and register all jobs (now all dependencies are bound)
    for (const { JobClass, jobName, id, options } of jobEntries) {
      try {
        const instance = container.get<IJob<unknown>>(JobClass);

        JobRegistry.instance.register(id, instance, options);

        // Execute onBoot method if present (similar to services)
        if (typeof instance.onBoot === 'function') {
          this.logger.info(`Executing onBoot for job: ${jobName}`);
          try {
            // Check if job should run based on popup visibility
            if (options.requiresPopup) {
              const isPopupVisible = PopupVisibilityService.instance.isPopupVisible();
              if (!isPopupVisible) {
                this.logger.debug(`Skipping onBoot for job ${jobName} - popup not visible`);
              } else {
                await instance.onBoot();
                this.logger.debug(`Executed onBoot for job: ${jobName}`);
              }
            } else {
              await instance.onBoot();
              this.logger.debug(`Executed onBoot for job: ${jobName}`);
            }
          } catch (error) {
            this.logger.error(`Failed to execute onBoot for job ${jobName}:`, error as any);
            // Don't throw - onBoot failures shouldn't prevent app startup
          }
        }

        // Only schedule if not starting paused
        if (!options.startPaused) {
          this.scheduler.schedule(id, options);
        } else {
          this.logger.info(`Job ${jobName} registered but paused (startPaused: true)`);
        }

        this.logger.success(`Registered job: ${jobName}`);
      } catch (error) {
        this.logger.error(`Failed to register job ${JobClass.name}:`, error as any);
      }
    }
  }
}

class BootstrapLogger implements Logger {
  private enableLogs: boolean;

  constructor(enableLogs: boolean = true) {
    this.enableLogs = enableLogs;
  }

  info(message: string, context?: Record<string, any>): void {
    if (!this.enableLogs) return;
    console.log(message);
    if (context) console.log('  ', context);
  }

  success(message: string): void {
    if (!this.enableLogs) return;
    console.log(message);
  }

  warn(message: string): void {
    if (!this.enableLogs) return;
    console.warn(message);
  }

  error(message: string, error?: Error): void {
    if (!this.enableLogs) return;
    console.error(message);
    if (error) console.error('  ', error);
  }

  debug(message: string, context?: Record<string, any>): void {
    if (!this.enableLogs) return;
    console.debug(message);
    if (context) console.debug('  ', context);
  }

  divider(): void {
    if (!this.enableLogs) return;
    console.log('='.repeat(50));
  }
}

// Laravel-style facade for clean API
export async function create({
  keepPortAlive = true,
  portName,
  enableLogs = true,
  disableBootMethods = false,
}: {
  keepPortAlive?: boolean;
  portName?: string;
  enableLogs?: boolean;
  disableBootMethods?: boolean;
} = {}): Promise<void> {
  const bootstrap = new ApplicationBootstrap();
  await bootstrap.create({
    keepPortAlive,
    portName,
    enableLogs,
    disableBootMethods,
  });
}

// Fluent API for store configuration
export function bootstrap(): BootstrapBuilder {
  return new BootstrapBuilder();
}

class BootstrapBuilder {
  private readonly app = new ApplicationBootstrap();

  /**
   * Add a store definition to be initialized
   */
  public withStore(storeDefinition: any): BootstrapBuilder {
    this.app.withStore(storeDefinition);
    return this;
  }

  /**
   * Add multiple store definitions to be initialized
   */
  public withStores(storeDefinitions: any[]): BootstrapBuilder {
    this.app.withStores(storeDefinitions);
    return this;
  }

  /**
   * Create and start the application
   */
  public async create({
    keepPortAlive = true,
    portName,
    enableLogs = true,
    disableBootMethods = false,
  }: {
    keepPortAlive?: boolean;
    portName?: string;
    enableLogs?: boolean;
    disableBootMethods?: boolean;
  } = {}): Promise<void> {
    await this.app.create({ keepPortAlive, portName, enableLogs, disableBootMethods });
  }
}
