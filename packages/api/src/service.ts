/** A typed handle for a service that one plugin provides and others consume. */
export interface ServiceToken<T> {
  readonly id: string;
  /** Phantom field carrying the service type; never set at runtime. */
  readonly __type?: T;
}

export function defineService<T>(id: string): ServiceToken<T> {
  return Object.freeze({ id }) as ServiceToken<T>;
}
