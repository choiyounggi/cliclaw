export interface Job {
  chatId: number;
  agent: string;
  abort: AbortController;
  startedAt: Date;
}

export class JobRegistry {
  private jobs = new Map<number, Job>();

  register(chatId: number, agent: string): Job {
    if (this.jobs.has(chatId)) {
      throw new Error(`job already in flight for chatId=${chatId}`);
    }
    const job: Job = {
      chatId,
      agent,
      abort: new AbortController(),
      startedAt: new Date(),
    };
    this.jobs.set(chatId, job);
    return job;
  }

  get(chatId: number): Job | undefined {
    return this.jobs.get(chatId);
  }

  /** Signal cancellation. Caller is responsible for actually killing the process via the AbortController signal listener. */
  cancel(chatId: number): Job | undefined {
    const job = this.jobs.get(chatId);
    if (!job) return undefined;
    job.abort.abort();
    return job;
  }

  /** Remove from registry. Call after subprocess fully exits. */
  clear(chatId: number): void {
    this.jobs.delete(chatId);
  }

  size(): number {
    return this.jobs.size;
  }
}
