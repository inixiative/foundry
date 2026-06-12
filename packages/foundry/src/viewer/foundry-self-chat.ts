import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SelfChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
  focus?: SelfChatFocus;
  tokens?: { input: number; output: number };
}

export interface SelfChatFocus {
  scope?: "global" | "project";
  projectId?: string;
  tab?: string;
  focusKind?: "source" | "agent" | "layer" | "provider" | null;
  focusId?: string | null;
}

/**
 * Persistent single-thread chat log for the "foundry-self" helper.
 * One long-lived conversation for customizing the Foundry install itself.
 */
export class FoundrySelfChatStore {
  private _file: string;
  private _messages: SelfChatMessage[] = [];
  private _loaded = false;

  constructor(file: string) {
    this._file = file;
  }

  get file(): string { return this._file; }
  get messages(): SelfChatMessage[] { return this._messages; }

  async load(): Promise<void> {
    if (this._loaded) return;
    this._loaded = true;
    try {
      const raw = await readFile(this._file, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) this._messages = parsed;
    } catch {
      this._messages = [];
    }
  }

  async append(msg: SelfChatMessage): Promise<void> {
    await this.load();
    this._messages.push(msg);
    await this._flush();
  }

  async clear(): Promise<void> {
    this._messages = [];
    await this._flush();
  }

  private async _flush(): Promise<void> {
    await mkdir(dirname(this._file), { recursive: true });
    await writeFile(this._file, JSON.stringify(this._messages, null, 2));
  }
}
