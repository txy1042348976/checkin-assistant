import type { Store } from './store.js';
import type { AppConfig, RunResult } from './types.js';

interface Engine {
  run: (row: NonNullable<ReturnType<Store['account']>>, credentials: ReturnType<Store['credentials']>, hasSnapshot?: boolean) => Promise<RunResult>;
  close: () => Promise<void>;
}

export class Scheduler {
  readonly queued = new Set<number>();
  readonly active = new Set<number>();
  private waiting: { id: number; trigger: string }[] = [];
  private jobs = new Set<Promise<void>>();
  private timer?: NodeJS.Timeout;
  private stopping = false;

  constructor(private store: Store, private engine: Engine, private config: AppConfig,
    private authorizing: (id: number) => boolean = () => false) {}

  isBusy(id: number): boolean { return this.queued.has(id) || this.active.has(id); }

  start(): void {
    this.store.recoverInterrupted();
    this.timer = setInterval(() => this.tick(), this.config.schedulerTickMs); this.timer.unref();
    this.tick();
  }

  tick(): void {
    if (this.stopping) return;
    try {
      if (!this.store.settings().scheduler_enabled) return;
      for (const row of this.store.accounts(true)) {
        if (row.next_run && new Date(row.next_run).getTime() <= Date.now()) this.enqueue(row.id, 'scheduled');
      }
    } catch { /* A later tick may recover; never fabricate a completed run. */ }
  }

  enqueue(id: number, trigger = 'manual'): boolean {
    if (this.stopping || this.isBusy(id) || this.authorizing(id)) return false;
    const row = this.store.account(id);
    if (!row || ['queued', 'running'].includes(row.status) || (trigger === 'scheduled' && !row.enabled)) return false;
    this.store.patch(id, { status: 'queued', last_message: '已加入签到队列' });
    this.queued.add(id); this.waiting.push({ id, trigger });
    setImmediate(() => this.drain());
    return true;
  }

  private drain(): void {
    while (!this.stopping && this.active.size < this.config.maxConcurrentRuns && this.waiting.length) {
      const task = this.waiting.shift()!;
      this.queued.delete(task.id); this.active.add(task.id);
      const job = this.execute(task.id, task.trigger).finally(() => {
        this.jobs.delete(job); this.active.delete(task.id); this.drain();
      });
      this.jobs.add(job);
      void job.catch(() => {});
    }
  }

  private async execute(id: number, trigger: string): Promise<void> {
    const row = this.store.account(id);
    if (!row) return;
    const runId = this.store.beginRun(row, trigger);
    try {
      const result = await this.engine.run(row, this.store.credentials(row), Boolean(row.has_snapshot));
      const session = result._session_update; delete result._session_update;
      this.store.transaction(() => {
        if (session) this.store.patch(id, { encrypted: this.store.encryptCredentials({ ...this.store.credentials(this.store.account(id) || row), ...session }) });
        this.store.finishRun(runId, id, result, trigger);
      });
    } catch {
      this.store.finishRun(runId, id, { status: this.stopping ? 'interrupted' : 'failed',
        message: this.stopping ? '服务停止，任务未完成。' : '任务未完成，请稍后重试。' }, trigger);
    }
  }

  async close(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.engine.close();
    await Promise.allSettled([...this.jobs]);
  }
}
