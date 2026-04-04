import { Plugin, PluginSettingTab, App, Setting, Notice, addIcon, setIcon, setTooltip, Modal, TFile } from "obsidian";

const CONFLICT_MARKER = ".sync-conflict-";

const SYNC_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 0 1 16 0"/><path d="M20 12a8 8 0 0 1-16 0"/><circle cx="12" cy="12" r="2"/></svg>`;
const SYNC_ICON_OFF = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 0 1 16 0" opacity="0.3"/><path d="M20 12a8 8 0 0 1-16 0" opacity="0.3"/><circle cx="12" cy="12" r="2" opacity="0.3"/><line x1="4" y1="4" x2="20" y2="20"/></svg>`;

function shortDeviceId(id: string): string {
	return `${id.substring(0, 7)}...`;
}

interface SyncthingDevice {
	deviceID: string;
	name: string;
	connected: boolean;
	paused: boolean;
	lastSeen: string;
}

interface SyncthingFolder {
	id: string;
	label: string;
	path: string;
	devices: { deviceID: string }[];
	state: string;
}

interface SyncthingBridgeSettings {
	apiUrl: string;
	apiKey: string;
	pollIntervalSeconds: number;
	showConflictNotices: boolean;
}

const DEFAULT_SETTINGS: SyncthingBridgeSettings = {
	apiUrl: "http://127.0.0.1:8384",
	apiKey: "",
	pollIntervalSeconds: 30,
	showConflictNotices: true,
};

export default class SyncthingBridgePlugin extends Plugin {
	settings: SyncthingBridgeSettings = { ...DEFAULT_SETTINGS };
	statusBarEl: HTMLElement | null = null;
	conflictBarEl: HTMLElement | null = null;
	pollInterval: number | null = null;
	lastStatusText: string | null = null;
	lastConflictCount = 0;

	async onload(): Promise<void> {
		await this.loadSettings();

		addIcon("syncthing-connected", SYNC_ICON);
		addIcon("syncthing-offline", SYNC_ICON_OFF);

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("syncthing-status");
		this.setStatusBar("syncthing-offline", "Syncthing: ...");

		this.conflictBarEl = this.addStatusBarItem();
		this.conflictBarEl.addClass("syncthing-conflict-indicator");
		this.conflictBarEl.hide();
		setTooltip(this.conflictBarEl, "Sync conflicts — click to resolve", { placement: "top" });
		this.conflictBarEl.addEventListener("click", () => this.openConflictResolver());

		this.addCommand({
			id: "syncthing-status",
			name: "Show sync status",
			callback: () => this.showStatus(),
		});

		this.addCommand({
			id: "syncthing-conflicts",
			name: "Resolve sync conflicts",
			callback: () => this.openConflictResolver(),
		});

		this.addSettingTab(new SyncthingBridgeSettingTab(this.app, this));

		this.startPolling();
	}

	onunload(): void {
		this.stopPolling();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	setStatusBar(iconId: string, text: string): void {
		if (!this.statusBarEl) return;
		this.statusBarEl.empty();
		const iconEl = this.statusBarEl.createSpan({ cls: "syncthing-status-icon" });
		setIcon(iconEl, iconId);
		this.statusBarEl.createSpan({ text });
	}

	startPolling(): void {
		this.stopPolling();
		this.poll();
		this.pollInterval = window.setInterval(
			() => this.poll(),
			this.settings.pollIntervalSeconds * 1000
		);
		this.registerInterval(this.pollInterval);
	}

	stopPolling(): void {
		if (this.pollInterval !== null) {
			window.clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	async apiGet<T>(endpoint: string): Promise<T> {
		const headers: Record<string, string> = {};
		if (this.settings.apiKey) {
			headers["X-API-Key"] = this.settings.apiKey;
		}
		const res = await fetch(`${this.settings.apiUrl}${endpoint}`, { headers });
		if (!res.ok) {
			throw new Error(`Syncthing API ${res.status}: ${res.statusText}`);
		}
		return res.json() as Promise<T>;
	}

	async poll(): Promise<void> {
		try {
			const { connections } = await this.apiGet<{
				connections: Record<string, { connected: boolean }>;
			}>("/rest/system/connections");

			const connectedCount = Object.values(connections).filter(
				(c) => c.connected
			).length;
			const totalCount = Object.keys(connections).length;

			const icon = connectedCount > 0 ? "syncthing-connected" : "syncthing-offline";
			const statusText = ` ${connectedCount}/${totalCount} devices`;

			if (statusText !== this.lastStatusText) {
				this.setStatusBar(icon, statusText);
				this.lastStatusText = statusText;
			}

			if (this.settings.showConflictNotices) {
				this.checkConflicts();
			}
		} catch {
			if (this.lastStatusText !== " offline") {
				this.setStatusBar("syncthing-offline", " offline");
				this.lastStatusText = " offline";
			}
		}
	}

	checkConflicts(): void {
		const count = this.findConflicts().length;
		if (count > 0 && count !== this.lastConflictCount) {
			new Notice(`Syncthing: ${count} conflict(s) detected`);
		}
		this.lastConflictCount = count;
		this.updateConflictIndicator(count);
	}

	updateConflictIndicator(count: number): void {
		if (!this.conflictBarEl) return;
		if (count === 0) {
			this.conflictBarEl.hide();
			return;
		}
		this.conflictBarEl.empty();
		const iconEl = this.conflictBarEl.createSpan({ cls: "syncthing-conflict-icon" });
		setIcon(iconEl, "alert-triangle");
		this.conflictBarEl.createSpan({ text: ` ${count}` });
		setTooltip(this.conflictBarEl, `${count} sync conflict${count === 1 ? "" : "s"} — click to resolve`, { placement: "top" });
		this.conflictBarEl.show();
	}

	async showStatus(): Promise<void> {
		try {
			const [system, { connections }, config] = await Promise.all([
				this.apiGet<{ myID: string }>("/rest/system/status"),
				this.apiGet<{ connections: Record<string, { connected: boolean; type: string }> }>("/rest/system/connections"),
				this.apiGet<{ devices: SyncthingDevice[]; folders: SyncthingFolder[] }>("/rest/config"),
			]);

			const lines: string[] = [
				`Device ID: ${shortDeviceId(system.myID)}`,
				`Folders: ${config.folders.length}`,
				"",
				"Devices:",
			];

			for (const device of config.devices) {
				if (device.deviceID === system.myID) continue;
				const conn = connections[device.deviceID];
				const status = conn?.connected ? "connected" : "disconnected";
				lines.push(`  ${device.name || shortDeviceId(device.deviceID)}: ${status}`);
			}

			new Notice(lines.join("\n"), 10000);
		} catch (e) {
			new Notice(`Syncthing error: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	findConflicts(): { original: TFile; conflict: TFile }[] {
		const files = this.app.vault.getFiles();
		const conflictFiles = files.filter((f) => f.name.includes(CONFLICT_MARKER));
		const pairs: { original: TFile; conflict: TFile }[] = [];

		for (const conflict of conflictFiles) {
			// test-note.sync-conflict-20260404-074555-IALUXA3.md → test-note.md
			const originalName = conflict.name.replace(/\.sync-conflict-[^.]+/, "");
			const parentPath = conflict.parent?.path;
			const originalPath = (parentPath && parentPath !== "/")
				? `${parentPath}/${originalName}`
				: originalName;

			// Try getFileByPath first, fall back to searching all files
			let original = this.app.vault.getFileByPath(originalPath);
			if (!original) {
				original = files.find((f) => f.name === originalName && f.parent?.path === conflict.parent?.path) ?? null;
			}
			if (original) {
				pairs.push({ original, conflict });
			}
		}
		return pairs;
	}

	async openConflictResolver(): Promise<void> {
		const pairs = this.findConflicts();
		if (pairs.length === 0) {
			new Notice("No sync conflicts found");
			return;
		}
		new ConflictResolverModal(this.app, this, pairs).open();
	}
}

class SyncthingBridgeSettingTab extends PluginSettingTab {
	plugin: SyncthingBridgePlugin;

	constructor(app: App, plugin: SyncthingBridgePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Syncthing API URL")
			.setDesc("Usually http://127.0.0.1:8384")
			.addText((text) =>
				text
					.setPlaceholder("http://127.0.0.1:8384")
					.setValue(this.plugin.settings.apiUrl)
					.onChange(async (value) => {
						this.plugin.settings.apiUrl = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("API Key")
			.setDesc("Found in Syncthing GUI → Actions → Settings → API Key")
			.addText((text) =>
				text
					.setPlaceholder("Enter API key")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Poll interval (seconds)")
			.setDesc("How often to check sync status")
			.addText((text) =>
				text
					.setPlaceholder("30")
					.setValue(String(this.plugin.settings.pollIntervalSeconds))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num >= 5) {
							this.plugin.settings.pollIntervalSeconds = num;
							await this.plugin.saveSettings();
							this.plugin.startPolling();
						}
					})
			);

		new Setting(containerEl)
			.setName("Conflict notifications")
			.setDesc("Show a notice when sync conflicts are detected")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showConflictNotices)
					.onChange(async (value) => {
						this.plugin.settings.showConflictNotices = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Verify Syncthing is reachable")
			.addButton((button) =>
				button.setButtonText("Test").onClick(async () => {
					try {
						const status = await this.plugin.apiGet<{ myID: string }>("/rest/system/status");
						new Notice(`Connected! Device: ${shortDeviceId(status.myID)}`);
					} catch (e) {
						new Notice(
							`Connection failed: ${e instanceof Error ? e.message : String(e)}`
						);
					}
				})
			);
	}
}

class ConflictResolverModal extends Modal {
	plugin: SyncthingBridgePlugin;
	pairs: { original: TFile; conflict: TFile }[];
	currentIndex: number;

	constructor(app: App, plugin: SyncthingBridgePlugin, pairs: { original: TFile; conflict: TFile }[]) {
		super(app);
		this.plugin = plugin;
		this.pairs = pairs;
		this.currentIndex = 0;
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass("syncthing-conflict-modal");
		await this.renderConflict();
	}

	async renderConflict(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();

		if (this.currentIndex >= this.pairs.length) {
			contentEl.createEl("h2", { text: "All conflicts resolved!" });
			const doneBtn = contentEl.createEl("button", { text: "Close" });
			doneBtn.addEventListener("click", () => this.close());
			return;
		}

		const pair = this.pairs[this.currentIndex]!;
		const originalContent = await this.app.vault.read(pair.original);
		const conflictContent = await this.app.vault.read(pair.conflict);

		// Header
		const header = contentEl.createDiv({ cls: "conflict-header" });
		header.createEl("h2", { text: `Conflict ${this.currentIndex + 1} of ${this.pairs.length}` });
		header.createEl("p", { text: pair.original.path, cls: "conflict-path" });

		// Parse conflict filename for metadata
		const match = pair.conflict.name.match(/\.sync-conflict-(\d{8})-(\d{6})-(\w+)\./);
		if (match) {
			const date = `${match[1]!.slice(0, 4)}-${match[1]!.slice(4, 6)}-${match[1]!.slice(6, 8)}`;
			const time = `${match[2]!.slice(0, 2)}:${match[2]!.slice(2, 4)}:${match[2]!.slice(4, 6)}`;
			header.createEl("p", {
				text: `Conflict from device ${match[3]} at ${date} ${time}`,
				cls: "conflict-meta",
			});
		}

		// Diff view - side by side
		const diffContainer = contentEl.createDiv({ cls: "conflict-diff" });

		const leftPane = diffContainer.createDiv({ cls: "conflict-pane" });
		leftPane.createEl("h3", { text: "Current version" });
		const leftContent = leftPane.createEl("pre", { cls: "conflict-content" });
		leftContent.createEl("code", { text: originalContent });

		const rightPane = diffContainer.createDiv({ cls: "conflict-pane" });
		rightPane.createEl("h3", { text: "Conflict version" });
		const rightContent = rightPane.createEl("pre", { cls: "conflict-content" });
		rightContent.createEl("code", { text: conflictContent });

		// Actions
		const actions = contentEl.createDiv({ cls: "conflict-actions" });

		const keepCurrentBtn = actions.createEl("button", {
			text: "Keep current",
			cls: "mod-warning",
		});
		keepCurrentBtn.addEventListener("click", async () => {
			await this.app.vault.delete(pair.conflict);
			new Notice(`Kept current version of ${pair.original.name}`);
			this.currentIndex++;
			await this.renderConflict();
		});

		const keepConflictBtn = actions.createEl("button", {
			text: "Keep conflict version",
			cls: "mod-warning",
		});
		keepConflictBtn.addEventListener("click", async () => {
			await this.app.vault.modify(pair.original, conflictContent);
			await this.app.vault.delete(pair.conflict);
			new Notice(`Replaced with conflict version of ${pair.original.name}`);
			this.currentIndex++;
			await this.renderConflict();
		});

		const keepBothBtn = actions.createEl("button", { text: "Keep both" });
		keepBothBtn.addEventListener("click", async () => {
			const ext = pair.original.extension;
			const baseName = pair.original.basename;
			const newPath = pair.conflict.parent
				? `${pair.conflict.parent.path}/${baseName} (conflict).${ext}`
				: `${baseName} (conflict).${ext}`;
			await this.app.vault.rename(pair.conflict, newPath);
			new Notice(`Kept both versions of ${pair.original.name}`);
			this.currentIndex++;
			await this.renderConflict();
		});

		const skipBtn = actions.createEl("button", { text: "Skip" });
		skipBtn.addEventListener("click", async () => {
			this.currentIndex++;
			await this.renderConflict();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
