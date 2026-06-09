// src/borg-arc/adapters/claw-code-rag.ts

export interface RAGResult {
  text: string;
  score: number;
  source: string;
}

export interface RAGStats {
  chunks: number;
  phase: string;
}

export class ClawCodeRAGClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async query(question: string, topK: number = 5): Promise<RAGResult[]> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: question, top_k: topK }),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { results?: RAGResult[] };
      return data.results ?? [];
    } catch {
      return [];
    }
  }

  async stats(): Promise<RAGStats> {
    const res = await fetch(`${this.baseUrl}/v1/stats`);
    return (await res.json()) as RAGStats;
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async ingest(workspacePaths: string[]): Promise<void> {
    await fetch(`${this.baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaces: workspacePaths }),
    });
  }
}
