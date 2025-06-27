export abstract class Booteable {
  /**
   * Boot method to be called when the service is initialized.
   * This method can be used to perform any setup or initialization logic.
   */
  abstract boot(): void;
  /**
   * Optional destroy method to be called when the service is being destroyed.
   * This can be used to clean up resources or perform any necessary teardown logic.
   */
  destroy?(): void {
    // Default implementation does nothing
  }
}

export function isBooteable(obj: any): obj is Booteable {
  return typeof obj.boot === 'function';
}

export function isDestroyable(obj: any): obj is Booteable {
  return typeof obj.destroy === 'function';
}
