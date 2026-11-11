import { TransportError } from './transport.js';

interface BrowserWaiter {
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: TransportError) => void;
  abort: () => void;
}

/** A shared, cancellable budget for live browsers in small-memory deployments. */
export class BrowserResources {
  private active = 0;
  private waiting: BrowserWaiter[] = [];
  private stopping = false;

  constructor(private readonly limit = 1) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Browser resource limit must be a positive integer.');
  }

  get activeCount(): number { return this.active; }
  get queuedCount(): number { return this.waiting.length; }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (this.stopping || signal.aborted) return Promise.reject(new TransportError('aborted'));
    if (this.active < this.limit && !this.waiting.length) {
      this.active++;
      return Promise.resolve(this.release());
    }
    return new Promise((resolve, reject) => {
      const waiter: BrowserWaiter = { signal, resolve, reject, abort: () => {
        const index = this.waiting.indexOf(waiter);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        signal.removeEventListener('abort', waiter.abort);
        reject(new TransportError('aborted'));
      } };
      this.waiting.push(waiter);
      signal.addEventListener('abort', waiter.abort, { once: true });
      if (signal.aborted) waiter.abort();
    });
  }

  private release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
    };
  }

  private drain(): void {
    while (!this.stopping && this.active < this.limit && this.waiting.length) {
      const waiter = this.waiting.shift()!;
      waiter.signal.removeEventListener('abort', waiter.abort);
      if (waiter.signal.aborted) { waiter.reject(new TransportError('aborted')); continue; }
      this.active++;
      waiter.resolve(this.release());
    }
  }

  shutdown(): void {
    this.stopping = true;
    for (const waiter of this.waiting.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.abort);
      waiter.reject(new TransportError('aborted'));
    }
  }

  close(): void { this.shutdown(); }
}
