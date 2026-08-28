/**
 * Per-connection state for one stdio MCP session. The stdio server is a single
 * long-lived process per connected client, so it can remember which entries it
 * surfaced during this session. That's what makes "on session-end, re-check the
 * entries you touched" possible: the agent doesn't have to remember what it
 * looked at — the server does, and hands the list back via memory.review.
 */
export class SessionState {
  private touched = new Set<string>();

  /** Records entry ids surfaced to the client (by search/list) as "touched this session". */
  recordTouched(ids: Iterable<string>): void {
    for (const id of ids) this.touched.add(id);
  }

  /** Ids surfaced during this session, insertion order. */
  getTouched(): string[] {
    return [...this.touched];
  }

  clear(): void {
    this.touched.clear();
  }
}

export type ToolContext = {
  cwd: string;
  session: SessionState;
};
