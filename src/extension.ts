import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

type Session = {
  id: string;
  name: string;
  workspacePath?: string;
  terminalName: string;
  updatedAt: number;
};

type RepoTarget = {
  fullPath: string;
  relativePath: string;
};

class SessionStore {
  private static readonly SessionsKey = "otf.sessions";
  private static readonly ActiveSessionKey = "otf.activeSessionId";

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public getSessions(): Session[] {
    return this.context.workspaceState.get<Session[]>(SessionStore.SessionsKey, []);
  }

  public saveSessions(sessions: Session[]): void {
    this.context.workspaceState.update(SessionStore.SessionsKey, sessions);
  }

  public getActiveSessionId(): string | undefined {
    return this.context.workspaceState.get<string>(SessionStore.ActiveSessionKey);
  }

  public setActiveSessionId(sessionId?: string): void {
    this.context.workspaceState.update(SessionStore.ActiveSessionKey, sessionId);
  }
}

class SessionItem extends vscode.TreeItem {
  public constructor(
    public readonly session: Session,
    public readonly active: boolean,
  ) {
    super(session.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "otfSession";
    this.description = active ? "active" : new Date(session.updatedAt).toLocaleTimeString();
    this.tooltip = new vscode.MarkdownString(
      `**${session.name}**\n\n- id: \`${session.id}\`\n- repo: \`${session.workspacePath ?? "not attached"}\``,
    );
    this.command = {
      command: "otf.switchSession",
      title: "Switch Session",
      arguments: [session.id],
    };
    this.iconPath = new vscode.ThemeIcon(active ? "play-circle" : "circle-large-outline");
  }
}

class SessionTreeProvider implements vscode.TreeDataProvider<SessionItem> {
  private readonly emitter = new vscode.EventEmitter<SessionItem | void>();

  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(private readonly store: SessionStore) {}

  public refresh(): void {
    this.emitter.fire();
  }

  public getTreeItem(element: SessionItem): vscode.TreeItem {
    return element;
  }

  public getChildren(): SessionItem[] {
    const activeSessionId = this.store.getActiveSessionId();
    const sessions = this.store
      .getSessions()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((session) => new SessionItem(session, session.id === activeSessionId));
    return sessions;
  }
}

class RepoNode extends vscode.TreeItem {
  public readonly gitStatus?: string;

  public constructor(
    public readonly fullPath: string,
    public readonly relativePath: string,
    public readonly isDirectory: boolean,
    gitStatus?: string,
    clickableFile = true,
  ) {
    super(
      path.basename(relativePath) || path.basename(fullPath),
      isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );

    this.gitStatus = gitStatus;
    this.description = gitStatus ?? (relativePath === "." ? fullPath : undefined);
    this.resourceUri = vscode.Uri.file(fullPath);
    this.contextValue = isDirectory ? "otfRepoDir" : "otfRepoFile";
    this.iconPath = new vscode.ThemeIcon(isDirectory ? "folder" : "file");
    if (!isDirectory && clickableFile) {
      this.command = {
        command: "otf.openRepoFile",
        title: "Open File",
        arguments: [{ fullPath, relativePath }],
      };
    }
  }
}

class RepoTreeProvider implements vscode.TreeDataProvider<RepoNode> {
  private readonly emitter = new vscode.EventEmitter<RepoNode | void>();
  private readonly gitStatusCache = new Map<string, { at: number; statuses: Map<string, string> }>();

  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(private readonly store: SessionStore) {}

  public refresh(): void {
    this.emitter.fire();
  }

  public getTreeItem(element: RepoNode): vscode.TreeItem {
    return element;
  }

  public async getActiveSessionGitStatus(): Promise<Map<string, string>> {
    const activeSessionId = this.store.getActiveSessionId();
    const activeSession = this.store.getSessions().find((session) => session.id === activeSessionId);
    if (!activeSession?.workspacePath) {
      return new Map<string, string>();
    }
    return this.getGitStatuses(activeSession.workspacePath);
  }

  public async getChildren(element?: RepoNode): Promise<RepoNode[]> {
    const activeSessionId = this.store.getActiveSessionId();
    const activeSession = this.store.getSessions().find((session) => session.id === activeSessionId);

    if (!activeSession?.workspacePath) {
      return [
        new RepoNode(
          "/",
          "Attach a repo path to the active session via command palette.",
          false,
          undefined,
          false,
        ),
      ];
    }

    const basePath = activeSession.workspacePath;
    const parentPath = element ? element.fullPath : basePath;
    const parentRelative = element ? element.relativePath : ".";
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(parentPath));
    } catch {
      return [];
    }

    const gitStatuses = await this.getGitStatuses(basePath);
    const nodes = entries
      .filter(([name]) => !name.startsWith(".git"))
      .map(([name, type]) => {
        const fullPath = path.join(parentPath, name);
        const rel = parentRelative === "." ? name : path.join(parentRelative, name);
        const isDirectory = (type & vscode.FileType.Directory) !== 0;
        const gitRel = rel.split(path.sep).join("/");
        const gitStatus = gitStatuses.get(gitRel);
        return new RepoNode(fullPath, rel, isDirectory, gitStatus);
      })
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        return a.label!.toString().localeCompare(b.label!.toString());
      });

    return nodes;
  }

  private async getGitStatuses(basePath: string): Promise<Map<string, string>> {
    const cached = this.gitStatusCache.get(basePath);
    if (cached && Date.now() - cached.at < 1500) {
      return cached.statuses;
    }

    const statuses = new Map<string, string>();
    try {
      const { stdout } = await execFileAsync("git", ["-C", basePath, "status", "--porcelain"]);
      const lines = stdout.split("\n").map((line) => line.trimEnd()).filter(Boolean);
      for (const line of lines) {
        if (line.length < 4) {
          continue;
        }
        const xy = line.slice(0, 2);
        const pathPart = line.slice(3).trim();
        const filePath = pathPart.includes(" -> ") ? pathPart.split(" -> ").pop() : pathPart;
        if (!filePath) {
          continue;
        }
        const gitStatus = xy === "??" ? "U" : xy.replaceAll(" ", "");
        statuses.set(path.normalize(filePath).split(path.sep).join("/"), gitStatus || "M");
      }
    } catch {
      this.gitStatusCache.set(basePath, { at: Date.now(), statuses });
      return statuses;
    }

    this.gitStatusCache.set(basePath, { at: Date.now(), statuses });
    return statuses;
  }
}

class SessionPanel {
  private panel: vscode.WebviewPanel | undefined;

  public show(session: Session | undefined): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "otfSessionPanel",
        "Thread Context",
        vscode.ViewColumn.One,
        { enableFindWidget: true },
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    } else {
      this.panel.reveal(vscode.ViewColumn.One);
    }

    this.panel.title = session ? `Thread: ${session.name}` : "Thread Context";
    this.panel.webview.html = this.render(session);
  }

  private render(session: Session | undefined): string {
    const title = session ? session.name : "No session selected";
    const terminalName = session?.terminalName ?? "n/a";
    const repo = session?.workspacePath ?? "No repo attached";
    const updated = session ? new Date(session.updatedAt).toLocaleString() : "-";
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; padding: 16px; color: #dbe2ea; background: #0f1720; }
h1 { font-size: 20px; margin: 0 0 12px; color: #9ad1ff; }
.row { margin: 8px 0; }
.label { color: #8a99a8; }
.value { color: #f2f6fb; }
.hint { margin-top: 16px; color: #9fb0bf; }
</style>
</head>
<body>
  <h1>${title}</h1>
  <div class="row"><span class="label">Terminal:</span> <span class="value">${terminalName}</span></div>
  <div class="row"><span class="label">Repo:</span> <span class="value">${repo}</span></div>
  <div class="row"><span class="label">Updated:</span> <span class="value">${updated}</span></div>
  <div class="hint">This panel is intentionally lightweight: switch threads in the Sessions view, run the agent in terminal.</div>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const store = new SessionStore(context);
  const sessionsProvider = new SessionTreeProvider(store);
  const repoProvider = new RepoTreeProvider(store);
  const panel = new SessionPanel();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("otf.sessions", sessionsProvider),
    vscode.window.registerTreeDataProvider("otf.repo", repoProvider),
  );

  const refreshAll = (): void => {
    sessionsProvider.refresh();
    repoProvider.refresh();
    const activeId = store.getActiveSessionId();
    const activeSession = store.getSessions().find((s) => s.id === activeId);
    panel.show(activeSession);
  };

  const toCdCommand = (cwd: string): string => {
    if (process.platform === "win32") {
      const escaped = cwd.replace(/"/g, '\\"');
      return `cd /d "${escaped}"`;
    }
    const escaped = cwd.replace(/'/g, `'\\''`);
    return `cd '${escaped}'`;
  };

  const ensureSessionTerminal = (session: Session): vscode.Terminal => {
    let terminal = vscode.window.terminals.find((t) => t.name === session.terminalName);
    if (!terminal) {
      terminal = vscode.window.createTerminal({
        name: session.terminalName,
        cwd: session.workspacePath,
      });
    }
    return terminal;
  };

  const resolveRepoTarget = (arg?: unknown, maybeRelativePath?: string): RepoTarget | undefined => {
    if (typeof arg === "string") {
      if (!maybeRelativePath) {
        return undefined;
      }
      return { fullPath: arg, relativePath: maybeRelativePath };
    }

    if (!arg || typeof arg !== "object") {
      return undefined;
    }

    const candidate = arg as Partial<RepoTarget>;
    if (typeof candidate.fullPath === "string" && typeof candidate.relativePath === "string") {
      return { fullPath: candidate.fullPath, relativePath: candidate.relativePath };
    }

    return undefined;
  };

  const resolveSessionId = (arg?: unknown): string | undefined => {
    if (typeof arg === "string") {
      return arg;
    }
    if (arg instanceof SessionItem) {
      return arg.session.id;
    }
    return undefined;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("otf.refresh", () => refreshAll()),
    vscode.commands.registerCommand("otf.openSessionPanel", () => {
      const activeId = store.getActiveSessionId();
      const activeSession = store.getSessions().find((s) => s.id === activeId);
      panel.show(activeSession);
    }),
    vscode.commands.registerCommand("otf.addSession", async () => {
      const name = await vscode.window.showInputBox({
        prompt: "Session name",
        placeHolder: "some_project",
        ignoreFocusOut: true,
      });
      if (!name) {
        return;
      }

      const terminalName = await vscode.window.showInputBox({
        prompt: "Terminal name for this session",
        placeHolder: `agent:${name}`,
        value: `agent:${name}`,
        ignoreFocusOut: true,
      });
      if (!terminalName) {
        return;
      }

      const session: Session = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name,
        terminalName,
        updatedAt: Date.now(),
      };

      const sessions = store.getSessions();
      sessions.push(session);
      store.saveSessions(sessions);
      store.setActiveSessionId(session.id);
      refreshAll();
    }),
    vscode.commands.registerCommand("otf.switchSession", async (arg?: string) => {
      let sessionId = resolveSessionId(arg);
      const sessions = store.getSessions();
      if (!sessions.length) {
        vscode.window.showInformationMessage("No sessions yet. Run 'Switchboard: Add Session' first.");
        return;
      }

      if (!sessionId) {
        const pick = await vscode.window.showQuickPick(
          sessions.map((session) => ({
            label: session.name,
            description: session.workspacePath ?? "No repo attached",
            sessionId: session.id,
          })),
          { placeHolder: "Switch active session" },
        );
        if (!pick) {
          return;
        }
        sessionId = pick.sessionId;
      }

      const current = sessions.find((session) => session.id === sessionId);
      if (!current) {
        return;
      }

      current.updatedAt = Date.now();
      store.saveSessions(sessions);
      store.setActiveSessionId(sessionId);
      refreshAll();
      await vscode.commands.executeCommand("otf.focusTerminal");
    }),
    vscode.commands.registerCommand("otf.removeSession", async (arg?: unknown) => {
      const sessions = store.getSessions();
      if (!sessions.length) {
        vscode.window.showInformationMessage("No sessions to remove.");
        return;
      }

      let sessionId = resolveSessionId(arg);
      if (!sessionId) {
        const pick = await vscode.window.showQuickPick(
          sessions.map((session) => ({
            label: session.name,
            description: session.workspacePath ?? "No repo attached",
            sessionId: session.id,
          })),
          { placeHolder: "Select a session to remove" },
        );
        if (!pick) {
          return;
        }
        sessionId = pick.sessionId;
      }

      const target = sessions.find((session) => session.id === sessionId);
      if (!target) {
        return;
      }

      const confirmed = await vscode.window.showWarningMessage(
        `Remove session "${target.name}"?`,
        { modal: true },
        "Remove",
      );
      if (confirmed !== "Remove") {
        return;
      }

      const remaining = sessions.filter((session) => session.id !== target.id);
      store.saveSessions(remaining);

      const activeSessionId = store.getActiveSessionId();
      if (activeSessionId === target.id) {
        store.setActiveSessionId(remaining[0]?.id);
      }

      refreshAll();
    }),
    vscode.commands.registerCommand("otf.attachRepo", async () => {
      const activeId = store.getActiveSessionId();
      if (!activeId) {
        vscode.window.showInformationMessage("Select or create a session first.");
        return;
      }
      const session = store.getSessions().find((item) => item.id === activeId);
      if (!session) {
        return;
      }

      const selected = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Attach Repo",
      });
      if (!selected?.length) {
        return;
      }

      session.workspacePath = selected[0].fsPath;
      session.updatedAt = Date.now();
      store.saveSessions(store.getSessions());
      refreshAll();

      const terminal = ensureSessionTerminal(session);
      terminal.show(true);
      terminal.sendText(toCdCommand(session.workspacePath), true);
    }),
    vscode.commands.registerCommand("otf.focusTerminal", async () => {
      const activeId = store.getActiveSessionId();
      const session = store.getSessions().find((item) => item.id === activeId);
      if (!session) {
        vscode.window.showInformationMessage("No active session to focus.");
        return;
      }

      const terminal = ensureSessionTerminal(session);
      terminal.show(true);
    }),
    vscode.commands.registerCommand("otf.openRepoInWorkspace", async () => {
      const activeId = store.getActiveSessionId();
      const session = store.getSessions().find((item) => item.id === activeId);
      if (!session?.workspacePath) {
        vscode.window.showInformationMessage("Attach a repo to the active session first.");
        return;
      }

      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(session.workspacePath), true);
    }),
    vscode.commands.registerCommand("otf.openRepoFile", async (arg?: unknown, relativePath?: string) => {
      const target = resolveRepoTarget(arg, relativePath);
      if (!target) {
        return;
      }
      const statusMap = await repoProvider.getActiveSessionGitStatus();
      const relative = target.relativePath.split(path.sep).join("/");
      const gitStatus = statusMap.get(relative);
      const fileUri = vscode.Uri.file(target.fullPath);

      if (gitStatus && gitStatus !== "U") {
        try {
          const opened = await vscode.commands.executeCommand<boolean>("git.openChange", fileUri);
          if (opened !== false) {
            return;
          }
        } catch {
          // fall back to regular file open when git extension command is unavailable
        }
      }

      await vscode.commands.executeCommand("vscode.open", fileUri);
    }),
    vscode.commands.registerCommand("otf.openRepoFileToSide", async (arg?: unknown, relativePath?: string) => {
      const target = resolveRepoTarget(arg, relativePath);
      if (!target) {
        return;
      }
      await vscode.commands.executeCommand(
        "vscode.open",
        vscode.Uri.file(target.fullPath),
        vscode.ViewColumn.Beside,
      );
    }),
    vscode.commands.registerCommand("otf.openRepoDiff", async (arg?: unknown, relativePath?: string) => {
      const target = resolveRepoTarget(arg, relativePath);
      if (!target) {
        return;
      }
      try {
        await vscode.commands.executeCommand("git.openChange", vscode.Uri.file(target.fullPath));
      } catch {
        vscode.window.showInformationMessage("Git changes are not available for this file.");
      }
    }),
    vscode.commands.registerCommand("otf.revealRepoItemInFinder", async (arg?: unknown, relativePath?: string) => {
      const target = resolveRepoTarget(arg, relativePath);
      if (!target) {
        return;
      }
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(target.fullPath));
    }),
    vscode.commands.registerCommand("otf.copyRepoRelativePath", async (arg?: unknown, relativePath?: string) => {
      const target = resolveRepoTarget(arg, relativePath);
      if (!target) {
        return;
      }
      await vscode.env.clipboard.writeText(target.relativePath.split(path.sep).join("/"));
      vscode.window.showInformationMessage(`Copied: ${target.relativePath}`);
    }),
  );

  refreshAll();
}

export function deactivate(): void {}
