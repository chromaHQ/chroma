import { decorate, inject, injectable, Newable } from 'inversify';
import { container } from './di/Container';
import { bootstrap as bridgeBootstrap } from './runtime/BridgeRuntime';
import { JobRegistry, Scheduler } from './scheduler';
import { IJob } from './scheduler/core/IJob';

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

/**
 * Application Bootstrap Manager
 * Handles automatic service discovery, dependency resolution, and application initialization
 */
class ApplicationBootstrap {
  private readonly serviceDependencies = new Map<string, ServiceMetadata>();
  private readonly serviceRegistry = new Map<string, Newable<any>>();
  private readonly logger = new BootstrapLogger();
  private readonly storeDefinitions: any[] = [];

  private scheduler: Scheduler | undefined;

  /**
   * Add a store definition to be initialized
   */
  public withStore(storeDefinition: any): ApplicationBootstrap {
    if (storeDefinition && storeDefinition.name) {
      this.storeDefinitions.push(storeDefinition);
      this.logger.debug(`📦 Added store definition: ${storeDefinition.name}`);
    }
    return this;
  }

  /**
   * Add multiple store definitions to be initialized
   */
  public withStores(storeDefinitions: any[]): ApplicationBootstrap {
    for (const store of storeDefinitions) {
      this.withStore(store);
    }
    return this;
  }

  /**
   * Create and initialize a new Chroma application instance
   */
  public async create(): Promise<void> {
    try {
      this.logger.info('🚀 Starting Chroma application bootstrap...');

      await this.discoverServices();
      await this.discoverAndInitializeStores();
      await this.validateDependencies();
      await this.registerServices();
      await this.registerMessages();
      await this.registerJobs();
      await this.bootMessages();

      this.logger.success('🎉 Chroma application initialization complete!');
      bridgeBootstrap({ container });
    } catch (error) {
      this.logger.error('💥 Application bootstrap failed:', error as any);
      throw error;
    }
  }

  /**
   * Discover all services in the application directory
   */
  private async discoverServices(): Promise<void> {
    this.logger.info('🔍 Discovering services...');

    const serviceModules = import.meta.glob<{ default?: Newable<any> }>(
      '/src/app/services/**/*.service.{ts,js}',
      { eager: true },
    );

    // First pass: register service classes
    for (const module of Object.values(serviceModules)) {
      const ServiceClass = module?.default;
      if (!ServiceClass) continue;

      this.serviceRegistry.set(ServiceClass.name, ServiceClass);
    }

    // Second pass: analyze dependencies
    for (const module of Object.values(serviceModules)) {
      const ServiceClass = module?.default;
      if (!ServiceClass) continue;

      const dependencies = this.resolveDependencies(ServiceClass);

      this.serviceDependencies.set(ServiceClass.name, {
        service: ServiceClass,
        dependencies,
        registered: false,
      });

      this.logger.debug(`📦 Discovered ${ServiceClass.name}`, {
        dependencies: dependencies.map((dep) => dep.name),
      });
    }

    this.logger.success(`✅ Discovered ${this.serviceDependencies.size} services`);
  }

  /**
   * Initialize stores from provided definitions
   */
  private async discoverAndInitializeStores(): Promise<void> {
    try {
      if (this.storeDefinitions.length === 0) {
        this.logger.debug('📭 No store definitions provided');
        return;
      }

      this.logger.info(`Initializing ${this.storeDefinitions.length} store(s)...`);

      // Check if @chromahq/store is available in global registry
      const chromaGlobal = (globalThis as any).__CHROMA__;

      if (chromaGlobal?.initStores && typeof chromaGlobal.initStores === 'function') {
        for (const store of this.storeDefinitions) {
          const { classes } = await chromaGlobal.initStores(store);

          this.registerMessageClass(classes.GetStoreStateMessage, `store:${store.name}:getState`);
          this.registerMessageClass(classes.SetStoreStateMessage, `store:${store.name}:setState`);
          this.registerMessageClass(
            classes.SubscribeToStoreMessage,
            `store:${store.name}:subscribe`,
          );

          this.logger.debug(`✅ Initialized store: ${store.name}`);
        }
      }

      this.logger.success(`✅ Initialized ${this.storeDefinitions.length} store(s)`);
    } catch (error) {
      this.logger.error('❌ Failed to initialize stores:', error as any);
    }
  }

  /**
   * Resolve service dependencies using reflection and fallback parsing
   */
  private resolveDependencies(ServiceClass: Newable<any>): Newable<any>[] {
    // Try reflection metadata first
    const paramTypes = Reflect.getMetadata('design:paramtypes', ServiceClass) || [];

    if (paramTypes.length > 0) {
      return paramTypes.filter((type: any) => type && type !== Object);
    }

    // Fallback to constructor string parsing
    if (ServiceClass.length > 0) {
      return this.parseConstructorDependencies(ServiceClass);
    }

    return [];
  }

  /**
   * Parse constructor dependencies from class string representation
   */
  private parseConstructorDependencies(ServiceClass: Newable<any>): Newable<any>[] {
    const constructorString = ServiceClass.toString();
    const constructorMatch = constructorString.match(/constructor\s*\(([^)]*)\)/);

    if (!constructorMatch) return [];

    const parameters = constructorMatch[1]
      .split(',')
      .map((param) => param.trim().toLowerCase())
      .filter((param) => param.length > 0);

    const dependencies: Newable<any>[] = [];

    for (const param of parameters) {
      const matchingService = Array.from(this.serviceRegistry.entries()).find(
        ([name]) => name.toLowerCase() === param,
      );

      if (matchingService) {
        dependencies.push(matchingService[1]);
      } else {
        this.logger.warn(`⚠️  No service found for parameter "${param}" in ${ServiceClass.name}`);
      }
    }

    return dependencies;
  }

  /**
   * Validate service dependencies and detect circular references
   */
  private async validateDependencies(): Promise<void> {
    this.logger.info('🔍 Validating dependencies...');

    const circularDependencies = this.detectCircularDependencies();

    if (circularDependencies.length > 0) {
      this.handleCircularDependencies(circularDependencies);
    } else {
      this.logger.success('✅ No circular dependencies detected');
    }
  }

  /**
   * Detect circular dependencies using depth-first search
   */
  private detectCircularDependencies(): CircularDependency[] {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const circularDeps: CircularDependency[] = [];

    const dfs = (serviceName: string, path: string[]): void => {
      if (recursionStack.has(serviceName)) {
        const cycleStart = path.indexOf(serviceName);
        const cycle = path.slice(cycleStart).concat([serviceName]);

        circularDeps.push({
          cycle: Object.freeze(cycle),
          services: Object.freeze(Array.from(new Set(cycle))),
        });
        return;
      }

      if (visited.has(serviceName)) return;

      visited.add(serviceName);
      recursionStack.add(serviceName);

      const serviceMetadata = this.serviceDependencies.get(serviceName);
      if (serviceMetadata) {
        for (const dependency of serviceMetadata.dependencies) {
          if (this.serviceDependencies.has(dependency.name)) {
            dfs(dependency.name, [...path, serviceName]);
          }
        }
      }

      recursionStack.delete(serviceName);
    };

    for (const serviceName of this.serviceDependencies.keys()) {
      if (!visited.has(serviceName)) {
        dfs(serviceName, []);
      }
    }

    return circularDeps;
  }

  /**
   * Handle circular dependencies with detailed reporting
   */
  private handleCircularDependencies(circularDeps: CircularDependency[]): void {
    this.logger.error('🔴 CIRCULAR DEPENDENCIES DETECTED');
    this.logger.divider();

    circularDeps.forEach((circular, index) => {
      this.logger.error(`📍 Circular Dependency #${index + 1}:`);
      this.logger.error(`   Cycle: ${circular.cycle.join(' → ')}`);
      this.logger.error(`   Affected Services: ${circular.services.join(', ')}`);

      this.logger.info('   💡 Resolution Suggestions:');
      this.logger.info('      • Extract shared functionality into a separate service');
      this.logger.info('      • Use interfaces or abstractions to break the cycle');
      this.logger.info('      • Consider Factory or Provider patterns');
      this.logger.info('      • Move shared logic to utility classes');
    });

    this.logger.divider();
    this.logger.warn('⚠️  Application will continue but some services may fail to resolve');
    this.logger.warn('   Please address these circular dependencies for optimal functionality');
  }

  /**
   * Register all services with the dependency injection container
   */
  private async registerServices(): Promise<void> {
    this.logger.info('🔧 Registering services...');

    for (const serviceName of this.serviceDependencies.keys()) {
      await this.registerService(serviceName);
    }

    const results = this.getRegistrationResults();
    this.reportRegistrationResults(results);
  }

  /**
   * Register a single service with dependency resolution
   */
  private async registerService(
    serviceName: string,
    visitedServices = new Set<string>(),
    registrationPath: string[] = [],
  ): Promise<RegistrationResult> {
    const serviceMetadata = this.serviceDependencies.get(serviceName);

    if (!serviceMetadata) {
      return { success: false, message: `Service ${serviceName} not found` };
    }

    if (serviceMetadata.registered) {
      return { success: true, message: `Service ${serviceName} already registered` };
    }

    if (visitedServices.has(serviceName)) {
      const cycle = [...registrationPath, serviceName];
      this.logger.warn(`🔄 Circular dependency in registration: ${cycle.join(' → ')}`);
      return { success: false, message: 'Circular dependency detected' };
    }

    const newVisited = new Set(visitedServices).add(serviceName);
    const newPath = [...registrationPath, serviceName];

    // Register dependencies first
    for (const dependency of serviceMetadata.dependencies) {
      if (this.serviceDependencies.has(dependency.name)) {
        await this.registerService(dependency.name, newVisited, newPath);
      }
    }

    try {
      const ServiceClass = serviceMetadata.service;

      // Apply decorators
      decorate(injectable(), ServiceClass);
      serviceMetadata.dependencies.forEach((dependency, index) => {
        decorate(inject(dependency), ServiceClass, index);
      });

      // Bind to container
      container.bind(ServiceClass).toSelf().inSingletonScope();
      serviceMetadata.registered = true;

      this.logger.success(`✅ Registered service: ${ServiceClass.name}`);
      return { success: true, message: `Successfully registered ${ServiceClass.name}` };
    } catch (error) {
      const errorMessage = `Failed to register ${serviceName}`;
      this.logger.error(`❌ ${errorMessage}:`, error as any);
      return { success: false, message: errorMessage, error: error as Error };
    }
  }

  /**
   * Get registration results summary
   */
  private getRegistrationResults(): { successful: string[]; failed: string[] } {
    const successful: string[] = [];
    const failed: string[] = [];

    for (const [name, metadata] of this.serviceDependencies.entries()) {
      if (metadata.registered) {
        successful.push(name);
      } else {
        failed.push(name);
      }
    }

    return { successful, failed };
  }

  /**
   * Report service registration results
   */
  private reportRegistrationResults({
    successful,
    failed,
  }: {
    successful: string[];
    failed: string[];
  }): void {
    if (failed.length > 0) {
      this.logger.error('⚠️  Some services could not be registered:');
      failed.forEach((serviceName) => {
        const metadata = this.serviceDependencies.get(serviceName);
        const deps = metadata?.dependencies.map((d) => d.name).join(', ') || 'none';
        this.logger.error(`   • ${serviceName} (dependencies: ${deps})`);
      });
    } else {
      this.logger.success(`✅ All ${successful.length} services registered successfully`);
    }
  }

  /**
   * Register message handlers
   */
  private async registerMessages(): Promise<void> {
    this.logger.info('📨 Registering messages...');

    const messageModules = import.meta.glob<{ default?: Newable<any> }>(
      '/src/app/messages/**/*.message.{ts,js}',
      { eager: true },
    );

    for (const module of Object.values(messageModules)) {
      const MessageClass = module?.default;
      if (!MessageClass) continue;

      try {
        const dependencies = this.resolveDependencies(MessageClass);

        // Apply decorators
        decorate(injectable(), MessageClass);

        dependencies.forEach((dependency, index) => {
          decorate(inject(dependency), MessageClass, index);
        });

        // Register with container
        const messageMetadata = Reflect.getMetadata('name', MessageClass);
        const messageName = messageMetadata || MessageClass.name;
        container.bind(messageName).to(MessageClass).inSingletonScope();

        this.logger.success(`✅ Registered message: ${messageName}`);
      } catch (error) {
        this.logger.error(`❌ Failed to register message ${MessageClass.name}:`, error as any);
      }
    }
  }

  private async registerMessageClass(MessageClass: Newable<any>, name: string): Promise<void> {
    const dependencies = this.resolveDependencies(MessageClass);

    // Apply decorators
    decorate(injectable(), MessageClass);

    dependencies.forEach((dependency, index) => {
      decorate(inject(dependency), MessageClass, index);
    });

    container.bind(name).to(MessageClass).inSingletonScope();
    this.logger.success(`✅ Registered message: ${name}`);
  }

  /**
   * Boot all registered messages
   */
  private async bootMessages(): Promise<void> {
    this.logger.info('🚀 Booting messages...');

    const messageModules = import.meta.glob<{ default?: Newable<any> }>(
      '/src/app/messages/**/*.message.{ts,js}',
      { eager: true },
    );

    for (const module of Object.values(messageModules)) {
      const MessageClass = module?.default;

      if (!MessageClass || typeof MessageClass.prototype.boot !== 'function') continue;

      try {
        const messageMetadata = Reflect.getMetadata('name', MessageClass);
        const messageName = messageMetadata || MessageClass.name;
        const messageInstance = container.get<any>(messageName);

        await messageInstance.boot();
        this.logger.success(`✅ Booted message: ${messageName}`);
      } catch (error) {
        this.logger.error(`❌ Failed to boot message ${MessageClass.name}:`, error as any);
      }
    }
  }

  /**
   * Register jobs for scheduled execution
   */
  private async registerJobs(): Promise<void> {
    this.logger.info('🕒 Registering jobs...');

    const jobModules = import.meta.glob<{ default?: Newable<any> }>('/src/app/jobs/*.job.{ts,js}', {
      eager: true,
    });

    for (const module of Object.values(jobModules)) {
      const JobClass = module?.default;
      if (!JobClass) continue;

      try {
        const dependencies = this.resolveDependencies(JobClass);

        // Apply decorators
        decorate(injectable(), JobClass);

        dependencies.forEach((dependency, index) => {
          decorate(inject(dependency), JobClass, index);
        });

        // Register with container
        const jobMetadata = Reflect.getMetadata('name', JobClass);
        const jobName = jobMetadata || JobClass.name;
        container.bind(JobClass).toSelf().inSingletonScope();

        // add to registry
        const id = '12';
        const options = Reflect.getMetadata('job:options', JobClass) || {};

        const instance = container.get<typeof JobClass>(JobClass);

        this.scheduler = new Scheduler();
        JobRegistry.instance.register(id, instance as unknown as IJob<unknown>, options);
        this.scheduler.schedule(id, options);

        this.logger.success(`✅ Registered job: ${jobName}`);
      } catch (error) {
        this.logger.error(`❌ Failed to register job ${JobClass.name}:`, error as any);
      }
    }
  }
}

class BootstrapLogger {
  info(message: string, context?: Record<string, any>): void {
    console.log(message);
    if (context) console.log('  ', context);
  }

  success(message: string): void {
    console.log(message);
  }

  warn(message: string): void {
    console.warn(message);
  }

  error(message: string, error?: Error): void {
    console.error(message);
    if (error) console.error('  ', error);
  }

  debug(message: string, context?: Record<string, any>): void {
    console.debug(message);
    if (context) console.debug('  ', context);
  }

  divider(): void {
    console.log('='.repeat(50));
  }
}

// Laravel-style facade for clean API
export async function create(): Promise<void> {
  const bootstrap = new ApplicationBootstrap();
  await bootstrap.create();
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
  public async create(): Promise<void> {
    await this.app.create();
  }
}
